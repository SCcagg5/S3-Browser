package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func TestParseParquetFileMetadataSummary(t *testing.T) {
	// FileMetaData.schema contains one root SchemaElement with three children;
	// FileMetaData.num_rows is 123. The bytes use Thrift compact protocol.
	metadata := []byte{0x29, 0x1c, 0x55, 0x06, 0x00, 0x16, 0xf6, 0x01, 0x00}
	summary, err := parseParquetFileMetadata(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Rows != 123 || summary.Columns != 3 {
		t.Fatalf("summary = %+v", summary)
	}
}

func TestCountDelimitedDimensionsHandlesQuotedNewlinesAndEmptyColumns(t *testing.T) {
	input := "name,,description,\nalpha,,\"line one\nline two\",\n,,,\nbeta,,\"a \"\"quoted\"\" value\",\n"
	summary, total, err := countDelimitedDimensions(strings.NewReader(input), ',')
	if err != nil {
		t.Fatal(err)
	}
	if total != int64(len(input)) {
		t.Fatalf("total = %d, want %d", total, len(input))
	}
	if summary.Rows != 2 || summary.Columns != 2 {
		t.Fatalf("summary = %+v, want 2 data rows and 2 non-empty columns", summary)
	}
}

func TestWorksheetRowSummaryIgnoresEmptyStyledCells(t *testing.T) {
	visible, columns := worksheetRowSummaryForTest(t, `<row r="1"><c r="A1" s="2"></c><c r="C1"><v>value</v></c></row>`)
	if !visible || columns != 3 {
		t.Fatalf("visible=%v columns=%d, want true and 3", visible, columns)
	}
	visible, columns = worksheetRowSummaryForTest(t, `<row r="2"><c r="D2" s="4"></c></row>`)
	if visible || columns != 0 {
		t.Fatalf("visible=%v columns=%d, want false and 0", visible, columns)
	}
	visible, columns = worksheetRowSummaryForTest(t, `<row r="3"><c r="B3"><f>SUM(A1:A2)</f></c></row>`)
	if !visible || columns != 2 {
		t.Fatalf("formula row visible=%v columns=%d, want true and 2", visible, columns)
	}
}

func worksheetRowSummaryForTest(t *testing.T, source string) (bool, int64) {
	t.Helper()
	decoder := xml.NewDecoder(strings.NewReader(source))
	token, err := decoder.Token()
	if err != nil {
		t.Fatal(err)
	}
	start, ok := token.(xml.StartElement)
	if !ok || start.Name.Local != "row" {
		t.Fatalf("first token = %#v", token)
	}
	visible, columns, err := countWorksheetRow(decoder, start)
	if err != nil {
		t.Fatal(err)
	}
	return visible, columns
}

func TestLargestStatsEntriesRemainBoundedAndSortedWhenCloned(t *testing.T) {
	entries := make([]statsEntry, 0)
	for index := 0; index < maxStatsLargestEntries+25; index++ {
		addLargestStatsEntry(&entries, statsEntry{Path: string(rune('a' + index%26)), Bytes: int64(index), Type: "other"})
	}
	if len(entries) != maxStatsLargestEntries {
		t.Fatalf("len(entries) = %d", len(entries))
	}
	job := persistentJob{Stats: &statsResponse{Largest: entries}}.public()
	if job.Stats == nil || len(job.Stats.Largest) != maxStatsLargestEntries {
		t.Fatalf("public stats = %+v", job.Stats)
	}
	for index := 1; index < len(job.Stats.Largest); index++ {
		if job.Stats.Largest[index-1].Bytes < job.Stats.Largest[index].Bytes {
			t.Fatalf("largest entries are not sorted descending at %d", index)
		}
	}
}

func TestRecentStatsEntriesRemainBoundedAndSortedWhenCloned(t *testing.T) {
	entries := make([]statsEntry, 0)
	base := time.Date(2026, 7, 25, 8, 0, 0, 0, time.UTC)
	for index := 0; index < maxStatsRecentEntries+25; index++ {
		addRecentStatsEntry(&entries, statsEntry{
			Path:         fmt.Sprintf("file-%03d.bin", index),
			Bytes:        int64(index),
			Type:         "other",
			LastModified: base.Add(time.Duration(index) * time.Minute).Format(time.RFC3339Nano),
		})
	}
	if len(entries) != maxStatsRecentEntries {
		t.Fatalf("len(entries) = %d", len(entries))
	}
	job := persistentJob{Stats: &statsResponse{Recent: entries}}.public()
	if job.Stats == nil || len(job.Stats.Recent) != maxStatsRecentEntries {
		t.Fatalf("public stats = %+v", job.Stats)
	}
	for index := 1; index < len(job.Stats.Recent); index++ {
		if job.Stats.Recent[index-1].LastModified < job.Stats.Recent[index].LastModified {
			t.Fatalf("recent entries are not sorted descending at %d", index)
		}
	}
	wantNewest := base.Add(time.Duration(maxStatsRecentEntries+24) * time.Minute).Format(time.RFC3339Nano)
	if job.Stats.Recent[0].LastModified != wantNewest {
		t.Fatalf("newest = %q, want %q", job.Stats.Recent[0].LastModified, wantNewest)
	}
}

func TestStatsFolderAggregatesKeepFiveExactLevels(t *testing.T) {
	stats := newStatsResponse("instance", "root/")
	addStatsFolderAggregates(stats, "root/", "root/a/b/c/d/e/f/file.bin", 42)
	want := []string{"a/", "a/b/", "a/b/c/", "a/b/c/d/", "a/b/c/d/e/"}
	for _, key := range want {
		value, ok := stats.ByFolder[key]
		if !ok || value.Count != 1 || value.Bytes != 42 {
			t.Fatalf("folder aggregate %q = %+v, present=%v", key, value, ok)
		}
	}
	if _, ok := stats.ByFolder["a/b/c/d/e/f/"]; ok {
		t.Fatal("folder aggregates must remain bounded to five levels")
	}
	if stats.LayoutVersion != statsLayoutVersion {
		t.Fatalf("layout version = %d", stats.LayoutVersion)
	}
}

func TestInspectDelimitedDetailsDefersExpensiveCounts(t *testing.T) {
	backend := newMemoryBackend(nil)
	content := "first;second;empty\n1;2;\n3;4;\n"
	backend.objects["table.csv"] = memoryObject{data: []byte(content), contentType: "text/csv"}
	cfg := bucketConfig{ID: "csv", Name: "csv", Provider: "s3", Bucket: "csv", PermissionsDefined: true, Permissions: []string{permissionRead}}
	instance := &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}
	response, handled, err := inspectDocumentDetails(context.Background(), instance, "table.csv", "csv", "text/csv", mediaSourceMetadata{Size: int64(len(content))})
	if err != nil {
		t.Fatal(err)
	}
	if !handled || response.Container != "CSV" || len(response.Properties) != 0 {
		t.Fatalf("response = %+v", response)
	}
	if backend.getCount != 0 || backend.headCount != 1 {
		t.Fatalf("storage reads: get=%d head=%d", backend.getCount, backend.headCount)
	}
}

