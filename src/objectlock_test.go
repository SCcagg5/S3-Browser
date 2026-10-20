package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLockVersion is one version of the fake Object Lock server.
type fakeLockVersion struct {
	data      string
	retention *objectRetention
	hold      bool
}

// fakeLockS3 is an S3 server with Object Lock for the tests: the configuration of the bucket, the retention and the
// legal hold of each version, PUT, HEAD, the list, DELETE with and without a version, and DeleteObjects. A delete of a
// locked version gets the refusal of SeaweedFS (403 AccessDenied) or of MinIO (400 InvalidRequest). SeaweedFS and MinIO
// write a delete marker for a delete without a version; refuseCurrent makes the fake refuse such a delete of a locked
// object, as a provider without this rule does.
type fakeLockS3 struct {
	t             *testing.T
	mu            sync.Mutex
	versions      map[string]*fakeLockVersion // "key?version"
	current       map[string]string           // key -> version, "" after a delete marker
	order         int
	config        string // "enabled", "none" or "unsupported"
	defaultMode   string
	minioStyle    bool
	refuseCurrent bool

	retentionPuts []http.Header
	holdPuts      int
	deletes       []string
}

func newFakeLockS3(t *testing.T) (*fakeLockS3, *httptest.Server) {
	fake := &fakeLockS3{t: t, versions: map[string]*fakeLockVersion{}, current: map[string]string{}, config: "enabled"}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return fake, server
}

func (f *fakeLockS3) put(key, data string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.order++
	version := fmt.Sprintf("v%d", f.order)
	f.versions[key+"?"+version] = &fakeLockVersion{data: data}
	f.current[key] = version
	return version
}

func (f *fakeLockS3) version(key, version string) *fakeLockVersion {
	if version == "" {
		version = f.current[key]
	}
	return f.versions[key+"?"+version]
}

func (f *fakeLockS3) locked(object *fakeLockVersion) bool {
	return object != nil && (object.hold || object.retention.active(time.Now()))
}

// refuse writes the refusal of a locked version, as SeaweedFS or MinIO send it.
func (f *fakeLockS3) refuse(w http.ResponseWriter) {
	if f.minioStyle {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "<Error><Code>InvalidRequest</Code><Message>Object is WORM protected and cannot be overwritten</Message></Error>")
		return
	}
	w.WriteHeader(http.StatusForbidden)
	_, _ = io.WriteString(w, "<Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>")
}

