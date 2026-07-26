server {
  listen     = ":8080"
  state_mode = "ephemeral"
  log_mode   = "anonymous"

  max_storage_bytes_per_request        = 2147483648
  max_storage_requests_per_request     = 4096
  max_range_cache_bytes                = 33554432
  max_concurrent_storage_requests      = 8
  max_concurrent_requests_per_storage  = 4
  session_ttl_seconds                  = 1200
  max_stats_folders                    = 10000
  max_archive_entries                  = 100000
}

# One authentication can be reused by any number of buckets. Credentials may
# be written directly in this HCL file or read from mounted files.
# Each bucket also controls how many 1,000-entry provider listing pages may
# be combined in one navigation batch. Use 0 for no page-count limit.
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

# A separate authentication can use another provider.
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
