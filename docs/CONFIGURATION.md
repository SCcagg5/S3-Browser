# Configuration

The application accepts one HCL file through `-c <path>` or `-config <path>`. Runtime settings and provider credentials come from this file only. An attribute with an `_env` form reads the environment variable that the file names, and no other variable.

[configuration-reference.md](configuration-reference.md) is the generated list of every key, with its default, its range and its forms. `s3-browser print-config -c <path>` (or `s3-browser -c <path> --print-config`) checks the file, writes the value and the source of each key, and exits. The server writes the same values in its log at start. Secrets are hidden.

Supported top-level blocks:

- zero or one `server` block;
- one or more `auth "id"` blocks;
- one or more `bucket "id"` blocks;
- exactly one `access` block (since 2.0.0). It is mandatory.

Unknown blocks, attributes, nested blocks, and wrong value types are rejected. The HCL file is limited to 4 MiB. Individual secret files are limited to 1 MiB; a GCS service-account file is bounded separately by the provider parser.

## Server block

```hcl
server {
  listen            = ":8080"
  job_history_limit = 10
  access_mode       = "inherit_credentials"
  log_mode          = "anonymous"
  frontend          = "default"

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
| `frontend` | `default` | The embedded browser interface: `default` or `portal`. See [Frontend selection](#frontend-selection). |
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

### Frontend selection

The binary contains two browser interfaces. `frontend` selects one of them at start. The two interfaces use the same routes, the same API and the same security headers.

- `default`: the standard interface (`src/public/`).
- `portal`: a test interface (`src/frontends/portal/`). It has the header of ClickHouse Dash, the bucket selector of the default interface, the parts of the portal and the dense tables of ClickHouse Dash. Its theme selector has System, Dark and Light. The browser keeps the choice.

The value must be one of these two names, as written. The server does not change the case and does not remove spaces. A different value or a value that is not a string stops the server at start. The error gives the line, the key, the permitted values and the value. The start log line gives the frontend that applies (`frontend=default`).

```hcl
server {
  frontend = "portal"
}
```

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

A secret (`secret_access_key`, `session_token`) accepts only its `_env` form (the name of an environment variable) or its `_file` form. A secret in clear text in the file stops the start. `access_key_id` is an identifier, not a secret: it also accepts the value in the file. Give one form only. File paths relative to the HCL file are resolved from the HCL directory. The value of a file applies without its last line end; a secret with a space or a control character stops the start.

Since 2.0.0, the server never changes a value to make it fit. It does not remove spaces, does not change the case (`provider = "S3"` is an error), does not remove the `/` at the end of `endpoint`, and does not add or remove a `/` in `root_prefix` (`root_prefix` is `""` or a prefix such as `"published/"`). The error gives the key, the expected form and the value.

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

## Access block

```hcl
# No access check: the behavior of 1.0.13. Use it only on a closed network.
access {
  mode = "open"
}
```

```hcl
# An access gateway gives an identity token, and an AuthZEN PDP decides each action.
access {
  mode = "authzen"
  identity {
    issuer           = "portal.home"
    audience         = "infra-s3"
    public_keys_file = "/run/secrets/s3_browser_identity_keys"
  }
  pdp {
    url        = "http://portal-pdp.edge.svc.cluster.local:4182"
    token_file = "/run/secrets/s3_browser_pdp_token"
  }
}
```

A file without the `access` block stops the start. [ACCESS.md](ACCESS.md) gives the keys, the resources, the actions and the rules. The `access` block is not related to `server.access_mode`: `force_read_only` still refuses each write, also when the PDP permits it.

## Version capability probe

A single bounded version-list request is made for every bucket when the application starts. Any error marks version browsing unavailable for that bucket. This includes providers such as Garage that return HTTP 501 for the version-list API. The result is process-local and is exposed only as a boolean capability; the HCL file does not need a versioning flag.

## Public path

There is no public-path attribute. The frontend resolves URLs relative to `document.baseURI`. A reverse proxy can mount the application under any path by stripping the public prefix before forwarding requests to the backend.
