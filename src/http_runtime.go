package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	resourceRequestsTrailer = "X-S3-Browser-Storage-Requests"
	resourceBytesTrailer    = "X-S3-Browser-Storage-Bytes"
	resourceElapsedTrailer  = "X-S3-Browser-Elapsed-Ms"
)

// requestBudgetMiddleware attaches a fresh, concurrency-safe resource budget to
// every API/object request. Static assets and the health endpoint do not touch
// object storage and intentionally avoid the extra trailer headers.
func requestBudgetMiddleware(policy runtimePolicy, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/s3" {
			next.ServeHTTP(w, r)
			return
		}
		budget := newResourceBudget(policy)
		w.Header().Add("Trailer", resourceRequestsTrailer)
		w.Header().Add("Trailer", resourceBytesTrailer)
		w.Header().Add("Trailer", resourceElapsedTrailer)
		next.ServeHTTP(w, r.WithContext(withResourceBudget(r.Context(), budget)))
		usage := budget.usage()
		w.Header().Set(resourceRequestsTrailer, strconv.FormatInt(usage.StorageRequests, 10))
		w.Header().Set(resourceBytesTrailer, strconv.FormatInt(usage.StorageBytes, 10))
		w.Header().Set(resourceElapsedTrailer, strconv.FormatInt(usage.ElapsedMS, 10))
	})
}

// sameOriginMutationMiddleware rejects browser-initiated cross-site mutations.
// CLI clients without browser Fetch Metadata/Origin headers remain supported.
// Storage permissions are still checked independently by every endpoint.
func sameOriginMutationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isSafeHTTPMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		if site := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))); site == "cross-site" {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{
				"code": "cross_site_request_blocked", "message": "cross-site mutation requests are not allowed",
			}})
			return
		}
		if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" && origin != "null" {
			parsed, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(parsed.Host, effectiveRequestHost(r)) || !isHTTPOrigin(parsed) {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{
					"code": "origin_mismatch", "message": "the request origin does not match this application",
				}})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func isSafeHTTPMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

func effectiveRequestHost(r *http.Request) string {
	// Do not trust X-Forwarded-Host from arbitrary clients. Deployments behind a
	// reverse proxy must preserve the public host in Request.Host (the default
	// behaviour of the common proxy servers) or strip/rewrite Origin themselves.
	// Treating an untrusted forwarded header as authoritative would let a direct
	// client forge both Origin and X-Forwarded-Host and bypass this browser CSRF
	// defence.
	return r.Host
}

func isHTTPOrigin(origin *url.URL) bool {
	return origin != nil && (origin.Scheme == "http" || origin.Scheme == "https") && origin.Host != ""
}

func publicRuntimeInfo(policy runtimePolicy) map[string]any {
	return map[string]any{
		"forceReadOnly":      policy.forceReadOnly(),
		"fullObjectFallback": policy.AllowFullObjectFallback,
		"sessionTTLSeconds":  policy.SessionTTLSeconds,
		"maxStorageBytes":    policy.MaxStorageBytesPerRequest,
		"maxStorageRequests": policy.MaxStorageRequestsPerRequest,
		"maxRangeCacheBytes": policy.MaxRangeCacheBytes,
		"maxArchiveEntries":  policy.MaxArchiveEntries,
	}
}

func resourceUsageHeaders(usage resourceUsage) http.Header {
	headers := make(http.Header)
	headers.Set(resourceRequestsTrailer, fmt.Sprintf("%d", usage.StorageRequests))
	headers.Set(resourceBytesTrailer, fmt.Sprintf("%d", usage.StorageBytes))
	headers.Set(resourceElapsedTrailer, fmt.Sprintf("%d", usage.ElapsedMS))
	return headers
}

// requestContextWithoutCancel is used only for bounded cleanup operations that
// must finish after a client disconnect. Ordinary storage reads always retain
// the original request cancellation signal.
func requestContextWithoutCancel(ctx context.Context) context.Context {
	return context.WithoutCancel(ctx)
}
