package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	pdpEvaluationPath  = "/access/v1/evaluation"
	pdpEvaluationsPath = "/access/v1/evaluations"

	maxPDPAnswerBytes     = 256 << 10
	pdpCacheMaxEntries    = 16384
	pdpCacheMaxBytes      = 8 << 20
	pdpCacheEntryOverhead = 96
	reasonUnknownSubject  = "unknown_subject"
)

// accessNode is one node of the resource tree: its type and its id.
type accessNode struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// accessResource is the resource of a question: the node and the chain of its
// ancestors from the service to its parent (contract 11.5).
type accessResource struct {
	Type      string
	ID        string
	Ancestors []accessNode
}

// path gives the text form of the chain of contract 11.8, for example
// "service:infra-s3/bucket:logs/prefix:2026". Each id is percent-encoded.
func (r accessResource) path() string {
	var b strings.Builder
	for _, node := range r.Ancestors {
		b.WriteString(node.Type)
		b.WriteByte(':')
		b.WriteString(percentEncodeID(node.ID))
		b.WriteByte('/')
	}
	b.WriteString(r.Type)
	b.WriteByte(':')
	b.WriteString(percentEncodeID(r.ID))
	return b.String()
}

func (r accessResource) MarshalJSON() ([]byte, error) {
	type properties struct {
		Ancestors []accessNode `json:"ancestors"`
	}
	type resource struct {
		Type       string      `json:"type"`
		ID         string      `json:"id"`
		Properties *properties `json:"properties,omitempty"`
	}
	out := resource{Type: r.Type, ID: r.ID}
	if len(r.Ancestors) > 0 {
		out.Properties = &properties{Ancestors: r.Ancestors}
	}
	return json.Marshal(out)
}

