package main

import (
	"context"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
)

// ghostLister lists a folder "ghost/" with a delimiter and no key under it, as MinIO does for an object whose current
// version is a delete marker.
type ghostLister struct {
	*memoryBackend
	probes atomic.Int64
	broken string
}

func (g *ghostLister) List(_ context.Context, options listOptions) (listPage, error) {
	if options.Delimiter != "" {
		prefixes := []string{"ghost/", "live/", "broken/"}
		for index := 0; index < 250; index++ {
			prefixes = append(prefixes, "many-"+strconv.Itoa(index)+"/")
		}
		return listPage{Prefixes: prefixes}, nil
	}
	g.probes.Add(1)
	switch options.Prefix {
	case "live/":
		return listPage{Objects: []objectInfo{{Key: "live/a.txt"}}}, nil
	case "broken/":
		return listPage{}, &upstreamError{StatusCode: http.StatusInternalServerError, Code: "InternalError"}
	}
	return listPage{}, nil
}

func ghostInstance(t *testing.T, flavour string, versioning bool) (*storageInstance, *ghostLister) {
	app, _, memory := testApplication(t)
	instance := app.instances["rw"]
	backend := &ghostLister{memoryBackend: memory}
	instance.backend = backend
	instance.setVersioningAvailable(versioning)
	instance.lifecycle.mu.Lock()
	instance.lifecycle.flavour, instance.lifecycle.flavourKnown = flavour, true
	instance.lifecycle.mu.Unlock()
	return instance, backend
}

func TestListHidesTheFolderOfADeleteMarkerOnMinIOWithVersioning(t *testing.T) {
	instance, backend := ghostInstance(t, flavourMinIO, true)
	page, err := instance.List(context.Background(), listOptions{Delimiter: "/"})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, prefix := range page.Prefixes {
		got[prefix] = true
	}
	if got["ghost/"] {
		t.Fatalf("the empty folder shows: %v", page.Prefixes[:3])
	}
	if !got["live/"] || !got["broken/"] {
		t.Fatalf("a folder with an object, and a folder whose probe failed, must stay: %v", page.Prefixes[:3])
	}
	// The probes are bounded: the folders after the limit stay without a probe.
	if probes := backend.probes.Load(); probes != maxPrefixProbes {
		t.Fatalf("probes = %d, want %d", probes, maxPrefixProbes)
	}
	if !got["many-249/"] {
		t.Fatal("a folder after the limit of probes stays")
	}
}

func TestListKeepsEveryFolderWhereTheProviderHasNoSuchFolder(t *testing.T) {
	for _, tc := range []struct {
		name       string
		flavour    string
		versioning bool
	}{
		{"seaweedfs", flavourSeaweedFS, true},
		{"aws", flavourAWS, true},
		{"minio without versioning", flavourMinIO, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			instance, backend := ghostInstance(t, tc.flavour, tc.versioning)
			page, err := instance.List(context.Background(), listOptions{Delimiter: "/"})
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Prefixes) != 253 || backend.probes.Load() != 0 {
				t.Fatalf("prefixes = %d, probes = %d: no probe expected", len(page.Prefixes), backend.probes.Load())
			}
		})
	}
}

func TestListWithoutDelimiterAddsNoProbe(t *testing.T) {
	instance, backend := ghostInstance(t, flavourMinIO, true)
	if _, err := instance.List(context.Background(), listOptions{Prefix: "live/"}); err != nil {
		t.Fatal(err)
	}
	if got := backend.probes.Load(); got != 1 {
		t.Fatalf("one request expected, got %d", got)
	}
}
