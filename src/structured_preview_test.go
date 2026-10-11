package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestStructuredPreviewContactCalendarEmailAndPrivateKeyRaw(t *testing.T) {
	t.Parallel()
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/person.vcf"] = memoryObject{data: []byte("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ada Lovelace\r\nORG:Analytical Engines\r\nEMAIL:ada@example.test\r\nTEL:+33123456789\r\nEND:VCARD\r\n"), contentType: "text/vcard"}
	backend.objects["tenant/event.ics"] = memoryObject{data: []byte("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Reviews\r\nBEGIN:VEVENT\r\nUID:review@example.test\r\nSUMMARY:Architecture review\r\nDTSTART:20260725T080000Z\r\nDTEND:20260725T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"), contentType: "text/calendar"}
	backend.objects["tenant/message.eml"] = memoryObject{data: []byte("From: Ada <ada@example.test>\r\nTo: Grace <grace@example.test>\r\nSubject: Review\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <img src=\"https://external.invalid/pixel.png\"></p>"), contentType: "message/rfc822"}
	privateKey := "-----BEGIN PRIVATE KEY-----\nAQIDBA==\n-----END PRIVATE KEY-----\n"
	backend.objects["tenant/secret.key"] = memoryObject{data: []byte(privateKey), contentType: "application/x-pem-file"}
	backend.mu.Unlock()

	tests := []struct {
		key   string
		kind  string
		check func(t *testing.T, payload structuredPreviewResponse)
	}{
		{key: "person.vcf", kind: "contact", check: func(t *testing.T, payload structuredPreviewResponse) {
			if len(payload.Contacts) != 1 || payload.Contacts[0].Name != "Ada Lovelace" {
				t.Fatalf("contacts = %+v", payload.Contacts)
			}
		}},
		{key: "event.ics", kind: "calendar", check: func(t *testing.T, payload structuredPreviewResponse) {
			if payload.Calendar == nil || len(payload.Calendar.Events) != 1 || payload.Calendar.Events[0].Summary != "Architecture review" {
				t.Fatalf("calendar = %+v", payload.Calendar)
			}
		}},
		{key: "message.eml", kind: "email", check: func(t *testing.T, payload structuredPreviewResponse) {
			if payload.Email == nil || payload.Email.Headers["Subject"] != "Review" {
				t.Fatalf("email = %+v", payload.Email)
			}
			if payload.Email.BodyText == "" {
				t.Fatal("email text preview is empty")
			}
		}},
		{key: "secret.key", kind: "certificate", check: func(t *testing.T, payload structuredPreviewResponse) {
			if payload.Raw != privateKey || payload.RawEncoding != "text" {
				t.Fatalf("raw private key preview was not preserved exactly: encoding=%q raw=%q", payload.RawEncoding, payload.Raw)
			}
		}},
	}

	for _, tc := range tests {
		t.Run(tc.key, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/structured-preview?instance=rw&key="+url.QueryEscape(tc.key), nil)
			app.routes().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			var payload structuredPreviewResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Kind != tc.kind {
				t.Fatalf("kind = %q, want %q", payload.Kind, tc.kind)
			}
			tc.check(t, payload)
		})
	}
}

