package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The size of the files of a volume. The usage of a volume says what the folder holds: the sum of the sizes of its
// regular files (the size of each file, not the blocks of the disk). A request never walks the tree: a sizer walks it
// in the background, one walk at a time, and the request gets the last count. A walk reads at most volumeSizeEntries
// entries in volumeSizeTime: a larger tree gives "partial" (at least the count). The count stays for volumeSizeTTL; a
// write of S3-Browser in the volume makes it old, so that the next read starts a new walk. A walk does not follow a
// symbolic link, and does not count the temporary files of S3-Browser.

const (
	// volumeSizeEntries is the largest number of entries that one walk reads.
	volumeSizeEntries = 1_000_000
	// volumeSizeTime is the longest time of one walk.
	volumeSizeTime = 20 * time.Second
	// volumeSizeTTL is the life of a complete count when nothing changes through S3-Browser.
	volumeSizeTTL = 5 * time.Minute

	volumeSizeComputing = "computing"
	volumeSizePartial   = "partial"
	volumeSizeReady     = "ready"
)

// volumeSizeCount is a count of the size of the files of a volume: the bytes, the files, the state and the time.
type volumeSizeCount struct {
	bytes int64
	files int64
	state string
	at    time.Time
}

type volumeSizer struct {
	root string
	// entries and timeout are volumeSizeEntries and volumeSizeTime. Tests set smaller values.
	entries int64
	timeout time.Duration

	mu      sync.Mutex
	last    volumeSizeCount
	running bool
	// progress is the count of the walk that runs.
	progress volumeSizeCount
	// stale is set by a write: the next read starts a new walk.
	stale bool
	// done is closed at the end of each walk. Tests wait for it.
	done chan struct{}
}

func newVolumeSizer(root string) *volumeSizer {
	return &volumeSizer{root: root, entries: volumeSizeEntries, timeout: volumeSizeTime, done: make(chan struct{})}
}

// invalidate makes the count old: a write changed the files.
func (s *volumeSizer) invalidate() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.stale = true
	s.mu.Unlock()
}

// snapshot gives the count for a read of the usage, and starts a walk when the count is old and no walk runs. While a
// walk runs, the count is its progress: "computing", at least these bytes.
func (s *volumeSizer) snapshot() volumeSizeCount {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.last.state == "" || s.stale || timeNowUTC().Sub(s.last.at) >= volumeSizeTTL
	if old && !s.running {
		s.running, s.stale = true, false
		s.progress = volumeSizeCount{state: volumeSizeComputing, at: timeNowUTC()}
		go s.walk()
	}
	if s.running {
		return s.progress
	}
	return s.last
}

// wait gives the channel that closes at the end of the walk that runs, or of the next walk.
func (s *volumeSizer) wait() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

// walk counts the files of the root and keeps the count.
func (s *volumeSizer) walk() {
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()
	visited := int64(0)
	count := volumeSizeCount{state: volumeSizeComputing}
	err := s.walkFolder(ctx, s.root, &visited, &count)
	count.at = timeNowUTC()
	count.state = volumeSizeReady
	if err != nil {
		count.state = volumeSizePartial
	}
	s.mu.Lock()
	s.last, s.running = count, false
	done := s.done
	s.done = make(chan struct{})
	s.mu.Unlock()
	close(done)
}

var errVolumeSizeBudget = errors.New("the count of the volume reached its budget")

func (s *volumeSizer) walkFolder(ctx context.Context, real string, visited *int64, count *volumeSizeCount) error {
	folder, err := os.Open(real)
	if err != nil {
		// A folder that the process cannot read counts nothing: the count stays complete for what it can read.
		return nil
	}
	defer folder.Close()
	for {
		batch, readErr := folder.ReadDir(1024)
		for _, item := range batch {
			if err := ctx.Err(); err != nil {
				return err
			}
			if *visited++; *visited > s.entries {
				return errVolumeSizeBudget
			}
			mode := item.Type()
			switch {
			case mode.IsDir():
				if err := s.walkFolder(ctx, filepath.Join(real, item.Name()), visited, count); err != nil {
					return err
				}
			case mode.IsRegular():
				if _, temporary := parseVolumeTempName(item.Name()); temporary {
					continue
				}
				if info, err := item.Info(); err == nil {
					count.bytes += info.Size()
					count.files++
				}
			}
		}
		if readErr != nil {
			break
		}
		s.mu.Lock()
		s.progress = volumeSizeCount{bytes: count.bytes, files: count.files, state: volumeSizeComputing, at: timeNowUTC()}
		s.mu.Unlock()
	}
	s.mu.Lock()
	s.progress = volumeSizeCount{bytes: count.bytes, files: count.files, state: volumeSizeComputing, at: timeNowUTC()}
	s.mu.Unlock()
	return nil
}
