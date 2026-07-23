package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

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
		cfg:      storageConfig{Bucket: "my bucket"},
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

	backend, err := newS3Backend(storageConfig{
		Provider: "s3", Endpoint: server.URL, Region: "test", Bucket: "bucket", Auth: "anonymous",
	})
	if err != nil {
		t.Fatal(err)
	}
	err = backend.Copy(context.Background(), "source", "destination")
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

	backend, err := newS3Backend(storageConfig{
		Provider: "s3", Endpoint: server.URL, Region: "test", Bucket: "bucket", Auth: "anonymous",
	})
	if err != nil {
		t.Fatal(err)
	}
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

	backend, err := newS3Backend(storageConfig{Provider: "s3", Endpoint: server.URL, Region: "test", Bucket: "bucket", Auth: "anonymous"})
	if err != nil {
		t.Fatal(err)
	}
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
	backend, err := newS3Backend(storageConfig{Provider: "s3", Endpoint: server.URL, Region: "test", Bucket: "bucket", Auth: "anonymous"})
	if err != nil {
		t.Fatal(err)
	}
	err = backend.CompleteMultipart(context.Background(), "large.bin", "upload", []s3CompletedPart{{PartNumber: 1, ETag: "etag"}})
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

	backend, err := newS3Backend(storageConfig{
		Provider: "s3", Endpoint: server.URL, Region: "test", Bucket: "bucket", Auth: "anonymous",
	})
	if err != nil {
		t.Fatal(err)
	}
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
