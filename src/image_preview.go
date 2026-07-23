package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	maxEmbeddedImagePreviewBytes = int64(128 << 20)
	maxConvertedImageBytes       = int64(512 << 20)
)

func (a *application) handleImagePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
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
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "image key cannot be empty"})
		return
	}
	extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(key), "."))

	// RAW/TIFF containers often carry a camera-generated JPEG preview. Reading
	// the format header and then returning that existing byte range is cheaper
	// than downloading and decoding the complete RAW object.
	if extension == "raf" || isTIFFBasedImage(extension, "") {
		source, sourceErr := openObjectRangeSource(r.Context(), instance, key)
		if sourceErr == nil {
			if extension == "raf" {
				header, headerErr := source.ReadRange(0, 128)
				if (headerErr == nil || errors.Is(headerErr, io.EOF)) && source.size > 0 {
					if offset, length, ok := rafPreviewRange(header); ok && embeddedPreviewFitsObject(offset, length, source.size) {
						a.serveEmbeddedImageRange(w, r, instance, key, offset, length)
						return
					}
				}
			} else if header, valid, headerErr := readAdaptiveTIFFHeader(source); headerErr == nil && valid && source.size > 0 {
				if offset, length, ok := embeddedTIFFJPEGRange(header); ok && embeddedPreviewFitsObject(offset, length, source.size) {
					a.serveEmbeddedImageRange(w, r, instance, key, offset, length)
					return
				}
			}
		}
	}

	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "no-store")
		applyObjectSafetyHeaders(w.Header())
		w.WriteHeader(http.StatusOK)
		return
	}

	previewPath, cleanup, err := a.convertImagePreview(r.Context(), instance, key, extension)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	defer cleanup()
	serveLocalPreviewFile(w, r, previewPath, "image/jpeg")
}

func embeddedPreviewFitsObject(offset, length, objectSize int64) bool {
	return offset >= 0 && length > 0 && length <= maxEmbeddedImagePreviewBytes && objectSize > 0 && offset <= objectSize && length <= objectSize-offset
}

