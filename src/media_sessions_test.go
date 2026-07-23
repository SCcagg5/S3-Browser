package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testMediaSession() *mediaSession {
	video := mediaTrackInfo{Index: 0, Type: "video", Codec: "h264", Width: 1920, Height: 1080, Label: "Video"}
	return &mediaSession{
		id:              "session",
		durationSeconds: 31,
		videoTrack:      &video,
		audioTracks: []mediaTrackInfo{
			{Index: 1, Type: "audio", Codec: "aac", Language: "eng", Label: "English", Default: true},
			{Index: 2, Type: "audio", Codec: "aac", Language: "fra", Label: "French"},
		},
		textSubtitles: []mediaTrackInfo{{Index: 3, Type: "subtitle", Codec: "subrip", Language: "eng", Label: "English", SubtitleMode: "webvtt"}},
		burnSubtitles: []mediaTrackInfo{{Index: 4, Type: "subtitle", Codec: "hdmv_pgs_subtitle", Language: "fra", Label: "French PGS", SubtitleMode: "burn"}},
	}
}

func TestMediaMasterPlaylistIncludesEmbeddedTracks(t *testing.T) {
	session := testMediaSession()
	playlist := session.masterPlaylist(-1)
	for _, expected := range []string{
		`TYPE=AUDIO,GROUP-ID="audio",NAME="English"`,
		`TYPE=AUDIO,GROUP-ID="audio",NAME="French"`,
		`TYPE=SUBTITLES,GROUP-ID="subs",NAME="English"`,
		`AUDIO="audio"`,
		`SUBTITLES="subs"`,
		`RESOLUTION=1920x1080`,
	} {
		if !strings.Contains(playlist, expected) {
			t.Fatalf("master playlist does not contain %q:\n%s", expected, playlist)
		}
	}

	burned := session.masterPlaylist(4)
	for _, expected := range []string{
		"video.m3u8?burn=4",
		"audio/1.m3u8?burn=4",
		"subtitle/3.m3u8?burn=4",
	} {
		if !strings.Contains(burned, expected) {
			t.Fatalf("burned master playlist does not contain %q:\n%s", expected, burned)
		}
	}
}

func TestMediaPlaylistsExposeFullDurationAndWindowBoundaries(t *testing.T) {
	session := testMediaSession()
	playlist, err := session.mediaPlaylist("video", -1, -1)
	if err != nil {
		t.Fatal(err)
	}
	if count := strings.Count(playlist, "#EXTINF:"); count != 6 {
		t.Fatalf("expected six six-second-or-shorter segments for 31 seconds, got %d:\n%s", count, playlist)
	}
	if !strings.Contains(playlist, "#EXTINF:1.000000,") {
		t.Fatalf("last segment duration is not bounded to the source duration:\n%s", playlist)
	}
	if count := strings.Count(playlist, "#EXT-X-DISCONTINUITY"); count != 1 {
		t.Fatalf("expected one discontinuity at the 24-second window boundary, got %d:\n%s", count, playlist)
	}
	if !strings.HasSuffix(playlist, "#EXT-X-ENDLIST\n") {
		t.Fatalf("playlist must advertise a complete VOD duration:\n%s", playlist)
	}
}

func TestMediaWindowInputIsStrictlyBounded(t *testing.T) {
	session := testMediaSession()
	arguments, err := buildMediaWindowArguments(session, "http://127.0.0.1/source", t.TempDir(), 2, -1, 48, 24)
	if err != nil {
		t.Fatal(err)
	}
	input := indexOfArgument(arguments, "-i")
	duration := indexOfArgument(arguments, "-t")
	seek := indexOfArgument(arguments, "-ss")
	if seek < 0 || duration < 0 || input < 0 || !(seek < duration && duration < input) {
		t.Fatalf("-ss and -t must be input options before -i: %v", arguments)
	}
	if arguments[duration+1] != "24.000000" {
		t.Fatalf("unexpected bounded duration: %q", arguments[duration+1])
	}
	if countArgument(arguments, "-i") != 1 {
		t.Fatalf("one source pass must produce video, audio, and subtitles: %v", arguments)
	}
}

