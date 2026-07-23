package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

type memoryObject struct {
	data        []byte
	contentType string
	modified    time.Time
}

type memoryMultipart struct {
	key         string
	contentType string
	parts       map[int][]byte
}

type memoryBackend struct {
	mu             sync.Mutex
	objects        map[string]memoryObject
	last           listOptions
	lastGetHeaders http.Header
	getRanges      []string
	getCount       int
	headCount      int
	ignoreRanges   bool
	multipart      map[string]*memoryMultipart
	nextUpload     int
}

func newMemoryBackend(objects map[string]string) *memoryBackend {
	backend := &memoryBackend{objects: make(map[string]memoryObject), multipart: make(map[string]*memoryMultipart)}
	for key, value := range objects {
		backend.objects[key] = memoryObject{data: []byte(value), contentType: "text/plain", modified: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	}
	return backend
}

func (m *memoryBackend) List(_ context.Context, options listOptions) (listPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.last = options
	keys := make([]string, 0, len(m.objects))
	for key := range m.objects {
		if strings.HasPrefix(key, options.Prefix) && (options.StartAfter == "" || key > options.StartAfter) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	page := listPage{}
	prefixes := make(map[string]struct{})
	for _, key := range keys {
		if options.Delimiter != "" {
			remainder := strings.TrimPrefix(key, options.Prefix)
			if index := strings.Index(remainder, options.Delimiter); index >= 0 {
				prefix := options.Prefix + remainder[:index+len(options.Delimiter)]
				prefixes[prefix] = struct{}{}
				continue
			}
		}
		object := m.objects[key]
		page.Objects = append(page.Objects, objectInfo{
			Key: key, Size: int64(len(object.data)), LastModified: object.modified, ETag: "etag-" + key, ContentType: object.contentType,
		})
	}
	for prefix := range prefixes {
		page.Prefixes = append(page.Prefixes, prefix)
	}
	sort.Strings(page.Prefixes)
	return page, nil
}

func (m *memoryBackend) Head(_ context.Context, key string) (objectResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.headCount++
	object, ok := m.objects[key]
	if !ok {
		return objectResponse{}, &upstreamError{StatusCode: http.StatusNotFound, Code: "NotFound", Message: "missing"}
	}
	headers := make(http.Header)
	headers.Set("Content-Type", object.contentType)
	headers.Set("Content-Length", strconv.Itoa(len(object.data)))
	headers.Set("ETag", `"etag-`+key+`"`)
	headers.Set("Last-Modified", object.modified.UTC().Format(http.TimeFormat))
	headers.Set("Set-Cookie", "should-not-leak=1")
	headers.Set("x-amz-meta-test", "visible")
	return objectResponse{StatusCode: http.StatusOK, Header: headers}, nil
}

func (m *memoryBackend) Get(_ context.Context, key string, requestHeaders http.Header) (objectResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	object, ok := m.objects[key]
	if !ok {
		return objectResponse{}, &upstreamError{StatusCode: http.StatusNotFound, Code: "NotFound", Message: "missing"}
	}
	m.lastGetHeaders = requestHeaders.Clone()
	m.getCount++
	m.getRanges = append(m.getRanges, requestHeaders.Get("Range"))
	data := object.data
	status := http.StatusOK
	contentRange := ""
	if value := strings.TrimSpace(requestHeaders.Get("Range")); !m.ignoreRanges && strings.HasPrefix(value, "bytes=") {
		raw := strings.TrimPrefix(value, "bytes=")
		parts := strings.SplitN(raw, "-", 2)
		if len(parts) == 2 && parts[0] == "" {
			length, lengthErr := strconv.Atoi(parts[1])
			if lengthErr == nil && length > 0 && len(data) > 0 {
				start := len(data) - length
				if start < 0 {
					start = 0
				}
				end := len(data) - 1
				contentRange = fmt.Sprintf("bytes %d-%d/%d", start, end, len(data))
				data = data[start : end+1]
				status = http.StatusPartialContent
			}
		} else if len(parts) == 2 {
			start, startErr := strconv.Atoi(parts[0])
			end := len(data) - 1
			endErr := error(nil)
			if strings.TrimSpace(parts[1]) != "" {
				end, endErr = strconv.Atoi(parts[1])
			}
			if startErr == nil && endErr == nil && start >= 0 && start < len(data) && end >= start {
				if end >= len(data) {
					end = len(data) - 1
				}
				contentRange = fmt.Sprintf("bytes %d-%d/%d", start, end, len(data))
				data = data[start : end+1]
				status = http.StatusPartialContent
			}
		}
	}
	headers := make(http.Header)
	headers.Set("Content-Type", object.contentType)
	headers.Set("Content-Length", strconv.Itoa(len(data)))
	headers.Set("ETag", `"etag-`+key+`"`)
	headers.Set("Last-Modified", object.modified.UTC().Format(http.TimeFormat))
	if contentRange != "" {
		headers.Set("Content-Range", contentRange)
	}
	headers.Set("Set-Cookie", "should-not-leak=1")
	headers.Set("x-amz-meta-test", "visible")
	return objectResponse{StatusCode: status, Header: headers, Body: io.NopCloser(bytes.NewReader(data))}, nil
}

func (m *memoryBackend) Put(_ context.Context, key string, body io.Reader, _ int64, contentType string) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = memoryObject{data: data, contentType: contentType, modified: time.Now().UTC()}
	return nil
}

func (m *memoryBackend) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, key)
	return nil
}

