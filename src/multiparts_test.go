package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeMultipartUpload is one incomplete upload of fakeMultipartS3. A zero initiated gives no Initiated element.
type fakeMultipartUpload struct {
	key, id   string
	initiated time.Time
	parts     []int64
}

// fakeMultipartS3 answers ListMultipartUploads, ListParts and AbortMultipartUpload with the pages of one provider:
// "aws" (and Garage) sorts by key and upload id and pages with both markers, "seaweedfs" sorts by upload id, sends no
// date and pages with NextUploadIdMarker only, and "minio" ignores max-uploads and sends one page.
type fakeMultipartS3 struct {
	t       *testing.T
	style   string
	mu      sync.Mutex
	uploads []fakeMultipartUpload
	aborted []string
	queries []string
	stuck   bool
}

func newFakeMultipartS3(t *testing.T, style string, uploads ...fakeMultipartUpload) (*fakeMultipartS3, *httptest.Server) {
	fake := &fakeMultipartS3{t: t, style: style, uploads: uploads}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return fake, server
}

func (f *fakeMultipartS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	query := r.URL.Query()
	key := strings.TrimPrefix(r.URL.Path, "/bucket/")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/bucket" && query.Has("uploads"):
		f.queries = append(f.queries, r.URL.RawQuery)
		f.list(w, query)
	case r.Method == http.MethodGet && query.Has("uploadId"):
		upload, ok := f.find(key, query.Get("uploadId"))
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "<Error><Code>NoSuchUpload</Code><Message>no</Message></Error>")
			return
		}
		maximum, _ := strconv.Atoi(query.Get("max-parts"))
		parts := upload.parts
		truncated := maximum > 0 && len(parts) > maximum
		if truncated {
			parts = parts[:maximum]
		}
		var body strings.Builder
		fmt.Fprintf(&body, "<ListPartsResult><IsTruncated>%t</IsTruncated>", truncated)
		for index, size := range parts {
			fmt.Fprintf(&body, "<Part><PartNumber>%d</PartNumber><Size>%d</Size></Part>", index+1, size)
		}
		body.WriteString("</ListPartsResult>")
		_, _ = io.WriteString(w, body.String())
	case r.Method == http.MethodDelete && query.Has("uploadId"):
		for index, upload := range f.uploads {
			if upload.key == key && upload.id == query.Get("uploadId") {
				f.uploads = append(f.uploads[:index], f.uploads[index+1:]...)
				f.aborted = append(f.aborted, key+"#"+upload.id)
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "<Error><Code>NoSuchUpload</Code><Message>no</Message></Error>")
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL)
		w.WriteHeader(http.StatusBadRequest)
	}
}

func (f *fakeMultipartS3) find(key, id string) (fakeMultipartUpload, bool) {
	for _, upload := range f.uploads {
		if upload.key == key && upload.id == id {
			return upload, true
		}
	}
	return fakeMultipartUpload{}, false
}

