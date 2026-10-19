package main

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestS3DeleteManySendsOneSignedDeleteObjectsRequest(t *testing.T) {
	t.Parallel()
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !r.URL.Query().Has("delete") || r.URL.Path != "/bucket" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
		}
		body, _ = io.ReadAll(r.Body)
		sum := md5.Sum(body)
		if got := r.Header.Get("Content-MD5"); got != base64.StdEncoding.EncodeToString(sum[:]) {
			t.Errorf("Content-MD5 = %q", got)
		}
		w.Header().Set("Content-Type", "application/xml")
		_, _ = io.WriteString(w, `<DeleteResult/>`)
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	if err := backend.DeleteMany(context.Background(), []string{"a/one.txt", "a/two & three.txt"}); err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{"<Quiet>true</Quiet>", "<Key>a/one.txt</Key>", "<Key>a/two &amp; three.txt</Key>"} {
		if !strings.Contains(text, want) {
			t.Errorf("body %s lacks %s", text, want)
		}
	}
}

func TestS3DeleteManyReportsRefusedKeysAndEmbeddedErrors(t *testing.T) {
	t.Parallel()
	for name, response := range map[string]string{
		"per key":  `<DeleteResult><Error><Key>a</Key><Code>AccessDenied</Code><Message>no</Message></Error><Error><Key>b</Key><Code>AccessDenied</Code><Message>no</Message></Error></DeleteResult>`,
		"embedded": `<Error><Code>InternalError</Code><Message>failed</Message></Error>`,
	} {
		response := response
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, response)
			}))
			defer server.Close()
			backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
			err := backend.DeleteMany(context.Background(), []string{"a", "b", "c"})
			if err == nil {
				t.Fatal("want an error")
			}
			if name == "per key" && (!strings.Contains(err.Error(), "AccessDenied") || !strings.Contains(err.Error(), "2 of 3")) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestS3DeleteManyRefusesMoreThanTheLimit(t *testing.T) {
	t.Parallel()
	backend := newAnonymousS3BackendForTest(t, "http://127.0.0.1:1", "bucket")
	keys := make([]string, maximumS3DeleteBatch+1)
	if err := backend.DeleteMany(context.Background(), keys); err == nil {
		t.Fatal("want an error")
	}
}

// batchBackend counts the single and the batch deletes.
type batchBackend struct {
	*memoryBackend
	mu      sync.Mutex
	batches []int
	singles int
	refuse  error
}

func (b *batchBackend) Delete(ctx context.Context, key string) error {
	b.mu.Lock()
	b.singles++
	b.mu.Unlock()
	return b.memoryBackend.Delete(ctx, key)
}

func (b *batchBackend) DeleteMany(ctx context.Context, keys []string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.refuse != nil {
		return b.refuse
	}
	b.batches = append(b.batches, len(keys))
	for _, key := range keys {
		_ = b.memoryBackend.Delete(ctx, key)
	}
	return nil
}

func TestInstanceDeleteManySplitsInBatchesOfAThousand(t *testing.T) {
	_, _, memory := testApplication(t)
	backend := &batchBackend{memoryBackend: memory}
	instance := &storageInstance{cfg: bucketConfig{ID: "rw"}, backend: backend, caps: initialCapabilities(bucketConfig{ID: "rw"})}
	keys := make([]string, 2500)
	for index := range keys {
		keys[index] = fmt.Sprintf("k/%05d", index)
	}
	if err := instance.DeleteMany(context.Background(), keys); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(backend.batches) != "[1000 1000 500]" || backend.singles != 0 {
		t.Fatalf("batches = %v, singles = %d", backend.batches, backend.singles)
	}
}

func TestInstanceDeleteManyKeepsKeysXMLCannotCarryOutOfTheBatch(t *testing.T) {
	_, _, memory := testApplication(t)
	backend := &batchBackend{memoryBackend: memory}
	instance := &storageInstance{cfg: bucketConfig{ID: "rw"}, backend: backend, caps: initialCapabilities(bucketConfig{ID: "rw"})}
	if err := instance.DeleteMany(context.Background(), []string{"a", "bad\x01key", "c", "bad\xffutf8"}); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(backend.batches) != "[2]" || backend.singles != 2 {
		t.Fatalf("batches = %v, singles = %d", backend.batches, backend.singles)
	}
}

