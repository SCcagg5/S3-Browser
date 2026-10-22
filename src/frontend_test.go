package main

import (
	"io/fs"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
)

func TestServerFrontendDefaultsToDefault(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, minimalTestConfig("bucket"))
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Frontend != frontendDefault {
		t.Fatalf("frontend = %q, want %q", cfg.Frontend, frontendDefault)
	}
}

func TestServerFrontendAcceptsEachDocumentedName(t *testing.T) {
	t.Parallel()
	for _, name := range frontendNames {
		path := filepath.Join(t.TempDir(), "config.hcl")
		writeConfig(t, path, "server {\n  frontend = \""+name+"\"\n}\n"+minimalTestConfig("bucket"))
		cfg, err := loadConfig(path)
		if err != nil {
			t.Fatalf("frontend %q: %v", name, err)
		}
		if cfg.Frontend != name {
			t.Fatalf("frontend = %q, want %q", cfg.Frontend, name)
		}
	}
}

// The key is closed and not coerced: a value with another case or with spaces is an error that names the key, the
// expected values and the value.
func TestServerFrontendRejectsOtherValues(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"", "Default", " default", "portal ", "Portal", "clickhouse-dash"} {
		path := filepath.Join(t.TempDir(), "config.hcl")
		writeConfig(t, path, "server {\n  frontend = \""+value+"\"\n}\n"+minimalTestConfig("bucket"))
		_, err := loadConfig(path)
		if err == nil {
			t.Fatalf("frontend %q was accepted", value)
		}
		message := err.Error()
		for _, want := range []string{"server.frontend", `"default"`, `"portal"`, `got "` + value + `"`, "line 2:"} {
			if !strings.Contains(message, want) {
				t.Fatalf("frontend %q: error %q does not contain %q", value, message, want)
			}
		}
	}
}

// The key table holds server.frontend: the reference documents it, and print-config gives its value and source.
func TestServerFrontendIsInTheKeyTable(t *testing.T) {
	t.Parallel()
	if !strings.Contains(configReference(), "| `frontend` | text | \"default\" |") {
		t.Fatal("the configuration reference does not document server.frontend")
	}
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, minimalTestConfig("bucket"))
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if text := formatEffectiveConfiguration(cfg); !strings.Contains(text, `server.frontend = "default"  # default`) {
		t.Fatalf("print-config without the key:\n%s", text)
	}
	writeConfig(t, path, "server {\n  frontend = \"portal\"\n}\n"+minimalTestConfig("bucket"))
	if cfg, err = loadConfig(path); err != nil {
		t.Fatal(err)
	}
	if text := formatEffectiveConfiguration(cfg); !strings.Contains(text, `server.frontend = "portal"  # file`) {
		t.Fatalf("print-config with the key:\n%s", text)
	}
}

func TestServerFrontendRejectsWrongType(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, "server {\n  frontend = true\n}\n"+minimalTestConfig("bucket"))
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), `"frontend" must be a quoted string`) {
		t.Fatalf("error = %v", err)
	}
}

func TestOpenFrontendRejectsUnknownName(t *testing.T) {
	t.Parallel()
	if _, err := openFrontend("other"); err == nil {
		t.Fatal("unknown frontend was opened")
	}
}

