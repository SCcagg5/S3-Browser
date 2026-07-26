package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	uploadStatusUploading = "uploading"
	uploadStatusCompleted = "completed"
	uploadStatusCanceled  = "canceled"

	minimumS3PartSize = int64(5 << 20)
	maximumS3PartSize = int64(5 << 30)
	maximumS3Parts    = 10000
	maximumObjectSize = int64(5) << 40
	gcsChunkAlignment = int64(256 << 10)
)

type s3MultipartAPI interface {
	InitiateMultipart(context.Context, string, string) (string, error)
	UploadPart(context.Context, string, string, int, io.Reader, int64) (string, error)
	CompleteMultipart(context.Context, string, string, []s3CompletedPart) error
	AbortMultipart(context.Context, string, string) error
}

type gcsResumableAPI interface {
	InitiateResumable(context.Context, string, int64, string) (string, error)
	UploadResumableChunk(context.Context, string, io.Reader, int64, int64, int64, string) (int64, bool, error)
	QueryResumable(context.Context, string, int64) (int64, bool, error)
	AbortResumable(context.Context, string) error
}

type uploadPartState struct {
	PartNumber int    `json:"part_number"`
	ETag       string `json:"etag"`
	Size       int64  `json:"size"`
}

type persistentUpload struct {
	ID               string            `json:"id"`
	Instance         string            `json:"instance"`
	Key              string            `json:"key"`
	Provider         string            `json:"provider"`
	Status           string            `json:"status"`
	ContentType      string            `json:"content_type"`
	TotalSize        int64             `json:"total_size"`
	UploadedBytes    int64             `json:"uploaded_bytes"`
	ChunkSize        int64             `json:"chunk_size"`
	ProviderUploadID string            `json:"provider_upload_id,omitempty"`
	SessionURL       string            `json:"session_url,omitempty"`
	Parts            []uploadPartState `json:"parts,omitempty"`
	Error            string            `json:"error,omitempty"`
	CreatedAt        time.Time         `json:"created_at"`
	UpdatedAt        time.Time         `json:"updated_at"`
	CompletedAt      *time.Time        `json:"completed_at,omitempty"`
}

