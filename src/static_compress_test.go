package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// embeddedApplication serves the real embedded frontend instead of the stub file system.
func embeddedApplication(t *testing.T) *application {
	t.Helper()
	app, _, _ := testApplication(t)
	publicFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		t.Fatal(err)
	}
	app.publicFS = publicFS
	return app
}

func fetchStatic(t *testing.T, app *application, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, request)
	return recorder
}

func TestEmbeddedAssetsAreGzippedWhenAccepted(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)
	original, err := embeddedPublic.ReadFile("public/assets/css/tokens.css")
	if err != nil {
		t.Fatal(err)
	}

	plain := fetchStatic(t, app, "/assets/css/tokens.css", nil)
	if plain.Code != http.StatusOK || plain.Header().Get("Content-Encoding") != "" {
		t.Fatalf("plain request: status %d, encoding %q", plain.Code, plain.Header().Get("Content-Encoding"))
	}
	if !bytes.Equal(plain.Body.Bytes(), original) {
		t.Fatal("plain body differs from the embedded asset")
	}

	compressed := fetchStatic(t, app, "/assets/css/tokens.css", map[string]string{"Accept-Encoding": "br, gzip"})
	if compressed.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("encoding = %q, want gzip", compressed.Header().Get("Content-Encoding"))
	}
	if compressed.Header().Get("Content-Length") != "" {
		t.Fatalf("compressed response must not keep the identity Content-Length: %q", compressed.Header().Get("Content-Length"))
	}
	if got := compressed.Header().Values("Vary"); len(got) == 0 || got[0] != "Accept-Encoding" {
		t.Fatalf("Vary = %v, want Accept-Encoding", got)
	}
	reader, err := gzip.NewReader(compressed.Body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, original) {
		t.Fatal("decompressed body differs from the embedded asset")
	}
	if compressed.Body.Len() >= len(original) {
		t.Fatalf("compressed size %d is not smaller than %d", compressed.Body.Len(), len(original))
	}
}

func TestEmbeddedHTMLIsGzippedAndKeepsBaseHref(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)
	recorder := fetchStatic(t, app, "/index.html", map[string]string{"Accept-Encoding": "gzip"})
	if recorder.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("encoding = %q", recorder.Header().Get("Content-Encoding"))
	}
	reader, err := gzip.NewReader(recorder.Body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := io.ReadAll(reader)
	if !bytes.Contains(decoded, []byte(`<base href="./"`)) {
		t.Fatalf("decoded HTML lost its base href: %.120s", decoded)
	}
}

func TestStaticCompressionSkipsRangesRefusalsAndHeads(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)

	ranged := fetchStatic(t, app, "/assets/css/tokens.css", map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=0-9"})
	if ranged.Code != http.StatusPartialContent || ranged.Header().Get("Content-Encoding") != "" || ranged.Body.Len() != 10 {
		t.Fatalf("range response: status %d, encoding %q, %d bytes", ranged.Code, ranged.Header().Get("Content-Encoding"), ranged.Body.Len())
	}
	refused := fetchStatic(t, app, "/assets/css/tokens.css", map[string]string{"Accept-Encoding": "gzip;q=0, identity"})
	if refused.Header().Get("Content-Encoding") != "" {
		t.Fatalf("gzip;q=0 must not be compressed, got %q", refused.Header().Get("Content-Encoding"))
	}
	head := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodHead, "/assets/css/tokens.css", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	app.routes().ServeHTTP(head, request)
	if head.Header().Get("Content-Encoding") != "" {
		t.Fatalf("HEAD must keep identity headers, got %q", head.Header().Get("Content-Encoding"))
	}
}

func TestStaticCompressionDoesNotTouchBinaryAssets(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)
	recorder := fetchStatic(t, app, "/favicon.svg", map[string]string{"Accept-Encoding": "gzip"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if recorder.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("svg should be compressed, got %q", recorder.Header().Get("Content-Encoding"))
	}
}

