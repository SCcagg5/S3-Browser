package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"
)

// The tests of the access of humans (docs/ACCESS.md). They use a fake PDP that
// applies the prefix rule of the grants and the match "subtree" (contract 11.5
// and 11.8), and identity tokens that the tests sign.

// accessEnv is an application in the authzen mode with a fake PDP.
type accessEnv struct {
	t         *testing.T
	app       *application
	handler   http.Handler
	pdp       *fakePDP
	key       ed25519.PrivateKey
	readWrite *memoryBackend
}

func newAccessEnv(t *testing.T, cacheTTL time.Duration) *accessEnv {
	t.Helper()
	app, _, readWrite := testApplication(t)
	readWrite.mu.Lock()
	for key, value := range map[string]string{
		"tenant/reports/q1.csv":     "a,b\n1,2\n",
		"tenant/private/secret.txt": "secret",
		"tenant/root.txt":           "root",
	} {
		readWrite.objects[key] = memoryObject{data: []byte(value), contentType: "text/plain", modified: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	}
	readWrite.mu.Unlock()

	private, publicPEM := newTestIdentityKey(t)
	keys, err := parseIdentityPublicKeys(publicPEM)
	if err != nil {
		t.Fatal(err)
	}
	pdp := newFakePDP()
	server := httptest.NewServer(pdp)
	t.Cleanup(server.Close)
	app.config.Access = accessConfig{
		Mode: accessModeAuthZEN, Header: defaultIdentityHeader, Issuer: testIssuer, Audience: testAudience,
		Keys: keys, MaxAge: 5 * time.Minute,
		PDPURL: server.URL, PDPToken: testPDPToken, PDPTimeout: 2 * time.Second, PDPCacheTTL: cacheTTL, PDPMaxEvaluations: 64,
	}
	app.identity = newIdentityVerifier(app.config.Access)
	app.pdp = newPDPClient(app.config.Access)
	return &accessEnv{t: t, app: app, handler: app.routes(), pdp: pdp, key: private, readWrite: readWrite}
}

func (e *accessEnv) token(subject string) string {
	now := time.Now().Unix()
	return signTestToken(e.t, e.key, map[string]any{"alg": "EdDSA", "typ": "JWT"}, map[string]any{
		"iss": testIssuer, "sub": subject, "aud": testAudience, "iat": now, "exp": now + 300,
	})
}

func (e *accessEnv) request(method, target, subject string, body []byte) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if subject != "" {
		request.Header.Set(defaultIdentityHeader, e.token(subject))
	}
	recorder := httptest.NewRecorder()
	e.handler.ServeHTTP(recorder, request)
	return recorder
}

func (e *accessEnv) expect(method, target, subject string, body []byte, status int) *httptest.ResponseRecorder {
	e.t.Helper()
	recorder := e.request(method, target, subject, body)
	if recorder.Code != status {
		e.t.Fatalf("%s %s as %q: status %d, want %d: %s", method, target, subject, recorder.Code, status, recorder.Body.String())
	}
	return recorder
}

func listedNames(t *testing.T, recorder *httptest.ResponseRecorder) []string {
	t.Helper()
	var response listResponseJSON
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode list: %v: %s", err, recorder.Body.String())
	}
	names := make([]string, 0, len(response.Items))
	for _, item := range response.Items {
		names = append(names, item.Name)
	}
	sort.Strings(names)
	return names
}

func visibleBucketIDs(t *testing.T, recorder *httptest.ResponseRecorder) ([]string, map[string]instanceInfo) {
	t.Helper()
	var response struct {
		Default   string         `json:"default"`
		Instances []instanceInfo `json:"instances"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(response.Instances))
	byID := make(map[string]instanceInfo)
	for _, instance := range response.Instances {
		ids = append(ids, instance.ID)
		byID[instance.ID] = instance
	}
	if len(ids) > 0 && response.Default != ids[0] {
		t.Fatalf("default = %q, want the first visible bucket %q", response.Default, ids[0])
	}
	return ids, byID
}

func requireForbidden(t *testing.T, recorder *httptest.ResponseRecorder, action string) {
	t.Helper()
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Action  string `json:"action"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode 403: %v: %s", err, recorder.Body.String())
	}
	if body.Error.Code != "forbidden" || body.Error.Action != action || body.Error.Message != "The action "+action+" is not allowed." {
		t.Fatalf("403 body = %+v, want the action %s", body.Error, action)
	}
}

