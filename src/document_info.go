package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// inspectDocumentDetails handles explicit Details requests for non-media
// formats whose useful properties require reading the document itself. It is
// deliberately never called while listing a folder.
func inspectDocumentDetails(ctx context.Context, instance *storageInstance, key, extension, contentType string, listed mediaSourceMetadata) (mediaInfoResponse, bool, error) {
	response := mediaInfoResponse{Instance: instance.cfg.ID, Key: key}
	extension = strings.ToLower(strings.TrimSpace(extension))

	// Delimited files and JSON can be much larger than the available memory. A
	// Details action therefore returns storage metadata immediately and exposes a
	// separate, explicit count operation in the frontend. Counting rows or lines
	// always requires a sequential read of the complete object and must never be
	// hidden inside a routine Details request.
	switch extension {
	case "csv", "tsv", "tab", "psv":
		head, err := instance.Head(ctx, instance.fullKey(key))
		if err != nil {
			return response, true, err
		}
		if head.Body != nil {
			defer head.Body.Close()
		}
		populateMediaStorageFields(&response, head.Header, listed.Size)
		response.Container = strings.ToUpper(extension)
		if extension == "tab" {
			response.Container = "TSV"
		}
		return response, true, nil
	case "json", "geojson":
		head, err := instance.Head(ctx, instance.fullKey(key))
		if err != nil {
			return response, true, err
		}
		if head.Body != nil {
			defer head.Body.Close()
		}
		populateMediaStorageFields(&response, head.Header, listed.Size)
		response.Container = strings.ToUpper(extension)
		return response, true, nil
	case "docx", "docm", "dotx", "dotm":
		summary, err := inspectWordProperties(ctx, instance, key, extension, listed)
		if err != nil {
			return response, true, err
		}
		populateMediaStorageFields(&response, summary.Headers, summary.Size)
		response.Container = summary.Container
		response.Properties = summary.Properties
		return response, true, nil
	case "xlsx", "xlsm", "xltx", "xltm", "xlam":
		summary, headers, size, err := inspectSpreadsheetSummary(ctx, instance, key, listed.Size)
		if err != nil {
			return response, true, err
		}
		office, err := inspectOfficeOpenXMLProperties(ctx, instance, key, extension, listed, officeFamilySpreadsheet)
		if err != nil {
			return response, true, err
		}
		populateMediaStorageFields(&response, headers, size)
		response.Container = officeOpenXMLContainerLabel(extension)
		response.Properties = mergeOfficeProperties(office.Properties, map[string]string{
			"Worksheets":       strconv.Itoa(summary.Sheets),
			"Active worksheet": summary.ActiveSheet,
		})
		return response, true, nil
	case "pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "ppam", "sldx", "sldm":
		summary, err := inspectOfficeOpenXMLProperties(ctx, instance, key, extension, listed, officeFamilyPresentation)
		if err != nil {
			return response, true, err
		}
		populateMediaStorageFields(&response, summary.Headers, summary.Size)
		response.Container = summary.Container
		response.Properties = summary.Properties
		return response, true, nil
	case "vsdx", "vsdm", "vssx", "vssm", "vstx", "vstm":
		summary, err := inspectOfficeOpenXMLProperties(ctx, instance, key, extension, listed, officeFamilyVisio)
		if err != nil {
			return response, true, err
		}
		populateMediaStorageFields(&response, summary.Headers, summary.Size)
		response.Container = summary.Container
		response.Properties = summary.Properties
		return response, true, nil
	case "parquet":
		summary, headers, size, err := inspectParquetSummary(ctx, instance, key, listed.Size)
		if err != nil {
			return response, true, err
		}
		populateMediaStorageFields(&response, headers, size)
		response.Container = "PARQUET"
		response.Properties = map[string]string{
			"Rows":    formatInteger(summary.Rows),
			"Columns": formatInteger(int64(summary.Columns)),
		}
		return response, true, nil
	case "sqlite", "sqlite3", "db", "db3", "s3db", "sl3":
		summary, headers, size, err := inspectSQLiteHeader(ctx, instance, key, listed.Size)
		if err != nil {
			return response, true, err
		}
		populateMediaStorageFields(&response, headers, size)
		response.Container = "SQLITE"
		response.Properties = summary
		return response, true, nil
	}
	if summary, handled, err := inspectStructuredMetadata(ctx, instance, key, extension, contentType, listed); handled {
		if err != nil {
			return response, true, err
		}
		populateMediaStorageFields(&response, summary.Headers, summary.Size)
		response.Container = summary.Container
		response.Properties = summary.Properties
		return response, true, nil
	}

	if extension == "" && isDelimitedContentType(contentType) {
		head, err := instance.Head(ctx, instance.fullKey(key))
		if err != nil {
			return response, true, err
		}
		if head.Body != nil {
			defer head.Body.Close()
		}
		populateMediaStorageFields(&response, head.Header, listed.Size)
		if strings.Contains(strings.ToLower(contentType), "tab") || strings.EqualFold(strings.TrimSpace(contentType), "text/tsv") {
			response.Container = "TSV"
		} else {
			response.Container = "CSV"
		}
		return response, true, nil
	}

	if !isTextLineCountCandidate(key, contentType) {
		return response, false, nil
	}
	head, err := instance.Head(ctx, instance.fullKey(key))
	if err != nil {
		return response, true, err
	}
	if head.Body != nil {
		defer head.Body.Close()
	}
	populateMediaStorageFields(&response, head.Header, listed.Size)
	response.Container = textContainerLabel(key, extension, contentType)
	return response, true, nil
}

