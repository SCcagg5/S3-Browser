package main

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The copy of an object in parts on the provider (S3 UploadPartCopy). CopyObject refuses a source above 5 GiB. From
// multipartCopyThreshold up, a copy, a move or a rename starts a multipart upload, lets the provider copy each byte
// range of the source into one part, and completes the upload. No byte of the object goes through this process.

const (
	// multipartCopyParallel is the number of parts that the provider copies at the same time. The concurrency gates of
	// the storage instance can lower it.
	multipartCopyParallel = 4
	// maximumMultipartParts is the S3 limit of parts in one multipart upload.
	maximumMultipartParts = 10000
	// minimumCopyPartSize and maximumCopyPartSize are the S3 limits of a part, the last part excepted.
	minimumCopyPartSize = int64(5 << 20)
	maximumCopyPartSize = int64(5 << 30)
	// multipartAbortTimeout is the time that the abort of a failed or canceled copy can take.
	multipartAbortTimeout = 30 * time.Second
)

var (
	// multipartCopyThreshold is the source size from which a copy goes in parts. CopyObject accepts 5 GiB at most: the
	// margin of 256 MiB keeps clear of that limit. Tests set a smaller value.
	multipartCopyThreshold = int64(5<<30 - 256<<20)
	// multipartCopyPartSize is the size of each part, the last part excepted. Tests set a smaller value.
	multipartCopyPartSize = int64(256 << 20)

	// The test image sets these two values with -ldflags "-X main.multipartCopyThresholdBuild=...". They stay empty
	// in a release build. applyMultipartCopyBuildSettings reads them one time at start.
	multipartCopyThresholdBuild string
	multipartCopyPartSizeBuild  string
)

// applyMultipartCopyBuildSettings applies the values that the build gave. A value that is not a number in its range
// stops the program at start. It gives one line for the log for each value that the build changed.
func applyMultipartCopyBuildSettings() ([]string, error) {
	var notes []string
	if raw := strings.TrimSpace(multipartCopyThresholdBuild); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 1 || value > maximumCopyPartSize {
			return nil, fmt.Errorf("build value multipartCopyThresholdBuild must be an integer from 1 to %d bytes, got %q", maximumCopyPartSize, raw)
		}
		multipartCopyThreshold = value
		notes = append(notes, fmt.Sprintf("build.multipart_copy_threshold = %d  # set at build time, for tests", value))
	}
	if raw := strings.TrimSpace(multipartCopyPartSizeBuild); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < minimumCopyPartSize || value > maximumCopyPartSize {
			return nil, fmt.Errorf("build value multipartCopyPartSizeBuild must be an integer from %d to %d bytes, got %q", minimumCopyPartSize, maximumCopyPartSize, raw)
		}
		multipartCopyPartSize = value
		notes = append(notes, fmt.Sprintf("build.multipart_copy_part_size = %d  # set at build time, for tests", value))
	}
	return notes, nil
}

// multipartCopyOptions are the choices of a copy in parts. The zero value copies the current version of the source with
// its metadata and its tags, as CopyObject does.
type multipartCopyOptions struct {
	// SourceVersion names a version of the source. Empty means the current version.
	SourceVersion string
	// ReplaceMetadata gives the destination the headers of Metadata instead of the headers of the source.
	ReplaceMetadata bool
	// Metadata holds the standard headers of copiedObjectHeaders and the x-amz-meta-* headers of the destination. Other
	// headers are ignored. It applies only with ReplaceMetadata.
	Metadata http.Header
	// ReplaceTags gives the destination Tags instead of the tags of the source. An empty Tags then means no tag.
	ReplaceTags bool
	Tags        []objectTag
	// Progress receives the size of each part after the provider copied it. The calls do not overlap.
	Progress func(int64)

	// partSize replaces multipartCopyPartSize when it is not 0. Tests set it.
	partSize int64
	// gate takes a slot of the storage instance for one request. The storage instance sets it. Nil means no limit.
	gate func(context.Context) (func(), error)
}

// copiedObjectHeaders are the standard headers that a copy keeps from the source, as CopyObject does.
var copiedObjectHeaders = []string{"Content-Type", "Cache-Control", "Content-Disposition", "Content-Encoding", "Content-Language", "Expires"}

// copyMetadataHeaders gives the headers of copiedObjectHeaders and the x-amz-meta-* headers of a response or of a
// request.
func copyMetadataHeaders(source http.Header) http.Header {
	headers := make(http.Header)
	for _, name := range copiedObjectHeaders {
		if value := source.Get(name); value != "" {
			headers.Set(name, value)
		}
	}
	for name, values := range source {
		if strings.HasPrefix(strings.ToLower(name), "x-amz-meta-") && len(values) > 0 {
			headers[http.CanonicalHeaderKey(name)] = append([]string(nil), values...)
		}
	}
	return headers
}

