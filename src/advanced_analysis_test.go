package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type memoryVersionBackend struct {
	*memoryBackend
	versions map[string][]memoryVersionRecord
	deleted  []string
	listErr  error
}

type memoryVersionRecord struct {
	id           string
	data         []byte
	contentType  string
	modified     time.Time
	current      bool
	deleteMarker bool
}

func (m *memoryVersionBackend) ListObjectVersions(_ context.Context, key, pageToken string, maximum int) (objectVersionPage, error) {
	if m.listErr != nil {
		return objectVersionPage{}, m.listErr
	}
	if pageToken != "" {
		return objectVersionPage{}, nil
	}
	records := m.versions[key]
	if maximum > 0 && len(records) > maximum {
		records = records[:maximum]
	}
	page := objectVersionPage{}
	for _, record := range records {
		page.Versions = append(page.Versions, storedObjectVersion{
			Version: record.id, IsCurrent: record.current, DeleteMarker: record.deleteMarker,
			Size: int64(len(record.data)), LastModified: record.modified, ContentType: record.contentType,
		})
	}
	sortedVersions(page.Versions)
	return page, nil
}

func (m *memoryVersionBackend) version(key, version string) (memoryVersionRecord, bool) {
	for _, record := range m.versions[key] {
		if record.id == version {
			return record, true
		}
	}
	return memoryVersionRecord{}, false
}

func (m *memoryVersionBackend) HeadObjectVersion(_ context.Context, key, version string) (objectResponse, error) {
	record, ok := m.version(key, version)
	if !ok || record.deleteMarker {
		return objectResponse{}, &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchVersion", Message: "missing"}
	}
	header := make(http.Header)
	header.Set("Content-Length", strconv.Itoa(len(record.data)))
	header.Set("Content-Type", record.contentType)
	header.Set("ETag", `"version-`+version+`"`)
	header.Set("Last-Modified", record.modified.UTC().Format(http.TimeFormat))
	return objectResponse{StatusCode: http.StatusOK, Header: header}, nil
}

func (m *memoryVersionBackend) GetObjectVersion(ctx context.Context, key, version string, requestHeaders http.Header) (objectResponse, error) {
	record, ok := m.version(key, version)
	if !ok || record.deleteMarker {
		return objectResponse{}, &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchVersion", Message: "missing"}
	}
	m.mu.Lock()
	original, existed := m.objects[key]
	m.objects[key] = memoryObject{data: append([]byte(nil), record.data...), contentType: record.contentType, modified: record.modified}
	m.mu.Unlock()
	response, err := m.memoryBackend.Get(ctx, key, requestHeaders)
	m.mu.Lock()
	if existed {
		m.objects[key] = original
	} else {
		delete(m.objects, key)
	}
	m.mu.Unlock()
	return response, err
}

func (m *memoryVersionBackend) DeleteObjectVersion(_ context.Context, key, version string) error {
	records := m.versions[key]
	for index, record := range records {
		if record.id != version {
			continue
		}
		m.versions[key] = append(records[:index], records[index+1:]...)
		m.deleted = append(m.deleted, key+"@"+version)
		return nil
	}
	return &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchVersion", Message: "missing"}
}

func (m *memoryVersionBackend) RestoreObjectVersion(_ context.Context, key, version string) error {
	record, ok := m.version(key, version)
	if !ok || record.deleteMarker {
		return &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchVersion", Message: "missing"}
	}
	m.mu.Lock()
	m.objects[key] = memoryObject{data: append([]byte(nil), record.data...), contentType: record.contentType, modified: time.Now().UTC()}
	m.mu.Unlock()
	return nil
}