func isDelimitedContentType(contentType string) bool {
	value := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	return value == "text/csv" || value == "text/tsv" || value == "text/tab-separated-values"
}

type delimitedSummary struct {
	Rows    int64
	Columns int64
}

// inspectDelimitedSummary performs one sequential object read. It never keeps
// a row or field value in memory: only per-column non-empty flags are retained,
// so a quoted field or a complete CSV file may be larger than available RAM.
// The first non-empty record is treated as the header, matching the preview.
func inspectDelimitedSummary(ctx context.Context, instance *storageInstance, key, extension string) (delimitedSummary, http.Header, int64, error) {
	response, err := instance.Get(ctx, instance.fullKey(key), nil)
	if err != nil {
		return delimitedSummary{}, nil, 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return delimitedSummary{}, nil, 0, fmt.Errorf("read delimited object: HTTP %d", response.StatusCode)
	}
	reader := bufio.NewReaderSize(response.Body, 256<<10)
	delimiter := byte(',')
	switch strings.ToLower(extension) {
	case "tsv", "tab":
		delimiter = '\t'
	case "psv":
		delimiter = '|'
	default:
		sample, peekErr := reader.Peek(128 << 10)
		if peekErr != nil && !errors.Is(peekErr, io.EOF) && !errors.Is(peekErr, bufio.ErrBufferFull) {
			return delimitedSummary{}, nil, 0, peekErr
		}
		delimiter = detectDelimitedSeparator(sample)
	}

	summary, total, err := countDelimitedDimensions(reader, delimiter)
	if err != nil {
		return delimitedSummary{}, nil, 0, err
	}
	return summary, response.Header.Clone(), total, nil
}

func detectDelimitedSeparator(sample []byte) byte {
	candidates := []byte{',', ';', '\t', '|'}
	best := candidates[0]
	bestScore := -1
	for _, candidate := range candidates {
		counts := sampleDelimitedFieldCounts(sample, candidate, 25)
		frequencies := make(map[int]int)
		maximum := 0
		for _, count := range counts {
			if count <= 1 {
				continue
			}
			frequencies[count]++
			if count > maximum {
				maximum = count
			}
		}
		mode := 0
		for _, frequency := range frequencies {
			if frequency > mode {
				mode = frequency
			}
		}
		score := mode*100 + maximum
		if score > bestScore {
			best, bestScore = candidate, score
		}
	}
	return best
}

func sampleDelimitedFieldCounts(sample []byte, delimiter byte, limit int) []int {
	counts := make([]int, 0, limit)
	fields := 1
	inQuotes := false
	afterQuote := false
	rowHasContent := false
	for index := 0; index < len(sample) && len(counts) < limit; index++ {
		value := sample[index]
		if inQuotes {
			if value == '"' {
				inQuotes = false
				afterQuote = true
			} else if value != ' ' && value != '\t' && value != '\r' && value != '\n' {
				rowHasContent = true
			}
			continue
		}
		if afterQuote {
			if value == '"' {
				inQuotes = true
				afterQuote = false
				rowHasContent = true
				continue
			}
			afterQuote = false
		}
		switch value {
		case '"':
			inQuotes = true
		case delimiter:
			fields++
		case '\r':
			if index+1 < len(sample) && sample[index+1] == '\n' {
				index++
			}
			if rowHasContent || fields > 1 {
				counts = append(counts, fields)
			}
			fields, rowHasContent = 1, false
		case '\n':
			if rowHasContent || fields > 1 {
				counts = append(counts, fields)
			}
			fields, rowHasContent = 1, false
		default:
			if value != ' ' && value != '\t' {
				rowHasContent = true
			}
		}
	}
	if len(counts) < limit && (rowHasContent || fields > 1) {
		counts = append(counts, fields)
	}
	return counts
}

