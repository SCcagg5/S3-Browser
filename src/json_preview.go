package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	jsonTextPageBytes       = 256 * 1024
	jsonTextPageLines       = 2000
	jsonTreeDefaultPageSize = 50
	jsonTreeMaxPageSize     = 200
	jsonTreePreviewBytes    = 1024
	jsonTreeKeyPreviewBytes = 2048
	jsonMaxNestingDepth     = 10000
)

type jsonTextCursor struct {
	Offset    int64  `json:"o"`
	Line      int64  `json:"l"`
	Continued bool   `json:"c,omitempty"`
	Stack     string `json:"s,omitempty"`
	InString  bool   `json:"q,omitempty"`
	Escaped   bool   `json:"e,omitempty"`
	InScalar  bool   `json:"n,omitempty"`
	Pending   byte   `json:"p,omitempty"`
}

type jsonTextPageResponse struct {
	Text       string `json:"text"`
	NextCursor string `json:"nextCursor,omitempty"`
	Done       bool   `json:"done"`
	LineStart  int64  `json:"lineStart"`
	LineEnd    int64  `json:"lineEnd"`
	Continued  bool   `json:"continued,omitempty"`
}

type jsonTreeNodeJSON struct {
	Label     string `json:"label,omitempty"`
	Type      string `json:"type"`
	Preview   string `json:"preview,omitempty"`
	Container bool   `json:"container"`
	Start     int64  `json:"start"`
	End       int64  `json:"end,omitempty"`
}

type jsonTreeResponse struct {
	Node      jsonTreeNodeJSON   `json:"node"`
	Children  []jsonTreeNodeJSON `json:"children"`
	Cursor    int64              `json:"cursor,omitempty"`
	NextIndex int64              `json:"nextIndex,omitempty"`
	Done      bool               `json:"done"`
}

type jsonStreamReader struct {
	reader *bufio.Reader
	offset int64
}

func newJSONStreamReader(reader io.Reader, offset int64) *jsonStreamReader {
	return &jsonStreamReader{reader: bufio.NewReaderSize(reader, 64*1024), offset: offset}
}

func (r *jsonStreamReader) readByte() (byte, error) {
	value, err := r.reader.ReadByte()
	if err == nil {
		r.offset++
	}
	return value, err
}

func (r *jsonStreamReader) peekByte() (byte, error) {
	value, err := r.reader.Peek(1)
	if err != nil {
		return 0, err
	}
	return value[0], nil
}

func (r *jsonStreamReader) readRune() (rune, int, error) {
	value, size, err := r.reader.ReadRune()
	if err == nil {
		r.offset += int64(size)
	}
	return value, size, err
}

func (r *jsonStreamReader) skipWhitespace() error {
	for {
		value, err := r.peekByte()
		if err != nil {
			return err
		}
		switch value {
		case ' ', '\t', '\r', '\n':
			_, _ = r.readByte()
		default:
			return nil
		}
	}
}

func parseNonNegativeInt64(value string, fallback int64) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return 0, apiError{Status: http.StatusBadRequest, Code: "invalid_offset", Message: "JSON byte offsets must be non-negative integers"}
	}
	return parsed, nil
}

func parsePositiveInt(value string, fallback, maximum int) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 || parsed > maximum {
		return 0, apiError{Status: http.StatusBadRequest, Code: "invalid_limit", Message: fmt.Sprintf("limit must be between 1 and %d", maximum)}
	}
	return parsed, nil
}

func (a *application) jsonObjectFromRequest(r *http.Request) (*storageInstance, string, string, error) {
	instance, err := a.instanceFromRequest(r, "")
	if err != nil {
		return nil, "", "", err
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		return nil, "", "", err
	}
	key := cleanRelativeKey(r.URL.Query().Get("key"))
	if key == "" {
		return nil, "", "", apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "JSON object key cannot be empty"}
	}
	return instance, key, strings.TrimSpace(r.URL.Query().Get("etag")), nil
}