func TestAccessActionsDocumentDeclaresTheTree(t *testing.T) {
	env := newAccessEnv(t, 0)
	recorder := env.expect(http.MethodGet, accessActionsPath, "", nil, http.StatusOK)
	var document struct {
		Server        string               `json:"server"`
		ResourceTypes []accessResourceType `json:"resource_types"`
		Actions       []struct {
			Name          string   `json:"name"`
			ResourceTypes []string `json:"resource_types"`
			Description   string   `json:"description"`
		} `json:"actions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if document.Server != testAudience {
		t.Fatalf("server = %q", document.Server)
	}
	parents := map[string]string{}
	for _, item := range document.ResourceTypes {
		parents[item.Name] = item.Parent
	}
	if len(parents) != 2 || parents["bucket"] != "service" || parents["prefix"] != "bucket" {
		t.Fatalf("resource types = %+v", document.ResourceTypes)
	}
	names := []string{}
	for _, action := range document.Actions {
		names = append(names, action.Name)
		if strings.Join(action.ResourceTypes, ",") != "service,bucket,prefix" || action.Description == "" {
			t.Fatalf("action %+v", action)
		}
		if action.Name == "access" {
			t.Fatal("the action access is for the access gateway")
		}
	}
	if strings.Join(names, ",") != "objects.read,objects.write,objects.delete" {
		t.Fatalf("actions = %v", names)
	}
}

func TestAccessOneBucketGrant(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("bob", "objects.read@service:infra-s3/bucket:rw")

	ids, byID := visibleBucketIDs(t, env.expect(http.MethodGet, "/api/instances", "bob", nil, http.StatusOK))
	if strings.Join(ids, ",") != "rw" {
		t.Fatalf("visible buckets = %v, want only rw", ids)
	}
	if byID["rw"].Capabilities.Write.State != capabilityDenied || byID["rw"].Operations["upload"].State != capabilityDenied {
		t.Fatalf("the capabilities must show that write is denied: %+v", byID["rw"].Capabilities)
	}

	names := listedNames(t, env.expect(http.MethodGet, "/api/list?instance=rw", "bob", nil, http.StatusOK))
	if strings.Join(names, ",") != "a/,folder/,private/,reports/,root.txt" {
		t.Fatalf("root listing = %v", names)
	}
	env.expect(http.MethodGet, "/s3?instance=rw&key=private/secret.txt", "bob", nil, http.StatusOK)
	env.expect(http.MethodGet, "/s3?instance=rw&key=root.txt", "bob", nil, http.StatusOK)
	requireForbidden(t, env.request(http.MethodPut, "/s3?instance=rw&key=new.txt", "bob", []byte("x")), actionObjectsWrite)
	requireForbidden(t, env.request(http.MethodGet, "/api/list?instance=readonly", "bob", nil), actionObjectsRead)
}

func TestAccessOnePrefixGrant(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw/prefix:reports", "objects.write@service:infra-s3/bucket:rw/prefix:reports")

	ids, _ := visibleBucketIDs(t, env.expect(http.MethodGet, "/api/instances", "carol", nil, http.StatusOK))
	if strings.Join(ids, ",") != "rw" {
		t.Fatalf("visible buckets = %v, want rw (a grant below the bucket shows it)", ids)
	}

	// The root of the bucket shows only the path to the granted folder.
	root := env.expect(http.MethodGet, "/api/list?instance=rw", "carol", nil, http.StatusOK)
	if names := listedNames(t, root); strings.Join(names, ",") != "reports/" {
		t.Fatalf("root listing = %v, want only reports/", names)
	}
	var rootResponse listResponseJSON
	_ = json.Unmarshal(root.Body.Bytes(), &rootResponse)
	if rootResponse.Access == nil || rootResponse.Access.Read || rootResponse.Access.Write || rootResponse.Access.Delete {
		t.Fatalf("root access = %+v, want all false (the match node on the bucket)", rootResponse.Access)
	}
	recursive := env.expect(http.MethodGet, "/api/list?instance=rw&delimiter=", "carol", nil, http.StatusOK)
	if names := listedNames(t, recursive); strings.Join(names, ",") != "q1.csv" {
		t.Fatalf("recursive root listing = %v, want only the objects of reports/", names)
	}

	inside := env.expect(http.MethodGet, "/api/list?instance=rw&prefix=reports/", "carol", nil, http.StatusOK)
	if names := listedNames(t, inside); strings.Join(names, ",") != "q1.csv" {
		t.Fatalf("reports/ listing = %v", names)
	}
	var insideResponse listResponseJSON
	_ = json.Unmarshal(inside.Body.Bytes(), &insideResponse)
	if insideResponse.Access == nil || !insideResponse.Access.Read || !insideResponse.Access.Write || insideResponse.Access.Delete {
		t.Fatalf("reports/ access = %+v", insideResponse.Access)
	}

	env.expect(http.MethodGet, "/s3?instance=rw&key=reports/q1.csv", "carol", nil, http.StatusOK)
	env.expect(http.MethodPut, "/s3?instance=rw&key=reports/q2.csv", "carol", []byte("c"), http.StatusNoContent)
	requireForbidden(t, env.request(http.MethodDelete, "/s3?instance=rw&key=reports/q2.csv", "carol", nil), actionObjectsDelete)
	requireForbidden(t, env.request(http.MethodGet, "/s3?instance=rw&key=private/secret.txt", "carol", nil), actionObjectsRead)
	requireForbidden(t, env.request(http.MethodGet, "/s3?instance=rw&key=root.txt", "carol", nil), actionObjectsRead)
	requireForbidden(t, env.request(http.MethodGet, "/api/list?instance=rw&prefix=private/", "carol", nil), actionObjectsRead)
	requireForbidden(t, env.request(http.MethodGet, "/api/stats?instance=rw", "carol", nil), actionObjectsRead)
	requireForbidden(t, env.request(http.MethodGet, "/open/x?instance=rw&key=private/secret.txt", "carol", nil), actionObjectsRead)

	// A copy needs objects.read on the source and objects.write on the destination.
	copyBody := []byte(`{"instance":"rw","src":"reports/q1.csv","dst":"private/q1.csv"}`)
	requireForbidden(t, env.request(http.MethodPost, "/api/copy", "carol", copyBody), actionObjectsWrite)
	env.expect(http.MethodPost, "/api/copy", "carol", []byte(`{"instance":"rw","src":"reports/q1.csv","dst":"reports/copy.csv"}`), http.StatusOK)
}

func TestAccessServiceWideGrant(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("admin", "objects.read@service:infra-s3", "objects.write@service:infra-s3", "objects.delete@service:infra-s3")

	ids, _ := visibleBucketIDs(t, env.expect(http.MethodGet, "/api/instances", "admin", nil, http.StatusOK))
	if strings.Join(ids, ",") != "readonly,rw" {
		t.Fatalf("visible buckets = %v", ids)
	}
	env.expect(http.MethodGet, "/api/list?instance=readonly", "admin", nil, http.StatusOK)
	env.expect(http.MethodPut, "/s3?instance=rw&key=root2.txt", "admin", []byte("x"), http.StatusNoContent)
	env.expect(http.MethodDelete, "/s3?instance=rw&key=root2.txt", "admin", nil, http.StatusNoContent)
	// With a grant on the service, an unknown bucket is not a secret.
	unknown := env.expect(http.MethodGet, "/api/list?instance=does-not-exist", "admin", nil, http.StatusNotFound)
	if !strings.Contains(unknown.Body.String(), "unknown_instance") {
		t.Fatalf("unknown bucket body = %s", unknown.Body.String())
	}
}

func TestAccessHiddenAndUnknownBucketsGetTheSameAnswer(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw/prefix:reports")

	for _, route := range []struct {
		method, path string
		body         string
		action       string
	}{
		{http.MethodGet, "/api/list?instance=%s", "", actionObjectsRead},
		{http.MethodGet, "/s3?instance=%s&key=readonly.txt", "", actionObjectsRead},
		{http.MethodPut, "/s3?instance=%s&key=new.txt", "x", actionObjectsWrite},
		{http.MethodDelete, "/s3?instance=%s&key=readonly.txt", "", actionObjectsDelete},
		{http.MethodGet, "/api/versions?instance=%s&key=readonly.txt", "", actionObjectsRead},
		{http.MethodPost, "/api/uploads", `{"instance":"%s","key":"new.bin","size":1}`, actionObjectsWrite},
		{http.MethodPost, "/api/delete-prefix", `{"instance":"%s","prefix":"x/"}`, actionObjectsDelete},
	} {
		answers := make([]string, 0, 2)
		for _, bucket := range []string{"readonly", "does-not-exist"} {
			target := route.path
			var body []byte
			if strings.Contains(target, "%s") {
				target = fmt.Sprintf(target, bucket)
			}
			if route.body != "" {
				if strings.Contains(route.body, "%s") {
					body = []byte(fmt.Sprintf(route.body, bucket))
				} else {
					body = []byte(route.body)
				}
			}
			recorder := env.request(route.method, target, "carol", body)
			if recorder.Code == http.StatusForbidden {
				requireForbidden(t, recorder, route.action)
			}
			answers = append(answers, fmt.Sprintf("%d %s", recorder.Code, recorder.Body.String()))
		}
		if answers[0] != answers[1] {
			t.Fatalf("%s %s: hidden bucket %q, unknown bucket %q", route.method, route.path, answers[0], answers[1])
		}
		if !strings.HasPrefix(answers[0], "403 ") {
			t.Fatalf("%s %s: answer %q, want 403", route.method, route.path, answers[0])
		}
	}

	// The page of a hidden bucket is the 404 page of an unknown bucket.
	hidden := env.request(http.MethodGet, "/-/test-auth/readonly/", "carol", nil)
	unknown := env.request(http.MethodGet, "/-/test-auth/does-not-exist/", "carol", nil)
	if hidden.Code != http.StatusNotFound || hidden.Code != unknown.Code || hidden.Body.String() != unknown.Body.String() {
		t.Fatalf("hidden page %d %q, unknown page %d %q", hidden.Code, hidden.Body.String(), unknown.Code, unknown.Body.String())
	}
	env.expect(http.MethodGet, "/-/test-auth/rw/", "carol", nil, http.StatusOK)
}

func TestAccessReadOnlyUserCannotUploadOrDelete(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("reader", "objects.read@service:infra-s3")

	list := env.expect(http.MethodGet, "/api/list?instance=rw&prefix=reports/", "reader", nil, http.StatusOK)
	var response listResponseJSON
	_ = json.Unmarshal(list.Body.Bytes(), &response)
	if response.Access == nil || !response.Access.Read || response.Access.Write || response.Access.Delete {
		t.Fatalf("access = %+v, want read only", response.Access)
	}
	env.expect(http.MethodGet, "/s3?instance=rw&key=reports/q1.csv", "reader", nil, http.StatusOK)
	requireForbidden(t, env.request(http.MethodPut, "/s3?instance=rw&key=reports/new.csv", "reader", []byte("x")), actionObjectsWrite)
	requireForbidden(t, env.request(http.MethodDelete, "/s3?instance=rw&key=reports/q1.csv", "reader", nil), actionObjectsDelete)
	requireForbidden(t, env.request(http.MethodPost, "/api/uploads", "reader", []byte(`{"instance":"rw","key":"reports/big.bin","size":10}`)), actionObjectsWrite)
	requireForbidden(t, env.request(http.MethodPost, "/api/rename", "reader", []byte(`{"instance":"rw","src":"reports/q1.csv","dst":"reports/q9.csv"}`)), actionObjectsDelete)
	requireForbidden(t, env.request(http.MethodPost, "/api/delete-prefix", "reader", []byte(`{"instance":"rw","prefix":"reports/"}`)), actionObjectsDelete)
	requireForbidden(t, env.request(http.MethodPost, "/api/copy", "reader", []byte(`{"instance":"rw","src":"reports/q1.csv","dst":"reports/q9.csv"}`)), actionObjectsWrite)
	requireForbidden(t, env.request(http.MethodPost, "/api/versions/restore", "reader", []byte(`{"instance":"rw","key":"reports/q1.csv","version":"v1"}`)), actionObjectsWrite)
	env.readWrite.mu.Lock()
	_, stillThere := env.readWrite.objects["tenant/reports/q1.csv"]
	_, created := env.readWrite.objects["tenant/reports/new.csv"]
	env.readWrite.mu.Unlock()
	if !stillThere || created {
		t.Fatalf("a refused operation changed the bucket: q1 present=%t new present=%t", stillThere, created)
	}
	_, byID := visibleBucketIDs(t, env.expect(http.MethodGet, "/api/instances", "reader", nil, http.StatusOK))
	if byID["rw"].Capabilities.Write.State != capabilityDenied || byID["rw"].Capabilities.Delete.State != capabilityDenied {
		t.Fatalf("capabilities = %+v", byID["rw"].Capabilities)
	}
}

func TestAccessJobsKeepTheirResource(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw/prefix:reports")
	env.pdp.grant("dave", "objects.read@service:infra-s3/bucket:rw/prefix:private")

	recorder := env.request(http.MethodGet, "/api/stats?instance=rw&prefix=reports/", "carol", nil)
	if recorder.Code != http.StatusOK && recorder.Code != http.StatusAccepted {
		t.Fatalf("stats: %d %s", recorder.Code, recorder.Body.String())
	}
	var job struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &job); err != nil || job.ID == "" {
		t.Fatalf("job id: %v %s", err, recorder.Body.String())
	}
	env.expect(http.MethodGet, "/api/jobs/"+job.ID, "carol", nil, http.StatusOK)
	hidden := env.expect(http.MethodGet, "/api/jobs/"+job.ID, "dave", nil, http.StatusNotFound)
	unknown := env.expect(http.MethodGet, "/api/jobs/job_does_not_exist", "dave", nil, http.StatusNotFound)
	if hidden.Body.String() != unknown.Body.String() {
		t.Fatalf("hidden job %q, unknown job %q", hidden.Body.String(), unknown.Body.String())
	}
	env.expect(http.MethodPost, "/api/jobs/"+job.ID+"/cancel", "dave", []byte(`{}`), http.StatusNotFound)
}

func TestAccessInvalidTokensGet401(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("bob", "objects.read@service:infra-s3")
	now := time.Now().Unix()
	otherKey, _ := newTestIdentityKey(t)
	valid := map[string]any{"iss": testIssuer, "sub": "bob", "aud": testAudience, "iat": now, "exp": now + 300}
	with := func(changes map[string]any) map[string]any {
		out := make(map[string]any, len(valid))
		for key, value := range valid {
			out[key] = value
		}
		for key, value := range changes {
			if value == nil {
				delete(out, key)
			} else {
				out[key] = value
			}
		}
		return out
	}
	header := map[string]any{"alg": "EdDSA", "typ": "JWT"}
	tokens := map[string]string{
		"other key":      signTestToken(t, otherKey, header, valid),
		"wrong issuer":   signTestToken(t, env.key, header, with(map[string]any{"iss": "https://evil"})),
		"wrong audience": signTestToken(t, env.key, header, with(map[string]any{"aud": "infra-other"})),
		"expired":        signTestToken(t, env.key, header, with(map[string]any{"iat": now - 400, "exp": now - 100})),
		"too long":       signTestToken(t, env.key, header, with(map[string]any{"exp": now + 3600})),
		"no subject":     signTestToken(t, env.key, header, with(map[string]any{"sub": nil})),
		"no expiry":      signTestToken(t, env.key, header, with(map[string]any{"exp": nil})),
		"future iat":     signTestToken(t, env.key, header, with(map[string]any{"iat": now + 120, "exp": now + 200})),
		"alg none":       signTestToken(t, env.key, map[string]any{"alg": "none"}, valid),
		"crit header":    signTestToken(t, env.key, map[string]any{"alg": "EdDSA", "crit": []string{"x"}}, valid),
		"wrong typ":      signTestToken(t, env.key, map[string]any{"alg": "EdDSA", "typ": "at+jwt"}, valid),
		"garbage":        "not.a.token",
	}
	for name, token := range tokens {
		request := httptest.NewRequest(http.MethodGet, "/api/instances", nil)
		request.Header.Set(defaultIdentityHeader, token)
		recorder := httptest.NewRecorder()
		env.handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), `"unauthenticated"`) {
			t.Fatalf("%s: status %d %s, want 401", name, recorder.Code, recorder.Body.String())
		}
	}

	good := env.token("bob")
	// The token is accepted only in its header: not in a cookie, not in a query parameter.
	for name, prepare := range map[string]func(*http.Request){
		"no token": func(*http.Request) {},
		"cookie":   func(r *http.Request) { r.AddCookie(&http.Cookie{Name: defaultIdentityHeader, Value: good}) },
		"query":    func(r *http.Request) { r.URL.RawQuery = "token=" + url.QueryEscape(good) },
		"two copies": func(r *http.Request) {
			r.Header.Add(defaultIdentityHeader, good)
			r.Header.Add(defaultIdentityHeader, good)
		},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/instances", nil)
		prepare(request)
		recorder := httptest.NewRecorder()
		env.handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status %d, want 401", name, recorder.Code)
		}
	}
	for _, path := range []string{"/", "/api/build", "/-/test-auth/rw/"} {
		env.expect(http.MethodGet, path, "", nil, http.StatusUnauthorized)
	}
	// The probes and the list of actions need no token.
	env.expect(http.MethodGet, "/healthz", "", nil, http.StatusOK)
	env.expect(http.MethodGet, accessActionsPath, "", nil, http.StatusOK)
	if len(env.pdp.received()) != 0 {
		t.Fatal("a request without a valid token must not reach the PDP")
	}
	env.expect(http.MethodGet, "/api/instances", "bob", nil, http.StatusOK)
}

func TestAccessFailsClosedWhenThePDPFails(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("admin", "objects.read@service:infra-s3")
	env.pdp.setStatus(http.StatusInternalServerError)
	ids, _ := visibleBucketIDs(t, env.expect(http.MethodGet, "/api/instances", "admin", nil, http.StatusOK))
	if len(ids) != 0 {
		t.Fatalf("visible buckets = %v, want none when the PDP fails", ids)
	}
	requireForbidden(t, env.request(http.MethodGet, "/s3?instance=rw&key=reports/q1.csv", "admin", nil), actionObjectsRead)
	// A failure is never kept: the next request asks again.
	env.pdp.setStatus(http.StatusOK)
	env.expect(http.MethodGet, "/s3?instance=rw&key=reports/q1.csv", "admin", nil, http.StatusOK)

	// A PDP that does not answer before the timeout gives false.
	env.app.pdp.timeout = 50 * time.Millisecond
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`{"decision": true}`))
	}))
	defer slow.Close()
	env.app.pdp.baseURL = slow.URL
	requireForbidden(t, env.request(http.MethodGet, "/s3?instance=rw&key=private/secret.txt", "admin", nil), actionObjectsRead)
}

func TestAccessRequestsToThePDP(t *testing.T) {
	env := newAccessEnv(t, 30*time.Second)
	env.pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw/prefix:reports")
	request := httptest.NewRequest(http.MethodGet, "/s3?instance=rw&key=reports/q1.csv", nil)
	request.Header.Set(defaultIdentityHeader, env.token("carol"))
	request.Header.Set("X-Request-ID", "req-123")
	recorder := httptest.NewRecorder()
	env.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status %d %s", recorder.Code, recorder.Body.String())
	}
	received := env.pdp.received()
	if len(received) != 2 {
		t.Fatalf("PDP requests = %d, want 2 (the visibility batch, then the node question)", len(received))
	}
	for _, item := range received {
		if item.Authorization != "Bearer "+testPDPToken || item.RequestID != "req-123" {
			t.Fatalf("headers: %+v", item)
		}
	}
	batch := received[0]
	if batch.Path != "/access/v1/evaluations" {
		t.Fatalf("first path %s", batch.Path)
	}
	evaluations, _ := batch.Body["evaluations"].([]any)
	if len(evaluations) != 3 {
		t.Fatalf("visibility batch = %v", batch.Body)
	}
	for _, raw := range evaluations {
		item := raw.(map[string]any)
		context := item["context"].(map[string]any)
		resource := item["resource"].(map[string]any)
		if context["match"] != "subtree" || resource["type"] != "bucket" || resource["id"] != "rw" {
			t.Fatalf("visibility item = %v", item)
		}
	}
	single := received[1]
	if single.Path != "/access/v1/evaluation" {
		t.Fatalf("second path %s", single.Path)
	}
	resource, _ := json.Marshal(single.Body["resource"])
	if string(resource) != `{"id":"reports","properties":{"ancestors":[{"id":"infra-s3","type":"service"},{"id":"rw","type":"bucket"}]},"type":"prefix"}` {
		t.Fatalf("node resource = %s", resource)
	}
	if context, _ := json.Marshal(single.Body["context"]); string(context) != `{}` {
		t.Fatalf("node context = %s, want {} (the default match node)", context)
	}
	if subject, _ := json.Marshal(single.Body["subject"]); string(subject) != `{"id":"carol","type":"user"}` {
		t.Fatalf("subject = %s", subject)
	}

	// The cache answers the same questions; the match is part of its key.
	env.expect(http.MethodGet, "/s3?instance=rw&key=reports/q1.csv", "carol", nil, http.StatusOK)
	if count := len(env.pdp.received()); count != 2 {
		t.Fatalf("PDP requests after a second read = %d, want 2 (the cache)", count)
	}
	requireForbidden(t, env.request(http.MethodGet, "/s3?instance=rw&key=root.txt", "carol", nil), actionObjectsRead)
}

func TestAccessNodeOfAKey(t *testing.T) {
	env := newAccessEnv(t, 0)
	instance := env.app.instances["rw"]
	for key, want := range map[string]string{
		"":                              "service:infra-s3/bucket:rw",
		"root.txt":                      "service:infra-s3/bucket:rw",
		"reports":                       "service:infra-s3/bucket:rw",
		"reports/":                      "service:infra-s3/bucket:rw/prefix:reports",
		"reports/2026/q1.csv":           "service:infra-s3/bucket:rw/prefix:reports",
		"a b:c/x":                       "service:infra-s3/bucket:rw/prefix:a%20b%3Ac",
		"\x01ctl/x":                     "service:infra-s3/bucket:rw",
		strings.Repeat("x", 257) + "/y": "service:infra-s3/bucket:rw",
	} {
		if got := env.app.nodeResource(instance, key).path(); got != want {
			t.Fatalf("node of %q = %s, want %s", key, got, want)
		}
	}
}

func TestAccessOpenModeKeepsTheBehaviour(t *testing.T) {
	app, _, _ := testApplication(t)
	handler := app.routes()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/list?instance=rw", nil))
	if recorder.Code != http.StatusOK || strings.Contains(recorder.Body.String(), `"access"`) {
		t.Fatalf("open mode list: %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, accessActionsPath, nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"server":"stowr"`) {
		t.Fatalf("open mode actions: %d %s", recorder.Code, recorder.Body.String())
	}
}

