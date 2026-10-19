# Development and validation

## Requirements

- Go 1.22 or newer;
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

## Configuration reference

`docs/configuration-reference.md` is generated from the table of keys in `src/config_keys.go`. After a change of the table, make it again:

```sh
cd src
go run . config-reference > ../docs/configuration-reference.md
```

The test `TestConfigurationReferenceIsCurrent` fails when the file and the table do not agree.

## Access tests

The tests of the access of humans (`src/access_*_test.go`) start the server in the `authzen` mode with a fake AuthZEN PDP and identity tokens that the tests sign. They need no network and no container. Refer to [ACCESS.md](ACCESS.md#tests).

## Frontend

The frontend under `src/public` is plain HTML, CSS and JavaScript embedded into the binary. It has no build step and no
JavaScript toolchain: edit the files, rebuild the binary (or the test image) and reload. The object browser page
(`public/index.html`, `assets/js/app.js`) renders its DOM directly; there is no framework.

The test frontend under `src/frontends/portal` follows the same rules. To use it, set `frontend = "portal"` in the `server` block.

- Change a colour, a size, a radius or a duration in the tokens at the top of `assets/css/portal.css`. The components name tokens only.
- A new icon name needs a rule in `assets/css/icons.css` and a Tabler file in `assets/icons/tabler/`.
- `go test ./...` runs `TestPortalFrontendIsSelfContained`. It finds an external URL, a missing asset, a missing icon file and an icon name without a rule.

### Browser tests of the portal frontend

`test/portal-frontend/run.sh` starts Garage and S3-Browser with `frontend = "portal"`. It uses Docker Compose with the project name `s3-portal-tests`. Then it puts test objects in the buckets and runs `browser-tests.js` in the Playwright container. The tests cover the theme selector, the header, the bucket selector, the breadcrumb and the toolbar row, the bulk upload and the access behaviour. At the end, the script stops the stack.

```sh
./test/portal-frontend/run.sh
```

The Playwright container installs the `playwright` package one time, in a Docker volume. To use a copy that is already on disk, set `PLAYWRIGHT_NODE_MODULES` to its `node_modules` directory. To run some tests only, set `ONLY` to a part of their names.

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

CI checks formatting, race tests, vet, all JavaScript contracts, shell syntax, absence of process-environment configuration (only `src/config_env.go` may read a variable that an `_env` attribute names), absence of local runtime write APIs, absence of external frontend assets, static linking, and the read-only scratch runtime.

Before distributing an archive, extract that exact archive into a clean directory and repeat the full validation suite there.
