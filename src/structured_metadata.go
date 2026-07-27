package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxSmallStructuredMetadataBytes = int64(1 << 20)
	maxPDFMetadataPrefixBytes       = int64(256 << 10)
	maxPDFMetadataSuffixBytes       = int64(4 << 20)
)

type structuredMetadataSummary struct {
	Container  string
	Properties map[string]string
	Headers    http.Header
	Size       int64
}

func inspectStructuredMetadata(ctx context.Context, instance *storageInstance, key, extension, contentType string, listed mediaSourceMetadata) (structuredMetadataSummary, bool, error) {
	extension = strings.ToLower(strings.TrimSpace(extension))
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch {
	case extension == "pdf" || contentType == "application/pdf":
		summary, err := inspectPDFMetadata(ctx, instance, key, listed)
		return summary, true, err
	case isZipArchiveExtension(extension):
		summary, err := inspectZipArchiveMetadata(ctx, instance, key, extension, listed)
		return summary, true, err
	case isContactExtension(extension, contentType):
		summary, err := inspectSmallTextStructuredMetadata(ctx, instance, key, listed, contactContainerLabel(extension), parseVCardMetadata)
		return summary, true, err
	case isCalendarExtension(extension, contentType):
		summary, err := inspectSmallTextStructuredMetadata(ctx, instance, key, listed, calendarContainerLabel(extension), parseICalendarMetadata)
		return summary, true, err
	case isEmailExtension(extension, contentType):
		summary, err := inspectEmailHeaderMetadata(ctx, instance, key, listed, emailContainerLabel(extension))
		return summary, true, err
	case isCertificateExtension(extension, contentType):
		summary, err := inspectCertificateMetadata(ctx, instance, key, extension, contentType, listed)
		return summary, true, err
	default:
		return structuredMetadataSummary{}, false, nil
	}
}

func isZipArchiveExtension(extension string) bool {
	switch extension {
	case "zip", "jar", "war", "ear", "apk", "aar", "xpi", "crx", "vsix", "epub":
		return true
	default:
		return false
	}
}

func isContactExtension(extension, contentType string) bool {
	return extension == "vcf" || extension == "vcard" || contentType == "text/vcard" || contentType == "text/x-vcard"
}

func isCalendarExtension(extension, contentType string) bool {
	return extension == "ics" || extension == "ifb" || contentType == "text/calendar" || contentType == "application/ics"
}

func isEmailExtension(extension, contentType string) bool {
	switch extension {
	case "eml", "mime", "mht", "mhtml":
		return true
	}
	return contentType == "message/rfc822" || contentType == "multipart/related"
}

func isCertificateExtension(extension, contentType string) bool {
	switch extension {
	case "pem", "crt", "cer", "cert", "der", "csr", "req", "p7b", "p7c", "spc", "pfx", "p12", "key", "pub":
		return true
	}
	return strings.Contains(contentType, "x-pem") || strings.Contains(contentType, "x-x509") || strings.Contains(contentType, "pkcs") || strings.Contains(contentType, "certificate")
}

func openStructuredRangeSource(ctx context.Context, instance *storageInstance, key string, listed mediaSourceMetadata) (*objectRangeSource, error) {
	return openStructuredRangeSourceVersion(ctx, instance, key, "", listed)
}

func openStructuredRangeSourceVersion(ctx context.Context, instance *storageInstance, key, version string, listed mediaSourceMetadata) (*objectRangeSource, error) {
	source, err := openObjectRangeSourceVersion(ctx, instance, key, version)
	if err != nil {
		return nil, err
	}
	source.SetKnownSize(listed.Size)
	source.SetExpectedVersion(objectVersion{ETag: listed.ETag, Modified: listed.LastModified})
	return source, nil
}

func structuredSummaryFromSource(container string, properties map[string]string, source *objectRangeSource) structuredMetadataSummary {
	if len(properties) == 0 {
		properties = nil
	}
	return structuredMetadataSummary{Container: container, Properties: properties, Headers: source.Headers(), Size: source.Size()}
}