func countDelimitedDimensions(reader io.Reader, delimiter byte) (delimitedSummary, int64, error) {
	buffer := make([]byte, 256<<10)
	row := make([]bool, 0, 32)
	nonEmptyColumns := make([]bool, 0, 32)
	fieldNonEmpty := false
	fieldStarted := false
	inQuotes := false
	afterQuote := false
	skipLF := false
	var records int64
	var total int64

	finishField := func() {
		row = append(row, fieldNonEmpty)
		fieldNonEmpty = false
		fieldStarted = false
	}
	finishRecord := func() {
		finishField()
		visible := false
		for _, value := range row {
			if value {
				visible = true
				break
			}
		}
		if visible {
			records++
			if len(nonEmptyColumns) < len(row) {
				nonEmptyColumns = append(nonEmptyColumns, make([]bool, len(row)-len(nonEmptyColumns))...)
			}
			for index, value := range row {
				if value {
					nonEmptyColumns[index] = true
				}
			}
		}
		row = row[:0]
	}

	for {
		count, readErr := reader.Read(buffer)
		if count > 0 {
			total += int64(count)
			for _, value := range buffer[:count] {
				if skipLF {
					skipLF = false
					if value == '\n' {
						continue
					}
				}
				if inQuotes {
					fieldStarted = true
					if value == '"' {
						inQuotes = false
						afterQuote = true
					} else if value != ' ' && value != '\t' && value != '\r' && value != '\n' {
						fieldNonEmpty = true
					}
					continue
				}
				if afterQuote {
					if value == '"' {
						inQuotes = true
						afterQuote = false
						fieldNonEmpty = true
						continue
					}
					afterQuote = false
				}
				switch value {
				case '"':
					if !fieldStarted {
						fieldStarted = true
						inQuotes = true
					} else {
						fieldNonEmpty = true
					}
				case delimiter:
					finishField()
				case '\r':
					finishRecord()
					skipLF = true
				case '\n':
					finishRecord()
				default:
					fieldStarted = true
					if value != ' ' && value != '\t' {
						fieldNonEmpty = true
					}
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return delimitedSummary{}, total, readErr
		}
	}
	if inQuotes {
		return delimitedSummary{}, total, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_delimited_file", Message: "the delimited file ends inside a quoted field"}
	}
	if fieldStarted || fieldNonEmpty || len(row) > 0 {
		finishRecord()
	}
	columns := int64(0)
	for _, value := range nonEmptyColumns {
		if value {
			columns++
		}
	}
	rows := records
	if rows > 0 {
		rows--
	}
	return delimitedSummary{Rows: rows, Columns: columns}, total, nil
}

func formatInteger(value int64) string {
	return strconv.FormatInt(value, 10)
}

var textContainerLabels = map[string]string{
	"sh": "Shell", "bash": "Shell", "zsh": "Shell", "ksh": "Shell", "fish": "Shell", "envrc": "Shell",
	"ps1": "PowerShell", "psm1": "PowerShell", "psd1": "PowerShell",
	"js": "JavaScript", "mjs": "JavaScript module", "cjs": "CommonJS JavaScript", "jsx": "JavaScript XML",
	"ts": "TypeScript", "mts": "TypeScript module", "cts": "TypeScript module", "tsx": "TypeScript XML",
	"json": "JSON", "json5": "JSON5", "hjson": "Hjson", "geojson": "GeoJSON", "ipynb": "Jupyter Notebook",
	"yaml": "YAML", "yml": "YAML", "toml": "TOML", "hcl": "Terraform HCL", "tf": "Terraform HCL", "tfvars": "Terraform variables",
	"html": "HTML", "htm": "HTML", "xhtml": "XHTML", "vue": "Vue single-file component", "svelte": "Svelte component", "xml": "XML", "svg": "SVG",
	"css": "CSS", "scss": "SCSS", "sass": "Sass", "less": "Less",
	"ini": "INI", "conf": "Configuration", "cfg": "Configuration", "properties": "Java properties", "cnf": "Configuration",
	"md": "Markdown", "markdown": "Markdown", "mdown": "Markdown", "mkd": "Markdown", "rmd": "R Markdown", "adoc": "AsciiDoc", "asciidoc": "AsciiDoc",
	"txt": "Plain text", "log": "Log", "out": "Plain text", "diff": "Diff", "patch": "Patch",
	"sql": "SQL", "gql": "GraphQL", "graphql": "GraphQL", "proto": "Protocol Buffers", "thrift": "Apache Thrift",
	"mk": "Makefile", "nginx": "Nginx configuration",
	"java": "Java", "kt": "Kotlin", "kts": "Kotlin", "groovy": "Groovy", "scala": "Scala",
	"c": "C", "h": "C", "cpp": "C++", "cxx": "C++", "cc": "C++", "hpp": "C++", "hxx": "C++", "inl": "C++",
	"m": "Objective-C", "mm": "Objective-C++", "cs": "C#",
	"go": "Go", "mod": "Go module", "sum": "Go checksum list", "work": "Go workspace", "rs": "Rust", "swift": "Swift",
	"py": "Python", "pyw": "Python", "pyi": "Python type stub", "rb": "Ruby", "php": "PHP", "phtml": "PHP",
	"pl": "Perl", "pm": "Perl", "lua": "Lua", "r": "R", "dart": "Dart", "zig": "Zig", "cue": "CUE", "nix": "Nix",
	"bat": "DOS batch", "cmd": "DOS batch", "vb": "Visual Basic .NET", "vbs": "VBScript", "fs": "F#", "fsx": "F#",
	"hs": "Haskell", "ml": "OCaml", "mli": "OCaml", "pas": "Pascal", "pp": "Pascal",
	"mustache": "Mustache template", "hbs": "Handlebars", "handlebars": "Handlebars", "ejs": "Embedded JavaScript template",
	"njk": "Nunjucks template", "twig": "Twig template", "jinja": "Jinja template", "lock": "Lock file",
}

func textContainerLabel(key, extension, contentType string) string {
	extension = strings.ToLower(strings.TrimSpace(extension))
	if label := textContainerLabels[extension]; label != "" {
		return label
	}
	name := strings.ToLower(path.Base(key))
	switch {
	case strings.HasPrefix(name, "dockerfile"):
		return "Dockerfile"
	case strings.HasPrefix(name, "containerfile"):
		return "Containerfile"
	case name == "makefile" || name == "gnumakefile":
		return "Makefile"
	case strings.HasPrefix(name, "jenkinsfile"):
		return "Jenkins pipeline"
	case strings.HasPrefix(name, ".env"):
		return "Environment configuration"
	}
	if strings.HasPrefix(strings.ToLower(contentType), "text/") {
		return "Plain text"
	}
	return ""
}

func isTextLineCountCandidate(key, contentType string) bool {
	name := strings.ToLower(path.Base(key))
	extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "text/") {
		return true
	}
	if strings.HasPrefix(name, ".env") {
		return true
	}
	exact := map[string]bool{
		"dockerfile": true, "containerfile": true, "makefile": true,
		"gnumakefile": true, "jenkinsfile": true, "procfile": true,
		"gemfile": true, "rakefile": true, "vagrantfile": true,
		"caddyfile": true, "justfile": true, "taskfile": true,
		"earthfile": true, "brewfile": true, "podfile": true,
		"codeowners": true, "owners": true, "maintainers": true,
	}
	if exact[name] || strings.HasPrefix(name, ".git") || strings.HasPrefix(name, ".docker") {
		return true
	}
	textExtensions := map[string]bool{
		"txt": true, "log": true, "md": true, "markdown": true, "mdown": true, "mkd": true, "rmd": true,
		"go": true, "mod": true, "sum": true, "work": true, "rs": true, "c": true, "h": true,
		"cpp": true, "cxx": true, "cc": true, "hpp": true, "hxx": true, "cs": true, "java": true,
		"kt": true, "kts": true, "swift": true, "m": true, "mm": true, "py": true, "pyw": true,
		"pyi": true, "rb": true, "php": true, "pl": true, "pm": true, "lua": true, "r": true,
		"js": true, "mjs": true, "cjs": true, "jsx": true, "ts": true, "mts": true, "cts": true,
		"tsx": true, "css": true, "scss": true, "sass": true, "less": true, "html": true, "htm": true,
		"xhtml": true, "xml": true, "svg": true, "yaml": true, "yml": true, "toml": true, "hcl": true,
		"tf": true, "tfvars": true, "ini": true, "conf": true, "cfg": true, "properties": true,
		"sh": true, "bash": true, "zsh": true, "fish": true, "ps1": true, "sql": true, "proto": true,
		"graphql": true, "gql": true, "diff": true, "patch": true, "json": true, "json5": true, "hjson": true, "geojson": true, "ipynb": true,
		"jsonl": true, "ndjson": true, "csv": true, "tsv": true, "tab": true, "psv": true,
		"psm1": true, "psd1": true, "ksh": true, "envrc": true, "adoc": true, "asciidoc": true, "out": true,
		"thrift": true, "mk": true, "nginx": true, "groovy": true, "scala": true, "inl": true, "dart": true,
		"zig": true, "cue": true, "nix": true, "bat": true, "cmd": true, "vb": true, "vbs": true, "fs": true, "fsx": true,
		"hs": true, "ml": true, "mli": true, "pas": true, "pp": true, "mustache": true, "hbs": true,
		"handlebars": true, "ejs": true, "njk": true, "twig": true, "jinja": true, "lock": true,
	}
	return textExtensions[extension]
}

func countObjectLines(ctx context.Context, instance *storageInstance, key string) (int64, http.Header, int64, error) {
	response, err := instance.Get(ctx, instance.fullKey(key), nil)
	if err != nil {
		return 0, nil, 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, nil, 0, fmt.Errorf("read text object: HTTP %d", response.StatusCode)
	}
	reader := bufio.NewReaderSize(response.Body, 256<<10)
	buffer := make([]byte, 256<<10)
	var lines int64
	var total int64
	last := byte(0)
	for {
		count, readErr := reader.Read(buffer)
		if count > 0 {
			total += int64(count)
			lines += int64(bytes.Count(buffer[:count], []byte{'\n'}))
			last = buffer[count-1]
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, nil, 0, readErr
		}
	}
	if total > 0 && last != '\n' {
		lines++
	}
	return lines, response.Header.Clone(), total, nil
}

type spreadsheetSummary struct {
	Sheets      int
	ActiveSheet string
	Rows        int64
	Columns     int64
}

func inspectSpreadsheetSummary(ctx context.Context, instance *storageInstance, key string, knownSize int64) (spreadsheetSummary, http.Header, int64, error) {
	source, err := openObjectRangeSource(ctx, instance, key)
	if err != nil {
		return spreadsheetSummary{}, nil, 0, err
	}
	source.SetKnownSize(knownSize)
	if source.Size() <= 0 {
		if _, err := source.ReadSuffix(64 << 10); err != nil && err != io.EOF {
			return spreadsheetSummary{}, nil, 0, err
		}
	}
	if source.Size() <= 0 {
		return spreadsheetSummary{}, nil, 0, apiError{Status: http.StatusUnprocessableEntity, Code: "unknown_workbook_size", Message: "spreadsheet details require a known non-zero object size"}
	}
	if source.Size() > maxSpreadsheetObjectBytes {
		return spreadsheetSummary{}, nil, 0, apiError{Status: http.StatusRequestEntityTooLarge, Code: "workbook_too_large", Message: fmt.Sprintf("spreadsheet details are limited to %d MiB", maxSpreadsheetObjectBytes>>20)}
	}
	reader, err := newSpreadsheetZipReader(source)
	if err != nil {
		return spreadsheetSummary{}, nil, 0, err
	}
	files := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		files[path.Clean(strings.TrimLeft(file.Name, "/"))] = file
	}
	sheets, err := readWorkbookSheets(files)
	if err != nil {
		return spreadsheetSummary{}, nil, 0, err
	}
	summary := spreadsheetSummary{Sheets: len(sheets)}
	if len(sheets) == 0 {
		return summary, source.Headers().Clone(), source.Size(), nil
	}
	activeIndex, err := readWorkbookActiveSheetIndex(files["xl/workbook.xml"], sheets)
	if err != nil {
		return spreadsheetSummary{}, nil, 0, err
	}
	active := sheets[activeIndex]
	summary.ActiveSheet = active.Name
	// Exact used-row and used-column counts require traversing the complete
	// active worksheet. Details deliberately omit them; the explicit document
	// count action performs that scan when the user requests it.
	return summary, source.Headers().Clone(), source.Size(), nil
}

