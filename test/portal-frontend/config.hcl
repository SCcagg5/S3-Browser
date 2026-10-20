# The test stack of the "portal" interface: three S3 providers and server.frontend = "portal".
# run.sh starts it with Docker Compose. The three auth blocks use the same key: the entrypoint of each provider reads
# the first access_key_id and the first secret_access_key_file of this file.
server {
  frontend                             = "portal"
  listen                               = ":8080"
  job_history_limit                    = 10
  memory_limit_bytes                   = 67108864
  max_range_cache_bytes                = 8388608
  max_concurrent_storage_requests      = 4
  max_concurrent_requests_per_storage  = 2
}

auth "seaweedfs" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "http://seaweedfs:8333"
  region                 = "us-east-1"
  access_key_id          = "GK0123456789abcdef01234567"
  # A secret accepts only _env and _file. The test compose and scratch-runtime.sh mount test/secrets here.
  secret_access_key_file = "/config/secrets/s3_secret_access_key"
}

bucket "seaweedfs-main" {
  name           = "SeaweedFS - primary"
  auth           = "seaweedfs"
  bucket         = "default"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

bucket "seaweedfs-archive" {
  name           = "SeaweedFS - archive"
  auth           = "seaweedfs"
  bucket         = "archive"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

# The bucket "locked" has Object Lock (test/seaweedfs/scripts/entrypoint.sh). The tests of Object Lock use it.
bucket "seaweedfs-locked" {
  name           = "SeaweedFS - locked"
  auth           = "seaweedfs"
  bucket         = "locked"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

# encryption = "sse-s3": each write of S3-Browser asks for SSE-S3. SeaweedFS encrypts with its test KEK
# (test/seaweedfs/scripts/entrypoint.sh). The tests of the encryption use it.
bucket "seaweedfs-encrypted" {
  name           = "SeaweedFS - encrypted"
  auth           = "seaweedfs"
  bucket         = "encrypted"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
  encryption     = "sse-s3"
}

auth "minio" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "http://minio:9000"
  region                 = "us-east-1"
  access_key_id          = "GK0123456789abcdef01234567"
  secret_access_key_file = "/config/secrets/s3_secret_access_key"
}

bucket "minio-main" {
  name           = "MinIO - primary"
  auth           = "minio"
  bucket         = "default"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

# The bucket "locked" has Object Lock (test/minio/scripts/entrypoint.sh). The tests of Object Lock use it.
bucket "minio-locked" {
  name           = "MinIO - locked"
  auth           = "minio"
  bucket         = "locked"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

# encryption = "sse-s3": MinIO encrypts with its test KMS key (test/minio/scripts/entrypoint.sh).
bucket "minio-encrypted" {
  name           = "MinIO - encrypted"
  auth           = "minio"
  bucket         = "encrypted"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
  encryption     = "sse-s3"
}

auth "garage" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "http://garage:3900"
  # The s3_region of the Garage configuration (test/garage/scripts/entrypoint.sh).
  region                 = "garage"
  access_key_id          = "GK0123456789abcdef01234567"
  secret_access_key_file = "/config/secrets/s3_secret_access_key"
}

bucket "garage-main" {
  name           = "Garage - primary"
  auth           = "garage"
  bucket         = "default"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

# The bucket "default" of Garage again, with encryption = "sse-s3". Garage v2.4.1 accepts the header and does not
# encrypt: the server writes a warning at start, and the details show no encryption.
bucket "garage-encrypted" {
  name           = "Garage - encrypted"
  auth           = "garage"
  bucket         = "default"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
  encryption     = "sse-s3"
}

# The test stack has no access gateway: the browser checks no identity.
access {
  mode = "open"
}