func headOnlyStructuredSummary(ctx context.Context, instance *storageInstance, key, container string) (structuredMetadataSummary, error) {
	response, err := instance.Head(ctx, instance.fullKey(key))
	if err != nil {
		return structuredMetadataSummary{}, err
	}
	if response.Body != nil {
		_ = response.Body.Close()
	}
	size, _ := strconv.ParseInt(strings.TrimSpace(response.Header.Get("Content-Length")), 10, 64)
	return structuredMetadataSummary{Container: container, Headers: response.Header.Clone(), Size: size}, nil
}

func inspectPDFMetadata(ctx context.Context, instance *storageInstance, key string, listed mediaSourceMetadata) (structuredMetadataSummary, error) {
	source, err := openStructuredRangeSource(ctx, instance, key, listed)
	if err != nil {
		return structuredMetadataSummary{}, err
	}
	prefix, err := source.ReadRange(0, metadataRangeLength(source, 0, maxPDFMetadataPrefixBytes))
	if err != nil && err != io.EOF {
		return structuredMetadataSummary{}, err
	}
	if source.Size() <= 0 {
		if _, err := source.ReadSuffix(maxPDFMetadataSuffixBytes); err != nil && err != io.EOF {
			return structuredMetadataSummary{}, err
		}
	}
	var suffix []byte
	if size := source.Size(); size > 0 {
		length := minInt64(size, maxPDFMetadataSuffixBytes)
		suffix, err = source.ReadRange(size-length, length)
		if err != nil && err != io.EOF {
			return structuredMetadataSummary{}, err
		}
	}
	props := parsePDFMetadata(prefix, suffix, source.Size())
	return structuredSummaryFromSource("PDF", props, source), nil
}

var (
	pdfHeaderPattern      = regexp.MustCompile(`%PDF-([0-9]+\.[0-9]+)`)
	pdfPagesMarkerPattern = regexp.MustCompile(`/Type\s*/Pages\b`)
	pdfCountOnlyPattern   = regexp.MustCompile(`/Count\s+([0-9]+)`)
	pdfInfoObjectPattern  = regexp.MustCompile(`/Info\s+([0-9]+)\s+([0-9]+)\s+R`)
	pdfObjectPattern      = regexp.MustCompile(`(?s)([0-9]+)\s+([0-9]+)\s+obj\s*<<(.*?)>>`)
)

func parsePDFMetadata(prefix, suffix []byte, size int64) map[string]string {
	props := make(map[string]string)
	if match := pdfHeaderPattern.FindSubmatch(prefix); len(match) == 2 {
		props["PDF version"] = string(match[1])
	}
	if bytes.Contains(prefix, []byte("/Linearized")) {
		props["Linearized"] = "Yes"
	}
	combined := append(append([]byte(nil), prefix...), suffix...)
	if pages := deterministicPDFPageCount(combined); pages > 0 {
		props["Pages"] = formatInteger(int64(pages))
	}
	if size > 0 {
		props["Object size"] = formatInteger(size)
	}
	for k, v := range parsePDFInfoDictionary(combined) {
		if _, exists := props[k]; !exists && v != "" {
			props[k] = v
		}
	}
	if bytes.Contains(combined, []byte("/Encrypt")) {
		props["Encrypted"] = "Yes"
	}
	if bytes.Contains(combined, []byte("/AcroForm")) {
		props["Forms"] = "AcroForm"
	}
	if bytes.Contains(combined, []byte("/MarkInfo")) {
		props["Tagged"] = "Yes"
	}
	return props
}

func deterministicPDFPageCount(data []byte) int {
	counts := make([]int, 0, 8)
	markers := pdfPagesMarkerPattern.FindAllIndex(data, -1)
	for _, marker := range markers {
		start := marker[0]
		if objectStart := bytes.LastIndex(data[:marker[0]], []byte("obj")); objectStart >= 0 && marker[0]-objectStart <= 4096 {
			start = objectStart
		} else if start > 512 {
			start -= 512
		} else {
			start = 0
		}
		end := marker[1] + 4096
		if rel := bytes.Index(data[marker[1]:minInt(len(data), marker[1]+4096)], []byte("endobj")); rel >= 0 {
			end = marker[1] + rel
		}
		if end > len(data) {
			end = len(data)
		}
		matches := pdfCountOnlyPattern.FindAllSubmatch(data[start:end], -1)
		for _, match := range matches {
			if len(match) != 2 {
				continue
			}
			value, err := strconv.Atoi(string(match[1]))
			if err == nil && value > 0 {
				counts = append(counts, value)
			}
		}
	}
	if len(counts) == 0 {
		return 0
	}
	sort.Ints(counts)
	total := 0
	for _, value := range counts {
		total += value
	}
	largest := counts[len(counts)-1]
	rest := total - largest
	if rest == 0 || rest == largest {
		return largest
	}
	if rest > 0 && rest < largest {
		return total
	}
	return largest
}