func waitAnalysisJob(t *testing.T, app *application, recorder *httptest.ResponseRecorder) publicJob {
	t.Helper()
	var job publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode analysis response: %v; body=%s", err, recorder.Body.String())
	}
	if recorder.Code == http.StatusOK {
		return job
	}
	if recorder.Code != http.StatusAccepted || job.ID == "" {
		t.Fatalf("analysis status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	completed, ok := app.jobs.waitForTerminal(context.Background(), job.ID, 5*time.Second)
	if !ok {
		t.Fatalf("job %s did not finish", job.ID)
	}
	if completed.Status != jobStatusCompleted {
		t.Fatalf("job = %+v", completed.public())
	}
	return completed.public()
}

func postJSON(t *testing.T, handler http.Handler, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, target, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestIntegrityAndInspection(t *testing.T) {
	app, _, backend := testApplication(t)
	app.config.Runtime = defaultRuntimePolicy()
	backend.mu.Lock()
	backend.objects["tenant/analysis/check.bin"] = memoryObject{data: []byte("same-content"), contentType: "application/octet-stream", modified: time.Now().UTC()}
	backend.objects["tenant/analysis/large.pdf"] = memoryObject{data: append([]byte("%PDF-1.7\n"), bytes.Repeat([]byte("x"), 140<<10)...), contentType: "application/pdf", modified: time.Now().UTC()}
	backend.mu.Unlock()
	handler := app.routes()

	integrity := postJSON(t, handler, "/api/integrity", map[string]any{"instance": "rw", "key": "analysis/check.bin"})
	integrityJob := waitAnalysisJob(t, app, integrity)
	if integrityJob.Integrity == nil || len(integrityJob.Integrity.Entries) != 1 || len(integrityJob.Integrity.Entries[0].SHA256) != 64 {
		t.Fatalf("integrity = %+v", integrityJob.Integrity)
	}

	backend.mu.Lock()
	backend.getRanges = nil
	backend.mu.Unlock()
	inspect := httptest.NewRecorder()
	handler.ServeHTTP(inspect, httptest.NewRequest(http.MethodGet, "/api/inspect?instance=rw&key=analysis%2Flarge.pdf", nil))
	if inspect.Code != http.StatusOK {
		t.Fatalf("inspect status=%d body=%s", inspect.Code, inspect.Body.String())
	}
	var inspected inspectResponse
	if err := json.Unmarshal(inspect.Body.Bytes(), &inspected); err != nil {
		t.Fatal(err)
	}
	if inspected.DetectedKind != "pdf" || inspected.Structure["PDF version"] != "1.7" || len(inspected.Probes) != 2 {
		t.Fatalf("inspection = %+v", inspected)
	}
	if _, leaked := inspected.Headers["Set-Cookie"]; leaked {
		t.Fatalf("sensitive response header leaked: %+v", inspected.Headers)
	}
	backend.mu.Lock()
	ranges := append([]string(nil), backend.getRanges...)
	backend.mu.Unlock()
	requireExactByteRanges(t, ranges)
	if len(ranges) != 2 {
		t.Fatalf("inspection ranges = %v", ranges)
	}
}

func TestVersioningProbeHidesUnsupportedProviders(t *testing.T) {
	t.Parallel()
	base := newMemoryBackend(nil)
	supportedBackend := &memoryVersionBackend{memoryBackend: base, versions: map[string][]memoryVersionRecord{}}
	supported := &storageInstance{
		cfg:     bucketConfig{ID: "supported", Provider: "s3", PermissionsDefined: true, Permissions: []string{permissionRead}},
		backend: supportedBackend, caps: initialCapabilities(bucketConfig{PermissionsDefined: true, Permissions: []string{permissionRead}}),
	}
	if !supported.probeVersioning(context.Background()) || !supported.versioningAvailable() {
		t.Fatal("successful version listing was not exposed as supported")
	}

	unsupportedBackend := &memoryVersionBackend{
		memoryBackend: newMemoryBackend(nil),
		listErr:       &upstreamError{StatusCode: http.StatusNotImplemented, Code: "NotImplemented", Message: "version listing is not implemented"},
	}
	unsupported := &storageInstance{
		cfg:     bucketConfig{ID: "garage", Provider: "s3", PermissionsDefined: true, Permissions: []string{permissionRead}},
		backend: unsupportedBackend, caps: initialCapabilities(bucketConfig{PermissionsDefined: true, Permissions: []string{permissionRead}}),
	}
	if unsupported.probeVersioning(context.Background()) || unsupported.versioningAvailable() {
		t.Fatal("HTTP 501 version listing must hide version controls")
	}
	if info := unsupported.publicInfo(); info.VersioningSupported {
		t.Fatalf("public instance info exposed unsupported versioning: %+v", info)
	}
}

func TestApplicationStartupProbeHidesHTTP501Versioning(t *testing.T) {
	var probes atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("versions") {
			probes.Add(1)
			http.Error(w, "Not Implemented", http.StatusNotImplemented)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := appConfig{
		Listen: ":8080", JobHistoryLimit: 10, Runtime: defaultRuntimePolicy(),
		Authentications: []authConfig{{
			ID: "garage", Provider: "s3", Mode: "anonymous", Endpoint: server.URL, Region: "garage",
		}},
		Buckets: []bucketConfig{{
			ID: "garage", Name: "Garage", AuthID: "garage", Provider: "s3", Bucket: "objects", Region: "garage",
			PermissionsDefined: true, Permissions: []string{permissionRead}, MaxScanPages: 1,
		}},
	}
	app, err := newApplication(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	if probes.Load() != 1 {
		t.Fatalf("version probes = %d, want 1", probes.Load())
	}
	if app.instances["garage"].versioningAvailable() {
		t.Fatal("HTTP 501 startup probe exposed versioning")
	}

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/instances", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("instances status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Instances []instanceInfo `json:"instances"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Instances) != 1 || response.Instances[0].VersioningSupported {
		t.Fatalf("instances = %+v", response.Instances)
	}
}

func TestVersionAPIAndVersionAwareGateway(t *testing.T) {
	app, _, backend := testApplication(t)
	now := time.Now().UTC()
	versioned := &memoryVersionBackend{
		memoryBackend: backend,
		versions: map[string][]memoryVersionRecord{
			"tenant/versioned.txt": {
				{id: "v2", data: []byte("current"), contentType: "text/plain", modified: now, current: true},
				{id: "v1", data: []byte("previous"), contentType: "text/plain", modified: now.Add(-time.Hour)},
				{id: "delete-marker", modified: now.Add(-2 * time.Hour), deleteMarker: true},
			},
		},
	}
	app.instances["rw"].backend = versioned
	app.instances["rw"].setVersioningAvailable(true)
	handler := app.routes()

	versions := httptest.NewRecorder()
	handler.ServeHTTP(versions, httptest.NewRequest(http.MethodGet, "/api/versions?instance=rw&key=versioned.txt", nil))
	if versions.Code != http.StatusOK {
		t.Fatalf("versions status=%d body=%s", versions.Code, versions.Body.String())
	}
	var page struct {
		Versions []storedObjectVersion `json:"versions"`
	}
	if err := json.Unmarshal(versions.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Versions) != 3 || page.Versions[0].Version != "v2" || !page.Versions[2].DeleteMarker {
		t.Fatalf("versions = %+v", page.Versions)
	}

	countsRecorder := postJSON(t, handler, "/api/version-counts", map[string]any{"instance": "rw", "keys": []string{"versioned.txt"}})
	if countsRecorder.Code != http.StatusOK {
		t.Fatalf("version counts status=%d body=%s", countsRecorder.Code, countsRecorder.Body.String())
	}
	var counts struct {
		Counts map[string]versionCountResult `json:"counts"`
	}
	if err := json.Unmarshal(countsRecorder.Body.Bytes(), &counts); err != nil {
		t.Fatal(err)
	}
	if got := counts.Counts["versioned.txt"]; got.Count != 2 || got.CurrentVersion != "v2" {
		t.Fatalf("version count = %+v", got)
	}

	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/s3?instance=rw&key=versioned.txt&version=v1", nil))
	if get.Code != http.StatusOK || get.Body.String() != "previous" {
		t.Fatalf("version GET status=%d body=%q", get.Code, get.Body.String())
	}

	restore := postJSON(t, handler, "/api/versions/restore", map[string]string{"instance": "rw", "key": "versioned.txt", "version": "v1"})
	if restore.Code != http.StatusOK {
		t.Fatalf("restore status=%d body=%s", restore.Code, restore.Body.String())
	}
	backend.mu.Lock()
	restored := string(backend.objects["tenant/versioned.txt"].data)
	backend.mu.Unlock()
	if restored != "previous" {
		t.Fatalf("restored object = %q", restored)
	}

	remove := httptest.NewRecorder()
	target := "/api/versions?instance=rw&key=versioned.txt&version=" + url.QueryEscape("delete-marker")
	handler.ServeHTTP(remove, httptest.NewRequest(http.MethodDelete, target, nil))
	if remove.Code != http.StatusNoContent || len(versioned.deleted) != 1 {
		t.Fatalf("delete status=%d deleted=%v body=%s", remove.Code, versioned.deleted, remove.Body.String())
	}
}

func TestSelectiveArchiveEntryExtraction(t *testing.T) {
	app, _, backend := testApplication(t)
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	entry, err := writer.Create("folder/readme.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(entry, "inside archive")
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	backend.mu.Lock()
	backend.objects["tenant/archive.zip"] = memoryObject{data: append([]byte(nil), archive.Bytes()...), contentType: "application/zip", modified: time.Now().UTC()}
	backend.getRanges = nil
	backend.mu.Unlock()

	target := "/api/archive-entry?instance=rw&key=archive.zip&entry=" + url.QueryEscape("folder/readme.txt") + "&size=" + strconv.Itoa(archive.Len())
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "inside archive" {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "attachment") || !strings.Contains(got, "readme.txt") {
		t.Fatalf("Content-Disposition = %q", got)
	}
	backend.mu.Lock()
	ranges := append([]string(nil), backend.getRanges...)
	backend.mu.Unlock()
	requireExactByteRanges(t, ranges)
}

func TestChecksumComparisonSkipsCompositeProviderValues(t *testing.T) {
	if matched, comparable := checksumMatches("not-base64-3", []byte("value")); matched || comparable {
		t.Fatalf("composite checksum = matched:%v comparable:%v", matched, comparable)
	}
	if matched, comparable := checksumMatches("dmFsdWU=", []byte("value")); !matched || !comparable {
		t.Fatalf("base64 checksum = matched:%v comparable:%v", matched, comparable)
	}
}

func TestRunningAnalysisJobDoesNotExposePartialResult(t *testing.T) {
	job := jobState{
		ID:       "job-analysis-public-contract",
		Type:     jobTypeIntegrity,
		Instance: "rw",
		Status:   jobStatusRunning,
		Integrity: &integrityResult{Entries: []integrityEntry{{
			Key: "large-object.bin", SHA256: strings.Repeat("a", 64),
		}}},
	}
	if public := job.public(); public.Integrity != nil {
		t.Fatalf("running job exposed a partial result: %+v", public.Integrity)
	}
	job.Status = jobStatusCompleted
	if public := job.public(); public.Integrity == nil || len(public.Integrity.Entries) != 1 {
		t.Fatalf("completed job did not expose its immutable result: %+v", public.Integrity)
	}
}

func TestRemovedGlobalAnalysisRoutesAreNotExposed(t *testing.T) {
	app, _, _ := testApplication(t)
	for _, target := range []string{"/api/compare", "/api/duplicates", "/api/checksum-manifest"} {
		recorder := httptest.NewRecorder()
		app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("GET %s status=%d body=%s", target, recorder.Code, recorder.Body.String())
		}
	}
}

func TestVersioningProbeHidesProviderNotImplemented(t *testing.T) {
	app, _, backend := testApplication(t)
	unsupported := &memoryVersionBackend{
		memoryBackend: backend,
		listErr:       &upstreamError{StatusCode: http.StatusNotImplemented, Code: "NotImplemented", Message: "version listing is not implemented"},
	}
	instance := app.instances["rw"]
	instance.backend = unsupported
	if supported := instance.probeVersioning(context.Background()); supported {
		t.Fatal("HTTP 501 version listing was reported as supported")
	}
	if instance.versioningAvailable() {
		t.Fatal("versioning capability remained visible after HTTP 501")
	}

	instances := httptest.NewRecorder()
	app.routes().ServeHTTP(instances, httptest.NewRequest(http.MethodGet, "/api/instances", nil))
	if instances.Code != http.StatusOK {
		t.Fatalf("instances status=%d body=%s", instances.Code, instances.Body.String())
	}
	var payload struct {
		Instances []instanceInfo `json:"instances"`
	}
	if err := json.Unmarshal(instances.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, info := range payload.Instances {
		if info.ID == "rw" && info.VersioningSupported {
			t.Fatalf("unsupported versioning leaked to frontend: %+v", info)
		}
	}

	versions := httptest.NewRecorder()
	app.routes().ServeHTTP(versions, httptest.NewRequest(http.MethodGet, "/api/versions?instance=rw&key=versioned.txt", nil))
	if versions.Code != http.StatusNotImplemented {
		t.Fatalf("versions status=%d body=%s", versions.Code, versions.Body.String())
	}
}
