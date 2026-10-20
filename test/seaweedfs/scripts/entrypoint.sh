#!/bin/sh
set -eu

# One SeaweedFS process for the tests: master, volume, filer and S3 API. The identity comes from the HCL file of the
# browser, as for the browser itself. The script creates the buckets, and then writes the ready file. The buckets of
# LOCKED_BUCKETS have Object Lock (and so versioning): a bucket gets Object Lock only at its creation.
CONFIG_FILE="/config/config.hcl"
BUCKETS="default archive"
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
mkdir -p /data /etc/seaweedfs
cat > /etc/seaweedfs/s3.json <<EOF_IDENTITY
{
  "identities": [
    {
      "name": "browser",
      "credentials": [{"accessKey": "${KEY_ID}", "secretKey": "${KEY_SECRET}"}],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
EOF_IDENTITY

weed server -dir=/data -ip=127.0.0.1 -ip.bind=0.0.0.0 -master.volumeSizeLimitMB=64 -volume.max=30 \
  -filer -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json >/tmp/seaweedfs.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; exit 0' TERM INT

attempt=0
# The healthcheck waits for the ready file, which this script writes after the buckets: wait for the S3 port here.
until wget -S -q -O /dev/null -T 2 "http://127.0.0.1:8333/" 2>&1 | grep -Eq "HTTP/1\.[01] [0-9]{3}"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 60 ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat /tmp/seaweedfs.log >&2 || true
    echo "SeaweedFS did not become ready" >&2
    exit 1
  fi
  sleep 1
done

create_bucket() {
  bucket="$1"
  options="$2"
  attempt=0
  until printf 's3.bucket.create -name %s %s\n' "$bucket" "$options" | weed shell -master=127.0.0.1:9333 >/tmp/bucket-"$bucket".log 2>&1 \
      && ! grep -qi "error\|fail" /tmp/bucket-"$bucket".log; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 20 ]; then
      cat /tmp/bucket-"$bucket".log >&2 || true
      echo "Cannot create the bucket $bucket" >&2
      exit 1
    fi
    sleep 1
  done
}

for bucket in $BUCKETS; do
  create_bucket "$bucket" ""
done
for bucket in $LOCKED_BUCKETS; do
  create_bucket "$bucket" "-withLock"
done
touch "$READY_FILE"

wait "$SERVER_PID"
