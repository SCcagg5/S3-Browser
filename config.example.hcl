server {
  listen            = ":8080"
  job_history_limit = 10
  access_mode       = "inherit_credentials"
  log_mode          = "anonymous"

  # "default" or "portal" (a test interface: the shell of the portal and the tables of ClickHouse Dash).
  frontend = "default"

  # This is a soft Go heap target, not a container memory reservation.
  memory_limit_bytes = 67108864

  # Complete user-triggered reads of objects close to 100 GB remain possible,
  # while previews and metadata readers still use exact bounded byte ranges.
  max_storage_bytes_per_request       = 274877906944
  max_storage_requests_per_request    = 4096
  max_range_cache_bytes               = 8388608
  max_concurrent_storage_requests     = 4
  max_concurrent_requests_per_storage = 2

  session_ttl_seconds = 1200
  max_stats_folders   = 1000
  max_archive_entries = 10000

  # These limits apply only to explicit complete-object operations such as
  # per-object integrity verification and selected archive extraction.
  max_background_storage_bytes    = 274877906944
  max_background_storage_requests = 100000
}

# One authentication can be reused by any number of buckets. Each bucket keeps
# its own root, permission ceiling, and navigation scan limit.
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

# A separate authentication may use another provider.
auth "gcs-service-account" {
  provider         = "gcs"
  mode             = "service_account"
  credentials_file = "/run/secrets/gcs-service-account.json"
}

bucket "gcs-backups" {
  name           = "GCS backups"
  auth           = "gcs-service-account"
  bucket         = "company-backups"
  permissions    = ["read", "write"]
  max_scan_pages = 1
}

# The access of humans (docs/ACCESS.md). The block is mandatory.
# "open": the server checks no identity and no permission. Use it only on a
# closed network. "authzen": an access gateway gives a signed identity token,
# and an AuthZEN PDP decides each action on each bucket and folder.
access {
  mode = "authzen"

  identity {
    header           = "X-Identity-Token"
    issuer           = "https://access.example.internal"
    # The id of this server at the access gateway. It is the id of the service
    # resource of the grants, for example "objects.read on service:files".
    audience         = "files"
    public_keys_file = "/run/secrets/identity_public_keys.pem"
    max_age          = "5m"
  }

  pdp {
    url             = "http://pdp.example.internal:4182"
    token_file      = "/run/secrets/pdp_token"
    timeout         = "500ms"
    cache_ttl       = "30s"
    max_evaluations = 64
  }
}