func TestInspectTSVDetailsSupportsTabExtensionAndMIME(t *testing.T) {
	backend := newMemoryBackend(nil)
	content := "first\tsecond\n1\t2\n3\t4\n"
	backend.objects["table.tab"] = memoryObject{data: []byte(content), contentType: "text/tab-separated-values"}
	cfg := bucketConfig{ID: "tsv", Name: "tsv", Provider: "s3", Bucket: "tsv", PermissionsDefined: true, Permissions: []string{permissionRead}}
	instance := &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}
	response, handled, err := inspectDocumentDetails(context.Background(), instance, "table.tab", "tab", "text/tab-separated-values", mediaSourceMetadata{Size: int64(len(content))})
	if err != nil {
		t.Fatal(err)
	}
	if !handled || response.Container != "TSV" || len(response.Properties) != 0 {
		t.Fatalf("response = %+v", response)
	}
	if backend.getCount != 0 || backend.headCount != 1 {
		t.Fatalf("storage reads: get=%d head=%d", backend.getCount, backend.headCount)
	}
}

func TestSpreadsheetDetailsDescribeActiveWorksheetOnly(t *testing.T) {
	backend := newMemoryBackend(nil)
	workbook := testWorkbook(t)
	backend.objects["book.xlsx"] = memoryObject{
		data:        workbook,
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	}
	cfg := bucketConfig{ID: "xlsx", Name: "xlsx", Provider: "s3", Bucket: "xlsx", PermissionsDefined: true, Permissions: []string{permissionRead}}
	instance := &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}

	summary, _, _, err := inspectSpreadsheetSummary(context.Background(), instance, "book.xlsx", int64(len(workbook)))
	if err != nil {
		t.Fatal(err)
	}
	if summary.Sheets != 2 || summary.ActiveSheet != "Data" || summary.Rows != 0 || summary.Columns != 0 {
		t.Fatalf("summary = %+v, want only deterministic workbook metadata", summary)
	}
	dimensions, err := inspectSpreadsheetDimensions(context.Background(), instance, "book.xlsx", int64(len(workbook)))
	if err != nil {
		t.Fatal(err)
	}
	if dimensions.ActiveSheet != "Data" || dimensions.Rows != 5 || dimensions.Columns != 2 {
		t.Fatalf("dimensions = %+v, want active Data bounds 5x2", dimensions)
	}
}