func openJSONObjectStream(ctx context.Context, instance *storageInstance, key string, offset int64, etag string) (io.ReadCloser, error) {
	requestHeaders := make(http.Header)
	requestHeaders.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	if etag != "" {
		if !strings.HasPrefix(etag, `"`) && !strings.HasPrefix(etag, `W/"`) {
			etag = `"` + strings.Trim(etag, `"`) + `"`
		}
		requestHeaders.Set("If-Match", etag)
	}
	response, err := instance.backend.Get(ctx, instance.fullKey(key), requestHeaders)
	if err != nil {
		return nil, err
	}
	if response.Body == nil {
		return nil, apiError{Status: http.StatusBadGateway, Code: "empty_json_response", Message: "the storage provider returned an empty JSON response"}
	}
	if !isSuccessfulObjectReadStatus(response.StatusCode) {
		response.Body.Close()
		return nil, &upstreamError{StatusCode: response.StatusCode, Code: "JSONRangeReadFailed"}
	}
	contentRange := strings.TrimSpace(response.Header.Get("Content-Range"))
	if offset > 0 && (response.StatusCode != http.StatusPartialContent || contentRange == "") {
		response.Body.Close()
		return nil, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider ignored the JSON byte-range request"}
	}
	if response.StatusCode == http.StatusPartialContent && contentRange == "" {
		response.Body.Close()
		return nil, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider omitted Content-Range for the JSON byte-range request"}
	}
	return response.Body, nil
}

func encodeJSONCursor(cursor jsonTextCursor) string {
	payload, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeJSONCursor(raw string, fallback jsonTextCursor) (jsonTextCursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return jsonTextCursor{}, apiError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "invalid JSON continuation cursor"}
	}
	var cursor jsonTextCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.Offset < 0 || cursor.Line < 1 {
		return jsonTextCursor{}, apiError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "invalid JSON continuation cursor"}
	}
	if len(cursor.Stack) > jsonMaxNestingDepth {
		return jsonTextCursor{}, apiError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "JSON continuation cursor exceeds the nesting limit"}
	}
	for index := range cursor.Stack {
		if cursor.Stack[index] != '{' && cursor.Stack[index] != '[' {
			return jsonTextCursor{}, apiError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "invalid JSON continuation cursor"}
		}
	}
	if cursor.Pending != 0 && cursor.Pending != 'o' && cursor.Pending != 'c' {
		return jsonTextCursor{}, apiError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "invalid JSON continuation cursor"}
	}
	return cursor, nil
}

func (a *application) handleJSONRaw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, key, etag, err := a.jsonObjectFromRequest(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	cursor, err := decodeJSONCursor(r.URL.Query().Get("cursor"), jsonTextCursor{Line: 1})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	body, err := openJSONObjectStream(r.Context(), instance, key, cursor.Offset, etag)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	defer body.Close()

	reader := newJSONStreamReader(body, cursor.Offset)
	var output bytes.Buffer
	output.Grow(jsonTextPageBytes)
	startLine := cursor.Line
	line := cursor.Line
	continued := cursor.Continued
	done := false
	for output.Len() < jsonTextPageBytes && line-startLine < jsonTextPageLines {
		value, size, readErr := reader.readRune()
		if readErr != nil {
			if readErr == io.EOF {
				done = true
				break
			}
			writeAPIError(w, fmt.Errorf("read JSON source: %w", readErr))
			return
		}
		if value == utf8.RuneError && size == 1 {
			output.WriteRune(utf8.RuneError)
		} else {
			output.WriteRune(value)
		}
		if value == '\n' {
			line++
		}
	}
	if output.Len() == 0 && !done {
		done = true
	}
	next := ""
	if !done {
		text := output.String()
		next = encodeJSONCursor(jsonTextCursor{
			Offset:    reader.offset,
			Line:      line,
			Continued: !strings.HasSuffix(text, "\n"),
		})
	}
	writeJSON(w, http.StatusOK, jsonTextPageResponse{
		Text:       output.String(),
		NextCursor: next,
		Done:       done,
		LineStart:  startLine,
		LineEnd:    line,
		Continued:  continued,
	})
}