func (f *fakeLockS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/bucket"), "/")
	query := r.URL.Query()
	f.mu.Lock()
	defer f.mu.Unlock()
	version := query.Get("versionId")
	switch {
	case key == "" && query.Has("object-lock"):
		switch f.config {
		case "unsupported":
			w.WriteHeader(http.StatusNotImplemented)
			_, _ = io.WriteString(w, "<Error><Code>NotImplemented</Code><Message>Unimplemented action: GetObjectLockConfiguration</Message></Error>")
		case "none":
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "<Error><Code>ObjectLockConfigurationNotFoundError</Code><Message>Object Lock configuration does not exist for this bucket</Message></Error>")
		default:
			rule := ""
			if f.defaultMode != "" {
				rule = "<Rule><DefaultRetention><Mode>" + f.defaultMode + "</Mode><Days>30</Days></DefaultRetention></Rule>"
			}
			_, _ = io.WriteString(w, `<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled>`+rule+`</ObjectLockConfiguration>`)
		}
	case key == "" && query.Get("list-type") == "2":
		prefix := query.Get("prefix")
		keys := make([]string, 0)
		for name, current := range f.current {
			if current != "" && strings.HasPrefix(name, prefix) {
				keys = append(keys, name)
			}
		}
		sort.Strings(keys)
		var body strings.Builder
		body.WriteString("<ListBucketResult>")
		for _, name := range keys {
			fmt.Fprintf(&body, "<Contents><Key>%s</Key><Size>%d</Size><LastModified>2026-10-20T10:00:00Z</LastModified><ETag>\"e\"</ETag></Contents>", name, len(f.version(name, "").data))
		}
		body.WriteString("</ListBucketResult>")
		_, _ = io.WriteString(w, body.String())
	case key == "" && query.Has("delete") && r.Method == http.MethodPost:
		var request struct {
			Objects []struct {
				Key string `xml:"Key"`
			} `xml:"Object"`
		}
		if err := xml.NewDecoder(r.Body).Decode(&request); err != nil {
			f.t.Errorf("delete body: %v", err)
		}
		var body strings.Builder
		body.WriteString("<DeleteResult>")
		for _, object := range request.Objects {
			if f.refuseCurrent && f.locked(f.version(object.Key, "")) {
				fmt.Fprintf(&body, "<Error><Key>%s</Key><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>", object.Key)
				continue
			}
			f.deletes = append(f.deletes, object.Key)
			f.current[object.Key] = ""
		}
		body.WriteString("</DeleteResult>")
		_, _ = io.WriteString(w, body.String())
	case query.Has("retention") && r.Method == http.MethodGet:
		object := f.version(key, version)
		if object == nil {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
			return
		}
		if object.retention == nil {
			// MinIO answers 400 NoSuchObjectLockConfiguration, SeaweedFS 404 ObjectLockConfigurationNotFoundError.
			if f.minioStyle {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, "<Error><Code>NoSuchObjectLockConfiguration</Code><Message>The specified object does not have a ObjectLock configuration</Message></Error>")
			} else {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, "<Error><Code>ObjectLockConfigurationNotFoundError</Code><Message>Object Lock configuration does not exist for this bucket</Message></Error>")
			}
			return
		}
		fmt.Fprintf(w, `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>%s</Mode><RetainUntilDate>%s</RetainUntilDate></Retention>`,
			object.retention.Mode, object.retention.RetainUntil.UTC().Format("2006-01-02T15:04:05.000Z"))
	case query.Has("legal-hold") && r.Method == http.MethodGet:
		object := f.version(key, version)
		if object == nil {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
			return
		}
		if !object.hold && f.minioStyle {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, "<Error><Code>NoSuchObjectLockConfiguration</Code></Error>")
			return
		}
		if !object.hold {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "<Error><Code>NoSuchObjectLegalHold</Code></Error>")
			return
		}
		_, _ = io.WriteString(w, `<LegalHold xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>ON</Status></LegalHold>`)
	case query.Has("retention") && r.Method == http.MethodPut:
		f.retentionPuts = append(f.retentionPuts, r.Header.Clone())
		if r.Header.Get("Content-MD5") == "" {
			f.t.Error("PutObjectRetention without Content-MD5")
		}
		var request struct {
			Mode  string `xml:"Mode"`
			Until string `xml:"RetainUntilDate"`
		}
		if err := xml.NewDecoder(r.Body).Decode(&request); err != nil {
			f.t.Errorf("retention body: %v", err)
		}
		until, err := time.Parse(time.RFC3339, request.Until)
		if err != nil {
			f.t.Errorf("retain-until date %q: %v", request.Until, err)
		}
		object := f.version(key, version)
		if object.retention.active(time.Now()) && (until.Before(object.retention.RetainUntil.Truncate(time.Second)) || request.Mode != object.retention.Mode) &&
			(object.retention.Mode == objectLockCompliance || r.Header.Get("x-amz-bypass-governance-retention") != "true") {
			f.refuse(w)
			return
		}
		object.retention = &objectRetention{Mode: request.Mode, RetainUntil: until}
	case query.Has("legal-hold") && r.Method == http.MethodPut:
		f.holdPuts++
		var request struct {
			Status string `xml:"Status"`
		}
		if err := xml.NewDecoder(r.Body).Decode(&request); err != nil {
			f.t.Errorf("legal hold body: %v", err)
		}
		f.version(key, version).hold = request.Status == "ON"
	case r.Method == http.MethodHead:
		object := f.version(key, version)
		if object == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if version == "" {
			version = f.current[key]
		}
		w.Header().Set("x-amz-version-id", version)
		w.Header().Set("ETag", `"e"`)
		w.Header().Set("Content-Length", fmt.Sprint(len(object.data)))
	case r.Method == http.MethodPut && r.Header.Get("x-amz-copy-source") != "":
		source := f.version(strings.TrimPrefix(r.Header.Get("x-amz-copy-source"), "/bucket/"), "")
		f.order++
		next := fmt.Sprintf("v%d", f.order)
		f.versions[key+"?"+next] = &fakeLockVersion{data: source.data}
		f.current[key] = next
		_, _ = io.WriteString(w, "<CopyObjectResult/>")
	case r.Method == http.MethodDelete && version != "":
		if f.locked(f.versions[key+"?"+version]) {
			f.refuse(w)
			return
		}
		f.deletes = append(f.deletes, key+"?"+version)
		delete(f.versions, key+"?"+version)
		if f.current[key] == version {
			f.current[key] = ""
		}
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodDelete:
		if f.refuseCurrent && f.locked(f.version(key, "")) {
			f.refuse(w)
			return
		}
		f.deletes = append(f.deletes, key)
		f.current[key] = ""
		w.WriteHeader(http.StatusNoContent)
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL)
		w.WriteHeader(http.StatusNotImplemented)
	}
}