func TestEmbeddedFirstPartyAssetsRevalidateWithETag(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)
	for _, name := range []string{"/assets/css/tokens.css", "/assets/js/app.js", "/assets/icons/mdi/folder.svg", "/"} {
		first := fetchStatic(t, app, name, nil)
		if first.Code != http.StatusOK {
			t.Fatalf("%s: status %d", name, first.Code)
		}
		etag := first.Header().Get("ETag")
		if etag == "" || etag[:3] != `W/"` {
			t.Fatalf("%s: ETag = %q, want a weak validator", name, etag)
		}
		if got := first.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control = %q, want no-cache so upgrades are picked up", name, got)
		}
		again := fetchStatic(t, app, name, map[string]string{"If-None-Match": etag})
		if again.Code != http.StatusNotModified || again.Body.Len() != 0 {
			t.Fatalf("%s: conditional request returned %d with %d body bytes", name, again.Code, again.Body.Len())
		}
		gzipped := fetchStatic(t, app, name, map[string]string{"Accept-Encoding": "gzip"})
		if gzipped.Header().Get("ETag") != etag {
			t.Fatalf("%s: the gzip variant must keep the same weak ETag", name)
		}
	}
}

func TestEmbeddedVendorAssetsAreImmutable(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)
	recorder := fetchStatic(t, app, "/assets/vendor/vue/3.5.18/vue.runtime.global.prod.js", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status %d", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestUnknownAddressesGetAStyled404ForBrowsersOnly(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)
	page := fetchStatic(t, app, "/-/no-such-host/no-such-bucket/", map[string]string{"Accept": "text/html,application/xhtml+xml"})
	if page.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", page.Code)
	}
	if got := page.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	body := page.Body.String()
	if !bytes.Contains([]byte(body), []byte("Page not found")) || bytes.Contains([]byte(body), []byte("{{APP_BASE}}")) {
		t.Fatalf("unexpected 404 page: %q", body)
	}
	plain := fetchStatic(t, app, "/-/no-such-host/no-such-bucket/", nil)
	if plain.Code != http.StatusNotFound || plain.Body.String() != "404 page not found\n" {
		t.Fatalf("non-browser request: %d %q", plain.Code, plain.Body.String())
	}
	missingAsset := fetchStatic(t, app, "/assets/css/missing.css", map[string]string{"Accept": "text/css,*/*;q=0.1"})
	if missingAsset.Code != http.StatusNotFound || missingAsset.Body.String() != "404 page not found\n" {
		t.Fatalf("missing asset: %d %q", missingAsset.Code, missingAsset.Body.String())
	}
}

func TestPagesFingerprintEveryAssetAndFingerprintedAssetsAreImmutable(t *testing.T) {
	t.Parallel()
	app := embeddedApplication(t)
	page := fetchStatic(t, app, "/", nil)
	body := page.Body.String()
	if strings.Contains(body, "{{ASSET_VERSION}}") {
		t.Fatal("the asset version placeholder was not replaced")
	}
	match := regexp.MustCompile(`name="bb-asset-version" content="([0-9a-f]{12})"`).FindStringSubmatch(body)
	if match == nil {
		t.Fatal("the page does not announce its asset version")
	}
	version := match[1]
	for _, reference := range regexp.MustCompile(`(?:href|src)="(assets/[^"]+)"`).FindAllStringSubmatch(body, -1) {
		if !strings.HasSuffix(reference[1], "?v="+version) {
			t.Fatalf("asset reference %q is not fingerprinted", reference[1])
		}
	}

	versioned := fetchStatic(t, app, "/assets/css/tokens.css?v="+version, nil)
	if got := versioned.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("fingerprinted Cache-Control = %q", got)
	}
	for _, request := range []string{"/assets/css/tokens.css", "/assets/css/tokens.css?v=000000000000"} {
		stale := fetchStatic(t, app, request, nil)
		if got := stale.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control = %q, want no-cache for an unknown fingerprint", request, got)
		}
	}

	icons := fetchStatic(t, app, "/assets/css/icons.css", nil)
	if !strings.Contains(icons.Body.String(), `.svg?v=`+version+`")`) {
		t.Fatal("icon URLs inside the stylesheet are not fingerprinted")
	}
}

func TestGzipBodiesAreCompressedOncePerContent(t *testing.T) {
	t.Parallel()
	data := bytes.Repeat([]byte("body { color: red; }\n"), 200)
	etag := contentETag(data)
	first := gzipBody(etag, data)
	second := gzipBody(etag, data)
	if &first[0] != &second[0] {
		t.Fatal("the gzip body was recompressed instead of being served from the cache")
	}
	reader, err := gzip.NewReader(bytes.NewReader(first))
	if err != nil {
		t.Fatal(err)
	}
	restored, _ := io.ReadAll(reader)
	if !bytes.Equal(restored, data) {
		t.Fatal("the cached gzip body does not decode to the original")
	}
}