func (f *fakeMultipartS3) list(w http.ResponseWriter, query map[string][]string) {
	if len(query["prefix"]) > 0 {
		f.t.Errorf("the list sent a prefix: %v", query["prefix"])
	}
	get := func(name string) string {
		if values := query[name]; len(values) > 0 {
			return values[0]
		}
		return ""
	}
	sorted := append([]fakeMultipartUpload(nil), f.uploads...)
	sort.Slice(sorted, func(i, j int) bool {
		if f.style == "seaweedfs" || sorted[i].key == sorted[j].key {
			return sorted[i].id < sorted[j].id
		}
		return sorted[i].key < sorted[j].key
	})
	keyMarker, idMarker := get("key-marker"), get("upload-id-marker")
	page := make([]fakeMultipartUpload, 0, len(sorted))
	for _, upload := range sorted {
		switch f.style {
		case "seaweedfs":
			if idMarker != "" && upload.id <= idMarker {
				continue
			}
		case "aws":
			if keyMarker != "" && (upload.key < keyMarker || (upload.key == keyMarker && (idMarker == "" || upload.id <= idMarker))) {
				continue
			}
		}
		page = append(page, upload)
	}
	maximum, _ := strconv.Atoi(get("max-uploads"))
	truncated := false
	if f.style != "minio" && maximum > 0 && len(page) > maximum {
		page, truncated = page[:maximum], true
	}
	var body strings.Builder
	fmt.Fprintf(&body, "<ListMultipartUploadsResult><IsTruncated>%t</IsTruncated>", truncated)
	if truncated {
		last := page[len(page)-1]
		switch {
		case f.stuck:
			fmt.Fprintf(&body, "<NextKeyMarker>%s</NextKeyMarker><NextUploadIdMarker>%s</NextUploadIdMarker>", keyMarker, idMarker)
		case f.style == "seaweedfs":
			fmt.Fprintf(&body, "<NextUploadIdMarker>%s</NextUploadIdMarker>", last.id)
		default:
			fmt.Fprintf(&body, "<NextKeyMarker>%s</NextKeyMarker><NextUploadIdMarker>%s</NextUploadIdMarker>", last.key, last.id)
		}
	}
	for _, upload := range page {
		var key strings.Builder
		_ = xml.EscapeText(&key, []byte(upload.key))
		fmt.Fprintf(&body, "<Upload><Key>%s</Key><UploadId>%s</UploadId>", key.String(), upload.id)
		if f.style != "seaweedfs" && !upload.initiated.IsZero() {
			fmt.Fprintf(&body, "<Initiated>%s</Initiated>", upload.initiated.Format("2006-01-02T15:04:05.000Z"))
		}
		body.WriteString("</Upload>")
	}
	body.WriteString("</ListMultipartUploadsResult>")
	_, _ = io.WriteString(w, body.String())
}

func (f *fakeMultipartS3) abortedUploads() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := append([]string(nil), f.aborted...)
	sort.Strings(out)
	return out
}

// fakeMultipartApplication is the test application with its "rw" instance (root prefix tenant/) on fakeMultipartS3.
func fakeMultipartApplication(t *testing.T, style string, uploads ...fakeMultipartUpload) (*application, *fakeMultipartS3) {
	t.Helper()
	app, _, _ := testApplication(t)
	fake, server := newFakeMultipartS3(t, style, uploads...)
	app.instances["rw"].backend = newAnonymousS3BackendForTest(t, server.URL, "bucket")
	return app, fake
}

func decodeMultipartList(t *testing.T, recorder *httptest.ResponseRecorder) multipartListResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var response multipartListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

// walkMultipartList reads every answer of the list from the first token to the end.
func walkMultipartList(t *testing.T, app *application, prefix string, size int) []multipartUploadJSON {
	t.Helper()
	var all []multipartUploadJSON
	token := ""
	for answers := 0; ; answers++ {
		if answers > 50 {
			t.Fatal("the list does not end")
		}
		response := decodeMultipartList(t, doJSON(app, http.MethodGet, fmt.Sprintf("/api/multiparts?instance=rw&prefix=%s&max=%d&token=%s", prefix, size, token), nil))
		all = append(all, response.Uploads...)
		if token = response.NextToken; token == "" {
			return all
		}
	}
}

func uploadNames(uploads []multipartUploadJSON) []string {
	names := make([]string, 0, len(uploads))
	for _, upload := range uploads {
		names = append(names, upload.Key+"#"+upload.UploadID)
	}
	sort.Strings(names)
	return names
}

// sameKeyUploads has three uploads of one key, uploads of other keys, and uploads outside the root prefix tenant/.
func sameKeyUploads(initiated time.Time) []fakeMultipartUpload {
	return []fakeMultipartUpload{
		{key: "tenant/a.bin", id: "id-3", initiated: initiated},
		{key: "tenant/a.bin", id: "id-1", initiated: initiated},
		{key: "tenant/a.bin", id: "id-2", initiated: initiated},
		{key: "tenant/logs/b.log", id: "id-0", initiated: initiated},
		{key: "tenant/logs/c.log", id: "id-9", initiated: initiated},
		{key: "other/x.bin", id: "id-4", initiated: initiated},
		{key: "tenantx/y.bin", id: "id-5", initiated: initiated},
	}
}

