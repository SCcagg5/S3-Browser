package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOmittedPermissionsInheritCredentialCapabilities(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, `
auth "shared" {
  provider          = "s3"
  mode              = "access_key"
  endpoint          = "http://localhost:9000"
  region            = "test"
  access_key_id     = "key"
  secret_access_key = "secret"
}

bucket "inherited" {
  auth   = "shared"
  bucket = "bucket"
}
`)
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	bucket := cfg.Buckets[0]
	if bucket.PermissionsDefined || len(bucket.Permissions) != 0 {
		t.Fatalf("omitted permissions must not create an application ceiling: %#v", bucket)
	}
	caps := initialCapabilities(bucket)
	for name, state := range map[string]capabilityState{
		permissionRead: caps.Read, permissionWrite: caps.Write, permissionDelete: caps.Delete,
	} {
		if state.State != capabilityUnknown || !state.Allowed || state.Verified {
			t.Fatalf("%s capability = %#v, want tentable unknown", name, state)
		}
	}
}

func TestLoadConfigSharesAuthenticationAcrossBuckets(t *testing.T) {
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "s3-secret.txt")
	if err := os.WriteFile(secretPath, []byte("shared-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.hcl")
	writeConfig(t, configPath, `
server {
  listen            = ":9090"
  job_history_limit = 17
}

auth "production" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "http://127.0.0.1:9000/"
  region                 = "us-east-1"
  access_key_id          = "shared-key"
  secret_access_key_file = "./s3-secret.txt"
}

bucket "documents" {
  name           = "Documents"
  auth           = "production"
  bucket         = "documents"
  permissions    = ["read", "write", "delete"]
  root_prefix    = "/tenant-a"
  max_scan_pages = 15
}

bucket "archive" {
  name        = "Archive"
  auth        = "production"
  bucket      = "archive"
  permissions = ["read"]
}
`)
	cfg, err := loadConfig(configPath)
	if err != nil {
		t.Fatalf("loadConfig() error = %v", err)
	}
	if cfg.Listen != ":9090" || cfg.JobHistoryLimit != 17 {
		t.Fatalf("server config = listen:%q history:%d", cfg.Listen, cfg.JobHistoryLimit)
	}
	if len(cfg.Authentications) != 1 || len(cfg.Buckets) != 2 {
		t.Fatalf("auth=%d buckets=%d", len(cfg.Authentications), len(cfg.Buckets))
	}
	for _, bucket := range cfg.Buckets {
		if bucket.AuthID != "production" || bucket.Provider != "s3" || bucket.Region != "us-east-1" {
			t.Fatalf("bucket did not resolve shared auth identity: %+v", bucket)
		}
	}
	auth := cfg.Authentications[0]
	if auth.AccessKeyID != "shared-key" || auth.SecretAccessKey != "shared-secret" {
		t.Fatalf("shared authentication credentials were not loaded: %+v", auth)
	}
	if cfg.Buckets[0].RootPrefix != "tenant-a/" {
		t.Fatalf("RootPrefix = %q", cfg.Buckets[0].RootPrefix)
	}
	if cfg.Buckets[0].MaxScanPages != 15 || cfg.Buckets[1].MaxScanPages != 1 {
		t.Fatalf("max scan pages = documents:%d archive:%d", cfg.Buckets[0].MaxScanPages, cfg.Buckets[1].MaxScanPages)
	}
	if got := strings.Join(cfg.Buckets[0].Permissions, ","); got != "read,write,delete" {
		t.Fatalf("documents permissions = %q", got)
	}
}

func TestLoadConfigBackgroundBudgets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, `
server {
  max_background_storage_bytes    = 274877906944
  max_background_storage_requests = 12345
}

`+minimalTestConfig("primary"))
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Runtime.MaxBackgroundStorageBytes != 274877906944 {
		t.Fatalf("MaxBackgroundStorageBytes = %d", cfg.Runtime.MaxBackgroundStorageBytes)
	}
	if cfg.Runtime.MaxBackgroundStorageRequests != 12345 {
		t.Fatalf("MaxBackgroundStorageRequests = %d", cfg.Runtime.MaxBackgroundStorageRequests)
	}
}

func TestLoadConfigRejectsInvalidBackgroundBudgets(t *testing.T) {
	for _, test := range []struct {
		name      string
		attribute string
		value     string
	}{
		{name: "background bytes too small", attribute: "max_background_storage_bytes", value: "1024"},
		{name: "background requests zero", attribute: "max_background_storage_requests", value: "0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.hcl")
			writeConfig(t, path, "server { "+test.attribute+" = "+test.value+" }\n"+minimalTestConfig("primary"))
			if _, err := loadConfig(path); err == nil || !strings.Contains(err.Error(), test.attribute) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestLoadConfigUsesLowMemoryDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, minimalTestConfig("primary"))
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.JobHistoryLimit != 10 || cfg.Runtime.MaxRangeCacheBytes != 8<<20 {
		t.Fatalf("defaults = history:%d cache:%d", cfg.JobHistoryLimit, cfg.Runtime.MaxRangeCacheBytes)
	}
	if cfg.Runtime.MaxConcurrentStorageRequests != 4 || cfg.Runtime.MaxConcurrentRequestsPerStore != 2 {
		t.Fatalf("concurrency defaults = global:%d bucket:%d", cfg.Runtime.MaxConcurrentStorageRequests, cfg.Runtime.MaxConcurrentRequestsPerStore)
	}
	if cfg.Runtime.MaxStorageBytesPerRequest < 100<<30 || cfg.Runtime.MaxBackgroundStorageBytes < 100<<30 {
		t.Fatalf("streaming byte budgets must support 100 GiB objects: request:%d background:%d", cfg.Runtime.MaxStorageBytesPerRequest, cfg.Runtime.MaxBackgroundStorageBytes)
	}
}

