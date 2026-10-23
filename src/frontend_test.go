package main

import (
	"io/fs"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

// vendorPrefix holds the vendored third-party scripts (PDF.js, highlight.js, marked). They keep their own text.
const vendorPrefix = "assets/vendor"

// publicTree is the one embedded browser interface.
func publicTree(t *testing.T) fs.FS {
	t.Helper()
	root, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// The key server.frontend is gone: the schema is closed, so a configuration that still has it stops at start with
// the error of an unknown attribute. The error names the key and its line.
func TestServerFrontendKeyStopsTheStart(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"default", "stowr"} {
		path := filepath.Join(t.TempDir(), "config.hcl")
		writeConfig(t, path, "server {\n  frontend = \""+value+"\"\n}\n"+minimalTestConfig("bucket"))
		_, err := loadConfig(path)
		if err == nil {
			t.Fatalf("frontend = %q was accepted", value)
		}
		for _, want := range []string{`unknown attribute "frontend" in server block`, "line 2:"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("frontend = %q: error %q does not contain %q", value, err, want)
			}
		}
	}
}

// The reference and print-config do not show the removed key.
func TestServerFrontendIsNotInTheKeyTable(t *testing.T) {
	t.Parallel()
	if strings.Contains(configReference(), "`frontend`") {
		t.Fatal("the configuration reference still documents server.frontend")
	}
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, minimalTestConfig("bucket"))
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if text := formatEffectiveConfiguration(cfg); strings.Contains(text, "frontend") {
		t.Fatalf("print-config still shows the frontend:\n%s", text)
	}
}

// The tree must be a correct read-only file system (fstest.TestFS walks it, opens every file and compares ReadDir,
// Stat and Open). The files of the removed interface and its vendored styles are not in the binary.
func TestInterfaceFileSystem(t *testing.T) {
	t.Parallel()
	root := publicTree(t)
	expected := []string{
		"index.html", "preview.html", "info.html", "404.html", "favicon.svg",
		"assets/js/info.js", "assets/js/switcher.js", "assets/js/states.js", "assets/css/info.css",
		"assets/css/stowr.css", "assets/css/icons.css", "assets/css/dialogs.css", "assets/css/viewers.css", "assets/css/preview.css",
		"assets/icons/tabler/folder.svg", "assets/js/app.js", "assets/js/theme.js", "assets/js/uploads.js",
		"assets/js/session.js", "assets/js/common/api.js",
		"assets/vendor/marked/12.0.2/marked.min.js", "assets/vendor/highlightjs/11/highlight.min.js",
		"assets/vendor/pdfjs/4.10.38/pdf.min.mjs", "assets/vendor/pdfjs/4.10.38/pdf.worker.min.mjs",
		"assets/vendor/pdfjs/4.10.38/LICENSE",
	}
	if err := fstest.TestFS(root, expected...); err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{
		"assets/css/style.css", "assets/css/tokens.css", "assets/icons/mdi", "assets/vendor/buefy",
		"assets/vendor/github-markdown-css", "assets/vendor/highlightjs/11/styles",
	} {
		if _, err := fs.Stat(root, removed); err == nil {
			t.Fatalf("%s of the removed interface is still embedded", removed)
		}
	}
}

