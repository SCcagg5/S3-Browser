package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestS3SigningKeyMatchesTheSigV4Derivation(t *testing.T) {
	t.Parallel()
	want := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4secret-a"), "20260102"), "eu-west-1"), "s3"), "aws4_request")
	for attempt := 0; attempt < 2; attempt++ { // the second call is served from the cache
		if got := s3SigningKey("secret-a", "20260102", "eu-west-1"); !bytes.Equal(got, want) {
			t.Fatalf("attempt %d: signing key differs from the SigV4 derivation", attempt)
		}
	}
	if bytes.Equal(s3SigningKey("secret-b", "20260102", "eu-west-1"), want) {
		t.Fatal("a different secret must derive a different key")
	}
}

// inflightBackend counts how many object bodies are open at once.
type inflightBackend struct {
	*memoryBackend
	mu       sync.Mutex
	open     int
	maxOpen  int
	getCalls int
}

func (b *inflightBackend) Get(ctx context.Context, key string, headers http.Header) (objectResponse, error) {
	response, err := b.memoryBackend.Get(ctx, key, headers)
	if err != nil || response.Body == nil {
		return response, err
	}
	b.mu.Lock()
	b.getCalls++
	b.open++
	if b.open > b.maxOpen {
		b.maxOpen = b.open
	}
	b.mu.Unlock()
	var once sync.Once
	response.Body = &closeHook{ReadCloser: response.Body, onClose: func() {
		once.Do(func() { b.mu.Lock(); b.open--; b.mu.Unlock() })
	}}
	return response, nil
}

type closeHook struct {
	io.ReadCloser
	onClose func()
}

func (c *closeHook) Read(buffer []byte) (int, error) {
	time.Sleep(3 * time.Millisecond) // a member that takes a moment to transfer
	return c.ReadCloser.Read(buffer)
}

func (c *closeHook) Close() error { c.onClose(); return c.ReadCloser.Close() }

func archiveWithGate(t *testing.T, slots int, objects int) (*inflightBackend, map[string]string, int) {
	t.Helper()
	app, _, _ := testApplication(t)
	files := make(map[string]string, objects)
	seed := make(map[string]string, objects)
	for i := 0; i < objects; i++ {
		name := fmt.Sprintf("many/file-%03d.txt", i)
		files["file-"+fmt.Sprintf("%03d.txt", i)] = fmt.Sprintf("content of object %d", i)
		seed["tenant/"+name] = files["file-"+fmt.Sprintf("%03d.txt", i)]
	}
	backend := &inflightBackend{memoryBackend: newMemoryBackend(seed)}
	instance := app.instances["rw"]
	instance.backend = backend
	instance.gate = make(chan struct{}, slots)
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/archive?instance=rw&prefix=many%2F&name=many.zip", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	reader, err := zip.NewReader(bytes.NewReader(recorder.Body.Bytes()), int64(recorder.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := make(map[string]string)
	for _, file := range reader.File {
		handle, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(handle)
		handle.Close()
		got[file.Name] = string(data)
	}
	if len(got) != len(files) {
		t.Fatalf("archive has %d entries, want %d (trailer %q)", len(got), len(files), recorder.Result().Trailer.Get(archiveStatusTrailer))
	}
	for name, content := range files {
		if got[name] != content {
			t.Fatalf("entry %s = %q, want %q", name, got[name], content)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.open != 0 {
		t.Fatalf("%d object bodies were left open", backend.open)
	}
	return backend, got, backend.maxOpen
}

func TestArchivePrefetchOverlapsMembersWhenASlotIsFree(t *testing.T) {
	t.Parallel()
	_, _, maxOpen := archiveWithGate(t, 2, 40)
	if maxOpen < 2 {
		t.Fatalf("the next member was never requested while the current one streamed (max open bodies = %d)", maxOpen)
	}
}

func TestArchivePrefetchNeverTakesAContendedSlot(t *testing.T) {
	t.Parallel()
	// With a single slot the prefetch cannot get one: members are fetched one after the other, never two at once.
	backend, _, maxOpen := archiveWithGate(t, 1, 40)
	if maxOpen != 1 {
		t.Fatalf("max open bodies = %d with a single slot, want 1", maxOpen)
	}
	if backend.getCalls != 40 {
		t.Fatalf("object reads = %d, want 40 (every member read exactly once)", backend.getCalls)
	}
}
