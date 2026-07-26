package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
)

func newGCSBackendForTest(t *testing.T, endpoint, bucket, mode, credentialsFile string) *gcsBackend {
	t.Helper()
	auth, err := newSharedAuthentication(authConfig{
		ID: "test-gcs", Provider: "gcs", Mode: mode, Endpoint: endpoint, CredentialsFile: credentialsFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(auth.close)
	backend, err := newGCSBackendWithAuthentication(bucketConfig{
		ID: "test-bucket", AuthID: auth.cfg.ID, Provider: "gcs", Bucket: bucket,
	}, auth)
	if err != nil {
		t.Fatal(err)
	}
	return backend
}

func newAnonymousGCSBackendForTest(t *testing.T, endpoint, bucket string) *gcsBackend {
	return newGCSBackendForTest(t, endpoint, bucket, "anonymous", "")
}

func TestGCSServiceAccountJWTAndPermissionDiscovery(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	var tokenCalls atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			tokenCalls.Add(1)
			if err := r.ParseForm(); err != nil {
				t.Errorf("ParseForm: %v", err)
				http.Error(w, "bad form", http.StatusBadRequest)
				return
			}
			if got := r.Form.Get("grant_type"); got != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
				t.Errorf("grant_type = %q", got)
			}
			verifyServiceAccountAssertion(t, r.Form.Get("assertion"), &privateKey.PublicKey, server.URL+"/token")
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"access_token":"test-token","expires_in":3600,"token_type":"Bearer"}`)
		case "/storage/v1/b/test-bucket/iam/testPermissions":
			if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
				t.Errorf("Authorization = %q", got)
			}
			permissions := append([]string(nil), r.URL.Query()["permissions"]...)
			sort.Strings(permissions)
			want := []string{"storage.objects.create", "storage.objects.delete", "storage.objects.get", "storage.objects.list"}
			if strings.Join(permissions, ",") != strings.Join(want, ",") {
				t.Errorf("permissions = %v", permissions)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"permissions":["storage.objects.list","storage.objects.get","storage.objects.create"]}`)
		case "/storage/v1/b/test-bucket/o":
			if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
				t.Errorf("Authorization = %q", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"items":[{"name":"folder/file.txt","size":"12","updated":"2026-01-02T03:04:05Z","etag":"etag","contentType":"text/plain"}]}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	credentialsPath := writeTestServiceAccount(t, privateKey, server.URL+"/token")
	backend := newGCSBackendForTest(t, server.URL, "test-bucket", "service_account", credentialsPath)

	discovered, err := backend.DiscoverCapabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !discovered.States[permissionRead].Allowed || !discovered.States[permissionWrite].Allowed || discovered.States[permissionDelete].Allowed {
		t.Fatalf("unexpected capabilities: %+v", discovered.States)
	}
	page, err := backend.List(context.Background(), listOptions{Prefix: "folder/", MaxResults: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Objects) != 1 || page.Objects[0].Key != "folder/file.txt" || page.Objects[0].Size != 12 {
		t.Fatalf("unexpected list page: %+v", page)
	}
	if got := tokenCalls.Load(); got != 1 {
		t.Fatalf("token endpoint calls = %d, want 1", got)
	}

	u := backend.objectMetadataURL("dir/a b+é.txt", nil)
	if got, want := u.EscapedPath(), "/storage/v1/b/test-bucket/o/dir%2Fa%20b%2B%C3%A9.txt"; got != want {
		t.Fatalf("escaped path = %q, want %q", got, want)
	}
}

func TestGCSRewriteFollowsContinuationToken(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if !strings.Contains(r.URL.EscapedPath(), "/rewriteTo/") {
			t.Errorf("path = %q", r.URL.EscapedPath())
		}
		w.Header().Set("Content-Type", "application/json")
		if calls.Load() == 1 {
			if got := r.URL.Query().Get("rewriteToken"); got != "" {
				t.Errorf("first rewrite token = %q", got)
			}
			_, _ = io.WriteString(w, `{"done":false,"rewriteToken":"next-token"}`)
			return
		}
		if got := r.URL.Query().Get("rewriteToken"); got != "next-token" {
			t.Errorf("second rewrite token = %q", got)
		}
		_, _ = io.WriteString(w, `{"done":true}`)
	}))
	defer server.Close()

	backend := newAnonymousGCSBackendForTest(t, server.URL, "bucket")
	if err := backend.Copy(context.Background(), "source/one", "destination/two"); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("rewrite calls = %d", got)
	}
}

func writeTestServiceAccount(t *testing.T, key *rsa.PrivateKey, tokenURI string) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	payload := map[string]string{
		"type":           "service_account",
		"project_id":     "test-project",
		"private_key_id": "test-key",
		"private_key":    string(keyPEM),
		"client_email":   "browser@test-project.iam.gserviceaccount.com",
		"token_uri":      tokenURI,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "service-account.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func verifyServiceAccountAssertion(t *testing.T, assertion string, publicKey *rsa.PublicKey, expectedAudience string) {
	t.Helper()
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT parts = %d", len(parts))
	}
	decode := func(value string) []byte {
		data, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil {
			t.Fatalf("decode JWT: %v", err)
		}
		return data
	}
	var header map[string]any
	if err := json.Unmarshal(decode(parts[0]), &header); err != nil {
		t.Fatal(err)
	}
	if header["alg"] != "RS256" || header["kid"] != "test-key" {
		t.Fatalf("JWT header = %+v", header)
	}
	var claims map[string]any
	if err := json.Unmarshal(decode(parts[1]), &claims); err != nil {
		t.Fatal(err)
	}
	if claims["aud"] != expectedAudience || claims["scope"] != gcsOAuthScope {
		t.Fatalf("JWT claims = %+v", claims)
	}
	unsigned := parts[0] + "." + parts[1]
	digest := sha256.Sum256([]byte(unsigned))
	if err := rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, digest[:], decode(parts[2])); err != nil {
		t.Fatalf("verify JWT signature: %v", err)
	}
}

