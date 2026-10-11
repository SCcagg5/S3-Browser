package main

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

// gzipJSONMinBytes is the smallest JSON body worth compressing: below it the gzip header and the CPU cost outweigh
// the saving, so short answers (errors, permission checks, job polls) stay plain.
const gzipJSONMinBytes = 1024

var gzipJSONPool = sync.Pool{New: func() any {
	writer, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed)
	return writer
}}

// gzipJSONMiddleware compresses large JSON API answers (listings, stats, previews) for clients that accept gzip.
// Everything else — object bytes, ZIP archives, static files — passes through untouched, because the decision is made
// from the response's own Content-Type once the handler has chosen it.
func gzipJSONMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || r.Method == http.MethodHead || !acceptsGzip(r) {
			next.ServeHTTP(w, r)
			return
		}
		compressor := &gzipJSONWriter{ResponseWriter: w}
		defer compressor.finish()
		next.ServeHTTP(compressor, r)
	})
}

type gzipJSONWriter struct {
	http.ResponseWriter
	status      int
	headerSet   bool // WriteHeader was called by the handler
	passthrough bool // not JSON (or already encoded): hand everything to the real writer
	committed   bool // the real header has been written
	pending     []byte
	gzip        *gzip.Writer
}

func (g *gzipJSONWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

func (g *gzipJSONWriter) WriteHeader(status int) {
	if g.headerSet {
		return
	}
	g.headerSet = true
	g.status = status
	header := g.Header()
	if status < 200 || status == http.StatusNoContent || status == http.StatusNotModified ||
		header.Get("Content-Encoding") != "" || header.Get("Content-Range") != "" ||
		!strings.HasPrefix(strings.ToLower(header.Get("Content-Type")), "application/json") {
		g.passthrough = true
		g.committed = true
		g.ResponseWriter.WriteHeader(status)
	}
}

func (g *gzipJSONWriter) Write(data []byte) (int, error) {
	if !g.headerSet {
		g.WriteHeader(http.StatusOK)
	}
	if g.passthrough {
		return g.ResponseWriter.Write(data)
	}
	if g.gzip != nil {
		return g.gzip.Write(data)
	}
	g.pending = append(g.pending, data...)
	if len(g.pending) >= gzipJSONMinBytes {
		g.startGzip()
		if _, err := g.gzip.Write(g.pending); err != nil {
			return 0, err
		}
		g.pending = nil
	}
	return len(data), nil
}

func (g *gzipJSONWriter) startGzip() {
	header := g.Header()
	header.Set("Content-Encoding", "gzip")
	header.Add("Vary", "Accept-Encoding")
	header.Del("Content-Length")
	g.committed = true
	g.ResponseWriter.WriteHeader(g.status)
	g.gzip = gzipJSONPool.Get().(*gzip.Writer)
	g.gzip.Reset(g.ResponseWriter)
}

// Flush sends what is buffered. A body that is still below the threshold is sent plain, since a flush means the
// handler wants the client to see it now.
func (g *gzipJSONWriter) Flush() {
	if g.gzip != nil {
		_ = g.gzip.Flush()
	} else if !g.committed && g.headerSet {
		g.commitPlain()
	}
	if flusher, ok := g.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (g *gzipJSONWriter) commitPlain() {
	g.passthrough = true
	g.committed = true
	g.ResponseWriter.WriteHeader(g.status)
	if len(g.pending) > 0 {
		_, _ = g.ResponseWriter.Write(g.pending)
		g.pending = nil
	}
}

func (g *gzipJSONWriter) finish() {
	switch {
	case g.gzip != nil:
		_ = g.gzip.Close()
		g.gzip.Reset(nil)
		gzipJSONPool.Put(g.gzip)
		g.gzip = nil
	case g.headerSet && !g.committed:
		g.commitPlain()
	}
}
