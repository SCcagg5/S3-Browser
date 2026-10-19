package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestValidateTags(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("k", maxTagKeyChars+1)
	many := make([]objectTag, maxObjectTags+1)
	for index := range many {
		many[index] = objectTag{Key: fmt.Sprintf("k%d", index), Value: "v"}
	}
	for name, test := range map[string]struct {
		tags []objectTag
		ok   bool
	}{
		"none":            {nil, true},
		"simple":          {[]objectTag{{"team", "data"}, {"retention", "30d"}}, true},
		"allowed symbols": {[]objectTag{{"a+b-c=d.e_f:g/h@i", "x y"}}, true},
		"empty value":     {[]objectTag{{"flag", ""}}, true},
		"unicode":         {[]objectTag{{"équipe", "données"}}, true},
		"empty key":       {[]objectTag{{"", "v"}}, false},
		"long key":        {[]objectTag{{long, "v"}}, false},
		"long value":      {[]objectTag{{"k", strings.Repeat("v", maxTagValueChars+1)}}, false},
		"aws prefix":      {[]objectTag{{"aws:cloudformation", "v"}}, false},
		"AWS prefix":      {[]objectTag{{"AWS:x", "v"}}, false},
		"bad character":   {[]objectTag{{"k", "a&b"}}, false},
		"bad key char":    {[]objectTag{{"k?", "v"}}, false},
		"duplicate key":   {[]objectTag{{"k", "1"}, {"k", "2"}}, false},
		"eleven tags":     {many, false},
		"ten tags":        {many[:maxObjectTags], true},
	} {
		test := test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			err := validateTags(test.tags)
			if (err == nil) != test.ok {
				t.Fatalf("validateTags = %v, want ok = %v", err, test.ok)
			}
		})
	}
}

func TestApplyTagChange(t *testing.T) {
	t.Parallel()
	current := []objectTag{{"a", "1"}, {"b", "2"}, {"c", "3"}}
	got := applyTagChange(current, tagChange{Add: []objectTag{{"b", "20"}, {"d", "4"}}, Remove: []string{"a", "missing"}})
	want := []objectTag{{"b", "20"}, {"c", "3"}, {"d", "4"}}
	if !sameTags(got, want) {
		t.Fatalf("tags = %v, want %v", got, want)
	}
	if len(current) != 3 || current[1].Value != "2" {
		t.Fatalf("the input changed: %v", current)
	}
	// A key that is removed and added in one change stays: the addition wins.
	if got := applyTagChange(current, tagChange{Add: []objectTag{{"a", "9"}}, Remove: []string{"a"}}); got[0] != (objectTag{"a", "9"}) {
		t.Fatalf("tags = %v", got)
	}
}

func TestParseTaggingHeader(t *testing.T) {
	t.Parallel()
	header := http.Header{}
	header.Set("X-Amz-Tagging", "team=data&retention=30d")
	tags, err := parseTaggingHeader(header)
	if err != nil || !sameTags(tags, []objectTag{{"retention", "30d"}, {"team", "data"}}) {
		t.Fatalf("tags = %v, err = %v", tags, err)
	}
	if tags, err := parseTaggingHeader(http.Header{}); err != nil || tags != nil {
		t.Fatalf("no header: %v, %v", tags, err)
	}
	header.Set("X-Amz-Tagging", "aws:x=1")
	if _, err := parseTaggingHeader(header); err == nil {
		t.Fatal("a reserved key was accepted")
	}
	header.Set("X-Amz-Tagging", "%zz=1")
	if _, err := parseTaggingHeader(header); err == nil {
		t.Fatal("an invalid query string was accepted")
	}
}

// taggingMemory is a memoryBackend with object tags and lifecycle rules.
type taggingMemory struct {
	*memoryBackend
	mu         sync.Mutex
	tags       map[string][]objectTag
	puts       int
	rules      []lifecycleRule
	uploadTags map[string]string
}

func newTaggingMemory(memory *memoryBackend) *taggingMemory {
	return &taggingMemory{memoryBackend: memory, tags: map[string][]objectTag{}, uploadTags: map[string]string{}}
}

func (b *taggingMemory) GetObjectTagging(_ context.Context, key, _ string) ([]objectTag, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.memoryBackend.objects[key]; !ok {
		return nil, &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchKey"}
	}
	return append([]objectTag{}, b.tags[key]...), nil
}

