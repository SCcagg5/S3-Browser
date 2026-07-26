# Configuration

The application accepts one HCL file through `-config <path>` or `-c <path>`. It does not read runtime settings or credentials from environment variables.

The supported top-level blocks are:

- one optional `server` block;
- one or more `auth "id"` blocks;
- one or more `bucket "id"` blocks.

Unknown blocks and unknown attributes are rejected. Nested blocks are not accepted. The configuration file is limited to 4 MiB.

## `server`

```hcl
server {
  listen     = "127.0.0.1:8080"
  state_mode = "ephemeral"
  log_mode   = "anonymous"
}
```

| Attribute | Default | Description |
|---|---:|---|
| `listen` | `:8080` | Numeric `host:port` address used by the HTTP server. URL syntax is rejected. |
| `access_mode` | `inherit_credentials` | `inherit_credentials` or `force_read_only`. The latter blocks every mutation regardless of provider rights. |
| `state_mode` | `ephemeral` | `ephemeral` or `persistent`. |
| `data_dir` | none | Required only for persistent state. Relative paths are resolved from the configuration file directory. |
| `job_history_limit` | `100` | Maximum retained job records in persistent mode. |
| `log_mode` | `anonymous` | `anonymous` avoids object keys in request logs; `detailed` is intended for controlled diagnostics. |
| `browser_persistence` | `false` | Allows selected browser state to use local storage. Requires persistent state mode. |
| `allow_full_object_fallback` | `false` | Allows only explicitly bounded reader fallbacks. It never permits an unbounded PDF gateway request. |
| `memory_limit_bytes` | Go default | Optional Go memory limit. Minimum 32 MiB. |
| `max_storage_bytes_per_request` | 2 GiB | Maximum provider bytes charged to one HTTP request budget. |
| `max_storage_requests_per_request` | `4096` | Maximum provider requests charged to one HTTP request budget. |
| `max_temp_bytes_per_session` | 512 MiB | Maximum temporary bytes for one preview or processing session. |
| `max_range_cache_bytes` | 32 MiB | Maximum in-memory range cache. |
| `max_concurrent_storage_requests` | `8` | Global provider request concurrency. |
| `max_concurrent_requests_per_storage` | `4` | Concurrency for one configured bucket. |
| `session_ttl_seconds` | `1200` | Idle lifetime for temporary preview sessions. |
| `max_stats_folders` | `10000` | Maximum folder aggregates retained by a statistics job. |
| `max_archive_entries` | `100000` | Maximum deterministic archive entries returned by archive inspection. |

The backend has no public-path setting. It always serves routes from `/`. A reverse proxy may expose the application at a prefix only when it removes that prefix before forwarding requests. The frontend resolves all URLs relative to `document.baseURI`.

## `auth`

An authentication block owns provider credentials, endpoint configuration, one HTTP connection pool, and renewable token state. Any number of buckets can reference it.

Identifiers must match:

```text
[A-Za-z0-9][A-Za-z0-9._-]*
```

### S3-compatible storage

```hcl
auth "primary-s3" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "https://s3.example.internal"
  region                 = "eu-west-1"
  access_key_id_file     = "/run/secrets/s3-access-key-id"
  secret_access_key_file = "/run/secrets/s3-secret-access-key"
  session_token_file     = "/run/secrets/s3-session-token"
}
```

Supported modes:

- `access_key`: requires an access key ID and secret access key;
- `anonymous`: accepts no access credentials.

Every secret can be provided directly or through a file:

```hcl
access_key_id      = "..."
access_key_id_file = "/run/secrets/..."
```

Only one form may be used for a given secret. Secret files are read once during startup, are limited to 1 MiB, and are trimmed before use.

### Google Cloud Storage

```hcl
auth "gcs-service-account" {
  provider         = "gcs"
  mode             = "service_account"
  credentials_file = "/run/secrets/gcs-service-account.json"
}
```

Supported modes:

- `service_account`: requires `credentials_file`;
- `anonymous`: performs unsigned public requests.

The default endpoint is `https://storage.googleapis.com`. A custom `endpoint` can be supplied for a compatible test service.

### TLS testing option

`insecure_skip_verify = true` disables certificate verification for the provider connection. Use it only for isolated local test services. It is never enabled by default.

## `bucket`

```hcl
bucket "documents" {
  name           = "Documents"
  auth           = "primary-s3"
  bucket         = "company-documents"
  permissions    = ["read", "write", "delete"]
  root_prefix    = "tenant-a/"
  max_scan_pages = 15
}
```

| Attribute | Required | Default | Description |
|---|---:|---:|---|
| `name` | no | block identifier | Display name. |
| `auth` | yes | none | Identifier of an `auth` block. |
| `bucket` | yes | none | Provider bucket name. |
| `permissions` | no | provider inheritance | Optional application ceiling containing `read`, `write`, and/or `delete`. Omitting it leaves capabilities tentatively available until the provider denies an operation. |
| `root_prefix` | no | empty | Prefix exposed as the root of this configured bucket. |
| `max_scan_pages` | no | `1` | Maximum provider listing pages combined into one navigation batch. `0` means unlimited. Each provider request asks for up to 1,000 entries. |

A bucket never inherits another bucket's permission list or listing scan limit even when both use the same authentication.

### Listing and sorting behavior

`max_scan_pages` controls backend work, not a frontend setting. Its value is never returned to or displayed by the browser.

Examples for a provider that returns 1,000 entries per page:

```text
max_scan_pages = 1   -> at most 1,000 entries in one batch
max_scan_pages = 15  -> at most 15,000 entries in one batch
max_scan_pages = 0   -> continue until the provider reports the end
```

Global sorting by Name, Size, or Last modified is enabled only when the backend reaches the actual end of the current folder listing. If the scan limit is reached first, the frontend keeps provider-order navigation and continues with the returned continuation token.

Folders participate in global sorting with numeric Size `0` and Last modified `0`.

## Shared authentication example

```hcl
auth "shared" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "https://objects.example.com"
  region                 = "eu-central-1"
  access_key_id_file     = "/run/secrets/object-key"
  secret_access_key_file = "/run/secrets/object-secret"
}

bucket "team-write" {
  auth           = "shared"
  bucket         = "team-documents"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

bucket "audit-read-only" {
  auth           = "shared"
  bucket         = "audit-archive"
  permissions    = ["read"]
  max_scan_pages = 0
}
```

## Validation behavior

Startup fails before serving traffic when:

- the HCL syntax is invalid;
- an attribute has the wrong type;
- an identifier is duplicated or malformed;
- a bucket references an unknown authentication;
- required provider fields are missing;
- two secret sources are supplied for the same value;
- a persistent state configuration lacks `data_dir`;
- a listen address is invalid;
- a numeric resource limit is outside its accepted range.
