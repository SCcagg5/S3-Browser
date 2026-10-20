#!/bin/sh
set -eu

# One MinIO server with one drive for the tests. The identity comes from the HCL file of the browser, as for the
# browser itself. The script creates the buckets through the S3 API and then writes the ready file. The buckets of
# LOCKED_BUCKETS have Object Lock (and so versioning): a bucket gets Object Lock only at its creation.
CONFIG_FILE="/config/config.hcl"
BUCKETS="default"
LOCKED_BUCKETS="locked"
READY_FILE="/tmp/ready"

if [ ! -r "$CONFIG_FILE" ]; then
  echo "Browser HCL config is not readable: $CONFIG_FILE" >&2
  exit 1
fi

read_hcl_string() {
  attribute="$1"
  sed -n "s/^[[:space:]]*${attribute}[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG_FILE" | head -n 1
}

KEY_ID="$(read_hcl_string access_key_id)"
# The browser reads the secret from a file (a secret is never in clear text in the HCL file).
KEY_SECRET_FILE="$(read_hcl_string secret_access_key_file)"
KEY_SECRET=""
if [ -n "$KEY_SECRET_FILE" ] && [ -r "$KEY_SECRET_FILE" ]; then
  KEY_SECRET="$(head -n 1 "$KEY_SECRET_FILE")"
fi
if [ -z "$KEY_ID" ] || [ -z "$KEY_SECRET" ]; then
  echo "The S3 auth block in $CONFIG_FILE must define access_key_id and a readable secret_access_key_file" >&2
  exit 1
fi

rm -f "$READY_FILE"
mkdir -p /data
MINIO_ROOT_USER="$KEY_ID" MINIO_ROOT_PASSWORD="$KEY_SECRET" MINIO_BROWSER=off \
  minio server /data --address :9000 --quiet >/tmp/minio.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; exit 0' TERM INT

attempt=0
until curl -fs -o /dev/null "http://127.0.0.1:9000/minio/health/ready"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 60 ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat /tmp/minio.log >&2 || true
    echo "MinIO did not become ready" >&2
    exit 1
  fi
  sleep 1
done

# curl signs the request with SigV4. The credentials go on the standard input, not on the command line.
create_bucket() {
  bucket="$1"
  lock="$2"
  printf 'user = "%s:%s"\n' "$KEY_ID" "$KEY_SECRET" \
    | curl -fsS -K - --aws-sigv4 "aws:amz:us-east-1:s3" -X PUT -H "x-amz-bucket-object-lock-enabled: $lock" \
      -o /dev/null "http://127.0.0.1:9000/$bucket" || {
      echo "Cannot create the bucket $bucket" >&2
      exit 1
    }
}

for bucket in $BUCKETS; do
  create_bucket "$bucket" false
done
for bucket in $LOCKED_BUCKETS; do
  create_bucket "$bucket" true
done
touch "$READY_FILE"

wait "$SERVER_PID"