func (b *taggingMemory) PutObjectTagging(_ context.Context, key, _ string, tags []objectTag) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.puts++
	if len(tags) == 0 {
		delete(b.tags, key)
		return nil
	}
	b.tags[key] = append([]objectTag(nil), tags...)
	return nil
}

func (b *taggingMemory) GetBucketLifecycle(context.Context) ([]lifecycleRule, error) {
	return b.rules, nil
}

func (b *taggingMemory) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	if encoded, _ := ctx.Value(uploadTagsKey{}).(string); encoded != "" {
		b.mu.Lock()
		b.uploadTags[key] = encoded
		b.mu.Unlock()
	}
	return b.memoryBackend.Put(ctx, key, body, size, contentType)
}

func (b *taggingMemory) InitiateMultipart(ctx context.Context, key, contentType string) (string, error) {
	if encoded, _ := ctx.Value(uploadTagsKey{}).(string); encoded != "" {
		b.mu.Lock()
		b.uploadTags[key] = encoded
		b.mu.Unlock()
	}
	return b.memoryBackend.InitiateMultipart(ctx, key, contentType)
}

func taggingTestApplication(t *testing.T) (*application, *taggingMemory) {
	app, _, memory := testApplication(t)
	backend := newTaggingMemory(memory)
	app.instances["rw"].backend = backend
	return app, backend
}

func doJSON(app *application, method, target string, body any) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, request)
	return recorder
}

func TestTagsAPIReadsAndReplacesTheTagsOfAnObject(t *testing.T) {
	app, backend := taggingTestApplication(t)
	backend.tags["tenant/folder/direct.txt"] = []objectTag{{"team", "data"}}
	got := doJSON(app, http.MethodGet, "/api/tags?instance=rw&key=folder/direct.txt", nil)
	if got.Code != http.StatusOK {
		t.Fatalf("get = %d %s", got.Code, got.Body.String())
	}
	var response tagsResponse
	if err := json.Unmarshal(got.Body.Bytes(), &response); err != nil || response.MaxTags != maxObjectTags || !sameTags(response.Tags, []objectTag{{"team", "data"}}) {
		t.Fatalf("response = %+v, err = %v", response, err)
	}
	put := doJSON(app, http.MethodPut, "/api/tags", map[string]any{"instance": "rw", "key": "folder/direct.txt", "tags": []objectTag{{"z", "1"}, {"a", "2"}}})
	if put.Code != http.StatusOK {
		t.Fatalf("put = %d %s", put.Code, put.Body.String())
	}
	if !sameTags(backend.tags["tenant/folder/direct.txt"], []objectTag{{"a", "2"}, {"z", "1"}}) {
		t.Fatalf("stored tags = %v", backend.tags["tenant/folder/direct.txt"])
	}
	// An empty list removes the tags.
	if got := doJSON(app, http.MethodPut, "/api/tags", map[string]any{"instance": "rw", "key": "folder/direct.txt", "tags": []objectTag{}}); got.Code != http.StatusOK {
		t.Fatalf("clear = %d %s", got.Code, got.Body.String())
	}
	if len(backend.tags["tenant/folder/direct.txt"]) != 0 {
		t.Fatalf("stored tags = %v", backend.tags["tenant/folder/direct.txt"])
	}
}

func TestTagsAPIRefusesWhatS3Refuses(t *testing.T) {
	app, backend := taggingTestApplication(t)
	for name, body := range map[string]map[string]any{
		"reserved prefix": {"instance": "rw", "key": "folder/direct.txt", "tags": []objectTag{{"aws:x", "1"}}},
		"bad character":   {"instance": "rw", "key": "folder/direct.txt", "tags": []objectTag{{"k", "a&b"}}},
		"no key":          {"instance": "rw", "key": "", "tags": []objectTag{{"k", "v"}}},
	} {
		if got := doJSON(app, http.MethodPut, "/api/tags", body); got.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d %s", name, got.Code, got.Body.String())
		}
	}
	if backend.puts != 0 {
		t.Fatalf("a refused request reached the provider: %d", backend.puts)
	}
	if got := doJSON(app, http.MethodGet, "/api/tags?instance=rw&key=missing.txt", nil); got.Code != http.StatusNotFound {
		t.Errorf("missing object = %d %s", got.Code, got.Body.String())
	}
	// The instance "readonly" has no write permission.
	if got := doJSON(app, http.MethodPut, "/api/tags", map[string]any{"instance": "readonly", "key": "readonly.txt", "tags": []objectTag{{"k", "v"}}}); got.Code != http.StatusForbidden {
		t.Errorf("read-only instance = %d %s", got.Code, got.Body.String())
	}
	if got := doJSON(app, http.MethodDelete, "/api/tags", nil); got.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE = %d", got.Code)
	}
}

