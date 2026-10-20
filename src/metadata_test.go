package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateObjectHeaders(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		headers objectHeaders
		ok      bool
	}{
		"none":                 {objectHeaders{}, true},
		"all":                  {objectHeaders{"text/csv; charset=utf-8", "public, max-age=3600, stale-while-revalidate=\"60\"", `attachment; filename="r.csv"`, "gzip, br", "fr-CA, en", "Wed, 21 Oct 2026 07:28:00 GMT"}, true},
		"type without slash":   {objectHeaders{ContentType: "text"}, false},
		"type with bad params": {objectHeaders{ContentType: "text/plain; ="}, false},
		"non ASCII":            {objectHeaders{ContentType: "text/plain; name=é"}, false},
		"space at the end":     {objectHeaders{CacheControl: "no-cache "}, false},
		"control character":    {objectHeaders{CacheControl: "no-cache\r\nX-Evil: 1"}, false},
		"bad cache directive":  {objectHeaders{CacheControl: "max-age=1,,no-store"}, false},
		"bad disposition":      {objectHeaders{ContentDisposition: "download"}, false},
		"aws-chunked":          {objectHeaders{ContentEncoding: "aws-chunked"}, false},
		"bad encoding":         {objectHeaders{ContentEncoding: "gzip;q=1"}, false},
		"bad language":         {objectHeaders{ContentLanguage: "french language"}, false},
		"wildcard language":    {objectHeaders{ContentLanguage: "*"}, true},
		"RFC 3339 expires":     {objectHeaders{Expires: "2026-10-21T07:28:00Z"}, false},
		"expires not in GMT":   {objectHeaders{Expires: "Wed, 21 Oct 2026 07:28:00 UTC"}, false},
		"too long":             {objectHeaders{CacheControl: "max-age=1, x=" + strings.Repeat("a", maxStandardHeaderBytes)}, false},
	} {
		test := test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := validateObjectHeaders(test.headers); (err == nil) != test.ok {
				t.Fatalf("validateObjectHeaders = %v, want ok = %v", err, test.ok)
			}
		})
	}
}

func TestValidateUserMetadata(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		entries []metadataEntry
		ok      bool
	}{
		"none":              {nil, true},
		"simple":            {[]metadataEntry{{"owner", "ada"}, {"build.id", "a-1_2"}}, true},
		"upper case key":    {[]metadataEntry{{"Owner", "ada"}}, false},
		"key with a space":  {[]metadataEntry{{"my key", "v"}}, false},
		"key with a colon":  {[]metadataEntry{{"a:b", "v"}}, false},
		"key starts with -": {[]metadataEntry{{"-a", "v"}}, false},
		"duplicate key":     {[]metadataEntry{{"a", "1"}, {"a", "2"}}, false},
		"empty value":       {[]metadataEntry{{"a", ""}}, false},
		"non ASCII value":   {[]metadataEntry{{"a", "données"}}, false},
		"new line in value": {[]metadataEntry{{"a", "x\ny"}}, false},
		"2 KiB exactly":     {[]metadataEntry{{"k", strings.Repeat("v", maxUserMetadataBytes-1)}}, true},
		"above 2 KiB":       {[]metadataEntry{{"k", strings.Repeat("v", maxUserMetadataBytes-1)}, {"x", "y"}}, false},
	} {
		test := test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := validateUserMetadata(test.entries); (err == nil) != test.ok {
				t.Fatalf("validateUserMetadata = %v, want ok = %v", err, test.ok)
			}
		})
	}
	for _, etag := range []string{"", `"abc"`, "a b", "a,b", strings.Repeat("a", maxETagBytes+1)} {
		if validateETag(etag) == nil {
			t.Errorf("the ETag %q was accepted", etag)
		}
	}
	if err := validateETag("66f827ff4c27058d46432a4ee1974b78-2"); err != nil {
		t.Fatal(err)
	}
}

