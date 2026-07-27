server {
  listen                               = ":8080"
  job_history_limit                    = 10
  memory_limit_bytes                   = 67108864
  max_range_cache_bytes                = 8388608
  max_concurrent_storage_requests      = 4
  max_concurrent_requests_per_storage  = 2
}

auth "garage" {
  provider          = "s3"
  mode              = "access_key"
  endpoint          = "http://garage:3900"
  region            = "garage"
  access_key_id     = "GK0123456789abcdef01234567"
  secret_access_key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}

bucket "garage-main" {
  name           = "Garage - primary"
  auth           = "garage"
  bucket         = "default"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}

bucket "garage-archive" {
  name           = "Garage - archive"
  auth           = "garage"
  bucket         = "archive"
  permissions    = ["read", "write", "delete"]
  max_scan_pages = 15
}
