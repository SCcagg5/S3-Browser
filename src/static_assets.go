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
	gzipCache    sync.Map // weak ETag -> gzip-compressed body
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

// contentETag is a weak validator derived from the response bytes. It is weak because the same content is served
// both plain and gzip-encoded.
func contentETag(data []byte) string {
	sum := sha256.Sum256(data)
	return `W/"` + hex.EncodeToString(sum[:12]) + `"`
}

func gzipBody(etag string, data []byte) []byte {
	if cached, ok := gzipCache.Load(etag); ok {
		return cached.([]byte)
	}
	var buffer bytes.Buffer
	writer, _ := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
	_, _ = writer.Write(data)
	_ = writer.Close()
	compressed := buffer.Bytes()
	gzipCache.Store(etag, compressed)
	return compressed
}

// serveFrontendData answers with an embedded frontend file: validators, cache policy and (when the client accepts
// it) a gzip body that is compressed once per content. Range and HEAD requests are served plain.
func serveFrontendData(w http.ResponseWriter, r *http.Request, name, contentType, cacheControl string, data []byte) {
	header := w.Header()
	etag := contentETag(data)
	header.Set("Content-Type", contentType)
	header.Set("Cache-Control", cacheControl)
	header.Set("ETag", etag)
	header.Add("Vary", "Accept-Encoding")
	body := data
	if r.Method == http.MethodGet && r.Header.Get("Range") == "" && acceptsGzip(r) && compressibleContentType(contentType) {
		body = gzipBody(etag, data)
		header.Set("Content-Encoding", "gzip")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
}
