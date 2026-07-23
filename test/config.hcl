server {
  listen   = ":8080"
  data_dir = "/data"
}

# These credentials are deterministic, local-test-only Garage credentials.
# Production S3 credentials belong directly in the deployment HCL file.
storage "garage-main" {
  name              = "Garage — primary"
  provider          = "s3"
  endpoint          = "http://garage:3900"
  region            = "garage"
  bucket            = "default"
  auth              = "access_key"
  access_key_id     = "GK0123456789abcdef01234567"
  secret_access_key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  permissions       = ["read", "write", "delete"]
}

storage "garage-archive" {
  name              = "Garage — archive"
  provider          = "s3"
  endpoint          = "http://garage:3900"
  region            = "garage"
  bucket            = "archive"
  auth              = "access_key"
  access_key_id     = "GK0123456789abcdef01234567"
  secret_access_key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  permissions       = ["read", "write", "delete"]
}
