package main

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// /-/<host>/<bucket>/?info is the information page of the instance in the portal frontend. A deeper path stays the
// listing, an unknown instance is a 404, and the default frontend (no info.html) serves its listing.
func TestPortalInfoPageRoute(t *testing.T) {
	t.Parallel()
	portal, err := openFrontend(frontendPortal)
	if err != nil {
		t.Fatal(err)
	}
	defaultTree, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		t.Fatal(err)
	}
	instances := map[string]*storageInstance{"api": {cfg: bucketConfig{ID: "api", AuthID: "host"}}}
	for _, test := range []struct {
		name    string
		root    fs.FS
		path    string
		status  int
		content string
		base    string
	}{
		{name: "info page", root: portal, path: "/-/host/api/?info", status: http.StatusOK, content: `<body class="infoPage">`, base: `<base href="../../../" />`},
		{name: "info with a parameter", root: portal, path: "/-/host/api/?info&lifecycle-abort=logs%2F", status: http.StatusOK, content: `<body class="infoPage">`},
		{name: "deeper path is the listing", root: portal, path: "/-/host/api/folder/?info", status: http.StatusOK, content: "Skip to the files", base: `<base href="../../../../" />`},
		{name: "no info parameter is the listing", root: portal, path: "/-/host/api/", status: http.StatusOK, content: "Skip to the files"},
		{name: "unknown instance", root: portal, path: "/-/host/missing/?info", status: http.StatusNotFound},
		{name: "default frontend has no info page", root: defaultTree, path: "/-/host/api/?info", status: http.StatusOK, content: `id="root"`},
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