// encodeTagsHeader gives the tags in the form of the header x-amz-tagging (a=b&c=d).
func encodeTagsHeader(tags []objectTag) string {
	values := make(url.Values, len(tags))
	for _, tag := range tags {
		values.Set(tag.Key, tag.Value)
	}
	return values.Encode()
}

// copyPartRange is the byte range of the source that one part copies. First and Last are included.
type copyPartRange struct {
	Number      int
	First, Last int64
}

func (r copyPartRange) size() int64 { return r.Last - r.First + 1 }

// copyPartRanges divides size bytes into parts of partSize bytes; the last part has the remainder. When more than
// maximumMultipartParts parts are necessary, the parts become larger, in steps of 1 MiB.
func copyPartRanges(size, partSize int64) ([]copyPartRange, error) {
	if size <= 0 {
		return nil, fmt.Errorf("a copy in parts needs a source of 1 byte or more, got %d", size)
	}
	if partSize <= 0 {
		return nil, fmt.Errorf("the part size must be positive, got %d", partSize)
	}
	if (size+partSize-1)/partSize > maximumMultipartParts {
		const step = int64(1 << 20)
		partSize = (size + maximumMultipartParts - 1) / maximumMultipartParts
		partSize = (partSize + step - 1) / step * step
	}
	if partSize > maximumCopyPartSize {
		return nil, fmt.Errorf("a source of %d bytes needs parts larger than the S3 limit of %d bytes", size, maximumCopyPartSize)
	}
	ranges := make([]copyPartRange, 0, (size+partSize-1)/partSize)
	for first := int64(0); first < size; first += partSize {
		last := minInt64(first+partSize, size) - 1
		ranges = append(ranges, copyPartRange{Number: len(ranges) + 1, First: first, Last: last})
	}
	return ranges, nil
}

// copySourceHeader gives the value of x-amz-copy-source for a key of the bucket, and for one version of it when version
// is not empty.
func (s *s3Backend) copySourceHeader(key, version string) string {
	value := "/" + awsURIEncode(s.cfg.Bucket, true) + "/" + awsURIEncode(key, false)
	if version != "" {
		value += "?versionId=" + url.QueryEscape(version)
	}
	return value
}

// CopyMultipart copies the source to the destination in parts: CreateMultipartUpload with the metadata and the tags,
// UploadPartCopy for each byte range, CompleteMultipartUpload. Each part names the ETag of the source, so a source that
// changes during the copy makes it fail. On any error, and on a cancel of ctx, it aborts the multipart upload.
func (s *s3Backend) CopyMultipart(ctx context.Context, source, destination string, options multipartCopyOptions) (err error) {
	gate := options.gate
	if gate == nil {
		gate = func(context.Context) (func(), error) { return func() {}, nil }
	}
	head, err := s.headCopySource(ctx, gate, source, options.SourceVersion)
	if err != nil {
		return err
	}
	size, sizeErr := strconv.ParseInt(strings.TrimSpace(head.Header.Get("Content-Length")), 10, 64)
	if sizeErr != nil {
		return fmt.Errorf("the provider gave no size for the source of the copy")
	}
	partSize := multipartCopyPartSize
	if options.partSize != 0 {
		partSize = options.partSize
	}
	ranges, err := copyPartRanges(size, partSize)
	if err != nil {
		return err
	}
	headers := copyMetadataHeaders(head.Header)
	if options.ReplaceMetadata {
		headers = copyMetadataHeaders(options.Metadata)
	}
	tags := options.Tags
	if !options.ReplaceTags {
		if tags, err = s.copySourceTags(ctx, gate, source, options.SourceVersion, head.Header); err != nil {
			return err
		}
	}
	if len(tags) > 0 {
		headers.Set("x-amz-tagging", encodeTagsHeader(tags))
	}

	release, err := gate(ctx)
	if err != nil {
		return err
	}
	uploadID, err := s.initiateMultipart(ctx, destination, headers)
	release()
	if err != nil {
		return err
	}
	defer func() {
		if err == nil {
			return
		}
		// The context of the copy can be canceled: the abort gets its own time and no slot of the gate.
		abortCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), multipartAbortTimeout)
		defer cancel()
		if abortErr := s.AbortMultipart(abortCtx, destination, uploadID); abortErr != nil {
			err = fmt.Errorf("%w (the abort of the multipart upload %s also failed: %v)", err, uploadID, abortErr)
		}
	}()

	parts, err := s.copyParts(ctx, gate, source, options.SourceVersion, strings.TrimSpace(head.Header.Get("ETag")), destination, uploadID, ranges, options.Progress)
	if err != nil {
		return err
	}
	release, err = gate(ctx)
	if err != nil {
		return err
	}
	defer release()
	return s.CompleteMultipart(ctx, destination, uploadID, parts)
}

