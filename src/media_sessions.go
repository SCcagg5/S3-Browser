package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	mediaSessionIdleTimeout           = 20 * time.Second
	mediaSourceIdleTimeout            = 30 * time.Second
	mediaCleanupInterval              = 2 * time.Second
	mediaProbeTimeout                 = 35 * time.Second
	mediaProbeByteBudget        int64 = 128 << 20
	mediaSegmentSeconds               = 6
	mediaWindowSegments               = 4
	mediaWindowSeconds                = mediaSegmentSeconds * mediaWindowSegments
	mediaSegmentWaitTimeout           = 2 * time.Minute
	mediaWindowProcessTimeout         = 110 * time.Second
	mediaMaxConcurrentProcesses       = 1
	mediaWindowIdleTimeout            = 60 * time.Second
	mediaMaxRetainedWindows           = 3
	mediaVideoMaxWidth                = 1920
	mediaVideoThreads                 = 1
)

type mediaProbeResponse struct {
	Available       bool              `json:"available"`
	Instance        string            `json:"instance,omitempty"`
	Key             string            `json:"key,omitempty"`
	Container       string            `json:"container,omitempty"`
	DurationSeconds float64           `json:"durationSeconds,omitempty"`
	Tracks          []mediaTrackInfo  `json:"tracks,omitempty"`
	Tags            map[string]string `json:"tags,omitempty"`
	Error           string            `json:"error,omitempty"`
}

type mediaSessionStatus struct {
	ID              string           `json:"id"`
	Instance        string           `json:"instance"`
	Key             string           `json:"key"`
	State           string           `json:"state"`
	MasterURL       string           `json:"masterUrl,omitempty"`
	DurationSeconds float64          `json:"durationSeconds,omitempty"`
	SegmentSeconds  int              `json:"segmentSeconds"`
	Tracks          []mediaTrackInfo `json:"tracks,omitempty"`
	UpdatedAt       time.Time        `json:"updatedAt"`
	Error           string           `json:"error,omitempty"`
}

type mediaSourceRef struct {
	instance *storageInstance
	key      string
	size     int64
	mime     string
	etag     string
	modified string

	expiresAt        atomic.Int64
	byteBudget       atomic.Int64
	providerBytes    atomic.Int64
	providerRequests atomic.Int64
	cache            mediaRangeCache
	fetchMu          sync.Mutex
}

type mediaWindowJob struct {
	mu         sync.RWMutex
	directory  string
	done       chan struct{}
	err        error
	startedAt  time.Time
	lastAccess time.Time
	cancel     context.CancelFunc
}

type mediaSession struct {
	mu              sync.RWMutex
	id              string
	instanceID      string
	key             string
	directory       string
	sourceToken     string
	durationSeconds float64
	tracks          []mediaTrackInfo
	videoTrack      *mediaTrackInfo
	audioTracks     []mediaTrackInfo
	textSubtitles   []mediaTrackInfo
	burnSubtitles   []mediaTrackInfo
	state           string
	errorMessage    string
	updatedAt       time.Time
	ctx             context.Context
	cancel          context.CancelFunc
	windows         map[string]*mediaWindowJob
	watchers        int
	watchGeneration uint64
}

type mediaSessionManager struct {
	app         *application
	root        string
	ffmpegPath  string
	ffprobePath string
	mu          sync.RWMutex
	sessions    map[string]*mediaSession
	sources     map[string]*mediaSourceRef
	processes   chan struct{}
	closed      chan struct{}
	closeOnce   sync.Once
}

func newMediaSessionManager(app *application, dataDir string) (*mediaSessionManager, error) {
	root := filepath.Join(dataDir, "media-sessions")
	// Media session files are active playback buffers, never a reusable cache.
	// Clear leftovers from a previous process before accepting requests.
	if err := os.RemoveAll(root); err != nil {
		return nil, fmt.Errorf("clear media session directory: %w", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create media session directory: %w", err)
	}
	manager := &mediaSessionManager{
		app:       app,
		root:      root,
		sessions:  make(map[string]*mediaSession),
		sources:   make(map[string]*mediaSourceRef),
		processes: make(chan struct{}, mediaMaxConcurrentProcesses),
		closed:    make(chan struct{}),
	}
	manager.ffmpegPath, _ = exec.LookPath("ffmpeg")
	manager.ffprobePath, _ = exec.LookPath("ffprobe")
	go manager.cleanupLoop()
	return manager, nil
}

func (m *mediaSessionManager) available() bool {
	return m != nil && m.ffmpegPath != "" && m.ffprobePath != ""
}

func (m *mediaSessionManager) close() {
	if m == nil {
		return
	}
	m.closeOnce.Do(func() {
		close(m.closed)
		m.mu.Lock()
		sessions := make([]*mediaSession, 0, len(m.sessions))
		for _, session := range m.sessions {
			sessions = append(sessions, session)
		}
		m.sessions = make(map[string]*mediaSession)
		m.sources = make(map[string]*mediaSourceRef)
		m.mu.Unlock()
		for _, session := range sessions {
			m.stopSession(session)
		}
		_ = os.RemoveAll(m.root)
	})
}

func (m *mediaSessionManager) cleanupLoop() {
	ticker := time.NewTicker(mediaCleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.closed:
			return
		case <-ticker.C:
			m.cleanupExpired()
		}
	}
}

func (m *mediaSessionManager) cleanupExpired() {
	now := time.Now().UTC()
	var expired []*mediaSession
	var active []*mediaSession
	m.mu.Lock()
	for token, source := range m.sources {
		deadline := time.Unix(0, source.expiresAt.Load())
		if !deadline.IsZero() && now.After(deadline) {
			delete(m.sources, token)
		}
	}
	for id, session := range m.sessions {
		session.mu.RLock()
		stale := now.Sub(session.updatedAt) > mediaSessionIdleTimeout
		session.mu.RUnlock()
		if stale {
			delete(m.sessions, id)
			delete(m.sources, session.sourceToken)
			expired = append(expired, session)
		} else {
			active = append(active, session)
		}
	}
	m.mu.Unlock()
	for _, session := range expired {
		m.stopSession(session)
	}
	for _, session := range active {
		pruneMediaSessionWindows(session, now)
	}
}

func pruneMediaSessionWindows(session *mediaSession, now time.Time) {
	if session == nil {
		return
	}
	type candidate struct {
		key       string
		directory string
		last      time.Time
	}
	completed := make([]candidate, 0)
	remove := make([]candidate, 0)
	session.mu.Lock()
	for key, job := range session.windows {
		job.mu.RLock()
		last := job.lastAccess
		directory := job.directory
		done := false
		select {
		case <-job.done:
			done = true
		default:
		}
		job.mu.RUnlock()
		if !done {
			continue
		}
		entry := candidate{key: key, directory: directory, last: last}
		if !last.IsZero() && now.Sub(last) > mediaWindowIdleTimeout {
			delete(session.windows, key)
			remove = append(remove, entry)
			continue
		}
		completed = append(completed, entry)
	}
	if len(completed) > mediaMaxRetainedWindows {
		sort.Slice(completed, func(left, right int) bool { return completed[left].last.Before(completed[right].last) })
		for _, entry := range completed[:len(completed)-mediaMaxRetainedWindows] {
			delete(session.windows, entry.key)
			remove = append(remove, entry)
		}
	}
	session.mu.Unlock()
	for _, entry := range remove {
		_ = os.RemoveAll(entry.directory)
	}
}

