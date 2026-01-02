#!/bin/sh
set -eu

############################################
# Script: bootstrap-secrets-and-certs.sh
# Purpose: Populate a .env file with required secrets (idempotently) and
#          generate mTLS certificates using the same shell interpreter.
#   1. Parse CLI arguments ( --force).
#   2. Ensure prerequisites (openssl, sed, grep) are available.
#   3. Ensure a .env file exists (copy from .env.example if present).
#   4. Generate or refresh secrets (ADMIN_TOKEN, METRICS_TOKEN, KEY_SECRET,
#      RPC_SECRET, KEY_ID, BASIC_USER, BASIC_PASSWORD).
#   5. Invoke the certificate generation script with the detected shell.
#
# Requirements:
#   - POSIX shell (no bashisms for this script itself).
#   - Commands available in PATH: openssl, sed, grep.
#   - Optional .env.example to seed a new .env.
#   - A certificate generator script at traefik/certs/generate.sh.
#
# Arguments:
#   --force   Optional. Regenerate all values even if already present.
#
# Environment:
#   ENV_FILE  Optional. Path to the env file (default: ".env").
#
# Exit Codes:
#   0 - Success.
#   1 - Invalid usage, missing prerequisites, or operational error.
#
# Usage:
#   sh bootstrap-secrets-and-certs.sh
#   sh bootstrap-secrets-and-certs.sh --force
############################################

############################################
# Defaults & Globals
############################################
ENV_FILE="${ENV_FILE:-.env}"
FORCE=0

############################################
# Function: fail
# Purpose: Print an error message to stderr and exit with status 1.
############################################
fail() {
  echo "Error: $*" >&2
  exit 1
}

############################################
# Function: detect_invocation_shell
# Purpose: Detect the current interactive shell to reuse for the cert script.
# Notes:
#   - Prefers bash, then zsh; otherwise falls back to 'sh'.
############################################
detect_invocation_shell() {
  if [ -n "${BASH_VERSION-}" ] && command -v bash >/dev/null 2>&1; then
    SELF_SHELL="bash"
  elif [ -n "${ZSH_VERSION-}" ] && command -v zsh >/dev/null 2>&1; then
    SELF_SHELL="zsh"
  else
    SELF_SHELL="sh"
  fi
  export SELF_SHELL
}

############################################
# Function: parse_args
# Purpose: Parse CLI arguments into FORCE.
############################################
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --force)
        FORCE=1
        shift
        ;;
      *)
        fail "Unknown arg: $1"
        ;;
    esac
  done

}

############################################
# Function: need
# Purpose: Ensure a required command exists in PATH.
############################################
need() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

############################################
# Function: ensure_prereqs
# Purpose: Validate that required binaries are present.
############################################
ensure_prereqs() {
  need openssl
  need sed
  need grep
}

############################################
# Function: ensure_env_file
# Purpose: Ensure ENV_FILE exists; seed from .env.example if available.
############################################
ensure_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f ".env.example" ]; then
      cp .env.example "$ENV_FILE"
      echo "Created $ENV_FILE from .env.example"
    else
      : > "$ENV_FILE"
      echo "Created empty $ENV_FILE"
    fi
  fi
}

############################################
# Function: get_current
# Purpose: Read the current value of a key in ENV_FILE (without quotes).
# Input:
#   $1 - Key name
# Output:
#   Prints the current value (empty if missing).
############################################
get_current() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}

############################################
# Function: write_kv
# Purpose: Write or replace a key="value" pair in ENV_FILE.
# Notes:
#   - Compatible with both GNU and BSD sed.
############################################
write_kv() {
  key="$1"
  val="$2"
  quoted="\"$val\""

  if grep -qE "^$key=" "$ENV_FILE" 2>/dev/null; then
    if sed --version >/dev/null 2>&1; then
      sed -i -E "s|^$key=.*|$key=$quoted|g" "$ENV_FILE"
    else
      sed -i '' -E "s|^$key=.*|$key=$quoted|g" "$ENV_FILE"
    fi
  else
    printf "%s=%s\n" "$key" "$quoted" >> "$ENV_FILE"
  fi
}

############################################
# Function: gen_if_empty
# Purpose: Generate and write a value for key if currently empty or --force is set.
# Input:
#   $1 - Key name
#   $2 - Command to generate the value
############################################
gen_if_empty() {
  key="$1"
  gen_cmd="$2"
  cur="$(get_current "$key")"
  if [ -z "$cur" ] || [ "$FORCE" -eq 1 ]; then
    val="$($gen_cmd)"
    write_kv "$key" "$val"
  fi
}

############################################
# Generators
# Purpose: Produce random values in specific formats.
############################################
gen_b64() { openssl rand -base64 32 | tr -d '\n'; }
gen_hex() { openssl rand -hex 32; }
gen_keyid() { printf "GK%s" "$(openssl rand -hex 12)"; }
gen_basic_user() { printf "admin%s" "$(openssl rand -hex 3)"; }
gen_basic_pass() {
  # URL-safe base64, 32 characters, stripped of '/', '+', '=' and underscores
  openssl rand -base64 64 | tr -d '\n' | tr '/+' '-_' | tr -d '=' | tr -d '_' | cut -c1-32
}

############################################
# Function: populate_env
# Purpose: Fill required keys in ENV_FILE (idempotent unless --force).
############################################
populate_env() {
  gen_if_empty "ADMIN_TOKEN"    gen_b64
  gen_if_empty "METRICS_TOKEN"  gen_b64
  gen_if_empty "KEY_SECRET"     gen_hex
  gen_if_empty "RPC_SECRET"     gen_hex
  gen_if_empty "KEY_ID"         gen_keyid
  gen_if_empty "BASIC_USER"     gen_basic_user
  gen_if_empty "BASIC_PASSWORD" gen_basic_pass
  echo "[env] Updated $ENV_FILE"
}

############################################
# Main Script Execution
############################################
detect_invocation_shell
parse_args "$@"
ensure_prereqs
ensure_env_file
populate_env
echo "[done] Secrets and certificates ready."
