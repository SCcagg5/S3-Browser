package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitForJobStatus(t *testing.T, manager *jobManager, id, status string) jobState {
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
	return jobState{}
}

func TestRecursiveCopyRunsAsInMemoryJob(t *testing.T) {
	app, _, backend := testApplication(t)
	recorder := postJSON(t, app.routes(), "/api/copy", map[string]any{
		"instance": "rw", "src": "folder/", "dst": "copied/", "isPrefix": true,
	})
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
}

func TestFolderStatisticsKeepBoundedDistributionsAndLargestObjects(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/folder/photo.jpg"] = memoryObject{data: bytes.Repeat([]byte{'j'}, 80), contentType: "image/jpeg", modified: time.Now().UTC()}
	backend.objects["tenant/folder/archive.bin"] = memoryObject{data: bytes.Repeat([]byte{'b'}, 20), contentType: "application/octet-stream", modified: time.Now().UTC()}
	backend.objects["tenant/folder/nested/more/item.bin"] = memoryObject{data: bytes.Repeat([]byte{'m'}, 10), contentType: "application/octet-stream", modified: time.Now().UTC()}
	backend.mu.Unlock()

	created, err := app.jobs.create(jobState{Type: jobTypeStatsPrefix, Instance: "rw", Prefix: "folder/"})
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
	public := completed.public()
	if public.Stats == nil || len(public.Stats.Largest) != 5 || public.Stats.Largest[0].Path != "folder/photo.jpg" {
		t.Fatalf("largest = %+v", public.Stats)
	}
	if len(public.Stats.Largest) > maxStatsLargestEntries || len(public.Stats.Recent) > maxStatsRecentEntries {
		t.Fatalf("statistics exceeded in-memory limits: largest=%d recent=%d", len(public.Stats.Largest), len(public.Stats.Recent))
	}
}

