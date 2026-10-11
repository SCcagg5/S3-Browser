package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// First-party frontend files keep stable names, so the server fingerprints them instead: the HTML pages carry the
// fingerprint of the whole embedded frontend on every asset URL (?v=...), and a request whose fingerprint matches
// is cacheable for a year. A new binary changes the fingerprint, so every page load after an upgrade asks for new
// URLs; nothing stale is ever mixed with new markup. Requests without a fingerprint stay revalidated by ETag.

const assetVersionPlaceholder = "{{ASSET_VERSION}}"

var (
	versionMu    sync.Mutex
	versionCache = map[string]string{}
	htmlAssetRef = regexp.MustCompile(`((?:href|src)=")(assets/[^"?#]+)(")`)
	cssIconRef   = regexp.MustCompile(`url\("(\.\./icons/[^"?)]+)"\)`)
)

// frontendVersion fingerprints every file of the embedded frontend. It is computed once per file system.
func frontendVersion(root fs.FS) string {
	key := fmt.Sprintf("%p", root)
	versionMu.Lock()
	defer versionMu.Unlock()
	if version, ok := versionCache[key]; ok {
		return version
	}
	sum := sha256.New()
	_ = fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		data, readErr := fs.ReadFile(root, name)
		if readErr != nil {
			return nil
		}
		sum.Write([]byte(name))
		sum.Write([]byte{0})
		sum.Write(data)
		return nil
	})
	version := hex.EncodeToString(sum.Sum(nil))[:12]
	versionCache[key] = version
	return version
}

// versionHTML fills the fingerprint placeholder and appends it to every local asset URL of a page.
func versionHTML(html []byte, version string) []byte {
	html = bytes.ReplaceAll(html, []byte(assetVersionPlaceholder), []byte(version))
	return htmlAssetRef.ReplaceAll(html, []byte("${1}${2}?v="+version+"${3}"))
}

// versionCSS fingerprints the icon URLs inside a stylesheet so icons are cacheable with their stylesheet.
func versionCSS(css []byte, version string) []byte {
	return cssIconRef.ReplaceAll(css, []byte(`url("${1}?v=`+version+`")`))
}

// staticEntry is a frontend response prepared once: the final bytes (placeholders filled, URLs fingerprinted), their
// weak validator and, on first demand, the gzip form. Nothing here depends on the request, so concurrent requests
// share it. The ETag is weak because the same content is served both plain and gzip-encoded.
type staticEntry struct {
	data     []byte
	etag     string
	gzipOnce sync.Once
	gzipped  []byte
}

func newStaticEntry(data []byte) *staticEntry {
	sum := sha256.Sum256(data)
	return &staticEntry{data: data, etag: `W/"` + hex.EncodeToString(sum[:12]) + `"`}
}

// gzip returns the compressed body, computed at most once per entry.
func (e *staticEntry) gzip() []byte {
	e.gzipOnce.Do(func() {
		var buffer bytes.Buffer
		writer, _ := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
		_, _ = writer.Write(e.data)
		_ = writer.Close()
		e.gzipped = buffer.Bytes()
	})
	return e.gzipped
}

// staticCacheLimit and staticCacheByteLimit bound the prepared responses kept in memory. The first-party frontend is
// a few dozen files; the only per-request variable is the base href of the two HTML pages (one value per URL depth,
// and the depth is capped by maxFrontendDepth), so the caps are only reached by hostile URL shapes, which are then
// simply prepared again on every request. The byte budget counts each entry twice to cover its lazy gzip form.
const (
	staticCacheLimit     = 512
	staticCacheByteLimit = 64 << 20
)

var (
	staticMu    sync.RWMutex
	staticCache = map[string]*staticEntry{}
	// staticCacheBytes is the accounted size of staticCache, guarded by staticMu.
	staticCacheBytes int
)

// preparedStatic returns the prepared response for one frontend file. The key carries the fingerprint of the whole
// frontend, so a different embedded file system can never be served another build's bytes.
func preparedStatic(version, name, variant string, build func() ([]byte, error)) (*staticEntry, error) {
	key := version + "\x00" + name + "\x00" + variant
	staticMu.RLock()
	entry, ok := staticCache[key]
	staticMu.RUnlock()
	if ok {
		return entry, nil
	}
	data, err := build()
	if err != nil {
		return nil, err
	}
	entry = newStaticEntry(data)
	staticMu.Lock()
	if existing, ok := staticCache[key]; ok {
		entry = existing
	} else if size := 2 * len(entry.data); len(staticCache) < staticCacheLimit && staticCacheBytes+size <= staticCacheByteLimit {
		staticCache[key] = entry
		staticCacheBytes += size
	}
	staticMu.Unlock()
	return entry, nil
}

// serveFrontendEntry answers with a prepared frontend file: validators, cache policy and (when the client accepts
// it) the gzip body. Range and HEAD requests are served plain.
func serveFrontendEntry(w http.ResponseWriter, r *http.Request, name, contentType, cacheControl string, entry *staticEntry) {
	header := w.Header()
	header.Set("Content-Type", contentType)
	header.Set("Cache-Control", cacheControl)
	header.Set("ETag", entry.etag)
	header.Add("Vary", "Accept-Encoding")
	body := entry.data
	if r.Method == http.MethodGet && r.Header.Get("Range") == "" && acceptsGzip(r) && compressibleContentType(contentType) {
		body = entry.gzip()
		header.Set("Content-Encoding", "gzip")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
}
