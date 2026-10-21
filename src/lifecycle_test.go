package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLifecycleS3 keeps the lifecycle configuration of one bucket as bytes. server is the Server header of each
// answer: "" with garage true gives the answers of Garage v2.4.1. keep changes a written document before the fake
// keeps it, as a provider that drops a setting. refuse is the status of a refused write.
type fakeLifecycleS3 struct {
	t          *testing.T
	mu         sync.Mutex
	body       []byte
	server     string
	garage     bool
	versioning string
	keep       func([]byte) []byte
	refuse     int
	lifecycle  int // the status of a read of the configuration, when it is not 0
	puts       [][]byte
	deletes    int
}

func newFakeLifecycleS3(t *testing.T, server string, body string) (*fakeLifecycleS3, *httptest.Server) {
	fake := &fakeLifecycleS3{t: t, server: server, versioning: "Enabled"}
	if body != "" {
		fake.body = []byte(body)
	}
	httpServer := httptest.NewServer(fake)
	t.Cleanup(httpServer.Close)
	return fake, httpServer
}

func (f *fakeLifecycleS3) fail(w http.ResponseWriter, status int, code string) {
	w.WriteHeader(status)
	if f.garage {
		_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>`+code+`</Code><Message>no</Message><Resource>/bucket</Resource><Region>garage</Region></Error>`)
		return
	}
	_, _ = io.WriteString(w, `<Error><Code>`+code+`</Code><Message>no</Message><RequestId>1</RequestId></Error>`)
}

func (f *fakeLifecycleS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.server != "" {
		w.Header().Set("Server", f.server)
		w.Header().Set("x-amz-request-id", "1")
	}
	query := r.URL.Query()
	switch {
	case r.URL.Path == "/bucket" && query.Has("lifecycle") && r.Method == http.MethodGet:
		switch {
		case f.lifecycle != 0:
			f.fail(w, f.lifecycle, "NotImplemented")
		case f.body == nil:
			f.fail(w, http.StatusNotFound, "NoSuchLifecycleConfiguration")
		default:
			_, _ = w.Write(f.body)
		}
	case r.URL.Path == "/bucket" && query.Has("lifecycle") && r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		sum := md5.Sum(body)
		if r.Header.Get("Content-MD5") != base64.StdEncoding.EncodeToString(sum[:]) {
			f.t.Errorf("Content-MD5 = %q", r.Header.Get("Content-MD5"))
		}
		f.puts = append(f.puts, body)
		if f.refuse != 0 {
			f.fail(w, f.refuse, map[int]string{http.StatusForbidden: "AccessDenied", http.StatusNotImplemented: "NotImplemented", http.StatusBadRequest: "InvalidArgument"}[f.refuse])
			return
		}
		if f.keep != nil {
			body = f.keep(body)
		}
		f.body = body
	case r.URL.Path == "/bucket" && query.Has("lifecycle") && r.Method == http.MethodDelete:
		f.deletes++
		f.body = nil
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/bucket" && query.Has("versioning") && r.Method == http.MethodGet:
		_, _ = io.WriteString(w, `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>`+f.versioning+`</Status></VersioningConfiguration>`)
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/"+lifecycleFlavourProbeKey):
		f.fail(w, http.StatusNotFound, "NoSuchKey")
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL)
		w.WriteHeader(http.StatusBadRequest)
	}
}

func (f *fakeLifecycleS3) stored() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.body)
}

func (f *fakeLifecycleS3) setStored(body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.body = []byte(body)
}

// lifecycleApplication gives the test application with the fake behind the instance "rw" (root prefix tenant/) and the
// instance "readonly". The two instances have versioning and tags.
func lifecycleApplication(t *testing.T, server, body string) (*application, *fakeLifecycleS3) {
	t.Helper()
	app, _, _ := testApplication(t)
	fake, httpServer := newFakeLifecycleS3(t, server, body)
	for _, id := range []string{"rw", "readonly"} {
		app.instances[id].backend = newAnonymousS3BackendForTest(t, httpServer.URL, "bucket")
		app.instances[id].setVersioningAvailable(true)
	}
	return app, fake
}

func getLifecycle(t *testing.T, app *application, instance string) lifecycleResponse {
	t.Helper()
	recorder := doJSON(app, http.MethodGet, "/api/lifecycle?instance="+instance, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("get = %d %s", recorder.Code, recorder.Body.String())
	}
	var response lifecycleResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Editor == nil {
		t.Fatal("the answer has no editor")
	}
	return response
}

func putLifecycle(app *application, instance, hash string, rules []lifecycleEditRule) *httptest.ResponseRecorder {
	return doJSON(app, http.MethodPut, "/api/lifecycle", lifecycleRequest{Instance: instance, Hash: hash, Rules: rules})
}

func decodeLifecycle(t *testing.T, recorder *httptest.ResponseRecorder) lifecycleResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var response lifecycleResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func errorCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &payload)
	return payload.Error.Code
}

const keptTransition = `<Rule>
    <ID>to-cold</ID><Status>Enabled</Status>
    <Filter><And><Prefix>tenant/archive/</Prefix><ObjectSizeGreaterThan>1024</ObjectSizeGreaterThan></And></Filter>
    <Transition><Days>30</Days><StorageClass>GLACIER</StorageClass></Transition>
  </Rule>`

const keptOutside = `<Rule><ID>other-tenant</ID><Filter><Prefix>other/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>`

const editableLogs = `<Rule><ID>logs</ID><Filter><Prefix>tenant/logs/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule>`

func TestLifecycleSaveKeepsTheOtherRulesByteForByte(t *testing.T) {
	document := `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  ` + keptTransition + `
  ` + editableLogs + `
  ` + keptOutside + `
  <FutureElement a="1">kept</FutureElement>
</LifecycleConfiguration>`
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", document)
	response := getLifecycle(t, app, "rw")
	editor := response.Editor
	if editor.Hash != lifecycleHash([]byte(document), []int{1}) || editor.Provider != flavourSeaweedFS || !editor.Writable || editor.RootPrefix != "tenant/" {
		t.Fatalf("editor = %+v", editor)
	}
	if len(editor.Entries) != 3 || len(response.Rules) != 3 {
		t.Fatalf("entries = %+v, rules = %+v", editor.Entries, response.Rules)
	}
	if entry := editor.Entries[0]; entry.Editable || entry.XML != keptTransition || entry.Reason != "It moves objects to another storage class." {
		t.Fatalf("first entry = %+v", entry)
	}
	if entry := editor.Entries[1]; !entry.Editable || *entry.Rule != (lifecycleEditRule{ID: "logs", Enabled: true, Prefix: "logs/", ExpirationDays: 30}) {
		t.Fatalf("second entry = %+v", entry)
	}
	if entry := editor.Entries[2]; entry.Editable || entry.Reason != "It applies outside of the folder of this instance." {
		t.Fatalf("third entry = %+v", entry)
	}
	for _, field := range lifecycleFields {
		if !editor.Fields[field] {
			t.Fatalf("SeaweedFS with versioning and tags offers %s: %+v", field, editor.Hidden)
		}
	}
	rules := []lifecycleEditRule{
		{ID: "logs", Enabled: false, Prefix: "logs/", Tag: &objectTag{"retention", "30d"}, ExpirationDays: 10, NoncurrentDays: 5},
		{ID: "uploads", Enabled: true, Prefix: "tmp/<a&b>", AbortMultipartDays: 3},
	}
	saved := decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, rules))
	if len(saved.Warnings) != 0 {
		t.Fatalf("warnings = %v", saved.Warnings)
	}
	written := fake.stored()
	if !strings.HasPrefix(written, `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`) || !strings.HasSuffix(written, "</LifecycleConfiguration>") {
		t.Fatalf("root of the written document: %s", written)
	}
	for _, kept := range []string{keptTransition, keptOutside, `<FutureElement a="1">kept</FutureElement>`} {
		if strings.Count(written, kept) != 1 {
			t.Fatalf("the written document does not keep %q byte for byte:\n%s", kept, written)
		}
	}
	for _, part := range []string{
		`<Rule><ID>logs</ID><Filter><And><Prefix>tenant/logs/</Prefix><Tag><Key>retention</Key><Value>30d</Value></Tag></And></Filter><Status>Disabled</Status><Expiration><Days>10</Days></Expiration><NoncurrentVersionExpiration><NoncurrentDays>5</NoncurrentDays></NoncurrentVersionExpiration></Rule>`,
		`<Rule><ID>uploads</ID><Filter><Prefix>tenant/tmp/&lt;a&amp;b&gt;</Prefix></Filter><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>3</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>`,
	} {
		if !strings.Contains(written, part) {
			t.Fatalf("the written document has no %s:\n%s", part, written)
		}
	}
	if strings.Count(written, "<ID>logs</ID>") != 1 {
		t.Fatalf("the edited rule is twice in the document:\n%s", written)
	}
	if saved.Editor.Hash != lifecycleHash([]byte(written), []int{0, 1}) || len(saved.Editor.Entries) != 4 {
		t.Fatalf("saved editor = %+v", saved.Editor)
	}
	if got := saved.Editor.Entries[1].Rule; got == nil || got.Prefix != "tmp/<a&b>" || got.AbortMultipartDays != 3 {
		t.Fatalf("saved entries = %+v", saved.Editor.Entries)
	}
}

func TestLifecycleSaveRefusesAConfigurationThatChangedAfterTheRead(t *testing.T) {
	app, fake := lifecycleApplication(t, "MinIO", `<LifecycleConfiguration>`+editableLogs+`</LifecycleConfiguration>`)
	hash := getLifecycle(t, app, "rw").Editor.Hash
	fake.setStored(`<LifecycleConfiguration>` + editableLogs + keptOutside + `</LifecycleConfiguration>`)
	recorder := putLifecycle(app, "rw", hash, []lifecycleEditRule{{ID: "logs", Enabled: true, Prefix: "logs/", ExpirationDays: 7}})
	if recorder.Code != http.StatusConflict || errorCode(t, recorder) != "lifecycle_changed" {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if len(fake.puts) != 0 || fake.deletes != 0 {
		t.Fatalf("the refused save wrote: %v", fake.puts)
	}
	// The page reads the rules again: the new hash works.
	hash = getLifecycle(t, app, "rw").Editor.Hash
	decodeLifecycle(t, putLifecycle(app, "rw", hash, []lifecycleEditRule{{ID: "logs", Enabled: true, Prefix: "logs/", ExpirationDays: 7}}))
	if !strings.Contains(fake.stored(), keptOutside) || !strings.Contains(fake.stored(), "<Days>7</Days>") {
		t.Fatalf("stored = %s", fake.stored())
	}
	// A hash that is not a hash is refused before any read.
	if recorder := putLifecycle(app, "rw", "abc", nil); recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
}

// dropTags removes the tag filters of a written document, as Garage v2.4.1 does: <And> with a prefix and a tag
// becomes the prefix, and a filter with a tag only disappears.
func dropTags(body []byte) []byte {
	text := regexp.MustCompile(`<And>(<Prefix>[^<]*</Prefix>)<Tag>.*?</Tag></And>`).ReplaceAllString(string(body), "$1")
	text = regexp.MustCompile(`<Filter><Tag>.*?</Tag></Filter>`).ReplaceAllString(text, "")
	return []byte(text)
}

func TestLifecycleSaveTellsWhatTheProviderDropped(t *testing.T) {
	// A provider that S3-Browser does not know. A rule of the bucket uses a tag filter, so the editor offers it.
	tagged := `<Rule><ID>tagged</ID><Filter><And><Prefix>tenant/logs/</Prefix><Tag><Key>retention</Key><Value>30d</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule>`
	app, fake := lifecycleApplication(t, "", `<LifecycleConfiguration>`+tagged+`</LifecycleConfiguration>`)
	fake.keep = dropTags
	editor := getLifecycle(t, app, "rw").Editor
	if editor.Provider != "" || !editor.Fields[lifecycleFieldTag] || editor.Fields[lifecycleFieldAbort] || editor.Fields[lifecycleFieldNoncurrent] {
		t.Fatalf("fields of an unknown provider = %+v %+v", editor.Fields, editor.Hidden)
	}
	rules := []lifecycleEditRule{
		{ID: "tagged", Enabled: true, Prefix: "logs/", Tag: &objectTag{"retention", "30d"}, ExpirationDays: 30},
		{ID: "only-tag", Enabled: true, Prefix: "", Tag: &objectTag{"tmp", "yes"}, ExpirationDays: 2},
	}
	saved := decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, rules))
	joined := strings.Join(saved.Warnings, "\n")
	if len(saved.Warnings) != 2 ||
		!strings.Contains(joined, `The storage provider dropped the tag filter retention=30d of the rule "tagged". The rule now applies to every object under tenant/logs/`) ||
		!strings.Contains(joined, `The storage provider dropped the tag filter tmp=yes of the rule "only-tag". The rule now applies to every object under tenant/:`) {
		t.Fatalf("warnings = %v", saved.Warnings)
	}
	// The field is no longer offered, with the reason, and a save with it is refused.
	if saved.Editor.Fields[lifecycleFieldTag] || !strings.Contains(saved.Editor.Hidden[0].Reason, "dropped this setting") {
		t.Fatalf("fields after the save = %+v %+v", saved.Editor.Fields, saved.Editor.Hidden)
	}
	recorder := putLifecycle(app, "rw", saved.Editor.Hash, rules)
	if recorder.Code != http.StatusBadRequest || errorCode(t, recorder) != "lifecycle_field_unsupported" {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestLifecycleSaveTellsAboutADroppedActionAndAMissingRule(t *testing.T) {
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", "")
	fake.keep = func(body []byte) []byte {
		text := regexp.MustCompile(`<AbortIncompleteMultipartUpload>.*?</AbortIncompleteMultipartUpload>`).ReplaceAllString(string(body), "")
		return []byte(regexp.MustCompile(`<Rule><ID>gone</ID>.*?</Rule>`).ReplaceAllString(text, ""))
	}
	editor := getLifecycle(t, app, "rw").Editor
	if editor.Hash != lifecycleHash(nil, nil) || len(editor.Entries) != 0 {
		t.Fatalf("editor of a bucket without rules = %+v", editor)
	}
	saved := decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{
		{ID: "both", Enabled: true, Prefix: "a/", ExpirationDays: 3, AbortMultipartDays: 2},
		{ID: "gone", Enabled: true, Prefix: "b/", ExpirationDays: 4},
	}))
	if len(saved.Warnings) != 2 || saved.Warnings[0] != `The storage provider dropped the abort of incomplete multipart uploads of the rule "both".` ||
		saved.Warnings[1] != `The storage provider did not keep the rule "gone".` {
		t.Fatalf("warnings = %v", saved.Warnings)
	}
	if saved.Editor.Fields[lifecycleFieldAbort] {
		t.Fatal("the dropped field is still offered")
	}
}

func TestLifecycleFieldsFollowTheProviderTheVersioningAndTheTags(t *testing.T) {
	for name, test := range map[string]struct {
		server     string
		garage     bool
		versioning string
		tagsOff    bool
		provider   string
		want       []string
	}{
		"aws":                  {server: "AmazonS3", versioning: "Enabled", provider: flavourAWS, want: lifecycleFields},
		"seaweedfs":            {server: "SeaweedFS 30GB 4.41", versioning: "Suspended", provider: flavourSeaweedFS, want: lifecycleFields},
		"minio":                {server: "MinIO", versioning: "Enabled", provider: flavourMinIO, want: []string{lifecycleFieldTag, lifecycleFieldNoncurrent, lifecycleFieldDeleteMarker}},
		"garage":               {garage: true, versioning: "", provider: flavourGarage, want: []string{lifecycleFieldAbort}},
		"unknown":              {server: "", versioning: "Enabled", provider: "", want: nil},
		"minio, no versioning": {server: "MinIO", versioning: "", provider: flavourMinIO, want: []string{lifecycleFieldTag}},
		"aws, no tags":         {server: "AmazonS3", versioning: "Enabled", tagsOff: true, provider: flavourAWS, want: []string{lifecycleFieldNoncurrent, lifecycleFieldAbort, lifecycleFieldDeleteMarker}},
	} {
		test := test
		t.Run(name, func(t *testing.T) {
			app, fake := lifecycleApplication(t, test.server, "")
			fake.garage, fake.versioning = test.garage, test.versioning
			app.instances["rw"].tagsOff.Store(test.tagsOff)
			editor := getLifecycle(t, app, "rw").Editor
			if editor.Provider != test.provider {
				t.Fatalf("provider = %q, want %q", editor.Provider, test.provider)
			}
			for _, field := range lifecycleFields {
				if editor.Fields[field] != containsString(test.want, field) {
					t.Fatalf("fields = %v, hidden = %+v, want %v", editor.Fields, editor.Hidden, test.want)
				}
			}
			if len(editor.Hidden) != len(lifecycleFields)-len(test.want) {
				t.Fatalf("hidden = %+v", editor.Hidden)
			}
		})
	}
	// MinIO: a rule with the abort of incomplete uploads is refused before the write, with the reason.
	app, fake := lifecycleApplication(t, "MinIO", "")
	editor := getLifecycle(t, app, "rw").Editor
	recorder := putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{{ID: "abort", Enabled: true, AbortMultipartDays: 3}})
	if recorder.Code != http.StatusBadRequest || errorCode(t, recorder) != "lifecycle_field_unsupported" || !strings.Contains(recorder.Body.String(), "MinIO does not keep") {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if len(fake.puts) != 0 {
		t.Fatal("the refused rule was written")
	}
}

func TestLifecycleRuleOfAFieldThatIsNotOfferedIsKeptAsIs(t *testing.T) {
	abort := `<Rule><ID>abort</ID><Filter><Prefix>tenant/</Prefix></Filter><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>2</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>`
	app, fake := lifecycleApplication(t, "MinIO", `<LifecycleConfiguration>`+abort+editableLogs+`</LifecycleConfiguration>`)
	editor := getLifecycle(t, app, "rw").Editor
	if editor.Entries[0].Editable || editor.Entries[0].Reason != "It uses the abort of incomplete multipart uploads, which the editor does not offer here." || !editor.Entries[1].Editable {
		t.Fatalf("entries = %+v", editor.Entries)
	}
	decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{}))
	if fake.stored() != `<LifecycleConfiguration>`+abort+`</LifecycleConfiguration>` {
		t.Fatalf("stored = %s", fake.stored())
	}
}

func TestLifecycleSaveWithoutRulesDeletesTheConfiguration(t *testing.T) {
	app, fake := lifecycleApplication(t, "MinIO", `<LifecycleConfiguration>`+editableLogs+`</LifecycleConfiguration>`)
	editor := getLifecycle(t, app, "rw").Editor
	saved := decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, nil))
	if fake.deletes != 1 || len(fake.puts) != 0 || fake.stored() != "" || len(saved.Editor.Entries) != 0 || len(saved.Warnings) != 0 {
		t.Fatalf("deletes = %d, puts = %d, saved = %+v", fake.deletes, len(fake.puts), saved)
	}
}

func TestLifecycleWriteRefusalMakesTheEditorReadOnly(t *testing.T) {
	for _, test := range []struct {
		status int
		code   string
		reason string
	}{
		{http.StatusForbidden, "lifecycle_write_denied", "The storage provider refused the change (HTTP 403 AccessDenied): the credentials of this instance cannot change the lifecycle rules."},
		{http.StatusNotImplemented, "lifecycle_write_unsupported", "The storage provider does not let S3-Browser change the lifecycle rules (HTTP 501 NotImplemented)."},
	} {
		app, fake := lifecycleApplication(t, "AmazonS3", "")
		fake.refuse = test.status
		editor := getLifecycle(t, app, "rw").Editor
		recorder := putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{{ID: "a", Enabled: true, ExpirationDays: 1}})
		if recorder.Code != test.status || errorCode(t, recorder) != test.code {
			t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
		}
		after := getLifecycle(t, app, "rw").Editor
		if after.Writable || !strings.HasPrefix(after.ReadOnlyReason, test.reason) {
			t.Fatalf("editor after a refusal = %+v", after)
		}
		// A write that works clears the refusal.
		fake.refuse = 0
		decodeLifecycle(t, putLifecycle(app, "rw", after.Hash, []lifecycleEditRule{{ID: "a", Enabled: true, ExpirationDays: 1}}))
		if !getLifecycle(t, app, "rw").Editor.Writable {
			t.Fatal("the editor stayed read only after a write")
		}
	}
	// A refusal of the rules (400) does not change the editor.
	app, fake := lifecycleApplication(t, "AmazonS3", "")
	fake.refuse = http.StatusBadRequest
	editor := getLifecycle(t, app, "rw").Editor
	recorder := putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{{ID: "a", Enabled: true, ExpirationDays: 1}})
	if recorder.Code != http.StatusBadRequest || errorCode(t, recorder) != "lifecycle_refused" || !getLifecycle(t, app, "rw").Editor.Writable {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestLifecycleOfAnInstanceWithoutTheWritePermissionIsReadOnly(t *testing.T) {
	app, fake := lifecycleApplication(t, "MinIO", `<LifecycleConfiguration>`+editableLogs+`</LifecycleConfiguration>`)
	editor := getLifecycle(t, app, "readonly").Editor
	if editor.Writable || editor.ReadOnlyReason != "This instance has no write permission." || editor.RootPrefix != "" {
		t.Fatalf("editor = %+v", editor)
	}
	recorder := putLifecycle(app, "readonly", editor.Hash, nil)
	if recorder.Code != http.StatusForbidden || len(fake.puts) != 0 || fake.deletes != 0 {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestLifecycleRulesOfASaveAreChecked(t *testing.T) {
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", `<LifecycleConfiguration>`+keptOutside+`</LifecycleConfiguration>`)
	editor := getLifecycle(t, app, "rw").Editor
	tag := &objectTag{"k", "v"}
	for name, test := range map[string]struct {
		rules []lifecycleEditRule
		want  string
	}{
		"no ID":                       {[]lifecycleEditRule{{Enabled: true, ExpirationDays: 1}}, "each rule needs an ID"},
		"no action":                   {[]lifecycleEditRule{{ID: "a", Enabled: true}}, "has no action"},
		"ID of a kept rule":           {[]lifecycleEditRule{{ID: "other-tenant", Enabled: true, ExpirationDays: 1}}, "is on more than one rule"},
		"ID twice":                    {[]lifecycleEditRule{{ID: "a", ExpirationDays: 1}, {ID: "a", ExpirationDays: 2}}, "is on more than one rule"},
		"days out of range":           {[]lifecycleEditRule{{ID: "a", ExpirationDays: maxLifecycleDays + 1}}, "whole number from 1 to 36500"},
		"negative days":               {[]lifecycleEditRule{{ID: "a", NoncurrentDays: -1, ExpirationDays: 1}}, "whole number from 1 to 36500"},
		"days and delete markers":     {[]lifecycleEditRule{{ID: "a", ExpirationDays: 1, ExpiredDeleteMarker: true}}, "use two rules"},
		"tag and abort":               {[]lifecycleEditRule{{ID: "a", Tag: tag, ExpirationDays: 1, AbortMultipartDays: 1}}, "has a tag filter"},
		"tag and delete markers":      {[]lifecycleEditRule{{ID: "a", Tag: tag, ExpiredDeleteMarker: true}}, "has a tag filter"},
		"reserved tag":                {[]lifecycleEditRule{{ID: "a", Tag: &objectTag{"aws:x", "v"}, ExpirationDays: 1}}, "reserved prefix aws:"},
		"control character in prefix": {[]lifecycleEditRule{{ID: "a", Prefix: "a\nb", ExpirationDays: 1}}, "control character"},
		"space around the ID":         {[]lifecycleEditRule{{ID: " a", ExpirationDays: 1}}, "starts or ends with a space"},
		"long ID":                     {[]lifecycleEditRule{{ID: strings.Repeat("i", maxLifecycleIDChars+1), ExpirationDays: 1}}, "at most 255 characters"},
	} {
		recorder := putLifecycle(app, "rw", editor.Hash, test.rules)
		if recorder.Code != http.StatusBadRequest || errorCode(t, recorder) != "invalid_lifecycle" || !strings.Contains(recorder.Body.String(), test.want) {
			t.Errorf("%s: status = %d %s", name, recorder.Code, recorder.Body.String())
		}
	}
	if len(fake.puts) != 0 {
		t.Fatalf("a refused rule was written: %s", fake.puts)
	}
}

func TestProbeLifecycleHidesTheEditorOfAProviderWithoutIt(t *testing.T) {
	app, fake := lifecycleApplication(t, "", "")
	fake.garage = true
	instance := app.instances["rw"]
	instance.probeLifecycle(context.Background())
	if !instance.lifecycle.flavourKnown || !instance.publicInfo().Lifecycle || instance.lifecycleFlavour(context.Background()) != flavourGarage {
		t.Fatal("the probe of Garage must keep the editor and find Garage")
	}
	fake.lifecycle = http.StatusNotImplemented
	other, _ := lifecycleApplication(t, "", "")
	other.instances["rw"].backend = instance.backend
	other.instances["rw"].probeLifecycle(context.Background())
	if other.instances["rw"].publicInfo().Lifecycle {
		t.Fatal("a provider that answers 501 has no lifecycle")
	}
	if recorder := doJSON(other, http.MethodGet, "/api/lifecycle?instance=rw", nil); recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if _, ok := any(&gcsBackend{}).(BucketLifecycleReader); ok {
		t.Fatal("the GCS backend must answer unsupported")
	}
	if _, ok := any(&gcsBackend{}).(BucketLifecycleWriter); ok {
		t.Fatal("the GCS backend must answer unsupported")
	}
}

func TestInstancesGiveTheVersioningAndTheNumberOfLifecycleRules(t *testing.T) {
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", `<LifecycleConfiguration>`+keptOutside+keptTransition+`</LifecycleConfiguration>`)
	fake.versioning = "Suspended"
	instance := app.instances["rw"]
	// No read in the background until the test asks for it.
	instance.markBucketFactsRead()
	// Before a read, the server tells nothing.
	if info := instance.publicInfo(); info.VersioningState != "" || info.LifecycleRules != nil {
		t.Fatalf("info before a read = %+v", info)
	}
	instance.probeLifecycle(context.Background())
	if count := instance.publicInfo().LifecycleRules; count == nil || *count != 2 {
		t.Fatalf("rules after the probe = %v", count)
	}
	// A read of the editor gives the versioning, and a later change of the rules gives the new count.
	_ = getLifecycle(t, app, "rw")
	recorder := doJSON(app, http.MethodGet, "/api/instances", nil)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"versioningState":"suspended"`) || !strings.Contains(recorder.Body.String(), `"lifecycleRules":2`) {
		t.Fatalf("instances = %d %s", recorder.Code, recorder.Body.String())
	}
	fake.mu.Lock()
	fake.body = []byte(`<LifecycleConfiguration>` + keptOutside + `</LifecycleConfiguration>`)
	fake.versioning = "Enabled"
	fake.mu.Unlock()
	_ = getLifecycle(t, app, "rw")
	if count := instance.publicInfo().LifecycleRules; count == nil || *count != 1 {
		t.Fatalf("rules after a new read = %v", count)
	}
	// A change outside S3-Browser: a request of /api/instances reads the facts again in the background, after
	// bucketFactsTTL, one time.
	fake.mu.Lock()
	fake.body = nil
	fake.versioning = "Suspended"
	fake.mu.Unlock()
	instance.markBucketFactsRead()
	_ = doJSON(app, http.MethodGet, "/api/instances", nil)
	if count := instance.publicInfo().LifecycleRules; *count != 1 {
		t.Fatalf("a recent read must not run again: %d", *count)
	}
	instance.facts.mu.Lock()
	instance.facts.at = time.Now().Add(-2 * bucketFactsTTL)
	instance.facts.mu.Unlock()
	_ = doJSON(app, http.MethodGet, "/api/instances", nil)
	deadline := time.Now().Add(5 * time.Second)
	for {
		count := instance.publicInfo().LifecycleRules
		if *count == 0 && instance.versioningState() == "suspended" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the background read gave %d rules and %q", *count, instance.versioningState())
		}
		time.Sleep(20 * time.Millisecond)
	}
	for status, want := range map[string]string{"Enabled": "enabled", "Suspended": "suspended", "": "off"} {
		instance.setVersioningStatus(status)
		if got := instance.versioningState(); got != want {
			t.Errorf("status %q gives %q, want %q", status, got, want)
		}
	}
	// A provider without versions is off, and an instance without lifecycle rules gives no count.
	instance.setVersioningAvailable(false)
	instance.lifecycle.off.Store(true)
	if info := instance.publicInfo(); info.VersioningState != "off" || info.LifecycleRules != nil {
		t.Fatalf("info without versions and rules = %+v", info)
	}
}

