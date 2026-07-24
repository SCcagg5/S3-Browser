package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	delimitedDefaultPageSize = 100
	delimitedMaxPageSize     = 1000
	delimitedMaxColumns      = 200
	delimitedMaxCellBytes    = 64 * 1024
	delimitedPeekBytes       = 128 * 1024
)

type delimitedCursor struct {
	Offset  int64 `json:"o"`
	Records int64 `json:"r"`
	Columns int   `json:"c"`
	Comma   rune  `json:"d"`
}

type delimitedPageResponse struct {
	Headers          []string   `json:"headers,omitempty"`
	Rows             [][]string `json:"rows"`
	RowNumbers       []int64    `json:"rowNumbers"`
	NextCursor       string     `json:"nextCursor,omitempty"`
	Done             bool       `json:"done"`
	PageSize         int        `json:"pageSize"`
	StartRow         int64      `json:"startRow"`
	EndRow           int64      `json:"endRow"`
	Delimiter        string     `json:"delimiter"`
	TruncatedColumns bool       `json:"truncatedColumns,omitempty"`
	TruncatedCells   bool       `json:"truncatedCells,omitempty"`
}

type documentCountResponse struct {
	Kind    string `json:"kind"`
	Lines   int64  `json:"lines,omitempty"`
	Rows    int64  `json:"rows,omitempty"`
	Columns int64  `json:"columns,omitempty"`
}

func encodeDelimitedCursor(cursor delimitedCursor) string {
	payload, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeDelimitedCursor(raw string) (delimitedCursor, bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return delimitedCursor{}, false, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return delimitedCursor{}, false, apiError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "invalid delimited continuation cursor"}
	}
	var cursor delimitedCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.Offset < 0 || cursor.Records < 0 || cursor.Columns < 1 || cursor.Columns > delimitedMaxColumns || !validDelimitedComma(cursor.Comma) {
		return delimitedCursor{}, false, apiError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "invalid delimited continuation cursor"}
	}
	return cursor, true, nil
}

func validDelimitedComma(value rune) bool {
	return value == ',' || value == ';' || value == '\t' || value == '|'
}

func delimiterForObject(key string, sample []byte) rune {
	extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(key), "."))
	switch extension {
	case "tsv", "tab":
		return '\t'
	case "psv":
		return '|'
	default:
		return rune(detectDelimitedSeparator(sample))
	}
}

