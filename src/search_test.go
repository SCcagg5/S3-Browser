package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestSearchDocumentStreamScansBeyondReaderBuffer(t *testing.T) {
	prefix := strings.Repeat("a", searchReaderBytes-2)
	input := prefix + "Need" + "le\nsecond needle line\n"
	result, err := searchDocumentStream(strings.NewReader(input), []byte("needle"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 2 || len(result.Matches) != 2 {
		t.Fatalf("result = %+v", result)
	}
	if result.Matches[0].Line != 1 || result.Matches[1].Line != 2 {
		t.Fatalf("lines = %d, %d", result.Matches[0].Line, result.Matches[1].Line)
	}
	if result.BytesScanned != int64(len(input)) {
		t.Fatalf("bytes scanned = %d, want %d", result.BytesScanned, len(input))
	}
}

func TestSearchDocumentStreamBoundsReturnedMatches(t *testing.T) {
	input := bytes.Repeat([]byte("x\n"), maxSearchResults+20)
	result, err := searchDocumentStream(bytes.NewReader(input), []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != maxSearchResults+20 || len(result.Matches) != maxSearchResults || !result.Truncated {
		t.Fatalf("result = %+v", result)
	}
}
