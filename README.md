# S3 Browser

A lightweight, self-hosted web UI to browse and manage an **S3-compatible** bucket via a small Go HTTP proxy.

The server signs S3 requests using AWS Signature V4 and forwards them to your S3 endpoint, while serving a minimal frontend UI.

---

## Features

* Browse bucket content with folders/prefixes
* Preview files in the browser (depending on frontend capabilities)
* Download objects (supports `Range`)
* Upload objects (`PUT`)
* Rename / move files and folders (implemented as copy + delete)
* Delete files and folders (prefix delete)
* JSON endpoints for listing and stats
* Health endpoint (`/healthz`)
* Works with any **S3-compatible** endpoint

---

## Requirements

* An S3-compatible endpoint
* Access key / secret key with permissions on the target bucket
* Docker (recommended) or a Go toolchain (optional)

---

## Configuration

The server is configured via environment variables:

| Variable               | Required | Description                   | Example          |
| ---------------------- | -------: | ----------------------------- | ---------------- |
| `S3_ENDPOINT`          |        ✅ | Base URL of the S3 endpoint   | `http://s3:9000` |
| `S3_REGION`            |        ✅ | Region used for SigV4 signing | `us-east-1`      |
| `S3_ACCESS_KEY_ID`     |        ✅ | Access key id                 | `AKIA...`        |
| `S3_SECRET_ACCESS_KEY` |        ✅ | Secret access key             | `...`            |
| `S3_BUCKET`            |        ✅ | Bucket name                   | `my-bucket`      |
| `PORT`                 |        ❌ | Listen port (default: `8080`) | `8080`           |

---

## Run with Docker

### Build & run

```bash
docker build -t s3-browser .
docker run --rm -p 8080:8080 \
  -e S3_ENDPOINT="http://YOUR_S3_ENDPOINT:9000" \
  -e S3_REGION="us-east-1" \
  -e S3_ACCESS_KEY_ID="YOUR_KEY_ID" \
  -e S3_SECRET_ACCESS_KEY="YOUR_KEY_SECRET" \
  -e S3_BUCKET="my-bucket" \
  s3-browser
```

Open: `http://localhost:8080/`

---

## API

The frontend uses these endpoints:

* `GET /api/list?prefix=...&delimiter=/&max=...&continuationToken=...`
* `GET /api/stats?prefix=...`
* `POST /api/rename`
* `POST /api/delete-prefix`

S3 proxy endpoints:

* `GET|HEAD /s3` → list bucket (raw S3 list)
* `GET|HEAD /s3/<key>` → get object
* `PUT /s3/<key>` → upload object
* `DELETE /s3/<key>` → delete object

Healthcheck:

* `GET /healthz`

---

## Releases

Binary releases are published in GitHub Releases.

Each release provides binaries for:

* Linux (amd64, arm64)
* macOS (amd64, arm64)
* Windows (amd64, arm64)

---

## Development

Project layout:

```
src/
  main.go
  go.mod
  public/       # frontend (static assets)
test/
  docker-compose.yaml
  ...
```

Run locally (requires Go):

```bash
cd src
go run .
```

---

## Tests (local stack)

A local testing stack is available under `test/` and uses **Garage** as an S3-compatible backend.

From the repository root:

```bash
cd test
docker compose up --build
```

Then open: `http://localhost:8080/`

---

## Security notes

* The server signs requests using your credentials: keep them secret.
* If exposed publicly, run behind a reverse proxy with authentication.
* CORS is enabled (`Access-Control-Allow-Origin: *`) for simplicity.
