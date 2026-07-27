package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type s3Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

type s3Backend struct {
	cfg      bucketConfig
	endpoint *url.URL
	client   *http.Client
	creds    s3Credentials
	authMode string
	region   string
}

func newS3BackendWithAuthentication(cfg bucketConfig, auth *sharedAuthentication) (*s3Backend, error) {
	if auth == nil || auth.cfg.Provider != "s3" {
		return nil, fmt.Errorf("bucket %q requires an S3 authentication", cfg.ID)
	}
	if auth.cfg.Mode == "access_key" && (auth.s3Creds.AccessKeyID == "" || auth.s3Creds.SecretAccessKey == "") {
		return nil, fmt.Errorf("S3 credentials are incomplete")
	}
	return &s3Backend{
		cfg:      cfg,
		endpoint: auth.endpoint,
		client:   auth.client,
		creds:    auth.s3Creds,
		authMode: auth.cfg.Mode,
		region:   auth.cfg.Region,
	}, nil
}

func (s *s3Backend) List(ctx context.Context, options listOptions) (listPage, error) {
	query := url.Values{}
	query.Set("list-type", "2")
	if options.Prefix != "" {
		query.Set("prefix", options.Prefix)
	}
	if options.Delimiter != "" {
		query.Set("delimiter", options.Delimiter)
	}
	if options.MaxResults > 0 {
		query.Set("max-keys", strconv.Itoa(options.MaxResults))
	}
	if options.PageToken != "" {
		query.Set("continuation-token", options.PageToken)
	}
	if options.StartAfter != "" {
		query.Set("start-after", options.StartAfter)
	}

	resp, err := s.do(ctx, http.MethodGet, "", query, nil, 0, nil)
	if err != nil {
		return listPage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return listPage{}, s3ResponseError(resp)
	}
	var result struct {
		IsTruncated           bool   `xml:"IsTruncated"`
		NextContinuationToken string `xml:"NextContinuationToken"`
		CommonPrefixes        []struct {
			Prefix string `xml:"Prefix"`
		} `xml:"CommonPrefixes"`
		Contents []struct {
			Key          string `xml:"Key"`
			LastModified string `xml:"LastModified"`
			Size         int64  `xml:"Size"`
			ETag         string `xml:"ETag"`
		} `xml:"Contents"`
	}
	decoder := xml.NewDecoder(io.LimitReader(resp.Body, 32<<20))
	if err := decoder.Decode(&result); err != nil {
		return listPage{}, fmt.Errorf("decode s3 list response: %w", err)
	}
	page := listPage{NextPageToken: result.NextContinuationToken}
	for _, prefix := range result.CommonPrefixes {
		page.Prefixes = append(page.Prefixes, prefix.Prefix)
	}
	for _, object := range result.Contents {
		lastModified, _ := time.Parse(time.RFC3339, object.LastModified)
		if lastModified.IsZero() {
			lastModified, _ = time.Parse("2006-01-02T15:04:05.000Z", object.LastModified)
		}
		page.Objects = append(page.Objects, objectInfo{
			Key:          object.Key,
			Size:         object.Size,
			LastModified: lastModified,
			ETag:         strings.Trim(object.ETag, `"`),
		})
	}
	return page, nil
}