func indexOfArgument(arguments []string, expected string) int {
	for index, argument := range arguments {
		if argument == expected {
			return index
		}
	}
	return -1
}

func countArgument(arguments []string, expected string) int {
	count := 0
	for _, argument := range arguments {
		if argument == expected {
			count++
		}
	}
	return count
}

func TestMediaProbeRangeBudgetCapsProviderRequest(t *testing.T) {
	headers := make(http.Header)
	headers.Set("Range", "bytes=100-999999")
	limited := limitMediaProbeRange(headers, 4096)
	if got := limited.Get("Range"); got != "bytes=100-4195" {
		t.Fatalf("unexpected limited range: %q", got)
	}
	headers.Set("Range", "bytes=-999999")
	limited = limitMediaProbeRange(headers, 2048)
	if got := limited.Get("Range"); got != "bytes=-2048" {
		t.Fatalf("unexpected limited suffix range: %q", got)
	}
}

func TestEmbeddedWebVTTCuesAreSplitIntoCompleteFixedSegments(t *testing.T) {
	t.Parallel()
	cues := parseWebVTTCues([]byte(`WEBVTT

first
00:00:01.000 --> 00:00:08.000 align:start
Spans two segments

00:00:13.250 --> 00:00:15.000
Third segment
`))
	if len(cues) != 2 {
		t.Fatalf("parsed %d cues", len(cues))
	}
	first := string(renderWebVTTSegment(cues, 0, 6))
	second := string(renderWebVTTSegment(cues, 6, 12))
	third := string(renderWebVTTSegment(cues, 12, 18))
	fourth := string(renderWebVTTSegment(cues, 18, 24))
	for name, value := range map[string]string{"first": first, "second": second, "third": third, "fourth": fourth} {
		if !strings.HasPrefix(value, "WEBVTT\n\n") {
			t.Fatalf("%s segment is not WebVTT: %q", name, value)
		}
	}
	if !strings.Contains(first, "00:00:01.000 --> 00:00:06.000 align:start") {
		t.Fatalf("first segment did not clip the spanning cue:\n%s", first)
	}
	if !strings.Contains(second, "00:00:00.000 --> 00:00:02.000 align:start") {
		t.Fatalf("second segment did not continue the spanning cue:\n%s", second)
	}
	if !strings.Contains(third, "00:00:01.250 --> 00:00:03.000") {
		t.Fatalf("third segment did not rebase its cue:\n%s", third)
	}
	if fourth != "WEBVTT\n\n" {
		t.Fatalf("empty subtitle interval must still produce a valid segment: %q", fourth)
	}
}

func TestCompletedMediaWindowsAreBoundedAndRemoved(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	session := &mediaSession{windows: make(map[string]*mediaWindowJob)}
	now := time.Now().UTC()
	for index := 0; index < mediaMaxRetainedWindows+2; index++ {
		directory := filepath.Join(root, fmt.Sprintf("window-%d", index))
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		close(done)
		session.windows[fmt.Sprintf("window-%d", index)] = &mediaWindowJob{
			directory:  directory,
			done:       done,
			lastAccess: now.Add(time.Duration(index) * time.Second),
		}
	}
	pruneMediaSessionWindows(session, now.Add(10*time.Second))
	if got := len(session.windows); got != mediaMaxRetainedWindows {
		t.Fatalf("retained %d completed windows, want %d", got, mediaMaxRetainedWindows)
	}
	for index := 0; index < 2; index++ {
		if _, err := os.Stat(filepath.Join(root, fmt.Sprintf("window-%d", index))); !os.IsNotExist(err) {
			t.Fatalf("old media window %d was not removed: %v", index, err)
		}
	}
}