func TestGCSAPIURLPreservesEndpointPath(t *testing.T) {
	t.Parallel()
	backend := &gcsBackend{endpoint: mustParseURL(t, "https://example.test/emulator/v1")}
	u := backend.apiURL("storage/v1/b/a%20bucket/o", url.Values{"prefix": {"a/b"}})
	if got, want := u.String(), "https://example.test/emulator/v1/storage/v1/b/a%20bucket/o?prefix=a%2Fb"; got != want {
		t.Fatalf("URL = %q, want %q", got, want)
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(fmt.Errorf("parse URL: %w", err))
	}
	return u
}

func TestGCSGetPassesThroughNotModified(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != `"etag"` {
			t.Errorf("If-None-Match = %q", got)
		}
		if got := r.URL.Query().Get("alt"); got != "media" {
			t.Errorf("alt = %q", got)
		}
		w.Header().Set("ETag", `"etag"`)
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()

	backend := newAnonymousGCSBackendForTest(t, server.URL, "bucket")
	headers := make(http.Header)
	headers.Set("If-None-Match", `"etag"`)
	response, err := backend.Get(context.Background(), "object.txt", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotModified || response.Header.Get("ETag") != `"etag"` {
		t.Fatalf("response = %+v", response)
	}
}

func TestGCSResumableUploadLifecycle(t *testing.T) {
	t.Parallel()
	var server *httptest.Server
	var chunkCalls atomic.Int32
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/upload/storage/v1/b/bucket/o"):
			if got := r.URL.Query().Get("uploadType"); got != "resumable" {
				t.Errorf("uploadType = %q", got)
			}
			if got := r.Header.Get("X-Upload-Content-Length"); got != "10" {
				t.Errorf("content length hint = %q", got)
			}
			w.Header().Set("Location", server.URL+"/resumable/session-1")
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPut && r.URL.Path == "/resumable/session-1":
			rangeHeader := r.Header.Get("Content-Range")
			if rangeHeader == "bytes */10" {
				w.Header().Set("Range", "bytes=0-4")
				w.WriteHeader(http.StatusPermanentRedirect)
				return
			}
			call := chunkCalls.Add(1)
			if call == 1 {
				if rangeHeader != "bytes 0-4/10" {
					t.Errorf("first range = %q", rangeHeader)
				}
				w.Header().Set("Range", "bytes=0-4")
				w.WriteHeader(http.StatusPermanentRedirect)
				return
			}
			if rangeHeader != "bytes 5-9/10" {
				t.Errorf("second range = %q", rangeHeader)
			}
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodDelete && r.URL.Path == "/resumable/session-1":
			w.WriteHeader(499)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	backend := newAnonymousGCSBackendForTest(t, server.URL, "bucket")
	session, err := backend.InitiateResumable(context.Background(), "large.bin", 10, "application/octet-stream")
	if err != nil {
		t.Fatal(err)
	}
	next, complete, err := backend.UploadResumableChunk(context.Background(), session, strings.NewReader("12345"), 0, 5, 10, "application/octet-stream")
	if err != nil || complete || next != 5 {
		t.Fatalf("first chunk = next %d complete %v err %v", next, complete, err)
	}
	queried, complete, err := backend.QueryResumable(context.Background(), session, 10)
	if err != nil || complete || queried != 5 {
		t.Fatalf("query = next %d complete %v err %v", queried, complete, err)
	}
	next, complete, err = backend.UploadResumableChunk(context.Background(), session, strings.NewReader("67890"), 5, 5, 10, "application/octet-stream")
	if err != nil || !complete || next != 10 {
		t.Fatalf("second chunk = next %d complete %v err %v", next, complete, err)
	}
	if err := backend.AbortResumable(context.Background(), session); err != nil {
		t.Fatal(err)
	}
}

func TestGCSResumableURLRejectsUnexpectedHost(t *testing.T) {
	t.Parallel()
	backend := newAnonymousGCSBackendForTest(t, "https://storage.googleapis.com", "bucket")
	if _, err := backend.validateResumableURL("https://attacker.example/upload"); err == nil {
		t.Fatal("unexpected resumable host was accepted")
	}
	if got := resumableNextOffset("bytes=0-1048575"); got != 1048576 {
		t.Fatalf("next offset = %d", got)
	}
}

func TestGCSGetForwardsRangeResumeHeaders(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Range"); got != "bytes=100-" {
			t.Errorf("Range = %q", got)
		}
		if got := r.Header.Get("If-Range"); got != `"etag"` {
			t.Errorf("If-Range = %q", got)
		}
		if got := r.URL.Query().Get("alt"); got != "media" {
			t.Errorf("alt = %q", got)
		}
		w.Header().Set("Content-Range", "bytes 100-102/103")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "end")
	}))
	defer server.Close()

	backend := newAnonymousGCSBackendForTest(t, server.URL, "bucket")
	headers := make(http.Header)
	headers.Set("Range", "bytes=100-")
	headers.Set("If-Range", `"etag"`)
	response, err := backend.Get(context.Background(), "object.bin", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d", response.StatusCode)
	}
}