func TestTagsAPIAnswers501ForAProviderWithoutTags(t *testing.T) {
	app, _, _ := testApplication(t)
	got := doJSON(app, http.MethodGet, "/api/tags?instance=rw&key=folder/direct.txt", nil)
	if got.Code != http.StatusNotImplemented || !strings.Contains(got.Body.String(), "tagging_unsupported") {
		t.Fatalf("get = %d %s", got.Code, got.Body.String())
	}
	if got := doJSON(app, http.MethodPut, "/api/tags", map[string]any{"instance": "rw", "key": "folder/direct.txt", "tags": []objectTag{{"k", "v"}}}); got.Code != http.StatusNotImplemented {
		t.Fatalf("put = %d %s", got.Code, got.Body.String())
	}
	if got := doJSON(app, http.MethodGet, "/api/lifecycle?instance=rw", nil); got.Code != http.StatusNotImplemented {
		t.Fatalf("lifecycle = %d %s", got.Code, got.Body.String())
	}
}

func TestTagsAPITurnsA501OfTheProviderIntoTaggingUnsupported(t *testing.T) {
	app, memory := taggingTestApplication(t)
	app.instances["rw"].backend = refusingTagger{memory}
	got := doJSON(app, http.MethodGet, "/api/tags?instance=rw&key=folder/direct.txt", nil)
	if got.Code != http.StatusNotImplemented || !strings.Contains(got.Body.String(), "tagging_unsupported") {
		t.Fatalf("get = %d %s", got.Code, got.Body.String())
	}
}

type refusingTagger struct{ *taggingMemory }

func (refusingTagger) GetObjectTagging(context.Context, string, string) ([]objectTag, error) {
	return nil, &upstreamError{StatusCode: http.StatusNotImplemented, Code: "NotImplemented"}
}

func TestTagJobAddsAndRemovesTagsUnderAPrefixAndSkipsObjectsThatAlreadyMatch(t *testing.T) {
	app, backend := taggingTestApplication(t)
	for index := 0; index < 5; index++ {
		backend.memoryBackend.objects[fmt.Sprintf("tenant/data/f%d.txt", index)] = memoryObject{data: []byte("x")}
	}
	backend.memoryBackend.objects["tenant/other/keep.txt"] = memoryObject{data: []byte("x")}
	backend.tags["tenant/data/f0.txt"] = []objectTag{{"team", "data"}, {"old", "1"}}
	backend.tags["tenant/data/f1.txt"] = []objectTag{{"team", "data"}}
	recorder := doJSON(app, http.MethodPost, "/api/tags/bulk", map[string]any{
		"instance": "rw", "prefix": "data", "add": []objectTag{{"team", "data"}}, "remove": []string{"old"},
	})
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("bulk = %d %s", recorder.Code, recorder.Body.String())
	}
	var job publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if job.Type != jobTypeTagPrefix || job.Prefix != "data/" {
		t.Fatalf("job = %+v", job)
	}
	done := waitForJobStatus(t, app.jobs, job.ID, jobStatusCompleted)
	if done.Processed != 5 {
		t.Fatalf("processed = %d", done.Processed)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	for index := 0; index < 5; index++ {
		key := fmt.Sprintf("tenant/data/f%d.txt", index)
		if !sameTags(backend.tags[key], []objectTag{{"team", "data"}}) {
			t.Errorf("%s tags = %v", key, backend.tags[key])
		}
	}
	if len(backend.tags["tenant/other/keep.txt"]) != 0 {
		t.Errorf("an object outside the prefix changed: %v", backend.tags["tenant/other/keep.txt"])
	}
	// f1 already had the result: 5 objects, 1 without change, 4 writes.
	if backend.puts != 4 {
		t.Errorf("tag writes = %d, want 4", backend.puts)
	}
}

