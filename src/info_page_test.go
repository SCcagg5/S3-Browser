package main

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// /-/<host>/<bucket>/?info is the information page of the instance. A deeper path stays the listing, and an unknown
// instance is a 404.
func TestInfoPageRoute(t *testing.T) {
	t.Parallel()
	tree := publicTree(t)
	instances := map[string]*storageInstance{"api": {cfg: bucketConfig{ID: "api", AuthID: "host"}}}
	for _, test := range []struct {
		name    string
		root    fs.FS
		path    string
		status  int
		content string
		base    string
	}{
		{name: "info page", root: tree, path: "/-/host/api/?info", status: http.StatusOK, content: `<body class="infoPage">`, base: `<base href="../../../" />`},
		{name: "info with a parameter", root: tree, path: "/-/host/api/?info&lifecycle-abort=logs%2F", status: http.StatusOK, content: `<body class="infoPage">`},
		{name: "deeper path is the listing", root: tree, path: "/-/host/api/folder/?info", status: http.StatusOK, content: "Skip to the files", base: `<base href="../../../../" />`},
		{name: "no info parameter is the listing", root: tree, path: "/-/host/api/", status: http.StatusOK, content: "Skip to the files"},
		{name: "unknown instance", root: tree, path: "/-/host/missing/?info", status: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := &application{config: appConfig{Runtime: defaultRuntimePolicy()}, instances: instances, publicFS: test.root}
			recorder := httptest.NewRecorder()
			app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, test.path, nil))
			body := recorder.Body.String()
			if recorder.Code != test.status {
				t.Fatalf("GET %s status = %d; want %d", test.path, recorder.Code, test.status)
			}
			if test.content != "" && !strings.Contains(body, test.content) {
				t.Fatalf("GET %s does not serve %q", test.path, test.content)
			}
			if test.base != "" && !strings.Contains(body, test.base) {
				t.Fatalf("GET %s does not inject the base %q", test.path, test.base)
			}
			if test.status == http.StatusOK && strings.Contains(body, "{{") {
				t.Fatalf("GET %s keeps a placeholder", test.path)
			}
		})
	}
}

// /api/instances gives the S3 provider that the probe at start recognised, and no field when it is unknown.
func TestInstanceInfoGivesTheKnownFlavour(t *testing.T) {
	t.Parallel()
	known := &storageInstance{cfg: bucketConfig{ID: "m", AuthID: "h", Provider: "s3"}}
	known.lifecycle.flavour, known.lifecycle.flavourKnown = flavourMinIO, true
	if got := known.publicInfo().Flavour; got != flavourMinIO {
		t.Fatalf("flavour = %q, want %q", got, flavourMinIO)
	}
	unknown := &storageInstance{cfg: bucketConfig{ID: "u", AuthID: "h", Provider: "s3"}}
	info := unknown.publicInfo()
	if info.Flavour != "" {
		t.Fatalf("flavour of an instance without a probe = %q", info.Flavour)
	}
	body, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), `"flavour"`) {
		t.Fatalf("an unknown flavour is in the answer: %s", body)
	}
}
