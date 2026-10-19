package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func sha256Base64(data []byte) string {
	sum := sha256.Sum256(data)
	return base64.StdEncoding.EncodeToString(sum[:])
}

// checksumMemory is a memoryBackend that behaves like a provider with SHA-256 checksums: it refuses a part whose body does
// not match the digest of the request, stores the digests, echoes them, and reports the composite checksum of the object.
type checksumMemory struct {
	*memoryBackend
	mu         sync.Mutex
	algorithm  bool
	digests    map[string]map[int]string
	completed  []s3CompletedPart
	objectHash map[string]string
	silent     bool
	// noPartChecksums makes the list of parts omit the digests, as SeaweedFS does.
	noPartChecksums bool
}

func newChecksumMemory(memory *memoryBackend) *checksumMemory {
	return &checksumMemory{memoryBackend: memory, digests: map[string]map[int]string{}, objectHash: map[string]string{}}
}

func (c *checksumMemory) InitiateMultipart(ctx context.Context, key, contentType string) (string, error) {
	c.mu.Lock()
	c.algorithm = checksumAlgorithmFrom(ctx)
	c.mu.Unlock()
	return c.memoryBackend.InitiateMultipart(ctx, key, contentType)
}

func (c *checksumMemory) UploadPart(ctx context.Context, key, uploadID string, partNumber int, body io.Reader, size int64) (string, error) {
	data, err := io.ReadAll(body)
	if err != nil {
		return "", err
	}
	if transfer := checksumTransferFrom(ctx); transfer != nil && !c.silent {
		if transfer.SHA256 != sha256Base64(data) {
			return "", &upstreamError{StatusCode: http.StatusBadRequest, Code: "BadDigest", Message: "the checksum does not match the part"}
		}
		c.mu.Lock()
		if c.digests[uploadID] == nil {
			c.digests[uploadID] = map[int]string{}
		}
		c.digests[uploadID][partNumber] = transfer.SHA256
		c.mu.Unlock()
		transfer.Echoed = transfer.SHA256
	}
	return c.memoryBackend.UploadPart(ctx, key, uploadID, partNumber, bytes.NewReader(data), size)
}

func (c *checksumMemory) ListMultipartParts(ctx context.Context, key, uploadID string) ([]multipartPart, error) {
	parts, err := c.memoryBackend.ListMultipartParts(ctx, key, uploadID)
	c.mu.Lock()
	defer c.mu.Unlock()
	for index := range parts {
		if !c.noPartChecksums {
			parts[index].ChecksumSHA256 = c.digests[uploadID][parts[index].PartNumber]
		}
	}
	return parts, err
}

func (c *checksumMemory) CompleteMultipart(ctx context.Context, key, uploadID string, parts []s3CompletedPart) error {
	c.mu.Lock()
	c.completed = append([]s3CompletedPart(nil), parts...)
	states := make([]uploadPartState, 0, len(parts))
	for _, part := range parts {
		states = append(states, uploadPartState{PartNumber: part.PartNumber, ChecksumSHA256: part.ChecksumSHA256})
	}
	if digest, count, err := compositeChecksum(states); err == nil {
		c.objectHash[key] = fmt.Sprintf("%s-%d", digest, count)
	}
	c.mu.Unlock()
	return c.memoryBackend.CompleteMultipart(ctx, key, uploadID, parts)
}

func (c *checksumMemory) Head(ctx context.Context, key string) (objectResponse, error) {
	response, err := c.memoryBackend.Head(ctx, key)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil && c.objectHash[key] != "" && !c.silent {
		response.Header.Set("x-amz-checksum-sha256", c.objectHash[key])
	}
	return response, err
}

func (c *checksumMemory) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if transfer := checksumTransferFrom(ctx); transfer != nil && !c.silent {
		if transfer.SHA256 != sha256Base64(data) {
			return &upstreamError{StatusCode: http.StatusBadRequest, Code: "BadDigest", Message: "the checksum does not match the object"}
		}
		transfer.Echoed = transfer.SHA256
	}
	return c.memoryBackend.Put(ctx, key, bytes.NewReader(data), size, contentType)
}