// The overlay must behave as a correct read-only file system (fstest.TestFS walks it, opens every file and compares
// ReadDir, Stat and Open), give the vendored scripts of the default tree, and hide the rest of the default tree.
func TestPortalFrontendFileSystem(t *testing.T) {
	t.Parallel()
	root, err := openFrontend(frontendPortal)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"index.html", "preview.html", "info.html", "404.html", "favicon.svg",
		"assets/js/info.js", "assets/js/switcher.js", "assets/js/states.js", "assets/css/info.css",
		"assets/css/portal.css", "assets/css/icons.css", "assets/css/dialogs.css", "assets/css/viewers.css", "assets/css/preview.css",
		"assets/icons/tabler/folder.svg", "assets/js/app.js", "assets/js/theme.js", "assets/js/uploads.js",
		"assets/js/session.js", "assets/js/common/api.js",
		"assets/vendor/marked/12.0.2/marked.min.js", "assets/vendor/pdfjs/4.10.38/pdf.min.mjs",
	}
	if err := fstest.TestFS(root, expected...); err != nil {
		t.Fatal(err)
	}
	for _, hidden := range []string{"assets/css/style.css", "assets/css/tokens.css", "assets/icons/mdi/folder.svg", "assets/vendor/../css/style.css"} {
		if _, err := fs.Stat(root, hidden); err == nil {
			t.Fatalf("%s is visible through the portal frontend", hidden)
		}
	}
	entries, err := fs.ReadDir(root, "assets")
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !sort.StringsAreSorted(names) || !strings.Contains(strings.Join(names, ","), "vendor") {
		t.Fatalf("assets entries = %v", names)
	}
}

func frontendApplication(t *testing.T, name string) *application {
	t.Helper()
	app, _, _ := testApplication(t)
	root, err := openFrontend(name)
	if err != nil {
		t.Fatal(err)
	}
	app.publicFS = root
	return app
}

func TestPortalFrontendIsServed(t *testing.T) {
	t.Parallel()
	app := frontendApplication(t, frontendPortal)
	version := frontendVersion(app.publicFS)
	defaultRoot, err := openFrontend(frontendDefault)
	if err != nil {
		t.Fatal(err)
	}
	if version == frontendVersion(defaultRoot) {
		t.Fatal("the two frontends have the same fingerprint")
	}

	for _, page := range []string{"/", "/index.html", "/preview.html", "/info.html"} {
		recorder := fetchStatic(t, app, page, nil)
		body := recorder.Body.String()
		if recorder.Code != http.StatusOK || !strings.Contains(body, `<meta name="bb-frontend" content="portal" />`) {
			t.Fatalf("%s: status %d, body %.200q", page, recorder.Code, body)
		}
		for _, asset := range []string{"assets/css/portal.css", "assets/js/theme.js"} {
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

	vendor := fetchStatic(t, app, "/assets/vendor/marked/12.0.2/marked.min.js", nil)
	if vendor.Code != http.StatusOK {
		t.Fatalf("vendor: status %d", vendor.Code)
	}
	if missing := fetchStatic(t, app, "/assets/css/style.css", nil); missing.Code != http.StatusNotFound {
		t.Fatalf("default stylesheet status = %d, want 404", missing.Code)
	}
	notFound := fetchStatic(t, app, "/missing-page", map[string]string{"Accept": "text/html"})
	if notFound.Code != http.StatusNotFound || !strings.Contains(notFound.Body.String(), "assets/css/portal.css") {
		t.Fatalf("404 page: status %d, body %.200q", notFound.Code, notFound.Body.String())
	}
}

func TestDefaultFrontendStaysTheDefaultTree(t *testing.T) {
	t.Parallel()
	app := frontendApplication(t, frontendDefault)
	recorder := fetchStatic(t, app, "/", nil)
	body := recorder.Body.String()
	if recorder.Code != http.StatusOK || strings.Contains(body, "bb-frontend") || !strings.Contains(body, "assets/css/tokens.css?v=") {
		t.Fatalf("default index: status %d, body %.300q", recorder.Code, body)
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

// The portal tree must stay self-contained: no external URL, every page asset and every icon file present, and an
// icon rule for every icon name that the pages and the scripts write.
func TestPortalFrontendIsSelfContained(t *testing.T) {
	t.Parallel()
	root, err := openFrontend(frontendPortal)
	if err != nil {
		t.Fatal(err)
	}
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
		if err != nil || entry.IsDir() || strings.HasPrefix(name, sharedFrontendPrefix) {
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
