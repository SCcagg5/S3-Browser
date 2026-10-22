package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// The resumable uploads of a volume. An upload writes its chunks to a temporary file in the folder of the target: the
// name is volumeTempPrefix, a random part and, when it fits, the name of the target. The next chunk starts at the size
// of the temporary file, so a client can resume after a lost connection. The last chunk synchronizes the file and
// gives it the name of the target with one rename. The session of the upload (inside the sealed resume token) holds
// the temporary file and the key of the target.
//
// A temporary file that stays (a closed tab, a stopped server) is an incomplete upload: the window "Incomplete uploads"
// lists it with the date of its last write, and its abort removes it. The abort by age keeps a file younger than
// minimumMultipartAbortAge, and no abort touches a file that an upload of this process writes.

// volumeTempScanEntries is the largest number of entries that one page of the list of the incomplete uploads reads.
const volumeTempScanEntries = 20_000

// volumeSession is the session of a resumable upload: the path of the temporary file relative to the root, and the
// full key of the target. A NUL byte, which no key has, separates them.
type volumeSession struct {
	temporary string
	key       string
}

func (s volumeSession) String() string { return s.temporary + "\x00" + s.key }

func (b *volumeBackend) parseSession(value string) (volumeSession, string, error) {
	temporary, key, ok := strings.Cut(value, "\x00")
	invalid := apiError{Status: http.StatusBadRequest, Code: "invalid_resume_token", Message: "upload resume token does not match the configured storage"}
	if !ok || temporary == "" || filepath.IsAbs(temporary) {
		return volumeSession{}, "", invalid
	}
	if _, temporaryName := parseVolumeTempName(filepath.Base(temporary)); !temporaryName {
		return volumeSession{}, "", invalid
	}
	real := filepath.Join(b.root, temporary)
	if filepath.Clean(real) != real || !insideRoot(real, b.root) {
		return volumeSession{}, "", invalid
	}
	return volumeSession{temporary: temporary, key: key}, real, nil
}

// volumeSessionUploadID gives the id that the list of the incomplete uploads gives to the temporary file of a session:
// its name.
func volumeSessionUploadID(session string) string {
	temporary, _, _ := strings.Cut(session, "\x00")
	return filepath.Base(temporary)
}

// InitiateResumable makes the folders of the target and an empty temporary file in the folder of the target.
func (b *volumeBackend) InitiateResumable(_ context.Context, full string, _ int64, _ string) (string, error) {
	key, err := b.parse(full, true)
	if err != nil {
		return "", err
	}
	if key.folder || len(key.parts) == 0 {
		return "", invalidVolumeKey("an upload needs the key of a file")
	}
	target, err := b.writeTarget(key)
	if err != nil {
		return "", err
	}
	name, err := volumeTempName(filepath.Base(target))
	if err != nil {
		return "", err
	}
	real := filepath.Join(filepath.Dir(target), name)
	file, err := os.OpenFile(real, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return "", volumeError(err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(real)
		return "", volumeError(err)
	}
	relative, err := filepath.Rel(b.root, real)
	if err != nil {
		_ = os.Remove(real)
		return "", err
	}
	return volumeSession{temporary: relative, key: full}.String(), nil
}

// UploadResumableChunk writes one chunk at start. A temporary file longer than start (a chunk that a lost connection
// cut) is cut back to start. The last chunk gives the file the name of the target.
func (b *volumeBackend) UploadResumableChunk(ctx context.Context, value string, body io.Reader, start, size, total int64, _ string) (int64, bool, error) {
	if size <= 0 || start < 0 || total <= 0 || start+size > total {
		return start, false, fmt.Errorf("invalid volume upload range")
	}
	session, real, err := b.parseSession(value)
	if err != nil {
		return start, false, err
	}
	file, err := openTemporary(real)
	if err != nil {
		return start, false, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return start, false, volumeError(err)
	}
	if info.Size() < start {
		file.Close()
		return info.Size(), false, apiError{Status: http.StatusConflict, Code: "offset_mismatch", Message: fmt.Sprintf("upload must resume at byte %d", info.Size())}
	}
	if info.Size() > start {
		if err := file.Truncate(start); err != nil {
			file.Close()
			return start, false, volumeError(err)
		}
	}
	written, copyErr := io.Copy(io.NewOffsetWriter(file, start), io.LimitReader(volumeContextReader{ctx: ctx, reader: body}, size))
	syncErr := file.Sync()
	closeErr := file.Close()
	switch {
	case copyErr != nil:
		if ctx.Err() != nil {
			return start + written, false, ctx.Err()
		}
		return start + written, false, volumeError(copyErr)
	case written != size:
		return start + written, false, apiError{Status: http.StatusBadRequest, Code: "incomplete_body", Message: "the request has fewer bytes than its Content-Range"}
	case syncErr != nil:
		return start, false, volumeError(syncErr)
	case closeErr != nil:
		return start, false, volumeError(closeErr)
	}
	next := start + size
	if next < total {
		return next, false, nil
	}
	if err := b.finishUpload(session, real); err != nil {
		return next, false, err
	}
	return total, true, nil
}

// openTemporary opens a temporary file of an upload for a write. It must be a regular file, not a symbolic link.
func openTemporary(real string) (*os.File, error) {
	info, err := os.Lstat(real)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchUpload", Message: "the temporary file of the upload does not exist"}
	}
	if err != nil {
		return nil, volumeError(err)
	}
	if !info.Mode().IsRegular() {
		return nil, apiError{Status: http.StatusConflict, Code: "volume_not_file", Message: "the temporary file of the upload is not a regular file"}
	}
	file, err := os.OpenFile(real, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, volumeError(err)
	}
	return file, nil
}

