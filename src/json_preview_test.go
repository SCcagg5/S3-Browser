package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func putJSONTestObject(backend *memoryBackend, key, value string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.objects[key] = memoryObject{data: []byte(value), contentType: "application/json"}
}

func decodeJSONResponse[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status %d: %s", recorder.Code, recorder.Body.String())
	}
	var response T
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode JSON response: %v", err)
	}
	return response
}

func TestJSONRawPagesStreamWithoutWholeObjectBuffer(t *testing.T) {
	app, _, backend := testApplication(t)
	payload := `{"large":"` + strings.Repeat("x", jsonTextPageBytes*2) + `","tail":true}`
	putJSONTestObject(backend, "tenant/large.json", payload)

	request := httptest.NewRequest(http.MethodGet, "/api/json/raw?instance=rw&key=large.json", nil)
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, request)
	first := decodeJSONResponse[jsonTextPageResponse](t, recorder)
	if first.Done || first.NextCursor == "" {
		t.Fatalf("expected a continuation cursor for the large raw page: %+v", first)
	}
	if len(first.Text) > jsonTextPageBytes+utf8MaxRuneBytes {
		t.Fatalf("raw page exceeded the bounded response size: %d", len(first.Text))
	}
	if backend.getCount < 1 || backend.getCount > 2 {
		t.Fatalf("unexpected first raw read count: %d ranges=%v", backend.getCount, backend.getRanges)
	}
	requireExactByteRanges(t, backend.getRanges)
	if exactRangeStart(t, backend.getRanges[0]) != 0 {
		t.Fatalf("the first raw page did not start at byte zero: %v", backend.getRanges)
	}

	secondURL := "/api/json/raw?instance=rw&key=large.json&cursor=" + url.QueryEscape(first.NextCursor)
	recorder = httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, secondURL, nil))
	second := decodeJSONResponse[jsonTextPageResponse](t, recorder)
	if second.Text == "" {
		t.Fatal("expected a second raw page")
	}
	requireExactByteRanges(t, backend.getRanges)
	if exactRangeStart(t, backend.getRanges[len(backend.getRanges)-1]) <= 0 {
		t.Fatalf("the next raw page should resume from its byte cursor: %v", backend.getRanges)
	}
}

const utf8MaxRuneBytes = 4

func TestJSONRawPreservesTheOriginalSource(t *testing.T) {
	app, _, backend := testApplication(t)
	payload := "{\n\t\"unicode\": \"é\\n雪\",\n\t\"spacing\"   : [ 1,  2 ]\n}\n"
	putJSONTestObject(backend, "tenant/exact.json", payload)

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/json/raw?instance=rw&key=exact.json", nil))
	response := decodeJSONResponse[jsonTextPageResponse](t, recorder)
	if !response.Done {
		t.Fatal("the small raw document should fit in one page")
	}
	if response.Text != payload {
		t.Fatalf("raw JSON changed the source bytes:\n got %q\nwant %q", response.Text, payload)
	}
	if backend.getCount != 1 {
		t.Fatalf("raw JSON should use one bounded provider request: %v", backend.getRanges)
	}
	requireExactByteRanges(t, backend.getRanges)
	if exactRangeStart(t, backend.getRanges[0]) != 0 {
		t.Fatalf("raw JSON should start at byte zero: %v", backend.getRanges)
	}
}

func TestJSONBeautifyUsesContinuationState(t *testing.T) {
	app, _, backend := testApplication(t)
	payload := `{"name":"` + strings.Repeat("é", jsonTextPageBytes) + `","nested":{"enabled":true},"items":[1,2,3]}`
	putJSONTestObject(backend, "tenant/beautify.json", payload)

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/json/beautify?instance=rw&key=beautify.json", nil))
	first := decodeJSONResponse[jsonTextPageResponse](t, recorder)
	if first.NextCursor == "" || first.Done {
		t.Fatalf("expected the large string to continue on another beautified page: %+v", first)
	}
	if !strings.HasPrefix(first.Text, "{\n  \"name\": \"") {
		t.Fatalf("unexpected beautified prefix: %q", first.Text[:minInt(len(first.Text), 80)])
	}

	recorder = httptest.NewRecorder()
	nextURL := "/api/json/beautify?instance=rw&key=beautify.json&cursor=" + url.QueryEscape(first.NextCursor)
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, nextURL, nil))
	second := decodeJSONResponse[jsonTextPageResponse](t, recorder)
	if second.Text == "" {
		t.Fatal("expected continuation text")
	}
	requireExactByteRanges(t, backend.getRanges)
	if exactRangeStart(t, backend.getRanges[len(backend.getRanges)-1]) <= 0 {
		t.Fatalf("beautify continuation should use resumed bounded ranges: %v", backend.getRanges)
	}
}

