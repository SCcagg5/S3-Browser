package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCurrentBuildInfoUsesInjectedIdentity(t *testing.T) {
	previousVersion, previousCommit, previousDate := buildVersion, buildCommit, buildDate
	t.Cleanup(func() {
		buildVersion, buildCommit, buildDate = previousVersion, previousCommit, previousDate
	})
	buildVersion = "v1.2.3"
	buildCommit = "0123456789abcdef"
	buildDate = "2026-07-24T12:00:00Z"
	info := currentBuildInfo()
	if info.ShortCommit != "012345678" {
		t.Fatalf("ShortCommit = %q", info.ShortCommit)
	}
	if info.Display != "v1.2.3 · 012345678" {
		t.Fatalf("Display = %q", info.Display)
	}
}

func TestBuildIdentityEndpoints(t *testing.T) {
	previousVersion, previousCommit := buildVersion, buildCommit
	t.Cleanup(func() { buildVersion, buildCommit = previousVersion, previousCommit })
	buildVersion = "v9.8.7"
	buildCommit = "abcdef1234567890"

	app, _, _ := testApplication(t)
	for _, endpoint := range []string{"/api/build", "/api/instances"} {
		recorder := httptest.NewRecorder()
		app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, endpoint, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body = %s", endpoint, recorder.Code, recorder.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		buildPayload := payload
		if endpoint == "/api/instances" {
			value, ok := payload["build"].(map[string]any)
			if !ok {
				t.Fatalf("instances response does not contain build identity: %#v", payload)
			}
			buildPayload = value
		}
		if buildPayload["version"] != "v9.8.7" || buildPayload["shortCommit"] != "abcdef123" {
			t.Fatalf("unexpected build identity at %s: %#v", endpoint, buildPayload)
		}
	}
}
