package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func putTestZip(t *testing.T, backend *memoryBackend, key string, entries map[string][]byte) int {
	t.Helper()
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for name, data := range entries {
		entry, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	backend.mu.Lock()
	backend.objects[key] = memoryObject{data: append([]byte(nil), archive.Bytes()...), contentType: "application/zip", modified: time.Now().UTC()}
	backend.mu.Unlock()
	return archive.Len()
}

func archiveEntryRequest(method, archiveKey, entry string, size int, inline bool, headers map[string]string) *http.Request {
	target := "/api/archive-entry?instance=rw&key=" + url.QueryEscape(archiveKey) + "&entry=" + url.QueryEscape(entry) + fmt.Sprintf("&size=%d", size)
	if inline {
		target += "&inline=1"
	}
	request := httptest.NewRequest(method, target, nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	return request
}

func TestArchiveEntryNeverServesActiveSameOriginContent(t *testing.T) {
	app, _, backend := testApplication(t)
	size := putTestZip(t, backend, "tenant/bundle.zip", map[string][]byte{
		"page.html": []byte(`<script src="/api/archive-entry?entry=pwn.js"></script>`),
		"pwn.js":    []byte("alert(1)"),
		"logo.svg":  []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		"note.txt":  []byte("hello"),
	})
	handler := app.routes()
	serve := func(method, entry string, headers map[string]string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, archiveEntryRequest(method, "bundle.zip", entry, size, true, headers))
		return recorder
	}
	for _, entry := range []string{"page.html", "pwn.js", "logo.svg"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			recorder := serve(method, entry, nil)
			if recorder.Code != http.StatusOK {
				t.Fatalf("%s %s status=%d body=%s", method, entry, recorder.Code, recorder.Body.String())
			}
			header := recorder.Header()
			if !strings.Contains(header.Get("Content-Security-Policy"), "sandbox") {
				t.Fatalf("%s %s is missing the sandbox CSP: %q", method, entry, header.Get("Content-Security-Policy"))
			}
			if got := header.Get("Content-Type"); got != "application/octet-stream" {
				t.Fatalf("%s %s Content-Type = %q, want a neutral type", method, entry, got)
			}
			if got := header.Get("Content-Disposition"); !strings.HasPrefix(got, "attachment") {
				t.Fatalf("%s %s Content-Disposition = %q, want attachment", method, entry, got)
			}
			if header.Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("%s %s is missing nosniff", method, entry)
			}
		}
	}

	// An SVG used as an <img> cannot run script and must keep previewing.
	image := serve(http.MethodGet, "logo.svg", map[string]string{"Sec-Fetch-Dest": "image"})
	if got := image.Header().Get("Content-Type"); got != "image/svg+xml" || !strings.Contains(image.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("svg image Content-Type=%q CSP=%q", got, image.Header().Get("Content-Security-Policy"))
	}

	// Plain text members still preview inline.
	text := serve(http.MethodGet, "note.txt", nil)
	if text.Body.String() != "hello" || !strings.HasPrefix(text.Header().Get("Content-Disposition"), "inline") {
		t.Fatalf("text member: type=%q disposition=%q body=%q", text.Header().Get("Content-Type"), text.Header().Get("Content-Disposition"), text.Body.String())
	}
}

func TestArchiveEntryRejectsOversizedCentralDirectory(t *testing.T) {
	app, _, backend := testApplication(t)
	app.config.Runtime.MaxArchiveEntries = 3
	entries := map[string][]byte{}
	for index := 0; index < 5; index++ {
		entries[fmt.Sprintf("file-%d.txt", index)] = []byte("x")
	}
	size := putTestZip(t, backend, "tenant/many.zip", entries)
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, archiveEntryRequest(http.MethodGet, "many.zip", "file-0.txt", size, false, nil))
	if recorder.Code != http.StatusRequestEntityTooLarge || !strings.Contains(recorder.Body.String(), "archive_too_many_entries") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestAcquireGateWaitIsBoundedAndExemptionBypasses(t *testing.T) {
	original := gateWaitTimeout
	gateWaitTimeout = 50 * time.Millisecond
	t.Cleanup(func() { gateWaitTimeout = original })

	gate := make(chan struct{}, 1)
	release, err := acquireGate(context.Background(), gate)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = acquireGate(context.Background(), gate)
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusServiceUnavailable || time.Since(start) > 2*time.Second {
		t.Fatalf("saturated gate error = %#v after %s, want a prompt 503", err, time.Since(start))
	}

	// Background jobs opt out of the bounded wait and only stop on cancellation.
	ctx, cancel := context.WithTimeout(withUnboundedGateWait(context.Background()), 200*time.Millisecond)
	defer cancel()
	if _, err := acquireGate(ctx, gate); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unbounded wait error = %v, want the context deadline", err)
	}

	instance := &storageInstance{gate: gate}
	exempt, err := instance.acquire(withGateExempt(context.Background()))
	if err != nil {
		t.Fatalf("exempt acquire: %v", err)
	}
	exempt()
	release()
	if len(gate) != 0 {
		t.Fatal("gate slot leaked")
	}
}