// fakeLockApplication gives the instance "rw" (root prefix tenant/) a fake bucket with Object Lock, after the probe.
func fakeLockApplication(t *testing.T) (*application, *fakeLockS3) {
	t.Helper()
	app, _, _ := testApplication(t)
	fake, server := newFakeLockS3(t)
	instance := app.instances["rw"]
	instance.backend = newAnonymousS3BackendForTest(t, server.URL, "bucket")
	instance.setVersioningAvailable(true)
	instance.probeObjectLock(context.Background())
	return app, fake
}

func decodeObjectLock(t *testing.T, recorder *httptest.ResponseRecorder) objectLockResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var response objectLockResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func lockErrorCode(t *testing.T, recorder *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	return body.Error.Code, body.Error.Message
}

func TestS3BackendObjectLockRequestsAndXML(t *testing.T) {
	t.Parallel()
	var requests []*http.Request
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests, bodies = append(requests, r.Clone(context.Background())), append(bodies, string(body))
		switch {
		case r.URL.Query().Has("object-lock"):
			_, _ = io.WriteString(w, `<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Years>2</Years></DefaultRetention></Rule></ObjectLockConfiguration>`)
		case r.URL.Query().Has("retention") && r.Method == http.MethodGet:
			// MinIO sends the milliseconds.
			_, _ = io.WriteString(w, `<Retention><Mode>GOVERNANCE</Mode><RetainUntilDate>2026-10-20T15:56:31.000Z</RetainUntilDate></Retention>`)
		case r.URL.Query().Has("legal-hold") && r.Method == http.MethodGet:
			_, _ = io.WriteString(w, `<LegalHold><Status>ON</Status></LegalHold>`)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()
	backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
	ctx := context.Background()
	config, err := backend.ObjectLockConfiguration(ctx)
	if err != nil || !config.Enabled || config.Default == nil || *config.Default != (objectLockDefault{Mode: objectLockCompliance, Years: 2}) {
		t.Fatalf("config = %+v, %v", config, err)
	}
	retention, err := backend.ObjectRetention(ctx, "dir/a file.txt", "v 1")
	want := time.Date(2026, 10, 20, 15, 56, 31, 0, time.UTC)
	if err != nil || retention == nil || retention.Mode != objectLockGovernance || !retention.RetainUntil.Equal(want) {
		t.Fatalf("retention = %+v, %v", retention, err)
	}
	if hold, err := backend.ObjectLegalHold(ctx, "dir/a file.txt", "v 1"); err != nil || !hold {
		t.Fatalf("hold = %v, %v", hold, err)
	}
	until := time.Date(2027, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := backend.PutObjectRetention(ctx, "dir/a file.txt", "v 1", objectRetention{Mode: objectLockCompliance, RetainUntil: until}, false); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutObjectRetention(ctx, "k", "", objectRetention{Mode: objectLockGovernance, RetainUntil: until}, true); err != nil {
		t.Fatal(err)
	}
	if err := backend.PutObjectLegalHold(ctx, "k", "v2", false); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 6 {
		t.Fatalf("requests = %d", len(requests))
	}
	if r := requests[1]; r.URL.Path != "/bucket/dir/a file.txt" || r.URL.Query().Get("versionId") != "v 1" || !r.URL.Query().Has("retention") {
		t.Fatalf("GetObjectRetention = %s", r.URL)
	}
	put := requests[3]
	if put.Method != http.MethodPut || put.URL.Query().Get("versionId") != "v 1" || put.Header.Get("Content-MD5") == "" ||
		put.Header.Get("x-amz-bypass-governance-retention") != "" ||
		bodies[3] != `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>COMPLIANCE</Mode><RetainUntilDate>2027-01-02T03:04:05Z</RetainUntilDate></Retention>` {
		t.Fatalf("PutObjectRetention = %s %v %q", put.URL, put.Header, bodies[3])
	}
	if bypass := requests[4]; bypass.Header.Get("x-amz-bypass-governance-retention") != "true" || bypass.URL.Query().Has("versionId") {
		t.Fatalf("PutObjectRetention with bypass = %s %v", bypass.URL, bypass.Header)
	}
	if hold := requests[5]; !hold.URL.Query().Has("legal-hold") || hold.URL.Query().Get("versionId") != "v2" || hold.Header.Get("Content-MD5") == "" ||
		bodies[5] != `<LegalHold xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>OFF</Status></LegalHold>` {
		t.Fatalf("PutObjectLegalHold = %s %q", hold.URL, bodies[5])
	}
}

func TestS3BackendReadsNoLockFromTheAnswersOfEachProvider(t *testing.T) {
	t.Parallel()
	for name, answer := range map[string]struct {
		status int
		code   string
	}{
		"SeaweedFS retention": {http.StatusNotFound, "ObjectLockConfigurationNotFoundError"},
		"SeaweedFS hold":      {http.StatusNotFound, "NoSuchObjectLegalHold"},
		"MinIO":               {http.StatusBadRequest, "NoSuchObjectLockConfiguration"},
		"AWS":                 {http.StatusNotFound, "NoSuchObjectLockConfiguration"},
	} {
		answer := answer
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(answer.status)
				_, _ = io.WriteString(w, "<Error><Code>"+answer.code+"</Code><Message>none</Message></Error>")
			}))
			defer server.Close()
			backend := newAnonymousS3BackendForTest(t, server.URL, "bucket")
			if retention, err := backend.ObjectRetention(context.Background(), "k", "v"); retention != nil || err != nil {
				t.Fatalf("retention = %+v, %v", retention, err)
			}
			if hold, err := backend.ObjectLegalHold(context.Background(), "k", "v"); hold || err != nil {
				t.Fatalf("hold = %v, %v", hold, err)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>")
	}))
	defer server.Close()
	if _, err := newAnonymousS3BackendForTest(t, server.URL, "bucket").ObjectRetention(context.Background(), "k", ""); !isStorageNotFound(err) {
		t.Fatalf("a missing key must stay an error, got %v", err)
	}
}

