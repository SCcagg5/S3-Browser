# Development and validation

## Requirements

- Go 1.22 or newer;
- Node.js 22 or newer for frontend contract tests;
- Docker only for the optional Garage integration stack.

## Build

```sh
cd src
CGO_ENABLED=0 go build -trimpath -o s3-browser .
```

## Test

```sh
cd src
gofmt -w *.go
go test -count=1 ./...
go test -race -count=1 ./...
go vet ./...
```

Frontend checks from the repository root:

```sh
for file in src/public/assets/js/*.js src/public/assets/js/common/*.js test/*.js; do
  node --check "$file"
done
for file in test/*.js; do
  node "$file"
done
```

Shell syntax:

```sh
for file in test/*.sh test/garage/scripts/*.sh; do
  [ -e "$file" ] || continue
  sh -n "$file"
done
```

## PDF.js assets

The repository expects the pinned local PDF.js module and worker at:

```text
src/public/assets/vendor/pdfjs/4.10.38/pdf.min.mjs
src/public/assets/vendor/pdfjs/4.10.38/pdf.worker.min.mjs
```

Place the official `pdfjs-dist` 4.10.38 browser ESM build files there before compiling a release. Keep the Apache-2.0 license notice in the same directory. The application does not download them at startup.

## Optional Garage integration test

```sh
cd test
docker compose up --build
```

The test configuration contains fixed credentials for the isolated Garage service defined by the compose stack. They are not production credentials.

## Release checks

CI verifies:

- Go formatting, tests, race detector, and vet;
- JavaScript syntax and frontend contracts;
- shell syntax;
- absence of external commands and font binaries;
- absence of runtime external asset URLs;
- absence of runtime environment configuration APIs;
- HCL configuration and relative-URL reverse-proxy contracts;
- a statically linked Linux binary;
- the scratch-container runtime.
