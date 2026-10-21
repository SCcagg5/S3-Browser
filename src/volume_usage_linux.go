//go:build linux

package main

import "syscall"

// volumeUsageSupported tells that this system gives the size of the file system of a volume (statfs).
const volumeUsageSupported = true

// volumeDelayedFileSystems are the magic numbers of statfs of the file systems that can count the used bytes with a
// delay: FUSE (for example weed mount of SeaweedFS), NFS, CephFS, SMB 2 and CIFS.
var volumeDelayedFileSystems = map[int64]bool{0x65735546: true, 0x6969: true, 0x00c36400: true, 0xfe534d42: true, 0xff534d42: true}

// volumeStatfs gives the size and the available bytes of the file system of path, and tells if the file system can
// count with a delay. The available bytes are the bytes that the process can use: the blocks that the file system keeps
// for root are not in them.
func volumeStatfs(path string) (total, available uint64, delayed bool, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, false, err
	}
	size := uint64(stat.Frsize)
	if size == 0 {
		size = uint64(stat.Bsize)
	}
	return stat.Blocks * size, stat.Bavail * size, volumeDelayedFileSystems[int64(stat.Type)], nil
}
