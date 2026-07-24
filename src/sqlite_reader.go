package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	maxSQLiteBTreeDepth    = 128
	maxSQLiteRecordPayload = int64(64 << 20)
)

type sqliteDatabase struct {
	file       *os.File
	size       int64
	pageSize   int
	usableSize int
	pageCount  uint32
	encoding   uint32
}

type sqliteSchemaEntry struct {
	Type     string
	Name     string
	Table    string
	RootPage uint32
	SQL      string
}

type sqliteColumnDefinition struct {
	Name             string
	DeclaredType     string
	PrimaryKey       bool
	RowIDAlias       bool
	VirtualGenerated bool
}

type sqliteTableDefinition struct {
	Info         sqliteTableInfo
	RootPage     uint32
	WithoutRowID bool
	Columns      []sqliteColumnDefinition
	StorageOrder []int
}

type sqliteBlob []byte

func openSQLiteDatabase(path string) (*sqliteDatabase, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	cleanup := func(openErr error) (*sqliteDatabase, error) {
		_ = file.Close()
		return nil, openErr
	}
	info, err := file.Stat()
	if err != nil {
		return cleanup(err)
	}
	if info.Size() < 100 {
		return cleanup(apiError{Status: 422, Code: "invalid_sqlite", Message: "the object is too small to be a SQLite 3 database"})
	}
	header := make([]byte, 100)
	if _, err := io.ReadFull(io.NewSectionReader(file, 0, int64(len(header))), header); err != nil {
		return cleanup(err)
	}
	if string(header[:16]) != "SQLite format 3\x00" {
		return cleanup(apiError{Status: 422, Code: "invalid_sqlite", Message: "the object is not a SQLite 3 database"})
	}
	pageSize := int(binary.BigEndian.Uint16(header[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}
	if pageSize < 512 || pageSize > 65536 || pageSize&(pageSize-1) != 0 {
		return cleanup(apiError{Status: 422, Code: "invalid_sqlite_page_size", Message: "the SQLite database declares an invalid page size"})
	}
	reserved := int(header[20])
	if reserved < 0 || reserved >= pageSize-32 {
		return cleanup(apiError{Status: 422, Code: "invalid_sqlite_reserved_space", Message: "the SQLite database declares invalid reserved page space"})
	}
	pageCount := uint32((info.Size() + int64(pageSize) - 1) / int64(pageSize))
	if declared := binary.BigEndian.Uint32(header[28:32]); declared > 0 && declared < pageCount {
		// A database may have trailing bytes, but pages beyond the declared count
		// are not part of the logical database and must not be followed.
		pageCount = declared
	}
	encoding := binary.BigEndian.Uint32(header[56:60])
	if encoding == 0 {
		encoding = 1
	}
	if encoding < 1 || encoding > 3 {
		return cleanup(apiError{Status: 422, Code: "unsupported_sqlite_encoding", Message: "the SQLite database uses an unsupported text encoding"})
	}
	return &sqliteDatabase{
		file:       file,
		size:       info.Size(),
		pageSize:   pageSize,
		usableSize: pageSize - reserved,
		pageCount:  pageCount,
		encoding:   encoding,
	}, nil
}

func (db *sqliteDatabase) close() error {
	if db == nil || db.file == nil {
		return nil
	}
	return db.file.Close()
}

func (db *sqliteDatabase) readPage(pageNumber uint32) ([]byte, error) {
	if db == nil || db.file == nil || pageNumber == 0 || pageNumber > db.pageCount {
		return nil, apiError{Status: 422, Code: "invalid_sqlite_page", Message: "the SQLite database references a page outside the file"}
	}
	offset := int64(pageNumber-1) * int64(db.pageSize)
	if offset < 0 || offset >= db.size {
		return nil, apiError{Status: 422, Code: "invalid_sqlite_page", Message: "the SQLite database references a page outside the file"}
	}
	page := make([]byte, db.pageSize)
	read, err := db.file.ReadAt(page, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if read < db.pageSize {
		return nil, apiError{Status: 422, Code: "truncated_sqlite_page", Message: "the SQLite database ends in the middle of a page"}
	}
	return page, nil
}

func readSQLiteVarint(data []byte, offset int) (uint64, int, bool) {
	if offset < 0 || offset >= len(data) {
		return 0, 0, false
	}
	var value uint64
	for index := 0; index < 8; index++ {
		position := offset + index
		if position >= len(data) {
			return 0, 0, false
		}
		current := data[position]
		value = (value << 7) | uint64(current&0x7f)
		if current&0x80 == 0 {
			return value, index + 1, true
		}
	}
	position := offset + 8
	if position >= len(data) {
		return 0, 0, false
	}
	value = (value << 8) | uint64(data[position])
	return value, 9, true
}

func sqliteLocalPayloadSize(payloadSize int64, usableSize int, tableLeaf bool) (int, error) {
	if payloadSize < 0 || payloadSize > maxSQLiteRecordPayload {
		return 0, apiError{Status: 422, Code: "sqlite_record_too_large", Message: fmt.Sprintf("a SQLite record exceeds the %d MiB preview safety limit", maxSQLiteRecordPayload>>20)}
	}
	if payloadSize == 0 {
		return 0, nil
	}
	usable := int64(usableSize)
	if usable < 480 {
		return 0, apiError{Status: 422, Code: "invalid_sqlite_usable_page", Message: "the SQLite database has too little usable space per page"}
	}
	minimum := ((usable - 12) * 32 / 255) - 23
	maximum := ((usable - 12) * 64 / 255) - 23
	if tableLeaf {
		maximum = usable - 35
	}
	if payloadSize <= maximum {
		return int(payloadSize), nil
	}
	candidate := minimum + ((payloadSize - minimum) % (usable - 4))
	if candidate <= maximum {
		return int(candidate), nil
	}
	return int(minimum), nil
}

func (db *sqliteDatabase) readPayload(page []byte, start int, payloadSize int64, tableLeaf bool) ([]byte, error) {
	local, err := sqliteLocalPayloadSize(payloadSize, db.usableSize, tableLeaf)
	if err != nil {
		return nil, err
	}
	if start < 0 || start > db.usableSize || local < 0 || start+local > db.usableSize || start+local > len(page) {
		return nil, apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite cell points outside its page"}
	}
	payload := make([]byte, int(payloadSize))
	copied := copy(payload, page[start:start+local])
	if copied == len(payload) {
		return payload, nil
	}
	pointerOffset := start + local
	if pointerOffset+4 > db.usableSize || pointerOffset+4 > len(page) {
		return nil, apiError{Status: 422, Code: "invalid_sqlite_overflow", Message: "a SQLite overflow pointer is missing"}
	}
	nextPage := binary.BigEndian.Uint32(page[pointerOffset : pointerOffset+4])
	visited := make(map[uint32]struct{})
	for copied < len(payload) {
		if nextPage == 0 || nextPage > db.pageCount {
			return nil, apiError{Status: 422, Code: "invalid_sqlite_overflow", Message: "a SQLite record references an invalid overflow page"}
		}
		if _, exists := visited[nextPage]; exists {
			return nil, apiError{Status: 422, Code: "sqlite_overflow_cycle", Message: "a SQLite overflow chain contains a cycle"}
		}
		visited[nextPage] = struct{}{}
		overflow, err := db.readPage(nextPage)
		if err != nil {
			return nil, err
		}
		if db.usableSize < 4 {
			return nil, apiError{Status: 422, Code: "invalid_sqlite_overflow", Message: "a SQLite overflow page is too small"}
		}
		next := binary.BigEndian.Uint32(overflow[:4])
		available := db.usableSize - 4
		remaining := len(payload) - copied
		if available > remaining {
			available = remaining
		}
		copy(payload[copied:copied+available], overflow[4:4+available])
		copied += available
		nextPage = next
	}
	return payload, nil
}

func decodeSQLiteText(data []byte, encoding uint32) string {
	switch encoding {
	case 1:
		if utf8.Valid(data) {
			return string(data)
		}
		return strings.ToValidUTF8(string(data), "�")
	case 2, 3:
		if len(data)%2 != 0 {
			data = data[:len(data)-1]
		}
		units := make([]uint16, len(data)/2)
		for index := range units {
			if encoding == 2 {
				units[index] = binary.LittleEndian.Uint16(data[index*2 : index*2+2])
			} else {
				units[index] = binary.BigEndian.Uint16(data[index*2 : index*2+2])
			}
		}
		return string(utf16.Decode(units))
	default:
		return string(data)
	}
}

func sqliteSignedInteger(data []byte) int64 {
	if len(data) == 0 {
		return 0
	}
	var value uint64
	for _, current := range data {
		value = (value << 8) | uint64(current)
	}
	bits := uint(len(data) * 8)
	if bits < 64 && value&(uint64(1)<<(bits-1)) != 0 {
		value |= ^uint64(0) << bits
	}
	return int64(value)
}

func (db *sqliteDatabase) decodeRecord(payload []byte) ([]any, error) {
	headerSizeValue, consumed, ok := readSQLiteVarint(payload, 0)
	if !ok || headerSizeValue < uint64(consumed) || headerSizeValue > uint64(len(payload)) {
		return nil, apiError{Status: 422, Code: "invalid_sqlite_record", Message: "a SQLite record has an invalid header"}
	}
	headerSize := int(headerSizeValue)
	serials := make([]uint64, 0, 16)
	for offset := consumed; offset < headerSize; {
		serialType, width, ok := readSQLiteVarint(payload, offset)
		if !ok || width <= 0 || offset+width > headerSize {
			return nil, apiError{Status: 422, Code: "invalid_sqlite_record", Message: "a SQLite record has an invalid serial type"}
		}
		serials = append(serials, serialType)
		offset += width
	}
	values := make([]any, 0, len(serials))
	dataOffset := headerSize
	for _, serialType := range serials {
		var length int
		switch serialType {
		case 0, 8, 9:
			length = 0
		case 1:
			length = 1
		case 2:
			length = 2
		case 3:
			length = 3
		case 4:
			length = 4
		case 5:
			length = 6
		case 6, 7:
			length = 8
		case 10, 11:
			return nil, apiError{Status: 422, Code: "unsupported_sqlite_serial_type", Message: "a SQLite record uses a reserved serial type"}
		default:
			if serialType&1 == 0 {
				length = int((serialType - 12) / 2)
			} else {
				length = int((serialType - 13) / 2)
			}
		}
		if length < 0 || dataOffset < 0 || dataOffset+length > len(payload) {
			return nil, apiError{Status: 422, Code: "truncated_sqlite_record", Message: "a SQLite record payload is truncated"}
		}
		field := payload[dataOffset : dataOffset+length]
		dataOffset += length
		switch serialType {
		case 0:
			values = append(values, nil)
		case 1, 2, 3, 4, 5, 6:
			values = append(values, sqliteSignedInteger(field))
		case 7:
			values = append(values, math.Float64frombits(binary.BigEndian.Uint64(field)))
		case 8:
			values = append(values, int64(0))
		case 9:
			values = append(values, int64(1))
		default:
			if serialType&1 == 0 {
				copyValue := make([]byte, len(field))
				copy(copyValue, field)
				values = append(values, sqliteBlob(copyValue))
			} else {
				values = append(values, decodeSQLiteText(field, db.encoding))
			}
		}
	}
	return values, nil
}

func sqliteBTreeHeaderOffset(pageNumber uint32) int {
	if pageNumber == 1 {
		return 100
	}
	return 0
}

func sqliteCellPointers(page []byte, headerOffset, headerSize, count int) ([]int, error) {
	start := headerOffset + headerSize
	if count < 0 || start < 0 || start+count*2 > len(page) {
		return nil, apiError{Status: 422, Code: "invalid_sqlite_btree", Message: "a SQLite B-tree page has an invalid cell pointer array"}
	}
	pointers := make([]int, count)
	for index := 0; index < count; index++ {
		pointer := int(binary.BigEndian.Uint16(page[start+index*2 : start+index*2+2]))
		if pointer <= 0 || pointer >= len(page) {
			return nil, apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite cell pointer points outside its page"}
		}
		pointers[index] = pointer
	}
	return pointers, nil
}

type sqliteRecordVisitor func(rowID int64, values []any) error

func (db *sqliteDatabase) walkTableBTree(ctx context.Context, rootPage uint32, visitor sqliteRecordVisitor) error {
	visited := make(map[uint32]struct{})
	var walk func(uint32, int) error
	walk = func(pageNumber uint32, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > maxSQLiteBTreeDepth {
			return apiError{Status: 422, Code: "sqlite_btree_too_deep", Message: "the SQLite B-tree exceeds the preview depth limit"}
		}
		if _, exists := visited[pageNumber]; exists {
			return apiError{Status: 422, Code: "sqlite_btree_cycle", Message: "the SQLite B-tree contains a cycle"}
		}
		visited[pageNumber] = struct{}{}
		page, err := db.readPage(pageNumber)
		if err != nil {
			return err
		}
		headerOffset := sqliteBTreeHeaderOffset(pageNumber)
		if headerOffset+8 > len(page) {
			return apiError{Status: 422, Code: "invalid_sqlite_btree", Message: "a SQLite B-tree page is truncated"}
		}
		pageType := page[headerOffset]
		cellCount := int(binary.BigEndian.Uint16(page[headerOffset+3 : headerOffset+5]))
		switch pageType {
		case 0x05: // Interior table B-tree page.
			if headerOffset+12 > len(page) {
				return apiError{Status: 422, Code: "invalid_sqlite_btree", Message: "a SQLite interior table page is truncated"}
			}
			pointers, err := sqliteCellPointers(page, headerOffset, 12, cellCount)
			if err != nil {
				return err
			}
			for _, pointer := range pointers {
				if pointer+4 > len(page) {
					return apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite interior cell is truncated"}
				}
				child := binary.BigEndian.Uint32(page[pointer : pointer+4])
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
			rightMost := binary.BigEndian.Uint32(page[headerOffset+8 : headerOffset+12])
			return walk(rightMost, depth+1)
		case 0x0d: // Leaf table B-tree page.
			pointers, err := sqliteCellPointers(page, headerOffset, 8, cellCount)
			if err != nil {
				return err
			}
			for _, pointer := range pointers {
				payloadSizeValue, payloadWidth, ok := readSQLiteVarint(page, pointer)
				if !ok {
					return apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite table cell has an invalid payload size"}
				}
				rowIDValue, rowIDWidth, ok := readSQLiteVarint(page, pointer+payloadWidth)
				if !ok {
					return apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite table cell has an invalid row identifier"}
				}
				payload, err := db.readPayload(page, pointer+payloadWidth+rowIDWidth, int64(payloadSizeValue), true)
				if err != nil {
					return err
				}
				values, err := db.decodeRecord(payload)
				if err != nil {
					return err
				}
				if err := visitor(int64(rowIDValue), values); err != nil {
					return err
				}
			}
			return nil
		default:
			return apiError{Status: 422, Code: "unsupported_sqlite_table_btree", Message: fmt.Sprintf("the SQLite table root uses unsupported B-tree page type 0x%02x", pageType)}
		}
	}
	return walk(rootPage, 0)
}

func (db *sqliteDatabase) walkIndexBTree(ctx context.Context, rootPage uint32, visitor sqliteRecordVisitor) error {
	visited := make(map[uint32]struct{})
	var walk func(uint32, int) error
	walk = func(pageNumber uint32, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > maxSQLiteBTreeDepth {
			return apiError{Status: 422, Code: "sqlite_btree_too_deep", Message: "the SQLite B-tree exceeds the preview depth limit"}
		}
		if _, exists := visited[pageNumber]; exists {
			return apiError{Status: 422, Code: "sqlite_btree_cycle", Message: "the SQLite B-tree contains a cycle"}
		}
		visited[pageNumber] = struct{}{}
		page, err := db.readPage(pageNumber)
		if err != nil {
			return err
		}
		headerOffset := sqliteBTreeHeaderOffset(pageNumber)
		if headerOffset+8 > len(page) {
			return apiError{Status: 422, Code: "invalid_sqlite_btree", Message: "a SQLite B-tree page is truncated"}
		}
		pageType := page[headerOffset]
		cellCount := int(binary.BigEndian.Uint16(page[headerOffset+3 : headerOffset+5]))
		switch pageType {
		case 0x02: // Interior index B-tree page.
			if headerOffset+12 > len(page) {
				return apiError{Status: 422, Code: "invalid_sqlite_btree", Message: "a SQLite interior index page is truncated"}
			}
			pointers, err := sqliteCellPointers(page, headerOffset, 12, cellCount)
			if err != nil {
				return err
			}
			for _, pointer := range pointers {
				if pointer+4 > len(page) {
					return apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite interior index cell is truncated"}
				}
				child := binary.BigEndian.Uint32(page[pointer : pointer+4])
				if err := walk(child, depth+1); err != nil {
					return err
				}
				payloadSizeValue, width, ok := readSQLiteVarint(page, pointer+4)
				if !ok {
					return apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite index cell has an invalid payload size"}
				}
				payload, err := db.readPayload(page, pointer+4+width, int64(payloadSizeValue), false)
				if err != nil {
					return err
				}
				values, err := db.decodeRecord(payload)
				if err != nil {
					return err
				}
				if err := visitor(0, values); err != nil {
					return err
				}
			}
			rightMost := binary.BigEndian.Uint32(page[headerOffset+8 : headerOffset+12])
			return walk(rightMost, depth+1)
		case 0x0a: // Leaf index B-tree page.
			pointers, err := sqliteCellPointers(page, headerOffset, 8, cellCount)
			if err != nil {
				return err
			}
			for _, pointer := range pointers {
				payloadSizeValue, width, ok := readSQLiteVarint(page, pointer)
				if !ok {
					return apiError{Status: 422, Code: "invalid_sqlite_cell", Message: "a SQLite index cell has an invalid payload size"}
				}
				payload, err := db.readPayload(page, pointer+width, int64(payloadSizeValue), false)
				if err != nil {
					return err
				}
				values, err := db.decodeRecord(payload)
				if err != nil {
					return err
				}
				if err := visitor(0, values); err != nil {
					return err
				}
			}
			return nil
		default:
			return apiError{Status: 422, Code: "unsupported_sqlite_index_btree", Message: fmt.Sprintf("the SQLite table root uses unsupported index B-tree page type 0x%02x", pageType)}
		}
	}
	return walk(rootPage, 0)
}

func sqliteString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	case sqliteBlob:
		return fmt.Sprintf("[BLOB %d bytes]", len(typed))
	default:
		return fmt.Sprint(value)
	}
}

func sqliteInteger(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case float64:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	default:
		return 0
	}
}

func (db *sqliteDatabase) schema(ctx context.Context) ([]sqliteSchemaEntry, error) {
	entries := make([]sqliteSchemaEntry, 0, 32)
	err := db.walkTableBTree(ctx, 1, func(_ int64, values []any) error {
		if len(values) < 5 {
			return nil
		}
		entry := sqliteSchemaEntry{
			Type:     strings.ToLower(sqliteString(values[0])),
			Name:     sqliteString(values[1]),
			Table:    sqliteString(values[2]),
			RootPage: uint32(maxInt64(0, sqliteInteger(values[3]))),
			SQL:      sqliteString(values[4]),
		}
		entries = append(entries, entry)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func splitSQLiteDefinitionList(value string) []string {
	parts := make([]string, 0, 16)
	start := 0
	depth := 0
	quote := rune(0)
	bracket := false
	escaped := false
	runes := []rune(value)
	for index, current := range runes {
		if bracket {
			if current == ']' {
				bracket = false
			}
			continue
		}
		if quote != 0 {
			if escaped {
				escaped = false
				continue
			}
			if current == quote {
				if index+1 < len(runes) && runes[index+1] == quote {
					escaped = true
					continue
				}
				quote = 0
			}
			continue
		}
		switch current {
		case '\'', '"', '`':
			quote = current
		case '[':
			bracket = true
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(string(runes[start:index])))
				start = index + 1
			}
		}
	}
	if start <= len(runes) {
		parts = append(parts, strings.TrimSpace(string(runes[start:])))
	}
	filtered := parts[:0]
	for _, part := range parts {
		if part != "" {
			filtered = append(filtered, part)
		}
	}
	return filtered
}

func parseSQLiteIdentifier(value string) (string, string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", "", false
	}
	switch trimmed[0] {
	case '"', '\'', '`':
		quote := trimmed[0]
		var builder strings.Builder
		for index := 1; index < len(trimmed); index++ {
			current := trimmed[index]
			if current == quote {
				if index+1 < len(trimmed) && trimmed[index+1] == quote {
					builder.WriteByte(quote)
					index++
					continue
				}
				return builder.String(), strings.TrimSpace(trimmed[index+1:]), true
			}
			builder.WriteByte(current)
		}
		return "", "", false
	case '[':
		if end := strings.IndexByte(trimmed[1:], ']'); end >= 0 {
			end++
			return trimmed[1:end], strings.TrimSpace(trimmed[end+1:]), true
		}
		return "", "", false
	default:
		end := 0
		for end < len(trimmed) && !strings.ContainsRune(" \t\r\n,()", rune(trimmed[end])) {
			end++
		}
		if end == 0 {
			return "", "", false
		}
		return trimmed[:end], strings.TrimSpace(trimmed[end:]), true
	}
}

func sqliteContainsKeyword(value, keyword string) bool {
	upper := strings.ToUpper(value)
	keyword = strings.ToUpper(keyword)
	for index := strings.Index(upper, keyword); index >= 0; {
		leftOK := index == 0 || !(upper[index-1] == '_' || upper[index-1] >= '0' && upper[index-1] <= '9' || upper[index-1] >= 'A' && upper[index-1] <= 'Z')
		right := index + len(keyword)
		rightOK := right >= len(upper) || !(upper[right] == '_' || upper[right] >= '0' && upper[right] <= '9' || upper[right] >= 'A' && upper[right] <= 'Z')
		if leftOK && rightOK {
			return true
		}
		next := strings.Index(upper[index+1:], keyword)
		if next < 0 {
			break
		}
		index += next + 1
	}
	return false
}

func sqliteDeclaredType(definition string) string {
	constraints := map[string]struct{}{
		"PRIMARY": {}, "NOT": {}, "UNIQUE": {}, "CHECK": {}, "DEFAULT": {},
		"COLLATE": {}, "REFERENCES": {}, "GENERATED": {}, "AS": {}, "CONSTRAINT": {},
	}
	trimmed := strings.TrimSpace(definition)
	depth := 0
	quote := byte(0)
	end := len(trimmed)
	for index := 0; index < len(trimmed); {
		current := trimmed[index]
		if quote != 0 {
			if current == quote {
				if index+1 < len(trimmed) && trimmed[index+1] == quote {
					index += 2
					continue
				}
				quote = 0
			}
			index++
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
			index++
			continue
		}
		if current == '(' {
			depth++
			index++
			continue
		}
		if current == ')' {
			if depth > 0 {
				depth--
			}
			index++
			continue
		}
		if depth == 0 && (current == ' ' || current == '\t' || current == '\r' || current == '\n') {
			wordStart := index
			for wordStart < len(trimmed) && (trimmed[wordStart] == ' ' || trimmed[wordStart] == '\t' || trimmed[wordStart] == '\r' || trimmed[wordStart] == '\n') {
				wordStart++
			}
			wordEnd := wordStart
			for wordEnd < len(trimmed) && ((trimmed[wordEnd] >= 'A' && trimmed[wordEnd] <= 'Z') || (trimmed[wordEnd] >= 'a' && trimmed[wordEnd] <= 'z') || trimmed[wordEnd] == '_') {
				wordEnd++
			}
			if wordEnd > wordStart {
				if _, stop := constraints[strings.ToUpper(trimmed[wordStart:wordEnd])]; stop {
					end = index
					break
				}
			}
		}
		index++
	}
	return strings.TrimSpace(trimmed[:end])
}

func sqliteTablePrimaryKey(segment string) []string {
	upper := strings.ToUpper(segment)
	position := strings.Index(upper, "PRIMARY KEY")
	if position < 0 {
		return nil
	}
	open := strings.Index(segment[position+len("PRIMARY KEY"):], "(")
	if open < 0 {
		return nil
	}
	open += position + len("PRIMARY KEY")
	depth := 0
	closePosition := -1
	quote := byte(0)
	for index := open; index < len(segment); index++ {
		current := segment[index]
		if quote != 0 {
			if current == quote {
				if index+1 < len(segment) && segment[index+1] == quote {
					index++
					continue
				}
				quote = 0
			}
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
			continue
		}
		if current == '(' {
			depth++
		} else if current == ')' {
			depth--
			if depth == 0 {
				closePosition = index
				break
			}
		}
	}
	if closePosition < 0 {
		return nil
	}
	parts := splitSQLiteDefinitionList(segment[open+1 : closePosition])
	columns := make([]string, 0, len(parts))
	for _, part := range parts {
		name, _, ok := parseSQLiteIdentifier(part)
		if ok {
			columns = append(columns, name)
		}
	}
	return columns
}

func parseSQLiteCreateTable(entry sqliteSchemaEntry) (sqliteTableDefinition, error) {
	sql := strings.TrimSpace(entry.SQL)
	upper := strings.ToUpper(sql)
	if strings.Contains(upper, "CREATE VIRTUAL TABLE") || entry.RootPage == 0 {
		return sqliteTableDefinition{}, apiError{Status: 422, Code: "unsupported_sqlite_virtual_table", Message: "virtual SQLite tables are not available in the embedded preview reader"}
	}
	open := strings.Index(sql, "(")
	if open < 0 {
		return sqliteTableDefinition{}, apiError{Status: 422, Code: "invalid_sqlite_schema", Message: "a SQLite table definition is missing its column list"}
	}
	depth := 0
	quote := byte(0)
	closePosition := -1
	for index := open; index < len(sql); index++ {
		current := sql[index]
		if quote != 0 {
			if current == quote {
				if index+1 < len(sql) && sql[index+1] == quote {
					index++
					continue
				}
				quote = 0
			}
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
			continue
		}
		if current == '(' {
			depth++
		} else if current == ')' {
			depth--
			if depth == 0 {
				closePosition = index
				break
			}
		}
	}
	if closePosition < 0 {
		return sqliteTableDefinition{}, apiError{Status: 422, Code: "invalid_sqlite_schema", Message: "a SQLite table definition has an unterminated column list"}
	}
	segments := splitSQLiteDefinitionList(sql[open+1 : closePosition])
	columns := make([]sqliteColumnDefinition, 0, len(segments))
	tablePrimaryKey := make([]string, 0)
	for _, segment := range segments {
		trimmed := strings.TrimSpace(segment)
		upperSegment := strings.ToUpper(trimmed)
		for strings.HasPrefix(upperSegment, "CONSTRAINT ") {
			_, remainder, ok := parseSQLiteIdentifier(strings.TrimSpace(trimmed[len("CONSTRAINT "):]))
			if !ok {
				break
			}
			trimmed = remainder
			upperSegment = strings.ToUpper(trimmed)
		}
		if strings.HasPrefix(upperSegment, "PRIMARY KEY") {
			tablePrimaryKey = sqliteTablePrimaryKey(trimmed)
			continue
		}
		if strings.HasPrefix(upperSegment, "UNIQUE") || strings.HasPrefix(upperSegment, "CHECK") || strings.HasPrefix(upperSegment, "FOREIGN KEY") {
			continue
		}
		name, remainder, ok := parseSQLiteIdentifier(trimmed)
		if !ok || name == "" {
			continue
		}
		declared := sqliteDeclaredType(remainder)
		primary := sqliteContainsKeyword(remainder, "PRIMARY KEY")
		virtualGenerated := sqliteContainsKeyword(remainder, "GENERATED") && sqliteContainsKeyword(remainder, "VIRTUAL")
		columns = append(columns, sqliteColumnDefinition{
			Name:             name,
			DeclaredType:     declared,
			PrimaryKey:       primary,
			VirtualGenerated: virtualGenerated,
		})
	}
	if len(columns) == 0 {
		return sqliteTableDefinition{}, apiError{Status: 422, Code: "invalid_sqlite_schema", Message: "the SQLite table does not expose any readable columns"}
	}
	withoutRowID := strings.Contains(strings.ToUpper(sql[closePosition+1:]), "WITHOUT ROWID")
	columnIndex := make(map[string]int, len(columns))
	for index, column := range columns {
		columnIndex[strings.ToLower(column.Name)] = index
	}
	if len(tablePrimaryKey) > 0 {
		for _, name := range tablePrimaryKey {
			if index, ok := columnIndex[strings.ToLower(name)]; ok {
				columns[index].PrimaryKey = true
			}
		}
	}
	if len(tablePrimaryKey) == 0 {
		for _, column := range columns {
			if column.PrimaryKey {
				tablePrimaryKey = append(tablePrimaryKey, column.Name)
			}
		}
	}
	rowIDAliasIndex := -1
	if !withoutRowID && len(tablePrimaryKey) == 1 {
		if index, ok := columnIndex[strings.ToLower(tablePrimaryKey[0])]; ok {
			normalizedType := strings.ToUpper(strings.TrimSpace(columns[index].DeclaredType))
			definitionUpper := strings.ToUpper(segments[minInt(index, len(segments)-1)])
			if normalizedType == "INTEGER" && !strings.Contains(definitionUpper, "PRIMARY KEY DESC") {
				rowIDAliasIndex = index
				columns[index].RowIDAlias = true
			}
		}
	}
	storageOrder := make([]int, 0, len(columns))
	seen := make(map[int]struct{})
	if withoutRowID {
		for _, name := range tablePrimaryKey {
			if index, ok := columnIndex[strings.ToLower(name)]; ok && !columns[index].VirtualGenerated {
				storageOrder = append(storageOrder, index)
				seen[index] = struct{}{}
			}
		}
	}
	for index, column := range columns {
		if column.VirtualGenerated {
			continue
		}
		if _, exists := seen[index]; exists {
			continue
		}
		storageOrder = append(storageOrder, index)
	}
	infoColumns := make([]sqliteColumnInfo, 0, len(columns))
	for _, column := range columns {
		if column.VirtualGenerated {
			continue
		}
		infoColumns = append(infoColumns, sqliteColumnInfo{Name: column.Name, DeclaredType: column.DeclaredType, PrimaryKey: column.PrimaryKey})
	}
	_ = rowIDAliasIndex
	return sqliteTableDefinition{
		Info:     sqliteTableInfo{Name: entry.Name, Type: "table", Columns: infoColumns},
		RootPage: entry.RootPage, WithoutRowID: withoutRowID, Columns: columns, StorageOrder: storageOrder,
	}, nil
}

func inspectSQLiteTables(ctx context.Context, databasePath string) ([]sqliteTableInfo, map[string]sqliteTableDefinition, error) {
	database, err := openSQLiteDatabase(databasePath)
	if err != nil {
		return nil, nil, err
	}
	defer database.close()
	entries, err := database.schema(ctx)
	if err != nil {
		return nil, nil, err
	}
	definitions := make(map[string]sqliteTableDefinition)
	infos := make([]sqliteTableInfo, 0, len(entries))
	for _, entry := range entries {
		if entry.Type != "table" || strings.HasPrefix(strings.ToLower(entry.Name), "sqlite_") || entry.RootPage == 0 {
			continue
		}
		definition, parseErr := parseSQLiteCreateTable(entry)
		if parseErr != nil {
			// Virtual and implementation-specific tables are intentionally omitted
			// instead of making an otherwise readable database unavailable.
			continue
		}
		definitions[definition.Info.Name] = definition
		infos = append(infos, definition.Info)
	}
	sort.SliceStable(infos, func(left, right int) bool {
		return strings.ToLower(infos[left].Name) < strings.ToLower(infos[right].Name)
	})
	return infos, definitions, nil
}

func (definition sqliteTableDefinition) mapRecord(rowID int64, values []any) map[string]any {
	mapped := make(map[string]any, len(definition.Info.Columns))
	for storageIndex, columnIndex := range definition.StorageOrder {
		if columnIndex < 0 || columnIndex >= len(definition.Columns) {
			continue
		}
		column := definition.Columns[columnIndex]
		var value any
		if storageIndex < len(values) {
			value = values[storageIndex]
		}
		if column.RowIDAlias && value == nil {
			value = rowID
		}
		mapped[column.Name] = value
	}
	return mapped
}

func sqliteRowMatches(row map[string]any, columns []sqliteColumnInfo, query string) bool {
	if query == "" {
		return true
	}
	needle := strings.ToLower(query)
	for _, column := range columns {
		value := row[column.Name]
		if _, blob := value.(sqliteBlob); blob {
			continue
		}
		if strings.Contains(strings.ToLower(sqliteString(value)), needle) {
			return true
		}
	}
	return false
}

func sqliteDisplayValue(value any) any {
	switch typed := value.(type) {
	case sqliteBlob:
		return fmt.Sprintf("[BLOB %d bytes]", len(typed))
	case string:
		const maximum = 4096
		if utf8.RuneCountInString(typed) <= maximum {
			return typed
		}
		runes := []rune(typed)
		return string(runes[:maximum]) + "…"
	default:
		return value
	}
}

func querySQLiteTable(ctx context.Context, databasePath string, definition sqliteTableDefinition, page, pageSize int, search string) (sqlitePageResponse, error) {
	database, err := openSQLiteDatabase(databasePath)
	if err != nil {
		return sqlitePageResponse{}, err
	}
	defer database.close()
	page = maxInt(0, page)
	pageSize = minInt(1000, maxInt(1, pageSize))
	start := int64(page) * int64(pageSize)
	end := start + int64(pageSize)
	rows := make([]map[string]any, 0, pageSize)
	var sourceTotal int64
	var filteredTotal int64
	visit := func(rowID int64, values []any) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		sourceTotal++
		mapped := definition.mapRecord(rowID, values)
		if !sqliteRowMatches(mapped, definition.Info.Columns, search) {
			return nil
		}
		if filteredTotal >= start && filteredTotal < end {
			output := make(map[string]any, len(definition.Info.Columns))
			for _, column := range definition.Info.Columns {
				output[column.Name] = sqliteDisplayValue(mapped[column.Name])
			}
			rows = append(rows, output)
		}
		filteredTotal++
		return nil
	}
	if definition.WithoutRowID {
		err = database.walkIndexBTree(ctx, definition.RootPage, visit)
	} else {
		err = database.walkTableBTree(ctx, definition.RootPage, visit)
	}
	if err != nil {
		return sqlitePageResponse{}, err
	}
	return sqlitePageResponse{
		Table:           definition.Info,
		Rows:            rows,
		Page:            page,
		PageSize:        pageSize,
		HasMore:         filteredTotal > end,
		TotalRows:       filteredTotal,
		SourceTotalRows: sourceTotal,
		Query:           search,
		Columns:         definition.Info.Columns,
	}, nil
}
