# Local integration stack

This stack runs Object Storage Browser with two independent S3 instances backed by one local Garage server: `garage-main/default` and `garage-archive/archive`.

The deterministic local-only Garage access key and secret are defined in `config.hcl`. The Garage bootstrap container reads that same mounted file, so the values are not duplicated in `.env` or Compose environment variables. Browser job and upload state is stored in the `browser-data` volume.

The browser image installs ffprobe through the FFmpeg package and also installs ImageMagick. Video preview is disabled; ffprobe is used only after an explicit Details action when the lightweight container parser cannot determine media metadata. ImageMagick remains an explicit uncommon-image fallback. The application runs as the non-root user `65532:65532`.

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

Run the dependency-free frontend checks without Docker:

```sh
node frontend-smoke.js
node json-viewer.js
node transfer-controls.js
```

The values generated in `.env` are for local development only. Stop the stack and remove all local volumes with:

```sh
docker compose down -v
```
