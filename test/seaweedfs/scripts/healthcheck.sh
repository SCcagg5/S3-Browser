#!/bin/sh
set -eu

# The S3 API answers (any HTTP status) when it is up. A closed port fails.
wget -q -O /dev/null -T 2 --spider "http://127.0.0.1:8333/" 2>&1 | grep -q "Connection refused" && exit 1
wget -S -q -O /dev/null -T 2 "http://127.0.0.1:8333/" 2>&1 | grep -Eq "HTTP/1\.[01] [0-9]{3}"