func TestJSONTreeRootIsExpandedServerSideWithBoundedPreviews(t *testing.T) {
	app, _, backend := testApplication(t)
	payload := `{"small":1,"nested":{"enabled":true,"values":[1,2,{"label":"ok"}]},"large":"` + strings.Repeat("x", 2*1024*1024) + `","tail":null}`
	putJSONTestObject(backend, "tenant/tree.json", payload)

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/json/tree?instance=rw&key=tree.json&limit=50", nil))
	root := decodeJSONResponse[jsonTreeResponse](t, recorder)
	if root.Node.Type != "object" || !root.Node.Container || !root.Done {
		t.Fatalf("unexpected root response: %+v", root)
	}
	labels := make([]string, 0, len(root.Children))
	var nested jsonTreeNodeJSON
	for _, child := range root.Children {
		labels = append(labels, child.Label)
		if child.Label == "nested" {
			nested = child
		}
		if child.Label == "large" && (len(child.Preview) > jsonTreePreviewBytes+8 || !strings.HasSuffix(child.Preview, `…"`)) {
			t.Fatalf("large string preview was not bounded: %d %q", len(child.Preview), child.Preview)
		}
	}
	if strings.Join(labels, ",") != "small,nested,large,tail" {
		t.Fatalf("unexpected root children: %v", labels)
	}
	if backend.getCount < 1 {
		t.Fatalf("the root expansion should read bounded ranges: %v", backend.getRanges)
	}
	requireExactByteRanges(t, backend.getRanges)
	if exactRangeStart(t, backend.getRanges[0]) != 0 {
		t.Fatalf("the root expansion should start at byte zero: %v", backend.getRanges)
	}
	rootReadCount := backend.getCount

	nestedURL := fmt.Sprintf("/api/json/tree?instance=rw&key=tree.json&type=object&start=%d&limit=50", nested.Start)
	recorder = httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, nestedURL, nil))
	children := decodeJSONResponse[jsonTreeResponse](t, recorder)
	if len(children.Children) != 2 || children.Children[0].Label != "enabled" || children.Children[1].Label != "values" {
		t.Fatalf("unexpected nested children: %+v", children.Children)
	}
	if backend.getCount <= rootReadCount {
		t.Fatalf("nested expansion did not issue a bounded read: %v", backend.getRanges)
	}
	requireExactByteRanges(t, backend.getRanges[rootReadCount:])
	if exactRangeStart(t, backend.getRanges[rootReadCount]) != nested.Start {
		t.Fatalf("nested expansion should start at the node offset: %v", backend.getRanges)
	}
}

func TestJSONTreePaginationResumesAfterComma(t *testing.T) {
	app, _, backend := testApplication(t)
	values := make([]string, 0, 125)
	for index := 0; index < 125; index++ {
		values = append(values, strconv.Itoa(index))
	}
	putJSONTestObject(backend, "tenant/list.json", "["+strings.Join(values, ",")+"]")

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/json/tree?instance=rw&key=list.json&limit=50", nil))
	first := decodeJSONResponse[jsonTreeResponse](t, recorder)
	if first.Done || len(first.Children) != 50 || first.Cursor == "" || first.NextIndex != 50 {
		t.Fatalf("unexpected first page: %+v", first)
	}

	nextURL := fmt.Sprintf("/api/json/tree?instance=rw&key=list.json&type=array&start=%d&cursor=%s&index=%d&limit=50", first.Node.Start, url.QueryEscape(first.Cursor), first.NextIndex)
	recorder = httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, nextURL, nil))
	second := decodeJSONResponse[jsonTreeResponse](t, recorder)
	if second.Done || len(second.Children) != 50 || second.Children[0].Label != "50" {
		t.Fatalf("unexpected second page: %+v", second)
	}
	if backend.getCount != 2 {
		t.Fatalf("tree pagination should use one bounded request per small page: %v", backend.getRanges)
	}
	requireExactByteRanges(t, backend.getRanges)
	cursor, _, err := decodeJSONTreeCursor(first.Cursor, signedCursorScope("json-tree", "rw", "list.json"))
	if err != nil {
		t.Fatalf("decode tree cursor: %v", err)
	}
	if exactRangeStart(t, backend.getRanges[1]) != cursor.Offset {
		t.Fatalf("tree pagination should resume at the signed cursor offset: %v", backend.getRanges)
	}
}

func TestJSONBeautifyFormatsEmptyAndNestedContainers(t *testing.T) {
	app, _, backend := testApplication(t)
	putJSONTestObject(backend, "tenant/small.json", `{"a":1,"empty":{},"items":[true,false],"nested":{"value":null}}`)

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/json/beautify?instance=rw&key=small.json", nil))
	response := decodeJSONResponse[jsonTextPageResponse](t, recorder)
	if !response.Done {
		t.Fatal("small JSON should fit in one beautified page")
	}
	expected := "{\n  \"a\": 1,\n  \"empty\": {},\n  \"items\": [\n    true,\n    false\n  ],\n  \"nested\": {\n    \"value\": null\n  }\n}"
	if response.Text != expected {
		t.Fatalf("unexpected beautified JSON:\n%s\nwant:\n%s", response.Text, expected)
	}
}