func TestInstanceDeleteManyFallsBackWhenTheProviderRefusesTheBatchRequest(t *testing.T) {
	_, _, memory := testApplication(t)
	backend := &batchBackend{memoryBackend: memory, refuse: &upstreamError{StatusCode: http.StatusNotImplemented, Code: "NotImplemented"}}
	instance := &storageInstance{cfg: bucketConfig{ID: "rw"}, backend: backend, caps: initialCapabilities(bucketConfig{ID: "rw"})}
	if err := instance.DeleteMany(context.Background(), []string{"a", "b", "c"}); err != nil {
		t.Fatal(err)
	}
	if backend.singles != 3 || len(backend.batches) != 0 || !instance.batchDeleteOff.Load() {
		t.Fatalf("singles = %d, batches = %v, off = %v", backend.singles, backend.batches, instance.batchDeleteOff.Load())
	}
	if err := instance.DeleteMany(context.Background(), []string{"d"}); err != nil || backend.singles != 4 {
		t.Fatalf("later delete: singles = %d, err = %v", backend.singles, err)
	}
}

func TestInstanceDeleteManyKeepsOtherProviderErrors(t *testing.T) {
	_, _, memory := testApplication(t)
	backend := &batchBackend{memoryBackend: memory, refuse: &upstreamError{StatusCode: http.StatusForbidden, Code: "AccessDenied"}}
	instance := &storageInstance{cfg: bucketConfig{ID: "rw"}, backend: backend, caps: initialCapabilities(bucketConfig{ID: "rw"})}
	if err := instance.DeleteMany(context.Background(), []string{"a"}); err == nil || backend.singles != 0 || instance.batchDeleteOff.Load() {
		t.Fatalf("err = %v, singles = %d", err, backend.singles)
	}
}

func TestDeletePrefixJobDeletesInBatchesAndCountsEveryObject(t *testing.T) {
	app, _, memory := testApplication(t)
	for index := 0; index < 2300; index++ {
		memory.objects[fmt.Sprintf("tenant/bulk/%05d.txt", index)] = memoryObject{data: []byte("x")}
	}
	memory.objects["tenant/keep/one.txt"] = memoryObject{data: []byte("x")}
	backend := &batchBackend{memoryBackend: memory}
	app.instances["rw"].backend = backend
	job, err := app.jobs.create(jobState{Type: jobTypeDeletePrefix, Instance: "rw", Prefix: "bulk/"})
	if err != nil {
		t.Fatal(err)
	}
	done := waitForJobStatus(t, app.jobs, job.ID, jobStatusCompleted)
	if done.Processed != 2300 {
		t.Fatalf("processed = %d", done.Processed)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.batches) != 3 || backend.singles != 0 {
		t.Fatalf("batches = %v, singles = %d", backend.batches, backend.singles)
	}
	memory.mu.Lock()
	defer memory.mu.Unlock()
	for key := range memory.objects {
		if strings.HasPrefix(key, "tenant/bulk/") {
			t.Fatalf("%s was not deleted", key)
		}
	}
	if _, ok := memory.objects["tenant/keep/one.txt"]; !ok {
		t.Fatal("an object outside the prefix was deleted")
	}
}

func TestDeletePrefixJobOnAnEmptyPrefixFails(t *testing.T) {
	app, _, _ := testApplication(t)
	job, err := app.jobs.create(jobState{Type: jobTypeDeletePrefix, Instance: "rw", Prefix: "nothing/"})
	if err != nil {
		t.Fatal(err)
	}
	failed := waitForJobStatus(t, app.jobs, job.ID, jobStatusFailed)
	if !strings.Contains(failed.Error, "no objects") {
		t.Fatalf("error = %q", failed.Error)
	}
}
