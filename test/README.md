# Local integration stack

This stack runs Object Storage Browser with two independent S3 instances backed by one local Garage server: `garage-main/default` and `garage-archive/archive`.

The deterministic local-only Garage access key and secret are defined in `config.hcl`. The Garage bootstrap container reads that same mounted file, so the values are not duplicated in `.env` or Compose environment variables. Browser job and upload state is stored in the `browser-data` volume.

The browser image always uses the final `scratch` target. It contains the static Go binary and CA certificates only, runs as the non-root user `65532:65532`, and has no external command dependency. Storage operations, SQLite table browsing, metadata parsing, and supported previews are implemented in the binary or embedded browser assets. Video preview remains disabled, and RAW files without a browser-readable original or embedded JPEG report that preview is unavailable.

```sh
cd test
./setup.sh
docker compose up --build -d
./smoke.sh
docker compose logs -f s3-browser
```

The interface is available at `http://localhost:8080` by default. Set `PORT` in `.env` to use another host port.

Regenerate local Garage administrative secrets and recreate the stack:

```sh
./setup.sh --force
docker compose up --build -d --force-recreate
```

Validate the production scratch image and its in-container health check:

```sh
./scratch-runtime.sh
```

Run the dependency-free frontend checks without Docker:

```sh
node frontend-smoke.js
node json-viewer.js
node transfer-controls.js
node stats-viewer.js
node sqlite-viewer.js
```

The values generated in `.env` are for local development only. Stop the stack and remove all local volumes with:

```sh
docker compose down -v
```