func parsePDFInfoDictionary(data []byte) map[string]string {
	result := make(map[string]string)
	infoMatch := pdfInfoObjectPattern.FindSubmatch(data)
	if len(infoMatch) != 3 {
		return result
	}
	objectID := string(infoMatch[1])
	generation := string(infoMatch[2])
	objects := pdfObjectPattern.FindAllSubmatch(data, -1)
	for _, object := range objects {
		if len(object) != 4 || string(object[1]) != objectID || string(object[2]) != generation {
			continue
		}
		dictionary := object[3]
		fields := map[string]string{
			"Title": "Title", "Author": "Author", "Subject": "Subject", "Keywords": "Keywords",
			"Creator": "Creator", "Producer": "Producer", "CreationDate": "Created", "ModDate": "Modified",
		}
		for raw, label := range fields {
			if value := parsePDFLiteralField(dictionary, raw); value != "" {
				result[label] = value
			}
		}
		return result
	}
	return result
}

func parsePDFLiteralField(dictionary []byte, name string) string {
	marker := []byte("/" + name)
	idx := bytes.Index(dictionary, marker)
	if idx < 0 {
		return ""
	}
	cursor := idx + len(marker)
	for cursor < len(dictionary) && (dictionary[cursor] == ' ' || dictionary[cursor] == '\t' || dictionary[cursor] == '\r' || dictionary[cursor] == '\n') {
		cursor++
	}
	if cursor >= len(dictionary) || dictionary[cursor] != '(' {
		return ""
	}
	cursor++
	var out []byte
	escaped := false
	for cursor < len(dictionary) {
		b := dictionary[cursor]
		cursor++
		if escaped {
			switch b {
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			default:
				out = append(out, b)
			}
			escaped = false
			continue
		}
		if b == '\\' {
			escaped = true
			continue
		}
		if b == ')' {
			break
		}
		out = append(out, b)
	}
	return strings.TrimSpace(string(out))
}

func inspectZipArchiveMetadata(ctx context.Context, instance *storageInstance, key, extension string, listed mediaSourceMetadata) (structuredMetadataSummary, error) {
	source, err := openStructuredRangeSource(ctx, instance, key, listed)
	if err != nil {
		return structuredMetadataSummary{}, err
	}
	if source.Size() <= 0 {
		if _, err := source.ReadSuffix(64 << 10); err != nil && err != io.EOF {
			return structuredMetadataSummary{}, err
		}
	}
	if source.Size() <= 0 {
		return headOnlyStructuredSummary(ctx, instance, key, archiveContainerLabel(extension))
	}
	reader, err := openRemoteZIPReader(source, extension)
	if err != nil {
		return structuredSummaryFromSource(archiveContainerLabel(extension), nil, source), nil
	}
	props := zipArchiveProperties(reader)
	for label, value := range inspectArchivePackageMetadata(reader, extension) {
		if strings.TrimSpace(value) != "" {
			props[label] = value
		}
	}
	if extension == "epub" {
		if epub := inspectEPUBPreview(reader); epub != nil {
			for label, value := range map[string]string{
				"Title":                     epub.Title,
				"Authors":                   strings.Join(epub.Creators, ", "),
				"Language":                  epub.Language,
				"Identifier":                epub.Identifier,
				"Publisher":                 epub.Publisher,
				"Publication date":          epub.Date,
				"Rights":                    epub.Rights,
				"Subjects":                  strings.Join(epub.Subjects, ", "),
				"Table of contents entries": formatInteger(int64(len(epub.TOC))),
			} {
				if strings.TrimSpace(value) != "" && value != "0" {
					props[label] = value
				}
			}
		}
	}
	return structuredSummaryFromSource(archiveContainerLabel(extension), props, source), nil
}