func TestS3BackendReplaceObjectMetadataSendsTheHeadersOfTheCopy(t *testing.T) {
	t.Parallel()
	var got http.Header
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, path = r.Header.Clone(), r.URL.Path
		if r.Method != http.MethodPut || r.URL.RawQuery != "" {
			t.Errorf("request %s %s", r.Method, r.URL)
		}
		if r.Header.Get("x-amz-copy-source-if-match") != `"etag-1"` {
			w.WriteHeader(http.StatusPreconditionFailed)
			_, _ = io.WriteString(w, "<Error><Code>PreconditionFailed</Code><Message>no</Message></Error>")
			return
		}
		_, _ = io.WriteString(w, "<CopyObjectResult/>")
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	headers := metadataRequestHeaders(objectHeaders{ContentType: "application/json", CacheControl: "max-age=60"}, []metadataEntry{{"owner", "ada"}})
	if err := backend.ReplaceObjectMetadata(context.Background(), "dir/a file.json", "v 1", "etag-1", headers); err != nil {
		t.Fatal(err)
	}
	if path != "/bucket/dir/a file.json" || got.Get("x-amz-copy-source") != "/bucket/dir/a%20file.json?versionId=v+1" ||
		got.Get("x-amz-metadata-directive") != "REPLACE" || got.Get("x-amz-tagging-directive") != "COPY" ||
		got.Get("Content-Type") != "application/json" || got.Get("Cache-Control") != "max-age=60" || got.Get("X-Amz-Meta-Owner") != "ada" ||
		got.Get("Content-Disposition") != "" || got.Get("Expires") != "" {
		t.Fatalf("path = %q, headers = %v", path, got)
	}
	if headers.Get("x-amz-copy-source") != "" {
		t.Fatal("the call changed the headers of the caller")
	}
	err := backend.ReplaceObjectMetadata(context.Background(), "k", "", "other", http.Header{})
	if !isPreconditionFailed(err) {
		t.Fatalf("err = %v", err)
	}
}

func fakeMetadataApplication(t *testing.T) (*application, *fakeCopyS3) {
	t.Helper()
	app, fake := fakeCopyApplication(t)
	fake.put("tenant/doc.txt", []byte("small"), "text/plain", "team=data")
	return app, fake
}

func decodeMetadata(t *testing.T, recorder *httptest.ResponseRecorder) metadataResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var response metadataResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestMetadataAPIGivesTheStoredValuesNotTheValuesOfTheGateway(t *testing.T) {
	app, _ := fakeMetadataApplication(t)
	// The gateway /s3 adds its own Cache-Control in front of the value of the provider.
	head := httptest.NewRecorder()
	app.routes().ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/s3?instance=rw&key=doc.txt", nil))
	if gateway := strings.Join(head.Header().Values("Cache-Control"), ", "); gateway != "private, no-store, max-age=60" {
		t.Fatalf("Cache-Control of the gateway = %q", gateway)
	}
	state := decodeMetadata(t, doJSON(app, http.MethodGet, "/api/metadata?instance=rw&key=doc.txt", nil))
	if state.Headers != (objectHeaders{ContentType: "text/plain", CacheControl: "max-age=60"}) ||
		len(state.Metadata) != 1 || state.Metadata[0] != (metadataEntry{"origin", "seed"}) {
		t.Fatalf("state = %+v", state)
	}
	if state.ETag != "etag-tenant/doc.txt" || state.Size != 5 || state.MultipartETag || state.CopyInParts || state.MaxMetadataBytes != maxUserMetadataBytes {
		t.Fatalf("state = %+v", state)
	}
}

