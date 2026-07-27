package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
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

	// Upload session state is intentionally memory-only. Bounding the number of
	// simultaneously registered sessions prevents abandoned browser tabs from
	// growing the process indefinitely. A client-held resume token can recreate
	// a provider session after it has disappeared from memory.
	maxInMemoryUploadSessions = 4
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

type uploadSession struct {
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
	Verified         bool              `json:"verified,omitempty"`
	ResumeToken      string            `json:"-"`
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
	Verified      bool       `json:"verified,omitempty"`
	ResumeToken   string     `json:"resumeToken,omitempty"`
}

func (u uploadSession) public() publicUpload {
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
		Verified:      u.Verified,
		ResumeToken:   u.ResumeToken,
	}
}

type uploadManager struct {
	app     *application
	mu      sync.RWMutex
	uploads map[string]*uploadSession
	lockMu  sync.Mutex
	uplocks map[string]*sync.Mutex
}

func newUploadManager(app *application) (*uploadManager, error) {
	if app == nil {
		return nil, fmt.Errorf("application is nil")
	}
	return &uploadManager{app: app, uploads: make(map[string]*uploadSession), uplocks: make(map[string]*sync.Mutex)}, nil
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

func (m *uploadManager) get(id string) (uploadSession, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	upload, ok := m.uploads[id]
	if !ok {
		return uploadSession{}, false
	}
	return cloneUploadSession(*upload), true
}

func cloneUploadSession(upload uploadSession) uploadSession {
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

func (m *uploadManager) put(upload uploadSession) error {
	if strings.TrimSpace(upload.ID) == "" {
		return fmt.Errorf("upload id is empty")
	}
	copyUpload := cloneUploadSession(upload)
	m.mu.Lock()
	if _, exists := m.uploads[upload.ID]; !exists && len(m.uploads) >= maxInMemoryUploadSessions {
		m.mu.Unlock()
		return uploadCapacityError()
	}
	m.uploads[upload.ID] = &copyUpload
	m.mu.Unlock()
	return nil
}

func (m *uploadManager) hasCapacityFor(id string) bool {
	if m == nil {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, exists := m.uploads[id]; exists {
		return true
	}
	return len(m.uploads) < maxInMemoryUploadSessions
}

func uploadCapacityError() error {
	return apiError{
		Status:  http.StatusTooManyRequests,
		Code:    "upload_session_limit_reached",
		Message: fmt.Sprintf("the server is already tracking %d active upload sessions", maxInMemoryUploadSessions),
	}
}

func (m *uploadManager) remove(id string) {
	id = strings.TrimSpace(id)
	if id == "" {
		return
	}
	m.mu.Lock()
	delete(m.uploads, id)
	m.mu.Unlock()
	m.lockMu.Lock()
	delete(m.uplocks, id)
	m.lockMu.Unlock()
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

func (m *uploadManager) create(ctx context.Context, request createUploadRequest) (uploadSession, error) {
	if !m.hasCapacityFor("") {
		return uploadSession{}, uploadCapacityError()
	}
	instance, ok := m.app.instances[strings.TrimSpace(request.Instance)]
	if !ok {
		return uploadSession{}, apiError{Status: http.StatusNotFound, Code: "unknown_instance", Message: "storage instance was not found"}
	}
	if err := requirePermission(instance, permissionWrite); err != nil {
		return uploadSession{}, err
	}
	key := cleanRelativeKey(request.Key)
	if key == "" {
		return uploadSession{}, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "object key is required"}
	}
	chunkSize, err := uploadChunkSize(instance.cfg.Provider, request.Size)
	if err != nil {
		return uploadSession{}, apiError{Status: http.StatusBadRequest, Code: "invalid_size", Message: err.Error()}
	}
	contentType := strings.TrimSpace(request.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	now := time.Now().UTC()
	upload := uploadSession{
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
			return uploadSession{}, err
		}
		id, err := newStateID("upl")
		if err != nil {
			return uploadSession{}, err
		}
		upload.ID = id
		upload.Status = uploadStatusCompleted
		upload.CompletedAt = &now
		upload.Verified = true
		return upload, nil
	}

	switch instance.cfg.Provider {
	case "s3":
		uploadID, err := instance.InitiateMultipart(ctx, fullKey, contentType)
		if err != nil {
			return uploadSession{}, err
		}
		upload.ProviderUploadID = uploadID
	case "gcs":
		sessionURL, err := instance.InitiateResumable(ctx, fullKey, request.Size, contentType)
		if err != nil {
			return uploadSession{}, err
		}
		upload.SessionURL = sessionURL
	default:
		return uploadSession{}, fmt.Errorf("provider %q does not support resumable uploads", instance.cfg.Provider)
	}
	resumeToken, err := m.app.sealUploadResumeToken(instance, upload)
	if err != nil {
		_ = m.abortProvider(context.Background(), instance, upload)
		return uploadSession{}, err
	}
	upload.ResumeToken = resumeToken
	upload.ID = uploadIDFromResumeToken(resumeToken)
	if err := m.put(upload); err != nil {
		// Best effort cleanup when the in-memory session cannot be registered.
		_ = m.abortProvider(context.Background(), instance, upload)
		return uploadSession{}, err
	}
	return upload, nil
}

type resumeUploadRequest struct {
	ResumeToken string `json:"resumeToken"`
}

func (m *uploadManager) resume(ctx context.Context, token string) (uploadSession, error) {
	descriptor, instance, err := m.app.openUploadResumeToken(token)
	if err != nil {
		return uploadSession{}, err
	}
	if err := requirePermission(instance, permissionWrite); err != nil {
		return uploadSession{}, err
	}
	id := uploadIDFromResumeToken(token)
	if existing, ok := m.get(id); ok {
		return m.status(ctx, existing.ID)
	}
	if !m.hasCapacityFor(id) {
		return uploadSession{}, uploadCapacityError()
	}
	now := time.Now().UTC()
	upload := uploadSession{
		ID: id, Instance: descriptor.Instance, Key: descriptor.Key, Provider: descriptor.Provider,
		Status: uploadStatusUploading, ContentType: descriptor.ContentType, TotalSize: descriptor.TotalSize,
		ChunkSize: descriptor.ChunkSize, ProviderUploadID: descriptor.ProviderUploadID, SessionURL: descriptor.SessionURL,
		CreatedAt: time.Unix(descriptor.IssuedAt, 0).UTC(), UpdatedAt: now, ResumeToken: token,
	}
	if upload.ChunkSize <= 0 {
		upload.ChunkSize, err = uploadChunkSize(upload.Provider, upload.TotalSize)
		if err != nil {
			return uploadSession{}, err
		}
	}
	if err := m.put(upload); err != nil {
		return uploadSession{}, err
	}
	return m.status(ctx, id)
}

func (m *uploadManager) abortProvider(ctx context.Context, instance *storageInstance, upload uploadSession) error {
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

func (m *uploadManager) uploadChunk(ctx context.Context, id string, request *http.Request) (uploadSession, error) {
	lock := m.uploadLock(id)
	lock.Lock()
	defer lock.Unlock()

	upload, ok := m.get(id)
	if !ok {
		return uploadSession{}, apiError{Status: http.StatusNotFound, Code: "upload_not_found", Message: "upload session was not found"}
	}
	if upload.Status != uploadStatusUploading {
		return uploadSession{}, apiError{Status: http.StatusConflict, Code: "upload_not_active", Message: "upload session is not active"}
	}
	instance := m.app.instances[upload.Instance]
	if err := requirePermission(instance, permissionWrite); err != nil {
		return uploadSession{}, err
	}
	start, end, total, err := parseContentRange(request.Header.Get("Content-Range"))
	if err != nil {
		return uploadSession{}, apiError{Status: http.StatusBadRequest, Code: "invalid_content_range", Message: err.Error()}
	}
	if total != upload.TotalSize {
		return uploadSession{}, apiError{Status: http.StatusConflict, Code: "size_mismatch", Message: "Content-Range total does not match the upload session"}
	}
	size := end - start + 1
	if request.ContentLength < 0 {
		return uploadSession{}, apiError{Status: http.StatusLengthRequired, Code: "content_length_required", Message: "Content-Length is required for upload chunks"}
	}
	if request.ContentLength != size {
		return uploadSession{}, apiError{Status: http.StatusBadRequest, Code: "content_length_mismatch", Message: "Content-Length does not match Content-Range"}
	}

	if start != upload.UploadedBytes {
		switch upload.Provider {
		case "gcs":
			if err := m.synchronizeGCSOffset(ctx, instance, &upload); err != nil {
				return uploadSession{}, err
			}
		case "s3":
			if err := m.synchronizeS3Parts(ctx, instance, &upload); err != nil {
				return uploadSession{}, err
			}
		}
	}
	if start != upload.UploadedBytes {
		return uploadSession{}, apiError{
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
			return uploadSession{}, apiError{Status: http.StatusBadRequest, Code: "part_too_large", Message: "S3 upload parts cannot exceed 5 GiB"}
		}
		if end+1 < total && size < minimumS3PartSize {
			return uploadSession{}, apiError{Status: http.StatusBadRequest, Code: "part_too_small", Message: "non-final S3 upload parts must be at least 5 MiB"}
		}
		partNumber := len(upload.Parts) + 1
		if partNumber > maximumS3Parts {
			return uploadSession{}, apiError{Status: http.StatusBadRequest, Code: "too_many_parts", Message: "S3 multipart uploads cannot exceed 10000 parts"}
		}
		etag, err := instance.UploadPart(ctx, instance.fullKey(upload.Key), upload.ProviderUploadID, partNumber, body, size)
		if err != nil {
			upload.Error = publicStorageError(err)
			upload.UpdatedAt = time.Now().UTC()
			_ = m.put(upload)
			return uploadSession{}, err
		}
		upload.Parts = append(upload.Parts, uploadPartState{PartNumber: partNumber, ETag: etag, Size: size})
		upload.UploadedBytes = end + 1
		upload.UpdatedAt = time.Now().UTC()
		if err := m.put(upload); err != nil {
			return uploadSession{}, err
		}
		if upload.UploadedBytes == upload.TotalSize {
			if err := m.completeS3(ctx, instance, &upload); err != nil {
				return uploadSession{}, err
			}
		}
	case "gcs":
		next, complete, err := instance.UploadResumableChunk(ctx, upload.SessionURL, body, start, size, total, upload.ContentType)
		if err != nil {
			upload.Error = publicStorageError(err)
			upload.UpdatedAt = time.Now().UTC()
			_ = m.put(upload)
			return uploadSession{}, err
		}
		if next < start || next > total {
			return uploadSession{}, fmt.Errorf("gcs resumable upload returned an invalid offset")
		}
		upload.UploadedBytes = next
		upload.UpdatedAt = time.Now().UTC()
		if complete {
			now := upload.UpdatedAt
			upload.Status = uploadStatusCompleted
			upload.CompletedAt = &now
			if err := m.verifyCompletedObject(ctx, instance, &upload); err != nil {
				return uploadSession{}, err
			}
		}
		if err := m.put(upload); err != nil {
			return uploadSession{}, err
		}
	default:
		return uploadSession{}, fmt.Errorf("unsupported upload provider %q", upload.Provider)
	}
	return upload, nil
}

func (m *uploadManager) completeS3(ctx context.Context, instance *storageInstance, upload *uploadSession) error {
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
	if err := m.verifyCompletedObject(ctx, instance, upload); err != nil {
		return err
	}
	return m.put(*upload)
}

func (m *uploadManager) synchronizeS3Parts(ctx context.Context, instance *storageInstance, upload *uploadSession) error {
	if upload == nil || upload.ProviderUploadID == "" {
		return nil
	}
	parts, err := instance.ListMultipartParts(ctx, instance.fullKey(upload.Key), upload.ProviderUploadID)
	if err != nil {
		return err
	}
	state := make([]uploadPartState, 0, len(parts))
	var uploaded int64
	for index, part := range parts {
		if part.PartNumber != index+1 || part.Size <= 0 || strings.TrimSpace(part.ETag) == "" {
			return fmt.Errorf("s3 multipart upload contains a non-contiguous or invalid part sequence")
		}
		state = append(state, uploadPartState{PartNumber: part.PartNumber, ETag: part.ETag, Size: part.Size})
		uploaded += part.Size
	}
	if uploaded > upload.TotalSize {
		return fmt.Errorf("s3 multipart upload contains more bytes than the local upload session")
	}
	upload.Parts = state
	upload.UploadedBytes = uploaded
	upload.UpdatedAt = time.Now().UTC()
	return m.put(*upload)
}

func (m *uploadManager) verifyCompletedObject(ctx context.Context, instance *storageInstance, upload *uploadSession) error {
	response, err := instance.Head(ctx, instance.fullKey(upload.Key))
	if err != nil {
		upload.Error = "the upload completed but the final object could not be verified"
		upload.Verified = false
		upload.UpdatedAt = time.Now().UTC()
		_ = m.put(*upload)
		return err
	}
	defer closeObjectResponse(response)
	size, err := strconv.ParseInt(strings.TrimSpace(response.Header.Get("Content-Length")), 10, 64)
	if err != nil || size != upload.TotalSize {
		upload.Error = fmt.Sprintf("the upload completed but the provider reports %d bytes instead of %d", size, upload.TotalSize)
		upload.Verified = false
		upload.UpdatedAt = time.Now().UTC()
		_ = m.put(*upload)
		return fmt.Errorf("completed upload size verification failed")
	}
	upload.Verified = true
	upload.Error = ""
	return nil
}

func (m *uploadManager) synchronizeGCSOffset(ctx context.Context, instance *storageInstance, upload *uploadSession) error {
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
		if err := m.verifyCompletedObject(ctx, instance, upload); err != nil {
			return err
		}
	}
	return m.put(*upload)
}

func (m *uploadManager) status(ctx context.Context, id string) (uploadSession, error) {
	lock := m.uploadLock(id)
	lock.Lock()
	defer lock.Unlock()
	upload, ok := m.get(id)
	if !ok {
		return uploadSession{}, apiError{Status: http.StatusNotFound, Code: "upload_not_found", Message: "upload session was not found"}
	}
	instance := m.app.instances[upload.Instance]
	if instance == nil {
		return uploadSession{}, apiError{Status: http.StatusNotFound, Code: "unknown_instance", Message: "storage instance was not found"}
	}
	if upload.Status == uploadStatusUploading {
		switch upload.Provider {
		case "gcs":
			if err := m.synchronizeGCSOffset(ctx, instance, &upload); err != nil {
				// Preserve the last in-memory offset when the provider is temporarily unavailable.
				upload.Error = publicStorageError(err)
				upload.UpdatedAt = time.Now().UTC()
				_ = m.put(upload)
			}
		case "s3":
			err := m.synchronizeS3Parts(ctx, instance, &upload)
			if err != nil {
				// The provider may remove the multipart session immediately after completion. Verify the final object before marking the session complete.
				if isStorageNotFound(err) {
					now := time.Now().UTC()
					upload.Status = uploadStatusCompleted
					upload.UploadedBytes = upload.TotalSize
					upload.CompletedAt = &now
					upload.UpdatedAt = now
					if verifyErr := m.verifyCompletedObject(ctx, instance, &upload); verifyErr == nil {
						_ = m.put(upload)
					} else {
						upload.Status = uploadStatusUploading
						upload.UploadedBytes = 0
						upload.CompletedAt = nil
						upload.Error = publicStorageError(verifyErr)
						_ = m.put(upload)
					}
				} else {
					upload.Error = publicStorageError(err)
					upload.UpdatedAt = time.Now().UTC()
					_ = m.put(upload)
				}
			} else if upload.UploadedBytes == upload.TotalSize && len(upload.Parts) > 0 {
				if err := m.completeS3(ctx, instance, &upload); err != nil {
					upload.Error = publicStorageError(err)
					_ = m.put(upload)
				}
			}
		}
	}
	if upload.Status == uploadStatusCompleted && !upload.Verified {
		if err := m.verifyCompletedObject(ctx, instance, &upload); err != nil {
			upload.Error = publicStorageError(err)
		} else {
			upload.Error = ""
		}
		upload.UpdatedAt = time.Now().UTC()
		_ = m.put(upload)
	}
	return upload, nil
}

func isStorageNotFound(err error) bool {
	var upstream *upstreamError
	return errors.As(err, &upstream) && upstream.StatusCode == http.StatusNotFound
}

func (m *uploadManager) cancel(ctx context.Context, id string) (uploadSession, error) {
	lock := m.uploadLock(id)
	lock.Lock()
	defer lock.Unlock()
	upload, ok := m.get(id)
	if !ok {
		return uploadSession{}, apiError{Status: http.StatusNotFound, Code: "upload_not_found", Message: "upload session was not found"}
	}
	if upload.Status == uploadStatusCompleted || upload.Status == uploadStatusCanceled {
		return upload, nil
	}
	instance := m.app.instances[upload.Instance]
	if err := requirePermission(instance, permissionWrite); err != nil {
		return uploadSession{}, err
	}
	if err := m.abortProvider(ctx, instance, upload); err != nil {
		return uploadSession{}, err
	}
	now := time.Now().UTC()
	upload.Status = uploadStatusCanceled
	upload.Error = ""
	upload.UpdatedAt = now
	if err := m.put(upload); err != nil {
		return uploadSession{}, err
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

func uploadResumeTokenFromRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(r.Header.Get("X-S3-Browser-Resume-Token"))
}

func (a *application) writeUploadResponse(w http.ResponseWriter, status int, upload uploadSession) {
	public := upload.public()
	if a != nil && a.uploads != nil && (upload.Status == uploadStatusCompleted || upload.Status == uploadStatusCanceled) {
		a.uploads.remove(upload.ID)
	}
	writeJSON(w, status, public)
}

func (a *application) handleUploads(w http.ResponseWriter, r *http.Request) {
	if a.uploads == nil {
		writeAPIError(w, fmt.Errorf("upload manager is not initialized"))
		return
	}
	if r.URL.Path == "/api/uploads/resume" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		var request resumeUploadRequest
		if err := decodeJSONBody(r, &request); err != nil {
			writeAPIError(w, err)
			return
		}
		upload, err := a.uploads.resume(r.Context(), request.ResumeToken)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		a.writeUploadResponse(w, http.StatusOK, upload)
		return
	}
	if r.URL.Path != "/api/uploads" && r.URL.Path != "/api/uploads/" {
		http.NotFound(w, r)
		return
	}

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
		a.writeUploadResponse(w, http.StatusCreated, upload)
	case http.MethodGet:
		token := uploadResumeTokenFromRequest(r)
		if token == "" {
			writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "resume_token_required", Message: "upload resume token is required"})
			return
		}
		upload, err := a.uploads.resume(r.Context(), token)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		a.writeUploadResponse(w, http.StatusOK, upload)
	case http.MethodPut:
		token := uploadResumeTokenFromRequest(r)
		if token == "" {
			writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "resume_token_required", Message: "upload resume token is required"})
			return
		}
		upload, err := a.uploads.resume(r.Context(), token)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		upload, err = a.uploads.uploadChunk(r.Context(), upload.ID, r)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		a.writeUploadResponse(w, http.StatusOK, upload)
	case http.MethodDelete:
		token := uploadResumeTokenFromRequest(r)
		if token == "" {
			writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "resume_token_required", Message: "upload resume token is required"})
			return
		}
		upload, err := a.uploads.resume(r.Context(), token)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		upload, err = a.uploads.cancel(r.Context(), upload.ID)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		a.writeUploadResponse(w, http.StatusOK, upload)
	default:
		methodNotAllowed(w, http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete)
	}
}
