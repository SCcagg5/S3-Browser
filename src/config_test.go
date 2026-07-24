package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigMultipleProviders(t *testing.T) {
	dir := t.TempDir()
	credentialsDir := filepath.Join(dir, "credentials")
	if err := os.Mkdir(credentialsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	gcsCredentials := filepath.Join(credentialsDir, "gcs.json")
	if err := os.WriteFile(gcsCredentials, []byte(`{"type":"service_account"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	configPath := filepath.Join(dir, "config.hcl")
	config := `
server {
  listen   = ":9090"
  data_dir = "./state"
}

storage "primary" {
  name              = "Primary S3"
  provider          = "s3"
  endpoint          = "http://127.0.0.1:9000/"
  region            = "us-east-1"
  bucket            = "assets"
  auth              = "access_key"
  access_key_id     = "local-key"
  secret_access_key = "local-secret"
  permissions       = ["read", "write", "delete"]
  root_prefix       = "/tenant-a"
}

storage "archive" {
  name             = "Archive GCS"
  provider         = "gcs"
  bucket           = "archive-bucket"
  auth             = "service_account"
  credentials_file = "./credentials/gcs.json"
}
`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		t.Fatalf("loadConfig() error = %v", err)
	}
	if cfg.Listen != ":9090" {
		t.Fatalf("Listen = %q", cfg.Listen)
	}
	if cfg.SourceName != configPath {
		t.Fatalf("SourceName = %q, want %q", cfg.SourceName, configPath)
	}
	if cfg.DataDir != filepath.Join(dir, "state") {
		t.Fatalf("DataDir = %q", cfg.DataDir)
	}
	if len(cfg.Storages) != 2 {
		t.Fatalf("storages = %d, want 2", len(cfg.Storages))
	}

	s3 := cfg.Storages[0]
	if s3.ID != "primary" || s3.Name != "Primary S3" || s3.Endpoint != "http://127.0.0.1:9000" {
		t.Fatalf("unexpected S3 config: %+v", s3)
	}
	if s3.AccessKeyID != "local-key" || s3.SecretAccessKey != "local-secret" {
		t.Fatal("direct S3 credentials were not preserved")
	}
	if s3.RootPrefix != "tenant-a/" {
		t.Fatalf("RootPrefix = %q", s3.RootPrefix)
	}
	if got := strings.Join(s3.Permissions, ","); got != "read,write,delete" {
		t.Fatalf("Permissions = %q", got)
	}

	gcs := cfg.Storages[1]
	if gcs.Endpoint != "https://storage.googleapis.com" {
		t.Fatalf("GCS default endpoint = %q", gcs.Endpoint)
	}
	if gcs.CredentialsFile != gcsCredentials {
		t.Fatalf("credentials path = %q, want %q", gcs.CredentialsFile, gcsCredentials)
	}
	if gcs.PermissionsDefined {
		t.Fatal("GCS permissions should be auto-discovered when omitted")
	}
}

func TestLoadConfigRejectsWrongAttributeType(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "config.hcl")
	content := `
storage "broken" {
  provider = "s3"
  endpoint = "http://localhost:9000"
  region = "test"
  bucket = "bucket"
  auth = "anonymous"
  permissions = true
}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), `attribute "permissions" must be a string list`) {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigSupportsS3EnvironmentAndFileCredentials(t *testing.T) {
	dir := t.TempDir()
	secretFile := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("file-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("S3_TEST_ACCESS_KEY", "environment-key")
	path := filepath.Join(dir, "config.hcl")
	content := `
storage "configured" {
  provider               = "s3"
  endpoint               = "http://localhost:9000"
  region                 = "test"
  bucket                 = "bucket"
  auth                   = "access_key"
  access_key_id_env      = "S3_TEST_ACCESS_KEY"
  secret_access_key_file = "./secret.txt"
}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	storage := cfg.Storages[0]
	if storage.AccessKeyID != "environment-key" || storage.SecretAccessKey != "file-secret" {
		t.Fatalf("resolved credentials are incorrect: access=%q secret=%q", storage.AccessKeyID, storage.SecretAccessKey)
	}
}

func TestLoadConfigRejectsMultipleSourcesForCredential(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	content := `
storage "broken" {
  provider          = "s3"
  endpoint          = "http://localhost:9000"
  region            = "test"
  bucket            = "bucket"
  auth              = "access_key"
  access_key_id     = "direct"
  access_key_id_env = "S3_ACCESS_KEY"
  secret_key        = "secret"
}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), "only one of access_key_id") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadConfigRejectsMissingCredentialEnvironmentVariable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.hcl")
	content := `
storage "broken" {
  provider          = "s3"
  endpoint          = "http://localhost:9000"
  region            = "test"
  bucket            = "bucket"
  auth              = "access_key"
  access_key_id_env = "S3_BROWSER_TEST_MISSING"
  secret_key        = "secret"
}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), "is not set") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadRuntimeConfigSourcePrecedence(t *testing.T) {
	dir := t.TempDir()
	explicitPath := filepath.Join(dir, "explicit.hcl")
	environmentPath := filepath.Join(dir, "environment.hcl")
	writeMinimalConfig(t, explicitPath, "explicit")
	writeMinimalConfig(t, environmentPath, "environment")

	t.Setenv(configFileEnvironment, environmentPath)
	t.Setenv(configHCLEnvironment, minimalConfig("inline"))

	cfg, err := loadRuntimeConfig(explicitPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Storages[0].ID != "explicit" {
		t.Fatalf("explicit source did not win: %q", cfg.Storages[0].ID)
	}

	cfg, err = loadRuntimeConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Storages[0].ID != "environment" {
		t.Fatalf("file environment source did not win: %q", cfg.Storages[0].ID)
	}

	t.Setenv(configFileEnvironment, "")
	cfg, err = loadRuntimeConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Storages[0].ID != "inline" || cfg.SourceName != configHCLEnvironment {
		t.Fatalf("inline source was not loaded: %+v", cfg)
	}
}

func TestLoadRuntimeConfigRequiresSource(t *testing.T) {
	t.Setenv(configFileEnvironment, "")
	t.Setenv(configHCLEnvironment, "")
	_, err := loadRuntimeConfig("")
	if err == nil || !strings.Contains(err.Error(), "configuration is required") {
		t.Fatalf("error = %v", err)
	}
}

func TestParseHCLSubsetCommentsAndEscapes(t *testing.T) {
	t.Parallel()
	root, err := parseHCLSubset(`
// line comment
server { listen = ":8080" }
/* block comment */
storage "one" {
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

func writeMinimalConfig(t *testing.T, path, id string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(minimalConfig(id)), 0o600); err != nil {
		t.Fatal(err)
	}
}

func minimalConfig(id string) string {
	return `
storage "` + id + `" {
  provider = "s3"
  endpoint = "http://localhost:9000"
  region = "test"
  bucket = "bucket"
  auth = "anonymous"
}
`
}

func TestLoadConfigJobHistoryLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.hcl")
	content := `
server {
  data_dir         = "./state"
  job_history_limit = 37
}

storage "primary" {
  provider = "s3"
  endpoint = "http://localhost:9000"
  region   = "test"
  bucket   = "bucket"
  auth     = "anonymous"
}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.JobHistoryLimit != 37 {
		t.Fatalf("JobHistoryLimit = %d, want 37", cfg.JobHistoryLimit)
	}
}

func TestLoadConfigRejectsInvalidJobHistoryLimit(t *testing.T) {
	for _, value := range []string{"0", "10001", `"100"`} {
		t.Run(value, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.hcl")
			content := `
server {
  job_history_limit = ` + value + `
}

storage "primary" {
  provider = "s3"
  endpoint = "http://localhost:9000"
  region   = "test"
  bucket   = "bucket"
  auth     = "anonymous"
}
`
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := loadConfig(path)
			if err == nil {
				t.Fatal("expected invalid job history limit to fail")
			}
		})
	}
}
