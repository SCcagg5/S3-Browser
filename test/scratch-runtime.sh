#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IMAGE=${SCRATCH_IMAGE_NAME:-s3-browser:scratch-test}
CONTAINER="s3-browser-scratch-test-$$"

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for the scratch runtime test" >&2
  exit 1
fi

if ! grep -Eq '^FROM scratch AS runtime$' "$ROOT/test/browser/Dockerfile"; then
  echo "the default runtime stage must use FROM scratch" >&2
  exit 1
fi

docker build \
  --build-arg "VERSION=${BUILD_VERSION:-dev}" \
  --build-arg "COMMIT=${BUILD_COMMIT:-unknown}" \
  --build-arg "BUILD_DATE=${BUILD_DATE:-}" \
  --target runtime \
  --file "$ROOT/test/browser/Dockerfile" \
  --tag "$IMAGE" \
  "$ROOT"

VERSION_OUTPUT=$(docker run --rm "$IMAGE" version)
EXPECTED_VERSION=${BUILD_VERSION:-dev}
EXPECTED_COMMIT=${BUILD_COMMIT:-unknown}
if [ "$EXPECTED_COMMIT" != "unknown" ] && [ -n "$EXPECTED_COMMIT" ]; then
  EXPECTED_SHORT_COMMIT=$(printf '%s' "$EXPECTED_COMMIT" | cut -c1-9)
  EXPECTED_IDENTITY="$EXPECTED_VERSION · $EXPECTED_SHORT_COMMIT"
else
  EXPECTED_IDENTITY=$EXPECTED_VERSION
fi
case "$VERSION_OUTPUT" in
  *"$EXPECTED_IDENTITY"*) ;;
  *)
    echo "scratch image version output does not contain $EXPECTED_IDENTITY: $VERSION_OUTPUT" >&2
    exit 1
    ;;
esac

USER_VALUE=$(docker image inspect --format '{{.Config.User}}' "$IMAGE")
if [ "$USER_VALUE" != "65532:65532" ]; then
  echo "scratch image must run as 65532:65532, got $USER_VALUE" >&2
  exit 1
fi

docker run \
  --detach \
  --name "$CONTAINER" \
  --volume "$ROOT/test/config.hcl:/config/config.hcl:ro" \
  "$IMAGE" >/dev/null

attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$CONTAINER" /s3-browser healthcheck -c /config/config.hcl >/dev/null 2>&1; then
    echo "scratch runtime healthcheck passed"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "scratch runtime did not become healthy" >&2
docker logs "$CONTAINER" >&2 || true
exit 1