// TestStalledPutBodyDoesNotHoldStorageGate stalls a PUT body mid-transfer and
// asserts the rolling idle deadline frees the slot for a concurrent request.
func TestStalledPutBodyDoesNotHoldStorageGate(t *testing.T) {
	originalIdle, originalWait := streamIdleTimeout, gateWaitTimeout
	streamIdleTimeout, gateWaitTimeout = 300*time.Millisecond, 5*time.Second
	t.Cleanup(func() { streamIdleTimeout, gateWaitTimeout = originalIdle, originalWait })

	app, _, _ := testApplication(t)
	app.instances["rw"].gate = make(chan struct{}, 1)
	server := httptest.NewServer(app.routes())
	defer server.Close()

	connection, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	fmt.Fprintf(connection, "PUT /s3?instance=rw&key=stalled.bin HTTP/1.1\r\nHost: %s\r\nContent-Length: 1000\r\n\r\nabcdefghij", strings.TrimPrefix(server.URL, "http://"))
	time.Sleep(100 * time.Millisecond) // the handler now holds the only slot

	client := &http.Client{Timeout: 3 * time.Second}
	start := time.Now()
	response, err := client.Get(server.URL + "/s3?instance=rw&key=folder/direct.txt")
	if err != nil {
		t.Fatalf("concurrent request blocked behind the stalled upload: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || string(body) != "direct" {
		t.Fatalf("concurrent GET status=%d body=%q", response.StatusCode, body)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("slot was only released after %s", elapsed)
	}
	// The stalled request itself is answered with an error, not left hanging.
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	status, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil || strings.Contains(status, " 204 ") {
		t.Fatalf("stalled upload response = %q, %v", status, err)
	}
}

func TestCopyStreamKeepsLongTransfersAlive(t *testing.T) {
	originalIdle := streamIdleTimeout
	streamIdleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { streamIdleTimeout = originalIdle })

	// A source that dribbles for several idle periods in total must still finish.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		source := &slowReader{chunks: 8, delay: 80 * time.Millisecond}
		_, _ = copyStream(w, source)
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || len(body) != 8*16 {
		t.Fatalf("read %d bytes, err=%v", len(body), err)
	}
}

type slowReader struct {
	chunks int
	delay  time.Duration
}

func (r *slowReader) Read(buffer []byte) (int, error) {
	if r.chunks == 0 {
		return 0, io.EOF
	}
	r.chunks--
	time.Sleep(r.delay)
	return copy(buffer, bytes.Repeat([]byte("x"), 16)), nil
}

// barrierPutBackend holds every Put until two have started, so both extraction
// jobs own a storage slot before either reads its ZIP source.
type barrierPutBackend struct {
	*memoryBackend
	mu      sync.Mutex
	started int
}

func (b *barrierPutBackend) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	b.mu.Lock()
	b.started++
	b.mu.Unlock()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		ready := b.started >= 2
		b.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	return b.memoryBackend.Put(ctx, key, body, size, contentType)
}