func openObjectStreamAt(ctx context.Context, instance *storageInstance, key string, offset int64, etag string) (io.ReadCloser, http.Header, error) {
	requestHeaders := make(http.Header)
	if offset > 0 {
		requestHeaders.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	if strings.TrimSpace(etag) != "" {
		value := strings.TrimSpace(etag)
		if !strings.HasPrefix(value, `"`) && !strings.HasPrefix(value, `W/"`) {
			value = `"` + strings.Trim(value, `"`) + `"`
		}
		requestHeaders.Set("If-Match", value)
	}
	response, err := instance.backend.Get(ctx, instance.fullKey(key), requestHeaders)
	if err != nil {
		return nil, nil, err
	}
	if response.Body == nil {
		return nil, nil, apiError{Status: http.StatusBadGateway, Code: "empty_object_response", Message: "the storage provider returned an empty object response"}
	}
	if !isSuccessfulObjectReadStatus(response.StatusCode) {
		response.Body.Close()
		return nil, nil, &upstreamError{StatusCode: response.StatusCode, Code: "ObjectRangeReadFailed"}
	}
	if offset > 0 {
		contentRange := strings.TrimSpace(response.Header.Get("Content-Range"))
		if response.StatusCode != http.StatusPartialContent || contentRange == "" {
			response.Body.Close()
			return nil, nil, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider ignored the byte-range request"}
		}
	}
	return response.Body, response.Header.Clone(), nil
}

func configuredCSVReader(reader io.Reader, comma rune) *csv.Reader {
	parser := csv.NewReader(reader)
	parser.Comma = comma
	parser.FieldsPerRecord = -1
	parser.ReuseRecord = false
	return parser
}

func recordVisible(record []string) bool {
	for _, value := range record {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

func truncateDelimitedCell(value string) (string, bool) {
	if len(value) <= delimitedMaxCellBytes {
		return value, false
	}
	end := delimitedMaxCellBytes
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + "…", true
}

func normalizeDelimitedHeader(header []string, columns int) []string {
	out := make([]string, columns)
	seen := make(map[string]int, columns)
	for index := 0; index < columns; index++ {
		base := ""
		if index < len(header) {
			base = strings.TrimSpace(strings.TrimPrefix(header[index], "\ufeff"))
		}
		if base == "" {
			base = fmt.Sprintf("column_%d", index+1)
		}
		seen[base]++
		if seen[base] > 1 {
			out[index] = fmt.Sprintf("%s_%d", base, seen[base])
		} else {
			out[index] = base
		}
	}
	return out
}

func normalizeDelimitedRecord(record []string, columns int) ([]string, bool, bool) {
	out := make([]string, columns)
	truncatedColumns := len(record) > columns
	truncatedCells := false
	for index := 0; index < columns && index < len(record); index++ {
		out[index], truncatedCells = func(previous bool) (string, bool) {
			value, truncated := truncateDelimitedCell(record[index])
			return value, previous || truncated
		}(truncatedCells)
	}
	return out, truncatedColumns, truncatedCells
}

func (a *application) delimitedObjectFromRequest(r *http.Request) (*storageInstance, string, string, error) {
	instance, err := a.instanceFromRequest(r, "")
	if err != nil {
		return nil, "", "", err
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		return nil, "", "", err
	}
	key := cleanRelativeKey(r.URL.Query().Get("key"))
	if key == "" {
		return nil, "", "", apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "delimited object key cannot be empty"}
	}
	return instance, key, strings.TrimSpace(r.URL.Query().Get("etag")), nil
}

func (a *application) handleDelimitedPage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, key, etag, err := a.delimitedObjectFromRequest(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	pageSize := parseBoundedInt(r.URL.Query().Get("pageSize"), delimitedDefaultPageSize, 1, delimitedMaxPageSize)
	cursor, continuing, err := decodeDelimitedCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeAPIError(w, err)
		return
	}

	body, _, err := openObjectStreamAt(r.Context(), instance, key, cursor.Offset, etag)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	defer body.Close()

	buffered := bufio.NewReaderSize(body, delimitedPeekBytes)
	comma := cursor.Comma
	if !continuing {
		sample, peekErr := buffered.Peek(delimitedPeekBytes)
		if peekErr != nil && !errors.Is(peekErr, io.EOF) && !errors.Is(peekErr, bufio.ErrBufferFull) {
			writeAPIError(w, peekErr)
			return
		}
		comma = delimiterForObject(key, sample)
	}
	parser := configuredCSVReader(buffered, comma)

	var header []string
	committedOffset := cursor.Offset
	committedRecords := cursor.Records
	columns := cursor.Columns
	if !continuing {
		header, err = parser.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				writeJSON(w, http.StatusOK, delimitedPageResponse{Rows: [][]string{}, RowNumbers: []int64{}, Done: true, PageSize: pageSize, Delimiter: string(comma)})
				return
			}
			writeAPIError(w, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_delimited_file", Message: err.Error()})
			return
		}
		committedOffset = int64(parser.InputOffset())
		committedRecords = 1
		columns = len(header)
	}

	type recordEntry struct {
		values []string
		number int64
	}
	entries := make([]recordEntry, 0, pageSize)
	truncatedColumns := false
	truncatedCells := false
	done := false

	for len(entries) < pageSize {
		record, readErr := parser.Read()
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				done = true
				break
			}
			writeAPIError(w, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_delimited_file", Message: readErr.Error()})
			return
		}
		recordNumber := committedRecords + 1
		committedOffset = cursor.Offset + int64(parser.InputOffset())
		committedRecords = recordNumber
		if !recordVisible(record) {
			continue
		}
		if !continuing && len(record) > columns {
			columns = len(record)
		}
		entries = append(entries, recordEntry{values: append([]string(nil), record...), number: recordNumber})
	}

	if columns < 1 {
		columns = 1
	}
	if columns > delimitedMaxColumns {
		columns = delimitedMaxColumns
		truncatedColumns = true
	}
	if !continuing {
		header = normalizeDelimitedHeader(header, columns)
	}

	rows := make([][]string, 0, len(entries))
	rowNumbers := make([]int64, 0, len(entries))
	for _, entry := range entries {
		row, extraColumns, extraCells := normalizeDelimitedRecord(entry.values, columns)
		truncatedColumns = truncatedColumns || extraColumns
		truncatedCells = truncatedCells || extraCells
		rows = append(rows, row)
		rowNumbers = append(rowNumbers, entry.number)
	}

	if !done && len(entries) == pageSize {
		// Probe until the next visible record or EOF. Empty records are committed so
		// the following page does not pay to read them again. The visible lookahead
		// record is intentionally not committed and will be returned on the next page.
		for {
			beforeOffset := cursor.Offset + int64(parser.InputOffset())
			beforeRecords := committedRecords
			record, readErr := parser.Read()
			if readErr != nil {
				if errors.Is(readErr, io.EOF) {
					done = true
					break
				}
				writeAPIError(w, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_delimited_file", Message: readErr.Error()})
				return
			}
			if recordVisible(record) {
				committedOffset = beforeOffset
				committedRecords = beforeRecords
				break
			}
			committedOffset = cursor.Offset + int64(parser.InputOffset())
			committedRecords++
		}
	}

	response := delimitedPageResponse{
		Headers:          header,
		Rows:             rows,
		RowNumbers:       rowNumbers,
		Done:             done,
		PageSize:         pageSize,
		Delimiter:        string(comma),
		TruncatedColumns: truncatedColumns,
		TruncatedCells:   truncatedCells,
	}
	if len(rowNumbers) > 0 {
		response.StartRow = rowNumbers[0]
		response.EndRow = rowNumbers[len(rowNumbers)-1]
	}
	if !done {
		response.NextCursor = encodeDelimitedCursor(delimitedCursor{
			Offset:  committedOffset,
			Records: committedRecords,
			Columns: columns,
			Comma:   comma,
		})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, response)
}

func (a *application) handleDocumentCount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, err := a.instanceFromRequest(r, "")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeAPIError(w, err)
		return
	}
	key := cleanRelativeKey(r.URL.Query().Get("key"))
	if key == "" {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "object key cannot be empty"})
		return
	}
	extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(key), "."))
	switch extension {
	case "csv", "tsv", "tab", "psv":
		summary, _, _, countErr := inspectDelimitedSummary(r.Context(), instance, key, extension)
		if countErr != nil {
			writeAPIError(w, countErr)
			return
		}
		writeJSON(w, http.StatusOK, documentCountResponse{Kind: "delimited", Rows: summary.Rows, Columns: summary.Columns})
	case "json", "geojson":
		lines, _, _, countErr := countObjectLines(r.Context(), instance, key)
		if countErr != nil {
			writeAPIError(w, countErr)
			return
		}
		writeJSON(w, http.StatusOK, documentCountResponse{Kind: "lines", Lines: lines})
	default:
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "unsupported_count", Message: "this document type does not expose an explicit count operation"})
	}
}