func (m *memoryBackend) Copy(_ context.Context, source, destination string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	object, ok := m.objects[source]
	if !ok {
		return &upstreamError{StatusCode: http.StatusNotFound, Code: "NotFound", Message: "missing"}
	}
	object.data = append([]byte(nil), object.data...)
	m.objects[destination] = object
	return nil
}

func (m *memoryBackend) DiscoverCapabilities(context.Context) (discoveredCapabilities, error) {
	return discoveredCapabilities{}, nil
}

func (m *memoryBackend) InitiateMultipart(_ context.Context, key, contentType string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextUpload++
	id := fmt.Sprintf("upload-%d", m.nextUpload)
	m.multipart[id] = &memoryMultipart{key: key, contentType: contentType, parts: make(map[int][]byte)}
	return id, nil
}

func (m *memoryBackend) UploadPart(_ context.Context, _ string, uploadID string, partNumber int, body io.Reader, _ int64) (string, error) {
	data, err := io.ReadAll(body)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	upload := m.multipart[uploadID]
	if upload == nil {
		return "", errors.New("multipart upload not found")
	}
	upload.parts[partNumber] = append([]byte(nil), data...)
	return fmt.Sprintf("etag-%d", partNumber), nil
}

func (m *memoryBackend) CompleteMultipart(_ context.Context, _ string, uploadID string, parts []s3CompletedPart) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	upload := m.multipart[uploadID]
	if upload == nil {
		return errors.New("multipart upload not found")
	}
	var data []byte
	for _, part := range parts {
		data = append(data, upload.parts[part.PartNumber]...)
	}
	m.objects[upload.key] = memoryObject{data: data, contentType: upload.contentType, modified: time.Now().UTC()}
	delete(m.multipart, uploadID)
	return nil
}

func (m *memoryBackend) AbortMultipart(_ context.Context, _ string, uploadID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.multipart, uploadID)
	return nil
}

func testApplication(t *testing.T) (*application, *memoryBackend, *memoryBackend) {
	t.Helper()
	readOnly := newMemoryBackend(map[string]string{"readonly.txt": "read"})
	readWrite := newMemoryBackend(map[string]string{
		"tenant/folder/direct.txt":      "direct",
		"tenant/folder/nested/deep.txt": "deep",
		"tenant/a//./../b\\c":           "opaque",
	})
	makeInstance := func(id string, backend *memoryBackend, root string, permissions ...string) *storageInstance {
		cfg := storageConfig{ID: id, Name: id, Provider: "s3", Bucket: id + "-bucket", Endpoint: "http://internal.invalid", Region: "test", RootPrefix: root, PermissionsDefined: true, Permissions: permissions}
		return &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}
	}
	publicFS := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok"), Mode: fs.FileMode(0o444)}}
	app := &application{
		config: appConfig{DataDir: t.TempDir()},
		instances: map[string]*storageInstance{
			"readonly": makeInstance("readonly", readOnly, "", permissionRead),
			"rw":       makeInstance("rw", readWrite, "tenant/", permissionRead, permissionWrite, permissionDelete),
		},
		order:    []string{"readonly", "rw"},
		publicFS: publicFS,
	}
	var err error
	app.jobs, err = newJobManager(app, app.config.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	app.uploads, err = newUploadManager(app, app.config.DataDir)
	if err != nil {
		app.jobs.close()
		t.Fatal(err)
	}
	t.Cleanup(app.close)
	return app, readOnly, readWrite
}

