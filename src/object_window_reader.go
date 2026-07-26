package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
)

const defaultSequentialRangeWindowBytes = int64(256 << 10)

// objectWindowReader turns exact, version-bound object ranges into a sequential
// stream. It deliberately never emits an open-ended Range request. Callers can
// therefore parse CSV, JSON and other streaming formats without giving the
// provider permission to send the rest of a very large object unexpectedly.
type objectWindowReader struct {
	source   *objectRangeSource
	next     int64
	window   int64
	buffer   []byte
	position int
	pending  error
	closed   bool
}

func newObjectWindowReader(ctx context.Context, instance *storageInstance, key string, offset int64, etag string) (*objectWindowReader, error) {
	return newObjectWindowReaderVersion(ctx, instance, key, offset, objectVersion{ETag: etag})
}

func newObjectWindowReaderVersion(ctx context.Context, instance *storageInstance, key string, offset int64, version objectVersion) (*objectWindowReader, error) {
	if offset < 0 {
		return nil, apiError{Status: http.StatusBadRequest, Code: "invalid_offset", Message: "object stream offset cannot be negative"}
	}
	source, err := openObjectRangeSource(ctx, instance, key)
	if err != nil {
		return nil, err
	}
	source.SetExpectedVersion(version)
	return &objectWindowReader{
		source: source,
		next:   offset,
		window: defaultSequentialRangeWindowBytes,
	}, nil
}

func (r *objectWindowReader) Read(destination []byte) (int, error) {
	if len(destination) == 0 {
		return 0, nil
	}
	if r == nil || r.closed {
		return 0, io.ErrClosedPipe
	}
	for r.position >= len(r.buffer) {
		r.buffer = nil
		r.position = 0
		if r.pending != nil {
			err := r.pending
			r.pending = nil
			return 0, err
		}
		if size := r.source.Size(); size > 0 && r.next >= size {
			return 0, io.EOF
		}
		length := r.window
		if length <= 0 || length > maxSingleObjectRangeBytes {
			length = defaultSequentialRangeWindowBytes
		}
		data, err := r.source.ReadRange(r.next, length)
		if len(data) == 0 {
			if err == nil {
				err = io.EOF
			}
			return 0, err
		}
		r.buffer = data
		r.next += int64(len(data))
		if err != nil {
			r.pending = err
		}
	}

	read := copy(destination, r.buffer[r.position:])
	r.position += read
	return read, nil
}

func (r *objectWindowReader) Close() error {
	if r != nil {
		r.closed = true
		r.buffer = nil
	}
	return nil
}

func (r *objectWindowReader) Version() objectVersion {
	if r == nil || r.source == nil {
		return objectVersion{}
	}
	return r.source.Version()
}

func (r *objectWindowReader) Headers() http.Header {
	if r == nil || r.source == nil {
		return nil
	}
	return r.source.Headers()
}

func normalizeExpectedETag(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "*" {
		return value
	}
	if strings.HasPrefix(value, `W/"`) || strings.HasPrefix(value, `"`) {
		return value
	}
	return `"` + strings.Trim(value, `"`) + `"`
}

func isTerminalRangeRead(err error) bool {
	return errors.Is(err, io.EOF)
}
