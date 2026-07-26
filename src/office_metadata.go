package main

import (
	"archive/zip"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
)

const (
	maxOfficePropertiesXMLBytes = int64(1 << 20)
	maxOfficeCustomProperties   = 256
)

type officeOpenXMLFamily string

const (
	officeFamilyWord         officeOpenXMLFamily = "word"
	officeFamilySpreadsheet  officeOpenXMLFamily = "spreadsheet"
	officeFamilyPresentation officeOpenXMLFamily = "presentation"
	officeFamilyVisio        officeOpenXMLFamily = "visio"
)

// inspectOfficeOpenXMLProperties reads only the ZIP central directory and a
// bounded set of small package metadata parts. It never opens the main Word
// document, worksheet cell data, slide contents, or Visio page contents.
func inspectOfficeOpenXMLProperties(ctx context.Context, instance *storageInstance, key, extension string, listed mediaSourceMetadata, family officeOpenXMLFamily) (wordPropertiesSummary, error) {
	result := wordPropertiesSummary{
		Container:  officeOpenXMLContainerLabel(extension),
		Properties: make(map[string]string),
	}
	source, err := openObjectRangeSource(ctx, instance, key)
	if err != nil {
		return result, err
	}
	source.SetKnownSize(listed.Size)
	source.SetExpectedETag(listed.ETag)
	if source.Size() <= 0 {
		if _, err := source.ReadSuffix(64 << 10); err != nil && !errors.Is(err, io.EOF) {
			return result, err
		}
	}
	if source.Size() <= 0 {
		return result, apiError{Status: http.StatusUnprocessableEntity, Code: "unknown_office_size", Message: "Office document details require a known non-zero object size"}
	}
	if source.Size() > maxWordObjectBytes {
		return result, apiError{Status: http.StatusRequestEntityTooLarge, Code: "office_document_too_large", Message: fmt.Sprintf("Office document details are limited to objects smaller than %d GiB", maxWordObjectBytes>>30)}
	}

	remoteReader := &spreadsheetObjectReaderAt{source: source}
	reader, err := zip.NewReader(remoteReader, source.Size())
	if err != nil {
		if sourceErr := remoteReader.Error(); sourceErr != nil {
			return result, sourceErr
		}
		return result, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_office_package", Message: "the object is not a valid Office Open XML package"}
	}
	if len(reader.File) > maxWordArchiveFiles {
		return result, apiError{Status: http.StatusRequestEntityTooLarge, Code: "office_archive_too_large", Message: "the Office package contains too many archive members"}
	}

	files := make(map[string]*zip.File, len(reader.File))
	names := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		name := path.Clean(strings.TrimLeft(file.Name, "/"))
		files[name] = file
		names = append(names, name)
	}

	if core := files["docProps/core.xml"]; core != nil {
		if err := readWordPropertiesPart(core, result.Properties, wordCorePropertyLabels()); err != nil {
			return result, err
		}
	}
	if app := files["docProps/app.xml"]; app != nil {
		if err := readWordPropertiesPart(app, result.Properties, officeAppPropertyLabels()); err != nil {
			return result, err
		}
	}
	if custom := files["docProps/custom.xml"]; custom != nil {
		if err := readOfficeCustomProperties(custom, result.Properties); err != nil {
			return result, err
		}
	}
	addOfficePackageStructureProperties(result.Properties, names, family)

	if len(result.Properties) == 0 {
		result.Properties = nil
	}
	result.Headers = source.Headers()
	result.Size = source.Size()
	result.BytesRead = source.BytesRead()
	result.Requests = source.RequestCount()
	return result, nil
}

func officeOpenXMLContainerLabel(extension string) string {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case "docx":
		return "Microsoft Word Open XML"
	case "docm":
		return "Microsoft Word macro-enabled document"
	case "dotx":
		return "Microsoft Word template"
	case "dotm":
		return "Microsoft Word macro-enabled template"
	case "xlsx":
		return "Microsoft Excel workbook"
	case "xlsm":
		return "Microsoft Excel macro-enabled workbook"
	case "xltx":
		return "Microsoft Excel template"
	case "xltm":
		return "Microsoft Excel macro-enabled template"
	case "xlam":
		return "Microsoft Excel add-in"
	case "pptx":
		return "Microsoft PowerPoint presentation"
	case "pptm":
		return "Microsoft PowerPoint macro-enabled presentation"
	case "potx":
		return "Microsoft PowerPoint template"
	case "potm":
		return "Microsoft PowerPoint macro-enabled template"
	case "ppsx":
		return "Microsoft PowerPoint slide show"
	case "ppsm":
		return "Microsoft PowerPoint macro-enabled slide show"
	case "ppam":
		return "Microsoft PowerPoint add-in"
	case "sldx":
		return "Microsoft PowerPoint slide"
	case "sldm":
		return "Microsoft PowerPoint macro-enabled slide"
	case "vsdx":
		return "Microsoft Visio drawing"
	case "vsdm":
		return "Microsoft Visio macro-enabled drawing"
	case "vssx":
		return "Microsoft Visio stencil"
	case "vssm":
		return "Microsoft Visio macro-enabled stencil"
	case "vstx":
		return "Microsoft Visio template"
	case "vstm":
		return "Microsoft Visio macro-enabled template"
	default:
		return strings.ToUpper(strings.TrimSpace(extension))
	}
}

