package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newAnonymousS3BackendForTest(t *testing.T, endpoint, bucket string) *s3Backend {
	t.Helper()
	auth, err := newSharedAuthentication(authConfig{
		ID: "test-s3", Provider: "s3", Mode: "anonymous", Endpoint: endpoint, Region: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(auth.close)
	backend, err := newS3BackendWithAuthentication(bucketConfig{
		ID: "test-bucket", AuthID: auth.cfg.ID, Provider: "s3", Region: auth.cfg.Region, Bucket: bucket,
	}, auth)
	if err != nil {
		t.Fatal(err)
	}
	return backend
}

func TestSignS3RequestAWSReferenceVector(t *testing.T) {
	t.Parallel()
	req, err := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", "bytes=0-9")
	credentials := s3Credentials{
		AccessKeyID:     "AKIAIOSFODNN7EXAMPLE",
		SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	}
	when := time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
	if err := signS3Request(req, credentials, "us-east-1", when); err != nil {
		t.Fatal(err)
	}
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization:\n got %s\nwant %s", got, want)
	}
	if got := req.Header.Get("x-amz-content-sha256"); got != sha256Hex(nil) {
		t.Fatalf("payload hash = %q", got)
	}
}

func TestCanonicalQueryAndObjectPathEncoding(t *testing.T) {
	t.Parallel()
	values := url.Values{
		"prefix":   {"a b/+"},
		"max-keys": {"2"},
		"empty":    {""},
	}
	if got, want := canonicalQuery(values), "empty=&max-keys=2&prefix=a%20b%2F%2B"; got != want {
		t.Fatalf("canonicalQuery = %q, want %q", got, want)
	}

	backend := &s3Backend{
		cfg:      bucketConfig{Bucket: "my bucket"},
		endpoint: mustURL(t, "https://example.test/base"),
	}
	u := backend.objectURL("a//./../b +é.txt", nil)
	if got, want := u.EscapedPath(), "/base/my%20bucket/a//./../b%20%2B%C3%A9.txt"; got != want {
		t.Fatalf("escaped path = %q, want %q", got, want)
	}
}

func TestS3CopyDetectsErrorInsideSuccessfulHTTPResponse(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `<Error><Code>InternalError</Code><Message>copy failed</Message></Error>`)
	}))
	defer server.Close()

	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	err := backend.Copy(context.Background(), "source", "destination")
	if err == nil || !strings.Contains(err.Error(), "InternalError: copy failed") {
		t.Fatalf("Copy() error = %v", err)
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestS3GetPassesThroughNotModified(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != `"etag"` {
			t.Errorf("If-None-Match = %q", got)
		}
		w.Header().Set("ETag", `"etag"`)
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()

	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	headers := make(http.Header)
	headers.Set("If-None-Match", `"etag"`)
	response, err := backend.Get(context.Background(), "object.txt", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotModified || response.Header.Get("ETag") != `"etag"` {
		t.Fatalf("response = %+v", response)
	}
}

func TestS3MultipartLifecycle(t *testing.T) {
	t.Parallel()
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.RawQuery)
		switch {
		case r.Method == http.MethodPost && r.URL.Query().Has("uploads"):
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<InitiateMultipartUploadResult><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>`)
		case r.Method == http.MethodPut && r.URL.Query().Get("partNumber") == "1":
			body, _ := io.ReadAll(r.Body)
			if string(body) != "part-one" {
				t.Errorf("part body = %q", body)
			}
			w.Header().Set("ETag", `"etag-one"`)
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Query().Get("uploadId") == "upload-123":
			body, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(body), `<PartNumber>1</PartNumber>`) || !strings.Contains(string(body), `<ETag>&#34;etag-one&#34;</ETag>`) {
				t.Errorf("completion body = %s", body)
			}
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<CompleteMultipartUploadResult/>`)
		case r.Method == http.MethodDelete && r.URL.Query().Get("uploadId") == "upload-123":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	uploadID, err := backend.InitiateMultipart(context.Background(), "large.bin", "application/octet-stream")
	if err != nil || uploadID != "upload-123" {
		t.Fatalf("initiate = %q, %v", uploadID, err)
	}
	etag, err := backend.UploadPart(context.Background(), "large.bin", uploadID, 1, strings.NewReader("part-one"), 8)
	if err != nil || etag != "etag-one" {
		t.Fatalf("upload part = %q, %v", etag, err)
	}
	if err := backend.CompleteMultipart(context.Background(), "large.bin", uploadID, []s3CompletedPart{{PartNumber: 1, ETag: etag}}); err != nil {
		t.Fatal(err)
	}
	if err := backend.AbortMultipart(context.Background(), "large.bin", uploadID); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 4 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestS3MultipartCompletionDetectsEmbeddedError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		_, _ = io.WriteString(w, `<Error><Code>InternalError</Code><Message>failed</Message></Error>`)
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	err := backend.CompleteMultipart(context.Background(), "large.bin", "upload", []s3CompletedPart{{PartNumber: 1, ETag: "etag"}})
	if err == nil || !strings.Contains(err.Error(), "InternalError") {
		t.Fatalf("error = %v", err)
	}
}

func TestS3GetForwardsRangeResumeHeaders(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Range"); got != "bytes=100-" {
			t.Errorf("Range = %q", got)
		}
		if got := r.Header.Get("If-Range"); got != `"etag"` {
			t.Errorf("If-Range = %q", got)
		}
		w.Header().Set("Content-Range", "bytes 100-102/103")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "end")
	}))
	defer server.Close()

	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	headers := make(http.Header)
	headers.Set("Range", "bytes=100-")
	headers.Set("If-Range", `"etag"`)
	response, err := backend.Get(context.Background(), "object.bin", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d", response.StatusCode)
	}
}

func TestS3ObjectVersionLifecycle(t *testing.T) {
	t.Parallel()
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.EscapedPath()+"?"+r.URL.RawQuery)
		switch {
		case r.Method == http.MethodGet && r.URL.Query().Has("versions"):
			if got := r.URL.Query().Get("prefix"); got != "folder/file.txt" {
				t.Errorf("prefix = %q", got)
			}
			if got := r.URL.Query().Get("max-keys"); got != "250" {
				t.Errorf("max-keys = %q", got)
			}
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<ListVersionsResult>
<IsTruncated>true</IsTruncated><NextKeyMarker>folder/file.txt</NextKeyMarker><NextVersionIdMarker>v1</NextVersionIdMarker>
<Version><Key>folder/file.txt</Key><VersionId>v1</VersionId><IsLatest>false</IsLatest><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;etag-1&quot;</ETag><Size>3</Size></Version>
<Version><Key>folder/file.txt</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest><LastModified>2026-01-02T00:00:00.000Z</LastModified><ETag>&quot;etag-2&quot;</ETag><Size>4</Size></Version>
<DeleteMarker><Key>folder/file.txt</Key><VersionId>deleted</VersionId><IsLatest>false</IsLatest><LastModified>2025-12-31T00:00:00.000Z</LastModified></DeleteMarker>
<Version><Key>folder/file.txt-copy</Key><VersionId>other</VersionId><IsLatest>true</IsLatest><LastModified>2026-01-03T00:00:00.000Z</LastModified><Size>5</Size></Version>
</ListVersionsResult>`)
		case r.Method == http.MethodHead && r.URL.Query().Get("versionId") == "v1":
			if got := r.Header.Get("x-amz-checksum-mode"); got != "ENABLED" {
				t.Errorf("checksum mode = %q", got)
			}
			w.Header().Set("Content-Length", "3")
			w.Header().Set("x-amz-checksum-sha256", "YWJj")
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet && r.URL.Query().Get("versionId") == "v1":
			if got := r.Header.Get("Range"); got != "bytes=0-1" {
				t.Errorf("Range = %q", got)
			}
			w.Header().Set("Content-Range", "bytes 0-1/3")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, "ab")
		case r.Method == http.MethodDelete && r.URL.Query().Get("versionId") == "v1":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPut && r.URL.Query().Get("versionId") == "":
			if got := r.Header.Get("x-amz-copy-source"); got != "/bucket/folder/file.txt?versionId=v1" {
				t.Errorf("copy source = %q", got)
			}
			_, _ = io.WriteString(w, `<CopyObjectResult/>`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	page, err := backend.ListObjectVersions(context.Background(), "folder/file.txt", "", 250)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Versions) != 3 || page.Versions[0].Version != "v2" || !page.Versions[0].IsCurrent || !page.Versions[2].DeleteMarker {
		t.Fatalf("versions = %+v", page.Versions)
	}
	cursor, err := decodeS3VersionCursor(page.NextPageToken)
	if err != nil || cursor.KeyMarker != "folder/file.txt" || cursor.VersionIDMarker != "v1" {
		t.Fatalf("cursor = %+v, %v", cursor, err)
	}
	head, err := backend.HeadObjectVersion(context.Background(), "folder/file.txt", "v1")
	if err != nil || head.Header.Get("x-amz-checksum-sha256") != "YWJj" {
		t.Fatalf("head = %+v, %v", head, err)
	}
	headers := make(http.Header)
	headers.Set("Range", "bytes=0-1")
	response, err := backend.GetObjectVersion(context.Background(), "folder/file.txt", "v1", headers)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusPartialContent || string(body) != "ab" {
		t.Fatalf("version body = %q status=%d", body, response.StatusCode)
	}
	if err := backend.DeleteObjectVersion(context.Background(), "folder/file.txt", "v1"); err != nil {
		t.Fatal(err)
	}
	if err := backend.RestoreObjectVersion(context.Background(), "folder/file.txt", "v1"); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 5 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestS3ListMultipartPartsPaginatesAndSorts(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Query().Get("uploadId") != "upload-1" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		if r.URL.Query().Get("part-number-marker") == "" {
			_, _ = io.WriteString(w, `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>&quot;one&quot;</ETag><Size>5</Size></Part></ListPartsResult>`)
			return
		}
		if r.URL.Query().Get("part-number-marker") != "1" {
			t.Errorf("marker = %q", r.URL.Query().Get("part-number-marker"))
		}
		_, _ = io.WriteString(w, `<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><ETag>&quot;two&quot;</ETag><Size>7</Size></Part></ListPartsResult>`)
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	parts, err := backend.ListMultipartParts(context.Background(), "large.bin", "upload-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 2 || parts[0].PartNumber != 1 || parts[1].ETag != "two" || parts[1].Size != 7 {
		t.Fatalf("parts = %+v", parts)
	}
}

func TestS3PutIfAbsentUsesAtomicPrecondition(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s", r.Method)
		}
		if got := r.Header.Get("If-None-Match"); got != "*" {
			t.Errorf("If-None-Match = %q", got)
		}
		w.WriteHeader(http.StatusPreconditionFailed)
	}))
	defer server.Close()

	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	err := backend.PutIfAbsent(context.Background(), "existing.txt", strings.NewReader("value"), 5, "text/plain")
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict || apiErr.Code != "object_exists" {
		t.Fatalf("PutIfAbsent() error = %#v", err)
	}
}
