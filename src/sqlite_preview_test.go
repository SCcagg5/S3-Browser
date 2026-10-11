package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestEmbeddedSQLiteReaderPaginatesWithoutForcingExactTotals(t *testing.T) {
	path := writeSQLitePreviewFixture(t)
	_, definitions, err := inspectSQLiteTables(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	database, err := openSQLiteDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.close()
	items := definitions["items"]

	first, err := querySQLiteTableDatabase(context.Background(), database, items, 0, 2, "", nil, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Rows) != 2 || !first.HasMore || first.TotalKnown || first.TotalRows != -1 {
		t.Fatalf("first page = %+v", first)
	}

	second, err := querySQLiteTableDatabase(context.Background(), database, items, 1, 2, "", nil, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Rows) != 1 || second.HasMore || !second.TotalKnown || second.TotalRows != 3 {
		t.Fatalf("second page = %+v", second)
	}
}

func TestEmbeddedSQLiteReaderUsesSharedColumnFiltersAndSorting(t *testing.T) {
	path := writeSQLitePreviewFixture(t)
	_, definitions, err := inspectSQLiteTables(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	database, err := openSQLiteDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.close()
	items := definitions["items"]

	filtered, err := querySQLiteTableDatabase(context.Background(), database, items, 0, 100, "", map[string]string{"name": "beta"}, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Rows) != 1 || filtered.Rows[0]["name"] != "beta" {
		t.Fatalf("filtered page = %+v", filtered)
	}

	sorted, err := querySQLiteTableDatabase(context.Background(), database, items, 0, 2, "", nil, "name", "desc", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(sorted.Rows) != 2 || sorted.Rows[0]["name"] != "gamma" || sorted.Rows[1]["name"] != "beta" {
		t.Fatalf("sorted page = %+v", sorted)
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

func TestSQLiteSessionManagerEvictsLeastRecentlyUsedWhenFull(t *testing.T) {
	t.Parallel()
	manager := &sqliteSessionManager{sessions: make(map[string]*sqliteSession)}
	base := time.Now().UTC()
	for index := 0; index < maxInMemorySQLiteSessions; index++ {
		session := &sqliteSession{ID: fmt.Sprintf("session-%d", index), LastAccess: base.Add(time.Duration(index) * time.Second)}
		if err := manager.register(session); err != nil {
			t.Fatalf("register session %d: %v", index, err)
		}
	}
	if err := manager.register(&sqliteSession{ID: "newcomer", LastAccess: base.Add(time.Minute)}); err != nil {
		t.Fatalf("register newcomer: %v", err)
	}
	if len(manager.sessions) != maxInMemorySQLiteSessions {
		t.Fatalf("sessions = %d", len(manager.sessions))
	}
	if _, ok := manager.sessions["session-0"]; ok {
		t.Fatal("least recently used session was not evicted")
	}
	if _, ok := manager.sessions["newcomer"]; !ok {
		t.Fatal("newcomer was not registered")
	}
}

func TestSQLiteSessionKeepaliveCannotExceedMaximumAge(t *testing.T) {
	t.Parallel()
	manager := &sqliteSessionManager{app: &application{}, sessions: make(map[string]*sqliteSession)}
	ttl := manager.sessionTTL()
	now := time.Now().UTC()

	// Recently touched, but older than the absolute limit.
	manager.sessions["old"] = &sqliteSession{ID: "old", CreatedAt: now.Add(-ttl * sqliteSessionMaxAgeTTLs).Add(-time.Second), LastAccess: now}
	if _, ok := manager.get("old"); ok {
		t.Fatal("session past its maximum age was served")
	}
	if _, ok := manager.sessions["old"]; ok {
		t.Fatal("session past its maximum age was kept")
	}

	// Idle past the TTL but not yet swept.
	manager.sessions["idle"] = &sqliteSession{ID: "idle", CreatedAt: now.Add(-ttl - time.Minute), LastAccess: now.Add(-ttl - time.Second)}
	if _, ok := manager.get("idle"); ok {
		t.Fatal("idle session was revived by get")
	}

	// The periodic sweep applies the same absolute limit.
	manager.sessions["swept"] = &sqliteSession{ID: "swept", CreatedAt: now.Add(-ttl * sqliteSessionMaxAgeTTLs), LastAccess: now}
	manager.sessions["fresh"] = &sqliteSession{ID: "fresh", CreatedAt: now, LastAccess: now}
	manager.cleanupExpired(now)
	if _, ok := manager.sessions["swept"]; ok {
		t.Fatal("cleanupExpired kept a session past its maximum age")
	}
	if _, ok := manager.get("fresh"); !ok {
		t.Fatal("fresh session was evicted")
	}
}

// testSQLiteVarint encodes values below 2^21 in SQLite's big-endian varint form.
func testSQLiteVarint(value int) []byte {
	switch {
	case value < 1<<7:
		return []byte{byte(value)}
	case value < 1<<14:
		return []byte{byte(value>>7) | 0x80, byte(value & 0x7f)}
	default:
		return []byte{byte(value>>14) | 0x80, byte(value>>7&0x7f) | 0x80, byte(value & 0x7f)}
	}
}

func testSQLiteTableLeafPage(pageSize int, cells [][]byte, pointers []int) []byte {
	page := make([]byte, pageSize)
	end := pageSize
	offsets := make([]int, len(cells))
	for index, cell := range cells {
		end -= len(cell)
		copy(page[end:], cell)
		offsets[index] = end
	}
	page[0] = 0x0d
	binary.BigEndian.PutUint16(page[3:], uint16(len(pointers)))
	binary.BigEndian.PutUint16(page[5:], uint16(end))
	for index, cell := range pointers {
		binary.BigEndian.PutUint16(page[8+index*2:], uint16(offsets[cell]))
	}
	return page
}

func testSQLiteInteriorPage(pageSize int, children []uint32) []byte {
	page := make([]byte, pageSize)
	end := pageSize
	page[0] = 0x05
	last := len(children) - 1
	for index, child := range children[:last] {
		cell := append(binary.BigEndian.AppendUint32(nil, child), testSQLiteVarint(index+1)...)
		end -= len(cell)
		copy(page[end:], cell)
		binary.BigEndian.PutUint16(page[12+index*2:], uint16(end))
	}
	binary.BigEndian.PutUint16(page[3:], uint16(last))
	binary.BigEndian.PutUint16(page[5:], uint16(end))
	binary.BigEndian.PutUint32(page[8:], children[last])
	return page
}

// testSQLiteImage joins pages into a database image; pages[0] is page 2, since
// page 1 only needs the file header for these tests.
func testSQLiteImage(pageSize int, pages [][]byte) []byte {
	image := make([]byte, pageSize, pageSize*(len(pages)+1))
	copy(image, "SQLite format 3\x00")
	binary.BigEndian.PutUint16(image[16:], uint16(pageSize))
	for _, page := range pages {
		image = append(image, page...)
	}
	return image
}

func testSQLiteSingleColumnTable(root uint32) sqliteTableDefinition {
	return sqliteTableDefinition{
		Info:         sqliteTableInfo{Name: "t", Columns: []sqliteColumnInfo{{Name: "v"}}},
		RootPage:     root,
		Columns:      []sqliteColumnDefinition{{Name: "v"}},
		StorageOrder: []int{0},
	}
}

func testSQLiteDatabase(t *testing.T, image []byte) *sqliteDatabase {
	t.Helper()
	database, err := openSQLiteDatabaseReader(bytes.NewReader(image), int64(len(image)))
	if err != nil {
		t.Fatal(err)
	}
	return database
}

func TestSQLiteReaderRejectsDuplicateCellPointers(t *testing.T) {
	// A record holding a single integer 0: header size 2, serial type 8.
	cell := append(append(testSQLiteVarint(2), testSQLiteVarint(1)...), 0x02, 0x08)
	leaf := testSQLiteTableLeafPage(4096, [][]byte{cell}, []int{0, 0, 0})
	database := testSQLiteDatabase(t, testSQLiteImage(4096, [][]byte{leaf}))
	visited := 0
	err := database.walkTableBTree(context.Background(), 2, func(int64, []any) error {
		visited++
		return nil
	})
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Code != "invalid_sqlite_cell" || visited != 0 {
		t.Fatalf("err = %#v, visited = %d", err, visited)
	}
}

func TestSQLiteReaderRejectsOverflowChainSharedBetweenCells(t *testing.T) {
	// Two distinct cells declare a 5000 byte blob record whose 908 byte local
	// part is followed by a pointer to the same one-page overflow chain.
	const payloadSize = 5000
	cell := func(rowID int) []byte {
		out := append(testSQLiteVarint(payloadSize), testSQLiteVarint(rowID)...)
		local := make([]byte, 908)
		copy(local, append([]byte{3}, testSQLiteVarint(2*(payloadSize-3)+12)...))
		out = append(out, local...)
		return binary.BigEndian.AppendUint32(out, 3)
	}
	leaf := testSQLiteTableLeafPage(4096, [][]byte{cell(1), cell(2)}, []int{0, 1})
	overflow := make([]byte, 4096)
	database := testSQLiteDatabase(t, testSQLiteImage(4096, [][]byte{leaf, overflow}))
	visited := 0
	err := database.walkTableBTree(context.Background(), 2, func(int64, []any) error {
		visited++
		return nil
	})
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Code != "sqlite_overflow_cycle" || visited != 1 {
		t.Fatalf("err = %#v, visited = %d", err, visited)
	}
}

func TestSQLiteSortBuffersAreBoundedInBytes(t *testing.T) {
	const (
		pageSize  = 4096
		rowCount  = 17000
		fanout    = 300
		textBytes = 4000
	)
	// One 4000 byte text row per leaf page keeps every row below the row cap
	// while the buffered rows add up to more than maxSQLiteSortBytes.
	record := append([]byte{3}, testSQLiteVarint(13+2*textBytes)...)
	record = append(record, bytes.Repeat([]byte("a"), textBytes)...)
	pages := make([][]byte, 0, rowCount+rowCount/fanout+2)
	var leaves []uint32
	for row := 1; row <= rowCount; row++ {
		cell := append(append(testSQLiteVarint(len(record)), testSQLiteVarint(row)...), record...)
		pages = append(pages, testSQLiteTableLeafPage(pageSize, [][]byte{cell}, []int{0}))
		leaves = append(leaves, uint32(len(pages)+1))
	}
	var interiors []uint32
	for start := 0; start < len(leaves); start += fanout {
		pages = append(pages, testSQLiteInteriorPage(pageSize, leaves[start:minInt(start+fanout, len(leaves))]))
		interiors = append(interiors, uint32(len(pages)+1))
	}
	pages = append(pages, testSQLiteInteriorPage(pageSize, interiors))
	database := testSQLiteDatabase(t, testSQLiteImage(pageSize, pages))
	definition := testSQLiteSingleColumnTable(uint32(len(pages) + 1))

	_, err := querySQLiteTableDatabase(context.Background(), database, definition, 0, 10, "", nil, "v", "asc", true)
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Code != "sort_result_too_large" {
		t.Fatalf("sorted query error = %#v", err)
	}
	unsorted, err := querySQLiteTableDatabase(context.Background(), database, definition, 0, 10, "", nil, "", "", true)
	if err != nil || unsorted.TotalRows != rowCount {
		t.Fatalf("unsorted query = %+v, %v", unsorted, err)
	}
}

func TestSQLiteSortKeepsDisplayValuesForCompactedRows(t *testing.T) {
	path := writeSQLitePreviewFixture(t)
	_, definitions, err := inspectSQLiteTables(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	database, err := openSQLiteDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.close()
	sorted, err := querySQLiteTableDatabase(context.Background(), database, definitions["items"], 0, 3, "", nil, "name", "asc", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(sorted.Rows) != 3 || sorted.Rows[0]["name"] != "alpha" || sorted.Rows[0]["payload"] != "[BLOB 4 bytes]" {
		t.Fatalf("sorted rows = %+v", sorted.Rows)
	}
	long := strings.Repeat("é", maxSQLiteDisplayRunes+10)
	if got := sqliteTruncateText(long); got != strings.Repeat("é", maxSQLiteDisplayRunes)+"…" {
		t.Fatalf("truncated text has %d bytes", len(got))
	}
}