// TestAccessEveryRouteIsChecked sends each route as a human without a grant,
// and as a human with each action on the folder private/ only. The routes name
// the folder reports/. No route may answer with data or change the bucket: the
// answer is 403 or 404 (fail closed).
func TestAccessEveryRouteIsChecked(t *testing.T) {
	env := newAccessEnv(t, 0)
	env.pdp.grant("dave",
		"objects.read@service:infra-s3/bucket:rw/prefix:private",
		"objects.write@service:infra-s3/bucket:rw/prefix:private",
		"objects.delete@service:infra-s3/bucket:rw/prefix:private")
	routes := []struct{ method, path, body string }{
		{http.MethodPost, "/api/permissions/refresh?instance=rw", ""},
		{http.MethodGet, "/api/list?instance=rw&prefix=reports/", ""},
		{http.MethodGet, "/api/stats?instance=rw&prefix=reports/", ""},
		{http.MethodGet, "/api/archive?instance=rw&prefix=reports/", ""},
		{http.MethodPost, "/api/copy", `{"instance":"rw","src":"reports/q1.csv","dst":"reports/x.csv"}`},
		{http.MethodPost, "/api/rename", `{"instance":"rw","src":"reports/q1.csv","dst":"reports/x.csv"}`},
		{http.MethodPost, "/api/delete-prefix", `{"instance":"rw","prefix":"reports/"}`},
		{http.MethodPost, "/api/uploads", `{"instance":"rw","key":"reports/x.bin","size":1}`},
		{http.MethodPost, "/api/uploads/resume", `{"resumeToken":"stowr1.cnc.AAAA"}`},
		{http.MethodGet, "/api/spreadsheet?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/api/delimited?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/api/document-count?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/api/document/word?instance=rw&key=reports/q1.docx", ""},
		{http.MethodGet, "/api/parquet?instance=rw&key=reports/q1.parquet", ""},
		{http.MethodPost, "/api/sqlite/sessions", `{"instance":"rw","key":"reports/q1.sqlite"}`},
		{http.MethodGet, "/api/json/raw?instance=rw&key=reports/q1.json", ""},
		{http.MethodGet, "/api/json/beautify?instance=rw&key=reports/q1.json", ""},
		{http.MethodGet, "/api/json/summary?instance=rw&key=reports/q1.json", ""},
		{http.MethodGet, "/api/json/tree?instance=rw&key=reports/q1.json", ""},
		{http.MethodGet, "/api/search?instance=rw&key=reports/q1.csv&q=a", ""},
		{http.MethodGet, "/api/media-info?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/api/structured-preview?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/api/archive-preview?instance=rw&key=reports/q1.zip", ""},
		{http.MethodGet, "/api/archive-entry?instance=rw&key=reports/q1.zip&entry=a", ""},
		{http.MethodPost, "/api/archive-entry/integrity", `{"instance":"rw","key":"reports/q1.zip","entry":"a"}`},
		{http.MethodPost, "/api/archive-extract", `{"instance":"rw","key":"reports/q1.zip","entries":["a"],"target":"reports/"}`},
		{http.MethodGet, "/api/versions?instance=rw&key=reports/q1.csv", ""},
		{http.MethodPost, "/api/version-counts", `{"instance":"rw","keys":["reports/q1.csv"]}`},
		{http.MethodPost, "/api/versions/restore", `{"instance":"rw","key":"reports/q1.csv","version":"v"}`},
		{http.MethodPost, "/api/integrity", `{"instance":"rw","key":"reports/q1.csv"}`},
		{http.MethodGet, "/api/inspect?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/api/image-preview?instance=rw&key=reports/q1.png", ""},
		{http.MethodGet, "/open/q1.csv?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/s3?instance=rw&key=reports/q1.csv", ""},
		{http.MethodHead, "/s3?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/s3?instance=rw&prefix=reports/", ""},
		{http.MethodPut, "/s3?instance=rw&key=reports/x.csv", "x"},
		{http.MethodDelete, "/s3?instance=rw&key=reports/q1.csv", ""},
		{http.MethodGet, "/api/jobs/job_x", ""},
		{http.MethodGet, "/api/sqlite/sessions/sql_x", ""},
	}
	for _, subject := range []string{"nobody", "dave"} {
		for _, route := range routes {
			var body []byte
			if route.body != "" {
				body = []byte(route.body)
			}
			if subject == "dave" && strings.HasPrefix(route.path, "/api/permissions/refresh") {
				// The bucket is visible to dave: the refresh needs no action on a folder.
				continue
			}
			recorder := env.request(route.method, route.path, subject, body)
			switch {
			case recorder.Code == http.StatusForbidden || recorder.Code == http.StatusNotFound:
			case recorder.Code == http.StatusBadRequest && route.path == "/api/uploads/resume":
				// A token that the server cannot open names no object.
			default:
				t.Fatalf("%s %s as %s: status %d %s", route.method, route.path, subject, recorder.Code, recorder.Body.String())
			}
		}
	}
	env.readWrite.mu.Lock()
	defer env.readWrite.mu.Unlock()
	if _, ok := env.readWrite.objects["tenant/reports/q1.csv"]; !ok {
		t.Fatal("a refused route deleted an object")
	}
	if _, ok := env.readWrite.objects["tenant/reports/x.csv"]; ok {
		t.Fatal("a refused route wrote an object")
	}

	// Each route of the server is in the list above, or needs no action.
	mux := map[string]bool{}
	for _, route := range routes {
		path := route.path
		if index := strings.IndexByte(path, '?'); index >= 0 {
			path = path[:index]
		}
		mux[path] = true
	}
	for _, path := range []string{
		"/api/permissions/refresh", "/api/list", "/api/stats", "/api/archive", "/api/copy", "/api/rename", "/api/delete-prefix",
		"/api/uploads", "/api/spreadsheet", "/api/delimited", "/api/document-count", "/api/document/word", "/api/parquet",
		"/api/sqlite/sessions", "/api/json/raw", "/api/json/beautify", "/api/json/summary", "/api/json/tree", "/api/search",
		"/api/media-info", "/api/structured-preview", "/api/archive-preview", "/api/archive-entry", "/api/archive-entry/integrity",
		"/api/archive-extract", "/api/versions", "/api/version-counts", "/api/versions/restore", "/api/integrity", "/api/inspect",
		"/api/image-preview", "/s3",
	} {
		if !mux[path] {
			t.Fatalf("route %s has no case in this test", path)
		}
	}
}
