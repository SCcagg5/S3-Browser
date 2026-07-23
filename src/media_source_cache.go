package main

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const (
	// This cache exists only for the lifetime of an explicitly opened media
	// preview. It prevents FFmpeg from turning repeated or overlapping HTTP
	// seeks into separately billed S3/GCS requests. It is deleted with the
	// media session and is not shared across objects or preview sessions.
	mediaSourceCacheCapacity = int64(32 << 20)
	mediaSourceCacheMaxChunk = int64(16 << 20)
)

type mediaCachedRange struct {
	start int64
	end   int64 // inclusive
	data  []byte
	used  uint64
}

type mediaRangeCache struct {
	mu      sync.Mutex
	ranges  []mediaCachedRange
	bytes   int64
	counter uint64
}

func (c *mediaRangeCache) get(start, end int64) ([]byte, bool) {
	if c == nil || start < 0 || end < start {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for index := range c.ranges {
		entry := &c.ranges[index]
		if entry.start <= start && entry.end >= end {
			c.counter++
			entry.used = c.counter
			left := start - entry.start
			right := end - entry.start + 1
			return append([]byte(nil), entry.data[left:right]...), true
		}
	}
	return nil, false
}

func (c *mediaRangeCache) put(start int64, data []byte) {
	if c == nil || start < 0 || len(data) == 0 || int64(len(data)) > mediaSourceCacheMaxChunk {
		return
	}
	copyData := append([]byte(nil), data...)
	end := start + int64(len(copyData)) - 1
	c.mu.Lock()
	defer c.mu.Unlock()

	// Drop ranges fully covered by the new response. Keeping both wastes memory
	// and makes LRU eviction less useful. Partially overlapping ranges remain
	// separate; a later request can still be served by either containing range.
	kept := c.ranges[:0]
	for _, entry := range c.ranges {
		if start <= entry.start && end >= entry.end {
			c.bytes -= int64(len(entry.data))
			continue
		}
		kept = append(kept, entry)
	}
	c.ranges = kept
	c.counter++
	c.ranges = append(c.ranges, mediaCachedRange{start: start, end: end, data: copyData, used: c.counter})
	c.bytes += int64(len(copyData))

	for c.bytes > mediaSourceCacheCapacity && len(c.ranges) > 0 {
		oldest := 0
		for index := 1; index < len(c.ranges); index++ {
			if c.ranges[index].used < c.ranges[oldest].used {
				oldest = index
			}
		}
		c.bytes -= int64(len(c.ranges[oldest].data))
		c.ranges = append(c.ranges[:oldest], c.ranges[oldest+1:]...)
	}

	// Stable ordering makes diagnostics and tests deterministic.
	sort.SliceStable(c.ranges, func(left, right int) bool {
		return c.ranges[left].start < c.ranges[right].start
	})
}

func parseSingleByteRange(value string, size int64) (int64, int64, bool) {
	value = strings.TrimSpace(value)
	if size <= 0 || !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		return 0, 0, false
	}
	parts := strings.SplitN(strings.TrimPrefix(value, "bytes="), "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	left := strings.TrimSpace(parts[0])
	right := strings.TrimSpace(parts[1])
	if left == "" {
		suffix, err := strconv.ParseInt(right, 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false
		}
		if suffix > size {
			suffix = size
		}
		return size - suffix, size - 1, true
	}
	start, err := strconv.ParseInt(left, 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	end := size - 1
	if right != "" {
		end, err = strconv.ParseInt(right, 10, 64)
		if err != nil || end < start {
			return 0, 0, false
		}
		if end >= size {
			end = size - 1
		}
	}
	return start, end, true
}

func cachedMediaRangeAllowed(headers http.Header, source *mediaSourceRef) bool {
	for _, name := range []string{"If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"} {
		if strings.TrimSpace(headers.Get(name)) != "" {
			return false
		}
	}
	ifRange := strings.TrimSpace(headers.Get("If-Range"))
	if ifRange == "" {
		return true
	}
	if source == nil {
		return false
	}
	return (source.etag != "" && ifRange == source.etag) || (source.modified != "" && ifRange == source.modified)
}

func parseContentRangeStart(value string) (int64, bool) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "bytes ") {
		return 0, false
	}
	rangeAndSize := strings.TrimPrefix(value, "bytes ")
	rangePart, _, ok := strings.Cut(rangeAndSize, "/")
	if !ok {
		return 0, false
	}
	startText, _, ok := strings.Cut(rangePart, "-")
	if !ok {
		return 0, false
	}
	start, err := strconv.ParseInt(strings.TrimSpace(startText), 10, 64)
	return start, err == nil && start >= 0
}