type publicUpload struct {
	ID            string     `json:"id"`
	Instance      string     `json:"instance"`
	Key           string     `json:"key"`
	Provider      string     `json:"provider"`
	Status        string     `json:"status"`
	ContentType   string     `json:"contentType"`
	TotalSize     int64      `json:"totalSize"`
	UploadedBytes int64      `json:"uploadedBytes"`
	NextOffset    int64      `json:"nextOffset"`
	ChunkSize     int64      `json:"chunkSize"`
	PartCount     int        `json:"partCount,omitempty"`
	Error         string     `json:"error,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	CompletedAt   *time.Time `json:"completedAt,omitempty"`
}

func (u persistentUpload) public() publicUpload {
	return publicUpload{
		ID:            u.ID,
		Instance:      u.Instance,
		Key:           u.Key,
		Provider:      u.Provider,
		Status:        u.Status,
		ContentType:   u.ContentType,
		TotalSize:     u.TotalSize,
		UploadedBytes: u.UploadedBytes,
		NextOffset:    u.UploadedBytes,
		ChunkSize:     u.ChunkSize,
		PartCount:     len(u.Parts),
		Error:         u.Error,
		CreatedAt:     u.CreatedAt,
		UpdatedAt:     u.UpdatedAt,
		CompletedAt:   cloneTimePointer(u.CompletedAt),
	}
}

const maxPersistedUploadBytes = int64(4 << 20)

type uploadManager struct {
	app     *application
	dir     string
	mu      sync.RWMutex
	uploads map[string]*persistentUpload
	lockMu  sync.Mutex
	uplocks map[string]*sync.Mutex
}

func newUploadManager(app *application, dataDir string, persistent bool) (*uploadManager, error) {
	manager := &uploadManager{app: app, uploads: make(map[string]*persistentUpload), uplocks: make(map[string]*sync.Mutex)}
	if !persistent {
		return manager, nil
	}
	if strings.TrimSpace(dataDir) == "" {
		return nil, fmt.Errorf("persistent upload state requires a data directory")
	}
	manager.dir = filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(manager.dir, 0o700); err != nil {
		return nil, fmt.Errorf("create upload state directory: %w", err)
	}
	entries, err := os.ReadDir(manager.dir)
	if err != nil {
		return nil, fmt.Errorf("read upload state directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := readBoundedFile(filepath.Join(manager.dir, entry.Name()), maxPersistedUploadBytes)
		if err != nil {
			return nil, fmt.Errorf("read upload state %q: %w", entry.Name(), err)
		}
		var upload persistentUpload
		if err := json.Unmarshal(data, &upload); err != nil {
			return nil, fmt.Errorf("decode upload state %q: %w", entry.Name(), err)
		}
		if upload.ID == "" || upload.Instance == "" || upload.Key == "" {
			return nil, fmt.Errorf("upload state %q is incomplete", entry.Name())
		}
		if _, ok := app.instances[upload.Instance]; !ok {
			quarantineUnknownState(manager.dir, entry.Name(), "upload", upload.Instance)
			continue
		}
		copyUpload := clonePersistentUpload(upload)
		manager.uploads[upload.ID] = &copyUpload
	}
	return manager, nil
}

func (m *uploadManager) uploadLock(id string) *sync.Mutex {
	m.lockMu.Lock()
	defer m.lockMu.Unlock()
	lock := m.uplocks[id]
	if lock == nil {
		lock = &sync.Mutex{}
		m.uplocks[id] = lock
	}
	return lock
}

func (m *uploadManager) get(id string) (persistentUpload, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	upload, ok := m.uploads[id]
	if !ok {
		return persistentUpload{}, false
	}
	return clonePersistentUpload(*upload), true
}

func clonePersistentUpload(upload persistentUpload) persistentUpload {
	upload.Parts = append([]uploadPartState(nil), upload.Parts...)
	upload.CompletedAt = cloneTimePointer(upload.CompletedAt)
	return upload
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func (m *uploadManager) put(upload persistentUpload) error {
	copyUpload := clonePersistentUpload(upload)
	m.mu.Lock()
	m.uploads[upload.ID] = &copyUpload
	m.mu.Unlock()
	return m.persist(upload)
}

func (m *uploadManager) persist(upload persistentUpload) error {
	if m == nil || strings.TrimSpace(m.dir) == "" {
		return nil
	}
	data, err := json.MarshalIndent(upload, "", "  ")
	if err != nil {
		return fmt.Errorf("encode upload state: %w", err)
	}
	path := filepath.Join(m.dir, upload.ID+".json")
	temporary, err := os.CreateTemp(m.dir, upload.ID+"-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary upload state: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect upload state: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return fmt.Errorf("write upload state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync upload state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close upload state: %w", err)
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return fmt.Errorf("replace upload state: %w", err)
	}
	return nil
}

func (m *uploadManager) list(instance string) []publicUpload {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]publicUpload, 0, len(m.uploads))
	for _, upload := range m.uploads {
		if instance != "" && upload.Instance != instance {
			continue
		}
		out = append(out, upload.public())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

func uploadChunkSize(provider string, total int64) (int64, error) {
	if total < 0 || total > maximumObjectSize {
		return 0, fmt.Errorf("object size must be between 0 and %d bytes", maximumObjectSize)
	}
	if provider == "s3" {
		chunk := int64(16 << 20)
		minimumForPartLimit := (total + maximumS3Parts - 1) / maximumS3Parts
		if minimumForPartLimit > chunk {
			chunk = minimumForPartLimit
		}
		const mebibyte = int64(1 << 20)
		chunk = ((chunk + mebibyte - 1) / mebibyte) * mebibyte
		if chunk < minimumS3PartSize {
			chunk = minimumS3PartSize
		}
		if chunk > maximumS3PartSize {
			return 0, fmt.Errorf("object is too large for at most %d S3 parts", maximumS3Parts)
		}
		return chunk, nil
	}
	chunk := int64(8 << 20)
	chunk = ((chunk + gcsChunkAlignment - 1) / gcsChunkAlignment) * gcsChunkAlignment
	return chunk, nil
}

type createUploadRequest struct {
	Instance    string `json:"instance"`
	Key         string `json:"key"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

func (m *uploadManager) create(ctx context.Context, request createUploadRequest) (persistentUpload, error) {
	instance, ok := m.app.instances[strings.TrimSpace(request.Instance)]
	if !ok {
		return persistentUpload{}, apiError{Status: http.StatusNotFound, Code: "unknown_instance", Message: "storage instance was not found"}
	}
	if err := requirePermission(instance, permissionWrite); err != nil {
		return persistentUpload{}, err
	}
	key := cleanRelativeKey(request.Key)
	if key == "" {
		return persistentUpload{}, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "object key is required"}
	}
	chunkSize, err := uploadChunkSize(instance.cfg.Provider, request.Size)
	if err != nil {
		return persistentUpload{}, apiError{Status: http.StatusBadRequest, Code: "invalid_size", Message: err.Error()}
	}
	contentType := strings.TrimSpace(request.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	id, err := newStateID("upl")
	if err != nil {
		return persistentUpload{}, err
	}
	now := time.Now().UTC()
	upload := persistentUpload{
		ID:            id,
		Instance:      instance.cfg.ID,
		Key:           key,
		Provider:      instance.cfg.Provider,
		Status:        uploadStatusUploading,
		ContentType:   contentType,
		TotalSize:     request.Size,
		ChunkSize:     chunkSize,
		CreatedAt:     now,
		UpdatedAt:     now,
		UploadedBytes: 0,
	}
	fullKey := instance.fullKey(key)
	if request.Size == 0 {
		if err := instance.Put(ctx, fullKey, bytes.NewReader(nil), 0, contentType); err != nil {
			return persistentUpload{}, err
		}
		upload.Status = uploadStatusCompleted
		upload.CompletedAt = &now
		if err := m.put(upload); err != nil {
			return persistentUpload{}, err
		}
		return upload, nil
	}

	switch instance.cfg.Provider {
	case "s3":
		uploadID, err := instance.InitiateMultipart(ctx, fullKey, contentType)
		if err != nil {
			return persistentUpload{}, err
		}
		upload.ProviderUploadID = uploadID
	case "gcs":
		sessionURL, err := instance.InitiateResumable(ctx, fullKey, request.Size, contentType)
		if err != nil {
			return persistentUpload{}, err
		}
		upload.SessionURL = sessionURL
	default:
		return persistentUpload{}, fmt.Errorf("provider %q does not support resumable uploads", instance.cfg.Provider)
	}
	if err := m.put(upload); err != nil {
		// Best effort cleanup when the provider session exists but local state cannot be stored.
		_ = m.abortProvider(context.Background(), instance, upload)
		return persistentUpload{}, err
	}
	return upload, nil
}

func (m *uploadManager) abortProvider(ctx context.Context, instance *storageInstance, upload persistentUpload) error {
	switch upload.Provider {
	case "s3":
		if upload.ProviderUploadID == "" {
			return nil
		}
		return instance.AbortMultipart(ctx, instance.fullKey(upload.Key), upload.ProviderUploadID)
	case "gcs":
		if upload.SessionURL == "" {
			return nil
		}
		return instance.AbortResumable(ctx, upload.SessionURL)
	default:
		return nil
	}
}

func parseContentRange(value string) (start, end, total int64, err error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "bytes ") {
		return 0, 0, 0, fmt.Errorf("Content-Range must use bytes start-end/total")
	}
	parts := strings.SplitN(strings.TrimPrefix(value, "bytes "), "/", 2)
	if len(parts) != 2 {
		return 0, 0, 0, fmt.Errorf("Content-Range must use bytes start-end/total")
	}
	rangeParts := strings.SplitN(parts[0], "-", 2)
	if len(rangeParts) != 2 {
		return 0, 0, 0, fmt.Errorf("Content-Range must use bytes start-end/total")
	}
	start, err = strconv.ParseInt(rangeParts[0], 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("invalid Content-Range start")
	}
	end, err = strconv.ParseInt(rangeParts[1], 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("invalid Content-Range end")
	}
	total, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("invalid Content-Range total")
	}
	if start < 0 || end < start || total <= end {
		return 0, 0, 0, fmt.Errorf("Content-Range is outside the object size")
	}
	return start, end, total, nil
}