func writeJSONIndent(output *bytes.Buffer, depth int) {
	if depth <= 0 {
		return
	}
	output.WriteString(strings.Repeat("  ", depth))
}

func matchingJSONClose(open byte) byte {
	if open == '{' {
		return '}'
	}
	if open == '[' {
		return ']'
	}
	return 0
}

func appendJSONStack(stack string, value byte) (string, error) {
	if len(stack) >= jsonMaxNestingDepth {
		return "", apiError{Status: http.StatusUnprocessableEntity, Code: "json_too_deep", Message: "JSON nesting exceeds the supported limit"}
	}
	return stack + string(value), nil
}

func popJSONStack(stack string, close byte) (string, error) {
	if len(stack) == 0 || matchingJSONClose(stack[len(stack)-1]) != close {
		return "", apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: "JSON contains mismatched container delimiters"}
	}
	return stack[:len(stack)-1], nil
}

func writeBeautifyNewline(output *bytes.Buffer, line *int64, depth int) {
	output.WriteByte('\n')
	(*line)++
	writeJSONIndent(output, depth)
}

func (a *application) handleJSONBeautify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, key, etag, err := a.jsonObjectFromRequest(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	cursor, err := decodeJSONCursor(r.URL.Query().Get("cursor"), jsonTextCursor{Line: 1})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	body, err := openJSONObjectStream(r.Context(), instance, key, cursor.Offset, etag)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	defer body.Close()

	reader := newJSONStreamReader(body, cursor.Offset)
	state := cursor
	startLine := state.Line
	var output bytes.Buffer
	output.Grow(jsonTextPageBytes)
	done := false

	for output.Len() < jsonTextPageBytes && state.Line-startLine < jsonTextPageLines {
		value, size, readErr := reader.readRune()
		if readErr != nil {
			if readErr == io.EOF {
				done = true
				break
			}
			writeAPIError(w, fmt.Errorf("read JSON source: %w", readErr))
			return
		}
		if value == utf8.RuneError && size == 1 {
			value = utf8.RuneError
		}

	processRune:
		if state.InString {
			output.WriteRune(value)
			if state.Escaped {
				state.Escaped = false
			} else if value == '\\' {
				state.Escaped = true
			} else if value == '"' {
				state.InString = false
			}
			continue
		}

		if state.InScalar {
			if value == ' ' || value == '\t' || value == '\r' || value == '\n' || value == ',' || value == ']' || value == '}' {
				state.InScalar = false
				goto processRune
			}
			output.WriteRune(value)
			continue
		}

		if value == ' ' || value == '\t' || value == '\r' || value == '\n' {
			continue
		}

		if state.Pending != 0 {
			if state.Pending == 'o' && len(state.Stack) > 0 && matchingJSONClose(state.Stack[len(state.Stack)-1]) == byte(value) {
				state.Pending = 0
				state.Stack, err = popJSONStack(state.Stack, byte(value))
				if err != nil {
					writeAPIError(w, err)
					return
				}
				output.WriteRune(value)
				continue
			}
			writeBeautifyNewline(&output, &state.Line, len(state.Stack))
			state.Pending = 0
		}

		switch value {
		case '"':
			state.InString = true
			state.Escaped = false
			output.WriteRune(value)
		case '{', '[':
			output.WriteRune(value)
			state.Stack, err = appendJSONStack(state.Stack, byte(value))
			if err != nil {
				writeAPIError(w, err)
				return
			}
			state.Pending = 'o'
		case ',':
			output.WriteRune(value)
			state.Pending = 'c'
		case ':':
			output.WriteString(": ")
		case '}', ']':
			state.Stack, err = popJSONStack(state.Stack, byte(value))
			if err != nil {
				writeAPIError(w, err)
				return
			}
			writeBeautifyNewline(&output, &state.Line, len(state.Stack))
			output.WriteRune(value)
		default:
			state.InScalar = true
			output.WriteRune(value)
		}
	}

	if done {
		if state.InString || state.Escaped || len(state.Stack) != 0 {
			writeAPIError(w, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: "JSON ended before all strings or containers were closed"})
			return
		}
		if state.Pending != 0 {
			state.Pending = 0
		}
	}
	state.Offset = reader.offset
	next := ""
	if !done {
		next = encodeJSONCursor(state)
	}
	writeJSON(w, http.StatusOK, jsonTextPageResponse{
		Text:       output.String(),
		NextCursor: next,
		Done:       done,
		LineStart:  startLine,
		LineEnd:    state.Line,
		Continued:  cursor.InString || cursor.InScalar,
	})
}