func TestMediaSessionRealEmbeddedAudioAndSubtitle(t *testing.T) {
	ffmpeg, ffmpegErr := exec.LookPath("ffmpeg")
	ffprobe, ffprobeErr := exec.LookPath("ffprobe")
	if ffmpegErr != nil || ffprobeErr != nil {
		t.Skip("ffmpeg and ffprobe are required for the integration test")
	}
	mediaData := generateTestMatroska(t, ffmpeg)
	backend := newMemoryBackend(nil)
	backend.objects["movie.mkv"] = memoryObject{
		data:        mediaData,
		contentType: "video/x-matroska",
		modified:    time.Now().UTC(),
	}
	cfg := storageConfig{
		ID: "media", Name: "media", Provider: "s3", Bucket: "media",
		Endpoint: "http://internal.invalid", Region: "test",
		PermissionsDefined: true, Permissions: []string{permissionRead},
	}
	instance := &storageInstance{cfg: cfg, backend: backend, caps: initialCapabilities(cfg)}
	app := &application{
		config:    appConfig{DataDir: t.TempDir()},
		instances: map[string]*storageInstance{"media": instance},
		publicFS:  fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok"), Mode: fs.FileMode(0o444)}},
	}
	manager, err := newMediaSessionManager(app, app.config.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	manager.ffmpegPath = ffmpeg
	manager.ffprobePath = ffprobe
	app.media = manager
	defer app.close()

	server := httptest.NewServer(app.routes())
	defer server.Close()

	body, _ := json.Marshal(createMediaSessionRequest{
		Instance: "media", Key: "movie.mkv", Size: int64(len(mediaData)), MIME: "video/x-matroska",
	})
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/media-sessions", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("create media session returned %d: %s", response.StatusCode, data)
	}
	var status mediaSessionStatus
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.DurationSeconds <= 0 {
		t.Fatalf("duration was not detected: %+v", status)
	}
	if got := countTrackType(status.Tracks, "audio"); got != 2 {
		t.Fatalf("expected two embedded audio tracks, got %d: %+v", got, status.Tracks)
	}
	if got := countTrackType(status.Tracks, "subtitle"); got != 1 {
		t.Fatalf("expected one embedded subtitle track, got %d: %+v", got, status.Tracks)
	}
	backend.mu.Lock()
	readsAfterProbe := backend.getCount
	backend.mu.Unlock()
	if readsAfterProbe == 0 {
		t.Fatal("expected ffprobe to read the object through the media source")
	}

	master := mustHTTPText(t, server.URL+status.MasterURL)
	if strings.Count(master, "TYPE=AUDIO") != 2 || strings.Count(master, "TYPE=SUBTITLES") != 1 {
		t.Fatalf("unexpected master playlist:\n%s", master)
	}
	playbackCtx, playbackCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer playbackCancel()
	playbackProbe := exec.CommandContext(playbackCtx, ffprobe,
		"-v", "error",
		"-show_entries", "stream=codec_type,codec_name",
		"-of", "json",
		server.URL+status.MasterURL,
	)
	playbackOutput, playbackErr := playbackProbe.CombinedOutput()
	if playbackErr != nil {
		t.Fatalf("ffprobe could not consume the generated HLS master playlist: %v\n%s", playbackErr, playbackOutput)
	}
	if !bytes.Contains(playbackOutput, []byte(`"codec_type": "video"`)) || !bytes.Contains(playbackOutput, []byte(`"codec_type": "audio"`)) {
		t.Fatalf("generated HLS playlist did not expose video and audio streams:\n%s", playbackOutput)
	}

	videoURL := server.URL + "/api/media-sessions/" + status.ID + "/segment/video/0.ts"
	videoResponse, videoErr := http.Get(videoURL) // #nosec G107 -- local httptest URL
	if videoErr != nil {
		t.Fatal(videoErr)
	}
	video, _ := io.ReadAll(videoResponse.Body)
	videoResponse.Body.Close()
	if videoResponse.StatusCode < 200 || videoResponse.StatusCode >= 300 {
		session, _ := manager.getSessionWithoutTouch(status.ID)
		var debug []string
		if session != nil {
			session.mu.RLock()
			for name, job := range session.windows {
				entries, _ := os.ReadDir(job.directory)
				files := make([]string, 0, len(entries))
				for _, entry := range entries {
					info, _ := entry.Info()
					files = append(files, fmt.Sprintf("%s(%d)", entry.Name(), info.Size()))
				}
				debug = append(debug, name+":"+strings.Join(files, ",")+":"+fmt.Sprint(job.error()))
			}
			session.mu.RUnlock()
		}
		t.Fatalf("GET %s returned %d: %s; jobs=%v", videoURL, videoResponse.StatusCode, video, debug)
	}
	if len(video) == 0 {
		t.Fatal("video segment is empty")
	}
	backend.mu.Lock()
	readsAfterVideo := backend.getCount
	backend.mu.Unlock()
	if readsAfterVideo != readsAfterProbe {
		t.Fatalf("expected the active-session range buffer to reuse the small object read by ffprobe; provider reads changed from %d to %d", readsAfterProbe, readsAfterVideo)
	}

	audio := mustHTTPBytes(t, server.URL+"/api/media-sessions/"+status.ID+"/segment/audio/1/0.ts")
	if len(audio) == 0 {
		t.Fatal("audio segment is empty")
	}
	subtitle := string(mustHTTPBytes(t, server.URL+"/api/media-sessions/"+status.ID+"/segment/subtitle/3/0.vtt"))
	if !strings.Contains(subtitle, "WEBVTT") || !strings.Contains(subtitle, "X-TIMESTAMP-MAP") || !strings.Contains(subtitle, "Embedded subtitle") {
		t.Fatalf("unexpected WebVTT subtitle segment:\n%s", subtitle)
	}
	backend.mu.Lock()
	readsAfterAllTracks := backend.getCount
	backend.mu.Unlock()
	if readsAfterAllTracks != readsAfterVideo {
		t.Fatalf("audio/subtitle segments should reuse the active playback window: reads after video=%d, after all=%d", readsAfterVideo, readsAfterAllTracks)
	}

	deleteRequest, _ := http.NewRequest(http.MethodDelete, server.URL+"/api/media-sessions/"+status.ID, nil)
	deleteResponse, err := http.DefaultClient.Do(deleteRequest)
	if err != nil {
		t.Fatal(err)
	}
	deleteResponse.Body.Close()
	if deleteResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("delete media session returned %d", deleteResponse.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(manager.root, status.ID)); !os.IsNotExist(err) {
		t.Fatalf("session directory still exists after delete: %v", err)
	}
}