func (m *uploadManager) uploadChunk(ctx context.Context, id string, request *http.Request) (persistentUpload, error) {
	lock := m.uploadLock(id)
	lock.Lock()
	defer lock.Unlock()

	upload, ok := m.get(id)
	if !ok {
		return persistentUpload{}, apiError{Status: http.StatusNotFound, Code: "upload_not_found", Message: "upload session was not found"}
	}
	if upload.Status != uploadStatusUploading {
		return persistentUpload{}, apiError{Status: http.StatusConflict, Code: "upload_not_active", Message: "upload session is not active"}
	}
	instance := m.app.instances[upload.Instance]
	if err := requirePermission(instance, permissionWrite); err != nil {
		return persistentUpload{}, err
	}
	start, end, total, err := parseContentRange(request.Header.Get("Content-Range"))
	if err != nil {
		return persistentUpload{}, apiError{Status: http.StatusBadRequest, Code: "invalid_content_range", Message: err.Error()}
	}
	if total != upload.TotalSize {
		return persistentUpload{}, apiError{Status: http.StatusConflict, Code: "size_mismatch", Message: "Content-Range total does not match the upload session"}
	}
	size := end - start + 1
	if request.ContentLength < 0 {
		return persistentUpload{}, apiError{Status: http.StatusLengthRequired, Code: "content_length_required", Message: "Content-Length is required for upload chunks"}
	}
	if request.ContentLength != size {
		return persistentUpload{}, apiError{Status: http.StatusBadRequest, Code: "content_length_mismatch", Message: "Content-Length does not match Content-Range"}
	}

	if upload.Provider == "gcs" && start != upload.UploadedBytes {
		if err := m.synchronizeGCSOffset(ctx, instance, &upload); err != nil {
			return persistentUpload{}, err
		}
	}
	if start != upload.UploadedBytes {
		return persistentUpload{}, apiError{
			Status:  http.StatusConflict,
			Code:    "offset_mismatch",
			Message: fmt.Sprintf("upload must resume at byte %d", upload.UploadedBytes),
		}
	}

	body := io.LimitReader(request.Body, size)
	upload.Error = ""
	switch upload.Provider {
	case "s3":
		if size > maximumS3PartSize {
			return persistentUpload{}, apiError{Status: http.StatusBadRequest, Code: "part_too_large", Message: "S3 upload parts cannot exceed 5 GiB"}
		}
		if end+1 < total && size < minimumS3PartSize {
			return persistentUpload{}, apiError{Status: http.StatusBadRequest, Code: "part_too_small", Message: "non-final S3 upload parts must be at least 5 MiB"}
		}
		partNumber := len(upload.Parts) + 1
		if partNumber > maximumS3Parts {
			return persistentUpload{}, apiError{Status: http.StatusBadRequest, Code: "too_many_parts", Message: "S3 multipart uploads cannot exceed 10000 parts"}
		}
		etag, err := instance.UploadPart(ctx, instance.fullKey(upload.Key), upload.ProviderUploadID, partNumber, body, size)
		if err != nil {
			upload.Error = publicStorageError(err)
			upload.UpdatedAt = time.Now().UTC()
			_ = m.put(upload)
			return persistentUpload{}, err
		}
		upload.Parts = append(upload.Parts, uploadPartState{PartNumber: partNumber, ETag: etag, Size: size})
		upload.UploadedBytes = end + 1
		upload.UpdatedAt = time.Now().UTC()
		if err := m.put(upload); err != nil {
			return persistentUpload{}, err
		}
		if upload.UploadedBytes == upload.TotalSize {
			if err := m.completeS3(ctx, instance, &upload); err != nil {
				return persistentUpload{}, err
			}
		}
	case "gcs":
		next, complete, err := instance.UploadResumableChunk(ctx, upload.SessionURL, body, start, size, total, upload.ContentType)
		if err != nil {
			upload.Error = publicStorageError(err)
			upload.UpdatedAt = time.Now().UTC()
			_ = m.put(upload)
			return persistentUpload{}, err
		}
		if next < start || next > total {
			return persistentUpload{}, fmt.Errorf("gcs resumable upload returned an invalid offset")
		}
		upload.UploadedBytes = next
		upload.UpdatedAt = time.Now().UTC()
		if complete {
			now := upload.UpdatedAt
			upload.Status = uploadStatusCompleted
			upload.CompletedAt = &now
		}
		if err := m.put(upload); err != nil {
			return persistentUpload{}, err
		}
	default:
		return persistentUpload{}, fmt.Errorf("unsupported upload provider %q", upload.Provider)
	}
	return upload, nil
}

