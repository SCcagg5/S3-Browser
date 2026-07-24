package main

import (
	"context"
	"encoding/xml"
	"strings"
	"testing"
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
	cfg := storageConfig{ID: "csv", Name: "csv", Provider: "s3", Bucket: "csv", PermissionsDefined: true, Permissions: []string{permissionRead}}
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
	cfg := storageConfig{ID: "tsv", Name: "tsv", Provider: "s3", Bucket: "tsv", PermissionsDefined: true, Permissions: []string{permissionRead}}
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
