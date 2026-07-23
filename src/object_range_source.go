package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// objectRangeSource exists only for one HTTP request. It has no process-wide,
// cross-request, or persistent cache. Bytes already fetched during the current
// action are kept only until that HTTP request ends so a parser never pays for
// the same storage range twice while following format-declared offsets.
type objectByteSpan struct {
	start int64
	data  []byte
}

type objectRangeSource struct {
	ctx      context.Context
	instance *storageInstance
	key      string
	size     int64
	headers  http.Header
	spans    []objectByteSpan
	etag     string
	requests int
	bytes    int64
}

func openObjectRangeSource(ctx context.Context, instance *storageInstance, key string) (*objectRangeSource, error) {
	if instance == nil || instance.backend == nil {
		return nil, fmt.Errorf("storage instance is not initialized")
	}
	return &objectRangeSource{ctx: ctx, instance: instance, key: key}, nil
}

func objectSizeFromResponse(response objectResponse, received int64) int64 {
	if contentRange := strings.TrimSpace(response.Header.Get("Content-Range")); contentRange != "" {
		if slash := strings.LastIndex(contentRange, "/"); slash >= 0 && slash+1 < len(contentRange) {
			if total, err := strconv.ParseInt(strings.TrimSpace(contentRange[slash+1:]), 10, 64); err == nil && total >= 0 {
				return total
			}
		}
	}
	if value, err := strconv.ParseInt(strings.TrimSpace(response.Header.Get("Content-Length")), 10, 64); err == nil && value >= 0 {
		if response.StatusCode == http.StatusPartialContent {
			return maxInt64(value, received)
		}
		return value
	}
	return received
}

func (s *objectRangeSource) fetch(start, length int64) ([]byte, objectResponse, error) {
	if start < 0 || length <= 0 {
		return nil, objectResponse{}, fmt.Errorf("invalid object metadata range")
	}
	end := start + length - 1
	headers := make(http.Header)
	headers.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	if s.etag != "" {
		headers.Set("If-Match", s.etag)
	}
	response, err := s.instance.backend.Get(s.ctx, s.instance.fullKey(s.key), headers)
	if err != nil {
		return nil, objectResponse{}, err
	}
	if response.Body == nil {
		return nil, objectResponse{}, apiError{Status: http.StatusBadGateway, Code: "empty_metadata_response", Message: "the storage provider returned an empty metadata response"}
	}
	defer response.Body.Close()
	if !isSuccessfulObjectReadStatus(response.StatusCode) {
		return nil, objectResponse{}, &upstreamError{StatusCode: response.StatusCode, Code: "MetadataRangeReadFailed"}
	}

	contentRange := strings.TrimSpace(response.Header.Get("Content-Range"))
	contentLength, contentLengthErr := strconv.ParseInt(strings.TrimSpace(response.Header.Get("Content-Length")), 10, 64)
	if response.StatusCode == http.StatusPartialContent && contentRange == "" {
		return nil, objectResponse{}, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider omitted Content-Range for a byte-range metadata request"}
	}
	// Metadata readers require true random access. Accept a 200 response only
	// when the complete object is no larger than the requested prefix. Otherwise
	// even reading and closing just the prefix could cause the provider or an
	// intermediary to transfer and bill a multi-gigabyte object.
	if response.StatusCode == http.StatusOK && contentRange == "" {
		if start > 0 || contentLengthErr != nil || contentLength < 0 || contentLength > length {
			return nil, objectResponse{}, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider ignored a byte-range metadata request"}
		}
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, length))
	if err != nil {
		return nil, objectResponse{}, fmt.Errorf("read object metadata range: %w", err)
	}
	if s.headers == nil {
		s.headers = response.Header.Clone()
		s.etag = strings.TrimSpace(response.Header.Get("ETag"))
		s.size = objectSizeFromResponse(response, int64(len(data)))
	}
	s.requests++
	s.bytes += int64(len(data))
	if len(data) > 0 {
		s.spans = append(s.spans, objectByteSpan{start: start, data: append([]byte(nil), data...)})
	}
	return data, response, nil
}

func (s *objectRangeSource) hasByte(offset int64) bool {
	for _, span := range s.spans {
		if offset >= span.start && offset < span.start+int64(len(span.data)) {
			return true
		}
	}
	return false
}

