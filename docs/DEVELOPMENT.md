# Development and validation

## Requirements

- Go 1.22 or newer;
- Node.js 22 or newer for frontend contract tests;
- Docker only for the optional Garage and scratch-image tests.

## Build

```sh
cd src
CGO_ENABLED=0 go build -trimpath -o s3-browser .
```

## Go validation

```sh
cd src
test -z "$(gofmt -l *.go)"
go test -count=1 ./...
go test -race -count=1 ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /tmp/s3-browser-check .
```

## Frontend validation

From the repository root:

```sh
for file in src/public/assets/js/*.js src/public/assets/js/common/*.js test/*.js; do
  node --check "$file"
done

for file in test/*.js; do
  node "$file"
done
```

The advanced object-tool contract covers:

- startup-gated version controls;
- visible-row version counts;
- Preview and Details version selectors;
- browser-only same-key version comparison;
- strict range download behavior;
- memory-only transfer checkpoints;
- per-object integrity and inspection;
- selective ZIP-compatible entry access and extraction.

## Filesystem-write check

Production Go source must not call local filesystem write APIs:

```sh
if grep -R --include='*.go' --exclude='*_test.go' \
  -E 'os\.(Create|Mkdir|MkdirAll|WriteFile|OpenFile|Remove|RemoveAll|Rename)|CreateTemp|MkdirTemp' src; then
  exit 1
fi
```

Tests may create fixtures inside their temporary test directories.

## Shell syntax

```sh
for file in test/*.sh test/garage/scripts/*.sh; do
  [ -e "$file" ] || continue
  sh -n "$file"
done
```

## PDF.js assets

The repository expects the official `pdfjs-dist` 4.10.38 ESM module and worker at:

```text
src/public/assets/vendor/pdfjs/4.10.38/pdf.min.mjs
src/public/assets/vendor/pdfjs/4.10.38/pdf.worker.min.mjs
```

Keep the Apache-2.0 license notice in the same directory. The application does not fetch these assets at startup or at runtime.

## Optional Garage stack

```sh
cd test
docker compose up --build
```

The browser container is read-only and has no application data volume. Garage keeps its own provider storage as required by the test service. Garage may return HTTP 501 for version listing; the browser must start normally and omit version controls for those buckets.

## Scratch runtime

```sh
./test/scratch-runtime.sh
```

The test builds the scratch image, checks the numeric user and static binary identity, starts the container with `--read-only`, and runs the built-in health check.

## Release validation

CI checks formatting, race tests, vet, all JavaScript contracts, shell syntax, absence of process-environment configuration, absence of local runtime write APIs, absence of external frontend assets, static linking, and the read-only scratch runtime.

Before distributing an archive, extract that exact archive into a clean directory and repeat the full validation suite there.