func officeAppPropertyLabels() map[string]string {
	return map[string]string{
		"Application":          "Application",
		"AppVersion":           "Application version",
		"Company":              "Company",
		"Manager":              "Manager",
		"Template":             "Template",
		"Pages":                "Pages",
		"Words":                "Words",
		"Characters":           "Characters",
		"CharactersWithSpaces": "Characters with spaces",
		"Paragraphs":           "Paragraphs",
		"Lines":                "Lines",
		"TotalTime":            "Editing time (minutes)",
		"DocSecurity":          "Document security",
		"ScaleCrop":            "Scale crop",
		"SharedDoc":            "Shared document",
		"HyperlinksChanged":    "Hyperlinks changed",
		"Slides":               "Slides",
		"HiddenSlides":         "Hidden slides",
		"Notes":                "Notes slides",
		"MMClips":              "Multimedia clips",
		"PresentationFormat":   "Presentation format",
	}
}

type officeCustomPropertyXML struct {
	Name string `xml:"name,attr"`
}

func readOfficeCustomProperties(file *zip.File, destination map[string]string) error {
	if file == nil {
		return nil
	}
	if file.UncompressedSize64 > uint64(maxOfficePropertiesXMLBytes) {
		return apiError{Status: http.StatusRequestEntityTooLarge, Code: "office_properties_too_large", Message: "the Office custom properties exceed the metadata limit"}
	}
	stream, err := file.Open()
	if err != nil {
		return apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_office_properties", Message: "the Office custom properties could not be opened"}
	}
	defer stream.Close()
	decoder := xml.NewDecoder(io.LimitReader(stream, maxOfficePropertiesXMLBytes+1))
	count := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_office_properties", Message: "the Office custom properties could not be parsed"}
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "property" {
			continue
		}
		if count >= maxOfficeCustomProperties {
			return nil
		}
		name := ""
		for _, attr := range start.Attr {
			if attr.Name.Local == "name" {
				name = strings.TrimSpace(attr.Value)
				break
			}
		}
		value, err := readOfficeCustomPropertyValue(decoder, start)
		if err != nil {
			return err
		}
		if name != "" && value != "" {
			label := "Custom - " + name
			if _, exists := destination[label]; !exists {
				destination[label] = value
				count++
			}
		}
	}
}

func readOfficeCustomPropertyValue(decoder *xml.Decoder, property xml.StartElement) (string, error) {
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_office_properties", Message: "the Office custom properties could not be parsed"}
		}
		switch value := token.(type) {
		case xml.StartElement:
			var text string
			if err := decoder.DecodeElement(&text, &value); err != nil {
				return "", apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_office_properties", Message: "the Office custom properties could not be parsed"}
			}
			text = strings.TrimSpace(text)
			if text != "" {
				return text, nil
			}
		case xml.EndElement:
			if value.Name.Local == property.Name.Local {
				return "", nil
			}
		}
	}
}

