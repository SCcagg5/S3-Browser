package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
)

// quarantineUnknownState removes persistent state that can no longer be
// associated with a configured bucket. Moving it aside keeps the original data
// available for inspection without making every subsequent process start fail.
func quarantineUnknownState(directory, filename, stateKind, instanceID string) {
	source := filepath.Join(directory, filename)
	orphanedDir := filepath.Join(directory, "orphaned")
	if err := os.MkdirAll(orphanedDir, 0o700); err == nil {
		target := filepath.Join(orphanedDir, filename)
		if err := os.Rename(source, target); err == nil {
			log.Printf("moved %s state %q for removed bucket %q to %s", stateKind, filename, instanceID, orphanedDir)
			return
		}
	}
	if err := os.Remove(source); err == nil || errors.Is(err, os.ErrNotExist) {
		log.Printf("removed %s state %q for removed bucket %q", stateKind, filename, instanceID)
		return
	}
	log.Printf("ignored %s state %q for removed bucket %q because it could not be quarantined", stateKind, filename, instanceID)
}