func countTrackType(tracks []mediaTrackInfo, kind string) int {
	count := 0
	for _, track := range tracks {
		if track.Type == kind {
			count++
		}
	}
	return count
}

func generateTestMatroska(t *testing.T, ffmpeg string) []byte {
	t.Helper()
	directory := t.TempDir()
	subtitlePath := filepath.Join(directory, "subtitle.srt")
	if err := os.WriteFile(subtitlePath, []byte("1\n00:00:00,300 --> 00:00:02,600\nEmbedded subtitle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "movie.mkv")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	arguments := []string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=4",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
		"-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=4",
		"-i", subtitlePath,
		"-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0", "-map", "3:s:0",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "64k", "-c:s", "srt",
		"-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English",
		"-metadata:s:a:1", "language=fra", "-metadata:s:a:1", "title=French",
		"-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=English subtitles",
		"-disposition:a:0", "default", "-shortest", output,
	}
	command := exec.CommandContext(ctx, ffmpeg, arguments...)
	if data, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generate test media: %v\n%s", err, data)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mustHTTPText(t *testing.T, url string) string {
	t.Helper()
	return string(mustHTTPBytes(t, url))
}

func mustHTTPBytes(t *testing.T, url string) []byte {
	t.Helper()
	response, err := http.Get(url) // #nosec G107 -- local httptest URL
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("GET %s returned %d: %s", url, response.StatusCode, data)
	}
	return data
}

