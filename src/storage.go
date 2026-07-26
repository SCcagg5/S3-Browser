package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	permissionRead   = "read"
	permissionWrite  = "write"
	permissionDelete = "delete"

	capabilityUnknown = "unknown"
	capabilityAllowed = "allowed"
	capabilityDenied  = "denied"
)

type capabilityState struct {
	State    string `json:"state"`
	Allowed  bool   `json:"allowed"`
	Verified bool   `json:"verified"`
	Source   string `json:"source"`
	Reason   string `json:"reason,omitempty"`
}

func normalizedCapabilityState(state capabilityState) capabilityState {
	if state.State == "" {
		switch {
		case state.Verified && state.Allowed:
			state.State = capabilityAllowed
		case state.Verified && !state.Allowed:
			state.State = capabilityDenied
		default:
			state.State = capabilityUnknown
			// Unknown capabilities are intentionally tentable. The backend remains
			// authoritative and will learn an explicit provider denial in memory.
			state.Allowed = true
		}
	}
	if state.State == capabilityUnknown {
		state.Allowed = true
		state.Verified = false
	}
	if state.State == capabilityAllowed {
		state.Allowed = true
	}
	if state.State == capabilityDenied {
		state.Allowed = false
	}
	return state
}

func unknownCapability(source, reason string) capabilityState {
	return capabilityState{State: capabilityUnknown, Allowed: true, Verified: false, Source: source, Reason: reason}
}

func allowedCapability(source, reason string, verified bool) capabilityState {
	return capabilityState{State: capabilityAllowed, Allowed: true, Verified: verified, Source: source, Reason: reason}
}

func deniedCapability(source, reason string, verified bool) capabilityState {
	return capabilityState{State: capabilityDenied, Allowed: false, Verified: verified, Source: source, Reason: reason}
}

type capabilities struct {
	Read        capabilityState `json:"read"`
	Write       capabilityState `json:"write"`
	Delete      capabilityState `json:"delete"`
	Permissions []string        `json:"permissions,omitempty"`
	CheckedAt   *time.Time      `json:"checkedAt,omitempty"`
	Error       string          `json:"error,omitempty"`
}

func (c capabilities) state(name string) capabilityState {
	switch name {
	case permissionRead:
		return c.Read
	case permissionWrite:
		return c.Write
	case permissionDelete:
		return c.Delete
	default:
		return capabilityState{}
	}
}

func (c *capabilities) set(name string, state capabilityState) {
	state = normalizedCapabilityState(state)
	switch name {
	case permissionRead:
		c.Read = state
	case permissionWrite:
		c.Write = state
	case permissionDelete:
		c.Delete = state
	}
}

type discoveredCapabilities struct {
	States      map[string]capabilityState
	Permissions []string
}

type listOptions struct {
	Prefix     string
	Delimiter  string
	MaxResults int
	PageToken  string
	StartAfter string
}

type objectInfo struct {
	Key          string
	Size         int64
	LastModified time.Time
	ETag         string
	ContentType  string
}

type listPage struct {
	Objects       []objectInfo
	Prefixes      []string
	NextPageToken string
}

type objectResponse struct {
	StatusCode int
	Header     http.Header
	Body       io.ReadCloser
}

func isSuccessfulObjectReadStatus(status int) bool {
	return (status >= http.StatusOK && status < http.StatusMultipleChoices) || status == http.StatusNotModified
}

func parseStorageEndpoint(provider, raw string) (*url.URL, error) {
	endpoint, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse %s endpoint: %w", provider, err)
	}
	if endpoint.Scheme != "http" && endpoint.Scheme != "https" {
		return nil, fmt.Errorf("%s endpoint scheme must be http or https", provider)
	}
	if endpoint.Host == "" {
		return nil, fmt.Errorf("%s endpoint must include a host", provider)
	}
	if endpoint.User != nil {
		return nil, fmt.Errorf("%s endpoint must not contain user information", provider)
	}
	if endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
		return nil, fmt.Errorf("%s endpoint must not contain a query string or fragment", provider)
	}
	return endpoint, nil
}

func newStorageHTTPClient(insecureSkipVerify bool) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: insecureSkipVerify}, // #nosec G402 -- explicitly configured for local test services only
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func publicStorageError(err error) string {
	if err == nil {
		return ""
	}
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		if code := safeProviderErrorCode(upstream.Code); code != "" {
			return fmt.Sprintf("the storage provider returned HTTP %d (%s)", upstream.StatusCode, code)
		}
		return fmt.Sprintf("the storage provider returned HTTP %d", upstream.StatusCode)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "the storage provider connection timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "the storage provider request was canceled"
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return "unable to connect to or authenticate with the storage provider"
	}
	return "the storage provider operation failed"
}

func safeProviderErrorCode(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 64 {
		value = value[:64]
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			continue
		}
		return ""
	}
	return value
}