func TestProbeObjectLockShowsOnlyAnEnabledBucket(t *testing.T) {
	for config, want := range map[string]bool{"enabled": true, "none": false, "unsupported": false} {
		app, _, _ := testApplication(t)
		fake, server := newFakeLockS3(t)
		fake.config = config
		instance := app.instances["rw"]
		if instance.publicInfo().ObjectLock {
			t.Fatal("the feature shows before the probe")
		}
		instance.backend = newAnonymousS3BackendForTest(t, server.URL, "bucket")
		instance.probeObjectLock(context.Background())
		if instance.objectLockAvailable() != want || instance.publicInfo().ObjectLock != want {
			t.Fatalf("%s: available = %v, want %v", config, instance.objectLockAvailable(), want)
		}
		got := doJSON(app, http.MethodGet, "/api/object-lock?instance=rw&key=a.txt", nil)
		if !want && (got.Code != http.StatusNotImplemented || !strings.Contains(got.Body.String(), "object_lock_unsupported")) {
			t.Fatalf("%s: status = %d %s", config, got.Code, got.Body.String())
		}
	}
	// The memory backend and the GCS backend have no Object Lock.
	app, _, _ := testApplication(t)
	app.instances["rw"].probeObjectLock(context.Background())
	if app.instances["rw"].objectLockAvailable() {
		t.Fatal("a backend without Object Lock has it")
	}
	if _, ok := any(&gcsBackend{}).(ObjectLockManager); ok {
		t.Fatal("the GCS backend must answer unsupported")
	}
}