func (s *s3Backend) headCopySource(ctx context.Context, gate func(context.Context) (func(), error), key, version string) (objectResponse, error) {
	release, err := gate(ctx)
	if err != nil {
		return objectResponse{}, err
	}
	defer release()
	if version != "" {
		return s.HeadObjectVersion(ctx, key, version)
	}
	return s.Head(ctx, key)
}

// copySourceTags reads the tags of the source. A source that reports 0 tags in x-amz-tagging-count needs no request. A
// provider without tags (501 or 405) gives no tag.
func (s *s3Backend) copySourceTags(ctx context.Context, gate func(context.Context) (func(), error), key, version string, head http.Header) ([]objectTag, error) {
	if strings.TrimSpace(head.Get("x-amz-tagging-count")) == "0" {
		return nil, nil
	}
	release, err := gate(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	tags, err := s.GetObjectTagging(ctx, key, version)
	if providerRefusedFeature(err) {
		return nil, nil
	}
	return tags, err
}

// copyParts lets the provider copy the ranges, multipartCopyParallel at the same time. The first error cancels the
// parts that did not start.
func (s *s3Backend) copyParts(ctx context.Context, gate func(context.Context) (func(), error), source, version, sourceETag, destination, uploadID string, ranges []copyPartRange, progress func(int64)) ([]s3CompletedPart, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	parts := make([]s3CompletedPart, len(ranges))
	work := make(chan copyPartRange)
	var (
		mu       sync.Mutex
		firstErr error
		workers  sync.WaitGroup
	)
	for worker := 0; worker < minInt(multipartCopyParallel, len(ranges)); worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for part := range work {
				etag, err := s.uploadPartCopyGated(ctx, gate, source, version, sourceETag, destination, uploadID, part)
				mu.Lock()
				if err != nil {
					if firstErr == nil {
						firstErr = err
						cancel()
					}
				} else {
					parts[part.Number-1] = s3CompletedPart{PartNumber: part.Number, ETag: etag}
					if progress != nil {
						progress(part.size())
					}
				}
				mu.Unlock()
			}
		}()
	}
feed:
	for _, part := range ranges {
		select {
		case work <- part:
		case <-ctx.Done():
			break feed
		}
	}
	close(work)
	workers.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return parts, nil
}

func (s *s3Backend) uploadPartCopyGated(ctx context.Context, gate func(context.Context) (func(), error), source, version, sourceETag, destination, uploadID string, part copyPartRange) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	release, err := gate(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	return s.UploadPartCopy(ctx, source, version, sourceETag, destination, uploadID, part)
}

// UploadPartCopy lets the provider copy one byte range of the source into one part of the multipart upload. A
// sourceETag that is not empty makes the provider refuse a source that changed.
func (s *s3Backend) UploadPartCopy(ctx context.Context, source, version, sourceETag, destination, uploadID string, part copyPartRange) (string, error) {
	query := url.Values{}
	query.Set("partNumber", strconv.Itoa(part.Number))
	query.Set("uploadId", uploadID)
	headers := make(http.Header)
	headers.Set("x-amz-copy-source", s.copySourceHeader(source, version))
	headers.Set("x-amz-copy-source-range", fmt.Sprintf("bytes=%d-%d", part.First, part.Last))
	if sourceETag != "" {
		headers.Set("x-amz-copy-source-if-match", sourceETag)
	}
	resp, err := s.do(ctx, http.MethodPut, destination, query, nil, 0, headers)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", s3ResponseError(resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read s3 upload part copy response: %w", err)
	}
	// Some S3 implementations return HTTP 200 with an embedded Error document.
	var result struct {
		XMLName xml.Name
		ETag    string `xml:"ETag"`
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if err := xml.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("decode s3 upload part copy response: %w", err)
	}
	if result.XMLName.Local == "Error" {
		return "", &upstreamError{StatusCode: http.StatusBadGateway, Code: result.Code, Message: result.Message}
	}
	etag := strings.Trim(strings.TrimSpace(result.ETag), `"`)
	if etag == "" {
		return "", errors.New("s3 upload part copy did not return an ETag")
	}
	return etag, nil
}
