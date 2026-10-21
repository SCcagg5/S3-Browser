#!/bin/sh
# The real test of a volume on a FUSE mount of SeaweedFS (weed mount).
#
# The script starts the stack of compose.yaml under its own project name: the SeaweedFS of the tests, and the container
# "mount" with weed mount on /mnt/sw and S3-Browser with the volume "sw" on /mnt/sw/s3b. Only "mount" has /dev/fuse,
# SYS_ADMIN and no AppArmor profile. Then it runs the Go tests of the volumes in a folder of the mount, and the browser
# smoke test (smoke.js) in the Playwright container. At the end, it stops the stack and removes its volumes.
#
# Environment: VOLUME_FUSE_PROJECT (default s3-volmount), PLAYWRIGHT_NODE_MODULES.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=${VOLUME_FUSE_PROJECT:-s3-volmount}
PLAYWRIGHT_VERSION=1.48.2
PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v$PLAYWRIGHT_VERSION-jammy

compose() {
  docker compose -p "$PROJECT" -f "$DIR/compose.yaml" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! compose up --build --detach --wait; then
  compose logs mount >&2 || true
  echo "The FUSE mount did not start. This machine may refuse FUSE in Docker: refer to test/README.md." >&2
  exit 1
fi
compose exec -T mount grep ' /mnt/sw ' /proc/mounts

echo "Go tests of the volumes on the FUSE mount"
compose exec -T mount sh -c 'mkdir -p /mnt/sw/s3b-go && cd /src && status=0 && go test -count=1 -run "TestVolume" -v . -args -volume-dir=/mnt/sw/s3b-go >/tmp/go-test.log 2>&1 || status=$?; grep -E "^(--- |ok|FAIL|PASS)" /tmp/go-test.log; [ "$status" -eq 0 ] || tail -n 60 /tmp/go-test.log; exit "$status"'

if [ -n "${PLAYWRIGHT_NODE_MODULES:-}" ]; then
  modules="$PLAYWRIGHT_NODE_MODULES:/deps/node_modules:ro"
  install=":"
else
  modules="$PROJECT-playwright:/deps"
  install="[ -d /deps/node_modules/playwright ] || npm install --prefix /deps --no-save --no-audit --no-fund --loglevel=error playwright@$PLAYWRIGHT_VERSION >/dev/null"
fi

echo "Browser smoke test on the FUSE mount"
docker run --rm \
  --network "container:$(compose ps -q mount)" \
  -e HOME=/tmp \
  -e NODE_PATH=/deps/node_modules \
  -e BASE=http://localhost:8080/ \
  -v "$DIR:/tests:ro" \
  -v "$modules" \
  "$PLAYWRIGHT_IMAGE" \
  sh -c "$install && node /tests/smoke.js"