// Each vendored script is loaded by a page or a script of the interface, so the binary carries no dead vendor file.
func TestInterfaceUsesEachVendorFile(t *testing.T) {
	t.Parallel()
	root := publicTree(t)
	var sources strings.Builder
	var vendored []string
	err := fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		if strings.HasPrefix(name, vendorPrefix+"/") {
			if extension := path.Ext(name); extension == ".js" || extension == ".mjs" || extension == ".css" {
				vendored = append(vendored, name)
			}
			return nil
		}
		if extension := path.Ext(name); extension == ".html" || extension == ".js" || extension == ".css" {
			data, err := fs.ReadFile(root, name)
			if err != nil {
				return err
			}
			sources.Write(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(vendored) == 0 {
		t.Fatal("no vendored script")
	}
	text := strings.ReplaceAll(sources.String(), "${PDFJS_VERSION}", "4.10.38")
	for _, name := range vendored {
		if !strings.Contains(text, name) {
			t.Errorf("no page or script loads %s", name)
		}
	}
}

func TestInterfaceIsServed(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	app.publicFS = publicTree(t)
	version := frontendVersion(app.publicFS)

	for _, page := range []string{"/", "/index.html", "/preview.html", "/info.html"} {
		recorder := fetchStatic(t, app, page, nil)
		body := recorder.Body.String()
		if recorder.Code != http.StatusOK || !strings.Contains(body, `<meta name="bb-frontend" content="stowr" />`) {
			t.Fatalf("%s: status %d, body %.200q", page, recorder.Code, body)
		}
		for _, asset := range []string{"assets/css/stowr.css", "assets/js/theme.js"} {
			if !strings.Contains(body, `="`+asset+`?v=`+version+`"`) {
				t.Fatalf("%s does not link the fingerprinted %s", page, asset)
			}
		}
		// The theme applies before the first paint: theme.js is the first script and has no defer or async.
		if first := strings.Index(body, "<script"); first < 0 || !strings.HasPrefix(body[first:], `<script src="assets/js/theme.js?v=`) || first > strings.Index(body, "</head>") {
			t.Fatalf("%s does not load theme.js first in <head>", page)
		}
		if strings.Contains(body, "{{") {
			t.Fatalf("%s keeps a placeholder", page)
		}
		for _, header := range []string{"Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
			if recorder.Header().Get(header) == "" {
				t.Fatalf("%s has no %s header", page, header)
			}
		}
	}

	css := fetchStatic(t, app, "/assets/css/icons.css?v="+version, nil)
	if css.Code != http.StatusOK || css.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("icons.css: status %d, cache %q", css.Code, css.Header().Get("Cache-Control"))
	}
	if !strings.Contains(css.Body.String(), `url("../icons/tabler/folder.svg?v=`+version+`")`) {
		t.Fatalf("the icon URLs of icons.css are not fingerprinted: %.300s", css.Body.String())
	}

	for _, vendor := range []string{"/assets/vendor/marked/12.0.2/marked.min.js", "/assets/vendor/pdfjs/4.10.38/pdf.worker.min.mjs"} {
		if recorder := fetchStatic(t, app, vendor, nil); recorder.Code != http.StatusOK {
			t.Fatalf("%s: status %d", vendor, recorder.Code)
		}
	}
	if missing := fetchStatic(t, app, "/assets/css/style.css", nil); missing.Code != http.StatusNotFound {
		t.Fatalf("stylesheet of the removed interface: status = %d, want 404", missing.Code)
	}
	notFound := fetchStatic(t, app, "/missing-page", map[string]string{"Accept": "text/html"})
	if notFound.Code != http.StatusNotFound || !strings.Contains(notFound.Body.String(), "assets/css/stowr.css") {
		t.Fatalf("404 page: status %d, body %.200q", notFound.Code, notFound.Body.String())
	}
}

var (
	urlLiteral     = regexp.MustCompile(`https?://|//cdn\.`)
	pageAssetRef   = regexp.MustCompile(`(?:href|src)="(assets/[^"?#]+)`)
	cssIconTarget  = regexp.MustCompile(`url\("\.\./(icons/[^"?]+)"\)`)
	iconRule       = regexp.MustCompile(`\.((?:mdi|ic)-[a-z0-9-]+) \{ --icon:`)
	iconClassUse   = regexp.MustCompile(`\b(?:mdi|ic) ((?:mdi|ic)-[a-z0-9-]+)`)
	iconHelperCall = regexp.MustCompile(`\b(ic|mdi|icon)\('([a-z0-9-]+)'`)
	detectIconName = regexp.MustCompile(`:\s*'([a-z0-9-]+)'|\|\| '([a-z0-9-]+)'`)
)

// The interface must stay self-contained: no external URL, every page asset and every icon file present, and an
// icon rule for every icon name that the pages and the scripts write.
func TestInterfaceIsSelfContained(t *testing.T) {
	t.Parallel()
	root := publicTree(t)
	icons, err := fs.ReadFile(root, "assets/css/icons.css")
	if err != nil {
		t.Fatal(err)
	}
	rules := map[string]bool{}
	for _, match := range iconRule.FindAllStringSubmatch(string(icons), -1) {
		rules[match[1]] = true
	}
	if len(rules) < 50 {
		t.Fatalf("icons.css has %d icon rules", len(rules))
	}
	for _, match := range cssIconTarget.FindAllStringSubmatch(string(icons), -1) {
		if _, err := fs.Stat(root, path.Join("assets", match[1])); err != nil {
			t.Errorf("icons.css draws the missing file %s", match[1])
		}
	}
	err = fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || strings.HasPrefix(name, vendorPrefix) {
			return err
		}
		extension := path.Ext(name)
		if extension != ".html" && extension != ".js" && extension != ".css" {
			return nil
		}
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return err
		}
		text := string(data)
		if match := urlLiteral.FindString(text); match != "" {
			t.Errorf("%s contains the external URL literal %q", name, match)
		}
		if extension == ".css" {
			for _, match := range cssIconTarget.FindAllStringSubmatch(text, -1) {
				if _, err := fs.Stat(root, path.Join("assets", match[1])); err != nil {
					t.Errorf("%s draws the missing file %s", name, match[1])
				}
			}
			return nil
		}
		if extension == ".html" {
			for _, match := range pageAssetRef.FindAllStringSubmatch(text, -1) {
				if _, err := fs.Stat(root, match[1]); err != nil {
					t.Errorf("%s references the missing asset %s", name, match[1])
				}
			}
		}
		for _, match := range iconClassUse.FindAllStringSubmatch(text, -1) {
			if match[1] != "mdi-spin" && match[1] != "mdi-24px" && !rules[match[1]] {
				t.Errorf("%s uses the icon %s, which icons.css does not draw", name, match[1])
			}
		}
		for _, match := range iconHelperCall.FindAllStringSubmatch(text, -1) {
			prefix := "mdi-"
			if match[1] == "ic" {
				prefix = "ic-"
			}
			if !rules[prefix+match[2]] {
				t.Errorf("%s draws the icon %s%s, which icons.css does not draw", name, prefix, match[2])
			}
		}
		if name == "assets/js/common/detect.js" {
			start := strings.Index(text, "function iconForType")
			end := strings.Index(text, "function resolveType")
			if start < 0 || end < start {
				t.Fatal("detect.js has no iconForType")
			}
			for _, match := range detectIconName.FindAllStringSubmatch(text[start:end], -1) {
				icon := match[1] + match[2]
				if !rules["mdi-"+icon] {
					t.Errorf("detect.js gives the icon mdi-%s, which icons.css does not draw", icon)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
