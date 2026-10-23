package main

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// Stowr has no authentication of its own. The schema is closed, so a configuration that still has an access block
// stops at start with the error of an unknown block. The error names the block and its line.
func TestAccessBlockStopsTheStart(t *testing.T) {
	t.Parallel()
	for name, block := range map[string]string{
		"open":    "access {\n  mode = \"open\"\n}\n",
		"authzen": "access {\n  mode = \"authzen\"\n  identity {\n    issuer = \"issuer\"\n  }\n}\n",
	} {
		path := filepath.Join(t.TempDir(), "config.hcl")
		writeConfig(t, path, "\n"+block+minimalTestConfig("bucket"))
		_, err := loadConfig(path)
		if err == nil {
			t.Fatalf("%s: the access block was accepted", name)
		}
		for _, want := range []string{`unknown block type "access"`, "line 2:"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("%s: error %q does not contain %q", name, err, want)
			}
		}
	}
}

// The reference, print-config and the routes do not show the removed access of humans.
func TestAccessIsNotInTheKeyTableOrTheRoutes(t *testing.T) {
	t.Parallel()
	reference := configReference()
	for _, removed := range []string{"`access.", "access {", "authzen", "PDP", "identity token"} {
		if strings.Contains(reference, removed) {
			t.Fatalf("the configuration reference still contains %q", removed)
		}
	}
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, minimalTestConfig("bucket"))
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if text := formatEffectiveConfiguration(cfg); strings.Contains(text, "access.mode") || strings.Contains(text, "access.identity") {
		t.Fatalf("print-config still shows the access block:\n%s", text)
	}
	app, _, _ := testApplication(t)
	app.publicFS = publicTree(t)
	recorder := fetchStatic(t, app, "/.well-known/access-actions", nil)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("/.well-known/access-actions: status %d, want 404", recorder.Code)
	}
}
