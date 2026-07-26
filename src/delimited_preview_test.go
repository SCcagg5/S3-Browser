package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDelimitedPreviewPagesTSVWithoutLoadingWholeObject(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/table.tsv"] = memoryObject{
		data:        []byte("name\tvalue\nalpha\t1\nbeta\t2\ngamma\t3\ndelta\t4\n"),
		contentType: "text/tab-separated-values",
	}
	backend.mu.Unlock()

	request := httptest.NewRequest(http.MethodGet, "/api/delimited?instance=rw&key=table.tsv&pageSize=2", nil)
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("first page status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var first delimitedPageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if strings.Join(first.Headers, ",") != "name,value" || len(first.Rows) != 2 || first.Done || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/delimited?instance=rw&key=table.tsv&pageSize=2&cursor="+url.QueryEscape(first.NextCursor), nil)
	recorder = httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("second page status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var second delimitedPageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if len(second.Rows) != 2 || second.Rows[0][0] != "gamma" || second.Rows[1][0] != "delta" || !second.Done {
		t.Fatalf("second page = %+v", second)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.getCount != 2 {
		t.Fatalf("GET count = %d, want 2", backend.getCount)
	}
	requireExactByteRanges(t, backend.getRanges)
	if exactRangeStart(t, backend.getRanges[0]) != 0 || exactRangeStart(t, backend.getRanges[1]) <= 0 {
		t.Fatalf("ranges did not resume from the cursor: %#v", backend.getRanges)
	}
}

func TestDelimitedPreviewHandlesTSVLargerThanBrowserLimit(t *testing.T) {
	app, _, backend := testApplication(t)
	const targetBytes = 33 * 1024 * 1024
	row := []byte("large-value\t42\n")
	data := make([]byte, 0, targetBytes+len(row)+16)
	data = append(data, []byte("name\tvalue\n")...)
	data = append(data, bytes.Repeat(row, targetBytes/len(row)+1)...)
	backend.mu.Lock()
	backend.objects["tenant/large.tsv"] = memoryObject{
		data:        data,
		contentType: "text/tab-separated-values",
	}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/delimited?instance=rw&key=large.tsv&pageSize=3", nil)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var page delimitedPageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 3 || page.Rows[0][0] != "large-value" || page.Done || page.NextCursor == "" {
		t.Fatalf("page = %+v", page)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.getCount != 1 {
		t.Fatalf("GET count = %d, want 1", backend.getCount)
	}
	requireExactByteRanges(t, backend.getRanges)
}

func TestDocumentCountIsExplicitForTSV(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/table.tsv"] = memoryObject{
		data:        []byte("name\tvalue\nalpha\t1\nbeta\t2\n"),
		contentType: "text/tab-separated-values",
	}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/media-info?instance=rw&key=table.tsv&size=30&mime=text/tab-separated-values", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("details status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	backend.mu.Lock()
	if backend.getCount != 0 || backend.headCount != 1 {
		backend.mu.Unlock()
		t.Fatalf("details used GET=%d HEAD=%d, want GET=0 HEAD=1", backend.getCount, backend.headCount)
	}
	backend.mu.Unlock()

	recorder = httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/document-count?instance=rw&key=table.tsv", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("count status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var result documentCountResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Rows != 2 || result.Columns != 2 {
		t.Fatalf("count = %+v", result)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.getCount != 1 {
		t.Fatalf("count GETs = %d, want 1", backend.getCount)
	}
}

func TestDelimitedPreviewStripsUTF8BOMFromHeader(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/bom.tsv"] = memoryObject{
		data:        []byte("\xef\xbb\xbfid\tvalue\n1\talpha\n"),
		contentType: "text/tab-separated-values",
	}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/delimited?instance=rw&key=bom.tsv&pageSize=100", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var page delimitedPageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Headers) != 2 || page.Headers[0] != "id" || page.Headers[1] != "value" {
		t.Fatalf("headers = %#v", page.Headers)
	}
}
