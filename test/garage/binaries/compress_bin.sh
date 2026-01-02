#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 <DIR> <EXPECTED_NAME_IN_ARCHIVE>" >&2
  exit 1
fi

DIR="$1"
EXPECTED="$2"

if [[ -z "$EXPECTED" || "$EXPECTED" == */* ]]; then
  echo "Error: <EXPECTED_NAME_IN_ARCHIVE> must be a simple filename without slashes." >&2
  exit 1
fi

if [[ ! -d "$DIR" ]]; then
  echo "Error: directory '$DIR' not found." >&2
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "Error: 'tar' is required." >&2
  exit 1
fi

shopt -s nullglob

IGNORE_EXTS=("*.tgz" "*.tar.gz" "*.tar.zst" "*.tar.xz" "*.txz" "*.tar.bz2" "*.tbz2" "*.zip" "*.gz" "*.xz" "*.bz2" "*.zst" "*.sh" "*.bash" "*.md")

to_process=()
for f in "$DIR"/*; do
  [[ -f "$f" ]] || continue
  skip=false
  for pat in "${IGNORE_EXTS[@]}"; do
    if [[ "$(basename -- "$f")" == $pat ]]; then
      skip=true
      break
    fi
  done
  $skip && continue
  to_process+=("$f")
done

if (( ${#to_process[@]} == 0 )); then
  echo "Nothing to package in '$DIR'."
  exit 0
fi

for filepath in "${to_process[@]}"; do
  filename="$(basename -- "$filepath")"
  tgz_path="$DIR/${filename}.tgz"

  if [[ -e "$tgz_path" ]]; then
    echo "Archive already exists, skipping: $tgz_path"
    continue
  fi

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  cp -- "$filepath" "$tmpdir/$EXPECTED"

  tar -C "$tmpdir" -czf "$tgz_path" "$EXPECTED"

  if ! tar -tzf "$tgz_path" | grep -qx "$EXPECTED"; then
    echo "Verification failed: unexpected content in $tgz_path" >&2
    rm -f "$tgz_path"
    rm -rf "$tmpdir"
    trap - RETURN
    continue
  fi

  rm -f -- "$filepath"
  rm -rf "$tmpdir"
  trap - RETURN

  echo "Created: $(basename -- "$tgz_path"); deleted original: $filename"
done

echo "Done."