func TestTagJobFailsWhenAnObjectWouldHaveMoreThanTenTags(t *testing.T) {
	app, backend := taggingTestApplication(t)
	backend.memoryBackend.objects["tenant/full/f.txt"] = memoryObject{data: []byte("x")}
	full := make([]objectTag, maxObjectTags)
	for index := range full {
		full[index] = objectTag{Key: fmt.Sprintf("k%d", index), Value: "v"}
	}
	backend.tags["tenant/full/f.txt"] = full
	recorder := doJSON(app, http.MethodPost, "/api/tags/bulk", map[string]any{"instance": "rw", "prefix": "full/", "add": []objectTag{{"extra", "1"}}})
	var job publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	failed := waitForJobStatus(t, app.jobs, job.ID, jobStatusFailed)
	if !strings.Contains(failed.Error, "full/f.txt") || !strings.Contains(failed.Error, "at most 10 tags") {
		t.Fatalf("error = %q", failed.Error)
	}
}

func TestTagsBulkRequestIsValidated(t *testing.T) {
	app, _ := taggingTestApplication(t)
	for name, body := range map[string]map[string]any{
		"no change":    {"instance": "rw", "prefix": "data/"},
		"bad tag":      {"instance": "rw", "prefix": "data/", "add": []objectTag{{"aws:x", "1"}}},
		"empty remove": {"instance": "rw", "prefix": "data/", "remove": []string{""}},
		"read only":    {"instance": "readonly", "prefix": "data/", "add": []objectTag{{"k", "v"}}},
	} {
		got := doJSON(app, http.MethodPost, "/api/tags/bulk", body)
		if got.Code != http.StatusBadRequest && got.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d %s", name, got.Code, got.Body.String())
		}
	}
}

func TestLifecycleAPIGivesTheRules(t *testing.T) {
	app, backend := taggingTestApplication(t)
	backend.rules = []lifecycleRule{{ID: "expire", Enabled: true, Prefix: "logs/", Tags: []objectTag{{"retention", "30d"}}, ExpirationDays: 30}}
	got := doJSON(app, http.MethodGet, "/api/lifecycle?instance=rw", nil)
	if got.Code != http.StatusOK {
		t.Fatalf("lifecycle = %d %s", got.Code, got.Body.String())
	}
	var response lifecycleResponse
	if err := json.Unmarshal(got.Body.Bytes(), &response); err != nil || len(response.Rules) != 1 || response.Rules[0].ExpirationDays != 30 {
		t.Fatalf("response = %+v, err = %v", response, err)
	}
}

func TestUploadsCarryTags(t *testing.T) {
	app, backend := taggingTestApplication(t)
	body := []byte("tagged")
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/s3?instance=rw&key=tagged.txt", bytes.NewReader(body))
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("X-Amz-Tagging", "team=data&retention=30d")
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("put = %d %s", recorder.Code, recorder.Body.String())
	}
	if got := backend.uploadTags["tenant/tagged.txt"]; got != "retention=30d&team=data" {
		t.Fatalf("tags sent to the provider = %q", got)
	}
	bad := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPut, "/s3?instance=rw&key=bad.txt", bytes.NewReader(body))
	request.Header.Set("X-Amz-Tagging", "aws:x=1")
	app.routes().ServeHTTP(bad, request)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("a reserved key = %d %s", bad.Code, bad.Body.String())
	}
	created := doJSON(app, http.MethodPost, "/api/uploads", map[string]any{
		"instance": "rw", "key": "multi.bin", "size": 6 << 20, "contentType": "application/octet-stream", "tags": []objectTag{{"team", "data"}},
	})
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	if got := backend.uploadTags["tenant/multi.bin"]; got != "team=data" {
		t.Fatalf("tags of the multipart upload = %q", got)
	}
	refused := doJSON(app, http.MethodPost, "/api/uploads", map[string]any{
		"instance": "rw", "key": "refused.bin", "size": 6 << 20, "tags": []objectTag{{"aws:x", "1"}},
	})
	if refused.Code != http.StatusBadRequest {
		t.Fatalf("reserved tag = %d %s", refused.Code, refused.Body.String())
	}
}

