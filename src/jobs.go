package main

import (
	"container/heap"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxStatsLargestEntries = 1000
	maxStatsFolderDepth    = 5
	statsLayoutVersion     = 2
)

type statsEntryHeap []statsEntry

func (h statsEntryHeap) Len() int { return len(h) }
func (h statsEntryHeap) Less(i, j int) bool {
	if h[i].Bytes != h[j].Bytes {
		return h[i].Bytes < h[j].Bytes
	}
	return h[i].Path > h[j].Path
}
func (h statsEntryHeap) Swap(i, j int)   { h[i], h[j] = h[j], h[i] }
func (h *statsEntryHeap) Push(value any) { *h = append(*h, value.(statsEntry)) }
func (h *statsEntryHeap) Pop() any {
	old := *h
	last := len(old) - 1
	value := old[last]
	*h = old[:last]
	return value
}

func addLargestStatsEntry(entries *[]statsEntry, entry statsEntry) {
	if entries == nil || entry.Bytes < 0 || entry.Path == "" {
		return
	}
	h := (*statsEntryHeap)(entries)
	if h.Len() < maxStatsLargestEntries {
		heap.Push(h, entry)
		return
	}
	if h.Len() == 0 {
		return
	}
	minimum := (*h)[0]
	if entry.Bytes < minimum.Bytes || (entry.Bytes == minimum.Bytes && entry.Path >= minimum.Path) {
		return
	}
	heap.Pop(h)
	heap.Push(h, entry)
}

const (
	jobTypeCopyPrefix   = "copy_prefix"
	jobTypeMovePrefix   = "move_prefix"
	jobTypeDeletePrefix = "delete_prefix"
	jobTypeStatsPrefix  = "stats_prefix"

	jobStatusQueued    = "queued"
	jobStatusRunning   = "running"
	jobStatusPaused    = "paused"
	jobStatusCompleted = "completed"
	jobStatusFailed    = "failed"
	jobStatusCanceled  = "canceled"
)

var (
	errJobPaused   = errors.New("job paused")
	errJobCanceled = errors.New("job canceled")
)

type persistentJob struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Instance  string         `json:"instance"`
	Source    string         `json:"source,omitempty"`
	Target    string         `json:"target,omitempty"`
	Prefix    string         `json:"prefix,omitempty"`
	Status    string         `json:"status"`
	Processed int64          `json:"processed"`
	LastKey   string         `json:"last_key,omitempty"`
	Stats     *statsResponse `json:"stats,omitempty"`
	Error     string         `json:"error,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	StartedAt *time.Time     `json:"started_at,omitempty"`
	EndedAt   *time.Time     `json:"ended_at,omitempty"`
}

type publicJob struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Instance  string         `json:"instance"`
	Source    string         `json:"source,omitempty"`
	Target    string         `json:"target,omitempty"`
	Prefix    string         `json:"prefix,omitempty"`
	Status    string         `json:"status"`
	Processed int64          `json:"processed"`
	LastKey   string         `json:"lastKey,omitempty"`
	Stats     *statsResponse `json:"stats,omitempty"`
	Error     string         `json:"error,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`
	StartedAt *time.Time     `json:"startedAt,omitempty"`
	EndedAt   *time.Time     `json:"endedAt,omitempty"`
}

func (j persistentJob) public() publicJob {
	return publicJob{
		ID:        j.ID,
		Type:      j.Type,
		Instance:  j.Instance,
		Source:    j.Source,
		Target:    j.Target,
		Prefix:    j.Prefix,
		Status:    j.Status,
		Processed: j.Processed,
		LastKey:   j.LastKey,
		Stats:     cloneStatsForPublic(j.Stats),
		Error:     j.Error,
		CreatedAt: j.CreatedAt,
		UpdatedAt: j.UpdatedAt,
		StartedAt: cloneTimePointer(j.StartedAt),
		EndedAt:   cloneTimePointer(j.EndedAt),
	}
}

func cloneStats(stats *statsResponse) *statsResponse {
	if stats == nil {
		return nil
	}
	copyStats := *stats
	copyStats.ByType = cloneAggregateMap(stats.ByType)
	copyStats.ByFolder = cloneAggregateMap(stats.ByFolder)
	copyStats.Largest = append([]statsEntry(nil), stats.Largest...)
	copyStats.Newest = cloneTimePointer(stats.Newest)
	copyStats.Oldest = cloneTimePointer(stats.Oldest)
	return &copyStats
}