func (m *uploadManager) completeS3(ctx context.Context, instance *storageInstance, upload *persistentUpload) error {
	parts := make([]s3CompletedPart, 0, len(upload.Parts))
	for _, part := range upload.Parts {
		parts = append(parts, s3CompletedPart{PartNumber: part.PartNumber, ETag: part.ETag})
	}
	if err := instance.CompleteMultipart(ctx, instance.fullKey(upload.Key), upload.ProviderUploadID, parts); err != nil {
		upload.Error = publicStorageError(err)
		upload.UpdatedAt = time.Now().UTC()
		_ = m.put(*upload)
		return err
	}
	now := time.Now().UTC()
	upload.Status = uploadStatusCompleted
	upload.Error = ""
	upload.UpdatedAt = now
	upload.CompletedAt = &now
	return m.put(*upload)
}

func (m *uploadManager) synchronizeGCSOffset(ctx context.Context, instance *storageInstance, upload *persistentUpload) error {
	next, complete, err := instance.QueryResumable(ctx, upload.SessionURL, upload.TotalSize)
	if err != nil {
		return err
	}
	upload.UploadedBytes = next
	upload.UpdatedAt = time.Now().UTC()
	if complete {
		now := upload.UpdatedAt
		upload.Status = uploadStatusCompleted
		upload.CompletedAt = &now
	}
	return m.put(*upload)
}