// percentEncodeID encodes each byte outside A-Z, a-z, 0-9, '-', '.', '_' and
// '~' as %XX with upper-case hexadecimal digits (contract 11.8).
func percentEncodeID(id string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(id); i++ {
		c := id[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

// accessQuestion is one question to the PDP. Subtree is the match "subtree":
// a grant below the resource also gives true. The server uses it only to show
// or hide a navigation element, never to let an operation run.
type accessQuestion struct {
	Action   string
	Resource accessResource
	Subtree  bool
}

func (q accessQuestion) match() string {
	if q.Subtree {
		return "subtree"
	}
	return "node"
}

// accessDecision is the answer to one question. Source is "pdp", "cache" or
// "error" (fail closed).
type accessDecision struct {
	Allowed        bool
	Source         string
	UnknownSubject bool
}

type pdpCacheEntry struct {
	allowed        bool
	unknownSubject bool
	expires        time.Time
}

// pdpClient asks the AuthZEN PDP (contract 11.5). It keeps the answers for
// cache_ttl at most, and gives false for each question when the PDP does not
// answer correctly (fail closed).
type pdpClient struct {
	baseURL        string
	token          string
	timeout        time.Duration
	cacheTTL       time.Duration
	maxEvaluations int
	client         *http.Client
	now            func() time.Time

	mu         sync.Mutex
	cache      map[string]pdpCacheEntry
	cacheBytes int
}

func newPDPClient(cfg accessConfig) *pdpClient {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: cfg.PDPTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   cfg.PDPTimeout,
		ResponseHeaderTimeout: cfg.PDPTimeout,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
	}
	return &pdpClient{
		baseURL:        cfg.PDPURL,
		token:          cfg.PDPToken,
		timeout:        cfg.PDPTimeout,
		cacheTTL:       cfg.PDPCacheTTL,
		maxEvaluations: cfg.PDPMaxEvaluations,
		client: &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		now:   time.Now,
		cache: make(map[string]pdpCacheEntry),
	}
}

func (c *pdpClient) close() {
	if c == nil {
		return
	}
	closeHTTPClient(c.client)
}

func pdpCacheKey(subject string, question accessQuestion) string {
	return subject + "\x1f" + question.Action + "\x1f" + question.Resource.path() + "\x1f" + question.match()
}

// decide answers each question. The answers are in the order of the questions.
func (c *pdpClient) decide(ctx context.Context, requestID, subject string, questions []accessQuestion) []accessDecision {
	out := make([]accessDecision, len(questions))
	keys := make([]string, len(questions))
	pending := make(map[string][]int)
	order := make([]string, 0, len(questions))
	now := c.now()
	c.mu.Lock()
	for index, question := range questions {
		key := pdpCacheKey(subject, question)
		keys[index] = key
		if c.cacheTTL > 0 {
			if entry, found := c.cache[key]; found && now.Before(entry.expires) {
				out[index] = accessDecision{Allowed: entry.allowed, Source: "cache", UnknownSubject: entry.unknownSubject}
				continue
			}
		}
		if _, waiting := pending[key]; !waiting {
			order = append(order, key)
		}
		pending[key] = append(pending[key], index)
	}
	c.mu.Unlock()

	for start := 0; start < len(order); start += c.maxEvaluations {
		end := start + c.maxEvaluations
		if end > len(order) {
			end = len(order)
		}
		chunk := order[start:end]
		asked := make([]accessQuestion, 0, len(chunk))
		for _, key := range chunk {
			asked = append(asked, questions[pending[key][0]])
		}
		answers, err := c.call(ctx, requestID, subject, asked)
		if err != nil {
			log.Printf("access.pdp_failed request_id=%s evaluations=%d error=%q", requestID, len(asked), err.Error())
			for _, key := range chunk {
				for _, index := range pending[key] {
					out[index] = accessDecision{Allowed: false, Source: "error"}
				}
			}
			continue
		}
		expires := c.now().Add(c.cacheTTL)
		c.mu.Lock()
		for position, key := range chunk {
			answer := answers[position]
			for _, index := range pending[key] {
				out[index] = accessDecision{Allowed: answer.Allowed, Source: "pdp", UnknownSubject: answer.UnknownSubject}
			}
			if c.cacheTTL > 0 {
				c.storeLocked(key, pdpCacheEntry{allowed: answer.Allowed, unknownSubject: answer.UnknownSubject, expires: expires})
			}
		}
		c.mu.Unlock()
	}

	for index, question := range questions {
		reason := ""
		if out[index].UnknownSubject {
			reason = reasonUnknownSubject
		}
		log.Printf("access.decision request_id=%s subject=%q action=%s resource=%q match=%s decision=%t source=%s reason=%s",
			requestID, subject, question.Action, question.Resource.path(), question.match(), out[index].Allowed, out[index].Source, reason)
	}
	return out
}

// storeLocked keeps an answer. The cache holds 16384 answers and 8 MiB at
// most. When it is full, the expired answers go first. If the cache is still
// full, it becomes empty.
func (c *pdpClient) storeLocked(key string, entry pdpCacheEntry) {
	size := len(key) + pdpCacheEntryOverhead
	if size > pdpCacheMaxBytes {
		return
	}
	if _, found := c.cache[key]; found {
		c.cache[key] = entry
		return
	}
	if len(c.cache) >= pdpCacheMaxEntries || c.cacheBytes+size > pdpCacheMaxBytes {
		now := c.now()
		for existing, value := range c.cache {
			if !now.Before(value.expires) {
				c.cacheBytes -= len(existing) + pdpCacheEntryOverhead
				delete(c.cache, existing)
			}
		}
		if len(c.cache) >= pdpCacheMaxEntries || c.cacheBytes+size > pdpCacheMaxBytes {
			c.cache = make(map[string]pdpCacheEntry)
			c.cacheBytes = 0
		}
	}
	c.cache[key] = entry
	c.cacheBytes += size
}

type pdpSubject struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type pdpAction struct {
	Name string `json:"name"`
}

type pdpContext struct {
	Match string `json:"match,omitempty"`
}

type pdpEvaluation struct {
	Action   pdpAction      `json:"action"`
	Resource accessResource `json:"resource"`
	Context  *pdpContext    `json:"context,omitempty"`
}

// requestBody gives the AuthZEN request. One question uses the evaluation API.
// More questions use one batch: the subject is at the top, and only a question
// of the navigation has a context (AuthZEN 1.0, 7.1: it replaces the default).
func requestBody(subject string, questions []accessQuestion) ([]byte, string, error) {
	who := pdpSubject{Type: "user", ID: subject}
	if len(questions) == 1 {
		question := questions[0]
		context := pdpContext{}
		if question.Subtree {
			context.Match = "subtree"
		}
		body, err := json.Marshal(struct {
			Subject  pdpSubject     `json:"subject"`
			Action   pdpAction      `json:"action"`
			Resource accessResource `json:"resource"`
			Context  pdpContext     `json:"context"`
		}{who, pdpAction{question.Action}, question.Resource, context})
		return body, pdpEvaluationPath, err
	}
	evaluations := make([]pdpEvaluation, 0, len(questions))
	for _, question := range questions {
		item := pdpEvaluation{Action: pdpAction{question.Action}, Resource: question.Resource}
		if question.Subtree {
			item.Context = &pdpContext{Match: "subtree"}
		}
		evaluations = append(evaluations, item)
	}
	body, err := json.Marshal(struct {
		Subject     pdpSubject      `json:"subject"`
		Evaluations []pdpEvaluation `json:"evaluations"`
	}{who, evaluations})
	return body, pdpEvaluationsPath, err
}

func (c *pdpClient) call(ctx context.Context, requestID, subject string, questions []accessQuestion) ([]accessDecision, error) {
	body, path, err := requestBody(subject, questions)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Request-ID", requestID)
	response, err := c.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("no answer: %v", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPDPAnswerBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read the answer: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", response.StatusCode)
	}
	if len(data) > maxPDPAnswerBytes {
		return nil, fmt.Errorf("the answer is larger than %d bytes", maxPDPAnswerBytes)
	}
	answers, ok := parsePDPAnswer(data, len(questions))
	if !ok {
		return nil, fmt.Errorf("the answer is not a valid AuthZEN answer")
	}
	return answers, nil
}

// parsePDPAnswer reads {"decision": bool} for one question, or
// {"evaluations": [...]} with one item for each question.
func parsePDPAnswer(data []byte, count int) ([]accessDecision, bool) {
	if count == 1 {
		decision, ok := decisionOf(data)
		if !ok {
			return nil, false
		}
		return []accessDecision{decision}, true
	}
	var batch struct {
		Evaluations []json.RawMessage `json:"evaluations"`
	}
	if json.Unmarshal(data, &batch) != nil || len(batch.Evaluations) != count {
		return nil, false
	}
	out := make([]accessDecision, 0, count)
	for _, item := range batch.Evaluations {
		decision, ok := decisionOf(item)
		if !ok {
			return nil, false
		}
		out = append(out, decision)
	}
	return out, true
}

func decisionOf(data []byte) (accessDecision, bool) {
	var answer map[string]json.RawMessage
	if json.Unmarshal(data, &answer) != nil || answer == nil {
		return accessDecision{}, false
	}
	var allowed bool
	raw, found := answer["decision"]
	if !found || json.Unmarshal(raw, &allowed) != nil {
		return accessDecision{}, false
	}
	if !bytes.Equal(bytes.TrimSpace(raw), []byte("true")) && !bytes.Equal(bytes.TrimSpace(raw), []byte("false")) {
		return accessDecision{}, false
	}
	decision := accessDecision{Allowed: allowed}
	rawContext, found := answer["context"]
	if !found {
		return decision, true
	}
	var context map[string]json.RawMessage
	if json.Unmarshal(rawContext, &context) != nil || context == nil {
		return accessDecision{}, false
	}
	var reason string
	if rawReason, ok := context["reason"]; ok && json.Unmarshal(rawReason, &reason) == nil {
		// Only a false decision can name an unknown subject (contract 11.5).
		decision.UnknownSubject = !allowed && reason == reasonUnknownSubject
	}
	return decision, true
}
