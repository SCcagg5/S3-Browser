#!/bin/sh
set -euo pipefail

############################################
# Script: healthcheck.sh
# Purpose: This script checks the cluster health status of Garage.
#   1. Executes `garage json-api GetClusterHealth` to retrieve cluster status.
#   2. Verifies that the returned JSON contains `"status":"healthy"`.
#   3. Exits with code 0 if healthy, or 1 if not.
#
# Exit Codes:
#   0 - Cluster is healthy
#   1 - Cluster is unhealthy
#
# Usage:
#   ./healthcheck.sh
############################################

############################################
# Function: check_cluster_health
# Purpose: Execute the cluster health check and parse the result.
#          Returns success if status is "healthy".
############################################
check_cluster_health() {
    out="$(garage json-api GetClusterHealth 2>/dev/null || true)"
    echo "$out" | grep -q '"status": "healthy"' && {
        echo "Cluster health: OK"
        exit 0
    }
    echo "Cluster health: Unhealthy"
    exit 1
}

############################################
# Main Script Execution
############################################

check_cluster_health
