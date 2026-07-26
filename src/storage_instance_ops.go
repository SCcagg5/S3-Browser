package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

func (s *storageInstance) acquire(ctx context.Context) (func(), error) {
	if s == nil {
		return nil, errors.New("storage instance is nil")
	}
	var global chan struct{}
	if s.concurrency != nil {
		global = s.concurrency.global
	}
	return acquireGate(ctx, global, s.gate)
}

func (s *storageInstance) beginStorageRequest(ctx context.Context) (func(), error) {
	if budget := budgetFromContext(ctx); budget != nil {
		if err := budget.consumeRequest(); err != nil {
			return nil, err
		}
	}
	return s.acquire(ctx)
}

func (s *storageInstance) observePermission(permission string, err error) {
	if s == nil || permission == "" {
		return
	}
	if s.forceReadOnly && permission != permissionRead {
		return
	}
	if s.cfg.PermissionsDefined && !containsString(s.cfg.Permissions, permission) {
		return
	}

	var next capabilityState
	if err == nil {
		next = allowedCapability("observed", "a real provider operation succeeded during this process", true)
	} else {
		var upstream *upstreamError
		if !errors.As(err, &upstream) || (upstream.StatusCode != http.StatusUnauthorized && upstream.StatusCode != http.StatusForbidden) {
			return
		}
		next = deniedCapability("provider", "the storage provider denied a real operation during this process", true)
	}

	s.mu.Lock()
	current := s.caps.state(permission)
	// An explicit administrative/configuration denial is a hard ceiling. A
	// provider denial can later be replaced by a successful observed operation
	// because credentials or bucket policies may be refreshed without restart.
	if current.Source != "runtime" && current.Source != "configuration" {
		s.caps.set(permission, next)
		now := timeNowUTC()
		s.caps.CheckedAt = &now
	}
	s.mu.Unlock()
}

// timeNowUTC is a tiny seam used by capability observations and tests without
// coupling storage operations to a process-wide clock abstraction.
var timeNowUTC = func() time.Time { return time.Now().UTC() }

func (s *storageInstance) List(ctx context.Context, options listOptions) (listPage, error) {
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return listPage{}, err
	}
	defer release()
	page, err := s.backend.List(ctx, options)
	s.observePermission(permissionRead, err)
	return page, err
}

func (s *storageInstance) Head(ctx context.Context, key string) (objectResponse, error) {
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return objectResponse{}, err
	}
	defer release()
	response, err := s.backend.Head(ctx, key)
	if err == nil && (response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden) {
		err = &upstreamError{StatusCode: response.StatusCode, Code: "AccessDenied"}
	}
	s.observePermission(permissionRead, err)
	return response, err
}

type budgetReadCloser struct {
	body   io.ReadCloser
	budget *resourceBudget
	once   sync.Once
}

func (r *budgetReadCloser) Read(buffer []byte) (int, error) {
	count, err := r.body.Read(buffer)
	if count > 0 && r.budget != nil {
		if budgetErr := r.budget.consumeBytes(int64(count)); budgetErr != nil {
			return count, budgetErr
		}
	}
	return count, err
}

func (r *budgetReadCloser) Close() error {
	var err error
	r.once.Do(func() { err = r.body.Close() })
	return err
}

func (s *storageInstance) Get(ctx context.Context, key string, headers http.Header) (objectResponse, error) {
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return objectResponse{}, err
	}
	response, err := s.backend.Get(ctx, key, headers)
	if err != nil {
		release()
		s.observePermission(permissionRead, err)
		return objectResponse{}, err
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		release()
		if response.Body != nil {
			_ = response.Body.Close()
		}
		err = &upstreamError{StatusCode: response.StatusCode, Code: "AccessDenied"}
		s.observePermission(permissionRead, err)
		return objectResponse{}, err
	}
	if response.Body != nil {
		response.Body = &releaseReadCloser{
			ReadCloser: &budgetReadCloser{body: response.Body, budget: budgetFromContext(ctx)},
			release:    release,
		}
	} else {
		release()
	}
	s.observePermission(permissionRead, nil)
	return response, nil
}

type releaseReadCloser struct {
	io.ReadCloser
	release func()
	once    sync.Once
}

func (r *releaseReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(r.release)
	return err
}

func (s *storageInstance) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return err
	}
	defer release()
	if budget := budgetFromContext(ctx); budget != nil && size > 0 {
		if err := budget.consumeBytes(size); err != nil {
			return err
		}
	}
	err = s.backend.Put(ctx, key, body, size, contentType)
	s.observePermission(permissionWrite, err)
	return err
}

