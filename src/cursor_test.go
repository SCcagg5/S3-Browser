package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func mutateCursor(value string) string {
	if value == "" {
		return "x"
	}
	last := value[len(value)-1]
	replacement := byte('A')
	if last == replacement {
		replacement = 'B'
	}
	return value[:len(value)-1] + string(replacement)
}

func TestSignedCursorRejectsTamperingAndWrongScope(t *testing.T) {
	value := jsonTextCursor{Offset: 42, Line: 7, Scope: signedCursorScope("json-raw", "alpha", "a.json")}
	encoded, err := encodeJSONCursor(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeJSONCursor(mutateCursor(encoded), jsonTextCursor{Line: 1}, value.Scope); err == nil {
		t.Fatal("a tampered cursor was accepted")
	}
	if _, err := decodeJSONCursor(encoded, jsonTextCursor{Line: 1}, signedCursorScope("json-raw", "alpha", "b.json")); err == nil {
		t.Fatal("a cursor was accepted for another object")
	}
}

func TestDelimitedEndpointRejectsReplayedCursor(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/first.csv"] = memoryObject{data: []byte("id,name\n1,one\n2,two\n"), contentType: "text/csv"}
	backend.objects["tenant/second.csv"] = memoryObject{data: []byte("id,name\n3,three\n4,four\n"), contentType: "text/csv"}
	backend.mu.Unlock()

	firstRecorder := httptest.NewRecorder()
	app.routes().ServeHTTP(firstRecorder, httptest.NewRequest(http.MethodGet, "/api/delimited?instance=rw&key=first.csv&pageSize=1", nil))
	first := decodeJSONResponse[delimitedPageResponse](t, firstRecorder)
	if first.NextCursor == "" {
		t.Fatal("first page did not return a cursor")
	}

	cases := map[string][2]string{
		"tampered": {mutateCursor(first.NextCursor), "first.csv"},
		"replayed": {first.NextCursor, "second.csv"},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			requestURL := "/api/delimited?instance=rw&key=" + testCase[1] + "&pageSize=1&cursor=" + url.QueryEscape(testCase[0])
			app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, requestURL, nil))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_cursor") {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
