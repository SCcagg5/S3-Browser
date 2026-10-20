#!/bin/sh
set -eu

# The service is healthy when the entrypoint created the buckets and the S3 API is ready.
test -f /tmp/ready
curl -fs -o /dev/null "http://127.0.0.1:9000/minio/health/ready"