func addOfficePackageStructureProperties(properties map[string]string, names []string, family officeOpenXMLFamily) {
	counts := map[string]int64{}
	macros := false
	signed := false
	for _, name := range names {
		lower := strings.ToLower(name)
		if strings.HasSuffix(lower, "/vbaproject.bin") {
			macros = true
		}
		if strings.HasPrefix(lower, "_xmlsignatures/") {
			signed = true
		}
		switch family {
		case officeFamilyWord:
			countOfficePrefix(counts, lower, "word/media/", "Images")
			countOfficePrefix(counts, lower, "word/embeddings/", "Embedded objects")
			countOfficePrefix(counts, lower, "word/charts/", "Charts")
			countOfficeExactPart(counts, lower, "word/header", "Headers")
			countOfficeExactPart(counts, lower, "word/footer", "Footers")
			countOfficeExactName(counts, lower, "word/comments.xml", "Comments")
			countOfficeExactName(counts, lower, "word/footnotes.xml", "Footnotes")
			countOfficeExactName(counts, lower, "word/endnotes.xml", "Endnotes")
		case officeFamilySpreadsheet:
			countOfficeNumberedPart(counts, lower, "xl/worksheets/sheet", "Worksheets")
			countOfficePrefix(counts, lower, "xl/media/", "Images")
			countOfficePrefix(counts, lower, "xl/embeddings/", "Embedded objects")
			countOfficeNumberedPart(counts, lower, "xl/charts/chart", "Charts")
			countOfficeNumberedPart(counts, lower, "xl/pivottables/pivottable", "Pivot tables")
			countOfficePrefix(counts, lower, "xl/externallinks/", "External links")
			countOfficePrefix(counts, lower, "xl/comments", "Comment parts")
			countOfficeExactName(counts, lower, "xl/connections.xml", "Data connections")
		case officeFamilyPresentation:
			countOfficeNumberedPart(counts, lower, "ppt/slides/slide", "Slides")
			countOfficeNumberedPart(counts, lower, "ppt/notesslides/notesslide", "Notes slides")
			countOfficeNumberedPart(counts, lower, "ppt/comments/comment", "Comment parts")
			countOfficePrefix(counts, lower, "ppt/media/", "Media files")
			countOfficePrefix(counts, lower, "ppt/embeddings/", "Embedded objects")
			countOfficeNumberedPart(counts, lower, "ppt/charts/chart", "Charts")
			countOfficeNumberedPart(counts, lower, "ppt/slidemasters/slidemaster", "Slide masters")
			countOfficeNumberedPart(counts, lower, "ppt/slidelayouts/slidelayout", "Slide layouts")
			countOfficePrefix(counts, lower, "ppt/theme/", "Themes")
		case officeFamilyVisio:
			countOfficeNumberedPart(counts, lower, "visio/pages/page", "Pages")
			countOfficeNumberedPart(counts, lower, "visio/masters/master", "Masters")
			countOfficePrefix(counts, lower, "visio/media/", "Media files")
			countOfficePrefix(counts, lower, "visio/embeddings/", "Embedded objects")
			countOfficePrefix(counts, lower, "visio/theme/", "Themes")
		}
	}
	for label, count := range counts {
		if count <= 0 {
			continue
		}
		if existing, ok := properties[label]; ok {
			if parsed, err := strconv.ParseInt(strings.ReplaceAll(existing, ",", ""), 10, 64); err == nil && parsed > 0 {
				continue
			}
		}
		properties[label] = formatInteger(count)
	}
	if macros {
		properties["Macros"] = "Yes"
	}
	if signed {
		properties["Digital signatures"] = "Yes"
	}
}

func countOfficePrefix(counts map[string]int64, name, prefix, label string) {
	if strings.HasPrefix(name, prefix) && !strings.HasSuffix(name, "/") {
		counts[label]++
	}
}

func countOfficeExactName(counts map[string]int64, name, expected, label string) {
	if name == expected {
		counts[label]++
	}
}

func countOfficeExactPart(counts map[string]int64, name, prefix, label string) {
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".xml") || strings.Contains(name, "/_rels/") {
		return
	}
	suffix := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".xml")
	if _, err := strconv.ParseInt(suffix, 10, 64); err == nil {
		counts[label]++
	}
}

func countOfficeNumberedPart(counts map[string]int64, name, prefix, label string) {
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".xml") || strings.Contains(name, "/_rels/") {
		return
	}
	suffix := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".xml")
	if suffix == "" {
		return
	}
	if _, err := strconv.ParseInt(suffix, 10, 64); err == nil {
		counts[label]++
	}
}

func mergeOfficeProperties(destination map[string]string, source map[string]string) map[string]string {
	if destination == nil {
		destination = make(map[string]string)
	}
	for key, value := range source {
		if strings.TrimSpace(value) == "" {
			continue
		}
		if _, exists := destination[key]; !exists {
			destination[key] = value
		}
	}
	return destination
}

func isWordOpenXMLExtension(extension string) bool {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case "docx", "docm", "dotx", "dotm":
		return true
	default:
		return false
	}
}

func isSpreadsheetOpenXMLExtension(extension string) bool {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case "xlsx", "xlsm", "xltx", "xltm", "xlam":
		return true
	default:
		return false
	}
}

func isPresentationOpenXMLExtension(extension string) bool {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case "pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "ppam", "sldx", "sldm":
		return true
	default:
		return false
	}
}

func isVisioOpenXMLExtension(extension string) bool {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case "vsdx", "vsdm", "vssx", "vssm", "vstx", "vstm":
		return true
	default:
		return false
	}
}