func TestLoadConfigSupportsGCSAuthentication(t *testing.T) {
	dir := t.TempDir()
	credentials := filepath.Join(dir, "gcs.json")
	if err := os.WriteFile(credentials, []byte(`{"type":"service_account"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.hcl")
	writeConfig(t, configPath, `
auth "gcs" {
  provider         = "gcs"
  mode             = "service_account"
  credentials_file = "./gcs.json"
}

bucket "archive" {
  auth   = "gcs"
  bucket = "archive-bucket"
}
`)
	cfg, err := loadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	bucket := cfg.Buckets[0]
	if bucket.Provider != "gcs" || bucket.AuthID != "gcs" {
		t.Fatalf("resolved GCS bucket = %+v", bucket)
	}
	auth := cfg.Authentications[0]
	if auth.Endpoint != "https://storage.googleapis.com" || auth.CredentialsFile != credentials {
		t.Fatalf("resolved GCS authentication = %+v", auth)
	}
}

func TestLoadConfigRejectsUnknownAuthenticationAttributes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, `
auth "broken" {
  provider           = "s3"
  endpoint           = "http://localhost:9000"
  region             = "test"
  unsupported_option = "value"
}

bucket "bucket" { auth = "broken" bucket = "bucket" }
`)
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), `unknown attribute "unsupported_option"`) {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigRejectsUnknownAuthentication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, minimalTestConfig("known")+`
bucket "broken" { auth = "missing" bucket = "bucket" }
`)
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), `auth "missing" is not defined`) {
		t.Fatalf("error = %v", err)
	}
}
func TestLoadConfigRejectsUnknownServerAttribute(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, `server { public_prefix = "/browser/" }
`+minimalTestConfig("bucket"))
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), "public_prefix") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigValidatesMaxScanPages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, `
auth "public" {
  provider = "s3"
  mode     = "anonymous"
  endpoint = "http://localhost:9000"
  region   = "test"
}

bucket "bucket" {
  auth           = "public"
  bucket         = "bucket"
  max_scan_pages = 1000001
}
`)
	if _, err := loadConfig(path); err == nil || !strings.Contains(err.Error(), "max_scan_pages") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigRejectsOversizedConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	data := strings.Repeat("# padding\n", int(maxConfigurationBytes/10)+2)
	if int64(len(data)) <= maxConfigurationBytes {
		data += strings.Repeat("x", int(maxConfigurationBytes)-len(data)+1)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), "exceeds the") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigRejectsOversizedSecretFile(t *testing.T) {
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secretPath, bytes.Repeat([]byte{'x'}, int(maxSecretFileBytes)+1), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.hcl")
	writeConfig(t, configPath, `
auth "shared" {
  provider               = "s3"
  mode                   = "access_key"
  endpoint               = "http://localhost:9000"
  region                 = "test"
  access_key_id          = "key"
  secret_access_key_file = "./secret.txt"
}

bucket "bucket" { auth = "shared" bucket = "bucket" }
`)
	_, err := loadConfig(configPath)
	if err == nil || !strings.Contains(err.Error(), "exceeds the") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadRuntimeConfigRequiresPath(t *testing.T) {
	_, err := loadRuntimeConfig("")
	if err == nil || !strings.Contains(err.Error(), "configuration path is required") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigRejectsWrongAttributeType(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, `
auth "public" {
  provider = "s3"
  mode     = "anonymous"
  endpoint = "http://localhost:9000"
  region   = "test"
}

bucket "broken" {
  auth        = "public"
  bucket      = "bucket"
  permissions = true
}
`)
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), `attribute "permissions" must be a string list`) {
		t.Fatalf("error = %v", err)
	}
}

func TestParseHCLSubsetCommentsAndEscapes(t *testing.T) {
	t.Parallel()
	root, err := parseHCLSubset(`
// line comment
server { listen = ":8080" }
/* block comment */
bucket "one" {
  name = "A\nB"
  permissions = ["read", "write",]
}
`)
	if err != nil {
		t.Fatal(err)
	}
	if len(root.Blocks) != 2 {
		t.Fatalf("blocks = %d", len(root.Blocks))
	}
	if got, _ := root.Blocks[1].stringAttr("name"); got != "A\nB" {
		t.Fatalf("escaped string = %q", got)
	}
}

func TestLoadConfigJobHistoryLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	writeConfig(t, path, `server { job_history_limit = 12 }
`+minimalTestConfig("primary"))
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.JobHistoryLimit != 12 {
		t.Fatalf("JobHistoryLimit = %d, want 12", cfg.JobHistoryLimit)
	}
}

func TestLoadConfigRejectsInvalidJobHistoryLimit(t *testing.T) {
	for _, value := range []string{"0", "21", `"100"`} {
		t.Run(value, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.hcl")
			writeConfig(t, path, "server { job_history_limit = "+value+" }\n"+minimalTestConfig("primary"))
			if _, err := loadConfig(path); err == nil {
				t.Fatal("expected invalid job history limit to fail")
			}
		})
	}
}

func writeConfig(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