func inspectSpreadsheetDimensions(ctx context.Context, instance *storageInstance, key string, knownSize int64) (spreadsheetSummary, error) {
	source, err := openObjectRangeSource(ctx, instance, key)
	if err != nil {
		return spreadsheetSummary{}, err
	}
	source.SetKnownSize(knownSize)
	if source.Size() <= 0 {
		if _, err := source.ReadSuffix(64 << 10); err != nil && !errors.Is(err, io.EOF) {
			return spreadsheetSummary{}, err
		}
	}
	if source.Size() <= 0 {
		return spreadsheetSummary{}, apiError{Status: http.StatusUnprocessableEntity, Code: "unknown_workbook_size", Message: "spreadsheet dimensions require a known non-zero object size"}
	}
	if source.Size() > maxSpreadsheetObjectBytes {
		return spreadsheetSummary{}, apiError{Status: http.StatusRequestEntityTooLarge, Code: "workbook_too_large", Message: fmt.Sprintf("spreadsheet dimension scans are limited to %d MiB", maxSpreadsheetObjectBytes>>20)}
	}
	reader, err := newSpreadsheetZipReader(source)
	if err != nil {
		return spreadsheetSummary{}, err
	}
	files := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		files[path.Clean(strings.TrimLeft(file.Name, "/"))] = file
	}
	sheets, err := readWorkbookSheets(files)
	if err != nil {
		return spreadsheetSummary{}, err
	}
	summary := spreadsheetSummary{Sheets: len(sheets)}
	if len(sheets) == 0 {
		return summary, nil
	}
	activeIndex, err := readWorkbookActiveSheetIndex(files["xl/workbook.xml"], sheets)
	if err != nil {
		return spreadsheetSummary{}, err
	}
	active := sheets[activeIndex]
	summary.ActiveSheet = active.Name
	summary.Rows, summary.Columns, err = countWorksheetDimensions(files[active.Target])
	if err != nil {
		return spreadsheetSummary{}, err
	}
	return summary, nil
}

