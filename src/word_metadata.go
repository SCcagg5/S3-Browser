package main

import (
	"archive/zip"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const maxWordPropertiesXMLBytes = int64(1 << 20)

type wordPropertiesSummary struct {
	Container  string
	Properties map[string]string
	Headers    http.Header
	Size       int64
	BytesRead  int64
	Requests   int
}

// inspectWordProperties reads only the DOCX ZIP central directory and the
// small docProps/core.xml and docProps/app.xml members. It deliberately does
// not open word/document.xml, so Details stays bounded even for very large
// document bodies.
func inspectWordProperties(ctx context.Context, instance *storageInstance, key, extension string, listed mediaSourceMetadata) (wordPropertiesSummary, error) {
	return inspectOfficeOpenXMLProperties(ctx, instance, key, extension, listed, officeFamilyWord)
}

func wordContainerLabel(extension string) string {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case "docm":
		return "Microsoft Word macro-enabled document"
	case "dotx":
		return "Microsoft Word template"
	case "dotm":
		return "Microsoft Word macro-enabled template"
	default:
		return "Microsoft Word Open XML"
	}
}

func wordCorePropertyLabels() map[string]string {
	return map[string]string{
		"title":          "Title",
		"subject":        "Subject",
		"creator":        "Author",
		"keywords":       "Keywords",
		"description":    "Description",
		"lastModifiedBy": "Last modified by",
		"revision":       "Revision",
		"created":        "Created",
		"modified":       "Modified",
		"category":       "Category",
		"contentStatus":  "Content status",
		"language":       "Language",
		"identifier":     "Identifier",
		"version":        "Version",
	}
}

func wordAppPropertyLabels() map[string]string {
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
	}
}

func readWordPropertiesPart(file *zip.File, destination map[string]string, labels map[string]string) error {
	if file == nil {
		return nil
	}
	if file.UncompressedSize64 > uint64(maxWordPropertiesXMLBytes) {
		return apiError{Status: http.StatusRequestEntityTooLarge, Code: "document_properties_too_large", Message: "the Word document properties exceed the preview limit"}
	}
	stream, err := file.Open()
	if err != nil {
		return apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_docx_properties", Message: "the Word document properties could not be opened"}
	}
	defer stream.Close()
	decoder := xml.NewDecoder(io.LimitReader(stream, maxWordPropertiesXMLBytes+1))
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_docx_properties", Message: "the Word document properties could not be parsed"}
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		label := labels[start.Name.Local]
		if label == "" {
			continue
		}
		var value string
		if err := decoder.DecodeElement(&value, &start); err != nil {
			return apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_docx_properties", Message: "the Word document properties could not be parsed"}
		}
		value = normalizeWordPropertyValue(start.Name.Local, value)
		if value != "" {
			destination[label] = value
		}
	}
}

func normalizeWordPropertyValue(name, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	switch name {
	case "Pages", "Words", "Characters", "CharactersWithSpaces", "Paragraphs", "Lines", "TotalTime", "Revision", "DocSecurity", "Slides", "HiddenSlides", "Notes", "MMClips":
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			return formatInteger(parsed)
		}
	}
	return value
}