func TestMetadataAPIReplacesTheMetadataAndKeepsTheTags(t *testing.T) {
	app, fake := fakeMetadataApplication(t)
	got := doJSON(app, http.MethodPut, "/api/metadata", map[string]any{
		"instance": "rw", "key": "doc.txt", "etag": "etag-tenant/doc.txt",
		"headers":  map[string]string{"contentType": "application/json", "contentLanguage": "fr"},
		"metadata": []metadataEntry{{"owner", "grace"}},
	})
	state := decodeMetadata(t, got)
	// The cache control and the metadata origin are not in the request: they are removed.
	if state.Headers != (objectHeaders{ContentType: "application/json", ContentLanguage: "fr"}) ||
		len(state.Metadata) != 1 || state.Metadata[0] != (metadataEntry{"owner", "grace"}) {
		t.Fatalf("state = %+v", state)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.copyHeaders) != 1 {
		t.Fatalf("copies = %d", len(fake.copyHeaders))
	}
	sent := fake.copyHeaders[0]
	if sent.Get("x-amz-copy-source") != "/bucket/tenant/doc.txt" || sent.Get("x-amz-copy-source-if-match") != `"etag-tenant/doc.txt"` ||
		sent.Get("x-amz-metadata-directive") != "REPLACE" || sent.Get("x-amz-tagging-directive") != "COPY" {
		t.Fatalf("copy headers = %v", sent)
	}
	if fake.objects["tenant/doc.txt"].tags != "team=data" || string(fake.objects["tenant/doc.txt"].data) != "small" {
		t.Fatalf("object = %+v", fake.objects["tenant/doc.txt"])
	}
}

