package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testWorkbook(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
		"xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Archive" sheetId="2" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
		"xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>alpha</t></si><si><t>beta</t></si><si><t>gamma</t></si><si><t>archived</t></si>
</sst>`,
		"xl/styles.xml": `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`,
		"xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>10</v></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t></t></is></c></row>
  <row r="4"><c r="A4" t="s"><v>1</v></c><c r="B4"><v>20</v></c></row>
  <row r="5"><c r="A5" t="s"><v>2</v></c><c r="B5"><v>3</v></c><c r="D5"></c></row>
</sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="s"><v>3</v></c></row>
</sheetData></worksheet>`,
	}
	for name, contents := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestSpreadsheetPreviewFiltersAndPaginatesOnServer(t *testing.T) {
	app, _, backend := testApplication(t)
	workbook := testWorkbook(t)
	backend.mu.Lock()
	backend.objects["tenant/book.xlsx"] = memoryObject{
		data:        workbook,
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		modified:    time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC),
	}
	backend.mu.Unlock()

	filters := url.QueryEscape(`{"A":"=beta"}`)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/spreadsheet?instance=rw&key=book.xlsx&sheet=0&page=0&pageSize=50&filters="+filters, nil)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response spreadsheetResponseJSON
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Sheets) != 2 || response.Sheets[1].Hidden != "hidden" {
		t.Fatalf("sheets = %+v", response.Sheets)
	}
	if len(response.Headers) != 2 || response.Headers[0] != "A" || response.Headers[1] != "B" {
		t.Fatalf("headers = %#v", response.Headers)
	}
	if response.SourceRows != 3 || response.TotalRows != 1 {
		t.Fatalf("row counts = source %d, filtered %d", response.SourceRows, response.TotalRows)
	}
	if len(response.Rows) != 1 || response.Rows[0].Number != 4 {
		t.Fatalf("rows = %+v", response.Rows)
	}
	if got := response.Rows[0].Cells; len(got) != 2 || got[0] != "beta" || got[1] != "20" {
		t.Fatalf("cells = %#v", got)
	}
}

func TestSpreadsheetPreviewMarksXLSMMacrosIgnored(t *testing.T) {
	app, _, backend := testApplication(t)
	workbook := testWorkbook(t)
	backend.mu.Lock()
	backend.objects["tenant/book.xlsm"] = memoryObject{
		data:        workbook,
		contentType: "application/vnd.ms-excel.sheet.macroEnabled.12",
		modified:    time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC),
	}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/spreadsheet?instance=rw&key=book.xlsm", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response spreadsheetResponseJSON
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.MacrosIgnored {
		t.Fatal("MacrosIgnored is false")
	}
}

func TestSpreadsheetPreviewHasNoCrossRequestOrPersistentCache(t *testing.T) {
	app, _, backend := testApplication(t)
	workbook := testWorkbook(t)
	backend.mu.Lock()
	backend.objects["tenant/book.xlsx"] = memoryObject{
		data:        workbook,
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		modified:    time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC),
	}
	backend.mu.Unlock()

	path := "/api/spreadsheet?instance=rw&key=book.xlsx&size=" + strconv.Itoa(len(workbook))
	request := func() {
		recorder := httptest.NewRecorder()
		app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
	}

	request()
	firstGets, firstHeads, _ := backendReadCounts(backend)
	request()
	secondGets, secondHeads, _ := backendReadCounts(backend)
	if firstGets == 0 || secondGets <= firstGets || firstHeads != 0 || secondHeads != 0 {
		t.Fatalf("first GET/HEAD = %d/%d, second = %d/%d", firstGets, firstHeads, secondGets, secondHeads)
	}
	if _, err := os.Stat(filepath.Join(app.config.DataDir, "spreadsheets")); !os.IsNotExist(err) {
		t.Fatalf("spreadsheet cache directory exists or cannot be checked: %v", err)
	}
}

func spreadsheetPreviewErrorCode(t *testing.T, app *application, path string) (int, string, string) {
	t.Helper()
	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error response: %v; body = %s", err, recorder.Body.String())
	}
	return recorder.Code, payload.Error.Code, payload.Error.Message
}

func TestSpreadsheetPreviewExplainsMismatchedExtension(t *testing.T) {
	app, _, backend := testApplication(t)
	contents := []byte("this object is plain text, not an Office package")
	backend.mu.Lock()
	backend.objects["tenant/not-really.xlsx"] = memoryObject{data: contents, contentType: "text/plain"}
	backend.mu.Unlock()

	status, code, message := spreadsheetPreviewErrorCode(t, app, "/api/spreadsheet?instance=rw&key=not-really.xlsx&size="+strconv.Itoa(len(contents)))
	if status != http.StatusUnprocessableEntity || code != "invalid_workbook_container" {
		t.Fatalf("status/code = %d/%q, message = %q", status, code, message)
	}
	if !strings.Contains(message, "extension says XLSX/XLSM") {
		t.Fatalf("message = %q", message)
	}
}

func TestSpreadsheetPreviewExplainsBinaryXLSRenamedAsXLSX(t *testing.T) {
	app, _, backend := testApplication(t)
	contents := append([]byte(nil), binaryExcelCompoundSignature...)
	contents = append(contents, make([]byte, 64)...)
	backend.mu.Lock()
	backend.objects["tenant/binary-xls.xlsx"] = memoryObject{data: contents, contentType: "application/vnd.ms-excel"}
	backend.mu.Unlock()

	status, code, message := spreadsheetPreviewErrorCode(t, app, "/api/spreadsheet?instance=rw&key=binary-xls.xlsx&size="+strconv.Itoa(len(contents)))
	if status != http.StatusUnprocessableEntity || code != "unsupported_xls_container" {
		t.Fatalf("status/code = %d/%q, message = %q", status, code, message)
	}
	if !strings.Contains(message, "binary XLS format") {
		t.Fatalf("message = %q", message)
	}
}

func TestSpreadsheetPreviewExplainsCorruptOfficeZIP(t *testing.T) {
	app, _, backend := testApplication(t)
	contents := []byte{'P', 'K', 3, 4, 0, 0, 0, 0, 1, 2, 3, 4}
	backend.mu.Lock()
	backend.objects["tenant/corrupt.xlsx"] = memoryObject{data: contents, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
	backend.mu.Unlock()

	status, code, message := spreadsheetPreviewErrorCode(t, app, "/api/spreadsheet?instance=rw&key=corrupt.xlsx&size="+strconv.Itoa(len(contents)))
	if status != http.StatusUnprocessableEntity || code != "invalid_workbook_package" {
		t.Fatalf("status/code = %d/%q, message = %q", status, code, message)
	}
	if !strings.Contains(message, "central directory") {
		t.Fatalf("message = %q", message)
	}
}