func randomMediaID(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func (m *mediaSessionManager) registerSource(instance *storageInstance, key string, metadata mediaSourceMetadata, lifetime time.Duration, byteBudget int64) (string, error) {
	token, err := randomMediaID(24)
	if err != nil {
		return "", fmt.Errorf("generate media source token: %w", err)
	}
	source := &mediaSourceRef{
		instance: instance,
		key:      key,
		size:     metadata.Size,
		mime:     metadata.MIME,
		etag:     metadata.ETag,
		modified: metadata.LastModified,
	}
	source.byteBudget.Store(byteBudget)
	source.expiresAt.Store(time.Now().UTC().Add(lifetime).UnixNano())
	m.mu.Lock()
	m.sources[token] = source
	m.mu.Unlock()
	return token, nil
}

func (m *mediaSessionManager) removeSource(token string) {
	m.mu.Lock()
	delete(m.sources, token)
	m.mu.Unlock()
}

func (m *mediaSessionManager) touchSource(source *mediaSourceRef) {
	if source != nil {
		source.expiresAt.Store(time.Now().UTC().Add(mediaSourceIdleTimeout).UnixNano())
	}
}

type mediaSourceMetadata struct {
	Size         int64
	MIME         string
	ETag         string
	LastModified string
}

func internalMediaBaseURL(r *http.Request, configuredListen string) string {
	port := listenPort(configuredListen)
	if port == "" || port == "0" {
		if _, parsedPort, err := net.SplitHostPort(r.Host); err == nil {
			port = parsedPort
		}
	}
	if port == "" || port == "0" {
		port = "8080"
	}
	return "http://" + net.JoinHostPort("127.0.0.1", port)
}

func listenPort(address string) string {
	address = strings.TrimSpace(address)
	if address == "" {
		return ""
	}
	if _, port, err := net.SplitHostPort(address); err == nil {
		return port
	}
	if strings.HasPrefix(address, ":") {
		return strings.TrimSpace(strings.TrimPrefix(address, ":"))
	}
	return ""
}

func mediaSourceURL(baseURL, token string) string {
	return strings.TrimRight(baseURL, "/") + "/api/media-source/" + token
}

type ffprobeDocument struct {
	Streams []struct {
		Index         int               `json:"index"`
		CodecType     string            `json:"codec_type"`
		CodecName     string            `json:"codec_name"`
		CodecLongName string            `json:"codec_long_name"`
		Profile       string            `json:"profile"`
		PixelFormat   string            `json:"pix_fmt"`
		Width         int               `json:"width"`
		Height        int               `json:"height"`
		Channels      int               `json:"channels"`
		ChannelLayout string            `json:"channel_layout"`
		SampleRate    string            `json:"sample_rate"`
		BitRate       string            `json:"bit_rate"`
		FrameRate     string            `json:"avg_frame_rate"`
		Tags          map[string]string `json:"tags"`
		Disposition   struct {
			Default int `json:"default"`
			Forced  int `json:"forced"`
		} `json:"disposition"`
	} `json:"streams"`
	Format struct {
		FormatName string            `json:"format_name"`
		Duration   string            `json:"duration"`
		BitRate    string            `json:"bit_rate"`
		Tags       map[string]string `json:"tags"`
	} `json:"format"`
}

func (m *mediaSessionManager) probe(ctx context.Context, instance *storageInstance, key, baseURL string, metadata mediaSourceMetadata) (mediaProbeResponse, error) {
	response := mediaProbeResponse{Available: false, Instance: instance.cfg.ID, Key: key}
	if m == nil || m.ffprobePath == "" {
		response.Error = "Advanced media inspection requires ffprobe on the server."
		return response, nil
	}
	token, err := m.registerSource(instance, key, metadata, 2*time.Minute, mediaProbeByteBudget)
	if err != nil {
		return response, err
	}
	defer m.removeSource(token)
	return m.probeWithSource(ctx, instance, key, baseURL, token)
}

func (m *mediaSessionManager) probeWithSource(ctx context.Context, instance *storageInstance, key, baseURL, token string) (mediaProbeResponse, error) {
	response := mediaProbeResponse{Available: false, Instance: instance.cfg.ID, Key: key}
	if m == nil || m.ffprobePath == "" {
		response.Error = "Advanced media inspection requires ffprobe on the server."
		return response, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, mediaProbeTimeout)
	defer cancel()
	arguments := []string{
		"-v", "error",
		"-probesize", "16777216",
		"-analyzeduration", "10000000",
		"-show_entries", "format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,codec_long_name,profile,pix_fmt,width,height,channels,channel_layout,sample_rate,bit_rate,avg_frame_rate:stream_tags=language,title:stream_disposition=default,forced",
		"-of", "json",
		mediaSourceURL(baseURL, token),
	}
	command := exec.CommandContext(probeCtx, m.ffprobePath, arguments...)
	configureProcessGroup(command)
	var output bytes.Buffer
	var stderr limitedWriter
	stderr.limit = 64 << 10
	command.Stdout = &output
	command.Stderr = &stderr
	if err := runCommandWithContext(probeCtx, command); err != nil {
		if errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			return response, apiError{Status: http.StatusGatewayTimeout, Code: "media_probe_timeout", Message: "media inspection timed out"}
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = "the server could not inspect this media container"
		}
		response.Error = publicMediaToolError(message)
		return response, nil
	}
	var document ffprobeDocument
	if err := json.Unmarshal(output.Bytes(), &document); err != nil {
		return response, fmt.Errorf("decode ffprobe output: %w", err)
	}
	response.Available = true
	response.Container = document.Format.FormatName
	response.DurationSeconds, _ = strconv.ParseFloat(document.Format.Duration, 64)
	response.Tags = normalizeMediaTags(document.Format.Tags)
	for _, stream := range document.Streams {
		if stream.CodecType != "video" && stream.CodecType != "audio" && stream.CodecType != "subtitle" {
			continue
		}
		language := normalizeLanguage(stream.Tags["language"])
		title := strings.TrimSpace(stream.Tags["title"])
		label := title
		if label == "" {
			label = mediaTrackLabel(stream.CodecType, language, stream.Index)
		}
		sampleRate, _ := strconv.Atoi(stream.SampleRate)
		bitRate, _ := strconv.ParseInt(stream.BitRate, 10, 64)
		track := mediaTrackInfo{
			Index:         stream.Index,
			Type:          stream.CodecType,
			Codec:         stream.CodecName,
			CodecLongName: stream.CodecLongName,
			Profile:       stream.Profile,
			PixelFormat:   stream.PixelFormat,
			Language:      language,
			Title:         title,
			Label:         label,
			Width:         stream.Width,
			Height:        stream.Height,
			Channels:      stream.Channels,
			ChannelLayout: stream.ChannelLayout,
			SampleRate:    sampleRate,
			BitRate:       bitRate,
			FrameRate:     stream.FrameRate,
			Default:       stream.Disposition.Default == 1,
			Forced:        stream.Disposition.Forced == 1,
			SubtitleMode:  subtitlePlaybackMode(stream.CodecType, stream.CodecName),
		}
		response.Tracks = append(response.Tracks, track)
	}
	sortMediaTracks(response.Tracks)
	return response, nil
}

func sortMediaTracks(tracks []mediaTrackInfo) {
	order := map[string]int{"video": 0, "audio": 1, "subtitle": 2}
	sort.SliceStable(tracks, func(left, right int) bool {
		if order[tracks[left].Type] != order[tracks[right].Type] {
			return order[tracks[left].Type] < order[tracks[right].Type]
		}
		return tracks[left].Index < tracks[right].Index
	})
}