func TestJSONSummaryMatchesPagedRawAndBeautifiedViews(t *testing.T) {
	app, _, backend := testApplication(t)
	payload := `{"large":"` + strings.Repeat("x", jsonTextPageBytes+4096) + `","items":[1,2,3],"tail":true}`
	putJSONTestObject(backend, "tenant/summary.json", payload)

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/json/summary?instance=rw&key=summary.json", nil))
	summary := decodeJSONResponse[jsonSummaryResponse](t, recorder)
	if summary.RawLines != 1 || summary.RawPages < 2 || summary.BeautifyLines < 2 || summary.BeautifyPages < 2 {
		t.Fatalf("unexpected JSON summary: %+v", summary)
	}
	if summary.RawPage == nil || summary.RawPage.Done || summary.RawPage.NextCursor == "" {
		t.Fatalf("the summary should include the first paged Raw response: %+v", summary.RawPage)
	}
	if len(summary.RawPage.Text) > jsonTextPageBytes+utf8MaxRuneBytes || summary.RawPage.LineStart != 1 {
		t.Fatalf("unexpected first Raw page in summary: %+v", summary.RawPage)
	}
	if backend.getCount < 1 {
		t.Fatalf("JSON summary should use bounded provider ranges: %v", backend.getRanges)
	}
	requireExactByteRanges(t, backend.getRanges)
	if exactRangeStart(t, backend.getRanges[0]) != 0 {
		t.Fatalf("JSON summary should start at byte zero: %v", backend.getRanges)
	}

	countPages := func(endpoint string, first *jsonTextPageResponse) (int64, int64) {
		t.Helper()
		var pages int64
		var finalLine int64
		cursor := ""
		if first != nil {
			pages = 1
			finalLine = first.LineEnd
			if first.Done {
				return pages, finalLine
			}
			cursor = first.NextCursor
		}
		for {
			requestURL := endpoint
			if cursor != "" {
				requestURL += "&cursor=" + url.QueryEscape(cursor)
			}
			recorder := httptest.NewRecorder()
			app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, requestURL, nil))
			page := decodeJSONResponse[jsonTextPageResponse](t, recorder)
			pages++
			finalLine = page.LineEnd
			if page.Done {
				return pages, finalLine
			}
			if page.NextCursor == "" {
				t.Fatal("paged JSON response omitted its continuation cursor")
			}
			cursor = page.NextCursor
		}
	}

	rawPages, rawLines := countPages("/api/json/raw?instance=rw&key=summary.json", summary.RawPage)
	if rawPages != summary.RawPages || rawLines != summary.RawLines {
		t.Fatalf("raw summary/pages mismatch: summary=%+v pages=%d lines=%d", summary, rawPages, rawLines)
	}
	beautifyPages, beautifyLines := countPages("/api/json/beautify?instance=rw&key=summary.json", nil)
	if beautifyPages != summary.BeautifyPages || beautifyLines != summary.BeautifyLines {
		t.Fatalf("beautify summary/pages mismatch: summary=%+v pages=%d lines=%d", summary, beautifyPages, beautifyLines)
	}
}

func TestJSONTreeReportsArrayElementCounts(t *testing.T) {
	app, _, backend := testApplication(t)
	putJSONTestObject(backend, "tenant/counts.json", `{"items":[1,2,{"nested":[3,4,5]}]}`)

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/json/tree?instance=rw&key=counts.json&limit=50", nil))
	root := decodeJSONResponse[jsonTreeResponse](t, recorder)
	if !root.Node.CountKnown || root.Node.Count != 1 {
		t.Fatalf("root object count = %+v", root.Node)
	}
	if len(root.Children) != 1 || root.Children[0].Type != "array" || !root.Children[0].CountKnown || root.Children[0].Count != 3 {
		t.Fatalf("array child count = %+v", root.Children)
	}

	items := root.Children[0]
	itemsURL := fmt.Sprintf("/api/json/tree?instance=rw&key=counts.json&type=array&start=%d&limit=50", items.Start)
	recorder = httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, itemsURL, nil))
	itemsPage := decodeJSONResponse[jsonTreeResponse](t, recorder)
	if !itemsPage.Node.CountKnown || itemsPage.Node.Count != 3 {
		t.Fatalf("expanded array count = %+v", itemsPage.Node)
	}
	if len(itemsPage.Children) != 3 || itemsPage.Children[2].Type != "object" {
		t.Fatalf("unexpected array children: %+v", itemsPage.Children)
	}
	if backend.getCount != 2 {
		t.Fatalf("array count should not add a provider read: count=%d ranges=%v", backend.getCount, backend.getRanges)
	}
}
