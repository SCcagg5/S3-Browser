#!/bin/sh
set -eu

ENV_FILE="${ENV_FILE:-.env}"
FORCE=0

usage() {
  echo "Usage: $0 [--force]" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    *) usage ;;
  esac
  shift
done

command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required" >&2
  exit 1
}

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "Created $ENV_FILE from .env.example"
fi

read_value() {
  key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1
}

write_value() {
  key="$1"
  value="$2"
  tmp="${ENV_FILE}.tmp.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { written = 0 }
    index($0, key "=") == 1 {
      if (!written) print key "=" value
      written = 1
      next
    }
    { print }
    END { if (!written) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

generate_if_missing() {
  key="$1"
  generator="$2"
  current="$(read_value "$key")"
  if [ "$FORCE" -eq 1 ] || [ -z "$current" ]; then
    write_value "$key" "$($generator)"
  fi
}

gen_b64() { openssl rand -base64 32 | tr -d '\n'; }
gen_hex() { openssl rand -hex 32; }

generate_if_missing ADMIN_TOKEN gen_b64
generate_if_missing METRICS_TOKEN gen_b64
generate_if_missing RPC_SECRET gen_hex

chmod 600 "$ENV_FILE" 2>/dev/null || true
echo "Local test secrets are ready in $ENV_FILE"