func cloneStatsForPublic(stats *statsResponse) *statsResponse {
	copyStats := cloneStats(stats)
	if copyStats == nil {
		return nil
	}
	sort.SliceStable(copyStats.Largest, func(i, j int) bool {
		if copyStats.Largest[i].Bytes != copyStats.Largest[j].Bytes {
			return copyStats.Largest[i].Bytes > copyStats.Largest[j].Bytes
		}
		return copyStats.Largest[i].Path < copyStats.Largest[j].Path
	})
	return copyStats
}

func cloneAggregateMap(source map[string]aggregate) map[string]aggregate {
	if source == nil {
		return nil
	}
	out := make(map[string]aggregate, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func clonePersistentJob(job persistentJob) persistentJob {
	job.Stats = cloneStats(job.Stats)
	job.StartedAt = cloneTimePointer(job.StartedAt)
	job.EndedAt = cloneTimePointer(job.EndedAt)
	return job
}

type jobManager struct {
	app          *application
	dir          string
	ctx          context.Context
	cancel       context.CancelFunc
	queue        chan string
	mu           sync.RWMutex
	jobs         map[string]*persistentJob
	lockMu       sync.Mutex
	locks        map[string]*sync.Mutex
	wg           sync.WaitGroup
	historyLimit int
}

func newJobManager(app *application, dataDir string, historyLimits ...int) (*jobManager, error) {
	dir := filepath.Join(dataDir, "jobs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create job state directory: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	historyLimit := 100
	if len(historyLimits) > 0 && historyLimits[0] > 0 {
		historyLimit = historyLimits[0]
	}
	manager := &jobManager{
		app:          app,
		historyLimit: historyLimit,
		dir:          dir,
		ctx:          ctx,
		cancel:       cancel,
		queue:        make(chan string, 1024),
		jobs:         make(map[string]*persistentJob),
		locks:        make(map[string]*sync.Mutex),
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("read job state directory: %w", err)
	}
	var recoverIDs []string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			cancel()
			return nil, fmt.Errorf("read job state %q: %w", entry.Name(), err)
		}
		var job persistentJob
		if err := json.Unmarshal(data, &job); err != nil {
			cancel()
			return nil, fmt.Errorf("decode job state %q: %w", entry.Name(), err)
		}
		if job.ID == "" || job.Instance == "" || job.Type == "" {
			cancel()
			return nil, fmt.Errorf("job state %q is incomplete", entry.Name())
		}
		if _, ok := app.instances[job.Instance]; !ok {
			cancel()
			return nil, fmt.Errorf("job state %q references unknown instance %q", entry.Name(), job.Instance)
		}
		if job.Status == jobStatusRunning {
			job.Status = jobStatusQueued
			job.Error = ""
			job.UpdatedAt = time.Now().UTC()
			recoverIDs = append(recoverIDs, job.ID)
		} else if job.Status == jobStatusQueued {
			recoverIDs = append(recoverIDs, job.ID)
		}
		copyJob := clonePersistentJob(job)
		manager.jobs[job.ID] = &copyJob
		if job.Status == jobStatusQueued {
			if err := manager.persist(job); err != nil {
				cancel()
				return nil, err
			}
		}
	}
	if err := manager.pruneHistory(); err != nil {
		cancel()
		return nil, err
	}
	for worker := 0; worker < 2; worker++ {
		manager.wg.Add(1)
		go manager.worker()
	}
	for _, id := range recoverIDs {
		manager.enqueue(id)
	}
	return manager, nil
}

func (m *jobManager) close() {
	if m == nil {
		return
	}
	m.cancel()
	m.wg.Wait()
}

func (m *jobManager) jobLock(id string) *sync.Mutex {
	m.lockMu.Lock()
	defer m.lockMu.Unlock()
	lock := m.locks[id]
	if lock == nil {
		lock = &sync.Mutex{}
		m.locks[id] = lock
	}
	return lock
}

func (m *jobManager) get(id string) (persistentJob, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	job, ok := m.jobs[id]
	if !ok {
		return persistentJob{}, false
	}
	return clonePersistentJob(*job), true
}

func (m *jobManager) put(job persistentJob) error {
	copyJob := clonePersistentJob(job)
	m.mu.Lock()
	m.jobs[job.ID] = &copyJob
	m.mu.Unlock()
	return m.persist(job)
}

func (m *jobManager) persist(job persistentJob) error {
	data, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return fmt.Errorf("encode job state: %w", err)
	}
	temporary, err := os.CreateTemp(m.dir, job.ID+"-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary job state: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect job state: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return fmt.Errorf("write job state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync job state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close job state: %w", err)
	}
	if err := os.Rename(temporaryName, filepath.Join(m.dir, job.ID+".json")); err != nil {
		return fmt.Errorf("replace job state: %w", err)
	}
	return nil
}