func (m *uploadManager) status(ctx context.Context, id string) (persistentUpload, error) {
	lock := m.uploadLock(id)
	lock.Lock()
	defer lock.Unlock()
	upload, ok := m.get(id)
	if !ok {
		return persistentUpload{}, apiError{Status: http.StatusNotFound, Code: "upload_not_found", Message: "upload session was not found"}
	}
	instance := m.app.instances[upload.Instance]
	if upload.Status == uploadStatusUploading {
		switch upload.Provider {
		case "gcs":
			if err := m.synchronizeGCSOffset(ctx, instance, &upload); err != nil {
				// A status check should still expose the persisted offset when the provider is temporarily unavailable.
				upload.Error = publicStorageError(err)
				upload.UpdatedAt = time.Now().UTC()
				_ = m.put(upload)
			}
		case "s3":
			if upload.UploadedBytes == upload.TotalSize && len(upload.Parts) > 0 {
				_ = m.completeS3(ctx, instance, &upload)
			}
		}
	}
	return upload, nil
}

func (m *uploadManager) cancel(ctx context.Context, id string) (persistentUpload, error) {
	lock := m.uploadLock(id)
	lock.Lock()
	defer lock.Unlock()
	upload, ok := m.get(id)
	if !ok {
		return persistentUpload{}, apiError{Status: http.StatusNotFound, Code: "upload_not_found", Message: "upload session was not found"}
	}
	if upload.Status == uploadStatusCompleted || upload.Status == uploadStatusCanceled {
		return upload, nil
	}
	instance := m.app.instances[upload.Instance]
	if err := requirePermission(instance, permissionWrite); err != nil {
		return persistentUpload{}, err
	}
	if err := m.abortProvider(ctx, instance, upload); err != nil {
		return persistentUpload{}, err
	}
	now := time.Now().UTC()
	upload.Status = uploadStatusCanceled
	upload.Error = ""
	upload.UpdatedAt = now
	if err := m.put(upload); err != nil {
		return persistentUpload{}, err
	}
	return upload, nil
}

func newStateID(prefix string) (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("generate state id: %w", err)
	}
	return prefix + "_" + hex.EncodeToString(random[:]), nil
}

func (a *application) handleUploads(w http.ResponseWriter, r *http.Request) {
	if a.uploads == nil {
		writeAPIError(w, fmt.Errorf("upload manager is not initialized"))
		return
	}
	if r.URL.Path == "/api/uploads" || r.URL.Path == "/api/uploads/" {
		switch r.Method {
		case http.MethodPost:
			var request createUploadRequest
			if err := decodeJSONBody(r, &request); err != nil {
				writeAPIError(w, err)
				return
			}
			if request.Instance == "" {
				request.Instance = r.URL.Query().Get("instance")
			}
			upload, err := a.uploads.create(r.Context(), request)
			if err != nil {
				writeAPIError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, upload.public())
		case http.MethodGet:
			instance := strings.TrimSpace(r.URL.Query().Get("instance"))
			writeJSON(w, http.StatusOK, map[string]any{"uploads": a.uploads.list(instance)})
		default:
			methodNotAllowed(w, http.MethodGet, http.MethodPost)
		}
		return
	}

	id := strings.TrimPrefix(r.URL.Path, "/api/uploads/")
	if id == "" || strings.Contains(id, "/") {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "upload_not_found", Message: "upload session was not found"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		upload, err := a.uploads.status(r.Context(), id)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, upload.public())
	case http.MethodPut:
		upload, err := a.uploads.uploadChunk(r.Context(), id, r)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, upload.public())
	case http.MethodDelete:
		upload, err := a.uploads.cancel(r.Context(), id)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, upload.public())
	default:
		methodNotAllowed(w, http.MethodGet, http.MethodPut, http.MethodDelete)
	}
}