func (s *s3Backend) Head(ctx context.Context, key string) (objectResponse, error) {
	headers := make(http.Header)
	headers.Set("x-amz-checksum-mode", "ENABLED")
	resp, err := s.do(ctx, http.MethodHead, key, nil, nil, 0, headers)
	if err != nil {
		return objectResponse{}, err
	}
	// A number of S3-compatible providers predate checksum mode. Retry without
	// the optional request header rather than making basic metadata unavailable.
	if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotImplemented {
		_ = resp.Body.Close()
		resp, err = s.do(ctx, http.MethodHead, key, nil, nil, 0, nil)
		if err != nil {
			return objectResponse{}, err
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return objectResponse{}, s3ResponseError(resp)
	}
	_ = resp.Body.Close()
	return objectResponse{StatusCode: resp.StatusCode, Header: resp.Header.Clone()}, nil
}

func (s *s3Backend) HeadObjectVersion(ctx context.Context, key, version string) (objectResponse, error) {
	query := url.Values{}
	query.Set("versionId", version)
	headers := make(http.Header)
	headers.Set("x-amz-checksum-mode", "ENABLED")
	resp, err := s.do(ctx, http.MethodHead, key, query, nil, 0, headers)
	if err != nil {
		return objectResponse{}, err
	}
	if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotImplemented {
		_ = resp.Body.Close()
		resp, err = s.do(ctx, http.MethodHead, key, query, nil, 0, nil)
		if err != nil {
			return objectResponse{}, err
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return objectResponse{}, s3ResponseError(resp)
	}
	_ = resp.Body.Close()
	return objectResponse{StatusCode: resp.StatusCode, Header: resp.Header.Clone()}, nil
}

func (s *s3Backend) Get(ctx context.Context, key string, requestHeaders http.Header) (objectResponse, error) {
	return s.getWithQuery(ctx, key, nil, requestHeaders)
}

func (s *s3Backend) GetObjectVersion(ctx context.Context, key, version string, requestHeaders http.Header) (objectResponse, error) {
	query := url.Values{}
	query.Set("versionId", version)
	return s.getWithQuery(ctx, key, query, requestHeaders)
}

func (s *s3Backend) getWithQuery(ctx context.Context, key string, query url.Values, requestHeaders http.Header) (objectResponse, error) {
	headers := make(http.Header)
	for _, name := range []string{"Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "If-Range"} {
		if value := requestHeaders.Get(name); value != "" {
			headers.Set(name, value)
		}
	}
	if headers.Get("Range") != "" {
		headers.Set("Accept-Encoding", "identity")
	}
	resp, err := s.do(ctx, http.MethodGet, key, query, nil, 0, headers)
	if err != nil {
		return objectResponse{}, err
	}
	if !isSuccessfulObjectReadStatus(resp.StatusCode) {
		defer resp.Body.Close()
		return objectResponse{}, s3ResponseError(resp)
	}
	return objectResponse{StatusCode: resp.StatusCode, Header: resp.Header.Clone(), Body: resp.Body}, nil
}

func (s *s3Backend) ListObjectVersions(ctx context.Context, key, pageToken string, maximum int) (objectVersionPage, error) {
	cursor, err := decodeS3VersionCursor(pageToken)
	if err != nil {
		return objectVersionPage{}, apiError{Status: http.StatusBadRequest, Code: "invalid_page_token", Message: "version page token is invalid"}
	}
	query := url.Values{}
	query.Set("versions", "")
	query.Set("prefix", key)
	if maximum <= 0 || maximum > 1000 {
		maximum = 1000
	}
	query.Set("max-keys", strconv.Itoa(maximum))
	if cursor.KeyMarker != "" {
		query.Set("key-marker", cursor.KeyMarker)
	}
	if cursor.VersionIDMarker != "" {
		query.Set("version-id-marker", cursor.VersionIDMarker)
	}
	resp, err := s.do(ctx, http.MethodGet, "", query, nil, 0, nil)
	if err != nil {
		return objectVersionPage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return objectVersionPage{}, s3ResponseError(resp)
	}
	var result struct {
		IsTruncated         bool   `xml:"IsTruncated"`
		NextKeyMarker       string `xml:"NextKeyMarker"`
		NextVersionIDMarker string `xml:"NextVersionIdMarker"`
		Versions            []struct {
			Key          string `xml:"Key"`
			VersionID    string `xml:"VersionId"`
			IsLatest     bool   `xml:"IsLatest"`
			LastModified string `xml:"LastModified"`
			ETag         string `xml:"ETag"`
			Size         int64  `xml:"Size"`
		} `xml:"Version"`
		DeleteMarkers []struct {
			Key          string `xml:"Key"`
			VersionID    string `xml:"VersionId"`
			IsLatest     bool   `xml:"IsLatest"`
			LastModified string `xml:"LastModified"`
		} `xml:"DeleteMarker"`
	}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&result); err != nil {
		return objectVersionPage{}, fmt.Errorf("decode s3 version response: %w", err)
	}
	page := objectVersionPage{}
	for _, item := range result.Versions {
		if item.Key != key {
			continue
		}
		modified, _ := time.Parse(time.RFC3339Nano, item.LastModified)
		page.Versions = append(page.Versions, storedObjectVersion{
			Version: item.VersionID, IsCurrent: item.IsLatest, Size: item.Size,
			LastModified: modified, ETag: strings.Trim(item.ETag, `"`),
		})
	}
	for _, item := range result.DeleteMarkers {
		if item.Key != key {
			continue
		}
		modified, _ := time.Parse(time.RFC3339Nano, item.LastModified)
		page.Versions = append(page.Versions, storedObjectVersion{
			Version: item.VersionID, IsCurrent: item.IsLatest, DeleteMarker: true, LastModified: modified,
		})
	}
	sortedVersions(page.Versions)
	// Prefix listing can continue with a different key. Only expose a cursor
	// while the provider is still paginating versions of the exact object.
	if result.IsTruncated && result.NextKeyMarker == key && result.NextVersionIDMarker != "" {
		page.NextPageToken = encodeS3VersionCursor(s3VersionCursor{
			KeyMarker: result.NextKeyMarker, VersionIDMarker: result.NextVersionIDMarker,
		})
	}
	return page, nil
}

func (s *s3Backend) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	return s.put(ctx, key, body, size, contentType, false)
}

