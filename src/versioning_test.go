package main

import (
	"net/http"
	"testing"
)

func TestWithoutVersionPreconditionsKeepsRangeAndDropsIfMatch(t *testing.T) {
	headers := http.Header{}
	headers.Set("Range", "bytes=0-9")
	headers.Set("If-Match", `"abc"`)
	headers.Set("If-Unmodified-Since", "Mon, 02 Jan 2006 15:04:05 GMT")
	clean := withoutVersionPreconditions(headers)
	if clean.Get("Range") != "bytes=0-9" || clean.Get("If-Match") != "" || clean.Get("If-Unmodified-Since") != "" {
		t.Fatalf("unexpected headers: %v", clean)
	}
	if headers.Get("If-Match") == "" {
		t.Fatal("the caller headers changed")
	}
	plain := http.Header{"Range": {"bytes=0-9"}}
	if got := withoutVersionPreconditions(plain); got.Get("Range") != "bytes=0-9" {
		t.Fatalf("unexpected headers: %v", got)
	}
}
