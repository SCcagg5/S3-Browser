//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDeletingMediaSessionTerminatesWholeProcessGroup(t *testing.T) {
	root := t.TempDir()
	pidFile := filepath.Join(root, "worker.pid")
	script := filepath.Join(root, "slow-ffmpeg")
	body := fmt.Sprintf(`#!/bin/sh
set -eu
echo $$ > %s
trap 'exit 0' TERM INT
sleep 120 &
wait
`, shellSingleQuote(pidFile))
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}

	manager, err := newMediaSessionManager(&application{}, root)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.close()
	manager.ffmpegPath = script

	directory := filepath.Join(manager.root, "session")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	video := mediaTrackInfo{Index: 0, Type: "video", Codec: "h264", Width: 320, Height: 180}
	session := &mediaSession{
		id:              "session",
		directory:       directory,
		durationSeconds: 120,
		videoTrack:      &video,
		state:           "ready",
		updatedAt:       time.Now().UTC(),
		ctx:             ctx,
		cancel:          cancel,
		windows:         make(map[string]*mediaWindowJob),
	}
	manager.mu.Lock()
	manager.sessions[session.id] = session
	manager.mu.Unlock()
	job := manager.ensureWindow(session, 0, -1, "http://127.0.0.1")

	var pid int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, readErr := os.ReadFile(pidFile)
		if readErr == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
			if pid > 0 {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid <= 0 {
		t.Fatal("test FFmpeg replacement did not start")
	}

	if !manager.delete(session.id) {
		t.Fatal("media session was not deleted")
	}
	select {
	case <-job.done:
	case <-time.After(5 * time.Second):
		t.Fatal("media process did not stop after deleting the session")
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("session directory still exists: %v", err)
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatalf("media process %d is still running", pid)
	}
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
