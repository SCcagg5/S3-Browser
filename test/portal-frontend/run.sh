#!/bin/sh
# Browser tests of the "portal" interface (server.frontend = "portal").
#
# The script starts the stack of compose.yaml (Garage and S3-Browser) under its own project name, puts the test
# objects in the buckets (seed.js), runs browser-tests.js in the Playwright container, and stops the stack.
# Everything runs in Docker. The Playwright container installs the playwright package (PLAYWRIGHT_VERSION) in a
# Docker volume, one time. To use a copy that is already on disk, set PLAYWRIGHT_NODE_MODULES to its node_modules.
#
# Environment: PORTAL_TEST_PROJECT (default s3-portal-tests), PLAYWRIGHT_NODE_MODULES, ONLY (a part of a test name).
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=${PORTAL_TEST_PROJECT:-s3-portal-tests}
PLAYWRIGHT_VERSION=1.48.2
PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v$PLAYWRIGHT_VERSION-jammy

compose() {
  docker compose -p "$PROJECT" -f "$DIR/compose.yaml" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

compose up --build --detach --wait

if [ -n "${PLAYWRIGHT_NODE_MODULES:-}" ]; then
  modules="$PLAYWRIGHT_NODE_MODULES:/deps/node_modules:ro"
  install=":"
else
  modules="$PROJECT-playwright:/deps"
  install="[ -d /deps/node_modules/playwright ] || npm install --prefix /deps --no-save --no-audit --no-fund --loglevel=error playwright@$PLAYWRIGHT_VERSION >/dev/null"
fi

docker run --rm \
  --network "${PROJECT}_default" \
  -e HOME=/tmp \
  -e NODE_PATH=/deps/node_modules \
  -e BASE=http://browser:8080/ \
  -e ONLY="${ONLY:-}" \
  -v "$DIR:/tests:ro" \
  -v "$modules" \
  "$PLAYWRIGHT_IMAGE" \
  sh -c "$install && node /tests/seed.js && node /tests/browser-tests.js"