func archiveContainerLabel(extension string) string {
	switch extension {
	case "jar":
		return "Java archive"
	case "war":
		return "Java web archive"
	case "ear":
		return "Java enterprise archive"
	case "apk":
		return "Android package"
	case "aar":
		return "Android library archive"
	case "crx":
		return "Chrome extension"
	case "epub":
		return "EPUB"
	case "xpi":
		return "Firefox extension"
	case "vsix":
		return "VSIX package"
	default:
		return "ZIP archive"
	}
}

func zipArchiveProperties(reader *zip.Reader) map[string]string {
	props := make(map[string]string)
	var files, dirs int64
	var compressed, uncompressed uint64
	methods := make(map[uint16]int)
	encrypted := false
	zip64 := false
	for _, file := range reader.File {
		name := strings.TrimSpace(file.Name)
		if strings.HasSuffix(name, "/") {
			dirs++
		} else {
			files++
		}
		compressed += file.CompressedSize64
		uncompressed += file.UncompressedSize64
		methods[file.Method]++
		if file.Flags&0x1 != 0 {
			encrypted = true
		}
		if file.CompressedSize64 >= 0xffffffff || file.UncompressedSize64 >= 0xffffffff {
			zip64 = true
		}
	}
	props["Entries"] = formatInteger(int64(len(reader.File)))
	props["Files"] = formatInteger(files)
	props["Folders"] = formatInteger(dirs)
	props["Compressed size"] = formatInteger(int64(compressed))
	props["Uncompressed size"] = formatInteger(int64(uncompressed))
	if compressed > 0 && uncompressed > compressed {
		props["Compression ratio"] = fmt.Sprintf("%.1f%%", (1-float64(compressed)/float64(uncompressed))*100)
	}
	if encrypted {
		props["Encrypted entries"] = "Yes"
	}
	if zip64 {
		props["ZIP64"] = "Yes"
	}
	methodLabels := make([]string, 0, len(methods))
	for method, count := range methods {
		methodLabels = append(methodLabels, fmt.Sprintf("%s (%d)", zipCompressionMethodLabel(method), count))
	}
	sort.Strings(methodLabels)
	if len(methodLabels) > 0 {
		props["Compression methods"] = strings.Join(methodLabels, ", ")
	}
	return props
}

func zipCompressionMethodLabel(method uint16) string {
	switch method {
	case zip.Store:
		return "Stored"
	case zip.Deflate:
		return "Deflate"
	case 12:
		return "BZIP2"
	case 14:
		return "LZMA"
	case 93:
		return "Zstandard"
	case 99:
		return "AES"
	default:
		return fmt.Sprintf("Method %d", method)
	}
}

func inspectSmallTextStructuredMetadata(ctx context.Context, instance *storageInstance, key string, listed mediaSourceMetadata, container string, parser func([]byte) map[string]string) (structuredMetadataSummary, error) {
	source, err := openStructuredRangeSource(ctx, instance, key, listed)
	if err != nil {
		return structuredMetadataSummary{}, err
	}
	if source.Size() <= 0 {
		if _, err := source.ReadSuffix(64 << 10); err != nil && err != io.EOF {
			return structuredMetadataSummary{}, err
		}
	}
	if source.Size() <= 0 || source.Size() > maxSmallStructuredMetadataBytes {
		return headOnlyStructuredSummary(ctx, instance, key, container)
	}
	data, err := source.ReadRange(0, source.Size())
	if err != nil && err != io.EOF {
		return structuredMetadataSummary{}, err
	}
	return structuredSummaryFromSource(container, parser(data), source), nil
}

func contactContainerLabel(extension string) string {
	return "vCard contact"
}

func calendarContainerLabel(extension string) string {
	if extension == "ifb" {
		return "iCalendar free/busy"
	}
	return "iCalendar"
}

func emailContainerLabel(extension string) string {
	if extension == "mhtml" || extension == "mht" {
		return "MHTML email archive"
	}
	return "Email message"
}