func (s *objectRangeSource) ReadRange(start, length int64) ([]byte, error) {
	if start < 0 || length <= 0 {
		return nil, fmt.Errorf("invalid object metadata range")
	}
	if s.size > 0 {
		if start >= s.size {
			return nil, io.EOF
		}
		length = minInt64(length, s.size-start)
	}
	end := start + length
	out := make([]byte, length)
	cursor := start
	for cursor < end {
		covered := false
		for _, span := range s.spans {
			spanEnd := span.start + int64(len(span.data))
			if cursor < span.start || cursor >= spanEnd {
				continue
			}
			copyEnd := minInt64(end, spanEnd)
			copy(out[cursor-start:copyEnd-start], span.data[cursor-span.start:copyEnd-span.start])
			cursor = copyEnd
			covered = true
			break
		}
		if covered {
			continue
		}
		gapEnd := end
		for _, span := range s.spans {
			if span.start > cursor && span.start < gapEnd {
				gapEnd = span.start
			}
		}
		fetched, _, err := s.fetch(cursor, gapEnd-cursor)
		if err != nil {
			return nil, err
		}
		if len(fetched) == 0 {
			return out[:cursor-start], io.EOF
		}
		copy(out[cursor-start:], fetched)
		cursor += int64(len(fetched))
		if s.size > 0 && cursor >= s.size {
			return out[:cursor-start], nil
		}
	}
	return out, nil
}

// ReadSuffix performs one suffix-range request when the object size is not yet
// known. It is useful for ZIP central directories: the same paid request both
// discovers the total size and supplies the tail bytes needed by archive/zip.
func (s *objectRangeSource) ReadSuffix(length int64) ([]byte, error) {
	if length <= 0 {
		return nil, fmt.Errorf("invalid object metadata suffix length")
	}
	if s.size > 0 {
		length = minInt64(length, s.size)
		return s.ReadRange(s.size-length, length)
	}

	headers := make(http.Header)
	headers.Set("Range", fmt.Sprintf("bytes=-%d", length))
	if s.etag != "" {
		headers.Set("If-Match", s.etag)
	}
	response, err := s.instance.backend.Get(s.ctx, s.instance.fullKey(s.key), headers)
	if err != nil {
		return nil, err
	}
	if response.Body == nil {
		return nil, apiError{Status: http.StatusBadGateway, Code: "empty_metadata_response", Message: "the storage provider returned an empty metadata response"}
	}
	defer response.Body.Close()
	if !isSuccessfulObjectReadStatus(response.StatusCode) {
		return nil, &upstreamError{StatusCode: response.StatusCode, Code: "MetadataRangeReadFailed"}
	}

	if response.StatusCode == http.StatusPartialContent && strings.TrimSpace(response.Header.Get("Content-Range")) == "" {
		return nil, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider omitted Content-Range for a suffix request"}
	}
	if response.StatusCode == http.StatusOK {
		contentLength, parseErr := strconv.ParseInt(strings.TrimSpace(response.Header.Get("Content-Length")), 10, 64)
		if parseErr != nil || contentLength < 0 || contentLength > length {
			return nil, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider ignored a suffix byte-range request"}
		}
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, length+1))
	if err != nil {
		return nil, fmt.Errorf("read object metadata suffix: %w", err)
	}
	if int64(len(data)) > length {
		return nil, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider returned more data than the suffix request allowed"}
	}
	total := objectSizeFromResponse(response, int64(len(data)))
	if total < int64(len(data)) {
		total = int64(len(data))
	}
	start := total - int64(len(data))
	if start < 0 {
		start = 0
	}
	s.headers = response.Header.Clone()
	s.etag = strings.TrimSpace(response.Header.Get("ETag"))
	s.size = total
	s.requests++
	s.bytes += int64(len(data))
	if len(data) > 0 {
		s.spans = append(s.spans, objectByteSpan{start: start, data: append([]byte(nil), data...)})
	}
	return data, nil
}

func (s *objectRangeSource) ReadPrefix(length int64) ([]byte, error) {
	if length <= 0 {
		return nil, nil
	}
	if s.size > 0 {
		length = minInt64(length, s.size)
	}
	return s.ReadRange(0, length)
}