func TestS3ProviderFlavourFromTheAnswer(t *testing.T) {
	endpoint, _ := url.Parse("http://storage.local:9000")
	aws, _ := url.Parse("https://s3.eu-west-1.amazonaws.com")
	garageError := []byte(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>Key not found</Message><Resource>/b/k</Resource><Region>garage</Region></Error>`)
	awsError := []byte(`<Error><Code>NoSuchKey</Code><Message>no</Message><RequestId>1</RequestId><HostId>2</HostId></Error>`)
	for _, test := range []struct {
		endpoint *url.URL
		header   http.Header
		body     []byte
		want     string
	}{
		{aws, http.Header{}, nil, flavourAWS},
		{endpoint, http.Header{"Server": {"AmazonS3"}}, awsError, flavourAWS},
		{endpoint, http.Header{"Server": {"MinIO"}}, awsError, flavourMinIO},
		{endpoint, http.Header{"Server": {"SeaweedFS 30GB 4.41"}}, awsError, flavourSeaweedFS},
		{endpoint, http.Header{}, garageError, flavourGarage},
		{endpoint, http.Header{"X-Amz-Request-Id": {"1"}}, garageError, ""},
		{endpoint, http.Header{"Server": {"nginx"}}, garageError, ""},
		{endpoint, http.Header{}, awsError, ""},
		{endpoint, http.Header{}, []byte("not xml"), ""},
	} {
		if got := s3ProviderFlavour(test.endpoint, test.header, test.body); got != test.want {
			t.Errorf("flavour(%v, %s) = %q, want %q", test.header, test.body, got, test.want)
		}
	}
}

func TestSplitLifecycleDocumentKeepsTheBytesOfEachElement(t *testing.T) {
	document := "<?xml version=\"1.0\"?>\n<!-- a comment -->\n<LifecycleConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\n" +
		"<Rule><ID>a</ID><Filter/><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>  <Rule><ID>b &amp; c</ID></Rule>\n</LifecycleConfiguration>\n"
	config, err := splitLifecycleDocument([]byte(document))
	if err != nil {
		t.Fatal(err)
	}
	if string(config.RootStart) != `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` || config.RootName != "LifecycleConfiguration" || len(config.Items) != 2 {
		t.Fatalf("config = %+v", config)
	}
	if string(config.Items[0].Raw) != `<Rule><ID>a</ID><Filter/><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>` ||
		string(config.Items[1].Raw) != `<Rule><ID>b &amp; c</ID></Rule>` || config.Items[1].Node.child("ID").Text != "b & c" {
		t.Fatalf("items = %q, %q", config.Items[0].Raw, config.Items[1].Raw)
	}
	// An empty filter is a rule of the whole bucket that the editor shows.
	rule, reason := lifecycleEditRuleFromNode(config.Items[0].Node, "")
	if reason != "" || rule != (lifecycleEditRule{ID: "a", Enabled: true, ExpirationDays: 1}) {
		t.Fatalf("rule = %+v, reason = %q", rule, reason)
	}
	for _, invalid := range []string{"<LifecycleConfiguration><Rule>", "<Other/>", "not xml"} {
		if _, err := splitLifecycleDocument([]byte(invalid)); err == nil {
			t.Errorf("%q was accepted", invalid)
		}
	}
	if config, err := splitLifecycleDocument([]byte("<LifecycleConfiguration/>")); err != nil || len(config.Items) != 0 {
		t.Fatalf("empty root: %+v, %v", config, err)
	}
	// The same rule with the children in another order and other spaces has the same canonical form (MinIO).
	left, _ := splitLifecycleDocument([]byte(`<LifecycleConfiguration><Rule><ID>x</ID><Filter><And><Prefix>p/</Prefix><ObjectSizeGreaterThan>1</ObjectSizeGreaterThan></And></Filter></Rule></LifecycleConfiguration>`))
	right, _ := splitLifecycleDocument([]byte("<LifecycleConfiguration xmlns=\"" + lifecycleNamespace + "\"><Rule>\n <Filter><And><ObjectSizeGreaterThan>1</ObjectSizeGreaterThan><Prefix>p/</Prefix></And></Filter><ID>x</ID></Rule></LifecycleConfiguration>"))
	if left.Items[0].Node.canonical() != right.Items[0].Node.canonical() {
		t.Fatal("the canonical forms differ")
	}
	if !bytes.Equal(lifecycleRuleXML(lifecycleEditRule{ID: "t", Enabled: true, Tag: &objectTag{"k", "v"}, ExpirationDays: 2}, ""),
		[]byte(`<Rule><ID>t</ID><Filter><Tag><Key>k</Key><Value>v</Value></Tag></Filter><Status>Enabled</Status><Expiration><Days>2</Days></Expiration></Rule>`)) {
		t.Fatal("XML of a rule with a tag and no prefix")
	}
}

func TestLifecycleSaveAsksWriteOnThePrefixOfEachRule(t *testing.T) {
	env := newAccessEnv(t, 0)
	private := `<Rule><ID>private</ID><Filter><Prefix>tenant/private/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>3</Days></Expiration></Rule>`
	fake, server := newFakeLifecycleS3(t, "MinIO", `<LifecycleConfiguration>`+private+`</LifecycleConfiguration>`)
	env.app.instances["rw"].backend = newAnonymousS3BackendForTest(t, server.URL, "bucket")
	env.pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw", "objects.write@service:infra-s3/bucket:rw/prefix:reports")
	requireForbidden(t, env.request(http.MethodGet, "/api/lifecycle?instance=rw", "nobody", nil), actionObjectsRead)
	var state lifecycleResponse
	if err := json.Unmarshal(env.expect(http.MethodGet, "/api/lifecycle?instance=rw", "carol", nil, http.StatusOK).Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	privateRule := *state.Editor.Entries[0].Rule
	body := func(rules ...lifecycleEditRule) []byte {
		data, _ := json.Marshal(lifecycleRequest{Instance: "rw", Hash: state.Editor.Hash, Rules: rules})
		return data
	}
	reports := lifecycleEditRule{ID: "reports", Enabled: true, Prefix: "reports/", ExpirationDays: 9}
	// A rule that deletes objects needs objects.delete on its prefix.
	requireForbidden(t, env.request(http.MethodPut, "/api/lifecycle", "carol", body(privateRule, reports)), actionObjectsDelete)
	env.pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw", "objects.write@service:infra-s3/bucket:rw/prefix:reports", "objects.delete@service:infra-s3/bucket:rw/prefix:reports")
	// The removal of the rule of private/ needs objects.write on private/, as a new rule there does.
	requireForbidden(t, env.request(http.MethodPut, "/api/lifecycle", "carol", body(reports)), actionObjectsWrite)
	requireForbidden(t, env.request(http.MethodPut, "/api/lifecycle", "carol", body(privateRule, reports, lifecycleEditRule{ID: "x", Prefix: "private/x", ExpirationDays: 1})), actionObjectsWrite)
	// A rule without a prefix is the bucket.
	requireForbidden(t, env.request(http.MethodPut, "/api/lifecycle", "carol", body(privateRule, lifecycleEditRule{ID: "all", ExpirationDays: 1})), actionObjectsWrite)
	if len(fake.puts) != 0 {
		t.Fatalf("a refused save wrote: %s", fake.puts)
	}
	env.expect(http.MethodPut, "/api/lifecycle", "carol", body(privateRule, reports), http.StatusOK)
	// With objects.write on private/, the removal works.
	var saved lifecycleResponse
	_ = json.Unmarshal(env.expect(http.MethodGet, "/api/lifecycle?instance=rw", "carol", nil, http.StatusOK).Body.Bytes(), &saved)
	removal, _ := json.Marshal(lifecycleRequest{Instance: "rw", Hash: saved.Editor.Hash, Rules: []lifecycleEditRule{reports}})
	requireForbidden(t, env.request(http.MethodPut, "/api/lifecycle", "carol", removal), actionObjectsWrite)
	env.pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw", "objects.write@service:infra-s3/bucket:rw/prefix:reports",
		"objects.delete@service:infra-s3/bucket:rw/prefix:reports", "objects.write@service:infra-s3/bucket:rw/prefix:private")
	env.expect(http.MethodPut, "/api/lifecycle", "carol", removal, http.StatusOK)
	if strings.Contains(fake.stored(), "tenant/private/") {
		t.Fatalf("stored = %s", fake.stored())
	}
}

func TestLifecycleRulesThatThePageCannotShowExactlyAreKeptAsIs(t *testing.T) {
	padded := `<Rule><ID>padded</ID><Filter><Prefix>tenant/logs </Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>`
	equals := `<Rule><ID>equals</ID><Filter><And><Prefix>tenant/</Prefix><Tag><Key>a=b</Key><Value>c</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>`
	comma := `<Rule><ID>comma</ID><Filter><Tag><Key>k</Key><Value>a,b</Value></Tag></Filter><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>`
	// A rule that the editor shows, with spaces between the elements: a save that does not change it keeps its bytes.
	pretty := "<Rule>\n  <ID>pretty</ID>\n  <Filter><Prefix>tenant/a/</Prefix></Filter>\n  <Status>Enabled</Status>\n  <Expiration><Days>5</Days></Expiration>\n</Rule>"
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", `<LifecycleConfiguration>`+padded+equals+comma+pretty+`</LifecycleConfiguration>`)
	editor := getLifecycle(t, app, "rw").Editor
	for index := 0; index < 3; index++ {
		if editor.Entries[index].Editable {
			t.Fatalf("entry %d is editable: %+v", index, editor.Entries[index])
		}
	}
	if !editor.Entries[3].Editable {
		t.Fatalf("the rule with spaces between its elements is not editable: %+v", editor.Entries[3])
	}
	decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{*editor.Entries[3].Rule, {ID: "new", Enabled: true, Prefix: "b/", ExpirationDays: 2}}))
	for _, part := range []string{padded, equals, comma, pretty} {
		if !strings.Contains(fake.stored(), part) {
			t.Fatalf("the save changed %q:\n%s", part, fake.stored())
		}
	}
	// A change of the rule writes it again.
	editor = getLifecycle(t, app, "rw").Editor
	changed := *editor.Entries[0].Rule
	changed.ExpirationDays = 6
	decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{changed, *editor.Entries[1].Rule}))
	if strings.Contains(fake.stored(), pretty) || !strings.Contains(fake.stored(), "<ID>pretty</ID><Filter><Prefix>tenant/a/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>6</Days>") {
		t.Fatalf("stored = %s", fake.stored())
	}
}

func TestLifecycleRuleThatDeletesNeedsTheDeletePermission(t *testing.T) {
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", `<LifecycleConfiguration>`+editableLogs+`</LifecycleConfiguration>`)
	instance := app.instances["rw"]
	instance.cfg.Permissions = []string{permissionRead, permissionWrite}
	instance.caps = initialCapabilities(instance.cfg)
	editor := getLifecycle(t, app, "rw").Editor
	logs := *editor.Entries[0].Rule
	// A new rule that deletes objects, or a change of the days, needs the delete permission.
	for _, rules := range [][]lifecycleEditRule{
		{logs, {ID: "new", Enabled: true, Prefix: "x/", ExpirationDays: 1}},
		{{ID: "logs", Enabled: true, Prefix: "logs/", ExpirationDays: 1}},
		{logs, {ID: "versions", Enabled: true, Prefix: "x/", NoncurrentDays: 1}},
	} {
		if recorder := putLifecycle(app, "rw", editor.Hash, rules); recorder.Code != http.StatusForbidden {
			t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
		}
	}
	if len(fake.puts) != 0 || fake.deletes != 0 {
		t.Fatal("a refused save wrote")
	}
	// A rule that becomes disabled, the removal of a rule and the abort of incomplete uploads need write only.
	logs.Enabled = false
	saved := decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{logs, {ID: "abort", Enabled: true, Prefix: "x/", AbortMultipartDays: 2}}))
	decodeLifecycle(t, putLifecycle(app, "rw", saved.Editor.Hash, nil))
}

func TestLifecycleChangeOfTheEditableRulesStopsTheSave(t *testing.T) {
	// The hash also covers which rules the editor shows: a rule that becomes "kept as is" stops a save of the page.
	abort := `<Rule><ID>abort</ID><Filter><Prefix>tenant/</Prefix></Filter><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>2</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>`
	app, _ := lifecycleApplication(t, "SeaweedFS 30GB 4.41", `<LifecycleConfiguration>`+abort+`</LifecycleConfiguration>`)
	editor := getLifecycle(t, app, "rw").Editor
	app.instances["rw"].markLifecycleDropped(lifecycleFieldAbort)
	recorder := putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{{ID: "renamed", Enabled: true, Prefix: "", AbortMultipartDays: 2}})
	if recorder.Code != http.StatusConflict || errorCode(t, recorder) != "lifecycle_changed" {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestLifecycleReadBackOfAnUnknownShapeMarksNoField(t *testing.T) {
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", "")
	// The provider adds an element that the editor does not know: the rule comes back in another shape.
	fake.keep = func(body []byte) []byte {
		return []byte(strings.Replace(string(body), "</Rule>", "<Extra>1</Extra></Rule>", 1))
	}
	editor := getLifecycle(t, app, "rw").Editor
	saved := decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{{ID: "t", Enabled: true, Prefix: "a/", Tag: &objectTag{"k", "v"}, ExpirationDays: 3}}))
	if len(saved.Warnings) != 1 || saved.Warnings[0] != `The storage provider changed the rule "t": it has settings that the editor does not show.` {
		t.Fatalf("warnings = %v", saved.Warnings)
	}
	if !saved.Editor.Fields[lifecycleFieldTag] {
		t.Fatal("a rule of another shape marked the tag filter as dropped")
	}
}

func TestLifecycleSaveWhoseReadBackFailsSaysThatTheRulesAreSaved(t *testing.T) {
	app, fake := lifecycleApplication(t, "SeaweedFS 30GB 4.41", "")
	editor := getLifecycle(t, app, "rw").Editor
	fake.keep = func(body []byte) []byte {
		fake.lifecycle = http.StatusInternalServerError
		return body
	}
	saved := decodeLifecycle(t, putLifecycle(app, "rw", editor.Hash, []lifecycleEditRule{{ID: "a", Enabled: true, ExpirationDays: 3}}))
	if saved.Editor != nil || len(saved.Warnings) != 1 || !strings.HasPrefix(saved.Warnings[0], "The rules are saved, but S3-Browser cannot read them again") {
		t.Fatalf("answer = %+v", saved)
	}
	if !strings.Contains(fake.stored(), "<ID>a</ID>") {
		t.Fatal("the rule was not written")
	}
}