func parseVCardMetadata(data []byte) map[string]string {
	cards := splitICalBlocks(unfoldStructuredLines(string(data)), "BEGIN:VCARD", "END:VCARD")
	props := make(map[string]string)
	if len(cards) == 0 {
		return props
	}
	props["Contacts"] = formatInteger(int64(len(cards)))
	first := cards[0]
	setFirstStructuredValue(props, first, "FN", "Name")
	setFirstStructuredValue(props, first, "N", "Structured name")
	setFirstStructuredValue(props, first, "ORG", "Organization")
	setFirstStructuredValue(props, first, "TITLE", "Title")
	setFirstStructuredValue(props, first, "EMAIL", "Email")
	setFirstStructuredValue(props, first, "TEL", "Phone")
	setFirstStructuredValue(props, first, "URL", "URL")
	setFirstStructuredValue(props, first, "VERSION", "Version")
	return props
}

func parseICalendarMetadata(data []byte) map[string]string {
	lines := unfoldStructuredLines(string(data))
	props := make(map[string]string)
	setFirstStructuredValue(props, lines, "VERSION", "Version")
	setFirstStructuredValue(props, lines, "PRODID", "Product")
	setFirstStructuredValue(props, lines, "CALSCALE", "Calendar scale")
	setFirstStructuredValue(props, lines, "METHOD", "Method")
	setFirstStructuredValue(props, lines, "X-WR-CALNAME", "Calendar name")
	setFirstStructuredValue(props, lines, "X-WR-TIMEZONE", "Timezone")
	count := func(begin string) int {
		total := 0
		for _, line := range lines {
			if strings.EqualFold(strings.TrimSpace(line), begin) {
				total++
			}
		}
		return total
	}
	if events := count("BEGIN:VEVENT"); events > 0 {
		props["Events"] = formatInteger(int64(events))
	}
	if todos := count("BEGIN:VTODO"); todos > 0 {
		props["Todos"] = formatInteger(int64(todos))
	}
	if journals := count("BEGIN:VJOURNAL"); journals > 0 {
		props["Journals"] = formatInteger(int64(journals))
	}
	if zones := count("BEGIN:VTIMEZONE"); zones > 0 {
		props["Timezones"] = formatInteger(int64(zones))
	}
	if events := splitICalBlocks(lines, "BEGIN:VEVENT", "END:VEVENT"); len(events) > 0 {
		setFirstStructuredValue(props, events[0], "SUMMARY", "First event")
		setFirstStructuredValue(props, events[0], "DTSTART", "First start")
		setFirstStructuredValue(props, events[0], "DTEND", "First end")
	}
	return props
}

func unfoldStructuredLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	raw := strings.Split(text, "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		if line == "" {
			continue
		}
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && len(lines) > 0 {
			lines[len(lines)-1] += strings.TrimLeft(line, " \t")
			continue
		}
		lines = append(lines, strings.TrimRight(line, "\n"))
	}
	return lines
}

func splitICalBlocks(lines []string, begin, end string) [][]string {
	var blocks [][]string
	var current []string
	inside := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.EqualFold(trimmed, begin) {
			inside = true
			current = []string{line}
			continue
		}
		if inside {
			current = append(current, line)
			if strings.EqualFold(trimmed, end) {
				blocks = append(blocks, current)
				inside = false
				current = nil
			}
		}
	}
	return blocks
}

func structuredPropertyName(line string) string {
	prefix := line
	if idx := strings.IndexByte(prefix, ':'); idx >= 0 {
		prefix = prefix[:idx]
	}
	if idx := strings.IndexByte(prefix, ';'); idx >= 0 {
		prefix = prefix[:idx]
	}
	return strings.ToUpper(strings.TrimSpace(prefix))
}

func structuredPropertyValue(line string) string {
	idx := strings.IndexByte(line, ':')
	if idx < 0 || idx+1 >= len(line) {
		return ""
	}
	return strings.TrimSpace(strings.ReplaceAll(line[idx+1:], "\\n", " "))
}

func setFirstStructuredValue(props map[string]string, lines []string, property, label string) {
	property = strings.ToUpper(property)
	for _, line := range lines {
		if structuredPropertyName(line) != property {
			continue
		}
		if value := structuredPropertyValue(line); value != "" {
			props[label] = value
			return
		}
	}
}