func TestMetadataAPIRefusesTheEditOfAnObjectThatChanged(t *testing.T) {
	app, fake := fakeMetadataApplication(t)
	body := map[string]any{"instance": "rw", "key": "doc.txt", "etag": "etag-of-an-older-object", "headers": map[string]string{"contentType": "text/csv"}}
	got := doJSON(app, http.MethodPut, "/api/metadata", body)
	if got.Code != http.StatusPreconditionFailed || !strings.Contains(got.Body.String(), "object_changed") {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	// A change of the metadata only keeps the ETag: the date of the object is not the date that the form read.
	fake.mu.Lock()
	fake.objects["tenant/doc.txt"].headers.Set("Last-Modified", "Tue, 20 Oct 2026 14:09:42 GMT")
	fake.mu.Unlock()
	state := decodeMetadata(t, doJSON(app, http.MethodGet, "/api/metadata?instance=rw&key=doc.txt", nil))
	if state.LastModified != "2026-10-20T14:09:42Z" {
		t.Fatalf("lastModified = %q", state.LastModified)
	}
	body["etag"], body["lastModified"] = "etag-tenant/doc.txt", "2026-10-20T14:09:41Z"
	got = doJSON(app, http.MethodPut, "/api/metadata", body)
	if got.Code != http.StatusPreconditionFailed || !strings.Contains(got.Body.String(), "object_changed") {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	body["lastModified"] = "20 Oct 2026"
	if got = doJSON(app, http.MethodPut, "/api/metadata", body); got.Code != http.StatusBadRequest {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	body["lastModified"] = state.LastModified
	// The object changes between the HEAD request and the copy: the provider refuses the copy with 412.
	backend := app.instances["rw"].backend.(*s3Backend)
	app.instances["rw"].backend = changingETag{backend}
	got = doJSON(app, http.MethodPut, "/api/metadata", body)
	if got.Code != http.StatusPreconditionFailed || !strings.Contains(got.Body.String(), "object_changed") {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.objects["tenant/doc.txt"].headers.Get("Content-Type") != "text/plain" || len(fake.copyHeaders) != 1 {
		t.Fatalf("the object changed: %v, copies = %d", fake.objects["tenant/doc.txt"].headers, len(fake.copyHeaders))
	}
}

// changingETag sends the copy with another ETag: the object changed after the HEAD request.
type changingETag struct{ *s3Backend }

func (b changingETag) ReplaceObjectMetadata(ctx context.Context, key, version, _ string, headers http.Header) error {
	return b.s3Backend.ReplaceObjectMetadata(ctx, key, version, "etag-of-a-newer-object", headers)
}

func TestMetadataAPICopiesALargeObjectInPartsWithTheNewMetadata(t *testing.T) {
	app, fake := fakeMetadataApplication(t)
	data := []byte(strings.Repeat("0123456789", 4))
	fake.put("tenant/big.bin", data, "application/octet-stream", "keep=1")
	state := decodeMetadata(t, doJSON(app, http.MethodGet, "/api/metadata?instance=rw&key=big.bin", nil))
	if !state.CopyInParts {
		t.Fatalf("state = %+v", state)
	}
	got := doJSON(app, http.MethodPut, "/api/metadata", map[string]any{
		"instance": "rw", "key": "big.bin", "etag": state.ETag,
		"headers": map[string]string{"contentType": "application/x-big", "cacheControl": "no-cache"}, "metadata": []metadataEntry{{"owner", "ops"}},
	})
	decodeMetadata(t, got)
	fake.mu.Lock()
	created := fake.created["upload-1"]
	object := fake.objects["tenant/big.bin"]
	copies := fake.copyObjects
	fake.mu.Unlock()
	if created.Get("Content-Type") != "application/x-big" || created.Get("Cache-Control") != "no-cache" || created.Get("X-Amz-Meta-Owner") != "ops" ||
		created.Get("X-Amz-Meta-Origin") != "" || created.Get("x-amz-tagging") != "keep=1" {
		t.Fatalf("created with %v", created)
	}
	if string(object.data) != string(data) || object.tags != "keep=1" || copies != 0 {
		t.Fatalf("object = %q %q, copy objects = %d", object.data, object.tags, copies)
	}
	// A wrong ETag stops the copy in parts before any upload.
	got = doJSON(app, http.MethodPut, "/api/metadata", map[string]any{"instance": "rw", "key": "big.bin", "etag": "old", "headers": map[string]string{}})
	if got.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	if err := app.instances["rw"].CopyMultipart(context.Background(), "tenant/big.bin", "tenant/big.bin", multipartCopyOptions{SourceETag: "old"}); !isPreconditionFailed(err) {
		t.Fatalf("err = %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.nextUpload != 1 {
		t.Fatalf("uploads = %d", fake.nextUpload)
	}
}

func TestMetadataAPICopiesAnOlderVersionOntoTheKey(t *testing.T) {
	app, fake := fakeMetadataApplication(t)
	fake.mu.Lock()
	fake.versions["tenant/doc.txt?v1"] = fakeCopyObject{data: []byte("old"), headers: http.Header{"Content-Type": {"text/old"}}, tags: "age=old"}
	fake.mu.Unlock()
	got := doJSON(app, http.MethodPut, "/api/metadata", map[string]any{
		"instance": "rw", "key": "doc.txt", "version": "v1", "etag": "etag-tenant/doc.txt", "headers": map[string]string{"contentType": "text/markdown"},
	})
	decodeMetadata(t, got)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if source := fake.copyHeaders[0].Get("x-amz-copy-source"); source != "/bucket/tenant/doc.txt?versionId=v1" {
		t.Fatalf("source = %q", source)
	}
	if object := fake.objects["tenant/doc.txt"]; string(object.data) != "old" || object.headers.Get("Content-Type") != "text/markdown" || object.tags != "age=old" {
		t.Fatalf("object = %q %v %q", object.data, object.headers, object.tags)
	}
}

func TestMetadataAPIValidatesTheRequestBeforeTheProvider(t *testing.T) {
	app, fake := fakeMetadataApplication(t)
	for name, body := range map[string]map[string]any{
		"no etag":        {"instance": "rw", "key": "doc.txt", "headers": map[string]string{}},
		"no key":         {"instance": "rw", "key": "", "etag": "e", "headers": map[string]string{}},
		"unknown header": {"instance": "rw", "key": "doc.txt", "etag": "e", "headers": map[string]string{"xAmzAcl": "public-read"}},
		"unknown field":  {"instance": "rw", "key": "doc.txt", "etag": "e", "acl": "public-read"},
		"bad type":       {"instance": "rw", "key": "doc.txt", "etag": "e", "headers": map[string]string{"contentType": "plain"}},
		"bad metadata":   {"instance": "rw", "key": "doc.txt", "etag": "e", "metadata": []metadataEntry{{"Owner", "ada"}}},
		"long metadata":  {"instance": "rw", "key": "doc.txt", "etag": "e", "metadata": []metadataEntry{{"a", strings.Repeat("x", maxUserMetadataBytes)}}},
		"bad version":    {"instance": "rw", "key": "doc.txt", "etag": "e", "version": "v\n1"},
	} {
		if got := doJSON(app, http.MethodPut, "/api/metadata", body); got.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d %s", name, got.Code, got.Body.String())
		}
	}
	if got := doJSON(app, http.MethodPut, "/api/metadata", map[string]any{"instance": "readonly", "key": "readonly.txt", "etag": "e"}); got.Code != http.StatusForbidden {
		t.Errorf("read-only instance = %d %s", got.Code, got.Body.String())
	}
	if got := doJSON(app, http.MethodDelete, "/api/metadata", nil); got.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE = %d", got.Code)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.copyHeaders) != 0 {
		t.Fatalf("a refused request reached the provider: %d copies", len(fake.copyHeaders))
	}
}

func TestMetadataAPIAnswers501WithoutTheEdit(t *testing.T) {
	// The memory backend, as the GCS backend, has no edit of the metadata.
	app, _, _ := testApplication(t)
	if app.instances["rw"].publicInfo().MetadataEditable {
		t.Fatal("a backend without the edit is editable")
	}
	for _, got := range []*httptest.ResponseRecorder{
		doJSON(app, http.MethodGet, "/api/metadata?instance=rw&key=folder/direct.txt", nil),
		doJSON(app, http.MethodPut, "/api/metadata", map[string]any{"instance": "rw", "key": "folder/direct.txt", "etag": "e"}),
	} {
		if got.Code != http.StatusNotImplemented || !strings.Contains(got.Body.String(), "metadata_unsupported") {
			t.Fatalf("status = %d %s", got.Code, got.Body.String())
		}
	}
	if _, ok := any(&gcsBackend{}).(ObjectMetadataEditor); ok {
		t.Fatal("the GCS backend must answer unsupported")
	}
}

func TestProbeMetadataEditMarksAProviderWithoutCopyObject(t *testing.T) {
	app, _ := fakeMetadataApplication(t)
	instance := app.instances["rw"]
	instance.probeMetadataEdit(context.Background())
	if !instance.metadataEditAvailable() || !instance.publicInfo().MetadataEditable {
		t.Fatal("a provider that answers no such key keeps the edit")
	}
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-amz-copy-source-if-match") != `"s3-browser-probe"` || r.Header.Get("x-amz-metadata-directive") != "REPLACE" {
			t.Errorf("probe headers = %v", r.Header)
		}
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = io.WriteString(w, "<Error><Code>NotImplemented</Code><Message>Unimplemented action: CopyObject</Message></Error>")
	}))
	defer refusing.Close()
	instance.backend = newAnonymousS3BackendForTest(t, refusing.URL, "bucket")
	instance.probeMetadataEdit(context.Background())
	if instance.metadataEditAvailable() || instance.publicInfo().MetadataEditable {
		t.Fatal("a provider that answers 501 has no edit")
	}
	if got := doJSON(app, http.MethodGet, "/api/metadata?instance=rw&key=doc.txt", nil); got.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	// An instance without the write permission is not probed.
	readOnly := app.instances["readonly"]
	readOnly.backend = newAnonymousS3BackendForTest(t, refusing.URL, "bucket")
	readOnly.probeMetadataEdit(context.Background())
	if !readOnly.metadataEditAvailable() {
		t.Fatal("the probe ran on an instance without the write permission")
	}
}
