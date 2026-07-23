#!/bin/sh
set -eu

output="$(garage json-api GetClusterHealth 2>/dev/null || true)"
printf '%s\n' "$output" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"'
