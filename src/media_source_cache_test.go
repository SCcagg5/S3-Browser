package main

import (
	"net/http"
	"testing"
)

func TestParseSingleByteRange(t *testing.T) {
	tests := []struct {
		value      string
		size       int64
		start, end int64
		ok         bool
	}{
		{value: "bytes=0-99", size: 1000, start: 0, end: 99, ok: true},
		{value: "bytes=100-", size: 1000, start: 100, end: 999, ok: true},
		{value: "bytes=-50", size: 1000, start: 950, end: 999, ok: true},
		{value: "bytes=900-2000", size: 1000, start: 900, end: 999, ok: true},
		{value: "bytes=0-1,4-5", size: 1000, ok: false},
		{value: "bytes=1000-", size: 1000, ok: false},
	}
	for _, test := range tests {
		start, end, ok := parseSingleByteRange(test.value, test.size)
		if ok != test.ok || (ok && (start != test.start || end != test.end)) {
			t.Fatalf("parseSingleByteRange(%q, %d) = (%d, %d, %v), want (%d, %d, %v)", test.value, test.size, start, end, ok, test.start, test.end, test.ok)
		}
	}
}

func TestMediaRangeCacheServesContainedRanges(t *testing.T) {
	var cache mediaRangeCache
	cache.put(100, []byte("abcdefghij"))
	data, ok := cache.get(103, 106)
	if !ok || string(data) != "defg" {
		t.Fatalf("contained range = %q, %v", data, ok)
	}
	data[0] = 'X'
	again, ok := cache.get(103, 106)
	if !ok || string(again) != "defg" {
		t.Fatalf("cache returned an aliased buffer: %q, %v", again, ok)
	}
	if _, ok := cache.get(99, 101); ok {
		t.Fatal("range extending before the cached chunk should miss")
	}
}

func TestCachedMediaRangeHonorsConditionalHeaders(t *testing.T) {
	source := &mediaSourceRef{etag: `"etag"`, modified: "Wed, 01 Jan 2025 00:00:00 GMT"}
	headers := make(http.Header)
	if !cachedMediaRangeAllowed(headers, source) {
		t.Fatal("plain range should be cacheable")
	}
	headers.Set("If-Range", `"etag"`)
	if !cachedMediaRangeAllowed(headers, source) {
		t.Fatal("matching If-Range should be cacheable")
	}
	headers.Set("If-Range", `"other"`)
	if cachedMediaRangeAllowed(headers, source) {
		t.Fatal("mismatching If-Range must bypass the cache")
	}
	headers.Del("If-Range")
	headers.Set("If-Match", `"etag"`)
	if cachedMediaRangeAllowed(headers, source) {
		t.Fatal("conditional requests must bypass the session cache")
	}
}