func checksumTestApplication(t *testing.T) (*application, *checksumMemory) {
	app, _, memory := testApplication(t)
	backend := newChecksumMemory(memory)
	app.instances["rw"].backend = backend
	return app, backend
}

func createChecksumUpload(t *testing.T, app *application, key string, size int64, algorithm string) *httptest.ResponseRecorder {
	t.Helper()
	return postJSON(t, app.routes(), "/api/uploads", map[string]any{
		"instance": "rw", "key": key, "size": size, "contentType": "application/octet-stream", "checksum": algorithm,
	})
}

func putChecksumChunk(app *application, token string, data []byte, start, total int64, digest string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/uploads", bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(start+int64(len(data))-1, 10)+"/"+strconv.FormatInt(total, 10))
	request.Header.Set("X-S3-Browser-Resume-Token", token)
	if digest != "" {
		request.Header.Set(checksumHeader, digest)
	}
	app.routes().ServeHTTP(recorder, request)
	return recorder
}

func decodeUpload(t *testing.T, recorder *httptest.ResponseRecorder) publicUpload {
	t.Helper()
	var upload publicUpload
	if err := json.Unmarshal(recorder.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	return upload
}

func TestChecksumUploadSendsEachPartDigestAndConfirmsTheCompositeChecksum(t *testing.T) {
	app, backend := checksumTestApplication(t)
	const total = int64(16<<20) + 17
	recorder := createChecksumUpload(t, app, "sum.bin", total, "sha256")
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	created := decodeUpload(t, recorder)
	if created.Checksum != "sha256" || !backend.algorithm {
		t.Fatalf("checksum = %q, algorithm requested = %v", created.Checksum, backend.algorithm)
	}
	first := bytes.Repeat([]byte{'a'}, int(created.ChunkSize))
	if got := putChecksumChunk(app, created.ResumeToken, first, 0, total, sha256Base64(first)); got.Code != http.StatusOK {
		t.Fatalf("first chunk = %d %s", got.Code, got.Body.String())
	}
	last := bytes.Repeat([]byte{'b'}, int(total-int64(len(first))))
	got := putChecksumChunk(app, created.ResumeToken, last, int64(len(first)), total, sha256Base64(last))
	if got.Code != http.StatusOK {
		t.Fatalf("last chunk = %d %s", got.Code, got.Body.String())
	}
	done := decodeUpload(t, got)
	if done.Status != uploadStatusCompleted || !done.Verified || !done.ChecksumVerified {
		t.Fatalf("completed = %+v", done)
	}
	if len(backend.completed) != 2 || backend.completed[0].ChecksumSHA256 != sha256Base64(first) || backend.completed[1].ChecksumSHA256 != sha256Base64(last) {
		t.Fatalf("completion parts = %+v", backend.completed)
	}
}

func TestChecksumUploadRefusesAChunkWithoutOrWithAWrongDigest(t *testing.T) {
	app, _ := checksumTestApplication(t)
	const total = int64(6 << 20)
	created := decodeUpload(t, createChecksumUpload(t, app, "bad.bin", total, "sha256"))
	data := bytes.Repeat([]byte{'x'}, int(total))
	if got := putChecksumChunk(app, created.ResumeToken, data, 0, total, ""); got.Code != http.StatusBadRequest || !strings.Contains(got.Body.String(), "checksum_required") {
		t.Fatalf("no digest = %d %s", got.Code, got.Body.String())
	}
	if got := putChecksumChunk(app, created.ResumeToken, data, 0, total, "not-base64!"); got.Code != http.StatusBadRequest || !strings.Contains(got.Body.String(), "invalid_checksum") {
		t.Fatalf("bad encoding = %d %s", got.Code, got.Body.String())
	}
	if got := putChecksumChunk(app, created.ResumeToken, data, 0, total, base64.StdEncoding.EncodeToString([]byte("short"))); got.Code != http.StatusBadRequest {
		t.Fatalf("short digest = %d %s", got.Code, got.Body.String())
	}
	wrong := sha256Base64([]byte("other bytes"))
	if got := putChecksumChunk(app, created.ResumeToken, data, 0, total, wrong); got.Code == http.StatusOK {
		t.Fatalf("a digest that does not match the part was accepted: %s", got.Body.String())
	}
	if got := putChecksumChunk(app, created.ResumeToken, data, 0, total, sha256Base64(data)); got.Code != http.StatusOK {
		t.Fatalf("right digest after the refusals = %d %s", got.Code, got.Body.String())
	}
}

func TestUploadWithoutChecksumKeepsWorkingAndRefusesUnknownAlgorithms(t *testing.T) {
	app, backend := checksumTestApplication(t)
	created := decodeUpload(t, createChecksumUpload(t, app, "plain.bin", 6<<20, ""))
	if created.Checksum != "" || backend.algorithm {
		t.Fatalf("checksum = %q, algorithm requested = %v", created.Checksum, backend.algorithm)
	}
	data := bytes.Repeat([]byte{'p'}, 6<<20)
	got := putChecksumChunk(app, created.ResumeToken, data, 0, 6<<20, "")
	if got.Code != http.StatusOK {
		t.Fatalf("plain chunk = %d %s", got.Code, got.Body.String())
	}
	if done := decodeUpload(t, got); !done.Verified || done.ChecksumVerified {
		t.Fatalf("completed = %+v", done)
	}
	if got := createChecksumUpload(t, app, "md5.bin", 6<<20, "md5"); got.Code != http.StatusBadRequest {
		t.Fatalf("unknown algorithm = %d %s", got.Code, got.Body.String())
	}
}

func TestChecksumUploadIsNotVerifiedWhenTheProviderStoresNoChecksum(t *testing.T) {
	app, backend := checksumTestApplication(t)
	backend.silent = true
	const total = int64(6 << 20)
	created := decodeUpload(t, createChecksumUpload(t, app, "silent.bin", total, "sha256"))
	data := bytes.Repeat([]byte{'s'}, int(total))
	got := putChecksumChunk(app, created.ResumeToken, data, 0, total, sha256Base64(data))
	if got.Code != http.StatusOK {
		t.Fatalf("chunk = %d %s", got.Code, got.Body.String())
	}
	if done := decodeUpload(t, got); done.Status != uploadStatusCompleted || done.ChecksumVerified {
		t.Fatalf("completed = %+v", done)
	}
}

func TestChecksumUploadDetectsACompositeChecksumThatDiffers(t *testing.T) {
	upload := &uploadSession{Checksum: uploadChecksumSHA256, Parts: []uploadPartState{
		{PartNumber: 1, ChecksumSHA256: sha256Base64([]byte("one")), ChecksumStored: true},
		{PartNumber: 2, ChecksumSHA256: sha256Base64([]byte("two")), ChecksumStored: true},
	}}
	digest, count, err := compositeChecksum(upload.Parts)
	if err != nil {
		t.Fatal(err)
	}
	// S3 writes the digest and the number of parts; Garage writes the digest only.
	for _, good := range []string{fmt.Sprintf("%s-%d", digest, count), digest} {
		upload.ChecksumVerified = false
		if err := verifyUploadChecksum(http.Header{"X-Amz-Checksum-Sha256": {good}}, upload); err != nil || !upload.ChecksumVerified {
			t.Fatalf("good composite %q: %v, verified = %v", good, err, upload.ChecksumVerified)
		}
	}
	if err := verifyUploadChecksum(http.Header{"X-Amz-Checksum-Sha256": {digest + "-3"}}, upload); err == nil || upload.ChecksumVerified {
		t.Fatalf("a composite with another part count was accepted: %v", err)
	}
	if err := verifyUploadChecksum(http.Header{"X-Amz-Checksum-Sha256": {sha256Base64([]byte("x")) + "-2"}}, upload); err == nil || upload.ChecksumVerified {
		t.Fatalf("a different composite was accepted: %v", err)
	}
	if err := verifyUploadChecksum(http.Header{}, upload); err != nil || !upload.ChecksumVerified {
		t.Fatalf("a provider that reports no object checksum: %v, verified = %v", err, upload.ChecksumVerified)
	}
}

func TestResumedChecksumUploadKeepsItsAlgorithmAndPartDigests(t *testing.T) {
	app, backend := checksumTestApplication(t)
	const total = int64(10 << 20)
	created := decodeUpload(t, createChecksumUpload(t, app, "resume-sum.bin", total, "sha256"))
	first := bytes.Repeat([]byte{'r'}, 5<<20)
	if got := putChecksumChunk(app, created.ResumeToken, first, 0, total, sha256Base64(first)); got.Code != http.StatusOK {
		t.Fatalf("first chunk = %d %s", got.Code, got.Body.String())
	}
	// The process loses its memory: the token carries the algorithm and the provider lists the digests of the stored parts.
	var err error
	if app.uploads, err = newUploadManager(app); err != nil {
		t.Fatal(err)
	}
	resumed := postJSON(t, app.routes(), "/api/uploads/resume", map[string]string{"resumeToken": created.ResumeToken})
	if resumed.Code != http.StatusOK {
		t.Fatalf("resume = %d %s", resumed.Code, resumed.Body.String())
	}
	if upload := decodeUpload(t, resumed); upload.Checksum != "sha256" || upload.UploadedBytes != int64(len(first)) {
		t.Fatalf("resumed = %+v", upload)
	}
	second := bytes.Repeat([]byte{'s'}, 5<<20)
	got := putChecksumChunk(app, created.ResumeToken, second, int64(len(first)), total, sha256Base64(second))
	if got.Code != http.StatusOK {
		t.Fatalf("second chunk = %d %s", got.Code, got.Body.String())
	}
	if done := decodeUpload(t, got); done.Status != uploadStatusCompleted || !done.ChecksumVerified {
		t.Fatalf("completed = %+v", done)
	}
	if len(backend.completed) != 2 || backend.completed[0].ChecksumSHA256 != sha256Base64(first) {
		t.Fatalf("completion parts = %+v", backend.completed)
	}
}

func gatewayPut(app *application, key string, body []byte, digest string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/s3?instance=rw&key="+key, bytes.NewReader(body))
	request.Header.Set("Content-Type", "text/plain")
	if digest != "" {
		request.Header.Set(checksumHeader, digest)
	}
	app.routes().ServeHTTP(recorder, request)
	return recorder
}

func TestGatewayPutChecksumIsCheckedAndConfirmed(t *testing.T) {
	app, backend := checksumTestApplication(t)
	body := []byte("small file")
	got := gatewayPut(app, "small.txt", body, sha256Base64(body))
	if got.Code != http.StatusNoContent || got.Header().Get("X-Checksum-Sha256-Verified") != "true" {
		t.Fatalf("put = %d, headers = %v", got.Code, got.Header())
	}
	if got := gatewayPut(app, "plain.txt", body, ""); got.Code != http.StatusNoContent || got.Header().Get("X-Checksum-Sha256-Verified") != "" {
		t.Fatalf("put without digest = %d, headers = %v", got.Code, got.Header())
	}
	if got := gatewayPut(app, "wrong.txt", body, sha256Base64([]byte("other"))); got.Code == http.StatusNoContent {
		t.Fatalf("a wrong digest was accepted")
	}
	if got := gatewayPut(app, "bad.txt", body, "%%%"); got.Code != http.StatusBadRequest {
		t.Fatalf("an invalid digest = %d", got.Code)
	}
	backend.silent = true
	if got := gatewayPut(app, "silent.txt", body, sha256Base64(body)); got.Code != http.StatusNoContent || got.Header().Get("X-Checksum-Sha256-Verified") != "" {
		t.Fatalf("a provider without checksums = %d, headers = %v", got.Code, got.Header())
	}
}

func TestS3BackendSendsAndReadsChecksums(t *testing.T) {
	t.Parallel()
	digest := sha256Base64([]byte("part-one"))
	var initiate, put, completion string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Query().Has("uploads"):
			initiate = r.Header.Get("x-amz-checksum-algorithm")
			_, _ = io.WriteString(w, `<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>`)
		case r.Method == http.MethodPut && r.URL.Query().Get("partNumber") == "1":
			put = r.Header.Get("x-amz-checksum-sha256")
			w.Header().Set("x-amz-checksum-sha256", put)
			w.Header().Set("ETag", `"e1"`)
		case r.Method == http.MethodPut:
			put = r.Header.Get("x-amz-checksum-sha256")
			w.Header().Set("x-amz-checksum-sha256", put)
		case r.Method == http.MethodPost:
			body, _ := io.ReadAll(r.Body)
			completion = string(body)
			_, _ = io.WriteString(w, `<CompleteMultipartUploadResult/>`)
		case r.Method == http.MethodGet && r.URL.Query().Get("uploadId") == "u1":
			_, _ = io.WriteString(w, `<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>"e1"</ETag><Size>8</Size><ChecksumSHA256>`+digest+`</ChecksumSHA256></Part></ListPartsResult>`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	ctx := context.Background()
	if _, err := backend.InitiateMultipart(withChecksumAlgorithm(ctx), "k", ""); err != nil || initiate != "SHA256" {
		t.Fatalf("initiate: algorithm = %q, err = %v", initiate, err)
	}
	if _, err := backend.InitiateMultipart(ctx, "k", ""); err != nil || initiate != "" {
		t.Fatalf("initiate without algorithm: %q, err = %v", initiate, err)
	}
	transfer := &checksumTransfer{SHA256: digest}
	if _, err := backend.UploadPart(withChecksumTransfer(ctx, transfer), "k", "u1", 1, strings.NewReader("part-one"), 8); err != nil || put != digest || transfer.Echoed != digest {
		t.Fatalf("upload part: sent = %q, echoed = %q, err = %v", put, transfer.Echoed, err)
	}
	if err := backend.CompleteMultipart(ctx, "k", "u1", []s3CompletedPart{{PartNumber: 1, ETag: "e1", ChecksumSHA256: digest}}); err != nil || !strings.Contains(completion, "<ChecksumSHA256>"+digest+"</ChecksumSHA256>") {
		t.Fatalf("complete: %s, err = %v", completion, err)
	}
	parts, err := backend.ListMultipartParts(ctx, "k", "u1")
	if err != nil || len(parts) != 1 || parts[0].ChecksumSHA256 != digest {
		t.Fatalf("list parts = %+v, err = %v", parts, err)
	}
	single := &checksumTransfer{SHA256: digest}
	if err := backend.Put(withChecksumTransfer(ctx, single), "o", strings.NewReader("part-one"), 8, "text/plain"); err != nil || single.Echoed != digest {
		t.Fatalf("put: echoed = %q, err = %v", single.Echoed, err)
	}
}

func TestChecksumUploadKeepsThePartDigestsThatAProviderDoesNotList(t *testing.T) {
	app, backend := checksumTestApplication(t)
	backend.noPartChecksums = true
	const total = int64(10 << 20)
	created := decodeUpload(t, createChecksumUpload(t, app, "keep.bin", total, "sha256"))
	first := bytes.Repeat([]byte{'k'}, 5<<20)
	if got := putChecksumChunk(app, created.ResumeToken, first, 0, total, sha256Base64(first)); got.Code != http.StatusOK {
		t.Fatalf("first chunk = %d %s", got.Code, got.Body.String())
	}
	// A status request reads the parts of the provider again. The provider lists no digest: the server keeps its own.
	status := postJSON(t, app.routes(), "/api/uploads/resume", map[string]string{"resumeToken": created.ResumeToken})
	if status.Code != http.StatusOK {
		t.Fatalf("status = %d %s", status.Code, status.Body.String())
	}
	second := bytes.Repeat([]byte{'l'}, 5<<20)
	got := putChecksumChunk(app, created.ResumeToken, second, int64(len(first)), total, sha256Base64(second))
	if got.Code != http.StatusOK {
		t.Fatalf("second chunk = %d %s", got.Code, got.Body.String())
	}
	if done := decodeUpload(t, got); done.Status != uploadStatusCompleted || !done.ChecksumVerified {
		t.Fatalf("completed = %+v", done)
	}
}
