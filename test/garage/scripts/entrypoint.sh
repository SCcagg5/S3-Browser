#!/bin/sh
set -euo pipefail

############################################
# Script: garage_setup.sh
# Purpose: This script configures the garage system by performing the following actions:
#   1. Renders /etc/garage.toml from environment variables (secrets from env, metrics token optional).
#   2. Starts the garage server in the background.
#   3. Checks that the garage is online.
#   4. Verifies if the bucket 'default' exists; if not, it creates the bucket.
#   5. Validates the environment variables KEY_ID and KEY_SECRET and checks their format.
#   6. Imports the key and configures permissions if the key is not already present.
#   7. Kills the background garage server.
#   8. Restarts the garage server in the foreground.
#
# Requirements:
#   - Environment variables KEY_ID and KEY_SECRET must be defined.
#     * KEY_ID must be in the format: GK followed by 24 hexadecimal characters.
#     * KEY_SECRET must be 64 hexadecimal characters.
#   - Environment variables RPC_SECRET and ADMIN_TOKEN must be defined.
#   - METRICS_TOKEN is optional; if unset or empty, it will not be written in the config.
#
# Usage:
#   ./garage_setup.sh
############################################

############################################
# Function: render_config_from_env
# Purpose: Generate /etc/garage.toml from environment variables.
#          RPC_SECRET and ADMIN_TOKEN are required; METRICS_TOKEN is optional.
############################################
render_config_from_env() {
    : "${RPC_SECRET:?RPC_SECRET is required}"
    : "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"

    : "${S3_REGION:=garage}"
    : "${ROOT_DOMAIN:=.garage}"
    : "${USE_LOCAL_TZ:=false}"
    : "${REPLICATION_FACTOR:=1}"
    : "${COMPRESSION_LEVEL:=2}"

    cat > /etc/garage.toml <<EOF
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
${METRICS_TOKEN:+metrics_token = \"${METRICS_TOKEN}\"}
admin_token = "${ADMIN_TOKEN}"
EOF
    echo "Rendered /etc/garage.toml from environment."
}

############################################
# Function: start_server
# Purpose: Start the garage server in the background.
# Output: Sets the global variable SERVER_PID.
############################################
start_server() {
    echo "Starting garage server in background..."
    garage --config /etc/garage.toml server > /dev/null 2>&1 &
    SERVER_PID=$!
    echo "Garage server started with PID $SERVER_PID."
    # Allow the server time to initialize
    sleep 10
}

############################################
# Function: check_garage_status
# Purpose: Verify that the garage system is online.
#          If the status check fails, the server is killed and the script exits.
############################################
check_garage_status() {
    echo "Checking garage status..."
    if ! garage status > /dev/null 2>&1; then
        echo "Error: 'garage status' did not execute successfully."
        kill_server
        exit 1
    fi
    echo " - Garage is online."
}

############################################
# Function: create_default_bucket
# Purpose: Check if the 'default' bucket exists in the first column.
#          If it does not exist, retrieve the node ID, assign the layout,
#          and create the 'default' bucket.
############################################
create_default_bucket() {
    echo "Checking if bucket 'default' exists..."
    if ! garage bucket list | grep -wq default; then
        echo " - Bucket 'default' not found. Starting creation process."
        node_id=$(garage node id 2>/dev/null | head -n 1 | cut -d'@' -f1)
        echo " - Node ID retrieved: $node_id"
        echo " - Assigning layout in zone dc1 with 10G..."
        garage layout assign -z dc1 -c 1000G "$node_id" > /dev/null 2>&1
        echo " - Applying layout version 1..."
        garage layout apply --version 1 > /dev/null 2>&1
        echo " - Creating bucket 'default'..."
        garage bucket create default > /dev/null 2>&1
        echo " - Bucket 'default' created."
    else
        echo " - Bucket 'default' already exists. Skipping creation step."
    fi
}

############################################
# Function: verify_env_keys
# Purpose: Check that the environment variables KEY_ID and KEY_SECRET are set,
#          and verify that they are in the correct format.
#          Exits the script (after killing the server) if any checks fail.
############################################
verify_env_keys() {
    echo "Verifying environment variables KEY_ID and KEY_SECRET..."
    if [ -z "${KEY_ID:-}" ] || [ -z "${KEY_SECRET:-}" ]; then
        echo "Error: Environment variables KEY_ID and KEY_SECRET must be set."
        kill_server
        exit 1
    fi
    echo " - Environment variables are set."

    echo "Verifying KEY_ID format..."
    if ! printf '%s' "$KEY_ID" | grep -Eq '^GK[0-9a-f]{24}$'; then
        echo "Error: KEY_ID ('$KEY_ID') is not in the correct format. Expected: GK followed by 24 hexadecimal digits."
        kill_server
        exit 1
    fi
    echo " - KEY_ID format is correct."

    echo "Verifying KEY_SECRET format..."
    if ! printf '%s' "$KEY_SECRET" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "Error: KEY_SECRET ('$KEY_SECRET') is not in the correct format. Expected: 64 hexadecimal digits."
        kill_server
        exit 1
    fi
    echo " - KEY_SECRET format is correct."
}

############################################
# Function: import_key_if_needed
# Purpose: Check if the key specified by KEY_ID exists in 'garage key list'.
#          If not, import the key and configure permissions for the 'default' bucket.
############################################
import_key_if_needed() {
    echo "Checking if key is already present in 'garage key list'..."
    if ! garage key list | grep -E -q "^[[:space:]]*$KEY_ID[[:space:]]" && \
       ! garage key list | grep -E -q '^[[:space:]]*default[[:space:]]'; then
        echo " - Key not found. Importing key..."
        garage key import --yes "$KEY_ID" "$KEY_SECRET" -n default > /dev/null 2>&1
        echo " - Key imported successfully."
        echo " - Configuring permissions for bucket 'default'..."
        garage bucket allow --read --write --owner default --key default > /dev/null 2>&1
        echo " - Permissions configured."
    else
        echo " - Key already exists. Skipping key import and permission configuration."
    fi
}

############################################
# Function: kill_server
# Purpose: Kill the background garage server.
############################################
kill_server() {
    echo "Killing the garage server with PID $SERVER_PID..."
    kill "$SERVER_PID"
    sleep 1
    echo "Garage server killed."
}

############################################
# Function: restart_server
# Purpose: Restart the garage server in the foreground.
############################################
restart_server() {
    echo "Restarting the garage server in foreground..."
    garage --config /etc/garage.toml server
}

############################################
# Main Script Execution
############################################

render_config_from_env
start_server
check_garage_status
create_default_bucket
verify_env_keys
import_key_if_needed
kill_server
restart_server
