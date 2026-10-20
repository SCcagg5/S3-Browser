#!/bin/sh
set -eu

# One Garage node for the tests. The identity comes from the HCL file of the browser, as for the browser itself.
# Garage needs a key ID "GK" with 24 hexadecimal characters and a secret of 64 hexadecimal characters.
# The script gives the node its layout, creates the buckets and the key, and then writes the ready file.
CONFIG_FILE="/config/config.hcl"
BUCKETS="default"
READY_FILE="/tmp/ready"
# The RPC secret and the admin token protect a node that has no published port. They are test values.
RPC_SECRET="b0a2d8f1a0e9b7c44c0b5aa9b18d8d29d9ab188f28e1c5f8c3a5d7e9f0123456"
ADMIN_TOKEN="local-test-admin-token"

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
printf '%s' "$KEY_ID" | grep -Eq '^GK[0-9a-f]{24}$' || {
  echo "access_key_id must be GK followed by 24 lowercase hexadecimal characters" >&2
  exit 1
}
printf '%s' "$KEY_SECRET" | grep -Eq '^[0-9a-f]{64}$' || {
  echo "The secret access key must have 64 lowercase hexadecimal characters" >&2
  exit 1
}

rm -f "$READY_FILE"
cat > /etc/garage.toml <<EOF_CONFIG
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_secret = "${RPC_SECRET}"
rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
api_bind_addr = "0.0.0.0:3900"
s3_region = "garage"
root_domain = ".garage"

[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token = "${ADMIN_TOKEN}"
EOF_CONFIG

garage server >/tmp/garage.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; exit 0' TERM INT

attempt=0
until garage status >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 60 ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat /tmp/garage.log >&2 || true
    echo "Garage did not become ready" >&2
    exit 1
  fi
  sleep 1
done

node_id="$(garage node id -q | cut -d'@' -f1)"
garage layout assign -z dc1 -c 1G "$node_id" >/dev/null
garage layout apply --version 1 >/dev/null
# The import gets the key ID and the secret on the command line: the container has no other process to read them.
garage key import --yes -n browser "$KEY_ID" "$KEY_SECRET" >/dev/null
for bucket in $BUCKETS; do
  garage bucket create "$bucket" >/dev/null
  garage bucket allow --read --write --owner "$bucket" --key browser >/dev/null
done
touch "$READY_FILE"

wait "$SERVER_PID"
