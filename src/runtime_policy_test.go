package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultConfigurationIsEphemeralAndDoesNotCreateState(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cfg, err := decodeConfig(minimalTestConfig("ephemeral"), filepath.Join(root, "config.hcl"), root)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Runtime.AccessMode != accessModeInheritCredentials {
		t.Fatalf("access mode = %q", cfg.Runtime.AccessMode)
	}
	if cfg.Runtime.StateMode != stateModeEphemeral || cfg.DataDir != "" {
		t.Fatalf("state mode/data dir = %q / %q", cfg.Runtime.StateMode, cfg.DataDir)
	}
	app, err := newApplication(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	if app.jobs == nil || app.jobs.dir != "" {
		t.Fatalf("job manager persisted to %q", app.jobs.dir)
	}
	if app.uploads == nil || app.uploads.dir != "" {
		t.Fatalf("upload manager persisted to %q", app.uploads.dir)
	}
	if _, err := os.Stat(filepath.Join(root, ".s3-browser-data")); !os.IsNotExist(err) {
		t.Fatalf("default startup created persistent state: %v", err)
	}
}

func TestForceReadOnlyIsAnAdministrativeCeiling(t *testing.T) {
	t.Parallel()
	cfg := bucketConfig{PermissionsDefined: false}
	caps := initialCapabilities(cfg, true)
	if caps.Read.State != capabilityUnknown || !caps.Read.Allowed {
		t.Fatalf("read = %#v, want tentable", caps.Read)
	}
	for name, state := range map[string]capabilityState{
		permissionWrite: caps.Write, permissionDelete: caps.Delete,
	} {
		if state.State != capabilityDenied || state.Allowed || state.Source != "runtime" || !state.Verified {
			t.Fatalf("%s = %#v, want runtime denial", name, state)
		}
	}
}

func TestPersistentStateRequiresExplicitModeAndDirectory(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	withoutMode := `server { data_dir = "./state" }
` + minimalTestConfig("persistent")
	if _, err := decodeConfig(withoutMode, filepath.Join(root, "config.hcl"), root); err == nil || !strings.Contains(err.Error(), "data_dir requires state_mode") {
		t.Fatalf("unexpected error = %v", err)
	}

	withMode := `server { state_mode = "persistent" data_dir = "./state" }
` + minimalTestConfig("persistent")
	cfg, err := decodeConfig(withMode, filepath.Join(root, "config.hcl"), root)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Runtime.StateMode != stateModePersistent || cfg.DataDir != filepath.Join(root, "state") {
		t.Fatalf("state mode/data dir = %q / %q", cfg.Runtime.StateMode, cfg.DataDir)
	}
}

func minimalTestConfig(id string) string {
	return `
auth "public" {
  provider = "s3"
  mode     = "anonymous"
  endpoint = "http://localhost:9000"
  region   = "test"
}

bucket "` + id + `" {
  auth   = "public"
  bucket = "bucket"
}
`
}
