package main

import (
	"archive/zip"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	archiveStatusTrailer  = "X-S3-Browser-Archive-Status"
	archiveEntriesTrailer = "X-S3-Browser-Archive-Entries"
	archiveBytesTrailer   = "X-S3-Browser-Archive-Bytes"
)

func (a *application) handleArchive(w http.ResponseWriter, r *http.Request) {
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
	prefix := normalizePrefix(cleanRelativeKey(r.URL.Query().Get("prefix")))
	page, err := instance.List(r.Context(), listOptions{
		Prefix: instance.fullKey(prefix), MaxResults: 1000,
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if len(page.Objects) == 0 && page.NextPageToken == "" {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "empty_prefix", Message: "the selected prefix contains no objects"})
		return
	}

	filename := archiveFilename(r.URL.Query().Get("name"), prefix, instance.cfg.Name)
	w.Header().Set("Content-Type", "application/zip")
	if value := mime.FormatMediaType("attachment", map[string]string{"filename": filename}); value != "" {
		w.Header().Set("Content-Disposition", value)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Add("Trailer", archiveStatusTrailer)
	w.Header().Add("Trailer", archiveEntriesTrailer)
	w.Header().Add("Trailer", archiveBytesTrailer)
	w.WriteHeader(http.StatusOK)

	writer := zip.NewWriter(w)
	buffer := make([]byte, 128<<10)
	seen := make(map[string]int)
	entries := 0
	var writtenBytes int64
	archiveErr := error(nil)
	pageToken := ""
	current := page

	for {
		for _, object := range current.Objects {
			if err := r.Context().Err(); err != nil {
				archiveErr = err
				break
			}
			relative, ok := instance.relativeKey(object.Key)
			if !ok || !strings.HasPrefix(relative, prefix) {
				continue
			}
			name, ok := safeArchiveEntryName(strings.TrimPrefix(relative, prefix))
			if !ok {
				continue
			}
			name = uniqueArchiveEntryName(name, seen)
			entries++
			if entries > a.config.Runtime.MaxArchiveEntries {
				archiveErr = apiError{Status: http.StatusRequestEntityTooLarge, Code: "archive_entry_limit", Message: fmt.Sprintf("the archive exceeds the configured limit of %d entries", a.config.Runtime.MaxArchiveEntries)}
				break
			}
			if err := writeArchiveObject(r, writer, buffer, instance, object, name, &writtenBytes); err != nil {
				archiveErr = err
				break
			}
		}
		if archiveErr != nil || current.NextPageToken == "" {
			break
		}
		if current.NextPageToken == pageToken {
			archiveErr = apiError{Status: http.StatusBadGateway, Code: "invalid_continuation_token", Message: "the storage provider returned the same continuation token twice"}
			break
		}
		pageToken = current.NextPageToken
		current, err = instance.List(r.Context(), listOptions{
			Prefix: instance.fullKey(prefix), MaxResults: 1000, PageToken: pageToken,
		})
		if err != nil {
			archiveErr = err
			break
		}
	}

	if archiveErr != nil && r.Context().Err() == nil {
		_ = writeArchiveErrorEntry(writer, archiveErr, entries, writtenBytes)
	}
	closeErr := writer.Close()
	if archiveErr == nil {
		archiveErr = closeErr
	}
	status := "complete"
	if archiveErr != nil {
		status = "incomplete"
	}
	w.Header().Set(archiveStatusTrailer, status)
	w.Header().Set(archiveEntriesTrailer, strconv.Itoa(entries))
	w.Header().Set(archiveBytesTrailer, strconv.FormatInt(writtenBytes, 10))
}

func writeArchiveObject(r *http.Request, writer *zip.Writer, buffer []byte, instance *storageInstance, object objectInfo, name string, writtenBytes *int64) error {
	header := &zip.FileHeader{Name: name, Method: zip.Store}
	header.SetMode(0o600)
	if strings.HasSuffix(name, "/") {
		header.SetMode(0o755 | 0o040000)
	}
	if !object.LastModified.IsZero() {
		header.Modified = object.LastModified.UTC()
	}
	if strings.HasSuffix(name, "/") && object.Size == 0 {
		_, err := writer.CreateHeader(header)
		return err
	}
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("create archive entry: %w", err)
	}
	response, err := instance.Get(r.Context(), object.Key, nil)
	if err != nil {
		return err
	}
	if response.Body == nil {
		return apiError{Status: http.StatusBadGateway, Code: "empty_object_response", Message: "the storage provider returned an empty object body while creating the archive"}
	}
	defer response.Body.Close()
	if !isSuccessfulObjectReadStatus(response.StatusCode) {
		return &upstreamError{StatusCode: response.StatusCode, Code: "ArchiveObjectReadFailed"}
	}
	count, err := io.CopyBuffer(entry, response.Body, buffer)
	*writtenBytes += count
	if err != nil {
		return fmt.Errorf("stream archive object: %w", err)
	}
	if object.Size >= 0 && count != object.Size {
		return apiError{Status: http.StatusBadGateway, Code: "object_size_changed", Message: "an object changed size while the archive was being streamed"}
	}
	return nil
}