func TestTextContainerLabelsUseFullLanguageNames(t *testing.T) {
	tests := map[string]string{
		"js": "JavaScript", "mjs": "JavaScript module", "cjs": "CommonJS JavaScript",
		"jsx": "JavaScript XML", "ts": "TypeScript", "tsx": "TypeScript XML",
		"py": "Python", "rs": "Rust", "cpp": "C++", "cs": "C#", "fs": "F#",
		"hbs": "Handlebars", "vue": "Vue single-file component", "svg": "SVG",
	}
	for extension, want := range tests {
		if got := textContainerLabel("example."+extension, extension, "text/plain"); got != want {
			t.Fatalf("textContainerLabel(%q) = %q, want %q", extension, got, want)
		}
	}
}

func TestTextContainerLabelsExtensionlessCodeFiles(t *testing.T) {
	for name, want := range map[string]string{"Dockerfile": "Dockerfile", "Makefile": "Makefile", "Jenkinsfile": "Jenkins pipeline"} {
		if got := textContainerLabel(name, "", "text/plain"); got != want {
			t.Fatalf("textContainerLabel(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestWordDetailsReadOnlyPropertyParts(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	write := func(name, content string, method uint16) {
		t.Helper()
		header := &zip.FileHeader{Name: name, Method: method}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(part, content); err != nil {
			t.Fatal(err)
		}
	}
	write("docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Quarterly plan</dc:title><dc:creator>Ada Lovelace</dc:creator><cp:lastModifiedBy>Grace Hopper</cp:lastModifiedBy><cp:revision>7</cp:revision><dcterms:created>2026-07-25T08:00:00Z</dcterms:created></cp:coreProperties>`, zip.Deflate)
	write("docProps/app.xml", `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion><Company>Example</Company><Pages>12</Pages><Words>3456</Words><Lines>210</Lines><TotalTime>42</TotalTime></Properties>`, zip.Deflate)
	// Store a large body without compression. Details must not open or parse it.
	write("word/document.xml", strings.Repeat("x", 3<<20), zip.Store)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	backend := newMemoryBackend(nil)
	backend.objects["report.docx"] = memoryObject{
		data:        archive.Bytes(),
		contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	}
	cfg := bucketConfig{ID: "docx", Name: "docx", Provider: "s3", Bucket: "docx", PermissionsDefined: true, Permissions: []string{permissionRead}}
	instance := &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}
	response, handled, err := inspectDocumentDetails(context.Background(), instance, "report.docx", "docx", backend.objects["report.docx"].contentType, mediaSourceMetadata{Size: int64(archive.Len())})
	if err != nil {
		t.Fatal(err)
	}
	if !handled || response.Container != "Microsoft Word Open XML" {
		t.Fatalf("response = %+v", response)
	}
	for label, want := range map[string]string{
		"Title": "Quarterly plan", "Author": "Ada Lovelace", "Last modified by": "Grace Hopper",
		"Revision": "7", "Application": "Microsoft Office Word", "Pages": "12",
		"Words": "3456", "Lines": "210", "Editing time (minutes)": "42",
	} {
		if got := response.Properties[label]; got != want {
			t.Fatalf("property %q = %q, want %q", label, got, want)
		}
	}
	backend.mu.Lock()
	bytesRead, ranges := backend.getBytesRead, append([]string(nil), backend.getRanges...)
	backend.mu.Unlock()
	if bytesRead >= int64(archive.Len()) {
		t.Fatalf("details read the complete DOCX: %d of %d bytes", bytesRead, archive.Len())
	}
	requireExactByteRanges(t, ranges)
}

func TestPowerPointDetailsUseOnlyPackageMetadataAndCentralDirectory(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	write := func(name, content string, method uint16) {
		t.Helper()
		header := &zip.FileHeader{Name: name, Method: method}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(part, content); err != nil {
			t.Fatal(err)
		}
	}
	write("docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Board review</dc:title><dc:creator>Ada Lovelace</dc:creator><cp:lastModifiedBy>Grace Hopper</cp:lastModifiedBy></cp:coreProperties>`, zip.Deflate)
	write("docProps/app.xml", `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft PowerPoint</Application><AppVersion>16.0000</AppVersion><Slides>2</Slides><HiddenSlides>1</HiddenSlides><Notes>1</Notes><PresentationFormat>Widescreen</PresentationFormat></Properties>`, zip.Deflate)
	write("docProps/custom.xml", `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property name="Department"><vt:lpwstr>Research</vt:lpwstr></property></Properties>`, zip.Deflate)
	write("ppt/slides/slide1.xml", strings.Repeat("x", 2<<20), zip.Store)
	write("ppt/slides/slide2.xml", `<p:sld/>`, zip.Deflate)
	write("ppt/notesSlides/notesSlide1.xml", `<p:notes/>`, zip.Deflate)
	write("ppt/media/image1.png", "png", zip.Store)
	write("ppt/vbaProject.bin", "macro", zip.Store)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	backend := newMemoryBackend(nil)
	backend.objects["deck.pptm"] = memoryObject{data: archive.Bytes(), contentType: "application/vnd.ms-powerpoint.presentation.macroEnabled.12"}
	cfg := bucketConfig{ID: "ppt", Name: "ppt", Provider: "s3", Bucket: "ppt", PermissionsDefined: true, Permissions: []string{permissionRead}}
	instance := &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}
	response, handled, err := inspectDocumentDetails(context.Background(), instance, "deck.pptm", "pptm", backend.objects["deck.pptm"].contentType, mediaSourceMetadata{Size: int64(archive.Len())})
	if err != nil {
		t.Fatal(err)
	}
	if !handled || response.Container != "Microsoft PowerPoint macro-enabled presentation" {
		t.Fatalf("response = %+v", response)
	}
	for label, want := range map[string]string{
		"Title": "Board review", "Author": "Ada Lovelace", "Last modified by": "Grace Hopper",
		"Application": "Microsoft PowerPoint", "Slides": "2", "Hidden slides": "1",
		"Notes slides": "1", "Presentation format": "Widescreen", "Media files": "1",
		"Macros": "Yes", "Custom - Department": "Research",
	} {
		if got := response.Properties[label]; got != want {
			t.Fatalf("property %q = %q, want %q", label, got, want)
		}
	}
	backend.mu.Lock()
	bytesRead, ranges := backend.getBytesRead, append([]string(nil), backend.getRanges...)
	backend.mu.Unlock()
	if bytesRead >= int64(archive.Len()) {
		t.Fatalf("details read the complete PPTM: %d of %d bytes", bytesRead, archive.Len())
	}
	requireExactByteRanges(t, ranges)
}

func TestPDFMetadataUsesBoundedPageTreeCounts(t *testing.T) {
	prefix := []byte("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n")
	suffix := []byte("2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 6 >> endobj\n4 0 obj << /Type /Pages /Count 1229 >> endobj\ntrailer << /Root 1 0 R >>")
	props := parsePDFMetadata(prefix, suffix, int64(len(prefix)+len(suffix)))
	if got := props["Pages"]; got != "1235" {
		t.Fatalf("Pages = %q, want 1235", got)
	}
	if got := props["PDF version"]; got != "1.7" {
		t.Fatalf("PDF version = %q, want 1.7", got)
	}
}

func TestStructuredMetadataSmallTextFormats(t *testing.T) {
	backend := newMemoryBackend(nil)
	backend.objects["person.vcf"] = memoryObject{data: []byte("BEGIN:VCARD\nVERSION:4.0\nFN:Ada Lovelace\nORG:Analytical Engines\nEMAIL:ada@example.test\nTEL:+33123456789\nEND:VCARD\n"), contentType: "text/vcard"}
	backend.objects["event.ics"] = memoryObject{data: []byte("BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example//EN\nBEGIN:VEVENT\nSUMMARY:Review\nDTSTART:20260725T080000Z\nDTEND:20260725T090000Z\nEND:VEVENT\nEND:VCALENDAR\n"), contentType: "text/calendar"}
	backend.objects["message.eml"] = memoryObject{data: []byte("From: Ada <ada@example.test>\r\nTo: Grace <grace@example.test>\r\nSubject: Metadata\r\nDate: Sat, 25 Jul 2026 08:00:00 +0000\r\nMessage-ID: <one@example.test>\r\n\r\nBody not inspected by metadata."), contentType: "message/rfc822"}
	backend.objects["cert.pem"] = memoryObject{data: []byte("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"), contentType: "application/x-pem-file"}
	cfg := bucketConfig{ID: "meta", Name: "meta", Provider: "s3", Bucket: "meta", PermissionsDefined: true, Permissions: []string{permissionRead}}
	instance := &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}

	tests := []struct{ key, ext, ctype, container, prop, want string }{
		{"person.vcf", "vcf", "text/vcard", "vCard contact", "Name", "Ada Lovelace"},
		{"event.ics", "ics", "text/calendar", "iCalendar", "Events", "1"},
		{"message.eml", "eml", "message/rfc822", "Email message", "Subject", "Metadata"},
		{"cert.pem", "pem", "application/x-pem-file", "PEM certificate", "PEM blocks", "1"},
	}
	for _, tc := range tests {
		t.Run(tc.key, func(t *testing.T) {
			obj := backend.objects[tc.key]
			response, handled, err := inspectDocumentDetails(context.Background(), instance, tc.key, tc.ext, tc.ctype, mediaSourceMetadata{Size: int64(len(obj.data))})
			if err != nil {
				t.Fatal(err)
			}
			if !handled || response.Container != tc.container {
				t.Fatalf("response = %+v", response)
			}
			if got := response.Properties[tc.prop]; got != tc.want {
				t.Fatalf("property %q = %q, want %q", tc.prop, got, tc.want)
			}
		})
	}
}
