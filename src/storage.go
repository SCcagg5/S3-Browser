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
)

type capabilityState struct {
	Allowed  bool   `json:"allowed"`
	Verified bool   `json:"verified"`
	Source   string `json:"source"`
	Reason   string `json:"reason,omitempty"`
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
		Proxy:                 http.ProxyFromEnvironment,
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
	return &http.Client{Transport: transport}
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

type storageBackend interface {
	List(context.Context, listOptions) (listPage, error)
	Head(context.Context, string) (objectResponse, error)
	Get(context.Context, string, http.Header) (objectResponse, error)
	Put(context.Context, string, io.Reader, int64, string) error
	Delete(context.Context, string) error
	Copy(context.Context, string, string) error
	DiscoverCapabilities(context.Context) (discoveredCapabilities, error)
}

type storageInstance struct {
	cfg     storageConfig
	backend storageBackend
	mu      sync.RWMutex
	caps    capabilities
}

func newStorageInstance(cfg storageConfig) (*storageInstance, error) {
	var (
		backend storageBackend
		err     error
	)
	switch cfg.Provider {
	case "s3":
		backend, err = newS3Backend(cfg)
	case "gcs":
		backend, err = newGCSBackend(cfg)
	default:
		err = fmt.Errorf("unsupported provider %q", cfg.Provider)
	}
	if err != nil {
		return nil, err
	}
	instance := &storageInstance{cfg: cfg, backend: backend}
	instance.caps = initialCapabilities(cfg)
	return instance, nil
}

func initialCapabilities(cfg storageConfig) capabilities {
	var out capabilities
	for _, name := range []string{permissionRead, permissionWrite, permissionDelete} {
		allowed := cfg.PermissionsDefined && containsString(cfg.Permissions, name)
		reason := "permission is disabled by the configuration"
		if allowed {
			reason = "permission is enabled by the configuration; provider verification is not performed automatically to avoid additional storage requests"
		}
		out.set(name, capabilityState{
			Allowed:  allowed,
			Verified: false,
			Source:   "configuration",
			Reason:   reason,
		})
	}
	if !cfg.PermissionsDefined {
		for _, name := range []string{permissionRead, permissionWrite, permissionDelete} {
			out.set(name, capabilityState{
				Allowed:  false,
				Verified: false,
				Source:   "discovery",
				Reason:   "permissions are not configured; provider discovery requires an explicit refresh request",
			})
		}
	}
	return out
}

func (s *storageInstance) refreshCapabilities(ctx context.Context) capabilities {
	discovered, err := s.backend.DiscoverCapabilities(ctx)
	merged := mergeCapabilities(s.cfg, discovered, err)
	s.mu.Lock()
	s.caps = merged
	s.mu.Unlock()
	return merged
}

func mergeCapabilities(cfg storageConfig, discovered discoveredCapabilities, discoveryErr error) capabilities {
	now := time.Now().UTC()
	out := capabilities{
		Permissions: append([]string(nil), discovered.Permissions...),
		CheckedAt:   &now,
	}
	publicDiscoveryError := publicStorageError(discoveryErr)
	if publicDiscoveryError != "" {
		out.Error = publicDiscoveryError
	}
	sort.Strings(out.Permissions)

	for _, name := range []string{permissionRead, permissionWrite, permissionDelete} {
		discoveredState, known := discovered.States[name]
		declared := containsString(cfg.Permissions, name)

		if cfg.PermissionsDefined {
			if !declared {
				out.set(name, capabilityState{
					Allowed:  false,
					Verified: true,
					Source:   "configuration",
					Reason:   "action is disabled in the configuration",
				})
				continue
			}
			if known && discoveredState.Verified {
				discoveredState.Allowed = discoveredState.Allowed && declared
				out.set(name, discoveredState)
				continue
			}
			reason := "permission is declared in the configuration; the provider cannot verify it without a destructive operation"
			if discoveryErr != nil {
				reason = "permission is declared in the configuration; verification failed: " + publicDiscoveryError
			} else if known && discoveredState.Reason != "" {
				reason = discoveredState.Reason
			}
			out.set(name, capabilityState{
				Allowed:  true,
				Verified: false,
				Source:   "configuration",
				Reason:   reason,
			})
			continue
		}

		if known {
			out.set(name, discoveredState)
			continue
		}
		reason := "permission is not verified"
		if discoveryErr != nil {
			reason = "permission discovery failed: " + publicDiscoveryError
		}
		out.set(name, capabilityState{
			Allowed:  false,
			Verified: false,
			Source:   "discovery",
			Reason:   reason,
		})
	}
	return out
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

func (s *storageInstance) publicInfo() instanceInfo {
	return instanceInfo{
		ID:           s.cfg.ID,
		Name:         s.cfg.Name,
		Provider:     s.cfg.Provider,
		Bucket:       s.cfg.Bucket,
		Region:       s.cfg.Region,
		RootPrefix:   s.cfg.RootPrefix,
		TrashPrefix:  s.cfg.TrashPrefix,
		Capabilities: s.capabilities(),
	}
}

type instanceInfo struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Provider     string       `json:"provider"`
	Bucket       string       `json:"bucket"`
	Region       string       `json:"region,omitempty"`
	RootPrefix   string       `json:"rootPrefix,omitempty"`
	TrashPrefix  string       `json:"trashPrefix,omitempty"`
	Capabilities capabilities `json:"capabilities"`
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