func normalizeMediaTags(tags map[string]string) map[string]string {
	out := make(map[string]string)
	labels := map[string]string{
		"title": "Title", "artist": "Artist", "album": "Album", "album_artist": "Album artist",
		"date": "Date", "year": "Year", "genre": "Genre", "track": "Track", "comment": "Comment",
		"encoder": "Encoder", "copyright": "Copyright",
	}
	for key, value := range tags {
		label := labels[strings.ToLower(strings.TrimSpace(key))]
		if label != "" && strings.TrimSpace(value) != "" {
			out[label] = strings.TrimSpace(value)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeLanguage(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "und" || value == "unknown" {
		return ""
	}
	if len(value) > 16 {
		value = value[:16]
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' {
			continue
		}
		return ""
	}
	return value
}

func mediaTrackLabel(kind, language string, index int) string {
	base := strings.TrimSpace(kind)
	if base != "" {
		base = strings.ToUpper(base[:1]) + base[1:]
	}
	if language != "" {
		return strings.ToUpper(language) + " · " + base
	}
	return fmt.Sprintf("%s %d", base, index+1)
}

func subtitlePlaybackMode(kind, codec string) string {
	if kind != "subtitle" {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(codec)) {
	case "subrip", "srt", "webvtt", "mov_text", "text", "ass", "ssa", "ttml",
		"microdvd", "sami", "realtext", "jacosub", "mpl2", "pjs", "subviewer",
		"subviewer1", "vplayer", "dvb_teletext", "eia_608", "cea_608", "cea_708",
		"arib_caption", "hdmv_text_subtitle":
		return "webvtt"
	default:
		// Bitmap subtitle streams (PGS, VobSub, DVB subtitles, XSUB, etc.)
		// cannot become selectable WebVTT without OCR. They are supported by
		// rendering the selected stream into only the requested video windows.
		return "burn"
	}
}

func filterMediaTracks(tracks []mediaTrackInfo, kind string) []mediaTrackInfo {
	out := make([]mediaTrackInfo, 0)
	for _, track := range tracks {
		if track.Type == kind {
			out = append(out, track)
		}
	}
	return out
}

func findTrack(tracks []mediaTrackInfo, index int, kind string) (mediaTrackInfo, bool) {
	for _, track := range tracks {
		if track.Index == index && (kind == "" || track.Type == kind) {
			return track, true
		}
	}
	return mediaTrackInfo{}, false
}

type createMediaSessionRequest struct {
	Instance     string `json:"instance"`
	Key          string `json:"key"`
	Size         int64  `json:"size,omitempty"`
	MIME         string `json:"mime,omitempty"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
}

func (m *mediaSessionManager) create(ctx context.Context, instance *storageInstance, request createMediaSessionRequest, baseURL string) (*mediaSession, error) {
	if !m.available() {
		return nil, apiError{Status: http.StatusNotImplemented, Code: "media_tools_unavailable", Message: "advanced media preview requires ffmpeg and ffprobe on the server"}
	}
	metadata := mediaSourceMetadata{Size: request.Size, MIME: request.MIME, ETag: request.ETag, LastModified: request.LastModified}
	// Probe and playback share one short-lived source token. Besides avoiding a
	// second provider HEAD, this lets the active-session range buffer reuse the
	// container header bytes that ffprobe already paid to read.
	sourceToken, err := m.registerSource(instance, request.Key, metadata, mediaSourceIdleTimeout, mediaProbeByteBudget)
	if err != nil {
		return nil, err
	}
	keepSource := false
	defer func() {
		if !keepSource {
			m.removeSource(sourceToken)
		}
	}()
	probe, err := m.probeWithSource(ctx, instance, request.Key, baseURL, sourceToken)
	if err != nil {
		return nil, err
	}
	if !probe.Available {
		return nil, apiError{Status: http.StatusUnprocessableEntity, Code: "media_probe_failed", Message: probe.Error}
	}
	m.mu.RLock()
	source := m.sources[sourceToken]
	m.mu.RUnlock()
	if source != nil {
		source.byteBudget.Store(0)
		m.touchSource(source)
	}
	videoTracks := filterMediaTracks(probe.Tracks, "video")
	audioTracks := filterMediaTracks(probe.Tracks, "audio")
	if len(videoTracks) == 0 && len(audioTracks) == 0 {
		return nil, apiError{Status: http.StatusUnprocessableEntity, Code: "media_streams_missing", Message: "the media container has no playable video or audio stream"}
	}
	if probe.DurationSeconds <= 0 || math.IsNaN(probe.DurationSeconds) || math.IsInf(probe.DurationSeconds, 0) {
		return nil, apiError{Status: http.StatusUnprocessableEntity, Code: "media_duration_missing", Message: "the media duration could not be determined without scanning the complete object"}
	}

	id, err := randomMediaID(16)
	if err != nil {
		return nil, err
	}
	directory := filepath.Join(m.root, id)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		m.removeSource(sourceToken)
		return nil, fmt.Errorf("create media session directory: %w", err)
	}
	sessionCtx, cancel := context.WithCancel(context.Background())
	session := &mediaSession{
		id:              id,
		instanceID:      instance.cfg.ID,
		key:             request.Key,
		directory:       directory,
		sourceToken:     sourceToken,
		durationSeconds: probe.DurationSeconds,
		tracks:          append([]mediaTrackInfo(nil), probe.Tracks...),
		audioTracks:     append([]mediaTrackInfo(nil), audioTracks...),
		state:           "ready",
		updatedAt:       time.Now().UTC(),
		ctx:             sessionCtx,
		cancel:          cancel,
		windows:         make(map[string]*mediaWindowJob),
	}
	if len(videoTracks) > 0 {
		track := videoTracks[0]
		session.videoTrack = &track
	}
	for _, track := range filterMediaTracks(probe.Tracks, "subtitle") {
		if track.SubtitleMode == "webvtt" {
			session.textSubtitles = append(session.textSubtitles, track)
		} else {
			session.burnSubtitles = append(session.burnSubtitles, track)
		}
	}
	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()
	keepSource = true
	return session, nil
}

func (m *mediaSessionManager) touchSession(session *mediaSession) {
	if session == nil {
		return
	}
	session.mu.Lock()
	session.updatedAt = time.Now().UTC()
	session.mu.Unlock()
	m.mu.RLock()
	source := m.sources[session.sourceToken]
	m.mu.RUnlock()
	m.touchSource(source)
}

func (m *mediaSessionManager) beginWatch(session *mediaSession) uint64 {
	if session == nil {
		return 0
	}
	session.mu.Lock()
	session.watchers++
	session.watchGeneration++
	generation := session.watchGeneration
	session.updatedAt = time.Now().UTC()
	session.mu.Unlock()
	return generation
}

func (m *mediaSessionManager) endWatch(session *mediaSession) {
	if session == nil {
		return
	}
	session.mu.Lock()
	if session.watchers > 0 {
		session.watchers--
	}
	session.watchGeneration++
	generation := session.watchGeneration
	watchers := session.watchers
	session.updatedAt = time.Now().UTC()
	session.mu.Unlock()
	if watchers != 0 {
		return
	}
	// Closing a browser tab closes the event stream immediately. A short grace
	// period tolerates network reconnects while still stopping FFmpeg far sooner
	// than the idle-timeout fallback.
	go func(sessionID string, expected uint64) {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-m.closed:
			return
		}
		current, ok := m.getSessionWithoutTouch(sessionID)
		if !ok {
			return
		}
		current.mu.RLock()
		shouldDelete := current.watchers == 0 && current.watchGeneration == expected
		current.mu.RUnlock()
		if shouldDelete {
			m.delete(sessionID)
		}
	}(session.id, generation)
}

func (m *mediaSessionManager) getSessionWithoutTouch(id string) (*mediaSession, bool) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	return session, ok
}

func (m *mediaSessionManager) sessionStatus(session *mediaSession) mediaSessionStatus {
	session.mu.RLock()
	defer session.mu.RUnlock()
	return mediaSessionStatus{
		ID:              session.id,
		Instance:        session.instanceID,
		Key:             session.key,
		State:           session.state,
		MasterURL:       fmt.Sprintf("/api/media-sessions/%s/master.m3u8", session.id),
		DurationSeconds: session.durationSeconds,
		SegmentSeconds:  mediaSegmentSeconds,
		Tracks:          append([]mediaTrackInfo(nil), session.tracks...),
		UpdatedAt:       session.updatedAt,
		Error:           session.errorMessage,
	}
}

func (m *mediaSessionManager) getSession(id string) (*mediaSession, bool) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if ok {
		m.touchSession(session)
	}
	return session, ok
}

func (m *mediaSessionManager) delete(id string) bool {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
		delete(m.sources, session.sourceToken)
	}
	m.mu.Unlock()
	if !ok {
		return false
	}
	m.stopSession(session)
	return true
}

func (m *mediaSessionManager) stopSession(session *mediaSession) {
	if session == nil {
		return
	}
	session.mu.Lock()
	if session.cancel != nil {
		session.cancel()
	}
	for _, job := range session.windows {
		job.mu.RLock()
		cancel := job.cancel
		job.mu.RUnlock()
		if cancel != nil {
			cancel()
		}
	}
	session.state = "canceled"
	session.updatedAt = time.Now().UTC()
	session.mu.Unlock()
	_ = os.RemoveAll(session.directory)
}

func mediaWindowKey(window int, burnIndex int) string {
	if burnIndex >= 0 {
		return fmt.Sprintf("burn-%d-%d", burnIndex, window)
	}
	return fmt.Sprintf("base-%d", window)
}

func (m *mediaSessionManager) ensureWindow(session *mediaSession, window, burnIndex int, baseURL string) *mediaWindowJob {
	key := mediaWindowKey(window, burnIndex)
	now := time.Now().UTC()
	session.mu.Lock()
	if job := session.windows[key]; job != nil {
		job.mu.Lock()
		job.lastAccess = now
		job.mu.Unlock()
		session.updatedAt = now
		session.mu.Unlock()
		return job
	}
	directory := filepath.Join(session.directory, key)
	_ = os.MkdirAll(directory, 0o700)
	jobCtx, cancel := context.WithCancel(session.ctx)
	job := &mediaWindowJob{directory: directory, done: make(chan struct{}), startedAt: now, lastAccess: now, cancel: cancel}
	session.windows[key] = job
	session.updatedAt = now
	session.mu.Unlock()
	go m.generateWindow(jobCtx, session, job, window, burnIndex, baseURL)
	return job
}

func (m *mediaSessionManager) generateWindow(ctx context.Context, session *mediaSession, job *mediaWindowJob, window, burnIndex int, baseURL string) {
	defer close(job.done)
	select {
	case m.processes <- struct{}{}:
		defer func() { <-m.processes }()
	case <-ctx.Done():
		job.setError(ctx.Err())
		return
	case <-m.closed:
		job.setError(context.Canceled)
		return
	}
	start := float64(window * mediaWindowSeconds)
	remaining := session.durationSeconds - start
	if remaining <= 0 {
		job.setError(apiError{Status: http.StatusRequestedRangeNotSatisfiable, Code: "media_segment_out_of_range", Message: "media segment is outside the object duration"})
		return
	}
	duration := math.Min(float64(mediaWindowSeconds), remaining)
	arguments, err := buildMediaWindowArguments(session, mediaSourceURL(baseURL, session.sourceToken), job.directory, window, burnIndex, start, duration)
	if err != nil {
		job.setError(err)
		return
	}
	processCtx, processCancel := context.WithTimeout(ctx, mediaWindowProcessTimeout)
	defer processCancel()
	command := exec.CommandContext(processCtx, m.ffmpegPath, arguments...)
	configureProcessGroup(command)
	command.Dir = job.directory
	var stderr limitedWriter
	stderr.limit = 128 << 10
	command.Stdout = io.Discard
	command.Stderr = &stderr
	if err := runCommandWithContext(processCtx, command); err != nil {
		if errors.Is(processCtx.Err(), context.DeadlineExceeded) {
			job.setError(apiError{Status: http.StatusGatewayTimeout, Code: "media_segment_timeout", Message: "media segment preparation exceeded the server time limit"})
			return
		}
		if ctx.Err() != nil {
			job.setError(ctx.Err())
			return
		}
		job.setError(apiError{Status: http.StatusUnprocessableEntity, Code: "media_segment_failed", Message: publicMediaToolError(stderr.String())})
		return
	}
	if err := materializeTextSubtitleSegments(session, job.directory, window); err != nil {
		job.setError(apiError{Status: http.StatusUnprocessableEntity, Code: "media_subtitle_failed", Message: "the embedded subtitle track could not be segmented for browser playback"})
		return
	}
	job.setError(nil)
}

func (j *mediaWindowJob) setError(err error) {
	j.mu.Lock()
	j.err = err
	j.mu.Unlock()
}

func (j *mediaWindowJob) error() error {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.err
}

func buildMediaWindowArguments(session *mediaSession, sourceURL, directory string, window, burnIndex int, start, duration float64) ([]string, error) {
	globalStartNumber := window * mediaWindowSegments
	arguments := []string{
		"-hide_banner", "-nostdin", "-loglevel", "error", "-y",
		"-filter_threads", "1", "-filter_complex_threads", "1",
		// Both -ss and -t are input options. This is critical: every output in
		// the command is bounded to the requested playback window. Placing -t
		// after -i would scope it to only the first output and could make later
		// audio or subtitle outputs scan the rest of a multi-gigabyte object.
		"-ss", formatMediaSeconds(start),
		"-t", formatMediaSeconds(duration),
		"-i", sourceURL,
		"-map_metadata", "-1", "-map_chapters", "-1",
	}
	if burnIndex >= 0 {
		if session.videoTrack == nil {
			return nil, apiError{Status: http.StatusUnprocessableEntity, Code: "media_video_missing", Message: "a bitmap subtitle cannot be rendered without a video stream"}
		}
		if _, ok := findTrack(session.burnSubtitles, burnIndex, "subtitle"); !ok {
			return nil, apiError{Status: http.StatusBadRequest, Code: "invalid_subtitle_track", Message: "the selected subtitle track cannot be burned into this preview"}
		}
		filter := fmt.Sprintf("[0:%d][0:%d]overlay=eof_action=pass:shortest=0,%s[vout]", session.videoTrack.Index, burnIndex, mediaScaleFilter())
		arguments = append(arguments, "-filter_complex", filter, "-map", "[vout]")
		arguments = appendVideoOutput(arguments, directory, globalStartNumber, "video")
	} else if session.videoTrack != nil {
		arguments = append(arguments,
			"-map", fmt.Sprintf("0:%d", session.videoTrack.Index),
			"-vf", mediaScaleFilter(),
		)
		arguments = appendVideoOutput(arguments, directory, globalStartNumber, "video")
	}
	for _, track := range session.audioTracks {
		arguments = append(arguments, "-map", fmt.Sprintf("0:%d", track.Index), "-vn", "-sn")
		if canCopyHLSAudio(track.Codec) {
			arguments = append(arguments, "-c:a", "copy")
		} else {
			bitrate := "128k"
			if track.Channels > 2 {
				bitrate = "256k"
			}
			arguments = append(arguments, "-c:a", "aac", "-b:a", bitrate)
			if track.Channels > 0 && track.Channels <= 6 {
				arguments = append(arguments, "-ac", strconv.Itoa(track.Channels))
			}
		}
		arguments = appendHLSOutput(arguments, directory, globalStartNumber, fmt.Sprintf("audio_%d", track.Index), false)
	}
	for _, track := range session.textSubtitles {
		arguments = append(arguments,
			"-map", fmt.Sprintf("0:%d", track.Index),
			"-vn", "-an", "-c:s", "webvtt",
			"-f", "webvtt",
			filepath.Join(directory, fmt.Sprintf("subtitle_%d_window.vtt", track.Index)),
		)
	}
	return arguments, nil
}

type webVTTCue struct {
	identifier []string
	start      float64
	end        float64
	settings   string
	payload    []string
}

func materializeTextSubtitleSegments(session *mediaSession, directory string, window int) error {
	if session == nil || len(session.textSubtitles) == 0 {
		return nil
	}
	firstSegment := window * mediaWindowSegments
	totalSegments := mediaSegmentCount(session.durationSeconds)
	for _, track := range session.textSubtitles {
		rawPath := filepath.Join(directory, fmt.Sprintf("subtitle_%d_window.vtt", track.Index))
		data, err := os.ReadFile(rawPath)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		cues := parseWebVTTCues(data)
		for offset := 0; offset < mediaWindowSegments; offset++ {
			segment := firstSegment + offset
			if segment >= totalSegments {
				break
			}
			content := renderWebVTTSegment(cues, float64(offset*mediaSegmentSeconds), float64((offset+1)*mediaSegmentSeconds))
			path := filepath.Join(directory, fmt.Sprintf("subtitle_%d_%06d.vtt", track.Index, segment))
			if err := os.WriteFile(path, content, 0o600); err != nil {
				return err
			}
		}
		_ = os.Remove(rawPath)
	}
	return nil
}

func parseWebVTTCues(data []byte) []webVTTCue {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.TrimPrefix(text, "\ufeff")
	blocks := strings.Split(text, "\n\n")
	cues := make([]webVTTCue, 0, len(blocks))
	for _, block := range blocks {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) == 0 || strings.HasPrefix(strings.TrimSpace(lines[0]), "WEBVTT") || strings.HasPrefix(strings.TrimSpace(lines[0]), "NOTE") || strings.HasPrefix(strings.TrimSpace(lines[0]), "STYLE") || strings.HasPrefix(strings.TrimSpace(lines[0]), "REGION") {
			continue
		}
		timingIndex := -1
		for index, line := range lines {
			if strings.Contains(line, "-->") {
				timingIndex = index
				break
			}
		}
		if timingIndex < 0 {
			continue
		}
		parts := strings.SplitN(lines[timingIndex], "-->", 2)
		if len(parts) != 2 {
			continue
		}
		start, ok := parseWebVTTTime(strings.TrimSpace(parts[0]))
		if !ok {
			continue
		}
		rightFields := strings.Fields(strings.TrimSpace(parts[1]))
		if len(rightFields) == 0 {
			continue
		}
		end, ok := parseWebVTTTime(rightFields[0])
		if !ok || end <= start {
			continue
		}
		settings := ""
		if len(rightFields) > 1 {
			settings = strings.Join(rightFields[1:], " ")
		}
		cues = append(cues, webVTTCue{
			identifier: append([]string(nil), lines[:timingIndex]...),
			start:      start,
			end:        end,
			settings:   settings,
			payload:    append([]string(nil), lines[timingIndex+1:]...),
		})
	}
	return cues
}

func parseWebVTTTime(value string) (float64, bool) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 && len(parts) != 3 {
		return 0, false
	}
	seconds, err := strconv.ParseFloat(strings.ReplaceAll(parts[len(parts)-1], ",", "."), 64)
	if err != nil || seconds < 0 || seconds >= 60 {
		return 0, false
	}
	minutes, err := strconv.Atoi(parts[len(parts)-2])
	if err != nil || minutes < 0 || minutes >= 60 {
		return 0, false
	}
	hours := 0
	if len(parts) == 3 {
		hours, err = strconv.Atoi(parts[0])
		if err != nil || hours < 0 {
			return 0, false
		}
	}
	return float64(hours*3600+minutes*60) + seconds, true
}

func formatWebVTTTime(value float64) string {
	if value < 0 {
		value = 0
	}
	milliseconds := int64(math.Round(value * 1000))
	hours := milliseconds / 3600000
	milliseconds %= 3600000
	minutes := milliseconds / 60000
	milliseconds %= 60000
	seconds := milliseconds / 1000
	milliseconds %= 1000
	return fmt.Sprintf("%02d:%02d:%02d.%03d", hours, minutes, seconds, milliseconds)
}

func renderWebVTTSegment(cues []webVTTCue, segmentStart, segmentEnd float64) []byte {
	var builder strings.Builder
	builder.WriteString("WEBVTT\n\n")
	for _, cue := range cues {
		if cue.end <= segmentStart || cue.start >= segmentEnd {
			continue
		}
		start := math.Max(cue.start, segmentStart) - segmentStart
		end := math.Min(cue.end, segmentEnd) - segmentStart
		if end <= start {
			continue
		}
		for _, line := range cue.identifier {
			builder.WriteString(line)
			builder.WriteByte('\n')
		}
		builder.WriteString(formatWebVTTTime(start))
		builder.WriteString(" --> ")
		builder.WriteString(formatWebVTTTime(end))
		if cue.settings != "" {
			builder.WriteByte(' ')
			builder.WriteString(cue.settings)
		}
		builder.WriteByte('\n')
		for _, line := range cue.payload {
			builder.WriteString(line)
			builder.WriteByte('\n')
		}
		builder.WriteByte('\n')
	}
	return []byte(builder.String())
}

func appendVideoOutput(arguments []string, directory string, startNumber int, prefix string) []string {
	arguments = append(arguments,
		"-an", "-sn",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-crf", "26",
		"-pix_fmt", "yuv420p",
		"-threads", strconv.Itoa(mediaVideoThreads),
		"-sc_threshold", "0",
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", mediaSegmentSeconds),
		"-max_muxing_queue_size", "2048",
	)
	return appendHLSOutput(arguments, directory, startNumber, prefix, true)
}

func appendHLSOutput(arguments []string, directory string, startNumber int, prefix string, independent bool) []string {
	flags := "temp_file"
	if independent {
		flags += "+independent_segments"
	}
	return append(arguments,
		"-f", "hls",
		"-hls_time", strconv.Itoa(mediaSegmentSeconds),
		"-hls_list_size", "0",
		"-hls_playlist_type", "vod",
		"-hls_flags", flags,
		"-start_number", strconv.Itoa(startNumber),
		"-hls_segment_filename", filepath.Join(directory, prefix+"_%06d.ts"),
		filepath.Join(directory, prefix+".m3u8"),
	)
}

func mediaScaleFilter() string {
	return fmt.Sprintf("scale=w='min(%d,iw)':h='trunc(ow/a/2)*2':flags=fast_bilinear", mediaVideoMaxWidth)
}

func canCopyHLSAudio(codec string) bool {
	switch strings.ToLower(codec) {
	case "aac":
		return true
	default:
		return false
	}
}

func formatMediaSeconds(value float64) string {
	return strconv.FormatFloat(value, 'f', 6, 64)
}

func publicMediaToolError(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return "the server could not prepare this media preview"
	}
	lines := strings.Split(message, "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if line == "" || strings.Contains(line, "http://127.0.0.1") {
			continue
		}
		if len(line) > 280 {
			line = line[:280]
		}
		return "the server could not prepare this media preview: " + line
	}
	return "the server could not prepare this media preview"
}

type limitedWriter struct {
	buf   bytes.Buffer
	limit int
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	original := len(data)
	if w.limit <= 0 {
		return original, nil
	}
	remaining := w.limit - w.buf.Len()
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = w.buf.Write(data)
	}
	return original, nil
}

func (w *limitedWriter) String() string { return w.buf.String() }

func mediaSegmentCount(duration float64) int {
	if duration <= 0 {
		return 0
	}
	return int(math.Ceil(duration / float64(mediaSegmentSeconds)))
}

func mediaSegmentDuration(duration float64, segment int) float64 {
	start := float64(segment * mediaSegmentSeconds)
	remaining := duration - start
	if remaining <= 0 {
		return 0
	}
	return math.Min(float64(mediaSegmentSeconds), remaining)
}

func hlsQuote(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return "\"" + value + "\""
}

func (s *mediaSession) masterPlaylist(burnIndex int) string {
	var builder strings.Builder
	builder.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	if len(s.audioTracks) > 0 {
		defaultIndex := 0
		for index, track := range s.audioTracks {
			if track.Default {
				defaultIndex = index
				break
			}
		}
		for index, track := range s.audioTracks {
			name := track.Label
			if name == "" {
				name = mediaTrackLabel("audio", track.Language, track.Index)
			}
			builder.WriteString("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=")
			builder.WriteString(hlsQuote(name))
			if track.Language != "" {
				builder.WriteString(",LANGUAGE=")
				builder.WriteString(hlsQuote(track.Language))
			}
			if index == defaultIndex {
				builder.WriteString(",DEFAULT=YES,AUTOSELECT=YES")
			} else {
				builder.WriteString(",DEFAULT=NO,AUTOSELECT=YES")
			}
			builder.WriteString(",URI=")
			audioURI := fmt.Sprintf("audio/%d.m3u8", track.Index)
			if burnIndex >= 0 {
				audioURI += "?burn=" + strconv.Itoa(burnIndex)
			}
			builder.WriteString(hlsQuote(audioURI))
			builder.WriteByte('\n')
		}
	}
	if len(s.textSubtitles) > 0 {
		for _, track := range s.textSubtitles {
			name := track.Label
			if name == "" {
				name = mediaTrackLabel("subtitle", track.Language, track.Index)
			}
			builder.WriteString("#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=")
			builder.WriteString(hlsQuote(name))
			if track.Language != "" {
				builder.WriteString(",LANGUAGE=")
				builder.WriteString(hlsQuote(track.Language))
			}
			if track.Forced {
				builder.WriteString(",DEFAULT=NO,AUTOSELECT=YES,FORCED=YES")
			} else {
				builder.WriteString(",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO")
			}
			builder.WriteString(",URI=")
			subtitleURI := fmt.Sprintf("subtitle/%d.m3u8", track.Index)
			if burnIndex >= 0 {
				subtitleURI += "?burn=" + strconv.Itoa(burnIndex)
			}
			builder.WriteString(hlsQuote(subtitleURI))
			builder.WriteByte('\n')
		}
	}
	if s.videoTrack != nil {
		builder.WriteString("#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS=\"avc1.42E01E")
		if len(s.audioTracks) > 0 {
			builder.WriteString(",mp4a.40.2\",AUDIO=\"audio\"")
		} else {
			builder.WriteString("\"")
		}
		if len(s.textSubtitles) > 0 {
			builder.WriteString(",SUBTITLES=\"subs\"")
		}
		if s.videoTrack.Width > 0 && s.videoTrack.Height > 0 {
			width, height := scaledMediaDimensions(s.videoTrack.Width, s.videoTrack.Height)
			builder.WriteString(fmt.Sprintf(",RESOLUTION=%dx%d", width, height))
		}
		builder.WriteByte('\n')
		builder.WriteString("video.m3u8")
		if burnIndex >= 0 {
			builder.WriteString("?burn=")
			builder.WriteString(strconv.Itoa(burnIndex))
		}
		builder.WriteByte('\n')
	} else if len(s.audioTracks) > 0 {
		defaultTrack := s.audioTracks[0]
		for _, track := range s.audioTracks {
			if track.Default {
				defaultTrack = track
				break
			}
		}
		builder.WriteString("#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS=\"mp4a.40.2\",AUDIO=\"audio\"\n")
		builder.WriteString(fmt.Sprintf("audio/%d.m3u8\n", defaultTrack.Index))
	}
	return builder.String()
}

func scaledMediaDimensions(width, height int) (int, int) {
	if width <= 0 || height <= 0 || width <= mediaVideoMaxWidth {
		return width, height
	}
	scaledHeight := int(math.Round(float64(height) * float64(mediaVideoMaxWidth) / float64(width)))
	if scaledHeight%2 != 0 {
		scaledHeight--
	}
	return mediaVideoMaxWidth, maxMediaInt(2, scaledHeight)
}

func (s *mediaSession) mediaPlaylist(kind string, trackIndex, burnIndex int) (string, error) {
	if kind == "video" {
		if s.videoTrack == nil {
			return "", apiError{Status: http.StatusNotFound, Code: "media_video_missing", Message: "media session has no video track"}
		}
		if burnIndex >= 0 {
			if _, ok := findTrack(s.burnSubtitles, burnIndex, "subtitle"); !ok {
				return "", apiError{Status: http.StatusBadRequest, Code: "invalid_subtitle_track", Message: "invalid burned subtitle track"}
			}
		}
	} else if kind == "audio" {
		if _, ok := findTrack(s.audioTracks, trackIndex, "audio"); !ok {
			return "", apiError{Status: http.StatusNotFound, Code: "media_audio_missing", Message: "audio track does not exist"}
		}
	} else if kind == "subtitle" {
		if _, ok := findTrack(s.textSubtitles, trackIndex, "subtitle"); !ok {
			return "", apiError{Status: http.StatusNotFound, Code: "media_subtitle_missing", Message: "subtitle track does not exist"}
		}
	} else {
		return "", apiError{Status: http.StatusBadRequest, Code: "invalid_media_playlist", Message: "invalid media playlist"}
	}

	count := mediaSegmentCount(s.durationSeconds)
	var builder strings.Builder
	builder.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n")
	if kind == "video" {
		builder.WriteString("#EXT-X-INDEPENDENT-SEGMENTS\n")
	}
	builder.WriteString(fmt.Sprintf("#EXT-X-TARGETDURATION:%d\n", mediaSegmentSeconds))
	builder.WriteString("#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n")
	for segment := 0; segment < count; segment++ {
		if segment > 0 && segment%mediaWindowSegments == 0 {
			builder.WriteString("#EXT-X-DISCONTINUITY\n")
		}
		duration := mediaSegmentDuration(s.durationSeconds, segment)
		builder.WriteString(fmt.Sprintf("#EXTINF:%.6f,\n", duration))
		switch kind {
		case "video":
			builder.WriteString(fmt.Sprintf("segment/video/%d.ts", segment))
			if burnIndex >= 0 {
				builder.WriteString("?burn=")
				builder.WriteString(strconv.Itoa(burnIndex))
			}
			builder.WriteByte('\n')
		case "audio":
			builder.WriteString(fmt.Sprintf("../segment/audio/%d/%d.ts", trackIndex, segment))
			if burnIndex >= 0 {
				builder.WriteString("?burn=")
				builder.WriteString(strconv.Itoa(burnIndex))
			}
			builder.WriteByte('\n')
		case "subtitle":
			builder.WriteString(fmt.Sprintf("../segment/subtitle/%d/%d.vtt", trackIndex, segment))
			if burnIndex >= 0 {
				builder.WriteString("?burn=")
				builder.WriteString(strconv.Itoa(burnIndex))
			}
			builder.WriteByte('\n')
		}
	}
	builder.WriteString("#EXT-X-ENDLIST\n")
	return builder.String(), nil
}

func parseNonNegativeInt(value string) (int, error) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 {
		return 0, apiError{Status: http.StatusBadRequest, Code: "invalid_media_index", Message: "media index must be a non-negative integer"}
	}
	return parsed, nil
}

func parseOptionalTrackIndex(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "-1" {
		return -1, nil
	}
	return parseNonNegativeInt(value)
}

func (m *mediaSessionManager) serveSegment(w http.ResponseWriter, r *http.Request, session *mediaSession, kind string, trackIndex, segment, burnIndex int, baseURL string) {
	if segment < 0 || segment >= mediaSegmentCount(session.durationSeconds) {
		writeAPIError(w, apiError{Status: http.StatusRequestedRangeNotSatisfiable, Code: "media_segment_out_of_range", Message: "media segment is outside the object duration"})
		return
	}
	window := segment / mediaWindowSegments
	jobBurn := burnIndex
	job := m.ensureWindow(session, window, jobBurn, baseURL)
	filename := ""
	switch kind {
	case "video":
		filename = fmt.Sprintf("video_%06d.ts", segment)
	case "audio":
		if _, ok := findTrack(session.audioTracks, trackIndex, "audio"); !ok {
			writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "media_audio_missing", Message: "audio track does not exist"})
			return
		}
		filename = fmt.Sprintf("audio_%d_%06d.ts", trackIndex, segment)
	case "subtitle":
		if _, ok := findTrack(session.textSubtitles, trackIndex, "subtitle"); !ok {
			writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "media_subtitle_missing", Message: "subtitle track does not exist"})
			return
		}
		filename = fmt.Sprintf("subtitle_%d_%06d.vtt", trackIndex, segment)
	default:
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_media_segment", Message: "invalid media segment"})
		return
	}
	path := filepath.Join(job.directory, filename)
	if err := waitForMediaSegment(r.Context(), job, path, kind == "subtitle", segment); err != nil {
		writeAPIError(w, err)
		return
	}
	if kind == "subtitle" {
		data, err := os.ReadFile(path)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		data = addWebVTTTimestampMap(data, segment)
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("Cache-Control", "private, max-age=300, immutable")
		applyObjectSafetyHeaders(w.Header())
		if r.Method != http.MethodHead {
			_, _ = w.Write(data)
		}
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeAPIError(w, err)
		return
	}
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "private, max-age=300, immutable")
	applyObjectSafetyHeaders(w.Header())
	http.ServeContent(w, r, filename, info.ModTime(), file)
}

func waitForMediaSegment(ctx context.Context, job *mediaWindowJob, path string, subtitle bool, segment int) error {
	waitCtx, cancel := context.WithTimeout(ctx, mediaSegmentWaitTimeout)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if info, err := os.Stat(path); err == nil && info.Size() > 0 {
			if !subtitle || subtitleSegmentComplete(job, path, segment) {
				return nil
			}
		}
		select {
		case <-waitCtx.Done():
			if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
				return apiError{Status: http.StatusGatewayTimeout, Code: "media_segment_timeout", Message: "media segment preparation timed out"}
			}
			return waitCtx.Err()
		case <-job.done:
			if err := job.error(); err != nil {
				return err
			}
			// HLS uses atomic temporary files. On some filesystems the process can
			// exit just before the final rename becomes visible to another goroutine.
			// Give the directory entry a very short visibility grace period.
			for attempt := 0; attempt < 20; attempt++ {
				if info, err := os.Stat(path); err == nil && info.Size() > 0 {
					return nil
				}
				time.Sleep(10 * time.Millisecond)
			}
			return apiError{Status: http.StatusUnprocessableEntity, Code: "media_segment_missing", Message: "the requested media segment was not produced"}
		case <-ticker.C:
		}
	}
}

func subtitleSegmentComplete(job *mediaWindowJob, path string, segment int) bool {
	next := strings.TrimSuffix(path, fmt.Sprintf("%06d.vtt", segment)) + fmt.Sprintf("%06d.vtt", segment+1)
	if info, err := os.Stat(next); err == nil && info.Size() > 0 {
		return true
	}
	select {
	case <-job.done:
		return true
	default:
		return false
	}
}

func addWebVTTTimestampMap(data []byte, segment int) []byte {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.TrimPrefix(text, "\ufeff")
	if !strings.HasPrefix(text, "WEBVTT") {
		text = "WEBVTT\n\n" + text
	}
	if strings.Contains(text, "X-TIMESTAMP-MAP=") {
		return []byte(text)
	}
	newline := strings.IndexByte(text, '\n')
	if newline < 0 {
		newline = len(text)
	}
	mpegTS := int64(segment*mediaSegmentSeconds) * 90000
	mapping := fmt.Sprintf("\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:%d\n", mpegTS)
	return []byte(text[:newline] + mapping + text[newline:])
}

func writeM3U8(w http.ResponseWriter, r *http.Request, content string) {
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	applyObjectSafetyHeaders(w.Header())
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, content)
	}
}

func (a *application) handleMediaProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, err := a.instanceFromRequest(r, "")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeAPIError(w, err)
		return
	}
	key := cleanRelativeKey(r.URL.Query().Get("key"))
	if key == "" {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "media key cannot be empty"})
		return
	}
	metadata := mediaSourceMetadata{
		Size:         parseInt64Default(r.URL.Query().Get("size"), 0),
		MIME:         r.URL.Query().Get("mime"),
		ETag:         r.URL.Query().Get("etag"),
		LastModified: r.URL.Query().Get("lastModified"),
	}
	response, err := a.media.probe(r.Context(), instance, key, internalMediaBaseURL(r, a.config.Listen), metadata)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, response)
}

func parseInt64Default(value string, fallback int64) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func (a *application) handleMediaSessions(w http.ResponseWriter, r *http.Request) {
	if a.media == nil {
		writeAPIError(w, apiError{Status: http.StatusNotImplemented, Code: "media_tools_unavailable", Message: "advanced media preview is unavailable"})
		return
	}
	if r.URL.Path == "/api/media-sessions" || r.URL.Path == "/api/media-sessions/" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		var body createMediaSessionRequest
		if err := decodeJSONBody(r, &body); err != nil {
			writeAPIError(w, err)
			return
		}
		instance, err := a.instanceFromRequest(r, body.Instance)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		if err := requirePermission(instance, permissionRead); err != nil {
			writeAPIError(w, err)
			return
		}
		body.Key = cleanRelativeKey(body.Key)
		if body.Key == "" {
			writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "media key cannot be empty"})
			return
		}
		session, err := a.media.create(r.Context(), instance, body, internalMediaBaseURL(r, a.config.Listen))
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, a.media.sessionStatus(session))
		return
	}

	remainder := strings.TrimPrefix(r.URL.Path, "/api/media-sessions/")
	parts := strings.Split(strings.Trim(remainder, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "media_session_not_found", Message: "media session does not exist"})
		return
	}
	session, ok := a.media.getSession(parts[0])
	if !ok {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "media_session_not_found", Message: "media session does not exist"})
		return
	}
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, a.media.sessionStatus(session))
		case http.MethodDelete:
			a.media.delete(session.id)
			w.WriteHeader(http.StatusNoContent)
		default:
			methodNotAllowed(w, http.MethodGet, http.MethodDelete)
		}
		return
	}
	if len(parts) == 2 && parts[1] == "heartbeat" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		a.media.touchSession(session)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(parts) == 2 && parts[1] == "watch" {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeAPIError(w, apiError{Status: http.StatusInternalServerError, Code: "media_watch_unavailable", Message: "media session watch is unavailable"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Accel-Buffering", "no")
		applyObjectSafetyHeaders(w.Header())
		a.media.beginWatch(session)
		defer a.media.endWatch(session)
		_, _ = io.WriteString(w, ": connected\n\n")
		flusher.Flush()
		ticker := time.NewTicker(8 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-a.media.closed:
				return
			case <-ticker.C:
				a.media.touchSession(session)
				if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	burnIndex, err := parseOptionalTrackIndex(r.URL.Query().Get("burn"))
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if len(parts) == 2 && parts[1] == "master.m3u8" {
		if burnIndex >= 0 {
			if _, ok := findTrack(session.burnSubtitles, burnIndex, "subtitle"); !ok {
				writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_subtitle_track", Message: "invalid burned subtitle track"})
				return
			}
		}
		writeM3U8(w, r, session.masterPlaylist(burnIndex))
		return
	}
	if len(parts) == 2 && parts[1] == "video.m3u8" {
		playlist, err := session.mediaPlaylist("video", -1, burnIndex)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeM3U8(w, r, playlist)
		return
	}
	if len(parts) == 3 && parts[1] == "audio" && strings.HasSuffix(parts[2], ".m3u8") {
		index, err := parseNonNegativeInt(strings.TrimSuffix(parts[2], ".m3u8"))
		if err != nil {
			writeAPIError(w, err)
			return
		}
		playlist, err := session.mediaPlaylist("audio", index, burnIndex)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeM3U8(w, r, playlist)
		return
	}
	if len(parts) == 3 && parts[1] == "subtitle" && strings.HasSuffix(parts[2], ".m3u8") {
		index, err := parseNonNegativeInt(strings.TrimSuffix(parts[2], ".m3u8"))
		if err != nil {
			writeAPIError(w, err)
			return
		}
		playlist, err := session.mediaPlaylist("subtitle", index, burnIndex)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeM3U8(w, r, playlist)
		return
	}
	if len(parts) >= 4 && parts[1] == "segment" {
		baseURL := internalMediaBaseURL(r, a.config.Listen)
		switch parts[2] {
		case "video":
			if len(parts) != 4 || !strings.HasSuffix(parts[3], ".ts") {
				break
			}
			segment, err := parseNonNegativeInt(strings.TrimSuffix(parts[3], ".ts"))
			if err != nil {
				writeAPIError(w, err)
				return
			}
			a.media.serveSegment(w, r, session, "video", -1, segment, burnIndex, baseURL)
			return
		case "audio":
			if len(parts) != 5 || !strings.HasSuffix(parts[4], ".ts") {
				break
			}
			track, err := parseNonNegativeInt(parts[3])
			if err != nil {
				writeAPIError(w, err)
				return
			}
			segment, err := parseNonNegativeInt(strings.TrimSuffix(parts[4], ".ts"))
			if err != nil {
				writeAPIError(w, err)
				return
			}
			a.media.serveSegment(w, r, session, "audio", track, segment, burnIndex, baseURL)
			return
		case "subtitle":
			if len(parts) != 5 || !strings.HasSuffix(parts[4], ".vtt") {
				break
			}
			track, err := parseNonNegativeInt(parts[3])
			if err != nil {
				writeAPIError(w, err)
				return
			}
			segment, err := parseNonNegativeInt(strings.TrimSuffix(parts[4], ".vtt"))
			if err != nil {
				writeAPIError(w, err)
				return
			}
			a.media.serveSegment(w, r, session, "subtitle", track, segment, burnIndex, baseURL)
			return
		}
	}
	writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "media_endpoint_not_found", Message: "media session endpoint does not exist"})
}

const (
	// A single aligned metadata read is often cheaper than several tiny billed
	// Range requests. The bytes stay inside the active media session only.
	mediaSourceMetadataReadAhead    = int64(1 << 20)
	mediaSourceWholeObjectThreshold = int64(1 << 20)
)

func mediaSourceExpandedRange(source *mediaSourceRef, start, end, remaining int64) (int64, int64) {
	if source == nil || source.size <= 0 {
		return start, end
	}
	if source.size <= mediaSourceWholeObjectThreshold {
		return 0, source.size - 1
	}
	length := end - start + 1
	if length >= mediaSourceMetadataReadAhead || length >= mediaSourceCacheMaxChunk {
		return start, end
	}
	fetchStart := (start / mediaSourceMetadataReadAhead) * mediaSourceMetadataReadAhead
	fetchEnd := fetchStart + mediaSourceMetadataReadAhead - 1
	if fetchEnd < end {
		fetchEnd = end
	}
	if fetchEnd >= source.size {
		fetchEnd = source.size - 1
	}
	if remaining > 0 && fetchEnd-fetchStart+1 > remaining {
		fetchEnd = fetchStart + remaining - 1
		if fetchEnd < end {
			// Never truncate the caller's requested bytes. The generic streaming
			// path will enforce the remaining probe budget instead.
			return start, end
		}
	}
	if fetchEnd-fetchStart+1 > mediaSourceCacheMaxChunk {
		fetchEnd = fetchStart + mediaSourceCacheMaxChunk - 1
		if fetchEnd < end {
			return start, end
		}
	}
	return fetchStart, fetchEnd
}

func (a *application) loadCachedMediaSourceRange(ctx context.Context, source *mediaSourceRef, start, end int64) ([]byte, bool, error) {
	if source == nil || source.size <= 0 || start < 0 || end < start || end >= source.size {
		return nil, false, nil
	}
	if data, found := source.cache.get(start, end); found {
		return data, true, nil
	}

	// Serialize cacheable reads for one active preview. FFprobe can open several
	// overlapping HTTP connections at once; without this gate, those requests can
	// all miss the cache before the first provider response has arrived.
	source.fetchMu.Lock()
	defer source.fetchMu.Unlock()
	if data, found := source.cache.get(start, end); found {
		return data, true, nil
	}

	remaining := source.byteBudget.Load() - source.providerBytes.Load()
	if source.byteBudget.Load() <= 0 {
		remaining = 0
	}
	fetchStart, fetchEnd := mediaSourceExpandedRange(source, start, end, remaining)
	fetchLength := fetchEnd - fetchStart + 1
	if fetchLength <= 0 || fetchLength > mediaSourceCacheMaxChunk {
		return nil, false, nil
	}
	if budget := source.byteBudget.Load(); budget > 0 && (remaining <= 0 || fetchLength > remaining) {
		return nil, false, nil
	}

	headers := make(http.Header)
	headers.Set("Range", fmt.Sprintf("bytes=%d-%d", fetchStart, fetchEnd))
	object, err := source.instance.backend.Get(ctx, source.instance.fullKey(source.key), headers)
	if err != nil {
		return nil, false, err
	}
	source.providerRequests.Add(1)
	if object.Body == nil {
		return nil, false, apiError{Status: http.StatusBadGateway, Code: "empty_media_source", Message: "the storage provider returned an empty media source"}
	}
	defer object.Body.Close()
	if object.StatusCode != http.StatusPartialContent {
		return nil, false, apiError{Status: http.StatusBadGateway, Code: "media_range_unsupported", Message: "the storage provider did not honor the byte-range request required for media playback"}
	}
	data, err := io.ReadAll(io.LimitReader(object.Body, fetchLength+1))
	if err != nil {
		return nil, false, fmt.Errorf("read media source range: %w", err)
	}
	if int64(len(data)) != fetchLength {
		return nil, false, apiError{Status: http.StatusBadGateway, Code: "media_range_incomplete", Message: "the storage provider returned an incomplete media byte range"}
	}
	source.providerBytes.Add(int64(len(data)))
	source.cache.put(fetchStart, data)
	selected, found := source.cache.get(start, end)
	return selected, found, nil
}

func (a *application) handleMediaSource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/api/media-source/")
	if token == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	a.media.mu.RLock()
	source := a.media.sources[token]
	a.media.mu.RUnlock()
	if source == nil || time.Now().UTC().After(time.Unix(0, source.expiresAt.Load())) {
		http.NotFound(w, r)
		return
	}
	a.media.touchSource(source)
	if r.Method == http.MethodHead && source.size > 0 {
		writeKnownMediaSourceHeaders(w.Header(), source)
		w.WriteHeader(http.StatusOK)
		return
	}

	budget := source.byteBudget.Load()
	requestHeaders := r.Header.Clone()
	if budget > 0 {
		remaining := budget - source.providerBytes.Load()
		if remaining <= 0 {
			writeAPIError(w, apiError{Status: http.StatusTooManyRequests, Code: "media_probe_budget_exhausted", Message: "media inspection reached its byte budget"})
			return
		}
		requestHeaders = limitMediaProbeRange(requestHeaders, remaining)
	}

	if r.Method == http.MethodGet && cachedMediaRangeAllowed(requestHeaders, source) {
		if start, end, ok := parseSingleByteRange(requestHeaders.Get("Range"), source.size); ok {
			data, found, loadErr := a.loadCachedMediaSourceRange(r.Context(), source, start, end)
			if loadErr != nil {
				writeGatewayError(w, loadErr)
				return
			}
			if found {
				serveCachedMediaRange(w, r, source, start, end, data)
				return
			}
		} else if requestHeaders.Get("Range") == "" && source.size > 0 && source.size <= mediaSourceCacheMaxChunk {
			if data, found := source.cache.get(0, source.size-1); found {
				writeKnownMediaSourceHeaders(w.Header(), source)
				w.Header().Set("Content-Length", strconv.Itoa(len(data)))
				w.WriteHeader(http.StatusOK)
				if r.Method != http.MethodHead {
					_, _ = w.Write(data)
				}
				return
			}
		}
	}

	fullKey := source.instance.fullKey(source.key)
	if r.Method == http.MethodHead {
		object, err := source.instance.backend.Head(r.Context(), fullKey)
		if err != nil {
			writeGatewayError(w, err)
			return
		}
		if object.Body != nil {
			_ = object.Body.Close()
		}
		source.providerRequests.Add(1)
		copyObjectHeaders(w.Header(), object.Header)
		w.WriteHeader(object.StatusCode)
		return
	}

	object, err := source.instance.backend.Get(r.Context(), fullKey, requestHeaders)
	if err != nil {
		writeGatewayError(w, err)
		return
	}
	source.providerRequests.Add(1)
	if object.Body == nil {
		writeGatewayError(w, apiError{Status: http.StatusBadGateway, Code: "empty_media_source", Message: "the storage provider returned an empty media source"})
		return
	}
	defer object.Body.Close()
	if requestHeaders.Get("Range") != "" && object.StatusCode != http.StatusPartialContent {
		writeGatewayError(w, apiError{
			Status:  http.StatusBadGateway,
			Code:    "media_range_unsupported",
			Message: "the storage provider did not honor the byte-range request required for media playback",
		})
		return
	}

	copyObjectHeaders(w.Header(), object.Header)
	if w.Header().Get("Content-Type") == "" && source.mime != "" {
		w.Header().Set("Content-Type", source.mime)
	}
	if source.etag != "" && w.Header().Get("ETag") == "" {
		w.Header().Set("ETag", source.etag)
	}
	writeStatus := object.StatusCode
	w.WriteHeader(writeStatus)

	expected, _ := strconv.ParseInt(strings.TrimSpace(object.Header.Get("Content-Length")), 10, 64)
	cacheStart, cacheable := int64(0), false
	if object.StatusCode == http.StatusPartialContent {
		cacheStart, cacheable = parseContentRangeStart(object.Header.Get("Content-Range"))
	} else if object.StatusCode == http.StatusOK {
		cacheable = true
	}
	cacheable = cacheable && expected > 0 && expected <= mediaSourceCacheMaxChunk
	var capture bytes.Buffer
	if cacheable {
		capture.Grow(int(expected))
	}
	writer := io.Writer(w)
	if cacheable {
		writer = io.MultiWriter(w, &capture)
	}
	n, copyErr := io.Copy(writer, object.Body)
	source.providerBytes.Add(n)
	if copyErr == nil && cacheable && n == expected {
		source.cache.put(cacheStart, capture.Bytes())
	}
}

func serveCachedMediaRange(w http.ResponseWriter, r *http.Request, source *mediaSourceRef, start, end int64, data []byte) {
	writeKnownMediaSourceHeaders(w.Header(), source)
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, source.size))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusPartialContent)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

func limitMediaProbeRange(headers http.Header, remaining int64) http.Header {
	limited := headers.Clone()
	if remaining <= 0 {
		return limited
	}
	value := strings.TrimSpace(limited.Get("Range"))
	if !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		limited.Set("Range", fmt.Sprintf("bytes=0-%d", remaining-1))
		return limited
	}
	parts := strings.SplitN(strings.TrimPrefix(value, "bytes="), "-", 2)
	if len(parts) != 2 {
		limited.Set("Range", fmt.Sprintf("bytes=0-%d", remaining-1))
		return limited
	}
	if strings.TrimSpace(parts[0]) == "" {
		requested, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		if err != nil || requested <= 0 || requested > remaining {
			requested = remaining
		}
		limited.Set("Range", fmt.Sprintf("bytes=-%d", requested))
		return limited
	}
	start, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil || start < 0 {
		limited.Set("Range", fmt.Sprintf("bytes=0-%d", remaining-1))
		return limited
	}
	maximumEnd := start + remaining - 1
	end := maximumEnd
	if strings.TrimSpace(parts[1]) != "" {
		if requestedEnd, parseErr := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); parseErr == nil && requestedEnd >= start && requestedEnd < end {
			end = requestedEnd
		}
	}
	limited.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	return limited
}

func writeKnownMediaSourceHeaders(headers http.Header, source *mediaSourceRef) {
	if source.size > 0 {
		headers.Set("Content-Length", strconv.FormatInt(source.size, 10))
	}
	if source.mime != "" {
		headers.Set("Content-Type", source.mime)
	}
	if source.etag != "" {
		headers.Set("ETag", source.etag)
	}
	if source.modified != "" {
		headers.Set("Last-Modified", source.modified)
	}
	headers.Set("Accept-Ranges", "bytes")
}

func maxMediaInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