func TestMultipartListFollowsTheMarkersOfEachProvider(t *testing.T) {
	want := []string{"a.bin#id-1", "a.bin#id-2", "a.bin#id-3", "logs/b.log#id-0", "logs/c.log#id-9"}
	for _, style := range []string{"aws", "seaweedfs", "minio"} {
		for _, size := range []int{1, 2, 3, 100} {
			t.Run(fmt.Sprintf("%s/%d", style, size), func(t *testing.T) {
				app, _ := fakeMultipartApplication(t, style, sameKeyUploads(time.Now().Add(-48*time.Hour))...)
				got := uploadNames(walkMultipartList(t, app, "", size))
				if strings.Join(got, " ") != strings.Join(want, " ") {
					t.Fatalf("uploads = %v, want %v", got, want)
				}
				// The prefix of the request is a filter of S3-Browser: the provider gets no prefix.
				got = uploadNames(walkMultipartList(t, app, "logs/", size))
				if strings.Join(got, " ") != "logs/b.log#id-0 logs/c.log#id-9" {
					t.Fatalf("uploads under logs/ = %v", got)
				}
			})
		}
	}
}

func TestMultipartListGivesTheDateAndTheFirstPageOfTheParts(t *testing.T) {
	initiated := time.Date(2026, 10, 1, 8, 30, 0, 0, time.UTC)
	many := make([]int64, multipartPartsPageSize+5)
	for index := range many {
		many[index] = 10
	}
	app, fake := fakeMultipartApplication(t, "aws",
		fakeMultipartUpload{key: "tenant/few.bin", id: "u1", initiated: initiated, parts: []int64{5 << 20, 1000}},
		fakeMultipartUpload{key: "tenant/many.bin", id: "u2", initiated: initiated, parts: many},
		fakeMultipartUpload{key: "tenant/none.bin", id: "u3"},
	)
	// An upload that a person completes between the list and the parts is left out.
	fake.uploads = append(fake.uploads, fakeMultipartUpload{key: "tenant/gone.bin", id: "u4", initiated: initiated})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("uploadId") == "u4" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "<Error><Code>NoSuchUpload</Code><Message>no</Message></Error>")
			return
		}
		fake.ServeHTTP(w, r)
	}))
	defer server.Close()
	app.instances["rw"].backend = newAnonymousS3BackendForTest(t, server.URL, "bucket")
	response := decodeMultipartList(t, doJSON(app, http.MethodGet, "/api/multiparts?instance=rw", nil))
	byKey := map[string]multipartUploadJSON{}
	for _, upload := range response.Uploads {
		byKey[upload.Key] = upload
	}
	if len(byKey) != 3 || response.NextToken != "" || response.MinimumAbortAgeHours != 24 || response.PartsPageSize != multipartPartsPageSize {
		t.Fatalf("response = %+v", response)
	}
	if few := byKey["few.bin"]; few.Parts != 2 || few.Bytes != 5<<20+1000 || few.PartsAtLeast || few.Initiated != "2026-10-01T08:30:00Z" {
		t.Fatalf("few = %+v", few)
	}
	if many := byKey["many.bin"]; many.Parts != multipartPartsPageSize || many.Bytes != int64(10*multipartPartsPageSize) || !many.PartsAtLeast {
		t.Fatalf("many = %+v", many)
	}
	if none := byKey["none.bin"]; none.Parts != 0 || none.Initiated != "" || none.PartsUnknown {
		t.Fatalf("none = %+v", none)
	}
}

