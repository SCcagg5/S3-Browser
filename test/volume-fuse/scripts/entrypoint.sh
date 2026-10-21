#!/bin/sh
set -eu

# The FUSE mount of SeaweedFS, then S3-Browser with the volume "sw" on it (config.hcl). weed mount reads and writes the
# files through the filer of the service "seaweedfs": the volume servers of that service listen on its own address
# only (-volumeServerAccess=filerProxy). The script stops when the mount or S3-Browser stops.
MOUNT_DIR="/mnt/sw"
VOLUME_DIR="$MOUNT_DIR/s3b"

mkdir -p "$MOUNT_DIR"
weed mount -filer=seaweedfs:8888 -filer.path=/ -dir="$MOUNT_DIR" -volumeServerAccess=filerProxy >/tmp/mount.log 2>&1 &
MOUNT_PID=$!

attempt=0
until grep -q " $MOUNT_DIR fuse" /proc/mounts; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 60 ] || ! kill -0 "$MOUNT_PID" 2>/dev/null; then
    cat /tmp/mount.log >&2 || true
    echo "weed mount did not mount $MOUNT_DIR: the container needs /dev/fuse, SYS_ADMIN and no AppArmor profile" >&2
    exit 1
  fi
  sleep 1
done
grep " $MOUNT_DIR " /proc/mounts

mkdir -p "$VOLUME_DIR"
/usr/local/bin/s3-browser -c /config/config.hcl &
BROWSER_PID=$!
trap 'kill "$BROWSER_PID" 2>/dev/null || true; umount "$MOUNT_DIR" 2>/dev/null || fusermount3 -u "$MOUNT_DIR" 2>/dev/null || true; kill "$MOUNT_PID" 2>/dev/null || true; exit 0' TERM INT
wait "$BROWSER_PID"