func readWorkbookActiveSheetIndex(file *zip.File, sheets []spreadsheetSheetInfo) (int, error) {
	if len(sheets) == 0 || file == nil {
		return 0, nil
	}
	var workbook workbookXML
	if err := decodeZipXML(file, &workbook); err != nil {
		return 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_workbook", Message: "unable to read the active worksheet"}
	}
	activeTab := 0
	if len(workbook.Views) > 0 && workbook.Views[0].ActiveTab >= 0 {
		activeTab = workbook.Views[0].ActiveTab
	}
	if activeTab >= len(workbook.Sheets) {
		activeTab = 0
	}
	activeName := ""
	if activeTab < len(workbook.Sheets) {
		activeName = workbook.Sheets[activeTab].Name
	}
	for index, sheet := range sheets {
		if sheet.Name == activeName {
			return index, nil
		}
	}
	return 0, nil
}

func countWorksheetDimensions(file *zip.File) (int64, int64, error) {
	if file == nil {
		return 0, 0, nil
	}
	reader, err := file.Open()
	if err != nil {
		return 0, 0, err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(reader)
	var maximumRow int64
	var maximumColumn int64
	var fallbackRow int64
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_sheet", Message: "unable to inspect worksheet dimensions"}
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "row" {
			continue
		}
		fallbackRow++
		rowNumber := fallbackRow
		for _, attribute := range start.Attr {
			if attribute.Name.Local != "r" {
				continue
			}
			if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(attribute.Value), 10, 64); parseErr == nil && parsed > 0 {
				rowNumber = parsed
				fallbackRow = parsed
			}
		}
		visible, rowMaximum, err := countWorksheetRow(decoder, start)
		if err != nil {
			return 0, 0, err
		}
		if visible && rowNumber > maximumRow {
			maximumRow = rowNumber
		}
		if rowMaximum > maximumColumn {
			maximumColumn = rowMaximum
		}
	}
	return maximumRow, maximumColumn, nil
}

