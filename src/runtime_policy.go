package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const (
	accessModeInheritCredentials = "inherit_credentials"
	accessModeForceReadOnly      = "force_read_only"

	stateModeEphemeral  = "ephemeral"
	stateModePersistent = "persistent"

	logModeAnonymous = "anonymous"
	logModeDetailed  = "detailed"
)

const (
	defaultMaxStorageBytesPerRequest    = int64(2 << 30)
	defaultMaxStorageRequestsPerRequest = int64(4096)
	defaultMaxTempBytesPerSession       = int64(512 << 20)
	defaultMaxRangeCacheBytes           = int64(32 << 20)
	defaultMaxConcurrentStorageRequests = 8
	defaultMaxConcurrentPerStorage      = 4
	defaultSessionTTLSeconds            = 20 * 60
	defaultMaxStatsFolders              = 10000
	defaultMaxArchiveEntries            = 100000
)

type runtimePolicy struct {
	AccessMode                    string `json:"accessMode"`
	StateMode                     string `json:"stateMode"`
	BrowserPersistence            bool   `json:"browserPersistence"`
	AllowFullObjectFallback       bool   `json:"allowFullObjectFallback"`
	LogMode                       string `json:"logMode"`
	MemoryLimitBytes              int64  `json:"memoryLimitBytes,omitempty"`
	MaxStorageBytesPerRequest     int64  `json:"maxStorageBytesPerRequest"`
	MaxStorageRequestsPerRequest  int64  `json:"maxStorageRequestsPerRequest"`
	MaxTempBytesPerSession        int64  `json:"maxTempBytesPerSession"`
	MaxRangeCacheBytes            int64  `json:"maxRangeCacheBytes"`
	MaxConcurrentStorageRequests  int    `json:"maxConcurrentStorageRequests"`
	MaxConcurrentRequestsPerStore int    `json:"maxConcurrentRequestsPerStorage"`
	SessionTTLSeconds             int    `json:"sessionTTLSeconds"`
	MaxStatsFolders               int    `json:"maxStatsFolders"`
	MaxArchiveEntries             int    `json:"maxArchiveEntries"`
}

func defaultRuntimePolicy() runtimePolicy {
	return runtimePolicy{
		AccessMode:                    accessModeInheritCredentials,
		StateMode:                     stateModeEphemeral,
		BrowserPersistence:            false,
		AllowFullObjectFallback:       false,
		LogMode:                       logModeAnonymous,
		MaxStorageBytesPerRequest:     defaultMaxStorageBytesPerRequest,
		MaxStorageRequestsPerRequest:  defaultMaxStorageRequestsPerRequest,
		MaxTempBytesPerSession:        defaultMaxTempBytesPerSession,
		MaxRangeCacheBytes:            defaultMaxRangeCacheBytes,
		MaxConcurrentStorageRequests:  defaultMaxConcurrentStorageRequests,
		MaxConcurrentRequestsPerStore: defaultMaxConcurrentPerStorage,
		SessionTTLSeconds:             defaultSessionTTLSeconds,
		MaxStatsFolders:               defaultMaxStatsFolders,
		MaxArchiveEntries:             defaultMaxArchiveEntries,
	}
}

func (p runtimePolicy) persistent() bool    { return p.StateMode == stateModePersistent }
func (p runtimePolicy) forceReadOnly() bool { return p.AccessMode == accessModeForceReadOnly }
func (p runtimePolicy) sessionTTL() time.Duration {
	seconds := p.SessionTTLSeconds
	if seconds <= 0 {
		seconds = defaultSessionTTLSeconds
	}
	return time.Duration(seconds) * time.Second
}

type resourceUsage struct {
	StorageRequests int64     `json:"storageRequests"`
	StorageBytes    int64     `json:"storageBytes"`
	StartedAt       time.Time `json:"startedAt"`
	ElapsedMS       int64     `json:"elapsedMs"`
}

type resourceBudget struct {
	maxRequests int64
	maxBytes    int64
	requests    atomic.Int64
	bytes       atomic.Int64
	startedAt   time.Time
}

type resourceBudgetContextKey struct{}

func newResourceBudget(policy runtimePolicy) *resourceBudget {
	return &resourceBudget{
		maxRequests: policy.MaxStorageRequestsPerRequest,
		maxBytes:    policy.MaxStorageBytesPerRequest,
		startedAt:   time.Now().UTC(),
	}
}

func withResourceBudget(ctx context.Context, budget *resourceBudget) context.Context {
	if budget == nil {
		return ctx
	}
	return context.WithValue(ctx, resourceBudgetContextKey{}, budget)
}

func budgetFromContext(ctx context.Context) *resourceBudget {
	if ctx == nil {
		return nil
	}
	budget, _ := ctx.Value(resourceBudgetContextKey{}).(*resourceBudget)
	return budget
}

type resourceLimitError struct {
	Kind  string
	Limit int64
	Used  int64
}

func (e resourceLimitError) Error() string {
	return fmt.Sprintf("%s resource budget exceeded: used %d, limit %d", e.Kind, e.Used, e.Limit)
}

func (b *resourceBudget) consumeRequest() error {
	if b == nil {
		return nil
	}
	used := b.requests.Add(1)
	if b.maxRequests > 0 && used > b.maxRequests {
		return resourceLimitError{Kind: "storage_requests", Limit: b.maxRequests, Used: used}
	}
	return nil
}

func (b *resourceBudget) consumeBytes(count int64) error {
	if b == nil || count <= 0 {
		return nil
	}
	used := b.bytes.Add(count)
	if b.maxBytes > 0 && used > b.maxBytes {
		return resourceLimitError{Kind: "storage_bytes", Limit: b.maxBytes, Used: used}
	}
	return nil
}

func (b *resourceBudget) usage() resourceUsage {
	if b == nil {
		return resourceUsage{}
	}
	return resourceUsage{
		StorageRequests: b.requests.Load(),
		StorageBytes:    b.bytes.Load(),
		StartedAt:       b.startedAt,
		ElapsedMS:       time.Since(b.startedAt).Milliseconds(),
	}
}

func resourceLimitAPIError(err error) (apiError, bool) {
	var limit resourceLimitError
	if !errors.As(err, &limit) {
		return apiError{}, false
	}
	message := "the configured resource budget was exceeded"
	switch limit.Kind {
	case "storage_requests":
		message = fmt.Sprintf("the operation exceeded the limit of %d storage requests", limit.Limit)
	case "storage_bytes":
		message = fmt.Sprintf("the operation exceeded the limit of %d bytes read from storage", limit.Limit)
	}
	return apiError{Status: http.StatusTooManyRequests, Code: "resource_budget_exceeded", Message: message}, true
}

type storageConcurrency struct {
	global chan struct{}
}

func newStorageConcurrency(limit int) *storageConcurrency {
	if limit <= 0 {
		limit = defaultMaxConcurrentStorageRequests
	}
	return &storageConcurrency{global: make(chan struct{}, limit)}
}

func acquireGate(ctx context.Context, gates ...chan struct{}) (func(), error) {
	acquired := make([]chan struct{}, 0, len(gates))
	for _, gate := range gates {
		if gate == nil {
			continue
		}
		select {
		case gate <- struct{}{}:
			acquired = append(acquired, gate)
		case <-ctx.Done():
			for index := len(acquired) - 1; index >= 0; index-- {
				<-acquired[index]
			}
			return nil, ctx.Err()
		}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			for index := len(acquired) - 1; index >= 0; index-- {
				<-acquired[index]
			}
		})
	}, nil
}