func (s *s3Backend) PutIfAbsent(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	return s.put(ctx, key, body, size, contentType, true)
}

func (s *s3Backend) put(ctx context.Context, key string, body io.Reader, size int64, contentType string, ifAbsent bool) error {
	headers := make(http.Header)
	if contentType != "" {
		headers.Set("Content-Type", contentType)
	}
	if ifAbsent {
		headers.Set("If-None-Match", "*")
	}
	resp, err := s.do(ctx, http.MethodPut, key, nil, body, size, headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if ifAbsent && (resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusPreconditionFailed) {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return apiError{Status: http.StatusConflict, Code: "object_exists", Message: "an object already exists at the extraction destination"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return s3ResponseError(resp)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return nil
}

type s3CompletedPart struct {
	PartNumber int
	ETag       string
}

func (s *s3Backend) InitiateMultipart(ctx context.Context, key, contentType string) (string, error) {
	query := url.Values{}
	query.Set("uploads", "")
	headers := make(http.Header)
	if contentType != "" {
		headers.Set("Content-Type", contentType)
	}
	resp, err := s.do(ctx, http.MethodPost, key, query, nil, 0, headers)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", s3ResponseError(resp)
	}
	var result struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return "", fmt.Errorf("decode s3 multipart initiation response: %w", err)
	}
	if strings.TrimSpace(result.UploadID) == "" {
		return "", fmt.Errorf("s3 multipart initiation did not return an upload id")
	}
	return result.UploadID, nil
}

func (s *s3Backend) UploadPart(ctx context.Context, key, uploadID string, partNumber int, body io.Reader, size int64) (string, error) {
	query := url.Values{}
	query.Set("partNumber", strconv.Itoa(partNumber))
	query.Set("uploadId", uploadID)
	resp, err := s.do(ctx, http.MethodPut, key, query, body, size, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", s3ResponseError(resp)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	etag := strings.TrimSpace(resp.Header.Get("ETag"))
	if etag == "" {
		return "", fmt.Errorf("s3 multipart upload part did not return an ETag")
	}
	return strings.Trim(etag, `"`), nil
}

func (s *s3Backend) CompleteMultipart(ctx context.Context, key, uploadID string, parts []s3CompletedPart) error {
	if len(parts) == 0 {
		return fmt.Errorf("cannot complete an s3 multipart upload without parts")
	}
	type partXML struct {
		PartNumber int    `xml:"PartNumber"`
		ETag       string `xml:"ETag"`
	}
	payload := struct {
		XMLName xml.Name  `xml:"CompleteMultipartUpload"`
		Parts   []partXML `xml:"Part"`
	}{Parts: make([]partXML, 0, len(parts))}
	for _, part := range parts {
		payload.Parts = append(payload.Parts, partXML{PartNumber: part.PartNumber, ETag: `"` + strings.Trim(part.ETag, `"`) + `"`})
	}
	body, err := xml.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode s3 multipart completion request: %w", err)
	}
	query := url.Values{}
	query.Set("uploadId", uploadID)
	headers := make(http.Header)
	headers.Set("Content-Type", "application/xml")
	resp, err := s.do(ctx, http.MethodPost, key, query, strings.NewReader(string(body)), int64(len(body)), headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return s3ResponseError(resp)
	}
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read s3 multipart completion response: %w", err)
	}
	// Some S3 implementations return HTTP 200 with an embedded Error document.
	var embedded struct {
		XMLName xml.Name
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if len(responseBody) > 0 && xml.Unmarshal(responseBody, &embedded) == nil && embedded.XMLName.Local == "Error" {
		return &upstreamError{StatusCode: http.StatusBadGateway, Code: embedded.Code, Message: embedded.Message}
	}
	return nil
}

func (s *s3Backend) AbortMultipart(ctx context.Context, key, uploadID string) error {
	query := url.Values{}
	query.Set("uploadId", uploadID)
	resp, err := s.do(ctx, http.MethodDelete, key, query, nil, 0, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return s3ResponseError(resp)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return nil
}

func (s *s3Backend) ListMultipartParts(ctx context.Context, key, uploadID string) ([]multipartPart, error) {
	if strings.TrimSpace(uploadID) == "" {
		return nil, fmt.Errorf("multipart upload id is required")
	}
	parts := make([]multipartPart, 0)
	marker := 0
	for {
		query := url.Values{}
		query.Set("uploadId", uploadID)
		query.Set("max-parts", "1000")
		if marker > 0 {
			query.Set("part-number-marker", strconv.Itoa(marker))
		}
		resp, err := s.do(ctx, http.MethodGet, key, query, nil, 0, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			err := s3ResponseError(resp)
			resp.Body.Close()
			return nil, err
		}
		var result struct {
			IsTruncated          bool `xml:"IsTruncated"`
			NextPartNumberMarker int  `xml:"NextPartNumberMarker"`
			Parts                []struct {
				PartNumber int    `xml:"PartNumber"`
				ETag       string `xml:"ETag"`
				Size       int64  `xml:"Size"`
			} `xml:"Part"`
		}
		err = xml.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&result)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("decode s3 multipart parts response: %w", err)
		}
		for _, part := range result.Parts {
			parts = append(parts, multipartPart{PartNumber: part.PartNumber, ETag: strings.Trim(part.ETag, `"`), Size: part.Size})
		}
		if !result.IsTruncated {
			break
		}
		if result.NextPartNumberMarker <= marker {
			return nil, fmt.Errorf("s3 multipart parts response did not advance its marker")
		}
		marker = result.NextPartNumberMarker
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	return parts, nil
}

func (s *s3Backend) Delete(ctx context.Context, key string) error {
	resp, err := s.do(ctx, http.MethodDelete, key, nil, nil, 0, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return s3ResponseError(resp)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return nil
}

func (s *s3Backend) DeleteObjectVersion(ctx context.Context, key, version string) error {
	query := url.Values{}
	query.Set("versionId", version)
	resp, err := s.do(ctx, http.MethodDelete, key, query, nil, 0, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return s3ResponseError(resp)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return nil
}

func (s *s3Backend) RestoreObjectVersion(ctx context.Context, key, version string) error {
	headers := make(http.Header)
	copySource := "/" + awsURIEncode(s.cfg.Bucket, true) + "/" + awsURIEncode(key, false) + "?versionId=" + url.QueryEscape(version)
	headers.Set("x-amz-copy-source", copySource)
	resp, err := s.do(ctx, http.MethodPut, key, nil, nil, 0, headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return s3ResponseError(resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read s3 restore response: %w", err)
	}
	var embedded struct {
		XMLName xml.Name
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if len(body) > 0 && xml.Unmarshal(body, &embedded) == nil && embedded.XMLName.Local == "Error" {
		return &upstreamError{StatusCode: http.StatusBadGateway, Code: embedded.Code, Message: embedded.Message}
	}
	return nil
}

func (s *s3Backend) Copy(ctx context.Context, sourceKey, destinationKey string) error {
	headers := make(http.Header)
	headers.Set("x-amz-copy-source", "/"+awsURIEncode(s.cfg.Bucket, true)+"/"+awsURIEncode(sourceKey, false))
	resp, err := s.do(ctx, http.MethodPut, destinationKey, nil, nil, 0, headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return s3ResponseError(resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read s3 copy response: %w", err)
	}
	var copyResult struct {
		XMLName xml.Name
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if len(body) > 0 && xml.Unmarshal(body, &copyResult) == nil && copyResult.XMLName.Local == "Error" {
		return &upstreamError{StatusCode: http.StatusBadGateway, Code: copyResult.Code, Message: copyResult.Message}
	}
	return nil
}

func (s *s3Backend) DiscoverCapabilities(ctx context.Context) (discoveredCapabilities, error) {
	states := map[string]capabilityState{
		permissionWrite: {
			Allowed:  false,
			Verified: false,
			Source:   "s3",
			Reason:   "S3 does not provide a portable, non-destructive IAM test for PutObject",
		},
		permissionDelete: {
			Allowed:  false,
			Verified: false,
			Source:   "s3",
			Reason:   "S3 does not provide a portable, non-destructive IAM test for DeleteObject",
		},
	}
	page, err := s.List(ctx, listOptions{Prefix: s.cfg.RootPrefix, MaxResults: 1})
	if err != nil {
		states[permissionRead] = capabilityState{
			Allowed:  false,
			Verified: true,
			Source:   "s3-list-probe",
			Reason:   "ListObjectsV2 failed: " + publicStorageError(err),
		}
		return discoveredCapabilities{States: states}, nil
	}
	permissions := []string{"s3:ListBucket"}
	if len(page.Objects) == 0 {
		states[permissionRead] = capabilityState{
			Allowed:  true,
			Verified: false,
			Source:   "s3-list-probe",
			Reason:   "ListObjectsV2 succeeded; GetObject cannot be verified because the prefix is empty",
		}
		return discoveredCapabilities{States: states, Permissions: permissions}, nil
	}
	if _, err := s.Head(ctx, page.Objects[0].Key); err != nil {
		states[permissionRead] = capabilityState{
			Allowed:  false,
			Verified: true,
			Source:   "s3-read-probe",
			Reason:   "ListObjectsV2 succeeded but HeadObject failed: " + publicStorageError(err),
		}
		return discoveredCapabilities{States: states, Permissions: permissions}, nil
	}
	permissions = append(permissions, "s3:GetObject")
	states[permissionRead] = capabilityState{
		Allowed:  true,
		Verified: true,
		Source:   "s3-read-probe",
		Reason:   "ListObjectsV2 and HeadObject succeeded",
	}
	return discoveredCapabilities{States: states, Permissions: permissions}, nil
}

func (s *s3Backend) do(
	ctx context.Context,
	method string,
	key string,
	query url.Values,
	body io.Reader,
	size int64,
	headers http.Header,
) (*http.Response, error) {
	u := s.objectURL(key, query)
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, fmt.Errorf("create s3 request: %w", err)
	}
	if headers != nil {
		req.Header = headers.Clone()
	}
	if body != nil {
		req.ContentLength = size
	}
	if s.authMode == "access_key" {
		if err := signS3Request(req, s.creds, s.region, time.Now().UTC()); err != nil {
			return nil, err
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("s3 request failed: %w", err)
	}
	return resp, nil
}

func (s *s3Backend) objectURL(key string, query url.Values) *url.URL {
	u := *s.endpoint
	decodedBase := strings.TrimRight(u.Path, "/")
	escapedBase := strings.TrimRight(u.EscapedPath(), "/")
	decodedPath := decodedBase + "/" + s.cfg.Bucket
	escapedPath := escapedBase + "/" + awsURIEncode(s.cfg.Bucket, true)
	if key != "" {
		decodedPath += "/" + key
		escapedPath += "/" + awsURIEncode(key, false)
	}
	u.Path = decodedPath
	u.RawPath = escapedPath
	if len(query) > 0 {
		u.RawQuery = canonicalQuery(query)
	} else {
		u.RawQuery = ""
	}
	return &u
}

func signS3Request(req *http.Request, creds s3Credentials, region string, now time.Time) error {
	if creds.AccessKeyID == "" || creds.SecretAccessKey == "" {
		return fmt.Errorf("cannot sign s3 request without credentials")
	}
	if region == "" {
		return fmt.Errorf("cannot sign s3 request without a region")
	}
	amzDate := now.UTC().Format("20060102T150405Z")
	dateStamp := now.UTC().Format("20060102")
	payloadHash := sha256Hex(nil)
	if req.Body != nil {
		payloadHash = "UNSIGNED-PAYLOAD"
	}
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	if creds.SessionToken != "" {
		req.Header.Set("x-amz-security-token", creds.SessionToken)
	}

	canonicalHeaders, signedHeaders := canonicalS3Headers(req)
	canonicalURI := req.URL.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI,
		canonicalRawQuery(req.URL.RawQuery),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := dateStamp + "/" + region + "/s3/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	dateKey := hmacSHA256([]byte("AWS4"+creds.SecretAccessKey), dateStamp)
	regionKey := hmacSHA256(dateKey, region)
	serviceKey := hmacSHA256(regionKey, "s3")
	signingKey := hmacSHA256(serviceKey, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s,SignedHeaders=%s,Signature=%s",
		creds.AccessKeyID,
		scope,
		signedHeaders,
		signature,
	))
	return nil
}

func canonicalS3Headers(req *http.Request) (string, string) {
	values := map[string][]string{
		"host": {req.URL.Host},
	}
	for name, headerValues := range req.Header {
		lower := strings.ToLower(name)
		if lower == "authorization" || lower == "user-agent" || lower == "accept-encoding" || lower == "content-length" {
			continue
		}
		if !strings.HasPrefix(lower, "x-amz-") && lower != "content-type" && lower != "content-md5" &&
			lower != "range" && lower != "if-match" && lower != "if-none-match" &&
			lower != "if-modified-since" && lower != "if-unmodified-since" {
			continue
		}
		values[lower] = append(values[lower], headerValues...)
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	var canonical strings.Builder
	for _, name := range names {
		normalized := make([]string, 0, len(values[name]))
		for _, value := range values[name] {
			normalized = append(normalized, strings.Join(strings.Fields(value), " "))
		}
		canonical.WriteString(name)
		canonical.WriteByte(':')
		canonical.WriteString(strings.Join(normalized, ","))
		canonical.WriteByte('\n')
	}
	return canonical.String(), strings.Join(names, ";")
}

func canonicalQuery(values url.Values) string {
	pairs := make([]string, 0)
	for key, list := range values {
		if len(list) == 0 {
			list = []string{""}
		}
		for _, value := range list {
			pairs = append(pairs, awsURIEncode(key, true)+"="+awsURIEncode(value, true))
		}
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}

func canonicalRawQuery(raw string) string {
	if raw == "" {
		return ""
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return raw
	}
	return canonicalQuery(values)
}

func awsURIEncode(value string, encodeSlash bool) string {
	const hexChars = "0123456789ABCDEF"
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ||
			ch == '-' || ch == '_' || ch == '.' || ch == '~' || (ch == '/' && !encodeSlash) {
			out.WriteByte(ch)
			continue
		}
		out.WriteByte('%')
		out.WriteByte(hexChars[ch>>4])
		out.WriteByte(hexChars[ch&15])
	}
	return out.String()
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func s3ResponseError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	var parsed struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	_ = xml.Unmarshal(body, &parsed)
	message := strings.TrimSpace(parsed.Message)
	if message == "" {
		message = strings.TrimSpace(string(body))
	}
	if message == "" {
		message = resp.Status
	}
	return &upstreamError{StatusCode: resp.StatusCode, Code: parsed.Code, Message: message}
}