// finishUpload gives the complete temporary file the name of the target.
func (b *volumeBackend) finishUpload(session volumeSession, real string) error {
	b.sizer.invalidate()
	key, err := b.parse(session.key, true)
	if err != nil {
		return err
	}
	target, err := b.writeTarget(key)
	if err != nil {
		return err
	}
	if err := commitTemporary(real, target, false); err != nil {
		return err
	}
	syncFolder(filepath.Dir(target))
	return nil
}

// QueryResumable gives the size of the temporary file. When the file is gone and the target has the size of the
// upload, the upload is complete.
func (b *volumeBackend) QueryResumable(_ context.Context, value string, total int64) (int64, bool, error) {
	session, real, err := b.parseSession(value)
	if err != nil {
		return 0, false, err
	}
	info, err := os.Lstat(real)
	if err == nil {
		return info.Size(), false, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return 0, false, volumeError(err)
	}
	if _, object, err := b.stat(session.key); err == nil && object.Size == total {
		return total, true, nil
	}
	return 0, false, &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchUpload", Message: "the temporary file of the upload does not exist"}
}

// AbortResumable removes the temporary file. A file that is gone is not an error.
func (b *volumeBackend) AbortResumable(_ context.Context, value string) error {
	_, real, err := b.parseSession(value)
	if err != nil {
		return err
	}
	if err := os.Remove(real); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return volumeError(err)
	}
	return nil
}

// --- Incomplete uploads ---------------------------------------------------------------------------------------------

// ListMultipartUploads lists the temporary files of the tree, in the order of the keys, after the key of the cursor.
// The key of an upload is the key of its target when the temporary name has it, else the key of the temporary file.
// The id is the temporary name. The date is the last write. One page reads at most volumeTempScanEntries entries: the
// next cursor then starts after the last entry that the page read.
func (b *volumeBackend) ListMultipartUploads(ctx context.Context, cursor multipartCursor, maximum int) (multipartUploadPage, error) {
	marker := ""
	if cursor.KeyMarker != "" {
		relative, err := b.relative(cursor.KeyMarker)
		if err != nil {
			return multipartUploadPage{}, err
		}
		marker = relative
	}
	if maximum <= 0 {
		maximum = multipartScanPageSize
	}
	page := multipartUploadPage{Uploads: []multipartUpload{}}
	visited := 0
	last := ""
	err := b.walkTemporary(ctx, b.root, "", marker, func(key string, temporary bool, info os.FileInfo) bool {
		if visited == volumeTempScanEntries || len(page.Uploads) == maximum {
			page.Truncated = true
			return false
		}
		visited++
		last = key
		if !temporary {
			return true
		}
		folderKey, name := "", key
		if slash := strings.LastIndexByte(key, '/'); slash >= 0 {
			folderKey, name = key[:slash+1], key[slash+1:]
		}
		shown := key
		if target, _ := parseVolumeTempName(name); target != "" {
			shown = folderKey + target
		}
		page.Uploads = append(page.Uploads, multipartUpload{Key: b.prefix + shown, UploadID: name, Initiated: info.ModTime().UTC()})
		return true
	})
	if err != nil {
		return multipartUploadPage{}, err
	}
	if page.Truncated {
		page.Next = multipartCursor{KeyMarker: b.prefix + last}
	}
	return page, nil
}

