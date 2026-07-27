# Configuration

The application accepts one HCL file through `-c <path>` or `-config <path>`. Runtime settings and provider credentials are not read from environment variables.

Supported top-level blocks:

- zero or one `server` block;
- one or more `auth "id"` blocks;
- one or more `bucket "id"` blocks.

Unknown blocks, attributes, nested blocks, and wrong value types are rejected. The HCL file is limited to 4 MiB. Individual secret files are limited to 1 MiB; a GCS service-account file is bounded separately by the provider parser.

## Server block

```hcl
server {
  listen            = ":8080"
  job_history_limit = 10
  access_mode       = "inherit_credentials"
  log_mode          = "anonymous"

  memory_limit_bytes = 67108864

  max_storage_bytes_per_request       = 274877906944
  max_storage_requests_per_request    = 4096
  max_range_cache_bytes               = 8388608
  max_concurrent_storage_requests     = 4
  max_concurrent_requests_per_storage = 2

  session_ttl_seconds = 1200
  max_stats_folders   = 1000
  max_archive_entries = 10000

  max_background_storage_bytes    = 274877906944
  max_background_storage_requests = 100000
}
```

| Attribute | Default | Description |
|---|---:|---|
| `listen` | `:8080` | Numeric `host:port` listen address. URL syntax is rejected. |
| `job_history_limit` | `10` | Number of terminal job results retained in process memory. Valid range: 1-20. |
| `access_mode` | `inherit_credentials` | `inherit_credentials` or `force_read_only`. |
| `log_mode` | `anonymous` | `anonymous` avoids object keys in request logs; `detailed` is for controlled diagnostics. |
| `allow_full_object_fallback` | `false` | Allows explicitly implemented parser fallbacks that require a complete object. It never changes strict Range validation into an implicit oversized response. |
| `memory_limit_bytes` | `0` | Optional Go soft memory limit. `0` leaves the Go runtime default unchanged. |
| `max_storage_bytes_per_request` | 256 GiB | Provider bytes allowed for one interactive HTTP request. |
| `max_storage_requests_per_request` | `4096` | Provider calls allowed for one interactive HTTP request. |
| `max_range_cache_bytes` | 8 MiB | Maximum in-memory cache used by a range reader session. |
| `max_concurrent_storage_requests` | `4` | Global provider-request concurrency. |
| `max_concurrent_requests_per_storage` | `2` | Provider-request concurrency for one bucket. |
| `session_ttl_seconds` | `1200` | In-memory preview/session TTL. |
| `max_stats_folders` | `1000` | Maximum exact folder aggregates retained by one Insights result. |
| `max_archive_entries` | `10000` | Maximum deterministic central-directory entries and selected archive members. |
| `max_background_storage_bytes` | 256 GiB | Provider-byte budget for an explicit full-object job. |
| `max_background_storage_requests` | `100000` | Provider-call budget for an explicit background job. |

The server never creates a data directory. All sessions and jobs are memory-only. At most four jobs may be active or queued at once.

## S3 authentication

```hcl
auth "primary-s3" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "https://s3.example.internal"
  region                 = "eu-west-1"
  access_key_id_file     = "/run/secrets/s3-access-key-id"
  secret_access_key_file = "/run/secrets/s3-secret-access-key"
  session_token_file     = "/run/secrets/s3-session-token"
  insecure_skip_verify   = false
}
```

S3 modes:

- `access_key`: requires `access_key_id` or `access_key_id_file` and `secret_access_key` or `secret_access_key_file`; `session_token` is optional.
- `anonymous`: rejects access-key fields.

Every secret can be supplied directly or through its `_file` form, never both. File paths relative to the HCL file are resolved from the HCL directory.

The endpoint must use HTTP or HTTPS and may not contain credentials, a query string, or a fragment. Redirects and process environment proxies are disabled.

## GCS authentication

```hcl
auth "gcs-service-account" {
  provider         = "gcs"
  mode             = "service_account"
  credentials_file = "/run/secrets/gcs-service-account.json"
}
```

GCS modes:

- `service_account`: requires `credentials_file`;
- `anonymous`: rejects `credentials_file`.

If omitted, the GCS endpoint defaults to `https://storage.googleapis.com`.

## Bucket block

```hcl
bucket "archive" {
  name           = "Archive"
  auth           = "primary-s3"
  bucket         = "archive"
  root_prefix    = "published/"
  permissions    = ["read"]
  max_scan_pages = 15
}
```

| Attribute | Default | Description |
|---|---:|---|
| `name` | block id | Frontend display name. |
| `auth` | required | Referenced authentication id. |
| `bucket` | required | Provider bucket name. |
| `root_prefix` | empty | Virtual root exposed by the application. |
| `permissions` | omitted | Optional application ceiling containing `read`, `write`, and/or `delete`. |
| `max_scan_pages` | `1` | Maximum 1,000-entry provider listing pages combined in navigation. `0` means no page-count limit. |

`read` permits list, preview, details, inspection, version listing, and download. `write` permits upload and destination-side object creation. `delete` permits deletion and the source side of move/rename. Provider policy and retention rules still apply.

## Version capability probe

A single bounded version-list request is made for every bucket when the application starts. Any error marks version browsing unavailable for that bucket. This includes providers such as Garage that return HTTP 501 for the version-list API. The result is process-local and is exposed only as a boolean capability; the HCL file does not need a versioning flag.

## Public path

There is no public-path attribute. The frontend resolves URLs relative to `document.baseURI`. A reverse proxy can mount the application under any path by stripping the public prefix before forwarding requests to the backend.
