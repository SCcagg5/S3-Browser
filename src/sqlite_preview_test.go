package main

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

const sqlitePreviewFixtureBase64 = "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"

func writeSQLitePreviewFixture(t *testing.T) string {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(sqlitePreviewFixtureBase64)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fixture.sqlite")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEmbeddedSQLiteReaderInspectsAndPagesTables(t *testing.T) {
	path := writeSQLitePreviewFixture(t)
	infos, definitions, err := inspectSQLiteTables(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 2 {
		t.Fatalf("tables = %+v", infos)
	}
	items, ok := definitions["items"]
	if !ok {
		t.Fatalf("items definition missing: %+v", definitions)
	}
	if len(items.Info.Columns) != 5 || !items.Info.Columns[0].PrimaryKey || items.Info.Columns[0].Name != "id" {
		t.Fatalf("items columns = %+v", items.Info.Columns)
	}
	page, err := querySQLiteTable(context.Background(), path, items, 0, 2, "a")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 2 || !page.HasMore || page.PageSize != 2 || page.Query != "a" {
		t.Fatalf("page = %+v", page)
	}
	if page.TotalRows != 3 || page.SourceTotalRows != 3 {
		t.Fatalf("row totals = filtered %d source %d", page.TotalRows, page.SourceTotalRows)
	}
	if got := page.Rows[0]["id"]; got != int64(1) {
		t.Fatalf("rowid alias = %#v", got)
	}
	if got := page.Rows[0]["payload"]; got != "[BLOB 4 bytes]" {
		t.Fatalf("blob value = %#v", got)
	}
	empty, err := querySQLiteTable(context.Background(), path, items, 0, 100, "nohit")
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.Rows) != 0 || empty.TotalRows != 0 || empty.SourceTotalRows != 3 {
		t.Fatalf("empty filtered page = %+v", empty)
	}
}

func TestEmbeddedSQLiteReaderSupportsWithoutRowIDTables(t *testing.T) {
	path := writeSQLitePreviewFixture(t)
	_, definitions, err := inspectSQLiteTables(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	definition, ok := definitions["composite"]
	if !ok || !definition.WithoutRowID {
		t.Fatalf("composite definition = %+v", definition)
	}
	page, err := querySQLiteTable(context.Background(), path, definition, 0, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	if page.TotalRows != 3 || len(page.Rows) != 3 {
		t.Fatalf("page = %+v", page)
	}
	if page.Rows[0]["a"] != "x" || page.Rows[0]["b"] != int64(1) || page.Rows[0]["value"] != "one" {
		t.Fatalf("first WITHOUT ROWID row = %+v", page.Rows[0])
	}
}

func TestSQLiteVarintAndRecordSafety(t *testing.T) {
	if value, width, ok := readSQLiteVarint([]byte{0x81, 0x00}, 0); !ok || value != 128 || width != 2 {
		t.Fatalf("varint = %d width=%d ok=%v", value, width, ok)
	}
	if _, err := sqliteLocalPayloadSize(maxSQLiteRecordPayload+1, 4096, true); err == nil {
		t.Fatal("expected oversized record error")
	}
}
