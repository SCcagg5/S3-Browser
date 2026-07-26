# Object Storage Browser

A self-contained Go application for browsing, previewing, downloading, uploading, copying, moving, renaming, and deleting objects in S3-compatible storage and Google Cloud Storage.

The application is designed for very large objects and constrained hosts:

- one statically linked Go binary;
- HCL configuration only;
- no runtime dependency on environment variables;
- no external commands or CGO;
- no third-party asset requests at runtime;
- exact byte-range reads for large-file previews;
- bounded memory, temporary storage, request count, and transferred-byte budgets;
- read, write, and delete actions limited independently for every configured bucket;
- reusable authentication definitions shared by multiple buckets;
- relative frontend URLs that work behind a path-stripping reverse proxy.

## Quick start

1. Copy the example configuration:

   ```sh
   cp config.example.hcl config.hcl
   ```

2. Edit `config.hcl` and define at least one `auth` block and one `bucket` block.

3. Build and start the application:

   ```sh
   cd src
   CGO_ENABLED=0 go build -trimpath -o s3-browser .
   ./s3-browser -config ../config.hcl
   ```

The example listens on port 8080.

## Configuration model

Configuration is loaded only from the HCL file passed with `-config` or `-c`. The process does not read application settings or provider credentials from environment variables.

```hcl
server {
  listen     = ":8080"
  state_mode = "ephemeral"
}

auth "shared-s3" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "https://s3.example.internal"
  region                 = "eu-west-1"
  access_key_id_file     = "/run/secrets/s3-access-key-id"
  secret_access_key_file = "/run/secrets/s3-secret-access-key"
}

bucket "documents" {
  name           = "Documents"
  auth           = "shared-s3"
  bucket         = "documents"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

bucket "archive" {
  name           = "Archive"
  auth           = "shared-s3"
  bucket         = "archive"
  permissions    = ["read"]
  max_scan_pages = 0
}
```

The two buckets share one credential set, one HTTP connection pool, and one renewable provider token state. Their application permission ceilings and listing scan limits remain independent.

Omitting `permissions` does not force read-only access. It lets the application attempt every supported operation and learn explicit provider denials during the current process lifetime. Defining `permissions` creates an application-side ceiling in addition to the provider policy.

`max_scan_pages` controls how many provider listing pages may be combined for one navigation batch. Provider pages are requested with a limit of 1,000 entries. `1` scans at most one page, `15` scans at most fifteen pages, and `0` removes the page-count limit. Global navigation sorting is enabled only when the backend reaches the actual end of the listing within that limit. The configured value is never exposed in the frontend.

See [Configuration](docs/CONFIGURATION.md) for every supported field.

## Reverse proxy path prefixes

The backend always serves paths from `/`. The frontend uses only relative assets and resolves API, preview, object, and download URLs against `document.baseURI`.

To publish the application at:

```text
https://example.com/s3-browser/
```

the reverse proxy must strip `/s3-browser/` before forwarding the request:

```nginx
location /s3-browser/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

For example:

```text
/s3-browser/api/list  ->  /api/list
/s3-browser/s3       ->  /s3
```

No application-prefix setting is required or accepted in HCL. The public URL should keep its trailing slash so browser-relative URLs resolve inside the proxy prefix.

## Runtime state

`state_mode = "ephemeral"` is the default and recommended mode. It creates no persistent job or upload database. Temporary preview state is bounded and expires automatically.

`state_mode = "persistent"` requires `data_dir` and enables resumable application state across restarts. It does not create hidden objects, tags, or prefixes in the connected storage. State files that refer to a bucket removed from the HCL configuration are moved to an `orphaned` directory and do not block startup.

## Permissions

Each bucket can independently permit any subset of:

- `read`: list, inspect, preview, search, and download;
- `write`: upload, create folder markers, copy, and overwrite;
- `delete`: delete objects and the source side of move or rename operations.

Move and rename require read, write, and delete. Copy requires read and write. The backend validates every operation even when the frontend has hidden or disabled an action.

## Large-object behavior

Large-object readers use explicit bounded ranges. The application does not silently replace a failed range preview with a complete-object download. Operations that require a complete deterministic scan are started only after an explicit user action and remain subject to resource budgets.

PDF preview uses a local PDF.js canvas renderer with a custom `PDFDataRangeTransport`. The application expects these files before compilation:

```text
src/public/assets/vendor/pdfjs/4.10.38/pdf.min.mjs
src/public/assets/vendor/pdfjs/4.10.38/pdf.worker.min.mjs
```

They are intentionally not downloaded by the application at runtime.

## Documentation

- [Configuration](docs/CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Preview and metadata behavior](docs/PREVIEWS.md)
- [Security model](docs/SECURITY.md)
- [Development and validation](docs/DEVELOPMENT.md)

## License

Review and add the license appropriate for your deployment before redistribution. Third-party assets retain their own license notices in their vendor directories.