func TestValidateObjectLockRequest(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	on := true
	retention := func(mode, until string) *struct {
		Mode        string `json:"mode"`
		RetainUntil string `json:"retainUntil"`
	} {
		return &struct {
			Mode        string `json:"mode"`
			RetainUntil string `json:"retainUntil"`
		}{mode, until}
	}
	for name, test := range map[string]struct {
		request objectLockRequest
		ok      bool
	}{
		"legal hold":         {objectLockRequest{Version: "v1", LegalHold: &on}, true},
		"retention":          {objectLockRequest{Version: "v1", Retention: retention("GOVERNANCE", "2026-10-21T00:00:00Z")}, true},
		"offset date":        {objectLockRequest{Version: "v1", Retention: retention("COMPLIANCE", "2026-10-21T02:00:00+02:00")}, true},
		"no version":         {objectLockRequest{LegalHold: &on}, false},
		"control in version": {objectLockRequest{Version: "v\n1", LegalHold: &on}, false},
		"long version":       {objectLockRequest{Version: strings.Repeat("v", maxObjectLockVersionBytes+1), LegalHold: &on}, false},
		"nothing to change":  {objectLockRequest{Version: "v1"}, false},
		"lowercase mode":     {objectLockRequest{Version: "v1", Retention: retention("governance", "2026-10-21T00:00:00Z")}, false},
		"unknown mode":       {objectLockRequest{Version: "v1", Retention: retention("LEGAL", "2026-10-21T00:00:00Z")}, false},
		"not a date":         {objectLockRequest{Version: "v1", Retention: retention("GOVERNANCE", "tomorrow")}, false},
		"date only":          {objectLockRequest{Version: "v1", Retention: retention("GOVERNANCE", "2026-10-21")}, false},
		"past date":          {objectLockRequest{Version: "v1", Retention: retention("GOVERNANCE", "2026-10-20T11:59:59Z")}, false},
		"now":                {objectLockRequest{Version: "v1", Retention: retention("GOVERNANCE", "2026-10-20T12:00:00Z")}, false},
		"too far":            {objectLockRequest{Version: "v1", Retention: retention("GOVERNANCE", "2126-10-21T00:00:00Z")}, false},
	} {
		test := test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := validateObjectLockRequest(test.request, now); (err == nil) != test.ok {
				t.Fatalf("validateObjectLockRequest = %v, want ok = %v", err, test.ok)
			}
		})
	}
}

func TestRetentionChangeRules(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	at := func(minutes int) time.Time { return now.Add(time.Duration(minutes) * time.Minute) }
	governance := &objectRetention{Mode: objectLockGovernance, RetainUntil: at(60).Add(400 * time.Millisecond)}
	compliance := &objectRetention{Mode: objectLockCompliance, RetainUntil: at(60)}
	expired := &objectRetention{Mode: objectLockCompliance, RetainUntil: at(-1)}
	for name, test := range map[string]struct {
		current *objectRetention
		next    objectRetention
		bypass  bool
		refused bool
	}{
		"first retention":            {nil, objectRetention{objectLockCompliance, at(5)}, false, false},
		"after the end of a lock":    {expired, objectRetention{objectLockGovernance, at(5)}, false, false},
		"governance extended":        {governance, objectRetention{objectLockGovernance, at(90)}, false, false},
		"governance same second":     {governance, objectRetention{objectLockGovernance, at(60)}, false, false},
		"governance shortened":       {governance, objectRetention{objectLockGovernance, at(30)}, true, false},
		"governance to compliance":   {governance, objectRetention{objectLockCompliance, at(90)}, true, false},
		"compliance extended":        {compliance, objectRetention{objectLockCompliance, at(90)}, false, false},
		"compliance same date":       {compliance, objectRetention{objectLockCompliance, at(60)}, false, false},
		"compliance shortened":       {compliance, objectRetention{objectLockCompliance, at(30)}, false, true},
		"compliance to governance":   {compliance, objectRetention{objectLockGovernance, at(90)}, false, true},
		"compliance shortened again": {compliance, objectRetention{objectLockCompliance, at(59)}, false, true},
	} {
		test := test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			bypass, err := retentionChange(test.current, test.next, now)
			if bypass != test.bypass || (err != nil) != test.refused {
				t.Fatalf("retentionChange = %v, %v; want bypass %v, refused %v", bypass, err, test.bypass, test.refused)
			}
			if err != nil && (!strings.Contains(err.Error(), "Compliance") || !strings.Contains(err.Error(), "nobody can")) {
				t.Fatalf("the refusal does not say why: %v", err)
			}
		})
	}
}