func countWorksheetRow(decoder *xml.Decoder, start xml.StartElement) (bool, int64, error) {
	depth := 1
	visible := false
	maximumColumn := int64(0)
	fallback := 0
	for depth > 0 {
		token, err := decoder.Token()
		if err != nil {
			return false, 0, err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			if typed.Name.Local == "c" {
				column := fallback
				for _, attribute := range typed.Attr {
					if attribute.Name.Local == "r" {
						if parsed, ok := excelColumnIndex(attribute.Value); ok {
							column = parsed
						}
					}
				}
				fallback = column + 1
				hasContent, err := worksheetCellHasContent(decoder)
				if err != nil {
					return false, 0, err
				}
				if hasContent {
					visible = true
					if int64(column+1) > maximumColumn {
						maximumColumn = int64(column + 1)
					}
				}
				continue
			}
			depth++
		case xml.EndElement:
			depth--
		}
	}
	return visible, maximumColumn, nil
}

func worksheetCellHasContent(decoder *xml.Decoder) (bool, error) {
	depth := 1
	hasContent := false
	for depth > 0 {
		token, err := decoder.Token()
		if err != nil {
			return false, err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			depth++
			switch typed.Name.Local {
			case "f":
				// A formula is meaningful even if the workbook omits its cached value.
				hasContent = true
			case "v", "t":
				var value string
				if err := decoder.DecodeElement(&value, &typed); err != nil {
					return false, err
				}
				depth--
				if strings.TrimSpace(value) != "" {
					hasContent = true
				}
			}
		case xml.EndElement:
			depth--
		}
	}
	return hasContent, nil
}