func jsonStringPreview(raw []byte, complete bool) string {
	if complete {
		quoted := append([]byte{'"'}, raw...)
		quoted = append(quoted, '"')
		var value string
		if err := json.Unmarshal(quoted, &value); err == nil {
			return value
		}
	}
	value := strings.ReplaceAll(string(raw), `\n`, "↵")
	value = strings.ReplaceAll(value, `\r`, "")
	value = strings.ReplaceAll(value, `\t`, "⇥")
	value = strings.ReplaceAll(value, `\"`, `"`)
	value = strings.ReplaceAll(value, `\\`, `\`)
	return strings.ToValidUTF8(value, "�")
}

func readJSONString(reader *jsonStreamReader, captureLimit int) (start, end int64, preview string, truncated bool, err error) {
	start = reader.offset
	opening, err := reader.readByte()
	if err != nil {
		return 0, 0, "", false, err
	}
	if opening != '"' {
		return 0, 0, "", false, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: fmt.Sprintf("expected JSON string at byte %d", start)}
	}
	captured := make([]byte, 0, minInt(captureLimit, 256))
	escaped := false
	for {
		value, readErr := reader.readByte()
		if readErr != nil {
			if readErr == io.EOF {
				return 0, 0, "", false, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: "JSON ended inside a string"}
			}
			return 0, 0, "", false, readErr
		}
		if escaped {
			if len(captured)+2 <= captureLimit {
				captured = append(captured, '\\', value)
			} else {
				truncated = true
			}
			escaped = false
			continue
		}
		if value == '\\' {
			escaped = true
			continue
		}
		if value == '"' {
			return start, reader.offset, jsonStringPreview(captured, !truncated), truncated, nil
		}
		if len(captured) < captureLimit {
			captured = append(captured, value)
		} else {
			truncated = true
		}
	}
}

func skipJSONContainer(reader *jsonStreamReader) (int64, error) {
	opening, err := reader.readByte()
	if err != nil {
		return 0, err
	}
	if opening != '{' && opening != '[' {
		return 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: "expected a JSON object or array"}
	}
	stack := []byte{opening}
	inString := false
	escaped := false
	for len(stack) > 0 {
		value, readErr := reader.readByte()
		if readErr != nil {
			if readErr == io.EOF {
				return 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: "JSON ended before a container was closed"}
			}
			return 0, readErr
		}
		if inString {
			if escaped {
				escaped = false
			} else if value == '\\' {
				escaped = true
			} else if value == '"' {
				inString = false
			}
			continue
		}
		switch value {
		case '"':
			inString = true
		case '{', '[':
			if len(stack) >= jsonMaxNestingDepth {
				return 0, apiError{Status: http.StatusUnprocessableEntity, Code: "json_too_deep", Message: "JSON nesting exceeds the supported limit"}
			}
			stack = append(stack, value)
		case '}', ']':
			if matchingJSONClose(stack[len(stack)-1]) != value {
				return 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: fmt.Sprintf("mismatched JSON delimiter at byte %d", reader.offset-1)}
			}
			stack = stack[:len(stack)-1]
		}
	}
	return reader.offset, nil
}

func isJSONScalarDelimiter(value byte) bool {
	switch value {
	case ' ', '\t', '\r', '\n', ',', ']', '}':
		return true
	default:
		return false
	}
}

func inspectJSONValue(reader *jsonStreamReader) (jsonTreeNodeJSON, error) {
	if err := reader.skipWhitespace(); err != nil {
		return jsonTreeNodeJSON{}, err
	}
	start := reader.offset
	value, err := reader.peekByte()
	if err != nil {
		return jsonTreeNodeJSON{}, err
	}
	switch value {
	case '{', '[':
		kind := "object"
		preview := "{…}"
		if value == '[' {
			kind = "array"
			preview = "[…]"
		}
		end, err := skipJSONContainer(reader)
		if err != nil {
			return jsonTreeNodeJSON{}, err
		}
		return jsonTreeNodeJSON{Type: kind, Preview: preview, Container: true, Start: start, End: end}, nil
	case '"':
		_, end, preview, truncated, err := readJSONString(reader, jsonTreePreviewBytes)
		if err != nil {
			return jsonTreeNodeJSON{}, err
		}
		if truncated {
			preview += "…"
		}
		return jsonTreeNodeJSON{Type: "string", Preview: `"` + preview + `"`, Start: start, End: end}, nil
	default:
		captured := make([]byte, 0, 64)
		truncated := false
		for {
			current, peekErr := reader.peekByte()
			if peekErr != nil {
				if peekErr == io.EOF {
					break
				}
				return jsonTreeNodeJSON{}, peekErr
			}
			if isJSONScalarDelimiter(current) {
				break
			}
			_, _ = reader.readByte()
			if len(captured) < jsonTreePreviewBytes {
				captured = append(captured, current)
			} else {
				truncated = true
			}
		}
		raw := strings.TrimSpace(string(captured))
		kind := "number"
		if raw == "true" || raw == "false" {
			kind = "boolean"
		} else if raw == "null" {
			kind = "null"
		} else if _, parseErr := strconv.ParseFloat(raw, 64); parseErr != nil {
			kind = "unknown"
		}
		if truncated {
			raw += "…"
		}
		return jsonTreeNodeJSON{Type: kind, Preview: raw, Start: start, End: reader.offset}, nil
	}
}

func readJSONTreePage(reader *jsonStreamReader, node jsonTreeNodeJSON, cursorProvided bool, nextIndex int64, limit int) ([]jsonTreeNodeJSON, int64, int64, bool, error) {
	if node.Type != "object" && node.Type != "array" {
		return nil, 0, nextIndex, true, nil
	}
	if !cursorProvided {
		if err := reader.skipWhitespace(); err != nil {
			return nil, 0, nextIndex, false, err
		}
		opening, err := reader.readByte()
		if err != nil {
			return nil, 0, nextIndex, false, err
		}
		expected := byte('{')
		if node.Type == "array" {
			expected = '['
		}
		if opening != expected {
			return nil, 0, nextIndex, false, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: fmt.Sprintf("JSON %s no longer starts at byte %d", node.Type, node.Start)}
		}
	}

	closing := byte('}')
	if node.Type == "array" {
		closing = ']'
	}
	children := make([]jsonTreeNodeJSON, 0, limit)
	for len(children) < limit {
		if err := reader.skipWhitespace(); err != nil {
			if err == io.EOF {
				return nil, 0, nextIndex, false, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: "JSON ended while reading container children"}
			}
			return nil, 0, nextIndex, false, err
		}
		current, err := reader.peekByte()
		if err != nil {
			return nil, 0, nextIndex, false, err
		}
		if current == closing {
			_, _ = reader.readByte()
			return children, 0, nextIndex, true, nil
		}

		label := strconv.FormatInt(nextIndex, 10)
		if node.Type == "object" {
			_, _, keyPreview, truncated, err := readJSONString(reader, jsonTreeKeyPreviewBytes)
			if err != nil {
				return nil, 0, nextIndex, false, err
			}
			label = keyPreview
			if truncated {
				label += "…"
			}
			if err := reader.skipWhitespace(); err != nil {
				return nil, 0, nextIndex, false, err
			}
			colon, err := reader.readByte()
			if err != nil || colon != ':' {
				return nil, 0, nextIndex, false, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: fmt.Sprintf("expected ':' after JSON property at byte %d", reader.offset)}
			}
		}
		child, err := inspectJSONValue(reader)
		if err != nil {
			return nil, 0, nextIndex, false, err
		}
		child.Label = label
		children = append(children, child)
		nextIndex++

		if err := reader.skipWhitespace(); err != nil {
			return nil, 0, nextIndex, false, err
		}
		separator, err := reader.readByte()
		if err != nil {
			return nil, 0, nextIndex, false, err
		}
		switch separator {
		case ',':
			if len(children) >= limit {
				return children, reader.offset, nextIndex, false, nil
			}
		case closing:
			return children, 0, nextIndex, true, nil
		default:
			return nil, 0, nextIndex, false, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: fmt.Sprintf("expected ',' or closing delimiter at byte %d", reader.offset-1)}
		}
	}
	return children, reader.offset, nextIndex, false, nil
}

func (a *application) handleJSONTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, key, etag, err := a.jsonObjectFromRequest(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	start, err := parseNonNegativeInt64(r.URL.Query().Get("start"), 0)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	cursor, err := parseNonNegativeInt64(r.URL.Query().Get("cursor"), 0)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	nextIndex, err := parseNonNegativeInt64(r.URL.Query().Get("index"), 0)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	limit, err := parsePositiveInt(r.URL.Query().Get("limit"), jsonTreeDefaultPageSize, jsonTreeMaxPageSize)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	nodeType := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("type")))
	if nodeType != "" && nodeType != "object" && nodeType != "array" {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_node_type", Message: "JSON tree node type must be object or array"})
		return
	}

	streamOffset := start
	cursorProvided := cursor > 0
	if cursorProvided {
		streamOffset = cursor
	}
	body, err := openJSONObjectStream(r.Context(), instance, key, streamOffset, etag)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	defer body.Close()
	reader := newJSONStreamReader(body, streamOffset)

	var node jsonTreeNodeJSON
	if nodeType == "" {
		if err := reader.skipWhitespace(); err != nil {
			writeAPIError(w, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_json", Message: "JSON document is empty"})
			return
		}
		rootStart := reader.offset
		opening, err := reader.peekByte()
		if err != nil {
			writeAPIError(w, err)
			return
		}
		if opening == '{' || opening == '[' {
			node = jsonTreeNodeJSON{Type: "object", Preview: "{…}", Container: true, Start: rootStart}
			if opening == '[' {
				node.Type = "array"
				node.Preview = "[…]"
			}
		} else {
			node, err = inspectJSONValue(reader)
			if err != nil {
				writeAPIError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, jsonTreeResponse{Node: node, Done: true})
			return
		}
	} else {
		node = jsonTreeNodeJSON{Type: nodeType, Container: true, Start: start}
		if nodeType == "object" {
			node.Preview = "{…}"
		} else {
			node.Preview = "[…]"
		}
	}

	children, nextCursor, nextIndex, done, err := readJSONTreePage(reader, node, cursorProvided, nextIndex, limit)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, jsonTreeResponse{
		Node:      node,
		Children:  children,
		Cursor:    nextCursor,
		NextIndex: nextIndex,
		Done:      done,
	})
}
