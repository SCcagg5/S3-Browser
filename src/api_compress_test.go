package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func serveThroughGzipJSON(t *testing.T, path, acceptEncoding string, handler http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptEncoding != "" {
		request.Header.Set("Accept-Encoding", acceptEncoding)
	}
	recorder := httptest.NewRecorder()
	gzipJSONMiddleware(handler).ServeHTTP(recorder, request)
	return recorder
}

func TestGzipJSONCompressesLargeAPIAnswers(t *testing.T) {
	t.Parallel()
	payload := map[string]any{"items": strings.Repeat("object-name-", 400)}
	recorder := serveThroughGzipJSON(t, "/api/list", "gzip", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, payload)
	})
	if got := recorder.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	reader, err := gzip.NewReader(recorder.Body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := io.ReadAll(reader)
	if !strings.Contains(string(decoded), "object-name-object-name-") || !strings.HasSuffix(string(decoded), "}\n") {
		t.Fatalf("decoded body is not the original JSON: %.80q", decoded)
	}
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("status/content-type changed: %d %q", recorder.Code, recorder.Header().Get("Content-Type"))
	}
}

func TestGzipJSONLeavesOtherResponsesAlone(t *testing.T) {
	t.Parallel()
	large := bytes.Repeat([]byte("x"), 4096)
	cases := []struct {
		name, path, accept string
		handler            http.HandlerFunc
		wantStatus         int
		wantBody           []byte
	}{
		{"small json", "/api/list", "gzip", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad"})
		}, http.StatusBadRequest, []byte("{\"error\":\"bad\"}\n")},
		{"large json without accept", "/api/list", "", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(large)
		}, http.StatusOK, large},
		{"zip", "/api/archive", "gzip", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(large)
		}, http.StatusOK, large},
		{"outside api", "/s3", "gzip", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(large)
		}, http.StatusOK, large},
		{"already encoded", "/api/list", "gzip", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", "br")
			_, _ = w.Write(large)
		}, http.StatusOK, large},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			recorder := serveThroughGzipJSON(t, tc.path, tc.accept, tc.handler)
			if encoding := recorder.Header().Get("Content-Encoding"); encoding == "gzip" {
				t.Fatalf("response was gzip-encoded")
			}
			if recorder.Code != tc.wantStatus || !bytes.Equal(recorder.Body.Bytes(), tc.wantBody) {
				t.Fatalf("status=%d body=%.60q", recorder.Code, recorder.Body.Bytes())
			}
		})
	}
}

func TestSortListItemsPutsFoldersFirstAndIgnoresCase(t *testing.T) {
	t.Parallel()
	items := []listItemJSON{
		{Type: "content", Name: "b.txt"},
		{Type: "prefix", Name: "Zeta/"},
		{Type: "content", Name: "A.txt"},
		{Type: "prefix", Name: "alpha/"},
		{Type: "content", Name: "a.txt"},
	}
	sortListItems(items)
	got := make([]string, len(items))
	for index, item := range items {
		got[index] = item.Name
	}
	// Stable for names that only differ by case: "A.txt" was listed before "a.txt".
	want := []string{"alpha/", "Zeta/", "A.txt", "a.txt", "b.txt"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestCopyStreamRelaysEveryByte(t *testing.T) {
	t.Parallel()
	data := bytes.Repeat([]byte("0123456789"), 100_000) // larger than the pooled buffer
	var out bytes.Buffer
	written, err := copyStream(&out, bytes.NewReader(data))
	if err != nil || written != int64(len(data)) || !bytes.Equal(out.Bytes(), data) {
		t.Fatalf("copyStream wrote %d bytes, err=%v", written, err)
	}
}

func TestPreparedStaticIsBuiltOncePerVariant(t *testing.T) {
	t.Parallel()
	version := fmt.Sprintf("test-version-%d", time.Now().UnixNano()) // the cache is process-wide: stay valid under -count
	builds := 0
	build := func(variant string) func() ([]byte, error) {
		return func() ([]byte, error) {
			builds++
			return []byte(variant), nil
		}
	}
	first, _ := preparedStatic(version, "index.html", "./", build("a"))
	again, _ := preparedStatic(version, "index.html", "./", build("a"))
	other, _ := preparedStatic(version, "index.html", "../", build("b"))
	if first != again {
		t.Fatal("the prepared response was rebuilt for the same file and variant")
	}
	if first == other || string(other.data) != "b" {
		t.Fatal("a different base href must produce its own prepared response")
	}
	if builds != 2 {
		t.Fatalf("builds = %d, want 2", builds)
	}
}