func TestArchivePreviewReturnsCompleteCentralDirectoryForEasyFormats(t *testing.T) {
	t.Parallel()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	files := map[string]string{
		"META-INF/MANIFEST.MF": "Manifest-Version: 1.0\nMain-Class: example.Main\n",
		"example/Main.class":   "bytecode",
		"assets/icon.png":      "png",
	}
	for name, body := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	directoryHeader := &zip.FileHeader{Name: "empty/", Method: zip.Store}
	directoryHeader.SetMode(fs.ModeDir | 0o755)
	if _, err := writer.CreateHeader(directoryHeader); err != nil {
		t.Fatal(err)
	}
	symlinkHeader := &zip.FileHeader{Name: "main-link", Method: zip.Store}
	symlinkHeader.SetMode(fs.ModeSymlink | 0o777)
	symlink, err := writer.CreateHeader(symlinkHeader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := symlink.Write([]byte("example/Main.class")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/app.jar"] = memoryObject{data: buffer.Bytes(), contentType: "application/java-archive"}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/archive-preview?instance=rw&key=app.jar&size="+url.QueryEscape(stringInt64(int64(buffer.Len()))), nil)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload archivePreviewResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Container != "Java archive" || len(payload.Entries) != len(files) {
		t.Fatalf("archive response = %+v", payload)
	}
	for _, entry := range payload.Entries {
		if entry.Name == "empty/" || entry.Name == "main-link" {
			t.Fatalf("directory or symbolic link leaked into file-only inventory: %+v", payload.Entries)
		}
	}
	if payload.Package["Main class"] != "example.Main" {
		t.Fatalf("package metadata = %+v", payload.Package)
	}
	backend.mu.Lock()
	ranges := append([]string(nil), backend.getRanges...)
	backend.mu.Unlock()
	requireExactByteRanges(t, ranges)
}

func TestArchivePreviewUsesConfiguredEntryLimit(t *testing.T) {
	t.Parallel()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, name := range []string{"one.txt", "two.txt"} {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	app, _, backend := testApplication(t)
	app.config.Runtime.MaxArchiveEntries = 1
	backend.mu.Lock()
	backend.objects["tenant/two.zip"] = memoryObject{data: buffer.Bytes(), contentType: "application/zip"}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/archive-preview?instance=rw&key=two.zip&size="+url.QueryEscape(stringInt64(int64(buffer.Len()))), nil)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "configured complete preview limit is 1") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestHardArchiveFormatsDoNotUseAutomaticArchivePreview(t *testing.T) {
	for _, extension := range []string{"tar", "rar", "7z", "gz", "xz", "zst"} {
		if isZipArchiveExtension(extension) {
			t.Fatalf(".%s must remain outside the deterministic central-directory preview", extension)
		}
	}
}

func stringInt64(value int64) string { return strconv.FormatInt(value, 10) }

func TestUnfoldStructuredLinesIsLinearAndCapped(t *testing.T) {
	if got := unfoldStructuredLines("A:1\r\n 2\r\n\t3\r\n\r\nB:x\r\n"); len(got) != 2 || got[0] != "A:123" || got[1] != "B:x" {
		t.Fatalf("unfolded = %q", got)
	}
	// 50k one-byte continuations: re-copying the accumulated line per row would
	// allocate over 1 GiB.
	input := "A:" + strings.Repeat("\n x", 50000)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	lines := unfoldStructuredLines(input)
	runtime.ReadMemStats(&after)
	if len(lines) != 1 || len(lines[0]) != 50002 {
		t.Fatalf("lines = %d, first length = %d", len(lines), len(lines[0]))
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 64<<20 {
		t.Fatalf("unfold allocated %d bytes", allocated)
	}
	huge := unfoldStructuredLines("A:" + strings.Repeat("\n "+strings.Repeat("x", 1<<20), 5))
	if len(huge) != 1 || len(huge[0]) > maxUnfoldedLineBytes {
		t.Fatalf("unfolded line length = %d, want <= %d", len(huge[0]), maxUnfoldedLineBytes)
	}
}

func TestParseVCardPreviewCapsAndDedupesValues(t *testing.T) {
	var builder strings.Builder
	builder.WriteString("BEGIN:VCARD\nFN:Ada\nEMAIL:dup@example.test\nEMAIL:dup@example.test\n")
	for index := 0; index < 20000; index++ {
		builder.WriteString("EMAIL:user" + strconv.Itoa(index) + "@example.test\n")
	}
	builder.WriteString("TEL:+1\nEND:VCARD\n")
	contacts := parseVCardPreview([]byte(builder.String()))
	if len(contacts) != 1 || len(contacts[0].Emails) != maxContactValuesPerField || contacts[0].Emails[0] != "dup@example.test" || contacts[0].Emails[1] != "user0@example.test" {
		t.Fatalf("contacts = %+v", contacts)
	}
	if len(contacts[0].Phones) != 1 {
		t.Fatalf("phones = %v", contacts[0].Phones)
	}
}

func nestedMultipartMessage(depth int, leaf string) []byte {
	var builder strings.Builder
	builder.WriteString("From: a@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n")
	for level := 0; level < depth; level++ {
		builder.WriteString("--b" + strconv.Itoa(level) + "\r\nContent-Type: multipart/mixed; boundary=b" + strconv.Itoa(level+1) + "\r\n\r\n")
	}
	builder.WriteString("--b" + strconv.Itoa(depth) + "\r\nContent-Type: text/plain\r\n\r\n" + leaf + "\r\n--b" + strconv.Itoa(depth) + "--\r\n")
	for level := depth - 1; level >= 0; level-- {
		builder.WriteString("--b" + strconv.Itoa(level) + "--\r\n")
	}
	return []byte(builder.String())
}

func TestParseEmailPreviewBoundsMultipartDepthAndParts(t *testing.T) {
	if preview := parseEmailPreview(nestedMultipartMessage(3, "shallow")); preview.BodyText != "shallow" {
		t.Fatalf("body = %q", preview.BodyText)
	}
	if preview := parseEmailPreview(nestedMultipartMessage(maxMIMEPreviewDepth+12, "too deep")); preview.BodyText != "" {
		t.Fatalf("deeply nested body = %q, want it skipped", preview.BodyText)
	}
	var builder strings.Builder
	builder.WriteString("From: a@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n")
	for index := 0; index < maxMIMEPreviewParts+500; index++ {
		builder.WriteString("--b\r\nContent-Type: text/plain; name=f.txt\r\n\r\nx\r\n")
	}
	builder.WriteString("--b--\r\n")
	if preview := parseEmailPreview([]byte(builder.String())); len(preview.Attachments) != maxMIMEPreviewParts {
		t.Fatalf("attachments = %d, want %d", len(preview.Attachments), maxMIMEPreviewParts)
	}
}
