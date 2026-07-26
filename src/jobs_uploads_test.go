package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitForJobStatus(t *testing.T, manager *jobManager, id, status string) persistentJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		job, ok := manager.get(id)
		if ok && job.Status == status {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	job, _ := manager.get(id)
	t.Fatalf("job %s did not reach %s: %+v", id, status, job)
	return persistentJob{}
}

func TestRecursiveCopyRunsAsPersistentJob(t *testing.T) {
	app, _, backend := testApplication(t)
	requestBody := `{"instance":"rw","src":"folder/","dst":"copied/","isPrefix":true}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/copy", strings.NewReader(requestBody))
	request.Header.Set("Content-Type", "application/json")
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var created publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	completed := waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted)
	if completed.Processed != 2 {
		t.Fatalf("processed = %d, want 2", completed.Processed)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if got := string(backend.objects["tenant/copied/direct.txt"].data); got != "direct" {
		t.Fatalf("direct copy = %q", got)
	}
	if got := string(backend.objects["tenant/copied/nested/deep.txt"].data); got != "deep" {
		t.Fatalf("nested copy = %q", got)
	}
	statePath := filepath.Join(app.config.DataDir, "jobs", created.ID+".json")
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("job state mode = %o", info.Mode().Perm())
	}
}

func TestFolderStatisticsKeepDistributionsAndLargestObjects(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/folder/photo.jpg"] = memoryObject{data: bytes.Repeat([]byte{'j'}, 80), contentType: "image/jpeg", modified: time.Now().UTC()}
	backend.objects["tenant/folder/archive.bin"] = memoryObject{data: bytes.Repeat([]byte{'b'}, 20), contentType: "application/octet-stream", modified: time.Now().UTC()}
	backend.objects["tenant/folder/nested/more/item.bin"] = memoryObject{data: bytes.Repeat([]byte{'m'}, 10), contentType: "application/octet-stream", modified: time.Now().UTC()}
	backend.mu.Unlock()

	created, err := app.jobs.create(persistentJob{Type: jobTypeStatsPrefix, Instance: "rw", Prefix: "folder/"})
	if err != nil {
		t.Fatal(err)
	}
	completed := waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted)
	if completed.Stats == nil {
		t.Fatal("completed statistics are missing")
	}
	if completed.Stats.Count != 5 || completed.Stats.TotalBytes != 120 {
		t.Fatalf("stats = %+v", completed.Stats)
	}
	if completed.Stats.ByType["image"].Count != 1 || completed.Stats.ByType["image"].Bytes != 80 {
		t.Fatalf("image distribution = %+v", completed.Stats.ByType)
	}
	if got := completed.Stats.ByFolder["nested/"]; got.Count != 2 || got.Bytes != 14 {
		t.Fatalf("nested folder aggregate = %+v", got)
	}
	if got := completed.Stats.ByFolder["nested/more/"]; got.Count != 1 || got.Bytes != 10 {
		t.Fatalf("nested/more folder aggregate = %+v", got)
	}
	public := completed.public()
	if public.Stats == nil || len(public.Stats.Largest) != 5 || public.Stats.Largest[0].Path != "folder/photo.jpg" {
		t.Fatalf("largest = %+v", public.Stats)
	}
	largest := public.Stats.Largest[0]
	if largest.MIME != "image/jpeg" || largest.ETag == "" || largest.LastModified == "" {
		t.Fatalf("largest object metadata = %+v", largest)
	}
	if len(public.Stats.Recent) != 5 {
		t.Fatalf("recent = %+v, want five objects", public.Stats.Recent)
	}
	for index := 1; index < len(public.Stats.Recent); index++ {
		if public.Stats.Recent[index-1].LastModified < public.Stats.Recent[index].LastModified {
			t.Fatalf("recent entries are not newest-first at index %d: %+v", index, public.Stats.Recent)
		}
	}
	if public.Stats.Recent[0].Type == "" || public.Stats.Recent[0].LastModified == "" {
		t.Fatalf("recent object metadata = %+v", public.Stats.Recent[0])
	}
}

func TestJobCollectionRouteIsNotExposed(t *testing.T) {
	app, _, _ := testApplication(t)
	for _, path := range []string{"/api/jobs", "/api/jobs/"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		app.routes().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, body = %s", path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestRunningJobResumesFromPersistedCheckpoint(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/recovered/direct.txt"] = backend.objects["tenant/folder/direct.txt"]
	backend.mu.Unlock()

	job := persistentJob{
		ID:        "job-recovery-test",
		Type:      jobTypeCopyPrefix,
		Instance:  "rw",
		Source:    "folder/",
		Target:    "recovered/",
		Status:    jobStatusRunning,
		Processed: 1,
		LastKey:   "folder/direct.txt",
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := app.jobs.put(job); err != nil {
		t.Fatal(err)
	}
	app.jobs.close()
	manager, err := newJobManager(app, app.config.DataDir, 100, true)
	if err != nil {
		t.Fatal(err)
	}
	app.jobs = manager
	completed := waitForJobStatus(t, manager, job.ID, jobStatusCompleted)
	if completed.Processed != 2 || completed.LastKey != "folder/nested/deep.txt" {
		t.Fatalf("resumed job = %+v", completed)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if got := string(backend.objects["tenant/recovered/nested/deep.txt"].data); got != "deep" {
		t.Fatalf("recovered nested copy = %q", got)
	}
}

func TestS3MultipartUploadIsPersistedAndCompleted(t *testing.T) {
	app, _, backend := testApplication(t)
	const total = int64(16<<20) + 17
	createBody := []byte(`{"instance":"rw","key":"large.bin","size":16777233,"contentType":"application/octet-stream"}`)
	createRecorder := httptest.NewRecorder()
	createRequest := httptest.NewRequest(http.MethodPost, "/api/uploads", bytes.NewReader(createBody))
	createRequest.Header.Set("Content-Type", "application/json")
	app.routes().ServeHTTP(createRecorder, createRequest)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createRecorder.Code, createRecorder.Body.String())
	}
	if strings.Contains(createRecorder.Body.String(), "provider_upload_id") || strings.Contains(createRecorder.Body.String(), "session_url") {
		t.Fatalf("provider upload details leaked: %s", createRecorder.Body.String())
	}
	var upload publicUpload
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	if upload.ChunkSize != 16<<20 {
		t.Fatalf("chunk size = %d", upload.ChunkSize)
	}

	first := bytes.Repeat([]byte{'a'}, int(upload.ChunkSize))
	upload = putUploadChunk(t, app, upload.ID, first, 0, int64(len(first))-1, total)
	if upload.Status != uploadStatusUploading || upload.UploadedBytes != int64(len(first)) {
		t.Fatalf("first part state = %+v", upload)
	}
	last := bytes.Repeat([]byte{'b'}, int(total-int64(len(first))))
	upload = putUploadChunk(t, app, upload.ID, last, int64(len(first)), total-1, total)
	if upload.Status != uploadStatusCompleted || upload.UploadedBytes != total {
		t.Fatalf("completed state = %+v", upload)
	}

	backend.mu.Lock()
	object := backend.objects["tenant/large.bin"]
	backend.mu.Unlock()
	if int64(len(object.data)) != total || object.data[0] != 'a' || object.data[len(object.data)-1] != 'b' {
		t.Fatalf("uploaded object is incorrect: size=%d", len(object.data))
	}
	statePath := filepath.Join(app.config.DataDir, "uploads", upload.ID+".json")
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("upload state mode = %o", info.Mode().Perm())
	}
}

func putUploadChunk(t *testing.T, app *application, id string, data []byte, start, end, total int64) publicUpload {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/uploads/"+id, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(total, 10))
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("chunk status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var upload publicUpload
	if err := json.Unmarshal(recorder.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	return upload
}

func TestJobManagerPrunesOnlyOldTerminalHistory(t *testing.T) {
	dir := t.TempDir()
	manager := &jobManager{
		dir:          dir,
		jobs:         make(map[string]*persistentJob),
		locks:        make(map[string]*sync.Mutex),
		historyLimit: 2,
	}
	base := time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)
	states := []persistentJob{
		{ID: "completed-old", Type: jobTypeStatsPrefix, Instance: "rw", Status: jobStatusCompleted, CreatedAt: base, UpdatedAt: base},
		{ID: "failed-middle", Type: jobTypeStatsPrefix, Instance: "rw", Status: jobStatusFailed, CreatedAt: base.Add(time.Minute), UpdatedAt: base.Add(time.Minute)},
		{ID: "completed-new", Type: jobTypeStatsPrefix, Instance: "rw", Status: jobStatusCompleted, CreatedAt: base.Add(2 * time.Minute), UpdatedAt: base.Add(2 * time.Minute)},
		{ID: "running-kept", Type: jobTypeStatsPrefix, Instance: "rw", Status: jobStatusRunning, CreatedAt: base.Add(3 * time.Minute), UpdatedAt: base.Add(3 * time.Minute)},
	}
	for index := range states {
		job := states[index]
		manager.jobs[job.ID] = &job
		if err := manager.persist(job); err != nil {
			t.Fatal(err)
		}
	}
	if err := manager.pruneHistory(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"failed-middle", "completed-new", "running-kept"} {
		if _, ok := manager.jobs[id]; !ok {
			t.Fatalf("job %q should have been retained", id)
		}
	}
	if _, ok := manager.jobs["completed-old"]; ok {
		t.Fatal("old terminal job should have been pruned")
	}
	if _, err := os.Stat(filepath.Join(dir, "completed-old.json")); !os.IsNotExist(err) {
		t.Fatalf("pruned job state still exists: %v", err)
	}
}

func TestPersistentStateForRemovedBucketIsQuarantined(t *testing.T) {
	dataDir := t.TempDir()
	jobsDir := filepath.Join(dataDir, "jobs")
	uploadsDir := filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(jobsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(uploadsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	job := persistentJob{
		ID:        "job-removed-bucket",
		Type:      jobTypeStatsPrefix,
		Instance:  "garage-archive",
		Status:    jobStatusCompleted,
		CreatedAt: now,
		UpdatedAt: now,
		EndedAt:   &now,
	}
	jobData, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	jobName := job.ID + ".json"
	if err := os.WriteFile(filepath.Join(jobsDir, jobName), jobData, 0o600); err != nil {
		t.Fatal(err)
	}
	upload := persistentUpload{
		ID:        "upload-removed-bucket",
		Instance:  "garage-archive",
		Key:       "file.bin",
		Provider:  "s3",
		Status:    uploadStatusCanceled,
		CreatedAt: now,
		UpdatedAt: now,
	}
	uploadData, err := json.Marshal(upload)
	if err != nil {
		t.Fatal(err)
	}
	uploadName := upload.ID + ".json"
	if err := os.WriteFile(filepath.Join(uploadsDir, uploadName), uploadData, 0o600); err != nil {
		t.Fatal(err)
	}

	app := &application{instances: map[string]*storageInstance{"current": {cfg: bucketConfig{ID: "current"}}}}
	jobs, err := newJobManager(app, dataDir, 100, true)
	if err != nil {
		t.Fatalf("newJobManager() error = %v", err)
	}
	defer jobs.close()
	uploads, err := newUploadManager(app, dataDir, true)
	if err != nil {
		t.Fatalf("newUploadManager() error = %v", err)
	}
	_ = uploads

	for _, state := range []struct {
		directory string
		filename  string
	}{
		{directory: jobsDir, filename: jobName},
		{directory: uploadsDir, filename: uploadName},
	} {
		if _, err := os.Stat(filepath.Join(state.directory, state.filename)); !os.IsNotExist(err) {
			t.Fatalf("original state still exists at %s: %v", filepath.Join(state.directory, state.filename), err)
		}
		if _, err := os.Stat(filepath.Join(state.directory, "orphaned", state.filename)); err != nil {
			t.Fatalf("quarantined state is missing: %v", err)
		}
	}
}

func TestInsightsReturnInlineAndReuseFreshCompletedResult(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.listCalls = 0
	backend.mu.Unlock()

	request := func() (int, publicJob) {
		recorder := httptest.NewRecorder()
		app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/stats?instance=rw&prefix=folder%2F", nil))
		var job publicJob
		if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
			t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
		}
		return recorder.Code, job
	}

	status, first := request()
	if status != http.StatusOK || first.Status != jobStatusCompleted || first.Stats == nil {
		t.Fatalf("first response status=%d job=%+v", status, first)
	}
	backend.mu.Lock()
	callsAfterFirst := backend.listCalls
	backend.mu.Unlock()

	status, second := request()
	if status != http.StatusOK || second.Status != jobStatusCompleted || second.ID != first.ID {
		t.Fatalf("second response status=%d job=%+v", status, second)
	}
	backend.mu.Lock()
	callsAfterSecond := backend.listCalls
	backend.mu.Unlock()
	if callsAfterSecond != callsAfterFirst {
		t.Fatalf("fresh cached insights triggered another listing: first=%d second=%d", callsAfterFirst, callsAfterSecond)
	}
}

func TestInsightsMoveToBackgroundAfterInlineDeadline(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.listDelay = 200 * time.Millisecond
	backend.mu.Unlock()

	started := time.Now()
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/stats?instance=rw&prefix=folder%2F", nil))
	elapsed := time.Since(started)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if elapsed < 80*time.Millisecond || elapsed > 180*time.Millisecond {
		t.Fatalf("inline wait = %s, want approximately 100ms", elapsed)
	}
	var created publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	completed := waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted)
	if completed.Stats == nil {
		t.Fatal("background insights completed without statistics")
	}
}
