package main

import (
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestOpenOriginalUsesRealFilenameAndConservativeInlineDisposition(t *testing.T) {
	t.Parallel()
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/media/board review.mp4"] = memoryObject{data: []byte("video"), contentType: "application/octet-stream"}
	backend.objects["tenant/media/archive.mkv"] = memoryObject{data: []byte("mkv"), contentType: "video/x-matroska"}
	backend.mu.Unlock()

	tests := []struct {
		key         string
		pathName    string
		disposition string
		contentType string
	}{
		{key: "media/board review.mp4", pathName: "board review.mp4", disposition: "inline", contentType: "video/mp4"},
		{key: "media/archive.mkv", pathName: "archive.mkv", disposition: "attachment", contentType: "video/x-matroska"},
	}
	for _, tc := range tests {
		t.Run(tc.pathName, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			requestURL := "/open/" + url.PathEscape(tc.pathName) + "?instance=rw&key=" + url.QueryEscape(tc.key)
			app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, requestURL, nil))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Content-Type"); got != tc.contentType {
				t.Fatalf("Content-Type = %q, want %q", got, tc.contentType)
			}
			mediaType, params, err := mime.ParseMediaType(recorder.Header().Get("Content-Disposition"))
			if err != nil {
				t.Fatalf("parse Content-Disposition: %v", err)
			}
			if mediaType != tc.disposition {
				t.Fatalf("disposition = %q, want %q", mediaType, tc.disposition)
			}
			if params["filename"] != tc.pathName {
				t.Fatalf("filename = %q, want %q", params["filename"], tc.pathName)
			}
			if !strings.Contains(requestURL, "/open/"+url.PathEscape(tc.pathName)) {
				t.Fatalf("open URL does not carry the filename: %s", requestURL)
			}
		})
	}
}

func TestArchiveDownloadUsesRequestedFolderFilename(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/archive?instance=rw&prefix=folder%2F&name=folder.zip", nil)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	mediaType, params, err := mime.ParseMediaType(recorder.Header().Get("Content-Disposition"))
	if err != nil {
		t.Fatal(err)
	}
	if mediaType != "attachment" || params["filename"] != "folder.zip" {
		t.Fatalf("Content-Disposition = %q, filename = %q", mediaType, params["filename"])
	}
}