func TestMediaWatchDisconnectDeletesSession(t *testing.T) {
	manager, err := newMediaSessionManager(&application{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer manager.close()

	directory := filepath.Join(manager.root, "watched")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	session := &mediaSession{
		id:        "watched",
		directory: directory,
		state:     "ready",
		updatedAt: time.Now().UTC(),
		ctx:       ctx,
		cancel:    cancel,
		windows:   make(map[string]*mediaWindowJob),
	}
	manager.mu.Lock()
	manager.sessions[session.id] = session
	manager.mu.Unlock()

	manager.beginWatch(session)
	manager.endWatch(session)
	deadline := time.Now().Add(7 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := manager.getSessionWithoutTouch(session.id); !ok {
			if _, err := os.Stat(directory); !os.IsNotExist(err) {
				t.Fatalf("disconnected media session directory still exists: %v", err)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("media session survived after its browser watch disconnected")
}

func TestMediaInfoFFprobeFallbackProvidesMP4AndMXFDetails(t *testing.T) {
	ffmpegPath, ffmpegErr := exec.LookPath("ffmpeg")
	ffprobePath, ffprobeErr := exec.LookPath("ffprobe")
	if ffmpegErr != nil || ffprobeErr != nil {
		t.Skip("ffmpeg and ffprobe are required for the real media-details integration test")
	}

	tests := []struct {
		name         string
		extension    string
		contentType  string
		arguments    []string
		expectedGETs int
	}{
		{
			name:        "MP4",
			extension:   "mp4",
			contentType: "video/mp4",
			arguments: []string{
				"-f", "lavfi", "-i", "testsrc2=size=352x198:rate=25:duration=2",
				"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
				"-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
			},
			expectedGETs: 2,
		},
		{
			name:        "MXF",
			extension:   "mxf",
			contentType: "application/mxf",
			arguments: []string{
				"-f", "lavfi", "-i", "testsrc2=size=352x198:rate=25:duration=2",
				"-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2",
				"-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-c:a", "pcm_s16le", "-shortest", "-f", "mxf",
			},
			expectedGETs: 1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "sample."+test.extension)
			arguments := append([]string{"-hide_banner", "-loglevel", "error", "-y"}, test.arguments...)
			arguments = append(arguments, path)
			command := exec.Command(ffmpegPath, arguments...)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("generate %s fixture: %v: %s", test.name, err, output)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}

			app, _, backend := testApplication(t)
			backend.mu.Lock()
			backend.objects["tenant/sample."+test.extension] = memoryObject{
				data:        data,
				contentType: test.contentType,
				modified:    time.Now().UTC(),
			}
			backend.mu.Unlock()
			manager, err := newMediaSessionManager(app, app.config.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			manager.ffmpegPath = ffmpegPath
			manager.ffprobePath = ffprobePath
			app.media = manager

			server := httptest.NewServer(app.routes())
			defer server.Close()
			modified := time.Date(2026, 7, 23, 12, 34, 56, 0, time.UTC)
			query := fmt.Sprintf(
				"/api/media-info?instance=rw&key=sample.%s&mime=%s&size=%d&etag=%s&lastModified=%s",
				test.extension,
				url.QueryEscape(test.contentType),
				len(data),
				url.QueryEscape("fixture-etag"),
				url.QueryEscape(modified.Format(http.TimeFormat)),
			)
			request, err := http.NewRequest(http.MethodGet, server.URL+query, nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				body, _ := io.ReadAll(response.Body)
				t.Fatalf("media details returned HTTP %d: %s", response.StatusCode, body)
			}
			var details mediaInfoResponse
			if err := json.NewDecoder(response.Body).Decode(&details); err != nil {
				t.Fatal(err)
			}
			if details.Width != 352 || details.Height != 198 {
				t.Fatalf("unexpected %s dimensions: %dx%d", test.name, details.Width, details.Height)
			}
			if details.DurationSeconds < 1.8 || details.DurationSeconds > 2.2 {
				t.Fatalf("unexpected %s duration: %f", test.name, details.DurationSeconds)
			}
			if len(filterMediaTracks(details.Tracks, "video")) != 1 || len(filterMediaTracks(details.Tracks, "audio")) != 1 {
				t.Fatalf("expected video and audio details for %s, got %+v", test.name, details.Tracks)
			}
			backend.mu.Lock()
			providerGETs := backend.getCount
			providerHEADs := backend.headCount
			backend.mu.Unlock()
			if providerGETs != test.expectedGETs {
				t.Fatalf("%s Details performed %d provider GETs, want %d format-required object reads", test.name, providerGETs, test.expectedGETs)
			}
			if providerHEADs != 0 {
				t.Fatalf("%s Details performed %d provider HEADs despite complete listing hints", test.name, providerHEADs)
			}
		})
	}
}
