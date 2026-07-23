package main

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

func TestParseStorageEndpointRejectsAmbiguousOrCredentialedURLs(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		"ftp://example.test",
		"https://user:secret@example.test",
		"https://example.test?mode=test",
		"https://example.test/#fragment",
	} {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			if _, err := parseStorageEndpoint("s3", raw); err == nil {
				t.Fatalf("parseStorageEndpoint(%q) unexpectedly succeeded", raw)
			}
		})
	}
	endpoint, err := parseStorageEndpoint("gcs", "https://example.test/emulator/v1")
	if err != nil || endpoint.Path != "/emulator/v1" {
		t.Fatalf("valid endpoint = %v, %v", endpoint, err)
	}
}

func TestPublicStorageErrorRedactsRequestURLAndProviderMessage(t *testing.T) {
	t.Parallel()
	networkErr := fmt.Errorf("request failed: %w", &url.Error{
		Op:  "Get",
		URL: "https://internal.example.test/private/path?token=secret",
		Err: errors.New("dial failed"),
	})
	if got := publicStorageError(networkErr); got != "unable to connect to or authenticate with the storage provider" {
		t.Fatalf("network error = %q", got)
	}
	upstream := &upstreamError{StatusCode: 403, Code: "AccessDenied", Message: "bucket secret details"}
	got := publicStorageError(upstream)
	if strings.Contains(got, "secret") || got != "the storage provider returned HTTP 403 (AccessDenied)" {
		t.Fatalf("upstream error = %q", got)
	}
}

func TestCapabilityErrorsArePublicSafe(t *testing.T) {
	t.Parallel()
	err := fmt.Errorf("gcs request failed: %w", &url.Error{
		Op:  "Get",
		URL: "https://internal.example.test/storage/v1/b/private",
		Err: errors.New("connection refused"),
	})
	caps := mergeCapabilities(storageConfig{
		Provider:           "gcs",
		PermissionsDefined: true,
		Permissions:        []string{permissionRead},
	}, discoveredCapabilities{}, err)
	for _, value := range []string{caps.Error, caps.Read.Reason, caps.Write.Reason, caps.Delete.Reason} {
		if strings.Contains(value, "internal.example.test") || strings.Contains(value, "/storage/v1/") {
			t.Fatalf("capability leaked endpoint: %q", value)
		}
	}
}

func TestInitialCapabilitiesUseConfigurationWithoutProviderProbe(t *testing.T) {
	t.Parallel()
	caps := initialCapabilities(storageConfig{
		PermissionsDefined: true,
		Permissions:        []string{permissionRead, permissionWrite},
	})
	if !caps.Read.Allowed || !caps.Write.Allowed || caps.Delete.Allowed {
		t.Fatalf("initial capabilities = %#v", caps)
	}
	if caps.CheckedAt != nil {
		t.Fatalf("initial capabilities unexpectedly report provider verification at %v", caps.CheckedAt)
	}
	if caps.Read.Verified || caps.Write.Verified || caps.Delete.Verified {
		t.Fatalf("initial capabilities unexpectedly verified provider permissions: %#v", caps)
	}
	if !strings.Contains(caps.Read.Reason, "not performed automatically") {
		t.Fatalf("read reason = %q", caps.Read.Reason)
	}
}
