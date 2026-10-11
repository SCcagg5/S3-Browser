package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
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
		if r.Method == http.MethodPut && r.Body != nil && r.Body != http.NoBody {
			// Object and upload-chunk bodies are streamed straight to the provider
			// while a storage slot is held, so a stalled client must not pin it.
			body := newIdleDeadlineBody(w, r.Body)
			defer body.release()
			r.Body = body
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

// streamIdleTimeout is how long a request body read or a response body write may
// make no progress before the connection deadline fires. The deadline is rolled
// forward on every chunk, so long transfers keep working while a stalled peer is
// cut off and stops holding a storage concurrency slot.
var streamIdleTimeout = 30 * time.Second

// idleDeadlineBody rolls the connection read deadline forward while the client
// keeps sending the request body. The deadline is cleared once the body ends so
// it cannot fire while the handler keeps working after the last byte.
type idleDeadlineBody struct {
	io.ReadCloser
	controller *http.ResponseController
	idle       time.Duration
	refreshed  time.Time
	armed      bool
	failed     bool
}

func newIdleDeadlineBody(w http.ResponseWriter, body io.ReadCloser) *idleDeadlineBody {
	return &idleDeadlineBody{ReadCloser: body, controller: http.NewResponseController(w), idle: streamIdleTimeout}
}

func (b *idleDeadlineBody) Read(buffer []byte) (int, error) {
	if b.idle > 0 {
		// Refresh at most every quarter period; the deadline is then never more
		// than one idle period past the last byte received.
		if now := time.Now(); !b.armed || now.Sub(b.refreshed) >= b.idle/4 {
			if b.controller.SetReadDeadline(now.Add(b.idle)) == nil {
				b.armed = true
			}
			b.refreshed = now
		}
	}
	count, err := b.ReadCloser.Read(buffer)
	if err == io.EOF {
		b.release()
	} else if err != nil {
		// Leave an expired deadline in place: the server drains an unread body
		// before it answers, and that drain must fail fast instead of waiting
		// for the stalled client again.
		b.failed = true
	}
	return count, err
}

func (b *idleDeadlineBody) release() {
	if b.armed && !b.failed {
		_ = b.controller.SetReadDeadline(time.Time{})
		b.armed = false
	}
}

func (b *idleDeadlineBody) Close() error {
	b.release()
	return b.ReadCloser.Close()
}

// idleDeadlineWriter is the download counterpart: it rolls the write deadline
// forward on each chunk so a client that stops reading releases its gate.
type idleDeadlineWriter struct {
	io.Writer
	controller *http.ResponseController
	idle       time.Duration
	refreshed  time.Time
}

func (w *idleDeadlineWriter) Write(data []byte) (int, error) {
	if now := time.Now(); now.Sub(w.refreshed) >= w.idle/4 {
		_ = w.controller.SetWriteDeadline(now.Add(w.idle))
		w.refreshed = now
	}
	return w.Writer.Write(data)
}

// streamBufferPool holds the copy buffers used to relay object bytes. A larger buffer than io.Copy's 32 KiB default
// means fewer read and write calls per gigabyte, and pooling keeps concurrent downloads from allocating one each.
var streamBufferPool = sync.Pool{New: func() any {
	buffer := make([]byte, 256<<10)
	return &buffer
}}

// withIdleWriteDeadline wraps a response writer so that every chunk rolls its write deadline forward. The returned
// function clears the deadline; when the connection does not support deadlines the writer is returned unchanged.
func withIdleWriteDeadline(w http.ResponseWriter) (io.Writer, func()) {
	if streamIdleTimeout <= 0 {
		return w, func() {}
	}
	controller := http.NewResponseController(w)
	now := time.Now()
	if controller.SetWriteDeadline(now.Add(streamIdleTimeout)) != nil {
		return w, func() {}
	}
	return &idleDeadlineWriter{Writer: w, controller: controller, idle: streamIdleTimeout, refreshed: now},
		func() { _ = controller.SetWriteDeadline(time.Time{}) }
}

// copyStream relays src to dst through a pooled buffer. When dst is a response
// writer that supports deadlines, a rolling write deadline cuts off a client
// that stops reading.
func copyStream(dst io.Writer, src io.Reader) (int64, error) {
	buffer := streamBufferPool.Get().(*[]byte)
	defer streamBufferPool.Put(buffer)
	if responseWriter, ok := dst.(http.ResponseWriter); ok {
		var done func()
		dst, done = withIdleWriteDeadline(responseWriter)
		defer done()
	}
	return io.CopyBuffer(dst, src, *buffer)
}