func inspectEmailHeaderMetadata(ctx context.Context, instance *storageInstance, key string, listed mediaSourceMetadata, container string) (structuredMetadataSummary, error) {
	source, err := openStructuredRangeSource(ctx, instance, key, listed)
	if err != nil {
		return structuredMetadataSummary{}, err
	}
	data, err := source.ReadRange(0, metadataRangeLength(source, 0, maxSmallStructuredMetadataBytes))
	if err != nil && err != io.EOF {
		return structuredMetadataSummary{}, err
	}
	headers, complete := parseEmailHeaders(data)
	if !complete {
		return structuredSummaryFromSource(container, nil, source), nil
	}
	return structuredSummaryFromSource(container, emailProperties(headers), source), nil
}

func parseEmailHeaders(data []byte) (map[string]string, bool) {
	boundary := bytes.Index(data, []byte("\r\n\r\n"))
	separatorLen := 4
	if boundary < 0 {
		boundary = bytes.Index(data, []byte("\n\n"))
		separatorLen = 2
	}
	if boundary < 0 {
		return nil, false
	}
	_ = separatorLen
	text := string(data[:boundary])
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	headers := make(map[string]string)
	current := ""
	for _, line := range lines {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			if current != "" {
				headers[current] += " " + strings.TrimSpace(line)
			}
			continue
		}
		idx := strings.IndexByte(line, ':')
		if idx <= 0 {
			continue
		}
		current = strings.ToLower(strings.TrimSpace(line[:idx]))
		if _, exists := headers[current]; !exists {
			headers[current] = strings.TrimSpace(line[idx+1:])
		}
	}
	return headers, true
}

func emailProperties(headers map[string]string) map[string]string {
	props := make(map[string]string)
	fields := []struct{ key, label string }{
		{"from", "From"}, {"to", "To"}, {"cc", "Cc"}, {"bcc", "Bcc"}, {"subject", "Subject"},
		{"date", "Date"}, {"message-id", "Message ID"}, {"reply-to", "Reply-To"}, {"content-type", "MIME type"},
		{"mime-version", "MIME version"}, {"user-agent", "User agent"}, {"x-mailer", "Mailer"},
	}
	for _, field := range fields {
		if value := strings.TrimSpace(headers[field.key]); value != "" {
			props[field.label] = value
		}
	}
	return props
}

func inspectCertificateMetadata(ctx context.Context, instance *storageInstance, key, extension, contentType string, listed mediaSourceMetadata) (structuredMetadataSummary, error) {
	source, err := openStructuredRangeSource(ctx, instance, key, listed)
	if err != nil {
		return structuredMetadataSummary{}, err
	}
	if source.Size() <= 0 {
		if _, err := source.ReadSuffix(64 << 10); err != nil && err != io.EOF {
			return structuredMetadataSummary{}, err
		}
	}
	container := certificateContainerLabel(extension, contentType)
	if source.Size() <= 0 || source.Size() > maxSmallStructuredMetadataBytes {
		return headOnlyStructuredSummary(ctx, instance, key, container)
	}
	data, err := source.ReadRange(0, source.Size())
	if err != nil && err != io.EOF {
		return structuredMetadataSummary{}, err
	}
	return structuredSummaryFromSource(container, parseCertificateProperties(data, extension), source), nil
}

func certificateContainerLabel(extension, contentType string) string {
	switch extension {
	case "csr", "req":
		return "Certificate signing request"
	case "p7b", "p7c", "spc":
		return "PKCS#7 certificate bundle"
	case "pfx", "p12":
		return "PKCS#12 bundle"
	case "key":
		return "PEM private key"
	case "pub":
		return "Public key"
	case "der":
		return "DER certificate"
	default:
		return "PEM certificate"
	}
}

func parseCertificateProperties(data []byte, extension string) map[string]string {
	props := make(map[string]string)
	pemBlocks := parsePEMBlocks(data)
	if len(pemBlocks) > 0 {
		props["PEM blocks"] = formatInteger(int64(len(pemBlocks)))
		for _, block := range pemBlocks {
			mergeCertificateBlockProperties(props, block.Type, block.Bytes)
			if len(props) > 1 {
				return props
			}
		}
		return props
	}
	if extension == "csr" || extension == "req" {
		mergeCertificateBlockProperties(props, "CERTIFICATE REQUEST", data)
	} else {
		mergeCertificateBlockProperties(props, "CERTIFICATE", data)
	}
	return props
}