func (s *storageInstance) Delete(ctx context.Context, key string) error {
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return err
	}
	defer release()
	err = s.backend.Delete(ctx, key)
	s.observePermission(permissionDelete, err)
	return err
}

func (s *storageInstance) Copy(ctx context.Context, source, destination string) error {
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return err
	}
	defer release()
	err = s.backend.Copy(ctx, source, destination)
	if err == nil {
		s.observePermission(permissionRead, nil)
		s.observePermission(permissionWrite, nil)
	} else {
		// S3 API implementations do not reliably identify whether a CopyObject denial
		// came from reading the source or writing the destination. Keep read
		// tentable and learn the conservative write denial only.
		s.observePermission(permissionWrite, err)
	}
	return err
}

func (s *storageInstance) discoverCapabilities(ctx context.Context) (discoveredCapabilities, error) {
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return discoveredCapabilities{}, err
	}
	defer release()
	return s.backend.DiscoverCapabilities(ctx)
}

func (s *storageInstance) InitiateMultipart(ctx context.Context, key, contentType string) (string, error) {
	backend, ok := s.backend.(s3MultipartAPI)
	if !ok {
		return "", errors.New("s3 backend does not support multipart uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	uploadID, err := backend.InitiateMultipart(ctx, key, contentType)
	s.observePermission(permissionWrite, err)
	return uploadID, err
}

func (s *storageInstance) UploadPart(ctx context.Context, key, uploadID string, partNumber int, body io.Reader, size int64) (string, error) {
	backend, ok := s.backend.(s3MultipartAPI)
	if !ok {
		return "", errors.New("s3 backend does not support multipart uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	if budget := budgetFromContext(ctx); budget != nil && size > 0 {
		if err := budget.consumeBytes(size); err != nil {
			return "", err
		}
	}
	etag, err := backend.UploadPart(ctx, key, uploadID, partNumber, body, size)
	s.observePermission(permissionWrite, err)
	return etag, err
}

func (s *storageInstance) CompleteMultipart(ctx context.Context, key, uploadID string, parts []s3CompletedPart) error {
	backend, ok := s.backend.(s3MultipartAPI)
	if !ok {
		return errors.New("s3 backend does not support multipart uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return err
	}
	defer release()
	err = backend.CompleteMultipart(ctx, key, uploadID, parts)
	s.observePermission(permissionWrite, err)
	return err
}

func (s *storageInstance) AbortMultipart(ctx context.Context, key, uploadID string) error {
	backend, ok := s.backend.(s3MultipartAPI)
	if !ok {
		return errors.New("s3 backend does not support multipart uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return err
	}
	defer release()
	err = backend.AbortMultipart(ctx, key, uploadID)
	s.observePermission(permissionWrite, err)
	return err
}

func (s *storageInstance) InitiateResumable(ctx context.Context, key string, total int64, contentType string) (string, error) {
	backend, ok := s.backend.(gcsResumableAPI)
	if !ok {
		return "", errors.New("gcs backend does not support resumable uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	sessionURL, err := backend.InitiateResumable(ctx, key, total, contentType)
	s.observePermission(permissionWrite, err)
	return sessionURL, err
}

func (s *storageInstance) UploadResumableChunk(ctx context.Context, sessionURL string, body io.Reader, start, size, total int64, contentType string) (int64, bool, error) {
	backend, ok := s.backend.(gcsResumableAPI)
	if !ok {
		return 0, false, errors.New("gcs backend does not support resumable uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return 0, false, err
	}
	defer release()
	if budget := budgetFromContext(ctx); budget != nil && size > 0 {
		if err := budget.consumeBytes(size); err != nil {
			return 0, false, err
		}
	}
	next, complete, err := backend.UploadResumableChunk(ctx, sessionURL, body, start, size, total, contentType)
	s.observePermission(permissionWrite, err)
	return next, complete, err
}

func (s *storageInstance) QueryResumable(ctx context.Context, sessionURL string, total int64) (int64, bool, error) {
	backend, ok := s.backend.(gcsResumableAPI)
	if !ok {
		return 0, false, errors.New("gcs backend does not support resumable uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return 0, false, err
	}
	defer release()
	next, complete, err := backend.QueryResumable(ctx, sessionURL, total)
	s.observePermission(permissionWrite, err)
	return next, complete, err
}

func (s *storageInstance) AbortResumable(ctx context.Context, sessionURL string) error {
	backend, ok := s.backend.(gcsResumableAPI)
	if !ok {
		return errors.New("gcs backend does not support resumable uploads")
	}
	release, err := s.beginStorageRequest(ctx)
	if err != nil {
		return err
	}
	defer release()
	err = backend.AbortResumable(ctx, sessionURL)
	s.observePermission(permissionWrite, err)
	return err
}
