#!/bin/sh
set -eu

BASE_URL="${1:-http://127.0.0.1:8080/s3-browser}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

request() {
  expected="$1"
  output="$2"
  shift 2
  status="$(curl -sS -o "$output" -w '%{http_code}' "$@")"
  if [ "$status" != "$expected" ]; then
    echo "Received HTTP $status; expected HTTP $expected for: curl $*" >&2
    cat "$output" >&2 || true
    exit 1
  fi
}

json_id() {
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

wait_job() {
  created_file="$1"
  result_file="$2"
  job_id="$(json_id "$created_file")"
  if [ -z "$job_id" ]; then
    echo "Unable to read job id from $created_file" >&2
    cat "$created_file" >&2
    exit 1
  fi
  attempt=0
  while [ "$attempt" -lt 240 ]; do
    request 200 "$result_file" "$BASE_URL/api/jobs/$job_id"
    if grep -q '"status":"completed"' "$result_file"; then
      return 0
    fi
    if grep -Eq '"status":"(failed|canceled)"' "$result_file"; then
      echo "Background job $job_id did not complete" >&2
      cat "$result_file" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  echo "Timed out waiting for background job $job_id" >&2
  cat "$result_file" >&2 || true
  exit 1
}

request 200 "$TMP_DIR/health.json" "$BASE_URL/healthz"
grep -q '"instances":2' "$TMP_DIR/health.json"

request 200 "$TMP_DIR/instances.json" "$BASE_URL/api/instances"
grep -q '"id":"garage-main"' "$TMP_DIR/instances.json"
grep -q '"id":"garage-archive"' "$TMP_DIR/instances.json"

for instance in garage-main garage-archive; do
  payload="test-${instance}"

  request 204 "$TMP_DIR/put" -X PUT \
    -H 'Content-Type: text/plain' \
    --data-binary "$payload" \
    "$BASE_URL/s3?instance=$instance&key=smoke%2F${instance}.txt"

  request 200 "$TMP_DIR/get.txt" "$BASE_URL/s3?instance=$instance&key=smoke%2F${instance}.txt"
  [ "$(cat "$TMP_DIR/get.txt")" = "$payload" ]

  request 200 "$TMP_DIR/list.json" \
    "$BASE_URL/api/list?instance=$instance&prefix=smoke%2F&delimiter=%2F"
  grep -q "${instance}.txt" "$TMP_DIR/list.json"

  request 200 "$TMP_DIR/permissions.json" -X POST \
    "$BASE_URL/api/permissions/refresh?instance=$instance"
  grep -q '"read"' "$TMP_DIR/permissions.json"
done

request 200 "$TMP_DIR/copy.json" -X POST \
  -H 'Content-Type: application/json' \
  --data '{"instance":"garage-main","src":"smoke/garage-main.txt","dst":"smoke/copied.txt","isPrefix":false}' \
  "$BASE_URL/api/copy"
grep -q '"copied":1' "$TMP_DIR/copy.json"

request 200 "$TMP_DIR/rename.json" -X POST \
  -H 'Content-Type: application/json' \
  --data '{"instance":"garage-main","src":"smoke/copied.txt","dst":"smoke/renamed.txt","isPrefix":false}' \
  "$BASE_URL/api/rename"
grep -q '"moved":1' "$TMP_DIR/rename.json"

# Exercise the browser-facing S3 multipart coordinator with a 17 MiB object.
dd if=/dev/zero of="$TMP_DIR/large.bin" bs=1048576 count=17 2>/dev/null
request 201 "$TMP_DIR/upload-create.json" -X POST \
  -H 'Content-Type: application/json' \
  --data '{"instance":"garage-main","key":"smoke/large.bin","size":17825792,"contentType":"application/octet-stream"}' \
  "$BASE_URL/api/uploads"
upload_id="$(json_id "$TMP_DIR/upload-create.json")"
[ -n "$upload_id" ]
dd if="$TMP_DIR/large.bin" of="$TMP_DIR/part-1.bin" bs=1048576 count=16 2>/dev/null
dd if="$TMP_DIR/large.bin" of="$TMP_DIR/part-2.bin" bs=1048576 skip=16 count=1 2>/dev/null
request 200 "$TMP_DIR/upload-part-1.json" -X PUT \
  -H 'Content-Type: application/octet-stream' \
  -H 'Content-Range: bytes 0-16777215/17825792' \
  --data-binary "@$TMP_DIR/part-1.bin" \
  "$BASE_URL/api/uploads/$upload_id"
grep -q '"uploadedBytes":16777216' "$TMP_DIR/upload-part-1.json"
request 200 "$TMP_DIR/upload-part-2.json" -X PUT \
  -H 'Content-Type: application/octet-stream' \
  -H 'Content-Range: bytes 16777216-17825791/17825792' \
  --data-binary "@$TMP_DIR/part-2.bin" \
  "$BASE_URL/api/uploads/$upload_id"
grep -q '"status":"completed"' "$TMP_DIR/upload-part-2.json"
request 200 "$TMP_DIR/large-head.txt" -I \
  "$BASE_URL/s3?instance=garage-main&key=smoke%2Flarge.bin"
grep -qi 'content-length: 17825792' "$TMP_DIR/large-head.txt"

request 202 "$TMP_DIR/stats-created.json" \
  "$BASE_URL/api/stats?instance=garage-main&prefix=smoke%2F"
wait_job "$TMP_DIR/stats-created.json" "$TMP_DIR/stats.json"
grep -q '"count":3' "$TMP_DIR/stats.json"

for instance in garage-main garage-archive; do
  request 202 "$TMP_DIR/delete-created-$instance.json" -X POST \
    -H 'Content-Type: application/json' \
    --data "{\"instance\":\"$instance\",\"prefix\":\"smoke/\"}" \
    "$BASE_URL/api/delete-prefix"
  wait_job "$TMP_DIR/delete-created-$instance.json" "$TMP_DIR/delete-$instance.json"
done

echo "Multi-instance, background-job, and multipart smoke test passed"