func TestS3BackendTagsAndLifecycle(t *testing.T) {
	t.Parallel()
	var putBody, putQuery, deleted, sentTagging string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Query().Has("tagging"):
			_, _ = io.WriteString(w, `<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>team</Key><Value>data</Value></Tag><Tag><Key>a</Key><Value>1</Value></Tag></TagSet></Tagging>`)
		case r.Method == http.MethodPut && r.URL.Query().Has("tagging"):
			body, _ := io.ReadAll(r.Body)
			putBody, putQuery = string(body), r.URL.RawQuery
			if r.Header.Get("Content-MD5") == "" {
				t.Error("no Content-MD5")
			}
		case r.Method == http.MethodDelete && r.URL.Query().Has("tagging"):
			deleted = r.URL.Path
		case r.Method == http.MethodPut:
			sentTagging = r.Header.Get("x-amz-tagging")
		case r.Method == http.MethodGet && r.URL.Query().Has("lifecycle"):
			_, _ = io.WriteString(w, `<LifecycleConfiguration>
<Rule><ID>expire-logs</ID><Status>Enabled</Status><Filter><And><Prefix>logs/</Prefix><Tag><Key>retention</Key><Value>30d</Value></Tag><ObjectSizeGreaterThan>1024</ObjectSizeGreaterThan></And></Filter>
<Expiration><Days>30</Days></Expiration><Transition><Days>7</Days><StorageClass>COLD</StorageClass></Transition>
<NoncurrentVersionExpiration><NoncurrentDays>5</NoncurrentDays></NoncurrentVersionExpiration>
<AbortIncompleteMultipartUpload><DaysAfterInitiation>2</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>
<Rule><ID>legacy</ID><Status>Disabled</Status><Prefix>tmp/</Prefix><Expiration><Days>1</Days></Expiration></Rule>
</LifecycleConfiguration>`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	ctx := context.Background()
	tags, err := backend.GetObjectTagging(ctx, "k", "v1")
	if err != nil || !sameTags(tags, []objectTag{{"a", "1"}, {"team", "data"}}) {
		t.Fatalf("tags = %v, err = %v", tags, err)
	}
	if err := backend.PutObjectTagging(ctx, "k", "v1", []objectTag{{"a", "x&y"}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(putBody, "<Key>a</Key><Value>x&amp;y</Value>") || !strings.Contains(putQuery, "versionId=v1") {
		t.Fatalf("put body = %s, query = %s", putBody, putQuery)
	}
	if err := backend.PutObjectTagging(ctx, "k", "", nil); err != nil || deleted != "/bucket/k" {
		t.Fatalf("clear: %v, deleted = %q", err, deleted)
	}
	if err := backend.Put(withUploadTags(ctx, []objectTag{{"b", "2"}, {"a", "1"}}), "o", strings.NewReader("x"), 1, "text/plain"); err != nil || sentTagging != "a=1&b=2" {
		t.Fatalf("x-amz-tagging = %q, err = %v", sentTagging, err)
	}
	rules, err := backend.GetBucketLifecycle(ctx)
	if err != nil || len(rules) != 2 {
		t.Fatalf("rules = %+v, err = %v", rules, err)
	}
	first := rules[0]
	if first.ID != "expire-logs" || !first.Enabled || first.Prefix != "logs/" || !sameTags(first.Tags, []objectTag{{"retention", "30d"}}) ||
		first.SizeGreaterThan != 1024 || first.ExpirationDays != 30 || len(first.Transitions) != 1 || first.Transitions[0].StorageClass != "COLD" ||
		first.NoncurrentExpirationDays != 5 || first.AbortMultipartDays != 2 {
		t.Fatalf("first rule = %+v", first)
	}
	if rules[1].Enabled || rules[1].Prefix != "tmp/" || rules[1].ExpirationDays != 1 {
		t.Fatalf("legacy rule = %+v", rules[1])
	}
}

func TestS3BackendLifecycleWithoutRulesIsEmpty(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `<Error><Code>NoSuchLifecycleConfiguration</Code><Message>none</Message></Error>`)
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	rules, err := backend.GetBucketLifecycle(context.Background())
	if err != nil || rules == nil || len(rules) != 0 {
		t.Fatalf("rules = %v, err = %v", rules, err)
	}
}
