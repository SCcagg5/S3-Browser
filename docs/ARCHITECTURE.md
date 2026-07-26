# Architecture

## Process model

The project builds one statically linked Go executable. The frontend is embedded into that executable. No helper process, shell command, CGO library, database server, or remote asset host is required at runtime.

## Main backend responsibilities

- `config.go`: strict HCL parsing and validation;
- `authentication.go`: shared provider authentication, HTTP transport, and token state;
- `storage.go`: provider-neutral operations, permission discovery, budgets, and concurrency gates;
- `s3.go` and `gcs.go`: provider protocol implementations;
- `app.go`: HTTP routing and API handlers;
- `runtime_policy.go`: resource accounting and execution limits;
- `object_range_source.go`: exact remote ranges and bounded cache behavior;
- document-specific readers: spreadsheet, SQLite, JSON, Parquet, Office, media, image, and archive metadata;
- `jobs.go` and `uploads.go`: explicit long-running operations and resumable transfers;
- `state_files.go`: quarantine of persistent records that reference removed buckets.

## Authentication and buckets

`auth` objects are initialized once. Buckets that reference the same authentication share:

- the endpoint URL;
- the provider HTTP transport and connection pool;
- access credentials;
- the renewable GCS token source where applicable.

Every bucket creates its own storage instance with:

- bucket name;
- exposed root prefix;
- independent permission ceiling;
- independent learned capability state;
- independent request concurrency gate;
- independent navigation scan-page limit.

Secrets are therefore not duplicated into each bucket configuration.

## HTTP routing and reverse-proxy prefixes

The backend router always serves routes from `/`. It does not know or accept the public reverse-proxy prefix.

The frontend contains relative asset references and resolves runtime URLs from `document.baseURI`. To expose the application at `/s3-browser/`, the reverse proxy removes `/s3-browser/` before forwarding requests to the backend. The public URL must retain a trailing slash so relative browser URLs remain inside that prefix.

The object gateway is the exact `/s3` endpoint with an opaque `key` query parameter. Object keys are never interpreted as HTTP path segments.

## Navigation listing and global sorting

The backend requests provider listing pages with a maximum of 1,000 entries and combines at most the configured `max_scan_pages` for the selected bucket. A value of zero removes the page-count limit.

The response distinguishes two cases:

- `scanComplete=true`: the provider reported the actual end of the folder; global sorting is safe;
- `scanComplete=false`: a continuation token remains because the configured scan limit was reached; the frontend must retain provider-order pagination.

When complete, the frontend can sort the full batch by Name, Size, or Last modified and paginate locally without issuing another provider request. Header icon placeholders retain identical column geometry whether sorting is active, inactive, or unavailable.

## Resource budgets

Every API request can carry a resource budget containing:

- provider request count;
- provider bytes read;
- start time and elapsed time.

Storage requests also pass through:

- a global concurrency gate;
- a per-bucket concurrency gate;
- request-context cancellation.

Readers must use exact bounded ranges. A provider that ignores a required range is rejected unless a specific bounded reader explicitly permits a controlled fallback.

## State model

Ephemeral mode keeps jobs, capability observations, upload state, and preview sessions in memory or bounded temporary storage. State disappears on process restart.

Persistent mode stores only application state in `data_dir`. It does not create hidden control objects in connected buckets. On startup, a state file referencing a removed bucket is moved to an `orphaned` directory. It cannot repeatedly fail or restart the application.

## Insights execution

Insights use a 100 ms synchronous fast path:

1. a recent completed result may be reused immediately;
2. otherwise an existing active job is reused or a new job is created;
3. the request waits for up to 100 ms;
4. a completed result is returned directly;
5. longer work continues as a background job.

The frontend creates the bottom-right progress notification only for the background-job case.

## Frontend structure

Common components provide:

- capability-aware actions;
- shared transfer controls;
- tabular grids;
- structured metadata previews;
- archive inventory;
- PDF.js canvas rendering;
- safe image, media, text, JSON, SQLite, Office, and code previews.

Tabular viewers use full-width scroll containers and do not reserve an unused permanent scrollbar gutter.