func TestObjectLockAPIReadsAndChangesTheLegalHoldOfAVersion(t *testing.T) {
	app, fake := fakeLockApplication(t)
	fake.defaultMode = objectLockGovernance
	version := fake.put("tenant/doc.txt", "data")
	state := decodeObjectLock(t, doJSON(app, http.MethodGet, "/api/object-lock?instance=rw&key=doc.txt", nil))
	if state.Version != version || state.Retention != nil || state.LegalHold || state.BucketDefault == nil ||
		*state.BucketDefault != (objectLockDefaultJSON{Mode: objectLockGovernance, Days: 30}) || state.MaxRetentionDays != maxObjectLockDays {
		t.Fatalf("state = %+v", state)
	}
	on := true
	state = decodeObjectLock(t, doJSON(app, http.MethodPut, "/api/object-lock", objectLockRequest{Instance: "rw", Key: "doc.txt", Version: version, LegalHold: &on}))
	if !state.LegalHold || state.Version != version {
		t.Fatalf("state = %+v", state)
	}
	// The same state again sends nothing to the provider.
	decodeObjectLock(t, doJSON(app, http.MethodPut, "/api/object-lock", objectLockRequest{Instance: "rw", Key: "doc.txt", Version: version, LegalHold: &on}))
	fake.mu.Lock()
	holdPuts := fake.holdPuts
	fake.mu.Unlock()
	if holdPuts != 1 {
		t.Fatalf("legal hold requests = %d", holdPuts)
	}
	// A change names the version, and the read-only instance cannot change a lock.
	if got := doJSON(app, http.MethodPut, "/api/object-lock", objectLockRequest{Instance: "rw", Key: "doc.txt", LegalHold: &on}); got.Code != http.StatusBadRequest {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	if got := doJSON(app, http.MethodPut, "/api/object-lock", objectLockRequest{Instance: "readonly", Key: "readonly.txt", Version: "v1", LegalHold: &on}); got.Code != http.StatusForbidden {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
}

func TestObjectLockAPIAppliesTheRulesOfTheRetention(t *testing.T) {
	app, fake := fakeLockApplication(t)
	version := fake.put("tenant/doc.txt", "data")
	until := func(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339) }
	put := func(mode, date string, bypass bool) *httptest.ResponseRecorder {
		request := map[string]any{"instance": "rw", "key": "doc.txt", "version": version,
			"retention": map[string]string{"mode": mode, "retainUntil": date}, "bypassGovernance": bypass}
		return doJSON(app, http.MethodPut, "/api/object-lock", request)
	}
	retentionPuts := func() []http.Header {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return append([]http.Header(nil), fake.retentionPuts...)
	}
	state := decodeObjectLock(t, put(objectLockGovernance, until(time.Hour), false))
	if state.Retention == nil || state.Retention.Mode != objectLockGovernance || !state.Retention.Active {
		t.Fatalf("state = %+v", state)
	}
	decodeObjectLock(t, put(objectLockGovernance, until(2*time.Hour), false))
	// A shorter Governance retention needs the bypass: without it, the request does not reach the provider.
	got := put(objectLockGovernance, until(time.Minute), false)
	if code, _ := lockErrorCode(t, got); got.Code != http.StatusConflict || code != "governance_bypass_required" {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
	if sent := retentionPuts(); len(sent) != 2 || sent[0].Get("x-amz-bypass-governance-retention") != "" || sent[1].Get("x-amz-bypass-governance-retention") != "" {
		t.Fatalf("retention requests = %v", sent)
	}
	state = decodeObjectLock(t, put(objectLockGovernance, until(time.Minute), true))
	if sent := retentionPuts(); len(sent) != 3 || sent[2].Get("x-amz-bypass-governance-retention") != "true" {
		t.Fatalf("retention requests = %v", sent)
	}
	if until, _ := time.Parse(time.RFC3339, state.Retention.RetainUntil); time.Until(until) > 2*time.Minute {
		t.Fatalf("state = %+v", state.Retention)
	}
	// Governance to Compliance with the bypass, and then no request can shorten the Compliance retention or change it.
	decodeObjectLock(t, put(objectLockCompliance, until(2*time.Minute), true))
	for _, request := range []struct {
		mode string
		date string
	}{{objectLockCompliance, until(time.Minute)}, {objectLockGovernance, until(time.Hour)}} {
		got := put(request.mode, request.date, true)
		if code, message := lockErrorCode(t, got); got.Code != http.StatusConflict || code != "compliance_retention" || !strings.Contains(message, "nobody can") {
			t.Fatalf("status = %d %s", got.Code, got.Body.String())
		}
	}
	if sent := retentionPuts(); len(sent) != 4 {
		t.Fatalf("a refused change reached the provider: %d requests", len(sent))
	}
	state = decodeObjectLock(t, put(objectLockCompliance, until(3*time.Minute), false))
	if state.Retention.Mode != objectLockCompliance {
		t.Fatalf("state = %+v", state.Retention)
	}
	// A request with a bad date does not reach the provider.
	if got := put(objectLockGovernance, until(-time.Minute), true); got.Code != http.StatusBadRequest {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
}

func TestDeleteOfALockedVersionNamesTheLock(t *testing.T) {
	for _, minio := range []bool{false, true} {
		app, fake := fakeLockApplication(t)
		fake.minioStyle = minio
		instance := app.instances["rw"]
		version := fake.put("tenant/doc.txt", "data")
		fake.mu.Lock()
		fake.version("tenant/doc.txt", version).hold = true
		fake.version("tenant/doc.txt", version).retention = &objectRetention{Mode: objectLockGovernance, RetainUntil: time.Now().Add(time.Hour)}
		fake.mu.Unlock()
		got := doJSON(app, http.MethodDelete, "/api/versions?instance=rw&key=doc.txt&version="+version, nil)
		code, message := lockErrorCode(t, got)
		if got.Code != http.StatusConflict || code != "object_locked" || !strings.Contains(message, "legal hold is on") ||
			!strings.Contains(message, "Governance retention keeps it until") || !strings.Contains(message, `"doc.txt"`) {
			t.Fatalf("minio = %v: status = %d %s", minio, got.Code, got.Body.String())
		}
		// The gateway /s3 answers with the message as text.
		got = doJSON(app, http.MethodDelete, "/s3?instance=rw&key=doc.txt&version="+version, nil)
		if got.Code != http.StatusConflict || strings.TrimSpace(got.Body.String()) != message {
			t.Fatalf("minio = %v: status = %d %s", minio, got.Code, got.Body.String())
		}
		// The refusal of the lock is not a refusal of the delete permission.
		if state := instance.capabilities().Delete; state.State == capabilityDenied {
			t.Fatalf("minio = %v: delete = %+v", minio, state)
		}
		// Without a lock, the same refusal stays the error of the provider.
		fake.mu.Lock()
		fake.version("tenant/doc.txt", version).hold = false
		fake.version("tenant/doc.txt", version).retention = nil
		fake.mu.Unlock()
		if err := instance.explainLockRefusal(context.Background(), "tenant/doc.txt", version, &upstreamError{StatusCode: http.StatusForbidden, Code: "AccessDenied"}); isObjectLocked(err) {
			t.Fatalf("minio = %v: an object without a lock is locked: %v", minio, err)
		}
		if got := doJSON(app, http.MethodDelete, "/api/versions?instance=rw&key=doc.txt&version="+version, nil); got.Code != http.StatusNoContent {
			t.Fatalf("minio = %v: status = %d %s", minio, got.Code, got.Body.String())
		}
	}
}

func TestDeletePrefixJobCountsTheLockedKeys(t *testing.T) {
	app, fake := fakeLockApplication(t)
	fake.refuseCurrent = true
	for _, name := range []string{"a", "b", "c", "d"} {
		fake.put("tenant/logs/"+name+".txt", name)
	}
	fake.mu.Lock()
	fake.version("tenant/logs/b.txt", "").hold = true
	fake.version("tenant/logs/d.txt", "").retention = &objectRetention{Mode: objectLockCompliance, RetainUntil: time.Now().Add(time.Hour)}
	fake.mu.Unlock()
	recorder := postJSON(t, app.routes(), "/api/delete-prefix", map[string]any{"instance": "rw", "prefix": "logs/"})
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var created publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	done := waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted).public()
	if done.Processed != 2 || done.Locked != 2 || strings.Join(done.LockedKeys, ",") != "logs/b.txt,logs/d.txt" || done.Error != "" {
		t.Fatalf("job = %+v", done)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if strings.Join(fake.deletes, ",") != "tenant/logs/a.txt,tenant/logs/c.txt" {
		t.Fatalf("deletes = %v", fake.deletes)
	}
}

func TestBatchDeleteKeepsTheOtherRefusals(t *testing.T) {
	app, fake := fakeLockApplication(t)
	fake.refuseCurrent = true
	instance := app.instances["rw"]
	fake.put("tenant/locked.txt", "x")
	fake.put("tenant/denied.txt", "y")
	fake.mu.Lock()
	fake.version("tenant/locked.txt", "").hold = true
	fake.mu.Unlock()
	refused := &batchDeleteError{Total: 2, Failures: []batchDeleteFailure{
		{Key: "tenant/locked.txt", Code: "AccessDenied", Message: "Access Denied."},
		{Key: "tenant/denied.txt", Code: "AccessDenied", Message: "Access Denied."},
	}}
	locked, err := instance.lockedKeys(context.Background(), refused)
	var others *batchDeleteError
	if strings.Join(locked, ",") != "tenant/locked.txt" || !errors.As(err, &others) || len(others.Failures) != 1 || others.Failures[0].Key != "tenant/denied.txt" {
		t.Fatalf("locked = %v, err = %v", locked, err)
	}
	// A caller that knows only upstreamError sees the first other refusal.
	var upstream *upstreamError
	if !errors.As(err, &upstream) || upstream.Code != "AccessDenied" || !strings.Contains(upstream.Message, "1 of 2 keys were not deleted") {
		t.Fatalf("upstream = %+v", upstream)
	}
}

func TestMoveJobKeepsALockedSourceAndCountsIt(t *testing.T) {
	app, fake := fakeLockApplication(t)
	fake.refuseCurrent = true
	fake.put("tenant/in/a.txt", "a")
	fake.put("tenant/in/b.txt", "b")
	fake.mu.Lock()
	fake.version("tenant/in/a.txt", "").hold = true
	fake.mu.Unlock()
	recorder := postJSON(t, app.routes(), "/api/rename", map[string]any{"instance": "rw", "src": "in/", "dst": "out/", "isPrefix": true})
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var created publicJob
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	done := waitForJobStatus(t, app.jobs, created.ID, jobStatusCompleted).public()
	if done.Locked != 1 || len(done.LockedKeys) != 1 || done.LockedKeys[0] != "in/a.txt" {
		t.Fatalf("job = %+v", done)
	}
	// The single rename of a locked object: the copy is made, the source stays, and the error says why.
	got := postJSON(t, app.routes(), "/api/rename", map[string]any{"instance": "rw", "src": "in/a.txt", "dst": "single.txt"})
	code, message := lockErrorCode(t, got)
	if got.Code != http.StatusConflict || code != "object_locked" || !strings.HasPrefix(message, "The copy is made, but the source stays. Object Lock keeps") {
		t.Fatalf("status = %d %s", got.Code, got.Body.String())
	}
}