func inspectSQLiteHeader(ctx context.Context, instance *storageInstance, key string, knownSize int64) (map[string]string, http.Header, int64, error) {
	source, err := openObjectRangeSource(ctx, instance, key)
	if err != nil {
		return nil, nil, 0, err
	}
	source.SetKnownSize(knownSize)
	header, err := source.ReadRange(0, 100)
	if err != nil {
		return nil, nil, 0, err
	}
	if len(header) < 100 || string(header[:16]) != "SQLite format 3\x00" {
		return nil, nil, 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_sqlite", Message: "the object is not a SQLite 3 database"}
	}
	pageSize := int64(binary.BigEndian.Uint16(header[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}
	pageCount := int64(binary.BigEndian.Uint32(header[28:32]))
	encoding := map[uint32]string{1: "UTF-8", 2: "UTF-16 little-endian", 3: "UTF-16 big-endian"}[binary.BigEndian.Uint32(header[56:60])]
	if encoding == "" {
		encoding = "Unknown"
	}
	properties := map[string]string{
		"Page size":      formatInteger(pageSize) + " bytes",
		"Database pages": formatInteger(pageCount),
		"Schema format":  formatInteger(int64(binary.BigEndian.Uint32(header[44:48]))),
		"Text encoding":  encoding,
		"User version":   formatInteger(int64(binary.BigEndian.Uint32(header[60:64]))),
	}
	if pageSize > 0 && pageCount > 0 {
		properties["Declared database size"] = formatInteger(pageSize*pageCount) + " bytes"
	}
	if applicationID := binary.BigEndian.Uint32(header[68:72]); applicationID != 0 {
		properties["Application ID"] = fmt.Sprintf("0x%08X", applicationID)
	}
	if version := binary.BigEndian.Uint32(header[96:100]); version != 0 {
		properties["SQLite version"] = fmt.Sprintf("%d.%d.%d", version/1_000_000, (version/1_000)%1_000, version%1_000)
	}
	return properties, source.Headers().Clone(), source.Size(), nil
}

type parquetSummary struct {
	Rows    int64
	Columns int
}

func inspectParquetSummary(ctx context.Context, instance *storageInstance, key string, knownSize int64) (parquetSummary, http.Header, int64, error) {
	source, err := openObjectRangeSource(ctx, instance, key)
	if err != nil {
		return parquetSummary{}, nil, 0, err
	}
	source.SetKnownSize(knownSize)
	footer, err := source.ReadSuffix(8)
	if err != nil {
		return parquetSummary{}, nil, 0, err
	}
	if len(footer) != 8 || string(footer[4:]) != "PAR1" {
		return parquetSummary{}, nil, 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_parquet", Message: "the object is not a valid Parquet file"}
	}
	metadataLength := int64(binary.LittleEndian.Uint32(footer[:4]))
	if metadataLength <= 0 || metadataLength > 128<<20 || source.Size() < metadataLength+8 {
		return parquetSummary{}, nil, 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_parquet_metadata", Message: "the Parquet footer metadata length is invalid"}
	}
	metadata, err := source.ReadRange(source.Size()-8-metadataLength, metadataLength)
	if err != nil {
		return parquetSummary{}, nil, 0, err
	}
	summary, err := parseParquetFileMetadata(metadata)
	if err != nil {
		return parquetSummary{}, nil, 0, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_parquet_metadata", Message: err.Error()}
	}
	return summary, source.Headers().Clone(), source.Size(), nil
}

// Minimal Thrift compact-protocol reader for the two FileMetaData fields needed
// by Details: schema[0].num_children and num_rows. Unknown fields are skipped.
type thriftCompactReader struct {
	data []byte
	pos  int
}

const (
	compactStop         = 0
	compactBooleanTrue  = 1
	compactBooleanFalse = 2
	compactByte         = 3
	compactI16          = 4
	compactI32          = 5
	compactI64          = 6
	compactDouble       = 7
	compactBinary       = 8
	compactList         = 9
	compactSet          = 10
	compactMap          = 11
	compactStruct       = 12
)

func (r *thriftCompactReader) readParquetSchemaElement(root bool) (int, error) {
	lastField := int16(0)
	children := 0
	for {
		fieldID, fieldType, nextLast, err := r.fieldHeader(lastField)
		if err != nil {
			return 0, err
		}
		if fieldType == compactStop {
			return children, nil
		}
		lastField = nextLast
		if root && fieldID == 5 && (fieldType == compactI32 || fieldType == compactI16 || fieldType == compactI64) {
			value, err := r.readZigZag()
			if err != nil {
				return 0, err
			}
			children = int(value)
			continue
		}
		if err := r.skip(fieldType); err != nil {
			return 0, err
		}
	}
}

func (r *thriftCompactReader) fieldHeader(lastField int16) (int16, byte, int16, error) {
	value, err := r.readByte()
	if err != nil {
		return 0, 0, lastField, err
	}
	fieldType := value & 0x0f
	if fieldType == compactStop {
		return 0, compactStop, lastField, nil
	}
	delta := int16(value >> 4)
	fieldID := lastField + delta
	if delta == 0 {
		raw, err := r.readVarint()
		if err != nil {
			return 0, 0, lastField, err
		}
		fieldID = int16(decodeZigZag(raw))
	}
	return fieldID, fieldType, fieldID, nil
}

func (r *thriftCompactReader) collectionHeader() (int, byte, error) {
	value, err := r.readByte()
	if err != nil {
		return 0, 0, err
	}
	size := int(value >> 4)
	elementType := value & 0x0f
	if size == 15 {
		raw, err := r.readVarint()
		if err != nil {
			return 0, 0, err
		}
		if raw > 1<<31 {
			return 0, 0, fmt.Errorf("Thrift collection is too large")
		}
		size = int(raw)
	}
	return size, elementType, nil
}

func (r *thriftCompactReader) skip(fieldType byte) error {
	switch fieldType {
	case compactStop, compactBooleanTrue, compactBooleanFalse:
		return nil
	case compactByte:
		_, err := r.readByte()
		return err
	case compactI16, compactI32, compactI64:
		_, err := r.readVarint()
		return err
	case compactDouble:
		return r.advance(8)
	case compactBinary:
		length, err := r.readVarint()
		if err != nil {
			return err
		}
		if length > uint64(len(r.data)) {
			return io.ErrUnexpectedEOF
		}
		return r.advance(int(length))
	case compactList, compactSet:
		size, elementType, err := r.collectionHeader()
		if err != nil {
			return err
		}
		for index := 0; index < size; index++ {
			if err := r.skip(elementType); err != nil {
				return err
			}
		}
		return nil
	case compactMap:
		size, err := r.readVarint()
		if err != nil {
			return err
		}
		if size == 0 {
			return nil
		}
		types, err := r.readByte()
		if err != nil {
			return err
		}
		keyType, valueType := types>>4, types&0x0f
		for index := uint64(0); index < size; index++ {
			if err := r.skip(keyType); err != nil {
				return err
			}
			if err := r.skip(valueType); err != nil {
				return err
			}
		}
		return nil
	case compactStruct:
		lastField := int16(0)
		for {
			_, nestedType, nextLast, err := r.fieldHeader(lastField)
			if err != nil {
				return err
			}
			if nestedType == compactStop {
				return nil
			}
			lastField = nextLast
			if err := r.skip(nestedType); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("unsupported Thrift compact type %d", fieldType)
	}
}

func (r *thriftCompactReader) readZigZag() (int64, error) {
	value, err := r.readVarint()
	if err != nil {
		return 0, err
	}
	return decodeZigZag(value), nil
}

func decodeZigZag(value uint64) int64 {
	return int64(value>>1) ^ -int64(value&1)
}

func (r *thriftCompactReader) readVarint() (uint64, error) {
	var value uint64
	for shift := uint(0); shift < 64; shift += 7 {
		byteValue, err := r.readByte()
		if err != nil {
			return 0, err
		}
		value |= uint64(byteValue&0x7f) << shift
		if byteValue&0x80 == 0 {
			return value, nil
		}
	}
	return 0, fmt.Errorf("invalid Thrift varint")
}

func (r *thriftCompactReader) readByte() (byte, error) {
	if r.pos >= len(r.data) {
		return 0, io.ErrUnexpectedEOF
	}
	value := r.data[r.pos]
	r.pos++
	return value, nil
}

func (r *thriftCompactReader) advance(count int) error {
	if count < 0 || r.pos+count > len(r.data) {
		return io.ErrUnexpectedEOF
	}
	r.pos += count
	return nil
}
