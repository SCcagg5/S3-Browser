package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestCopyPartRangesCoverTheSourceOnce(t *testing.T) {
	t.Parallel()
	ranges, err := copyPartRanges(12, 5)
	if err != nil {
		t.Fatal(err)
	}
	want := []copyPartRange{{1, 0, 4}, {2, 5, 9}, {3, 10, 11}}
	if fmt.Sprint(ranges) != fmt.Sprint(want) {
		t.Fatalf("ranges = %v, want %v", ranges, want)
	}
	ranges, err = copyPartRanges(10, 5)
	if err != nil || len(ranges) != 2 || ranges[1].Last != 9 {
		t.Fatalf("ranges = %v, err = %v", ranges, err)
	}
	ranges, err = copyPartRanges(1, 5)
	if err != nil || len(ranges) != 1 || ranges[0] != (copyPartRange{1, 0, 0}) {
		t.Fatalf("ranges = %v, err = %v", ranges, err)
	}
}

func TestCopyPartRangesGrowThePartsAboveTenThousandParts(t *testing.T) {
	t.Parallel()
	size := int64(5 << 40) // 5 TiB, the S3 limit of an object.
	ranges, err := copyPartRanges(size, 256<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(ranges) > maximumMultipartParts {
		t.Fatalf("%d parts", len(ranges))
	}
	partSize := ranges[0].size()
	if partSize%(1<<20) != 0 || partSize > maximumCopyPartSize {
		t.Fatalf("part size = %d", partSize)
	}
	var total int64
	for index, part := range ranges {
		if part.Number != index+1 || (index > 0 && part.First != ranges[index-1].Last+1) {
			t.Fatalf("part %d = %+v", index, part)
		}
		total += part.size()
	}
	if total != size {
		t.Fatalf("total = %d, want %d", total, size)
	}
}

func TestCopyPartRangesRefuseAnEmptySource(t *testing.T) {
	t.Parallel()
	if _, err := copyPartRanges(0, 5); err == nil {
		t.Fatal("want an error")
	}
}

// fakeCopyObject is one object (or one version) of fakeCopyS3.
type fakeCopyObject struct {
	data    []byte
	headers http.Header
	tags    string
}

// fakeCopyS3 is an S3 server for the copy tests: HEAD, GET, PUT, DELETE of objects, CopyObject, the tags, and the
// multipart upload with UploadPartCopy. The parts copy real bytes, so a test can compare the result with the source.
type fakeCopyS3 struct {
	t        *testing.T
	mu       sync.Mutex
	objects  map[string]fakeCopyObject
	versions map[string]fakeCopyObject // "key?version"
	uploads  map[string]map[int][]byte
	created  map[string]http.Header
	noTags   bool
	// failPart answers 500 to UploadPartCopy of this part number. blockPart waits for the end of the request instead.
	failPart  int
	blockPart int
	blocked   chan struct{}

	ranges         []string
	copySources    []string
	ifMatch        []string
	completed      int
	aborted        int
	copyObjects    int
	taggingQueries int
	nextUpload     int
}

func newFakeCopyS3(t *testing.T) (*fakeCopyS3, *httptest.Server) {
	fake := &fakeCopyS3{
		t: t, objects: map[string]fakeCopyObject{}, versions: map[string]fakeCopyObject{},
		uploads: map[string]map[int][]byte{}, created: map[string]http.Header{}, blocked: make(chan struct{}, 1),
	}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return fake, server
}

func (f *fakeCopyS3) put(key string, data []byte, contentType, tags string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	headers := http.Header{}
	headers.Set("Content-Type", contentType)
	headers.Set("Cache-Control", "max-age=60")
	headers.Set("X-Amz-Meta-Origin", "seed")
	f.objects[key] = fakeCopyObject{data: data, headers: headers, tags: tags}
}

func (f *fakeCopyS3) source(key, version string) (fakeCopyObject, bool) {
	if version != "" {
		object, ok := f.versions[key+"?"+version]
		return object, ok
	}
	object, ok := f.objects[key]
	return object, ok
}

func (f *fakeCopyS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/bucket/")
	query := r.URL.Query()
	if query.Get("partNumber") != "" && r.Method == http.MethodPut {
		f.uploadPartCopy(w, r, key)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodHead:
		object, ok := f.source(key, query.Get("versionId"))
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		for name, values := range object.headers {
			w.Header()[name] = values
		}
		w.Header().Set("ETag", `"etag-`+key+`"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(object.data)))
		if !f.noTags {
			w.Header().Set("x-amz-tagging-count", strconv.Itoa(len(strings.FieldsFunc(object.tags, func(r rune) bool { return r == '&' }))))
		}
	case query.Has("tagging") && r.Method == http.MethodGet:
		f.taggingQueries++
		if f.noTags {
			w.WriteHeader(http.StatusNotImplemented)
			return
		}
		object, _ := f.source(key, query.Get("versionId"))
		values, _ := url.ParseQuery(object.tags)
		names := make([]string, 0, len(values))
		for name := range values {
			names = append(names, name)
		}
		sort.Strings(names)
		var body strings.Builder
		body.WriteString("<Tagging><TagSet>")
		for _, name := range names {
			fmt.Fprintf(&body, "<Tag><Key>%s</Key><Value>%s</Value></Tag>", name, values.Get(name))
		}
		body.WriteString("</TagSet></Tagging>")
		_, _ = io.WriteString(w, body.String())
	case query.Has("uploads") && r.Method == http.MethodPost:
		f.nextUpload++
		id := fmt.Sprintf("upload-%d", f.nextUpload)
		f.uploads[id] = map[int][]byte{}
		f.created[id] = r.Header.Clone()
		fmt.Fprintf(w, "<InitiateMultipartUploadResult><UploadId>%s</UploadId></InitiateMultipartUploadResult>", id)
	case query.Get("uploadId") != "" && r.Method == http.MethodPost:
		id := query.Get("uploadId")
		var request struct {
			Parts []struct {
				PartNumber int    `xml:"PartNumber"`
				ETag       string `xml:"ETag"`
			} `xml:"Part"`
		}
		if err := xml.NewDecoder(r.Body).Decode(&request); err != nil {
			f.t.Errorf("complete body: %v", err)
		}
		var data []byte
		for index, part := range request.Parts {
			if part.PartNumber != index+1 || part.ETag != fmt.Sprintf(`"part-%d"`, part.PartNumber) {
				f.t.Errorf("complete part %d = %+v", index, part)
			}
			data = append(data, f.uploads[id][part.PartNumber]...)
		}
		created := f.created[id]
		f.objects[key] = fakeCopyObject{data: data, headers: copyMetadataHeaders(created), tags: created.Get("x-amz-tagging")}
		delete(f.uploads, id)
		f.completed++
		_, _ = io.WriteString(w, "<CompleteMultipartUploadResult/>")
	case query.Get("uploadId") != "" && r.Method == http.MethodDelete:
		delete(f.uploads, query.Get("uploadId"))
		f.aborted++
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPut && r.Header.Get("x-amz-copy-source") != "":
		f.copyObjects++
		sourceKey, version := f.parseCopySource(r.Header.Get("x-amz-copy-source"))
		object, ok := f.source(sourceKey, version)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.objects[key] = object
		_, _ = io.WriteString(w, "<CopyObjectResult/>")
	case r.Method == http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL)
		w.WriteHeader(http.StatusNotImplemented)
	}
}

func (f *fakeCopyS3) parseCopySource(value string) (string, string) {
	path, rawQuery, _ := strings.Cut(value, "?")
	key, err := url.PathUnescape(strings.TrimPrefix(path, "/bucket/"))
	if err != nil {
		f.t.Errorf("copy source %q: %v", value, err)
	}
	query, _ := url.ParseQuery(rawQuery)
	return key, query.Get("versionId")
}

func (f *fakeCopyS3) uploadPartCopy(w http.ResponseWriter, r *http.Request, key string) {
	number, _ := strconv.Atoi(r.URL.Query().Get("partNumber"))
	if number == f.blockPart {
		f.blocked <- struct{}{}
		<-r.Context().Done()
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ranges = append(f.ranges, r.Header.Get("x-amz-copy-source-range"))
	f.copySources = append(f.copySources, r.Header.Get("x-amz-copy-source"))
	f.ifMatch = append(f.ifMatch, r.Header.Get("x-amz-copy-source-if-match"))
	if number == f.failPart {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "<Error><Code>InternalError</Code><Message>part failed</Message></Error>")
		return
	}
	sourceKey, version := f.parseCopySource(r.Header.Get("x-amz-copy-source"))
	object, ok := f.source(sourceKey, version)
	parts, open := f.uploads[r.URL.Query().Get("uploadId")]
	if !ok || !open {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var first, last int
	if _, err := fmt.Sscanf(r.Header.Get("x-amz-copy-source-range"), "bytes=%d-%d", &first, &last); err != nil {
		f.t.Errorf("range: %v", err)
	}
	parts[number] = append([]byte(nil), object.data[first:last+1]...)
	fmt.Fprintf(w, `<CopyPartResult><ETag>"part-%d"</ETag></CopyPartResult>`, number)
}

func TestS3CopyMultipartKeepsMetadataTagsAndBytes(t *testing.T) {
	t.Parallel()
	fake, server := newFakeCopyS3(t)
	data := []byte("0123456789abcdefghijklmnopqrstuvwxyz")
	fake.put("dir/source file.bin", data, "application/x-test", "team=blue&state=draft")
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	var progress int64
	err := backend.CopyMultipart(context.Background(), "dir/source file.bin", "dir/copy.bin", multipartCopyOptions{
		partSize: 10, Progress: func(part int64) { progress += part },
	})
	if err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	copied := fake.objects["dir/copy.bin"]
	if !bytes.Equal(copied.data, data) {
		t.Fatalf("copy = %q", copied.data)
	}
	if progress != int64(len(data)) {
		t.Fatalf("progress = %d", progress)
	}
	sort.Strings(fake.ranges)
	if strings.Join(fake.ranges, ",") != "bytes=0-9,bytes=10-19,bytes=20-29,bytes=30-35" {
		t.Fatalf("ranges = %v", fake.ranges)
	}
	for index, source := range fake.copySources {
		if source != "/bucket/dir/source%20file.bin" || fake.ifMatch[index] != `"etag-dir/source file.bin"` {
			t.Fatalf("part source = %q, if-match = %q", source, fake.ifMatch[index])
		}
	}
	created := fake.created["upload-1"]
	if created.Get("Content-Type") != "application/x-test" || created.Get("Cache-Control") != "max-age=60" || created.Get("X-Amz-Meta-Origin") != "seed" {
		t.Fatalf("created with %v", created)
	}
	if created.Get("x-amz-tagging") != "state=draft&team=blue" {
		t.Fatalf("tags = %q", created.Get("x-amz-tagging"))
	}
	if fake.completed != 1 || fake.aborted != 0 || fake.copyObjects != 0 {
		t.Fatalf("completed = %d, aborted = %d, copy objects = %d", fake.completed, fake.aborted, fake.copyObjects)
	}
}

func TestS3CopyMultipartReadsTheNamedVersion(t *testing.T) {
	t.Parallel()
	fake, server := newFakeCopyS3(t)
	fake.put("doc.txt", []byte("current version"), "text/plain", "")
	fake.mu.Lock()
	fake.versions["doc.txt?v1"] = fakeCopyObject{data: []byte("the older version"), headers: http.Header{"Content-Type": {"text/old"}}, tags: "age=old"}
	fake.mu.Unlock()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	if err := backend.CopyMultipart(context.Background(), "doc.txt", "doc.txt", multipartCopyOptions{SourceVersion: "v1", partSize: 5}); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.objects["doc.txt"]; string(got.data) != "the older version" || got.headers.Get("Content-Type") != "text/old" || got.tags != "age=old" {
		t.Fatalf("restored = %q %v %q", got.data, got.headers, got.tags)
	}
	for _, source := range fake.copySources {
		if source != "/bucket/doc.txt?versionId=v1" {
			t.Fatalf("part source = %q", source)
		}
	}
}

func TestS3CopyMultipartReplacesMetadataAndTagsOnRequest(t *testing.T) {
	t.Parallel()
	fake, server := newFakeCopyS3(t)
	fake.put("a.bin", []byte("0123456789"), "application/octet-stream", "old=yes")
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	metadata := http.Header{}
	metadata.Set("Content-Type", "text/csv")
	metadata.Set("X-Amz-Meta-Owner", "ops")
	metadata.Set("Authorization", "ignored")
	err := backend.CopyMultipart(context.Background(), "a.bin", "a.bin", multipartCopyOptions{
		ReplaceMetadata: true, Metadata: metadata, ReplaceTags: true, Tags: []objectTag{{Key: "new", Value: "1"}}, partSize: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	created := fake.created["upload-1"]
	if created.Get("Content-Type") != "text/csv" || created.Get("X-Amz-Meta-Owner") != "ops" || created.Get("Cache-Control") != "" ||
		created.Get("X-Amz-Meta-Origin") != "" || created.Get("x-amz-tagging") != "new=1" {
		t.Fatalf("created with %v", created)
	}
	if fake.taggingQueries != 0 {
		t.Fatalf("%d tag reads", fake.taggingQueries)
	}
}

func TestS3CopyMultipartWithoutTagsOnTheProvider(t *testing.T) {
	t.Parallel()
	fake, server := newFakeCopyS3(t)
	fake.noTags = true
	fake.put("a.bin", []byte("0123456789"), "application/octet-stream", "")
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	if err := backend.CopyMultipart(context.Background(), "a.bin", "b.bin", multipartCopyOptions{partSize: 5}); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.created["upload-1"].Get("x-amz-tagging") != "" || string(fake.objects["b.bin"].data) != "0123456789" {
		t.Fatalf("created with %v", fake.created["upload-1"])
	}
}

func TestS3CopyMultipartAbortsWhenAPartFails(t *testing.T) {
	t.Parallel()
	fake, server := newFakeCopyS3(t)
	fake.failPart = 3
	fake.put("a.bin", bytes.Repeat([]byte("x"), 50), "application/octet-stream", "")
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	err := backend.CopyMultipart(context.Background(), "a.bin", "b.bin", multipartCopyOptions{partSize: 5})
	if err == nil || !strings.Contains(err.Error(), "part failed") {
		t.Fatalf("err = %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.aborted != 1 || fake.completed != 0 || len(fake.uploads) != 0 {
		t.Fatalf("aborted = %d, completed = %d, open uploads = %d", fake.aborted, fake.completed, len(fake.uploads))
	}
	if _, exists := fake.objects["b.bin"]; exists {
		t.Fatal("the failed copy made an object")
	}
}

func TestS3CopyMultipartAbortsOnCancel(t *testing.T) {
	t.Parallel()
	fake, server := newFakeCopyS3(t)
	fake.blockPart = 2
	fake.put("a.bin", bytes.Repeat([]byte("x"), 50), "application/octet-stream", "")
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-fake.blocked
		cancel()
	}()
	err := backend.CopyMultipart(ctx, "a.bin", "b.bin", multipartCopyOptions{partSize: 5})
	if err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("err = %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.aborted != 1 || fake.completed != 0 {
		t.Fatalf("aborted = %d, completed = %d", fake.aborted, fake.completed)
	}
}

// fakeCopyApplication is the test application with its "rw" instance on fakeCopyS3, and the copy threshold lowered to
// 16 bytes with parts of 5 MiB. Each test that uses it changes the package variables, so it does not run in parallel.
func fakeCopyApplication(t *testing.T) (*application, *fakeCopyS3) {
	t.Helper()
	threshold, partSize := multipartCopyThreshold, multipartCopyPartSize
	multipartCopyThreshold, multipartCopyPartSize = 16, 5<<20
	t.Cleanup(func() { multipartCopyThreshold, multipartCopyPartSize = threshold, partSize })
	app, _, _ := testApplication(t)
	fake, server := newFakeCopyS3(t)
	app.instances["rw"].backend = newAnonymousS3BackendForTest(t, server.URL, "bucket")
	return app, fake
}

func TestCopyOfALargeObjectRunsAsAJobWithItsBytes(t *testing.T) {
	app, fake := fakeCopyApplication(t)
	data := bytes.Repeat([]byte("0123456789"), 1<<20+3) // two parts of 5 MiB and one of the remainder
	fake.put("tenant/big.bin", data, "application/octet-stream", "keep=1")
	recorder := postJSON(t, app.routes(), "/api/copy", map[string]any{"instance": "rw", "src": "big.bin", "dst": "copy/big.bin"})
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var created publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Type != jobTypeCopyObject || created.TotalBytes != int64(len(data)) {
		t.Fatalf("job = %+v", created)
	}
	done := waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted)
	if public := done.public(); public.Processed != 1 || public.CopiedBytes != int64(len(data)) {
		t.Fatalf("job = %+v", public)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !bytes.Equal(fake.objects["tenant/copy/big.bin"].data, data) || fake.objects["tenant/copy/big.bin"].tags != "keep=1" {
		t.Fatal("the copy differs from the source")
	}
	if len(fake.ranges) != 3 || fake.copyObjects != 0 {
		t.Fatalf("ranges = %v, copy objects = %d", fake.ranges, fake.copyObjects)
	}
	if _, exists := fake.objects["tenant/big.bin"]; !exists {
		t.Fatal("the copy removed the source")
	}
}

func TestRenameOfALargeObjectMovesItInAJob(t *testing.T) {
	app, fake := fakeCopyApplication(t)
	fake.put("tenant/big.bin", bytes.Repeat([]byte("x"), 100), "application/octet-stream", "")
	recorder := postJSON(t, app.routes(), "/api/rename", map[string]any{"instance": "rw", "src": "big.bin", "dst": "moved.bin"})
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var created publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if _, exists := fake.objects["tenant/big.bin"]; exists {
		t.Fatal("the source is still there")
	}
	if len(fake.objects["tenant/moved.bin"].data) != 100 || fake.completed != 1 {
		t.Fatal("the destination is missing")
	}
}

func TestCopyOfASmallObjectStaysOneCopyObjectRequest(t *testing.T) {
	app, fake := fakeCopyApplication(t)
	fake.put("tenant/small.txt", []byte("tiny"), "text/plain", "")
	recorder := postJSON(t, app.routes(), "/api/copy", map[string]any{"instance": "rw", "src": "small.txt", "dst": "small-copy.txt"})
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"copied":1`) {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.copyObjects != 1 || fake.completed != 0 || string(fake.objects["tenant/small-copy.txt"].data) != "tiny" {
		t.Fatalf("copy objects = %d, multipart = %d", fake.copyObjects, fake.completed)
	}
}

func TestPrefixCopyJobCountsTheCopiedBytes(t *testing.T) {
	app, fake := fakeCopyApplication(t)
	fake.put("tenant/dir/big.bin", bytes.Repeat([]byte("b"), 40), "application/octet-stream", "")
	fake.put("tenant/dir/small.txt", []byte("tiny"), "text/plain", "")
	fake.mu.Lock()
	keys := []string{"tenant/dir/big.bin", "tenant/dir/small.txt"}
	fake.mu.Unlock()
	// fakeCopyS3 has no listing: the job lists through a memory backend that shares the keys and the sizes.
	lister := newMemoryBackend(map[string]string{keys[0]: strings.Repeat("b", 40), keys[1]: "tiny"})
	app.instances["rw"].backend = &listingCopyBackend{s3Backend: app.instances["rw"].backend.(*s3Backend), lister: lister}
	job, err := app.jobs.create(jobState{Type: jobTypeCopyPrefix, Instance: "rw", Source: "dir/", Target: "out/"})
	if err != nil {
		t.Fatal(err)
	}
	done := waitForJobStatus(t, app.jobs, job.ID, jobStatusCompleted)
	if public := done.public(); public.Processed != 2 || public.CopiedBytes != 44 || public.TotalBytes != 0 {
		t.Fatalf("job = %+v", public)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.completed != 1 || fake.copyObjects != 1 {
		t.Fatalf("multipart = %d, copy objects = %d", fake.completed, fake.copyObjects)
	}
}

// listingCopyBackend is the S3 backend of fakeCopyS3 with the listing of a memory backend.
type listingCopyBackend struct {
	*s3Backend
	lister *memoryBackend
}

func (b *listingCopyBackend) List(ctx context.Context, options listOptions) (listPage, error) {
	return b.lister.List(ctx, options)
}

func TestMultipartCopyBuildSettings(t *testing.T) {
	threshold, partSize := multipartCopyThreshold, multipartCopyPartSize
	thresholdBuild, partSizeBuild := multipartCopyThresholdBuild, multipartCopyPartSizeBuild
	t.Cleanup(func() {
		multipartCopyThreshold, multipartCopyPartSize = threshold, partSize
		multipartCopyThresholdBuild, multipartCopyPartSizeBuild = thresholdBuild, partSizeBuild
	})
	multipartCopyThresholdBuild, multipartCopyPartSizeBuild = "", ""
	if notes, err := applyMultipartCopyBuildSettings(); err != nil || len(notes) != 0 || multipartCopyThreshold != threshold {
		t.Fatalf("notes = %v, err = %v", notes, err)
	}
	multipartCopyThresholdBuild, multipartCopyPartSizeBuild = "8192", "5242880"
	if notes, err := applyMultipartCopyBuildSettings(); err != nil || len(notes) != 2 || multipartCopyThreshold != 8192 || multipartCopyPartSize != 5<<20 {
		t.Fatalf("notes = %v, err = %v", notes, err)
	}
	for _, values := range [][2]string{{"0", ""}, {"8k", ""}, {"", "1024"}, {"", "6442450944"}} {
		multipartCopyThresholdBuild, multipartCopyPartSizeBuild = values[0], values[1]
		if _, err := applyMultipartCopyBuildSettings(); err == nil {
			t.Fatalf("%q and %q: want an error", values[0], values[1])
		}
	}
}