func TestConcurrentExtractJobsDoNotDeadlockOnStorageGates(t *testing.T) {
	app, _, backend := testApplication(t)
	app.instances["rw"].backend = &barrierPutBackend{memoryBackend: backend}
	// Capacity equals the number of concurrent extraction jobs: each upload holds
	// a slot while its lazy ZIP source needs a second one.
	app.instances["rw"].gate = make(chan struct{}, 2)
	app.instances["rw"].concurrency = newStorageConcurrency(4)
	jobIDs := make([]string, 0, 2)
	for index := 0; index < 2; index++ {
		key := fmt.Sprintf("tenant/big-%d.zip", index)
		payload := bytes.Repeat([]byte{byte('a' + index)}, 12<<20)
		putTestZip(t, backend, key, map[string][]byte{"payload.bin": payload})
		recorder := postJSON(t, app.routes(), "/api/archive-extract", map[string]any{
			"instance": "rw", "key": fmt.Sprintf("big-%d.zip", index), "entries": []string{"payload.bin"}, "target": fmt.Sprintf("out-%d/", index),
		})
		if recorder.Code != http.StatusAccepted {
			t.Fatalf("extract status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var job publicJob
		if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
			t.Fatal(err)
		}
		jobIDs = append(jobIDs, job.ID)
	}
	for _, id := range jobIDs {
		waitForJobStatus(t, app.jobs, id, jobStatusCompleted)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	for index := 0; index < 2; index++ {
		if got := len(backend.objects[fmt.Sprintf("tenant/out-%d/payload.bin", index)].data); got != 12<<20 {
			t.Fatalf("extracted object %d has %d bytes", index, got)
		}
	}
}

type panicListBackend struct{ *memoryBackend }

func (panicListBackend) List(context.Context, listOptions) (listPage, error) {
	panic("backend exploded")
}

func TestJobPanicMarksJobFailedAndKeepsWorkerAlive(t *testing.T) {
	app, _, backend := testApplication(t)
	app.instances["rw"].backend = panicListBackend{backend}
	job, err := app.jobs.create(jobState{Type: jobTypeDeletePrefix, Instance: "rw", Prefix: "folder/"})
	if err != nil {
		t.Fatal(err)
	}
	failed := waitForJobStatus(t, app.jobs, job.ID, jobStatusFailed)
	if failed.Error == "" || strings.Contains(failed.Error, "exploded") {
		t.Fatalf("job error = %q, want a generic failure", failed.Error)
	}
	// The worker survived and still runs later jobs.
	app.instances["rw"].backend = backend
	next, err := app.jobs.create(jobState{Type: jobTypeStatsPrefix, Instance: "rw", Prefix: "folder/"})
	if err != nil {
		t.Fatal(err)
	}
	waitForJobStatus(t, app.jobs, next.ID, jobStatusCompleted)
}

func TestExtractIntoReadDeniedTargetIsRefused(t *testing.T) {
	app, _, backend := testApplication(t)
	cfg := bucketConfig{
		ID: "wo", Name: "wo", AuthID: "test-auth", Provider: "s3", Bucket: "wo-bucket", Region: "test",
		PermissionsDefined: true, Permissions: []string{permissionWrite},
	}
	app.instances["wo"] = &storageInstance{cfg: cfg, backend: newMemoryBackend(map[string]string{"exists.txt": "secret"}), caps: initialCapabilities(cfg)}
	putTestZip(t, backend, "tenant/src.zip", map[string][]byte{"exists.txt": []byte("a")})
	recorder := postJSON(t, app.routes(), "/api/archive-extract", map[string]any{
		"instance": "rw", "key": "src.zip", "entries": []string{"exists.txt"}, "targetInstance": "wo", "target": "",
	})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s, want 403 so object_exists is never an oracle", recorder.Code, recorder.Body.String())
	}

	// The job itself enforces the same ceiling.
	err := runArchiveExtraction(context.Background(), app.jobs, &jobState{
		ID: "direct", Type: jobTypeExtractArchive, Instance: "rw", TargetInstance: "wo", Source: "src.zip", Entries: []string{"exists.txt"},
	})
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden {
		t.Fatalf("job error = %#v, want permission_denied", err)
	}
}

func TestUploadResumeDoesNotProbeKeysOnReadDeniedInstance(t *testing.T) {
	app, _, _ := testApplication(t)
	existing := newMemoryBackend(map[string]string{"present.bin": strings.Repeat("x", 8<<20)})
	cfg := bucketConfig{
		ID: "wo", Name: "wo", AuthID: "test-auth", Provider: "s3", Bucket: "wo-bucket", Region: "test",
		PermissionsDefined: true, Permissions: []string{permissionWrite},
	}
	app.instances["wo"] = &storageInstance{cfg: cfg, backend: existing, caps: initialCapabilities(cfg)}
	app.order = append(app.order, "wo")

	probe := func(key string) publicUpload {
		recorder := postJSON(t, app.routes(), "/api/uploads", map[string]any{"instance": "wo", "key": key, "size": 8 << 20, "contentType": "application/octet-stream"})
		if recorder.Code != http.StatusCreated {
			t.Fatalf("create status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var created publicUpload
		if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
			t.Fatal(err)
		}
		do := func(method string) publicUpload {
			request := httptest.NewRequest(method, "/api/uploads", nil)
			request.Header.Set("X-S3-Browser-Resume-Token", created.ResumeToken)
			recorder := httptest.NewRecorder()
			app.routes().ServeHTTP(recorder, request)
			var upload publicUpload
			_ = json.Unmarshal(recorder.Body.Bytes(), &upload)
			return upload
		}
		do(http.MethodDelete) // abort the provider session, then resume with the same token
		return do(http.MethodGet)
	}
	present, absent := probe("present.bin"), probe("absent.bin")
	if present.Status != absent.Status || present.Verified != absent.Verified || present.Error != absent.Error {
		t.Fatalf("existing and absent keys are distinguishable: %+v vs %+v", present, absent)
	}
	if present.Status == uploadStatusCompleted || present.Verified {
		t.Fatalf("a vanished session was treated as completed on a read-denied instance: %+v", present)
	}
}

func TestExpiredPausedJobsAreCanceledAndFreeCapacity(t *testing.T) {
	app, _, _ := testApplication(t)
	now := time.Now().UTC()
	for index := 0; index < maxActiveJobs; index++ {
		job := jobState{
			ID: fmt.Sprintf("paused-%d", index), Type: jobTypeStatsPrefix, Instance: "rw",
			Status: jobStatusPaused, CreatedAt: now, UpdatedAt: now,
		}
		if err := app.jobs.put(job); err != nil {
			t.Fatal(err)
		}
	}
	if reaped := app.jobs.reapExpiredPaused(now.Add(pausedJobTTL / 2)); reaped != 0 {
		t.Fatalf("reaped %d jobs before the TTL", reaped)
	}
	if reaped := app.jobs.reapExpiredPaused(now.Add(pausedJobTTL + time.Minute)); reaped != maxActiveJobs {
		t.Fatalf("reaped %d jobs, want %d", reaped, maxActiveJobs)
	}
	job, err := app.jobs.create(jobState{Type: jobTypeStatsPrefix, Instance: "rw", Prefix: "folder/"})
	if err != nil {
		t.Fatalf("capacity was not released: %v", err)
	}
	waitForJobStatus(t, app.jobs, job.ID, jobStatusCompleted)
}

func TestIdleUploadSessionsAreAbortedAndFreeCapacity(t *testing.T) {
	app, _, backend := testApplication(t)
	var created []publicUpload
	for index := 0; index < maxInMemoryUploadSessions; index++ {
		created = append(created, createTestUpload(t, app, fmt.Sprintf("abandoned-%d.bin", index), 8<<20))
	}
	if _, err := app.uploads.create(context.Background(), createUploadRequest{Instance: "rw", Key: "extra.bin", Size: 8 << 20}); err == nil {
		t.Fatal("expected the session table to be full")
	}
	now := time.Now().UTC()
	if reaped := app.uploads.reapIdle(now.Add(uploadIdleTTL / 2)); reaped != 0 {
		t.Fatalf("reaped %d sessions before the TTL", reaped)
	}
	// A session that is mid-request keeps its slot however long it has been idle.
	busy := app.uploads.uploadLock(created[0].ID)
	busy.Lock()
	if reaped := app.uploads.reapIdle(now.Add(uploadIdleTTL + time.Minute)); reaped != maxInMemoryUploadSessions-1 {
		t.Fatalf("reaped %d sessions, want %d", reaped, maxInMemoryUploadSessions-1)
	}
	busy.Unlock()
	if reaped := app.uploads.reapIdle(now.Add(uploadIdleTTL + time.Minute)); reaped != 1 {
		t.Fatalf("reaped %d sessions after the lock was released, want 1", reaped)
	}
	backend.mu.Lock()
	remaining := len(backend.multipart)
	backend.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("%d provider multipart sessions were left open", remaining)
	}
	createTestUpload(t, app, "after-reap.bin", 8<<20)
}