func terminalJobStatus(status string) bool {
	switch status {
	case jobStatusCompleted, jobStatusFailed, jobStatusCanceled:
		return true
	default:
		return false
	}
}

func (m *jobManager) pruneHistory() error {
	if m == nil || m.historyLimit <= 0 {
		return nil
	}
	m.mu.Lock()
	terminal := make([]*persistentJob, 0, len(m.jobs))
	for _, job := range m.jobs {
		if terminalJobStatus(job.Status) {
			terminal = append(terminal, job)
		}
	}
	sort.Slice(terminal, func(i, j int) bool {
		if !terminal[i].UpdatedAt.Equal(terminal[j].UpdatedAt) {
			return terminal[i].UpdatedAt.After(terminal[j].UpdatedAt)
		}
		return terminal[i].ID > terminal[j].ID
	})
	if len(terminal) <= m.historyLimit {
		m.mu.Unlock()
		return nil
	}
	remove := append([]*persistentJob(nil), terminal[m.historyLimit:]...)
	for _, job := range remove {
		delete(m.jobs, job.ID)
	}
	m.mu.Unlock()

	var firstErr error
	for _, job := range remove {
		if err := os.Remove(filepath.Join(m.dir, job.ID+".json")); err != nil && !errors.Is(err, os.ErrNotExist) && firstErr == nil {
			firstErr = fmt.Errorf("remove expired job state %q: %w", job.ID, err)
		}
		m.lockMu.Lock()
		delete(m.locks, job.ID)
		m.lockMu.Unlock()
	}
	return firstErr
}