func safeArchiveEntryName(value string) (string, bool) {
	if value == "" || strings.ContainsRune(value, '\x00') {
		return "", false
	}
	value = strings.ReplaceAll(value, "\\", "/")
	isDirectory := strings.HasSuffix(value, "/")
	parts := strings.Split(value, "/")
	cleanParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		if part == "." || part == ".." {
			return "", false
		}
		part = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return '_'
			}
			return r
		}, part)
		if len(cleanParts) == 0 && len(part) >= 2 && part[1] == ':' {
			part = "_" + part
		}
		cleanParts = append(cleanParts, part)
	}
	if len(cleanParts) == 0 {
		return "", false
	}
	name := path.Clean(strings.Join(cleanParts, "/"))
	if name == "." || name == "" || strings.HasPrefix(name, "../") || strings.HasPrefix(name, "/") {
		return "", false
	}
	if isDirectory {
		name += "/"
	}
	return name, true
}

func uniqueArchiveEntryName(name string, seen map[string]int) string {
	if seen[name] == 0 {
		seen[name] = 1
		return name
	}
	seen[name]++
	count := seen[name]
	directory := strings.HasSuffix(name, "/")
	base := strings.TrimSuffix(name, "/")
	extension := path.Ext(base)
	stem := strings.TrimSuffix(base, extension)
	candidate := fmt.Sprintf("%s~%d%s", stem, count, extension)
	if directory {
		candidate += "/"
	}
	for seen[candidate] != 0 {
		count++
		candidate = fmt.Sprintf("%s~%d%s", stem, count, extension)
		if directory {
			candidate += "/"
		}
	}
	seen[candidate] = 1
	return candidate
}

func archiveFilename(requested, prefix, instanceName string) string {
	name := strings.TrimSpace(requested)
	if name == "" {
		name = strings.TrimSuffix(prefix, "/")
		if slash := strings.LastIndex(name, "/"); slash >= 0 {
			name = name[slash+1:]
		}
	}
	if name == "" {
		name = strings.TrimSpace(instanceName)
	}
	if name == "" {
		name = "archive"
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune("/\\:*?\"<>|", r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if name == "" {
		name = "archive"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".zip") {
		name += ".zip"
	}
	if len(name) > 180 {
		name = name[:176] + ".zip"
	}
	return name
}

func writeArchiveErrorEntry(writer *zip.Writer, archiveErr error, entries int, bytes int64) error {
	header := &zip.FileHeader{Name: "__S3_BROWSER_ARCHIVE_INCOMPLETE.txt", Method: zip.Store, Modified: time.Now().UTC()}
	header.SetMode(0o600)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	message := fmt.Sprintf("This archive is incomplete.\n\nCompleted entries: %d\nObject bytes streamed: %d\nReason: %s\n", entries, bytes, publicArchiveError(archiveErr))
	_, err = io.WriteString(entry, message)
	return err
}

func publicArchiveError(err error) string {
	if err == nil {
		return "unknown error"
	}
	if api, ok := err.(apiError); ok {
		return api.Message
	}
	return publicStorageError(err)
}
