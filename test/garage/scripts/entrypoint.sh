#!/bin/sh
set -eu

: "${RPC_SECRET:?RPC_SECRET is required}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"

BROWSER_CONFIG_FILE="${BROWSER_CONFIG_FILE:-/config/config.hcl}"
S3_REGION="${S3_REGION:-garage}"
ROOT_DOMAIN="${ROOT_DOMAIN:-.garage}"
USE_LOCAL_TZ="${USE_LOCAL_TZ:-false}"
REPLICATION_FACTOR="${REPLICATION_FACTOR:-1}"
COMPRESSION_LEVEL="${COMPRESSION_LEVEL:-2}"

if [ ! -r "$BROWSER_CONFIG_FILE" ]; then
  echo "Browser HCL config is not readable: $BROWSER_CONFIG_FILE" >&2
  exit 1
fi

read_hcl_string() {
  attribute="$1"
  sed -n "s/^[[:space:]]*${attribute}[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$BROWSER_CONFIG_FILE" | head -n 1
}

KEY_ID="$(read_hcl_string access_key_id)"
KEY_SECRET="$(read_hcl_string secret_access_key)"

if [ -z "$KEY_ID" ] || [ -z "$KEY_SECRET" ]; then
  echo "The first S3 storage block in $BROWSER_CONFIG_FILE must define access_key_id and secret_access_key" >&2
  exit 1
fi

printf '%s' "$KEY_ID" | grep -Eq '^GK[0-9a-f]{24}$' || {
  echo "access_key_id must be GK followed by 24 lowercase hexadecimal characters" >&2
  exit 1
}
printf '%s' "$KEY_SECRET" | grep -Eq '^[0-9a-f]{64}$' || {
  echo "secret_access_key must contain 64 lowercase hexadecimal characters" >&2
  exit 1
}

metrics_line=""
if [ -n "${METRICS_TOKEN:-}" ]; then
  metrics_line="metrics_token = \"${METRICS_TOKEN}\""
fi

cat > /etc/garage.toml <<EOF_CONFIG
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = ${REPLICATION_FACTOR}
use_local_tz = ${USE_LOCAL_TZ}
compression_level = ${COMPRESSION_LEVEL}
rpc_secret = "${RPC_SECRET}"
rpc_bind_addr = "0.0.0.0:3901"
rpc_bind_outgoing = false
rpc_public_addr = "0.0.0.0:3901"

[s3_api]
api_bind_addr = "0.0.0.0:3900"
s3_region = "${S3_REGION}"
root_domain = "${ROOT_DOMAIN}"

[s3_web]
bind_addr = "0.0.0.0:3902"
root_domain = "${ROOT_DOMAIN}"
add_host_to_metrics = true

[admin]
api_bind_addr = "0.0.0.0:3903"
${metrics_line}
admin_token = "${ADMIN_TOKEN}"
EOF_CONFIG

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

garage --config /etc/garage.toml server >/tmp/garage-bootstrap.log 2>&1 &
SERVER_PID=$!

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if garage status >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  cat /tmp/garage-bootstrap.log >&2 || true
  echo "Garage did not become ready" >&2
  exit 1
fi

if ! garage bucket list | grep -wq default; then
  node_id="$(garage node id 2>/dev/null | head -n 1 | cut -d'@' -f1)"
  garage layout assign -z dc1 -c 1000G "$node_id" >/dev/null
  garage layout apply --version 1 >/dev/null
fi

for bucket in default archive; do
  if ! garage bucket list | grep -wq "$bucket"; then
    garage bucket create "$bucket" >/dev/null
  fi
done

if ! garage key list | grep -Fq "$KEY_ID"; then
  garage key import --yes "$KEY_ID" "$KEY_SECRET" -n browser >/dev/null
fi
for bucket in default archive; do
  garage bucket allow --read --write --owner "$bucket" --key browser >/dev/null
done

cleanup
SERVER_PID=""
trap - EXIT INT TERM
exec garage --config /etc/garage.toml server