type ObjectLister interface {
	List(context.Context, listOptions) (listPage, error)
}
type ObjectStatReader interface {
	Head(context.Context, string) (objectResponse, error)
}
type ObjectReader interface {
	Get(context.Context, string, http.Header) (objectResponse, error)
}
type ObjectWriter interface {
	Put(context.Context, string, io.Reader, int64, string) error
}
type ObjectDeleter interface {
	Delete(context.Context, string) error
}
type ObjectCopier interface {
	Copy(context.Context, string, string) error
}
type CapabilityDiscoverer interface {
	DiscoverCapabilities(context.Context) (discoveredCapabilities, error)
}

type storageBackend interface {
	ObjectLister
	ObjectStatReader
	ObjectReader
	ObjectWriter
	ObjectDeleter
	ObjectCopier
	CapabilityDiscoverer
}

type storageInstance struct {
	cfg           bucketConfig
	backend       storageBackend
	mu            sync.RWMutex
	caps          capabilities
	forceReadOnly bool
	policy        runtimePolicy
	concurrency   *storageConcurrency
	gate          chan struct{}
}

func newStorageInstance(cfg bucketConfig, auth *sharedAuthentication, policy runtimePolicy, concurrency *storageConcurrency) (*storageInstance, error) {
	if auth == nil {
		return nil, fmt.Errorf("bucket %q references an unavailable authentication", cfg.ID)
	}
	if auth.cfg.ID != cfg.AuthID || auth.cfg.Provider != cfg.Provider {
		return nil, fmt.Errorf("bucket %q authentication does not match its resolved configuration", cfg.ID)
	}
	var (
		backend storageBackend
		err     error
	)
	switch cfg.Provider {
	case "s3":
		backend, err = newS3BackendWithAuthentication(cfg, auth)
	case "gcs":
		backend, err = newGCSBackendWithAuthentication(cfg, auth)
	default:
		err = fmt.Errorf("unsupported provider %q", cfg.Provider)
	}
	if err != nil {
		return nil, err
	}
	perStorage := policy.MaxConcurrentRequestsPerStore
	if perStorage <= 0 {
		perStorage = defaultMaxConcurrentPerStorage
	}
	instance := &storageInstance{
		cfg: cfg, backend: backend, forceReadOnly: policy.forceReadOnly(), policy: policy,
		concurrency: concurrency, gate: make(chan struct{}, perStorage),
	}
	instance.caps = initialCapabilities(cfg, instance.forceReadOnly)
	return instance, nil
}

func initialCapabilities(cfg bucketConfig, forceReadOnlyValues ...bool) capabilities {
	forceReadOnly := len(forceReadOnlyValues) > 0 && forceReadOnlyValues[0]
	var out capabilities
	for _, name := range []string{permissionRead, permissionWrite, permissionDelete} {
		if forceReadOnly && name != permissionRead {
			out.set(name, deniedCapability("runtime", "mutations are disabled by the administrative force_read_only policy", true))
			continue
		}
		if cfg.PermissionsDefined && !containsString(cfg.Permissions, name) {
			out.set(name, deniedCapability("configuration", "action is disabled by the storage permission ceiling", true))
			continue
		}
		reason := "the provider permission has not been tested; the action remains available and will be verified when used"
		if cfg.PermissionsDefined {
			reason = "the permission is enabled by the configuration ceiling and will be verified when used"
		}
		out.set(name, unknownCapability("credentials", reason))
	}
	return out
}

func (s *storageInstance) refreshCapabilities(ctx context.Context) capabilities {
	discovered, err := s.discoverCapabilities(ctx)
	merged := mergeCapabilitiesWithPolicy(s.cfg, s.forceReadOnly, discovered, err)
	s.mu.Lock()
	s.caps = merged
	s.mu.Unlock()
	return merged
}

func mergeCapabilitiesWithPolicy(cfg bucketConfig, forceReadOnly bool, discovered discoveredCapabilities, discoveryErr error) capabilities {
	now := time.Now().UTC()
	out := capabilities{Permissions: append([]string(nil), discovered.Permissions...), CheckedAt: &now}
	publicDiscoveryError := publicStorageError(discoveryErr)
	if publicDiscoveryError != "" {
		out.Error = publicDiscoveryError
	}
	sort.Strings(out.Permissions)

	for _, name := range []string{permissionRead, permissionWrite, permissionDelete} {
		if forceReadOnly && name != permissionRead {
			out.set(name, deniedCapability("runtime", "mutations are disabled by the administrative force_read_only policy", true))
			continue
		}
		if cfg.PermissionsDefined && !containsString(cfg.Permissions, name) {
			out.set(name, deniedCapability("configuration", "action is disabled by the storage permission ceiling", true))
			continue
		}
		if discoveredState, known := discovered.States[name]; known {
			discoveredState = normalizedCapabilityState(discoveredState)
			if discoveredState.Verified {
				out.set(name, discoveredState)
				continue
			}
			reason := discoveredState.Reason
			if reason == "" {
				reason = "the provider cannot verify this permission without executing the real operation"
			}
			out.set(name, unknownCapability(discoveredState.Source, reason))
			continue
		}
		reason := "the provider permission has not been tested; the action remains available and will be verified when used"
		if discoveryErr != nil {
			reason = "permission discovery failed; the action remains tentable: " + publicDiscoveryError
		}
		out.set(name, unknownCapability("credentials", reason))
	}
	return out
}

