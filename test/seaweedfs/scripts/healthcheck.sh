#!/bin/sh
set -eu

# The service is healthy when the entrypoint created the buckets and the S3 API answers (any HTTP status). A closed
# port fails.
test -f /tmp/ready
wget -q -O /dev/null -T 2 --spider "http://127.0.0.1:8333/" 2>&1 | grep -q "Connection refused" && exit 1
wget -S -q -O /dev/null -T 2 "http://127.0.0.1:8333/" 2>&1 | grep -Eq "HTTP/1\.[01] [0-9]{3}"
