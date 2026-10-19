package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

// fakePDP answers /access/v1/evaluation and /access/v1/evaluations. A grant is
// "<action>@<path>", where the path is "service:<id>[/<type>:<encoded id>]...".
type fakePDP struct {
	service string
	token   string
	parents map[string]string

	mu       sync.Mutex
	grants   map[string][]string
	unknown  map[string]bool
	status   int
	requests []fakePDPRequest
}

type fakePDPRequest struct {
	Path          string
	Authorization string
	RequestID     string
	Body          map[string]any
}

func newFakePDP() *fakePDP {
	return &fakePDP{
		service: testAudience,
		token:   testPDPToken,
		parents: map[string]string{"bucket": "service", "prefix": "bucket"},
		grants:  make(map[string][]string),
		unknown: make(map[string]bool),
		status:  http.StatusOK,
	}
}

func (f *fakePDP) grant(subject string, entries ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.grants[subject] = append(f.grants[subject], entries...)
}

func (f *fakePDP) setStatus(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status = status
}

func (f *fakePDP) received() []fakePDPRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakePDPRequest(nil), f.requests...)
}

// testEncodeID is the percent-encoding of contract 11.8, written again here so
// that a fault in the encoder of the server cannot hide itself.
func testEncodeID(id string) string {
	var b strings.Builder
	for _, c := range []byte(id) {
		if strings.IndexByte("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func (f *fakePDP) chain(resource map[string]any) ([]string, bool) {
	kind, _ := resource["type"].(string)
	id, _ := resource["id"].(string)
	type node struct{ kind, id string }
	nodes := make([]node, 0, 4)
	if properties, ok := resource["properties"].(map[string]any); ok {
		ancestors, _ := properties["ancestors"].([]any)
		for _, raw := range ancestors {
			item, _ := raw.(map[string]any)
			itemKind, _ := item["type"].(string)
			itemID, _ := item["id"].(string)
			nodes = append(nodes, node{itemKind, itemID})
		}
	}
	if kind != "service" && len(nodes) == 0 {
		nodes = append(nodes, node{"service", f.service})
	}
	nodes = append(nodes, node{kind, id})
	if nodes[0] != (node{"service", f.service}) {
		return nil, false
	}
	for index := 1; index < len(nodes); index++ {
		if f.parents[nodes[index].kind] != nodes[index-1].kind {
			return nil, false
		}
	}
	out := make([]string, 0, len(nodes))
	for _, item := range nodes {
		out = append(out, item.kind+":"+testEncodeID(item.id))
	}
	return out, true
}

func grantMatches(entry, action string, chain []string, subtree bool) bool {
	name, path, _ := strings.Cut(entry, "@")
	if name != action {
		return false
	}
	granted := strings.Split(path, "/")
	if len(granted) <= len(chain) {
		for index := range granted {
			if granted[index] != chain[index] {
				return false
			}
		}
		return true
	}
	if !subtree {
		return false
	}
	for index := range chain {
		if granted[index] != chain[index] {
			return false
		}
	}
	return true
}

func (f *fakePDP) decide(subject, action map[string]any, resource map[string]any, context any) map[string]any {
	match := "node"
	if context != nil {
		values, ok := context.(map[string]any)
		if !ok {
			return map[string]any{"decision": false, "context": map[string]any{"reason": "invalid_request"}}
		}
		if raw, found := values["match"]; found {
			text, isText := raw.(string)
			if !isText || (text != "node" && text != "subtree") {
				return map[string]any{"decision": false, "context": map[string]any{"reason": "invalid_request"}}
			}
			match = text
		}
	}
	subjectID, _ := subject["id"].(string)
	if f.unknown[subjectID] {
		return map[string]any{"decision": false, "context": map[string]any{"reason": "unknown_subject"}}
	}
	chain, ok := f.chain(resource)
	if !ok {
		return map[string]any{"decision": false, "context": map[string]any{"reason": "invalid_resource"}}
	}
	name, _ := action["name"].(string)
	for _, entry := range f.grants[subjectID] {
		if grantMatches(entry, name, chain, match == "subtree") {
			return map[string]any{"decision": true}
		}
	}
	return map[string]any{"decision": false}
}

func (f *fakePDP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, fakePDPRequest{
		Path: r.URL.Path, Authorization: r.Header.Get("Authorization"), RequestID: r.Header.Get("X-Request-ID"), Body: body,
	})
	reply := func(status int, value any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
	}
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		reply(http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	if f.status != http.StatusOK {
		reply(f.status, map[string]any{"error": "test status"})
		return
	}
	subject, _ := body["subject"].(map[string]any)
	switch r.URL.Path {
	case "/access/v1/evaluation":
		action, _ := body["action"].(map[string]any)
		resource, _ := body["resource"].(map[string]any)
		reply(http.StatusOK, f.decide(subject, action, resource, body["context"]))
	case "/access/v1/evaluations":
		items, _ := body["evaluations"].([]any)
		out := make([]any, 0, len(items))
		for _, raw := range items {
			item, _ := raw.(map[string]any)
			itemSubject := subject
			if value, ok := item["subject"].(map[string]any); ok {
				itemSubject = value
			}
			action, _ := item["action"].(map[string]any)
			resource, _ := item["resource"].(map[string]any)
			// AuthZEN 1.0, 7.1: the context of an item replaces the default context.
			context, found := item["context"]
			if !found {
				context = body["context"]
			}
			out = append(out, f.decide(itemSubject, action, resource, context))
		}
		reply(http.StatusOK, map[string]any{"evaluations": out})
	default:
		reply(http.StatusNotFound, map[string]any{"error": "not found"})
	}
}
