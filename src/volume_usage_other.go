//go:build !linux

package main

import "errors"

// volumeUsageSupported tells that this system does not give the size of the file system of a volume: the interface
// shows no usage for a volume. The release builds are for Linux only.
const volumeUsageSupported = false

func volumeStatfs(string) (uint64, uint64, error) {
	return 0, 0, errors.New("statfs is not available on this system")
}
