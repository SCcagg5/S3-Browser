package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func testPDPClient(url string, maxEvaluations int, cacheTTL time.Duration) *pdpClient {
	return newPDPClient(accessConfig{
		PDPURL: url, PDPToken: testPDPToken, PDPTimeout: 2 * time.Second, PDPCacheTTL: cacheTTL, PDPMaxEvaluations: maxEvaluations,
	})
}

func prefixQuestion(id string, subtree bool) accessQuestion {
	return accessQuestion{
		Action: actionObjectsRead,
		Resource: accessResource{Type: resourcePrefix, ID: id, Ancestors: []accessNode{
			{Type: resourceService, ID: testAudience}, {Type: resourceBucket, ID: "rw"},
		}},
		Subtree: subtree,
	}
}

func TestPDPClientSplitsBatchesAtMaxEvaluations(t *testing.T) {
	t.Parallel()
	pdp := newFakePDP()
	pdp.grant("carol", "objects.read@service:infra-s3/bucket:rw/prefix:b", "objects.read@service:infra-s3/bucket:rw/prefix:e")
	server := httptest.NewServer(pdp)
	defer server.Close()
	client := testPDPClient(server.URL, 2, 0)
	questions := []accessQuestion{prefixQuestion("a", true), prefixQuestion("b", true), prefixQuestion("c", true), prefixQuestion("d", true), prefixQuestion("e", true), prefixQuestion("b", true)}
	decisions := client.decide(context.Background(), "req-1", "carol", questions)
	got := ""
	for _, decision := range decisions {
		if decision.Allowed {
			got += "1"
		} else {
			got += "0"
		}
	}
	if got != "010011" {
		t.Fatalf("decisions = %s", got)
	}
	received := pdp.received()
	// Five distinct questions in batches of two: 2 + 2 + 1. The last call uses the evaluation API.
	if len(received) != 3 || received[0].Path != pdpEvaluationsPath || received[2].Path != pdpEvaluationPath {
		t.Fatalf("calls = %+v", received)
	}
	for _, item := range received[:2] {
		if evaluations, _ := item.Body["evaluations"].([]any); len(evaluations) != 2 {
			t.Fatalf("batch = %v", item.Body)
		}
	}
}

func TestPDPClientFailsClosedOnInvalidAnswers(t *testing.T) {
	t.Parallel()
	for name, answer := range map[string]string{
		"null decision":     `{"decision": null}`,
		"text decision":     `{"decision": "true"}`,
		"no decision":       `{}`,
		"context not obj":   `{"decision": true, "context": "x"}`,
		"not json":          `decision: true`,
		"wrong batch count": `{"evaluations": [{"decision": true}]}`,
	} {
		answer := answer
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(answer))
		}))
		client := testPDPClient(server.URL, 64, time.Minute)
		questions := []accessQuestion{prefixQuestion("a", false)}
		if strings.Contains(name, "batch") {
			questions = append(questions, prefixQuestion("b", false))
		}
		for _, decision := range client.decide(context.Background(), "req", "carol", questions) {
			if decision.Allowed || decision.Source != "error" {
				t.Fatalf("%s: decision %+v, want false from error", name, decision)
			}
		}
		if len(client.cache) != 0 {
			t.Fatalf("%s: a failure was kept in the cache", name)
		}
		server.Close()
	}
}

func TestPDPClientReadsUnknownSubjectOnlyOnFalse(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"evaluations": [{"decision": false, "context": {"reason": "unknown_subject"}}, {"decision": true, "context": {"reason": "unknown_subject"}}, {"decision": false, "context": {"reason": "invalid_resource"}}]}`))
	}))
	defer server.Close()
	client := testPDPClient(server.URL, 64, 0)
	decisions := client.decide(context.Background(), "req", "leaver", []accessQuestion{prefixQuestion("a", false), prefixQuestion("b", false), prefixQuestion("c", false)})
	if !decisions[0].UnknownSubject || decisions[1].UnknownSubject || decisions[2].UnknownSubject || !decisions[1].Allowed {
		t.Fatalf("decisions = %+v", decisions)
	}
}

func TestPDPClientCacheKeyHoldsTheMatch(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		calls++
		mu.Unlock()
		context, _ := body["context"].(map[string]any)
		_ = json.NewEncoder(w).Encode(map[string]any{"decision": context["match"] == "subtree"})
	}))
	defer server.Close()
	client := testPDPClient(server.URL, 64, time.Minute)
	now := time.Unix(1_800_000_000, 0)
	client.now = func() time.Time { return now }
	bucket := accessResource{Type: resourceBucket, ID: "rw", Ancestors: []accessNode{{Type: resourceService, ID: testAudience}}}
	subtree := client.decide(context.Background(), "r", "carol", []accessQuestion{{Action: actionObjectsRead, Resource: bucket, Subtree: true}})
	node := client.decide(context.Background(), "r", "carol", []accessQuestion{{Action: actionObjectsRead, Resource: bucket}})
	if !subtree[0].Allowed || node[0].Allowed || node[0].Source != "pdp" {
		t.Fatalf("a subtree answer answered a node question: subtree %+v node %+v", subtree, node)
	}
	again := client.decide(context.Background(), "r", "carol", []accessQuestion{{Action: actionObjectsRead, Resource: bucket}})
	mu.Lock()
	count := calls
	mu.Unlock()
	if again[0].Source != "cache" || count != 2 {
		t.Fatalf("second node question: %+v after %d calls", again, count)
	}
	now = now.Add(61 * time.Second)
	if expired := client.decide(context.Background(), "r", "carol", []accessQuestion{{Action: actionObjectsRead, Resource: bucket}}); expired[0].Source != "pdp" {
		t.Fatalf("after cache_ttl: %+v", expired)
	}
	// Another subject never reads the answer of the first one.
	if other := client.decide(context.Background(), "r", "dave", []accessQuestion{{Action: actionObjectsRead, Resource: bucket, Subtree: true}}); other[0].Source != "pdp" {
		t.Fatalf("other subject: %+v", other)
	}
}

func TestPDPClientRefusesRedirects(t *testing.T) {
	t.Parallel()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"decision": true}`))
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	client := testPDPClient(redirect.URL, 64, 0)
	if decision := client.decide(context.Background(), "r", "carol", []accessQuestion{prefixQuestion("a", false)}); decision[0].Allowed {
		t.Fatal("the client followed a redirect of the PDP")
	}
}

func TestPercentEncodeIDOfContract(t *testing.T) {
	t.Parallel()
	for id, want := range map[string]string{
		"2026/10/report.csv": "2026%2F10%2Freport.csv",
		"a:b":                "a%3Ab",
		"AZaz09-._~":         "AZaz09-._~",
		"é":                  "%C3%A9",
	} {
		if got := percentEncodeID(id); got != want {
			t.Fatalf("encode %q = %q, want %q", id, got, want)
		}
	}
}