func (a *application) serveEmbeddedImageRange(w http.ResponseWriter, r *http.Request, instance *storageInstance, key string, offset, length int64) {
	if offset < 0 || length <= 0 || length > maxEmbeddedImagePreviewBytes {
		writeAPIError(w, apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_embedded_preview", Message: "the embedded image preview range is invalid"})
		return
	}
	headers := make(http.Header)
	headers.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+length-1))
	object, err := instance.backend.Get(r.Context(), instance.fullKey(key), headers)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if object.Body == nil {
		writeAPIError(w, apiError{Status: http.StatusBadGateway, Code: "empty_image_preview", Message: "the storage provider returned an empty image preview"})
		return
	}
	defer object.Body.Close()
	if !isSuccessfulObjectReadStatus(object.StatusCode) {
		writeAPIError(w, &upstreamError{StatusCode: object.StatusCode, Code: "ImagePreviewReadFailed"})
		return
	}
	contentRange := strings.TrimSpace(object.Header.Get("Content-Range"))
	contentLength, contentLengthErr := strconv.ParseInt(strings.TrimSpace(object.Header.Get("Content-Length")), 10, 64)
	if object.StatusCode == http.StatusPartialContent && contentRange == "" {
		writeAPIError(w, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider omitted Content-Range for the embedded image preview"})
		return
	}
	if object.StatusCode == http.StatusOK && contentRange == "" {
		// Do not accept a provider that silently turns a small embedded-preview
		// Range into a complete RAW download. That would make a right-sized
		// preview unexpectedly expensive on object storage.
		if offset != 0 || contentLengthErr != nil || contentLength != length {
			writeAPIError(w, apiError{Status: http.StatusBadGateway, Code: "range_not_supported", Message: "the storage provider ignored the embedded image preview range"})
			return
		}
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.Header().Set("Cache-Control", "no-store")
	applyObjectSafetyHeaders(w.Header())
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.CopyN(w, object.Body, length)
}

func embeddedTIFFJPEGRange(data []byte) (int64, int64, bool) {
	reader, firstIFD, ok := newTIFFReader(data)
	if !ok {
		return 0, 0, false
	}
	visited := make(map[uint64]struct{})
	var inspect func(uint64, int) (int64, int64, bool)
	inspect = func(offset uint64, depth int) (int64, int64, bool) {
		if depth > 5 {
			return 0, 0, false
		}
		if _, exists := visited[offset]; exists {
			return 0, 0, false
		}
		visited[offset] = struct{}{}
		tags := reader.readIFD(offset)
		jpegOffset := int64(reader.asUint(tags[0x0201]))
		jpegLength := int64(reader.asUint(tags[0x0202]))
		if jpegOffset >= 0 && jpegLength > 0 {
			return jpegOffset, jpegLength, true
		}
		for _, tag := range []uint16{0x014a, 0x8769} {
			if child := reader.asUint(tags[tag]); child > 0 {
				if foundOffset, foundLength, found := inspect(child, depth+1); found {
					return foundOffset, foundLength, true
				}
			}
		}
		return 0, 0, false
	}
	return inspect(firstIFD, 0)
}

// convertImagePreview performs one explicit, request-bound ImageMagick
// conversion. Temporary source and output files are removed as soon as the HTTP
// response completes or the client disconnects; nothing is retained for reuse.
func (a *application) convertImagePreview(ctx context.Context, instance *storageInstance, key, extension string) (string, func(), error) {
	a.imagePreviewMu.Lock()
	locked := true
	unlock := func() {
		if locked {
			locked = false
			a.imagePreviewMu.Unlock()
		}
	}

	converter, err := imageConverterPath()
	if err != nil {
		unlock()
		return "", func() {}, apiError{Status: http.StatusNotImplemented, Code: "image_converter_unavailable", Message: "this image format requires ImageMagick on the server"}
	}
	tempRoot := filepath.Join(a.config.DataDir, "image-preview-tmp")
	if err := os.MkdirAll(tempRoot, 0o700); err != nil {
		unlock()
		return "", func() {}, fmt.Errorf("create image preview temporary directory: %w", err)
	}
	directory, err := os.MkdirTemp(tempRoot, "request-*")
	if err != nil {
		unlock()
		return "", func() {}, fmt.Errorf("create image preview workspace: %w", err)
	}
	cleanup := func() {
		_ = os.RemoveAll(directory)
		unlock()
	}
	if extension == "" || len(extension) > 12 {
		extension = "raw"
	}
	sourcePath := filepath.Join(directory, "source."+extension)
	outputPath := filepath.Join(directory, "preview.jpg")

	object, err := instance.backend.Get(ctx, instance.fullKey(key), nil)
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	if object.Body == nil {
		cleanup()
		return "", func() {}, apiError{Status: http.StatusBadGateway, Code: "empty_image_source", Message: "the storage provider returned an empty image source"}
	}
	defer object.Body.Close()
	if !isSuccessfulObjectReadStatus(object.StatusCode) {
		cleanup()
		return "", func() {}, &upstreamError{StatusCode: object.StatusCode, Code: "ImagePreviewReadFailed"}
	}
	source, err := os.OpenFile(sourcePath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("create image preview source: %w", err)
	}
	written, copyErr := io.Copy(source, io.LimitReader(object.Body, maxConvertedImageBytes+1))
	closeErr := source.Close()
	if copyErr != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("read image source: %w", copyErr)
	}
	if closeErr != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("close image source: %w", closeErr)
	}
	if written > maxConvertedImageBytes {
		cleanup()
		return "", func() {}, apiError{Status: http.StatusRequestEntityTooLarge, Code: "image_preview_too_large", Message: fmt.Sprintf("image previews are limited to %d MiB", maxConvertedImageBytes>>20)}
	}

	convertCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	args := []string{sourcePath + "[0]", "-auto-orient", "-thumbnail", "4096x4096>", "-strip", "-quality", "88", "jpeg:" + outputPath}
	command := exec.CommandContext(convertCtx, converter, args...)
	command.Env = append(os.Environ(), "MAGICK_TMPDIR="+directory)
	configureProcessGroup(command)
	if err := runCommandWithContext(convertCtx, command); err != nil {
		cleanup()
		if errors.Is(convertCtx.Err(), context.DeadlineExceeded) {
			return "", func() {}, apiError{Status: http.StatusGatewayTimeout, Code: "image_preview_timeout", Message: "image preview conversion timed out"}
		}
		if errors.Is(convertCtx.Err(), context.Canceled) {
			return "", func() {}, apiError{Status: 499, Code: "image_preview_canceled", Message: "image preview conversion was canceled"}
		}
		return "", func() {}, apiError{Status: http.StatusUnprocessableEntity, Code: "image_preview_failed", Message: "the server could not decode this image format"}
	}
	if info, statErr := os.Stat(outputPath); statErr != nil || info.Size() == 0 {
		cleanup()
		return "", func() {}, apiError{Status: http.StatusUnprocessableEntity, Code: "image_preview_empty", Message: "the image converter did not produce a preview"}
	}
	if err := os.Chmod(outputPath, 0o600); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("secure image preview: %w", err)
	}
	return outputPath, cleanup, nil
}

func imageConverterPath() (string, error) {
	if path, err := exec.LookPath("magick"); err == nil {
		return path, nil
	}
	if path, err := exec.LookPath("convert"); err == nil {
		return path, nil
	}
	return "", exec.ErrNotFound
}

func serveLocalPreviewFile(w http.ResponseWriter, r *http.Request, filePath, contentType string) {
	file, err := os.Open(filePath)
	if err != nil {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "preview_not_found", Message: "the generated preview is not available"})
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeAPIError(w, err)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	applyObjectSafetyHeaders(w.Header())
	http.ServeContent(w, r, filepath.Base(filePath), info.ModTime(), file)
}
