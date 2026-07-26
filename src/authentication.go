package main

import (
	"fmt"
	"net/http"
	"net/url"
)

// sharedAuthentication owns provider credentials, the provider endpoint, the
// HTTP connection pool, and any renewable provider token. Multiple buckets may
// reference the same authentication block and therefore reuse the same network
// and token state without duplicating secrets or connection pools.
type sharedAuthentication struct {
	cfg      authConfig
	endpoint *url.URL
	client   *http.Client
	s3Creds  s3Credentials
	gcsToken *gcsTokenSource
}

func newSharedAuthentication(cfg authConfig) (*sharedAuthentication, error) {
	endpoint, err := parseStorageEndpoint(cfg.Provider, cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	client := newStorageHTTPClient(cfg.InsecureSkipVerify)
	auth := &sharedAuthentication{cfg: cfg, endpoint: endpoint, client: client}

	switch cfg.Provider {
	case "s3":
		auth.s3Creds = s3Credentials{
			AccessKeyID:     cfg.AccessKeyID,
			SecretAccessKey: cfg.SecretAccessKey,
			SessionToken:    cfg.SessionToken,
		}
		if cfg.Mode == "access_key" && (auth.s3Creds.AccessKeyID == "" || auth.s3Creds.SecretAccessKey == "") {
			closeHTTPClient(client)
			return nil, fmt.Errorf("auth %q contains incomplete S3 credentials", cfg.ID)
		}
	case "gcs":
		if cfg.Mode == "service_account" {
			tokens, err := loadGCSTokenSource(cfg.CredentialsFile, client)
			if err != nil {
				closeHTTPClient(client)
				return nil, err
			}
			auth.gcsToken = tokens
		}
	default:
		closeHTTPClient(client)
		return nil, fmt.Errorf("auth %q uses unsupported provider %q", cfg.ID, cfg.Provider)
	}
	return auth, nil
}

func (a *sharedAuthentication) close() {
	if a == nil {
		return
	}
	closeHTTPClient(a.client)
}

func closeHTTPClient(client *http.Client) {
	if client == nil {
		return
	}
	if transport, ok := client.Transport.(*http.Transport); ok {
		transport.CloseIdleConnections()
	}
}