func mergeCapabilities(cfg bucketConfig, discovered discoveredCapabilities, discoveryErr error) capabilities {
	return mergeCapabilitiesWithPolicy(cfg, false, discovered, discoveryErr)
}

func (s *storageInstance) capabilities() capabilities {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.caps
}

func (s *storageInstance) allowed(permission string) bool {
	return s.capabilities().state(permission).Allowed
}

func (s *storageInstance) fullKey(relative string) string {
	relative = strings.TrimLeft(relative, "/")
	return s.cfg.RootPrefix + relative
}

func (s *storageInstance) relativeKey(full string) (string, bool) {
	if s.cfg.RootPrefix == "" {
		return strings.TrimLeft(full, "/"), true
	}
	if !strings.HasPrefix(full, s.cfg.RootPrefix) {
		return "", false
	}
	return strings.TrimPrefix(full, s.cfg.RootPrefix), true
}

func combineCapabilityStates(states ...capabilityState) capabilityState {
	if len(states) == 0 {
		return deniedCapability("application", "operation is not implemented", true)
	}
	unknown := false
	reasons := make([]string, 0, len(states))
	seenReasons := make(map[string]struct{}, len(states))
	for _, state := range states {
		state = normalizedCapabilityState(state)
		if state.Reason != "" {
			if _, exists := seenReasons[state.Reason]; !exists {
				seenReasons[state.Reason] = struct{}{}
				reasons = append(reasons, state.Reason)
			}
		}
		if state.State == capabilityDenied {
			return deniedCapability(state.Source, state.Reason, state.Verified)
		}
		if state.State == capabilityUnknown {
			unknown = true
		}
	}
	if unknown {
		return unknownCapability("derived", strings.Join(reasons, "; "))
	}
	return allowedCapability("derived", strings.Join(reasons, "; "), true)
}

func (s *storageInstance) operationCapabilities() map[string]capabilityState {
	caps := s.capabilities()
	read, write, remove := caps.Read, caps.Write, caps.Delete
	return map[string]capabilityState{
		"list": read, "preview": read, "download": read,
		"upload": write, "overwrite": write, "createFolder": write,
		"copy":   combineCapabilityStates(read, write),
		"move":   combineCapabilityStates(read, write, remove),
		"rename": combineCapabilityStates(read, write, remove),
		"delete": remove,
	}
}

func (s *storageInstance) publicInfo() instanceInfo {
	return instanceInfo{
		ID:           s.cfg.ID,
		Name:         s.cfg.Name,
		Provider:     s.cfg.Provider,
		Bucket:       s.cfg.Bucket,
		Region:       s.cfg.Region,
		RootPrefix:   s.cfg.RootPrefix,
		Capabilities: s.capabilities(),
		Operations:   s.operationCapabilities(),
	}
}

type instanceInfo struct {
	ID           string                     `json:"id"`
	Name         string                     `json:"name"`
	Provider     string                     `json:"provider"`
	Bucket       string                     `json:"bucket"`
	Region       string                     `json:"region,omitempty"`
	RootPrefix   string                     `json:"rootPrefix,omitempty"`
	Capabilities capabilities               `json:"capabilities"`
	Operations   map[string]capabilityState `json:"operations"`
}

type upstreamError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *upstreamError) Error() string {
	parts := make([]string, 0, 2)
	if e.Code != "" {
		parts = append(parts, e.Code)
	}
	if e.Message != "" {
		parts = append(parts, e.Message)
	}
	if len(parts) == 0 {
		return fmt.Sprintf("storage upstream returned HTTP %d", e.StatusCode)
	}
	return strings.Join(parts, ": ")
}

func statusFromError(err error) int {
	if err == nil {
		return http.StatusOK
	}
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		switch upstream.StatusCode {
		case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden,
			http.StatusNotFound, http.StatusConflict, http.StatusPreconditionFailed,
			http.StatusRequestedRangeNotSatisfiable, http.StatusTooManyRequests:
			return upstream.StatusCode
		default:
			if upstream.StatusCode >= 400 && upstream.StatusCode < 500 {
				return http.StatusBadRequest
			}
		}
	}
	return http.StatusBadGateway
}