func TestJobCollectionRouteIsNotExposed(t *testing.T) {
	app, _, _ := testApplication(t)
	for _, path := range []string{"/api/jobs", "/api/jobs/"} {
		recorder := httptest.NewRecorder()
		app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, body = %s", path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestJobsDoNotSurviveManagerRestart(t *testing.T) {
	app, _, _ := testApplication(t)
	job := jobState{
		ID: "job-memory-only", Type: jobTypeStatsPrefix, Instance: "rw", Status: jobStatusCompleted,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := app.jobs.put(job); err != nil {
		t.Fatal(err)
	}
	app.jobs.close()
	manager, err := newJobManager(app, 10)
	if err != nil {
		t.Fatal(err)
	}
	app.jobs = manager
	if _, ok := manager.get(job.ID); ok {
		t.Fatal("a memory-only job survived manager replacement")
	}
}

func createTestUpload(t *testing.T, app *application, key string, size int64) publicUpload {
	t.Helper()
	recorder := postJSON(t, app.routes(), "/api/uploads", map[string]any{
		"instance": "rw", "key": key, "size": size, "contentType": "application/octet-stream",
	})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create upload status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var upload publicUpload
	if err := json.Unmarshal(recorder.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	return upload
}

func putUploadChunk(t *testing.T, app *application, token string, data []byte, start, end, total int64) publicUpload {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/uploads", bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(total, 10))
	request.Header.Set("X-S3-Browser-Resume-Token", token)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("put upload status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var upload publicUpload
	if err := json.Unmarshal(recorder.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	return upload
}

func TestS3MultipartUploadUsesOpaqueClientTokenAndReleasesTerminalState(t *testing.T) {
	app, _, backend := testApplication(t)
	const total = int64(16<<20) + 17
	created := createTestUpload(t, app, "large.bin", total)
	if created.ResumeToken == "" || !strings.HasPrefix(created.ResumeToken, uploadResumeTokenVersion+".") {
		t.Fatalf("resume token = %q", created.ResumeToken)
	}
	encoded, _ := json.Marshal(created)
	if strings.Contains(string(encoded), "provider_upload_id") || strings.Contains(string(encoded), "session_url") {
		t.Fatalf("provider upload coordinates leaked: %s", encoded)
	}
	if created.ChunkSize != 16<<20 {
		t.Fatalf("chunk size = %d", created.ChunkSize)
	}

	first := bytes.Repeat([]byte{'a'}, int(created.ChunkSize))
	progress := putUploadChunk(t, app, created.ResumeToken, first, 0, int64(len(first))-1, total)
	if progress.Status != uploadStatusUploading || progress.UploadedBytes != int64(len(first)) {
		t.Fatalf("first part state = %+v", progress)
	}
	last := bytes.Repeat([]byte{'b'}, int(total-int64(len(first))))
	completed := putUploadChunk(t, app, created.ResumeToken, last, int64(len(first)), total-1, total)
	if completed.Status != uploadStatusCompleted || !completed.Verified || completed.UploadedBytes != total {
		t.Fatalf("completed upload = %+v", completed)
	}
	if _, ok := app.uploads.get(uploadIDFromResumeToken(created.ResumeToken)); ok {
		t.Fatal("completed upload remained in server memory")
	}
	backend.mu.Lock()
	object := backend.objects["tenant/large.bin"]
	backend.mu.Unlock()
	if int64(len(object.data)) != total {
		t.Fatalf("stored size = %d", len(object.data))
	}
}

func TestUploadResumeTokenReconstructsProviderStateWithoutServerPersistence(t *testing.T) {
	app, _, backend := testApplication(t)
	const total = int64(20 << 20)
	created := createTestUpload(t, app, "resume.bin", total)
	descriptor, _, err := app.openUploadResumeToken(created.ResumeToken)
	if err != nil {
		t.Fatal(err)
	}
	part := bytes.Repeat([]byte{'r'}, 5<<20)
	if _, err := backend.UploadPart(context.Background(), "tenant/resume.bin", descriptor.ProviderUploadID, 1, bytes.NewReader(part), int64(len(part))); err != nil {
		t.Fatal(err)
	}

	// Simulate a process-local state loss. The opaque token and provider session
	// are the only resume data that remain.
	app.uploads, err = newUploadManager(app)
	if err != nil {
		t.Fatal(err)
	}
	recorder := postJSON(t, app.routes(), "/api/uploads/resume", map[string]string{"resumeToken": created.ResumeToken})
	if recorder.Code != http.StatusOK {
		t.Fatalf("resume status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var resumed publicUpload
	if err := json.Unmarshal(recorder.Body.Bytes(), &resumed); err != nil {
		t.Fatal(err)
	}
	if resumed.UploadedBytes != int64(len(part)) || resumed.PartCount != 1 || resumed.Status != uploadStatusUploading {
		t.Fatalf("resumed upload = %+v", resumed)
	}

	// The token key is derived from configured credentials, so a fresh
	// application using the same authentication can decrypt it.
	restarted := &application{instances: app.instances, authentications: app.authentications}
	if _, _, err := restarted.openUploadResumeToken(created.ResumeToken); err != nil {
		t.Fatalf("fresh application could not open client-held token: %v", err)
	}
}

func TestCancelUploadAbortsProviderAndReleasesMemory(t *testing.T) {
	app, _, backend := testApplication(t)
	created := createTestUpload(t, app, "cancel.bin", 8<<20)
	descriptor, _, err := app.openUploadResumeToken(created.ResumeToken)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodDelete, "/api/uploads", nil)
	request.Header.Set("X-S3-Browser-Resume-Token", created.ResumeToken)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	backend.mu.Lock()
	_, exists := backend.multipart[descriptor.ProviderUploadID]
	backend.mu.Unlock()
	if exists {
		t.Fatal("provider multipart session was not aborted")
	}
	if _, ok := app.uploads.get(uploadIDFromResumeToken(created.ResumeToken)); ok {
		t.Fatal("canceled upload remained in server memory")
	}
}

func TestJobManagerPrunesOnlyOldTerminalHistory(t *testing.T) {
	manager := &jobManager{
		jobs:         make(map[string]*jobState),
		locks:        make(map[string]*sync.Mutex),
		historyLimit: 2,
	}
	base := time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)
	states := []jobState{
		{ID: "completed-old", Status: jobStatusCompleted, UpdatedAt: base},
		{ID: "failed-middle", Status: jobStatusFailed, UpdatedAt: base.Add(time.Minute)},
		{ID: "completed-new", Status: jobStatusCompleted, UpdatedAt: base.Add(2 * time.Minute)},
		{ID: "running-kept", Status: jobStatusRunning, UpdatedAt: base.Add(3 * time.Minute)},
	}
	for index := range states {
		job := states[index]
		manager.jobs[job.ID] = &job
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
		t.Fatalf("fresh in-memory insights triggered another listing: first=%d second=%d", callsAfterFirst, callsAfterSecond)
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

func TestJobManagerBoundsActiveInMemoryJobs(t *testing.T) {
	app, _, _ := testApplication(t)
	now := time.Now().UTC()
	for index := 0; index < maxActiveJobs; index++ {
		job := jobState{
			ID: fmt.Sprintf("active-%d", index), Type: jobTypeStatsPrefix, Instance: "rw",
			Status: jobStatusPaused, CreatedAt: now, UpdatedAt: now,
		}
		if err := app.jobs.put(job); err != nil {
			t.Fatal(err)
		}
	}
	_, err := app.jobs.create(jobState{Type: jobTypeStatsPrefix, Instance: "rw", Prefix: "folder/"})
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests || apiErr.Code != "job_limit_reached" {
		t.Fatalf("create error = %#v, want job_limit_reached", err)
	}
}

func TestInMemoryJobLimitRejectsAdditionalWork(t *testing.T) {
	app, _, _ := testApplication(t)
	now := time.Now().UTC()
	for index := 0; index < maxActiveJobs; index++ {
		job := jobState{
			ID:        fmt.Sprintf("job-active-%d", index),
			Type:      jobTypeStatsPrefix,
			Instance:  "rw",
			Status:    jobStatusRunning,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := app.jobs.put(job); err != nil {
			t.Fatal(err)
		}
	}
	_, err := app.jobs.create(jobState{Type: jobTypeStatsPrefix, Instance: "rw", Prefix: "folder/"})
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests || apiErr.Code != "job_limit_reached" {
		t.Fatalf("create error = %#v, want job_limit_reached", err)
	}
}

func TestInMemoryUploadLimitRejectsAdditionalSessions(t *testing.T) {
	app, _, _ := testApplication(t)
	now := time.Now().UTC()
	for index := 0; index < maxInMemoryUploadSessions; index++ {
		upload := uploadSession{
			ID:        fmt.Sprintf("upload-active-%d", index),
			Instance:  "rw",
			Key:       fmt.Sprintf("upload-%d.bin", index),
			Provider:  "s3",
			Status:    uploadStatusUploading,
			TotalSize: 8 << 20,
			ChunkSize: 8 << 20,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := app.uploads.put(upload); err != nil {
			t.Fatal(err)
		}
	}
	_, err := app.uploads.create(context.Background(), createUploadRequest{
		Instance: "rw", Key: "one-too-many.bin", Size: 8 << 20, ContentType: "application/octet-stream",
	})
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests || apiErr.Code != "upload_session_limit_reached" {
		t.Fatalf("create error = %#v, want upload_session_limit_reached", err)
	}
}