func TestMultipartListStopsWhenTheProviderDoesNotMoveItsMarkers(t *testing.T) {
	app, fake := fakeMultipartApplication(t, "aws", sameKeyUploads(time.Now())...)
	fake.stuck = true
	// The provider sends the markers of the request again: S3-Browser stops with an error, not a loop.
	got := doJSON(app, http.MethodGet, "/api/multiparts?instance=rw&max=1", nil)
	if got.Code != http.StatusBadGateway || !strings.Contains(got.Body.String(), "provider_paging") {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
}

func TestMultipartListValidatesItsParameters(t *testing.T) {
	app, _ := fakeMultipartApplication(t, "aws")
	for _, target := range []string{"/api/multiparts?instance=rw&max=0", "/api/multiparts?instance=rw&max=501", "/api/multiparts?instance=rw&max=x", "/api/multiparts?instance=rw&token=%21%21"} {
		if got := doJSON(app, http.MethodGet, target, nil); got.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d %s", target, got.Code, got.Body.String())
		}
	}
	if got := doJSON(app, http.MethodPost, "/api/multiparts?instance=rw", nil); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", got.Code)
	}
}

func TestMultipartAbortSelectedAbortsAtAnyAgeButNotAnActiveUpload(t *testing.T) {
	now := time.Now()
	app, fake := fakeMultipartApplication(t, "seaweedfs",
		fakeMultipartUpload{key: "tenant/new.bin", id: "n1", initiated: now},
		fakeMultipartUpload{key: "tenant/undated.bin", id: "d1"},
		fakeMultipartUpload{key: "tenant/sent.bin", id: "s1"},
	)
	// The resumable-upload store of this process sends s1 now.
	if err := app.uploads.put(uploadSession{ID: "upload-1", Instance: "rw", Key: "sent.bin", Provider: "s3", Status: uploadStatusUploading, ProviderUploadID: "s1"}); err != nil {
		t.Fatal(err)
	}
	list := decodeMultipartList(t, doJSON(app, http.MethodGet, "/api/multiparts?instance=rw", nil))
	for _, upload := range list.Uploads {
		if upload.Active != (upload.UploadID == "s1") {
			t.Fatalf("upload = %+v", upload)
		}
	}
	got := doJSON(app, http.MethodPost, "/api/multiparts/abort", map[string]any{"instance": "rw", "uploads": []map[string]string{
		{"key": "new.bin", "uploadId": "n1"}, {"key": "undated.bin", "uploadId": "d1"}, {"key": "sent.bin", "uploadId": "s1"}, {"key": "gone.bin", "uploadId": "g1"},
	}})
	if got.Code != http.StatusOK {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	var response multipartAbortResponse
	if err := json.Unmarshal(got.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	// An upload that the provider no longer knows counts as aborted: it is gone.
	if len(response.Aborted) != 3 || len(response.Skipped) != 1 || response.Skipped[0].UploadID != "s1" || response.Skipped[0].Reason != activeUploadReason || len(response.Failed) != 0 {
		t.Fatalf("response = %+v", response)
	}
	if got := strings.Join(fake.abortedUploads(), " "); got != "tenant/new.bin#n1 tenant/undated.bin#d1" {
		t.Fatalf("aborted = %s", got)
	}
}

func TestMultipartAbortValidatesTheRequest(t *testing.T) {
	app, fake := fakeMultipartApplication(t, "aws", fakeMultipartUpload{key: "tenant/a", id: "a1"})
	tooMany := make([]map[string]string, maximumMultipartAbortItems+1)
	for index := range tooMany {
		tooMany[index] = map[string]string{"key": "a", "uploadId": "a1"}
	}
	for name, body := range map[string]map[string]any{
		"nothing":            {"instance": "rw"},
		"both forms":         {"instance": "rw", "uploads": []map[string]string{{"key": "a", "uploadId": "a1"}}, "olderThanDays": 3},
		"zero days":          {"instance": "rw", "olderThanDays": 0},
		"negative days":      {"instance": "rw", "olderThanDays": -2},
		"too many days":      {"instance": "rw", "olderThanDays": maximumMultipartAbortDays + 1},
		"no upload id":       {"instance": "rw", "uploads": []map[string]string{{"key": "a"}}},
		"no key":             {"instance": "rw", "uploads": []map[string]string{{"uploadId": "a1"}}},
		"prefix with list":   {"instance": "rw", "uploads": []map[string]string{{"key": "a", "uploadId": "a1"}}, "prefix": "x/"},
		"too many uploads":   {"instance": "rw", "uploads": tooMany},
		"unknown field":      {"instance": "rw", "olderThanDays": 3, "force": true},
		"control in the key": {"instance": "rw", "uploads": []map[string]string{{"key": "a", "uploadId": "a\n1"}}},
	} {
		if got := doJSON(app, http.MethodPost, "/api/multiparts/abort", body); got.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d %s", name, got.Code, got.Body.String())
		}
	}
	// The instance "readonly" has no write permission.
	if got := doJSON(app, http.MethodPost, "/api/multiparts/abort", map[string]any{"instance": "readonly", "olderThanDays": 3}); got.Code != http.StatusForbidden {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	if aborted := fake.abortedUploads(); len(aborted) != 0 {
		t.Fatalf("aborted = %v", aborted)
	}
}

func startMultipartAbortJob(t *testing.T, app *application, body map[string]any) jobState {
	t.Helper()
	got := doJSON(app, http.MethodPost, "/api/multiparts/abort", body)
	if got.Code != http.StatusAccepted {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	var created publicJob
	if err := json.Unmarshal(got.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Type != jobTypeAbortMultiparts {
		t.Fatalf("job = %+v", created)
	}
	return waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted)
}

func TestMultipartAbortJobAbortsOnlyTheDatedUploadsOlderThanTheAge(t *testing.T) {
	now := time.Now().UTC()
	app, fake := fakeMultipartApplication(t, "aws",
		fakeMultipartUpload{key: "tenant/logs/old.log", id: "o1", initiated: now.Add(-10 * 24 * time.Hour)},
		fakeMultipartUpload{key: "tenant/logs/old.log", id: "o2", initiated: now.Add(-8 * 24 * time.Hour)},
		fakeMultipartUpload{key: "tenant/logs/three-days.log", id: "t1", initiated: now.Add(-3 * 24 * time.Hour)},
		fakeMultipartUpload{key: "tenant/logs/young.log", id: "y1", initiated: now.Add(-2 * time.Hour)},
		fakeMultipartUpload{key: "tenant/logs/undated.log", id: "u1"},
		fakeMultipartUpload{key: "tenant/logs/sent.log", id: "s1", initiated: now.Add(-30 * 24 * time.Hour)},
		fakeMultipartUpload{key: "tenant/data/old.bin", id: "x1", initiated: now.Add(-30 * 24 * time.Hour)},
		fakeMultipartUpload{key: "other/logs/old.log", id: "z1", initiated: now.Add(-30 * 24 * time.Hour)},
	)
	if err := app.uploads.put(uploadSession{ID: "upload-1", Instance: "rw", Key: "logs/sent.log", Provider: "s3", Status: uploadStatusUploading, ProviderUploadID: "s1"}); err != nil {
		t.Fatal(err)
	}
	done := startMultipartAbortJob(t, app, map[string]any{"instance": "rw", "olderThanDays": 5, "prefix": "logs/"})
	if got := strings.Join(fake.abortedUploads(), " "); got != "tenant/logs/old.log#o1 tenant/logs/old.log#o2" {
		t.Fatalf("aborted = %s", got)
	}
	public := done.public()
	want := multipartAbortResult{Aborted: 2, SkippedUndated: 1, SkippedRecent: 2, SkippedActive: 1}
	if public.MultipartAbort == nil || *public.MultipartAbort != want || public.OlderThanDays != 5 || public.Processed != 6 {
		t.Fatalf("job = %+v, counts = %+v", public, public.MultipartAbort)
	}
}

func TestMultipartAbortJobNeverAbortsAnUploadYoungerThanADay(t *testing.T) {
	now := time.Now().UTC()
	app, fake := fakeMultipartApplication(t, "aws",
		fakeMultipartUpload{key: "tenant/a.bin", id: "a1", initiated: now.Add(-23 * time.Hour)},
		fakeMultipartUpload{key: "tenant/b.bin", id: "b1", initiated: now.Add(-25 * time.Hour)},
	)
	// A job whose cutoff is in the future (a wrong clock, or a bug) still keeps the uploads of the last 24 hours.
	job, err := app.jobs.create(jobState{
		Type: jobTypeAbortMultiparts, Instance: "rw",
		MultipartAbort: &multipartAbortJob{OlderThanDays: 1, Cutoff: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	done := waitForJobStatus(t, app.jobs, job.ID, jobStatusCompleted)
	if got := strings.Join(fake.abortedUploads(), " "); got != "tenant/b.bin#b1" {
		t.Fatalf("aborted = %s", got)
	}
	if done.MultipartResult == nil || done.MultipartResult.SkippedRecent != 1 || done.MultipartResult.Aborted != 1 {
		t.Fatalf("counts = %+v", done.MultipartResult)
	}
}

func TestMultipartAbortJobOnAProviderWithoutDatesAbortsNothing(t *testing.T) {
	old := time.Now().Add(-90 * 24 * time.Hour)
	app, fake := fakeMultipartApplication(t, "seaweedfs", sameKeyUploads(old)...)
	done := startMultipartAbortJob(t, app, map[string]any{"instance": "rw", "olderThanDays": 1})
	if aborted := fake.abortedUploads(); len(aborted) != 0 {
		t.Fatalf("aborted = %v", aborted)
	}
	if done.MultipartResult.SkippedUndated != 5 || done.MultipartResult.Aborted != 0 {
		t.Fatalf("counts = %+v", done.MultipartResult)
	}
}

func TestMultipartProbeHidesTheFeatureOfAProviderWithoutTheList(t *testing.T) {
	app, _ := fakeMultipartApplication(t, "aws")
	instance := app.instances["rw"]
	instance.probeMultipartUploads(context.Background())
	if !instance.publicInfo().MultipartUploads {
		t.Fatal("a provider with the list lost it")
	}
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !r.URL.Query().Has("uploads") || r.URL.Query().Get("max-uploads") != "1" {
			t.Errorf("probe = %s", r.URL)
		}
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = io.WriteString(w, "<Error><Code>NotImplemented</Code><Message>no</Message></Error>")
	}))
	defer refusing.Close()
	instance.backend = newAnonymousS3BackendForTest(t, refusing.URL, "bucket")
	instance.probeMultipartUploads(context.Background())
	if instance.multipartUploadsAvailable() || instance.publicInfo().MultipartUploads {
		t.Fatal("a provider that answers 501 keeps the list")
	}
	for _, got := range []*httptest.ResponseRecorder{
		doJSON(app, http.MethodGet, "/api/multiparts?instance=rw", nil),
		doJSON(app, http.MethodPost, "/api/multiparts/abort", map[string]any{"instance": "rw", "olderThanDays": 2}),
	} {
		if got.Code != http.StatusNotImplemented || !strings.Contains(got.Body.String(), "multipart_unsupported") {
			t.Fatalf("status = %d %s", got.Code, got.Body.String())
		}
	}
	// The memory backend, as the GCS backend, has no list.
	memory, _, _ := testApplication(t)
	if memory.instances["rw"].publicInfo().MultipartUploads {
		t.Fatal("a backend without the list shows it")
	}
	if _, ok := any(&gcsBackend{}).(MultipartUploadLister); ok {
		t.Fatal("the GCS backend must answer unsupported")
	}
}
