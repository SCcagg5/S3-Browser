package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// volumeTestApplication starts the server with one volume block "vol" on the folder root. extra holds more attribute
// lines of the block.
func volumeTestApplication(t *testing.T, root, extra string) *application {
	t.Helper()
	cfg, err := decodeVolumeConfig(t, volumeConfigText(`path = "`+root+`"`+"\n"+extra))
	if err != nil {
		t.Fatal(err)
	}
	app, err := newApplication(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.close)
	return app
}

func writeVolumeFile(t *testing.T, root, relative, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// volumeTree makes the test tree of a volume, and a folder outside it with a secret file. It gives the root.
func volumeTree(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "volume")
	outside := filepath.Join(base, "outside")
	writeVolumeFile(t, outside, "secret.txt", "secret")
	writeVolumeFile(t, root, "a-b/x.txt", "x")
	writeVolumeFile(t, root, "a/b.txt", "0123456789")
	writeVolumeFile(t, root, "a0", "zero")
	writeVolumeFile(t, root, ".hidden", "hidden")
	writeVolumeFile(t, root, ".s3b-tmp-0123456789abcdef0123456789abcdef-upload.bin", "part")
	if err := os.Mkdir(filepath.Join(root, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	for link, target := range map[string]string{"link-in": "a", "link-file": "a0", "link-out": outside, "link-dangling": "missing"} {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func volumeInstance(t *testing.T, app *application) (*storageInstance, *volumeBackend) {
	t.Helper()
	instance := app.instances["vol"]
	backend, ok := instance.backend.(*volumeBackend)
	if !ok {
		t.Fatalf("backend = %T", instance.backend)
	}
	return instance, backend
}

func pageKeys(page listPage) []string {
	keys := make([]string, 0, len(page.Prefixes)+len(page.Objects))
	keys = append(keys, page.Prefixes...)
	for _, object := range page.Objects {
		keys = append(keys, object.Key)
	}
	return keys
}

func TestVolumeKeysRefusePathTricks(t *testing.T) {
	t.Parallel()
	for _, key := range []string{"../etc/passwd", "a/../../b", "a//b", "./a", "a/.", "a/\x00b", strings.Repeat("n", 256)} {
		if _, err := parseVolumeKey(key, false); err == nil || !strings.Contains(err.Error(), "a ") {
			t.Fatalf("key %q: error = %v", key, err)
		}
	}
	if _, err := parseVolumeKey("a/\xff.txt", true); err == nil || !strings.Contains(err.Error(), "valid UTF-8") {
		t.Fatalf("a write with a name that is not UTF-8: error = %v", err)
	}
	if _, err := parseVolumeKey("a/\xff.txt", false); err != nil {
		t.Fatalf("a read with a name that is not UTF-8: %v", err)
	}
	if _, err := parseVolumeKey("a/.s3b-tmp-x", true); err == nil || !strings.Contains(err.Error(), "temporary files") {
		t.Fatalf("a write of a temporary name: error = %v", err)
	}
	key, err := parseVolumeKey("a/b/", false)
	if err != nil || !key.folder || !reflect.DeepEqual(key.parts, []string{"a", "b"}) {
		t.Fatalf("folder key = %+v, %v", key, err)
	}
	if name, ok := parseVolumeTempName(".s3b-tmp-0123456789abcdef0123456789abcdef-report.pdf"); !ok || name != "report.pdf" {
		t.Fatalf("temporary name = %q, %v", name, ok)
	}
	for _, name := range []string{".s3b-tmp-0123", ".s3b-tmp-0123456789ABCDEF0123456789abcdef", ".s3b-tmp-0123456789abcdef0123456789abcdef-", "file.txt"} {
		if _, ok := parseVolumeTempName(name); ok {
			t.Fatalf("%q is not a temporary name", name)
		}
	}
}

func TestVolumeListingWithTheDelimiterReadsOneFolderInTheOrderOfS3(t *testing.T) {
	t.Parallel()
	root := volumeTree(t)
	app := volumeTestApplication(t, root, "")
	_, backend := volumeInstance(t, app)
	ctx := context.Background()
	page, err := backend.List(ctx, listOptions{Delimiter: "/"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a-b/", "a/", "empty/", "link-in/"}; !reflect.DeepEqual(page.Prefixes, want) {
		t.Fatalf("prefixes = %v, want %v", page.Prefixes, want)
	}
	objects := map[string]objectInfo{}
	for _, object := range page.Objects {
		objects[object.Key] = object
	}
	if len(objects) != 5 || objects[".hidden"].Size != 6 || objects["a0"].Size != 4 || objects["link-file"].Size != 4 ||
		!objects["link-out"].Unreadable || !objects["link-dangling"].Unreadable || objects["a0"].Unreadable {
		t.Fatalf("objects = %+v", page.Objects)
	}
	if etag := objects["a0"].ETag; !strings.HasPrefix(etag, `W/"4-`) {
		t.Fatalf("ETag = %q", etag)
	}
	// Three keys for each page: the token is the last key, and the pages give each key one time in the order of S3.
	var all []string
	token := ""
	for pages := 0; ; pages++ {
		page, err := backend.List(ctx, listOptions{Delimiter: "/", MaxResults: 3, PageToken: token})
		if err != nil {
			t.Fatal(err)
		}
		keys := pageKeys(page)
		if pages > 5 || len(keys) > 3 {
			t.Fatalf("page %d = %v", pages, keys)
		}
		all = append(all, keys...)
		if token = page.NextPageToken; token == "" {
			break
		}
		if token != keys[len(keys)-1] && token != page.Prefixes[len(page.Prefixes)-1] {
			t.Fatalf("token = %q, page = %v", token, keys)
		}
	}
	want := []string{".hidden", "a-b/", "a/", "a0", "empty/", "link-dangling", "link-file", "link-in/", "link-out"}
	got := append([]string(nil), all...)
	sortStrings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("keys of the pages = %v, want %v", all, want)
	}
	// A symbolic link to a folder in the root is followed.
	page, err = backend.List(ctx, listOptions{Prefix: "link-in/", Delimiter: "/"})
	if err != nil || len(page.Objects) != 1 || page.Objects[0].Key != "link-in/b.txt" {
		t.Fatalf("listing of a link = %+v, %v", page, err)
	}
	// A prefix that does not exist gives an empty page; a link that leaves the root is refused.
	if page, err := backend.List(ctx, listOptions{Prefix: "missing/", Delimiter: "/"}); err != nil || len(pageKeys(page)) != 0 {
		t.Fatalf("missing prefix = %+v, %v", page, err)
	}
	if _, err := backend.List(ctx, listOptions{Prefix: "link-out/", Delimiter: "/"}); err == nil || !strings.Contains(err.Error(), "leaves the volume") {
		t.Fatalf("listing of a link that leaves the root: error = %v", err)
	}
	if _, err := backend.List(ctx, listOptions{Delimiter: "|"}); err == nil {
		t.Fatal("a delimiter other than / is accepted")
	}
}

func sortStrings(values []string) {
	for i := range values {
		for j := i + 1; j < len(values); j++ {
			if values[j] < values[i] {
				values[i], values[j] = values[j], values[i]
			}
		}
	}
}

func TestVolumeListingWithoutTheDelimiterReadsTheTreeInTheOrderOfS3(t *testing.T) {
	t.Parallel()
	root := volumeTree(t)
	writeVolumeFile(t, root, "a/deep/c.txt", "c")
	if err := os.MkdirAll(filepath.Join(root, "a", "deep", "void"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := volumeTestApplication(t, root, "")
	_, backend := volumeInstance(t, app)
	ctx := context.Background()
	want := []string{".hidden", "a-b/x.txt", "a/b.txt", "a/deep/c.txt", "a/deep/void/", "a0", "empty/", "link-file"}
	page, err := backend.List(ctx, listOptions{})
	if err != nil || !reflect.DeepEqual(pageKeys(page), want) || page.NextPageToken != "" {
		t.Fatalf("tree = %v (token %q), %v; want %v", pageKeys(page), page.NextPageToken, err, want)
	}
	for _, object := range page.Objects {
		if object.Key == "empty/" && (object.Size != 0 || object.ContentType != volumeFolderContentType) {
			t.Fatalf("empty folder = %+v", object)
		}
	}
	var all []string
	token := ""
	for pages := 0; pages < 10; pages++ {
		page, err := backend.List(ctx, listOptions{MaxResults: 3, PageToken: token})
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, pageKeys(page)...)
		if token = page.NextPageToken; token == "" {
			break
		}
	}
	if !reflect.DeepEqual(all, want) {
		t.Fatalf("pages = %v, want %v", all, want)
	}
	for prefix, keys := range map[string][]string{
		"a":        {"a-b/x.txt", "a/b.txt", "a/deep/c.txt", "a/deep/void/", "a0"},
		"a/":       {"a/b.txt", "a/deep/c.txt", "a/deep/void/"},
		"empty/":   {"empty/"},
		"a/deep/v": {"a/deep/void/"},
		"missing/": {},
	} {
		page, err := backend.List(ctx, listOptions{Prefix: prefix})
		if got := pageKeys(page); err != nil || !reflect.DeepEqual(got, keys) {
			t.Fatalf("prefix %q = %v, %v; want %v", prefix, got, err, keys)
		}
	}
	page, err = backend.List(ctx, listOptions{StartAfter: "a/b.txt"})
	if got := pageKeys(page); err != nil || !reflect.DeepEqual(got, want[3:]) {
		t.Fatalf("after a/b.txt = %v, %v", got, err)
	}
}

func TestVolumeListingAPIShowsFoldersHiddenFilesAndUnreadableLinks(t *testing.T) {
	t.Parallel()
	app := volumeTestApplication(t, volumeTree(t), "")
	recorder := doJSON(app, http.MethodGet, "/api/list?instance=vol&prefix=", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var response listResponseJSON
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	names := map[string]listItemJSON{}
	for _, item := range response.Items {
		names[item.Name] = item
	}
	for _, name := range []string{"a/", "a-b/", "empty/", "link-in/", ".hidden", "a0", "link-file", "link-out"} {
		if _, ok := names[name]; !ok {
			t.Fatalf("the listing has no %q: %+v", name, response.Items)
		}
	}
	if !names["link-out"].Unreadable || names["a0"].Unreadable || names["a0"].ContentType == "" {
		t.Fatalf("items = %+v", response.Items)
	}
	for name := range names {
		if strings.HasPrefix(name, volumeTempPrefix) {
			t.Fatalf("the listing shows the temporary file %q", name)
		}
	}
}

func TestVolumeReadsHonourRangesAndConditions(t *testing.T) {
	t.Parallel()
	root := volumeTree(t)
	app := volumeTestApplication(t, root, "")
	handler := app.routes()
	request := func(method, key string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "/s3?instance=vol&key="+key, nil)
		for name, value := range headers {
			r.Header.Set(name, value)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, r)
		return recorder
	}
	head := request(http.MethodHead, "a/b.txt", nil)
	if head.Code != http.StatusOK || head.Header().Get("Content-Length") != "10" || !strings.HasPrefix(head.Header().Get("Content-Type"), "text/plain") ||
		!strings.HasPrefix(head.Header().Get("ETag"), `W/"10-`) || head.Header().Get("Last-Modified") == "" || head.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("HEAD = %d %v", head.Code, head.Header())
	}
	etag := head.Header().Get("ETag")
	for _, test := range []struct {
		headers map[string]string
		status  int
		body    string
		rng     string
	}{
		{nil, http.StatusOK, "0123456789", ""},
		{map[string]string{"Range": "bytes=2-4"}, http.StatusPartialContent, "234", "bytes 2-4/10"},
		{map[string]string{"Range": "bytes=-3"}, http.StatusPartialContent, "789", "bytes 7-9/10"},
		{map[string]string{"Range": "bytes=8-"}, http.StatusPartialContent, "89", "bytes 8-9/10"},
		{map[string]string{"Range": "bytes=8-100"}, http.StatusPartialContent, "89", "bytes 8-9/10"},
		{map[string]string{"Range": "bytes=10-"}, http.StatusRequestedRangeNotSatisfiable, "", ""},
		{map[string]string{"Range": "bytes=0-1,4-5"}, http.StatusOK, "0123456789", ""},
		{map[string]string{"If-Match": etag, "Range": "bytes=0-0"}, http.StatusPartialContent, "0", "bytes 0-0/10"},
		{map[string]string{"If-Match": strings.TrimPrefix(etag, "W/")}, http.StatusOK, "0123456789", ""},
		{map[string]string{"If-Match": `W/"10-1"`}, http.StatusPreconditionFailed, "", ""},
		{map[string]string{"If-None-Match": etag}, http.StatusNotModified, "", ""},
		{map[string]string{"If-Range": etag, "Range": "bytes=0-0"}, http.StatusOK, "0123456789", ""},
		{map[string]string{"If-Range": head.Header().Get("Last-Modified"), "Range": "bytes=0-0"}, http.StatusPartialContent, "0", "bytes 0-0/10"},
		{map[string]string{"If-Modified-Since": head.Header().Get("Last-Modified")}, http.StatusNotModified, "", ""},
	} {
		got := request(http.MethodGet, "a/b.txt", test.headers)
		if got.Code != test.status || (test.status < 300 && got.Body.String() != test.body) || got.Header().Get("Content-Range") != test.rng {
			t.Fatalf("GET %v = %d %q %q, want %d %q %q", test.headers, got.Code, got.Body.String(), got.Header().Get("Content-Range"), test.status, test.body, test.rng)
		}
	}
	// The range reader of the previews asks each range with If-Match: the weak ETag matches.
	instance, _ := volumeInstance(t, app)
	source, err := openObjectRangeSource(context.Background(), instance, "a/b.txt")
	if err != nil {
		t.Fatal(err)
	}
	if data, err := source.ReadRange(3, 4); err != nil || string(data) != "3456" {
		t.Fatalf("range source = %q, %v", data, err)
	}
	if data, err := source.ReadRange(8, 4); err != nil || string(data) != "89" {
		t.Fatalf("range source at the end = %q, %v", data, err)
	}
	if got := request(http.MethodGet, "link-file", nil); got.Code != http.StatusOK || got.Body.String() != "zero" {
		t.Fatalf("link to a file in the root = %d %q", got.Code, got.Body.String())
	}
	for _, key := range []string{"link-out", "link-out/secret.txt", "link-dangling"} {
		if got := request(http.MethodGet, key, nil); got.Code != http.StatusForbidden || strings.Contains(got.Body.String(), "secret") {
			t.Fatalf("GET %s = %d %q", key, got.Code, got.Body.String())
		}
	}
	for _, key := range []string{"missing.txt", "a", "a0/x"} {
		if got := request(http.MethodGet, key, nil); got.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d %q", key, got.Code, got.Body.String())
		}
	}
	if got := request(http.MethodHead, "empty/", nil); got.Code != http.StatusOK || got.Header().Get("Content-Length") != "0" {
		t.Fatalf("HEAD of a folder key = %d %v", got.Code, got.Header())
	}
	if got := request(http.MethodGet, "a%2F..%2F..%2Fetc%2Fpasswd", nil); got.Code != http.StatusBadRequest {
		t.Fatalf("GET with .. = %d %q", got.Code, got.Body.String())
	}
	opened := httptest.NewRecorder()
	handler.ServeHTTP(opened, httptest.NewRequest(http.MethodGet, "/open/b.txt?instance=vol&key=a/b.txt", nil))
	if opened.Code != http.StatusOK || opened.Body.String() != "0123456789" {
		t.Fatalf("open original = %d %q", opened.Code, opened.Body.String())
	}
}

func TestVolumeRootPrefixIsTheRootOfTheKeys(t *testing.T) {
	t.Parallel()
	base := t.TempDir()
	writeVolumeFile(t, base, "published/report.txt", "report")
	writeVolumeFile(t, base, "private.txt", "private")
	if err := os.Symlink("../private.txt", filepath.Join(base, "published", "up")); err != nil {
		t.Fatal(err)
	}
	app := volumeTestApplication(t, base, `root_prefix = "published/"`)
	recorder := doJSON(app, http.MethodGet, "/api/list?instance=vol", nil)
	var response listResponseJSON
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || len(response.Items) != 2 {
		t.Fatalf("listing = %s, %v", recorder.Body.String(), err)
	}
	get := httptest.NewRecorder()
	app.routes().ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/s3?instance=vol&key=report.txt", nil))
	if get.Code != http.StatusOK || get.Body.String() != "report" {
		t.Fatalf("GET = %d %q", get.Code, get.Body.String())
	}
	// A link that leaves root_prefix is refused, also when its target is in path.
	up := httptest.NewRecorder()
	app.routes().ServeHTTP(up, httptest.NewRequest(http.MethodGet, "/s3?instance=vol&key=up", nil))
	if up.Code != http.StatusForbidden {
		t.Fatalf("GET of a link out of root_prefix = %d %q", up.Code, up.Body.String())
	}
}

func TestVolumeInstanceHidesTheFeaturesOfS3(t *testing.T) {
	t.Parallel()
	app := volumeTestApplication(t, volumeTree(t), "")
	recorder := doJSON(app, http.MethodGet, "/api/instances", nil)
	var response struct {
		Instances []map[string]any `json:"instances"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || len(response.Instances) != 1 {
		t.Fatalf("instances = %s, %v", recorder.Body.String(), err)
	}
	info := response.Instances[0]
	for name, want := range map[string]any{
		"id": "vol", "host": volumeHostID, "provider": providerVolume, "versioningSupported": false, "tagsSupported": false,
		"metadataEditSupported": false, "lifecycleSupported": false, "objectLockSupported": false,
		"bucketEncryptionSupported": false, "multipartUploadsSupported": true, "usageSupported": volumeUsageSupported,
		"versioningState": "off",
	} {
		if info[name] != want {
			t.Fatalf("%s = %v, want %v (%v)", name, info[name], want, info)
		}
	}
	capabilities := info["capabilities"].(map[string]any)
	for _, name := range []string{"read", "write", "delete"} {
		state := capabilities[name].(map[string]any)
		if state["state"] != capabilityAllowed || state["verified"] != true {
			t.Fatalf("%s = %v", name, state)
		}
	}
	page := httptest.NewRecorder()
	app.routes().ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/-/volume/vol/", nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("page of the volume = %d %v", page.Code, page.Header())
	}
	other := httptest.NewRecorder()
	app.routes().ServeHTTP(other, httptest.NewRequest(http.MethodGet, "/-/other/vol/", nil))
	if other.Code == http.StatusOK {
		t.Fatalf("an other host word gives the page of the volume")
	}
}

func TestVolumeUsageIsTheSizeOfTheFileSystem(t *testing.T) {
	t.Parallel()
	reader := &volumeUsageReader{root: "/x", statfs: func(string) (uint64, uint64, error) { return 1000, 40, nil }}
	value, err := reader.BucketUsage(context.Background(), "")
	if err != nil || value.UsedBytes != 960 || value.LimitBytes != 1000 || value.UsedObjects != -1 || value.LimitObjects != 0 || value.Approximate {
		t.Fatalf("usage = %+v, %v", value, err)
	}
	app := volumeTestApplication(t, t.TempDir(), "")
	instance, _ := volumeInstance(t, app)
	instance.usage.reader = reader
	value.Source = usageSourceStatfs
	answer := usageAnswer(instance, value)
	if answer.Percent != 96 || answer.Level != "error" || answer.LimitSource != "provider" || answer.Approximate {
		t.Fatalf("answer = %+v", answer)
	}
	failing := &volumeUsageReader{root: "/x", statfs: func(string) (uint64, uint64, error) { return 0, 0, os.ErrPermission }}
	if _, err := failing.BucketUsage(context.Background(), ""); err == nil || strings.Contains(err.Error(), "/x") {
		t.Fatalf("error = %v", err)
	}
	if !volumeUsageSupported {
		return
	}
	real := volumeTestApplication(t, t.TempDir(), "")
	recorder := doJSON(real, http.MethodGet, "/api/usage?instance=vol", nil)
	var response usageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || !response.Supported || !response.Available ||
		response.Source != usageSourceStatfs || response.LimitBytes <= 0 || response.UsedBytes < 0 || response.UsedBytes > response.LimitBytes {
		t.Fatalf("usage = %s, %v", recorder.Body.String(), err)
	}
}

func TestVolumeReaderClosesTheFile(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeVolumeFile(t, root, "f.txt", "content")
	app := volumeTestApplication(t, root, "")
	_, backend := volumeInstance(t, app)
	response, err := backend.Get(context.Background(), "f.txt", http.Header{"Range": {"bytes=1-3"}})
	if err != nil || response.StatusCode != http.StatusPartialContent {
		t.Fatalf("get = %+v, %v", response, err)
	}
	data, _ := io.ReadAll(response.Body)
	if string(data) != "ont" {
		t.Fatalf("body = %q", data)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := response.Body.Read(make([]byte, 1)); err == nil {
		t.Fatal("the file is still open after Close")
	}
}