func TestEmbeddedFrontendKeepsFlatOriginalStyleTable(t *testing.T) {
	t.Parallel()
	data, err := embeddedPublic.ReadFile("public/index.html")
	if err != nil {
		t.Fatal(err)
	}
	html := string(data)
	for _, required := range []string{
		"assets/vendor/mdi/7.4.47/css/materialdesignicons.min.css",
		"class=\"storage-switcher\"",
		"icon=\"folder\"",
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("embedded index is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		" detailed",
		":detailed",
		"#detail",
		"mdi-chevron-right folder-expander",
	} {
		if strings.Contains(html, forbidden) {
			t.Fatalf("embedded index contains table-detail markup %q", forbidden)
		}
	}
}

func TestInstancesResponseDoesNotExposeCredentialsOrEndpoint(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/instances", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, forbidden := range []string{"internal.invalid", "secret_access_key", "access_key_id"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("response leaked %q: %s", forbidden, body)
		}
	}
	var response struct {
		Default   string         `json:"default"`
		Instances []instanceInfo `json:"instances"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Default != "readonly" || len(response.Instances) != 2 {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestPermissionEnforcementAndNativeRename(t *testing.T) {
	t.Parallel()
	app, readOnly, readWrite := testApplication(t)
	handler := app.routes()

	forbidden := httptest.NewRecorder()
	handler.ServeHTTP(forbidden, httptest.NewRequest(http.MethodPut, "/s3/new.txt?instance=readonly", strings.NewReader("blocked")))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("readonly PUT status = %d", forbidden.Code)
	}
	if _, exists := readOnly.objects["new.txt"]; exists {
		t.Fatal("readonly backend was modified")
	}

	body := `{"instance":"rw","src":"folder/direct.txt","dst":"folder/renamed.txt","isPrefix":false}`
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/rename", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	readWrite.mu.Lock()
	defer readWrite.mu.Unlock()
	if _, exists := readWrite.objects["tenant/folder/direct.txt"]; exists {
		t.Fatal("source still exists after rename")
	}
	if got := string(readWrite.objects["tenant/folder/renamed.txt"].data); got != "direct" {
		t.Fatalf("destination data = %q", got)
	}
}

func TestRecursiveListUsesExplicitEmptyDelimiter(t *testing.T) {
	t.Parallel()
	app, _, backend := testApplication(t)
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/list?instance=rw&prefix=folder%2F&delimiter=", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response listResponseJSON
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Delimiter != "" || len(response.Items) != 2 {
		t.Fatalf("response = %+v", response)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.last.Delimiter != "" {
		t.Fatalf("backend delimiter = %q", backend.last.Delimiter)
	}
}

func TestObjectGatewayRejectsAmbiguousQueryKey(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/s3?instance=rw&key=first&key=second", nil)
	app.routes().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestObjectGatewayPreservesOpaqueKeyAndFiltersHeaders(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/s3?instance=rw&key=a%2F%2F.%2F..%2Fb%5Cc", nil)
	app.routes().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Body.String(); got != "opaque" {
		t.Fatalf("body = %q", got)
	}
	if got := recorder.Header().Get("Set-Cookie"); got != "" {
		t.Fatalf("Set-Cookie leaked: %q", got)
	}
	if got := recorder.Header().Get("x-amz-meta-test"); got != "visible" {
		t.Fatalf("metadata header = %q", got)
	}
	if got := recorder.Header().Get("Content-Security-Policy"); !strings.Contains(got, "sandbox") {
		t.Fatalf("CSP = %q", got)
	}
}

func TestPreviewGatewayInfersMediaTypeAndForcesInline(t *testing.T) {
	t.Parallel()
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/video.mp4"] = memoryObject{
		data:        []byte("0123456789"),
		contentType: "application/octet-stream",
		modified:    time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/s3?instance=rw&preview=1&key=video.mp4", nil)
	request.Header.Set("Range", "bytes=0-3")
	app.routes().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "video/mp4" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "inline") {
		t.Fatalf("Content-Disposition = %q", got)
	}
	if got := recorder.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges = %q", got)
	}
	if got := recorder.Body.String(); got != "0123" {
		t.Fatalf("body = %q", got)
	}
}

func TestPreviewGatewayRejectsIgnoredRangeWithoutStreamingObject(t *testing.T) {
	t.Parallel()
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.ignoreRanges = true
	backend.objects["tenant/video.mp4"] = memoryObject{
		data:        bytes.Repeat([]byte("x"), 1024),
		contentType: "video/mp4",
		modified:    time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/s3?instance=rw&preview=1&key=video.mp4", nil)
	request.Header.Set("Range", "bytes=0-31")
	app.routes().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), strings.Repeat("x", 64)) {
		t.Fatal("gateway streamed the ignored full-object response")
	}
	if !strings.Contains(recorder.Body.String(), "did not honor the byte-range request") {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestPrefixDestinationCannotBeInsideSource(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	body := `{"instance":"rw","src":"folder/","dst":"folder/copy/","isPrefix":true}`
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/copy", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	app.routes().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "destination cannot be inside source") {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestPrefixDestinationCannotContainSource(t *testing.T) {
	t.Parallel()
	app, _, backend := testApplication(t)
	body := `{"instance":"rw","src":"folder/nested/","dst":"folder/","isPrefix":true}`
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/copy", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	app.routes().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "object paths would overlap") {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if got := string(backend.objects["tenant/folder/nested/deep.txt"].data); got != "deep" {
		t.Fatalf("source was modified: %q", got)
	}
}

func TestAPIStorageErrorsDoNotExposeRequestURL(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	err := fmt.Errorf("s3 request failed: %w", &url.Error{
		Op:  "Get",
		URL: "https://internal.example.test/private?credential=secret",
		Err: errors.New("dial failed"),
	})
	writeAPIError(recorder, err)
	if strings.Contains(recorder.Body.String(), "internal.example.test") || strings.Contains(recorder.Body.String(), "credential") {
		t.Fatalf("response leaked request URL: %s", recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestFolderListingDoesNotProbeObjectHeaders(t *testing.T) {
	app, _, backend := testApplication(t)
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/list?instance=rw&prefix=folder%2F&delimiter=%2F", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.getCount != 0 || backend.headCount != 0 {
		t.Fatalf("listing performed %d GET and %d HEAD object probes", backend.getCount, backend.headCount)
	}
}
