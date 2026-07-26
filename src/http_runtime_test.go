package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSameOriginMutationMiddlewareRejectsCrossSiteBrowserRequest(t *testing.T) {
	t.Parallel()
	handler := sameOriginMutationMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "https://browser.example/api/delete", nil)
	request.Host = "browser.example"
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "cross_site_request_blocked") {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestSameOriginMutationMiddlewareUsesRequestHostNotForwardedHost(t *testing.T) {
	t.Parallel()
	handler := sameOriginMutationMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "https://internal.example/api/delete", nil)
	request.Host = "internal.example"
	request.Header.Set("Origin", "https://attacker.example")
	request.Header.Set("X-Forwarded-Host", "attacker.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "origin_mismatch") {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestSameOriginMutationMiddlewareAllowsMatchingOrigin(t *testing.T) {
	t.Parallel()
	handler := sameOriginMutationMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "https://browser.example/api/upload", nil)
	request.Host = "browser.example"
	request.Header.Set("Origin", "https://browser.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestTraceIsNotTreatedAsSafeForCrossSiteChecks(t *testing.T) {
	t.Parallel()
	handler := sameOriginMutationMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodTrace, "https://browser.example/api/instances", nil)
	request.Host = "browser.example"
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
}

func TestResourceBudgetEnforcesRequestAndByteCeilings(t *testing.T) {
	t.Parallel()
	budget := newResourceBudget(runtimePolicy{MaxStorageRequestsPerRequest: 1, MaxStorageBytesPerRequest: 4})
	if err := budget.consumeRequest(); err != nil {
		t.Fatalf("first request: %v", err)
	}
	if err := budget.consumeRequest(); err == nil {
		t.Fatal("second request unexpectedly stayed within budget")
	}

	reader := &budgetReadCloser{body: io.NopCloser(strings.NewReader("abcdef")), budget: budget}
	buffer := make([]byte, 6)
	read, err := reader.Read(buffer)
	if read != 6 {
		t.Fatalf("read = %d, want 6", read)
	}
	if err == nil {
		t.Fatal("oversized body read unexpectedly stayed within budget")
	}
	if _, ok := resourceLimitAPIError(err); !ok {
		t.Fatalf("error = %T %v, want resource limit", err, err)
	}
}

func TestAcquireGateHonorsCanceledContext(t *testing.T) {
	t.Parallel()
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := acquireGate(ctx, gate); err == nil {
		t.Fatal("acquireGate unexpectedly ignored cancellation")
	}
}

func TestHealthURLFromListen(t *testing.T) {
	tests := []struct {
		listen string
		want   string
	}{
		{listen: ":8080", want: "http://127.0.0.1:8080/healthz"},
		{listen: "0.0.0.0:9090", want: "http://127.0.0.1:9090/healthz"},
		{listen: "[::]:8081", want: "http://127.0.0.1:8081/healthz"},
	}
	for _, test := range tests {
		if got := healthURLFromListen(test.listen); got != test.want {
			t.Errorf("healthURLFromListen(%q) = %q, want %q", test.listen, got, test.want)
		}
	}
}
