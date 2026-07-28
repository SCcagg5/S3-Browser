# Object Storage Browser

![frontpage](/.github/assets/front.png)

Object Storage Browser is a self-contained Go application for browsing and operating on S3-compatible storage and Google Cloud Storage. It is designed for hosts with a small memory budget and for objects that can be hundreds of gigabytes.

Core properties:

- one statically linked Go binary;
- HCL configuration only;
- no application configuration or provider credentials from environment variables;
- no local database, cache directory, temporary file, or persisted job state;
- no hidden control objects, indexes, or checkpoints in connected buckets;
- compatible with a read-only root filesystem;
- shared authentication definitions that can serve multiple independently configured buckets;
- exact byte-range readers for large-object previews and inspection;
- bounded provider requests, transferred bytes, concurrency, cache size, and in-memory job history;
- frontend URLs resolved relative to `document.baseURI` for deployment behind a path-stripping reverse proxy;
- no runtime CDN or third-party asset requests.

## Quick start

```sh
cp config.example.hcl config.hcl
cd src
CGO_ENABLED=0 go build -trimpath -o s3-browser .
./s3-browser -c ../config.hcl
```

The configuration must contain at least one `auth` block and one `bucket` block.

## Shared authentication and bucket-specific policy

```hcl
auth "primary-s3" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "https://s3.example.internal"
  region                 = "eu-west-1"
  access_key_id_file     = "/run/secrets/s3-access-key-id"
  secret_access_key_file = "/run/secrets/s3-secret-access-key"
}

bucket "documents" {
  name           = "Documents"
  auth           = "primary-s3"
  bucket         = "documents"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

bucket "archive" {
  name           = "Archive"
  auth           = "primary-s3"
  bucket         = "archive"
  permissions    = ["read"]
  root_prefix    = "published/"
  max_scan_pages = 0
}
```

Both buckets reuse one credential set and HTTP connection pool. Their root prefixes, permission ceilings, navigation scan limits, and learned provider capabilities remain independent.

Omitting `permissions` lets the application attempt every supported file operation. Explicit provider denials are learned only in memory for the current process. Defining `permissions` creates an application-side ceiling in addition to the provider policy.

`max_scan_pages` controls how many 1,000-entry provider listing pages may be combined for one navigation batch. `0` removes the page-count limit. Global column sorting is enabled only when the actual end of the listing has been reached.

See [Configuration](docs/CONFIGURATION.md) for all fields.

## Stateless runtime

The server never writes application state to the local filesystem. Background jobs, preview sessions, permission observations, and active upload sessions exist only in bounded process memory and disappear on restart.

Resumable uploads use an encrypted, authenticated token returned to the client. The token contains the provider-side multipart or resumable-session coordinates. A fresh server process using the same configured credentials can reconstruct the provider upload state from that token; the server does not store the token or a checkpoint file.

Completed and canceled uploads are removed from server memory. The process tracks at most four active upload sessions. Background jobs are limited to four active or queued operations and a small configurable in-memory terminal history.

## Version support

At startup, the server performs one bounded version-listing probe per configured bucket. A provider that returns `501 Not Implemented`, denies the operation, or otherwise fails the probe is marked as not supporting version browsing. Version controls and version-count requests are then omitted from the frontend for that bucket.

When supported:

- the navigation displays the exact number of non-delete-marker versions for visible files;
- Preview and Details expose a version selector;
- the version browser supports paginated listing, exact-version download, restore, and permanent exact-version deletion according to bucket permissions;
- comparison is available only between two versions of the same object;
- comparison runs entirely in the browser with two bounded range buffers and stops at the first differing byte.

There is no generic cross-object comparison endpoint on the backend.

## Large-object tools

- **Verify integrity** is an explicit per-object full scan. Hashes are calculated while streaming; object content is not accumulated in memory.
- **Inspect** performs a bounded technical inspection using object metadata and small exact header/trailer ranges.
- Both tools are available only in the **Advanced** tab of Details. Opening Details or the Advanced tab does not start either operation; computation begins only after the corresponding button is clicked, and results remain inside Details.
- **Archive entry access** uses the ZIP central directory and reads only selected regular, unencrypted members. Members can be opened, downloaded, verified, or streamed directly to an explicit destination object.
- **Insights** returns inline when complete within 100 ms; otherwise it continues as a memory-only background job with pause, resume, and cancel controls. The backend also produces the semantic treemap tree, applies the global one-percent grouping rule, and contracts redundant single-child folder chains before the response reaches the browser.

The project intentionally has no global duplicate finder and no global checksum-manifest generator. Exact global results would require retaining or emitting large scan state, which conflicts with the stateless low-memory runtime contract.

## Reverse proxy path prefixes

The backend always serves paths from `/`. The frontend uses relative URLs. To publish it at `/s3-browser/`, strip that prefix before forwarding:

```nginx
location /s3-browser/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Keep the public trailing slash so browser-relative URLs resolve inside the proxy prefix. No public-path setting is required or accepted in HCL.

## PDF.js

The PDF preview is a local canvas viewer using a custom `PDFDataRangeTransport`; it does not use an iframe, embed, object element, or native-browser fallback.

The release build expects:

```text
src/public/assets/vendor/pdfjs/4.10.38/pdf.min.mjs
src/public/assets/vendor/pdfjs/4.10.38/pdf.worker.min.mjs
```

The application never downloads these files at runtime.

## Documentation

- [Configuration](docs/CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Preview and metadata behavior](docs/PREVIEWS.md)
- [Security model](docs/SECURITY.md)
- [Development and validation](docs/DEVELOPMENT.md)

## License

Add the project license required for your deployment before redistribution. Third-party assets retain their own notices under `src/public/assets/vendor/`.
