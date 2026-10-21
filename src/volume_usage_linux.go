//go:build linux

package main

import "syscall"

// volumeUsageSupported tells that this system gives the size of the file system of a volume (statfs).
const volumeUsageSupported = true

// volumeStatfs gives the size and the available bytes of the file system of path. The available bytes are the bytes
// that the process can use: the blocks that the file system keeps for root are not in them.
func volumeStatfs(path string) (total, available uint64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	size := uint64(stat.Frsize)
	if size == 0 {
		size = uint64(stat.Bsize)
	}
	return stat.Blocks * size, stat.Bavail * size, nil
}