func (m *jobManager) list(instance string) []publicJob {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]publicJob, 0, len(m.jobs))
	for _, job := range m.jobs {
		if instance != "" && job.Instance != instance {
			continue
		}
		out = append(out, job.public())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

func (m *jobManager) create(job persistentJob) (persistentJob, error) {
	if _, ok := m.app.instances[job.Instance]; !ok {
		return persistentJob{}, apiError{Status: http.StatusNotFound, Code: "unknown_instance", Message: "storage instance was not found"}
	}
	now := time.Now().UTC()
	job.ID = newStateID("job")
	job.Status = jobStatusQueued
	job.CreatedAt = now
	job.UpdatedAt = now
	job.Error = ""
	if job.Type == jobTypeStatsPrefix && job.Stats == nil {
		job.Stats = newStatsResponse(job.Instance, job.Prefix)
	}
	if err := m.put(job); err != nil {
		return persistentJob{}, err
	}
	m.enqueue(job.ID)
	return job, nil
}

func (m *jobManager) enqueue(id string) {
	select {
	case m.queue <- id:
	case <-m.ctx.Done():
	}
}

func (m *jobManager) worker() {
	defer m.wg.Done()
	for {
		select {
		case <-m.ctx.Done():
			return
		case id := <-m.queue:
			m.run(id)
		}
	}
}

func (m *jobManager) run(id string) {
	// The execution lock serializes duplicate queue entries. Status controls do
	// not take this lock so pause and cancel remain responsive while a provider
	// request is in flight.
	lock := m.jobLock(id)
	lock.Lock()
	defer lock.Unlock()

	job, ok := m.get(id)
	if !ok || job.Status != jobStatusQueued {
		return
	}
	now := time.Now().UTC()
	job.Status = jobStatusRunning
	job.Error = ""
	job.UpdatedAt = now
	if job.StartedAt == nil {
		job.StartedAt = &now
	}
	if err := m.put(job); err != nil {
		return
	}

	err := m.execute(&job)
	latest, ok := m.get(id)
	if ok {
		job = latest
	}
	if errors.Is(err, errJobPaused) || job.Status == jobStatusPaused {
		return
	}
	if errors.Is(err, errJobCanceled) || job.Status == jobStatusCanceled {
		return
	}
	if errors.Is(err, context.Canceled) && m.ctx.Err() != nil {
		job.Status = jobStatusQueued
		job.Error = ""
		job.UpdatedAt = time.Now().UTC()
		job.EndedAt = nil
		_ = m.put(job)
		return
	}
	end := time.Now().UTC()
	job.UpdatedAt = end
	job.EndedAt = &end
	if err != nil {
		job.Status = jobStatusFailed
		job.Error = publicJobError(err)
	} else {
		job.Status = jobStatusCompleted
		job.Error = ""
		if job.Stats != nil && job.StartedAt != nil {
			job.Stats.TookMS = end.Sub(*job.StartedAt).Milliseconds()
		}
	}
	_ = m.put(job)
	_ = m.pruneHistory()
}

func publicJobError(err error) string {
	if err == nil {
		return ""
	}
	var apiErr apiError
	if errors.As(err, &apiErr) {
		return apiErr.Message
	}
	return publicStorageError(err)
}

func (m *jobManager) execute(job *persistentJob) error {
	instance := m.app.instances[job.Instance]
	switch job.Type {
	case jobTypeCopyPrefix:
		for _, permission := range []string{permissionRead, permissionWrite} {
			if err := requirePermission(instance, permission); err != nil {
				return err
			}
		}
		return m.runObjectJob(job, instance, func(ctx context.Context, object objectInfo, relative string) error {
			destination := job.Target + strings.TrimPrefix(relative, job.Source)
			return instance.backend.Copy(ctx, instance.fullKey(relative), instance.fullKey(destination))
		})
	case jobTypeMovePrefix:
		for _, permission := range []string{permissionRead, permissionWrite, permissionDelete} {
			if err := requirePermission(instance, permission); err != nil {
				return err
			}
		}
		return m.runObjectJob(job, instance, func(ctx context.Context, object objectInfo, relative string) error {
			destination := job.Target + strings.TrimPrefix(relative, job.Source)
			if err := instance.backend.Copy(ctx, instance.fullKey(relative), instance.fullKey(destination)); err != nil {
				return err
			}
			return instance.backend.Delete(ctx, instance.fullKey(relative))
		})
	case jobTypeDeletePrefix:
		for _, permission := range []string{permissionRead, permissionDelete} {
			if err := requirePermission(instance, permission); err != nil {
				return err
			}
		}
		return m.runObjectJob(job, instance, func(ctx context.Context, object objectInfo, relative string) error {
			return instance.backend.Delete(ctx, instance.fullKey(relative))
		})
	case jobTypeStatsPrefix:
		if err := requirePermission(instance, permissionRead); err != nil {
			return err
		}
		// Older persisted statistics did not retain exact aggregates for every
		// displayed folder level. Restart those jobs once so local "Others"
		// rectangles can report exact byte and object totals.
		if job.Stats == nil || job.Stats.LayoutVersion != statsLayoutVersion {
			job.Processed = 0
			job.LastKey = ""
			job.Stats = newStatsResponse(job.Instance, job.Prefix)
			if err := m.put(*job); err != nil {
				return err
			}
		}
		largest := (*statsEntryHeap)(&job.Stats.Largest)
		heap.Init(largest)
		return m.runObjectJob(job, instance, func(_ context.Context, object objectInfo, relative string) error {
			if strings.HasSuffix(relative, "/") && object.Size == 0 {
				return nil
			}
			stats := job.Stats
			stats.Count++
			stats.TotalBytes += object.Size
			kind := detectKind(relative, object.ContentType)
			typeAggregate := stats.ByType[kind]
			typeAggregate.Count++
			typeAggregate.Bytes += object.Size
			stats.ByType[kind] = typeAggregate
			modified := ""
			if !object.LastModified.IsZero() {
				modified = object.LastModified.UTC().Format(time.RFC3339)
			}
			addLargestStatsEntry(&stats.Largest, statsEntry{
				Path:         relative,
				Bytes:        object.Size,
				Type:         kind,
				MIME:         object.ContentType,
				ETag:         object.ETag,
				LastModified: modified,
			})

			addStatsFolderAggregates(stats, job.Prefix, relative, object.Size)

			if !object.LastModified.IsZero() {
				modified := object.LastModified
				if stats.Newest == nil || modified.After(*stats.Newest) {
					stats.Newest = cloneTimePointer(&modified)
				}
				if stats.Oldest == nil || modified.Before(*stats.Oldest) {
					stats.Oldest = cloneTimePointer(&modified)
				}
			}
			return nil
		})
	default:
		return fmt.Errorf("unknown job type %q", job.Type)
	}
}

func newStatsResponse(instance, prefix string) *statsResponse {
	return &statsResponse{
		Instance:      instance,
		Prefix:        prefix,
		LayoutVersion: statsLayoutVersion,
		ByType:        make(map[string]aggregate),
		ByFolder:      make(map[string]aggregate),
	}
}

// addStatsFolderAggregates records exact totals for each ancestor folder that
// may appear in the five-level treemap. Keys are relative to the selected
// prefix, so the frontend can attach a local "Others" rectangle to every
// folder without retaining every object as an individual node.
func addStatsFolderAggregates(stats *statsResponse, prefix, relative string, size int64) {
	if stats == nil {
		return
	}
	remaining := strings.TrimPrefix(relative, prefix)
	parts := strings.Split(remaining, "/")
	folderCount := len(parts) - 1
	if folderCount <= 0 {
		return
	}
	if folderCount > maxStatsFolderDepth {
		folderCount = maxStatsFolderDepth
	}
	for depth := 1; depth <= folderCount; depth++ {
		folder := strings.Join(parts[:depth], "/") + "/"
		value := stats.ByFolder[folder]
		value.Count++
		value.Bytes += size
		stats.ByFolder[folder] = value
	}
}

func (m *jobManager) runObjectJob(job *persistentJob, instance *storageInstance, operation func(context.Context, objectInfo, string) error) error {
	prefix := job.Prefix
	if prefix == "" {
		prefix = job.Source
	}
	processedThisRun := int64(0)
	lastCheckpoint := time.Now()
	err := forEachObjectAfter(m.ctx, instance, prefix, job.LastKey, func(object objectInfo, relative string) error {
		if err := m.controlState(job.ID); err != nil {
			return err
		}
		if err := operation(m.ctx, object, relative); err != nil {
			return err
		}
		job.Processed++
		processedThisRun++
		job.LastKey = relative
		job.UpdatedAt = time.Now().UTC()
		latest, ok := m.get(job.ID)
		if ok {
			job.Status = latest.Status
			job.EndedAt = cloneTimePointer(latest.EndedAt)
			// A resume request can change paused to queued before the active
			// worker observes the pause. That worker already owns the execution
			// lock, so it can safely continue without starting a duplicate run.
			if job.Status == jobStatusQueued {
				job.Status = jobStatusRunning
			}
		}
		forceCheckpoint := job.Type != jobTypeStatsPrefix ||
			processedThisRun%100 == 0 ||
			time.Since(lastCheckpoint) >= time.Second ||
			job.Status == jobStatusPaused ||
			job.Status == jobStatusCanceled
		if forceCheckpoint {
			if err := m.put(*job); err != nil {
				return err
			}
			lastCheckpoint = time.Now()
		}
		switch job.Status {
		case jobStatusPaused:
			return errJobPaused
		case jobStatusCanceled:
			return errJobCanceled
		}
		return nil
	})
	if err != nil {
		return err
	}
	if job.Type == jobTypeStatsPrefix && processedThisRun > 0 {
		if err := m.put(*job); err != nil {
			return err
		}
	}
	if job.Processed == 0 && processedThisRun == 0 && job.Type != jobTypeStatsPrefix {
		return apiError{Status: http.StatusNotFound, Code: "empty_prefix", Message: "source prefix contains no objects"}
	}
	return nil
}

func (m *jobManager) controlState(id string) error {
	job, ok := m.get(id)
	if !ok {
		return errJobCanceled
	}
	switch job.Status {
	case jobStatusPaused:
		return errJobPaused
	case jobStatusCanceled:
		return errJobCanceled
	}
	select {
	case <-m.ctx.Done():
		return m.ctx.Err()
	default:
		return nil
	}
}

func forEachObjectAfter(ctx context.Context, instance *storageInstance, prefix, lastKey string, callback func(objectInfo, string) error) error {
	fullPrefix := instance.fullKey(prefix)
	for {
		options := listOptions{Prefix: fullPrefix, Delimiter: "", MaxResults: 1000}
		if lastKey != "" {
			options.StartAfter = instance.fullKey(lastKey)
		}
		page, err := instance.backend.List(ctx, options)
		if err != nil {
			return err
		}
		sort.Slice(page.Objects, func(i, j int) bool { return page.Objects[i].Key < page.Objects[j].Key })
		progressed := false
		for _, object := range page.Objects {
			relative, ok := instance.relativeKey(object.Key)
			if !ok || relative == "" || !strings.HasPrefix(relative, prefix) || (lastKey != "" && relative <= lastKey) {
				continue
			}
			if err := callback(object, relative); err != nil {
				return err
			}
			lastKey = relative
			progressed = true
		}
		if !progressed || (page.NextPageToken == "" && len(page.Objects) < options.MaxResults) {
			return nil
		}
	}
}

func (m *jobManager) changeStatus(id, action string) (persistentJob, error) {
	job, ok := m.get(id)
	if !ok {
		return persistentJob{}, apiError{Status: http.StatusNotFound, Code: "job_not_found", Message: "job was not found"}
	}
	now := time.Now().UTC()
	switch action {
	case "pause":
		if job.Status != jobStatusQueued && job.Status != jobStatusRunning {
			return persistentJob{}, apiError{Status: http.StatusConflict, Code: "job_not_active", Message: "only queued or running jobs can be paused"}
		}
		job.Status = jobStatusPaused
	case "resume":
		if job.Status != jobStatusPaused && job.Status != jobStatusFailed {
			return persistentJob{}, apiError{Status: http.StatusConflict, Code: "job_not_resumable", Message: "only paused or failed jobs can be resumed"}
		}
		job.Status = jobStatusQueued
		job.Error = ""
		job.EndedAt = nil
	case "cancel":
		if job.Status == jobStatusCompleted || job.Status == jobStatusCanceled {
			return job, nil
		}
		job.Status = jobStatusCanceled
		job.Error = ""
		job.EndedAt = &now
	default:
		return persistentJob{}, apiError{Status: http.StatusBadRequest, Code: "invalid_job_action", Message: "unknown job action"}
	}
	job.UpdatedAt = now
	if err := m.put(job); err != nil {
		return persistentJob{}, err
	}
	if action == "cancel" {
		_ = m.pruneHistory()
	}
	if action == "resume" {
		m.enqueue(job.ID)
	}
	return job, nil
}

func validatePrefixOperation(source, target string) (string, string, error) {
	source = normalizePrefix(cleanRelativeKey(source))
	target = normalizePrefix(cleanRelativeKey(target))
	if source == "" || target == "" {
		return "", "", apiError{Status: http.StatusBadRequest, Code: "invalid_path", Message: "src and dst are required"}
	}
	if source == target {
		return "", "", apiError{Status: http.StatusBadRequest, Code: "same_path", Message: "src and dst must be different"}
	}
	if strings.HasPrefix(target, source) {
		return "", "", apiError{Status: http.StatusBadRequest, Code: "recursive_destination", Message: "destination cannot be inside source prefix"}
	}
	if strings.HasPrefix(source, target) {
		return "", "", apiError{Status: http.StatusBadRequest, Code: "overlapping_prefixes", Message: "destination cannot contain source prefix because object paths would overlap"}
	}
	return source, target, nil
}

func (a *application) handleJobs(w http.ResponseWriter, r *http.Request) {
	if a.jobs == nil {
		writeAPIError(w, fmt.Errorf("job manager is not initialized"))
		return
	}
	if r.URL.Path == "/api/jobs" || r.URL.Path == "/api/jobs/" {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobs": a.jobs.list(strings.TrimSpace(r.URL.Query().Get("instance")))})
		return
	}

	remainder := strings.TrimPrefix(r.URL.Path, "/api/jobs/")
	parts := strings.Split(remainder, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "job_not_found", Message: "job was not found"})
		return
	}
	id := parts[0]
	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		job, ok := a.jobs.get(id)
		if !ok {
			writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "job_not_found", Message: "job was not found"})
			return
		}
		writeJSON(w, http.StatusOK, job.public())
		return
	}
	if len(parts) != 2 || r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	job, err := a.jobs.changeStatus(id, parts[1])
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, job.public())
}