func parsePEMBlocks(data []byte) []*pem.Block {
	var blocks []*pem.Block
	rest := data
	for {
		block, remaining := pem.Decode(rest)
		if block == nil {
			return blocks
		}
		blocks = append(blocks, block)
		rest = remaining
	}
}

func mergeCertificateBlockProperties(props map[string]string, typ string, der []byte) {
	typ = strings.ToUpper(strings.TrimSpace(typ))
	if typ != "" {
		props["First block"] = typ
	}
	switch typ {
	case "CERTIFICATE":
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return
		}
		props["Subject"] = cert.Subject.String()
		props["Issuer"] = cert.Issuer.String()
		props["Serial number"] = cert.SerialNumber.String()
		props["Not before"] = cert.NotBefore.UTC().Format(time.RFC3339)
		props["Not after"] = cert.NotAfter.UTC().Format(time.RFC3339)
		props["Signature algorithm"] = cert.SignatureAlgorithm.String()
		props["Public key algorithm"] = cert.PublicKeyAlgorithm.String()
		if len(cert.DNSNames) > 0 {
			props["DNS names"] = strings.Join(cert.DNSNames, ", ")
		}
		if len(cert.EmailAddresses) > 0 {
			props["Email addresses"] = strings.Join(cert.EmailAddresses, ", ")
		}
		if len(cert.IPAddresses) > 0 {
			values := make([]string, 0, len(cert.IPAddresses))
			for _, ip := range cert.IPAddresses {
				values = append(values, ip.String())
			}
			props["IP addresses"] = strings.Join(values, ", ")
		}
		if cert.IsCA {
			props["Certificate authority"] = "Yes"
		}
	case "CERTIFICATE REQUEST", "NEW CERTIFICATE REQUEST":
		request, err := x509.ParseCertificateRequest(der)
		if err != nil {
			return
		}
		props["Subject"] = request.Subject.String()
		props["Signature algorithm"] = request.SignatureAlgorithm.String()
		props["Public key algorithm"] = publicKeyAlgorithmLabel(request.PublicKey)
		if len(request.DNSNames) > 0 {
			props["DNS names"] = strings.Join(request.DNSNames, ", ")
		}
	case "RSA PRIVATE KEY":
		if key, err := x509.ParsePKCS1PrivateKey(der); err == nil {
			props["Key algorithm"] = "RSA"
			props["Key bits"] = strconv.Itoa(key.N.BitLen())
		}
	case "PRIVATE KEY", "ENCRYPTED PRIVATE KEY":
		if key, err := x509.ParsePKCS8PrivateKey(der); err == nil {
			props["Key algorithm"] = publicKeyAlgorithmLabel(key)
		}
	case "PUBLIC KEY":
		if key, err := x509.ParsePKIXPublicKey(der); err == nil {
			props["Public key algorithm"] = publicKeyAlgorithmLabel(key)
		}
	case "EC PRIVATE KEY":
		if key, err := x509.ParseECPrivateKey(der); err == nil {
			props["Key algorithm"] = "ECDSA"
			props["Curve"] = key.Curve.Params().Name
		}
	default:
		if _, err := asn1.Unmarshal(der, &asn1.RawValue{}); err == nil {
			props["ASN.1 DER"] = "Yes"
		}
	}
}

func publicKeyAlgorithmLabel(key any) string {
	switch k := key.(type) {
	case *rsa.PublicKey:
		return fmt.Sprintf("RSA (%d bits)", k.N.BitLen())
	case *rsa.PrivateKey:
		return fmt.Sprintf("RSA (%d bits)", k.N.BitLen())
	case *ecdsa.PublicKey:
		return "ECDSA " + k.Curve.Params().Name
	case *ecdsa.PrivateKey:
		return "ECDSA " + k.Curve.Params().Name
	case ed25519.PublicKey, ed25519.PrivateKey:
		return "Ed25519"
	default:
		return fmt.Sprintf("%T", key)
	}
}

func safePathBase(value string) string {
	return path.Base(strings.TrimSpace(value))
}