// walkTemporary gives each file of the tree after marker, in the order of the keys, with true for a temporary file of
// S3-Browser. It does not follow a symbolic link. It stops when visit gives false.
func (b *volumeBackend) walkTemporary(ctx context.Context, real, folderKey, marker string, visit func(string, bool, os.FileInfo) bool) error {
	_, err := walkTemporaryFolder(ctx, real, folderKey, marker, visit)
	return err
}

func walkTemporaryFolder(ctx context.Context, real, folderKey, marker string, visit func(string, bool, os.FileInfo) bool) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	items, err := os.ReadDir(real)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
			return true, nil
		}
		return false, volumeError(err)
	}
	if len(items) > volumeMaxFolderEntries {
		return false, apiError{Status: http.StatusUnprocessableEntity, Code: "volume_folder_too_large", Message: fmt.Sprintf("a folder has more than %d entries: S3-Browser does not list it", volumeMaxFolderEntries)}
	}
	type entry struct {
		sortKey string
		item    fs.DirEntry
	}
	entries := make([]entry, 0, len(items))
	for _, item := range items {
		sortKey := item.Name()
		if item.Type().IsDir() {
			sortKey += "/"
		}
		entries = append(entries, entry{sortKey: sortKey, item: item})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].sortKey < entries[j].sortKey })
	for _, value := range entries {
		key := folderKey + value.sortKey
		if value.item.Type().IsDir() {
			if marker != "" && key < marker && !strings.HasPrefix(marker, key) {
				continue
			}
			more, err := walkTemporaryFolder(ctx, filepath.Join(real, value.item.Name()), key, marker, visit)
			if err != nil || !more {
				return more, err
			}
			continue
		}
		if !value.item.Type().IsRegular() || key <= marker {
			continue
		}
		_, temporary := parseVolumeTempName(value.item.Name())
		info, err := value.item.Info()
		if err != nil {
			continue
		}
		if !visit(key, temporary, info) {
			return false, nil
		}
	}
	return true, nil
}

// MultipartUploadParts gives one part with the size of the temporary file.
func (b *volumeBackend) MultipartUploadParts(_ context.Context, full, uploadID string, _ int) (multipartPartsSummary, error) {
	real, err := b.temporaryOfUpload(full, uploadID)
	if err != nil {
		return multipartPartsSummary{}, err
	}
	info, err := os.Lstat(real)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return multipartPartsSummary{}, &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchUpload", Message: "the temporary file of the upload does not exist"}
		}
		return multipartPartsSummary{}, volumeError(err)
	}
	return multipartPartsSummary{Parts: 1, Bytes: info.Size()}, nil
}

// RemoveIncompleteUpload removes the temporary file uploadID in the folder of the key of the list. A file that is gone
// is not an error.
func (b *volumeBackend) RemoveIncompleteUpload(_ context.Context, full, uploadID string) error {
	real, err := b.temporaryOfUpload(full, uploadID)
	if err != nil {
		return err
	}
	info, err := os.Lstat(real)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return volumeError(err)
	}
	if !info.Mode().IsRegular() {
		return apiError{Status: http.StatusConflict, Code: "volume_not_file", Message: "the temporary file of the upload is not a regular file"}
	}
	if err := os.Remove(real); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return volumeError(err)
	}
	syncFolder(filepath.Dir(real))
	return nil
}

// temporaryOfUpload gives the real path of the temporary file uploadID in the folder of the key of an upload of the
// list.
func (b *volumeBackend) temporaryOfUpload(full, uploadID string) (string, error) {
	if _, temporary := parseVolumeTempName(uploadID); !temporary || strings.ContainsRune(uploadID, '/') {
		return "", invalidMultipartRequest("the upload id of a volume is the name of a temporary file of S3-Browser")
	}
	key, err := b.parse(full, false)
	if err != nil {
		return "", err
	}
	folder, err := b.resolveFolder(key.parent(), false)
	if err != nil {
		if isStorageNotFound(err) || isVolumeNotFolder(err) {
			return "", &upstreamError{StatusCode: http.StatusNotFound, Code: "NoSuchUpload", Message: "the temporary file of the upload does not exist"}
		}
		return "", err
	}
	return filepath.Join(folder, uploadID), nil
}
