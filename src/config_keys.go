package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// keyForms tells the forms that a configuration key accepts.
type keyForms uint8

const (
	// formValue: the value is in the file (`<name> = "..."`).
	formValue keyForms = 1 << iota
	// formEnv: the value is in the environment variable that the file names (`<name>_env = "VAR"`).
	formEnv
	// formFile: the value is the content of the file that the file names (`<name>_file = "/path"`).
	formFile
)

// configKey is one key of the configuration. The decoders, the reference
// (docs/configuration-reference.md) and the effective configuration (print-config)
// all read this table. Thus they always agree.
type configKey struct {
	Block       string
	Name        string
	Type        string
	Default     string
	Range       string
	Forms       keyForms
	Secret      bool
	Description string
}

// configBlock describes one block of the configuration for the reference.
type configBlock struct {
	Path        string
	Syntax      string
	Description string
}

var configBlocks = []configBlock{
	{"server", "server { ... }", "Zero or one block. The listener, the logs and the limits of the process."},
	{"auth", `auth "<id>" { ... }`, "One or more blocks. A credential set and an endpoint that one or more buckets use."},
	{"auth.usage", `auth "<id>" { usage { ... } }`, "Zero or one block in an auth block with provider \"s3\". The admin API that gives the usage and the quota of the buckets of the auth block (docs/ARCHITECTURE.md, \"Usage and quota of a bucket\"). Without it, the interface shows no usage and no quota."},
	{"bucket", `bucket "<id>" { ... }`, "One or more blocks. One bucket that the browser shows. The label is the id of the bucket for the URL and for the access policy."},
	{"access", "access { ... }", "Exactly one block. It is mandatory. The access of humans: `open` or `authzen` (docs/ACCESS.md)."},
	{"access.identity", "access { identity { ... } }", "Exactly one block with `mode = \"authzen\"`. None with `mode = \"open\"`. The identity token of the access gateway."},
	{"access.pdp", "access { pdp { ... } }", "Exactly one block with `mode = \"authzen\"`. None with `mode = \"open\"`. The AuthZEN PDP that decides each action."},
}

var configKeys = []configKey{
	{"server", "listen", "text", `":8080"`, "a numeric host:port, not a URL", formValue, false, "The address and the port that the server listens on."},
	{"server", "job_history_limit", "integer", "10", "1 to 20", formValue, false, "The number of finished background jobs that the process keeps in memory."},
	{"server", "access_mode", "text", `"inherit_credentials"`, "inherit_credentials or force_read_only", formValue, false, "force_read_only refuses each write and each delete. This key is not the access of humans (refer to the access block)."},
	{"server", "log_mode", "text", `"anonymous"`, "anonymous or detailed", formValue, false, "anonymous keeps the object keys out of the request log. detailed writes them."},
	{"server", "frontend", "text", `"default"`, "default or portal, exact (no change of case, no space)", formValue, false, "The embedded browser interface that the server gives. portal is a test interface with the shell of the portal and the dense tables of ClickHouse Dash."},
	{"server", "allow_full_object_fallback", "boolean", "false", "", formValue, false, "Let a parser read a full object when a format has no range reader."},
	{"server", "memory_limit_bytes", "integer", "0", "0, or 33554432 to 1125899906842624", formValue, false, "The soft memory limit of the Go runtime. 0 keeps the default of the runtime."},
	{"server", "max_storage_bytes_per_request", "integer", "274877906944", "1048576 to 1125899906842624", formValue, false, "The provider bytes that one HTTP request can transfer."},
	{"server", "max_storage_requests_per_request", "integer", "4096", "1 to 10000000", formValue, false, "The provider calls that one HTTP request can make."},
	{"server", "max_range_cache_bytes", "integer", "8388608", "1048576 to 4294967296", formValue, false, "The memory cache of one range reader session."},
	{"server", "max_concurrent_storage_requests", "integer", "4", "1 to 1024", formValue, false, "The provider calls that run at the same time, for all the buckets."},
	{"server", "max_concurrent_requests_per_storage", "integer", "2", "1 to 256, and not more than max_concurrent_storage_requests", formValue, false, "The provider calls that run at the same time for one bucket."},
	{"server", "session_ttl_seconds", "integer", "1200", "30 to 604800", formValue, false, "The life of a preview session in memory."},
	{"server", "max_stats_folders", "integer", "1000", "100 to 1000000", formValue, false, "The folder totals that one Insights result keeps."},
	{"server", "max_archive_entries", "integer", "10000", "1 to 1000000", formValue, false, "The entries of a ZIP central directory that the server reads, and the members that a request can select."},
	{"server", "max_background_storage_bytes", "integer", "274877906944", "1048576 to 1125899906842624", formValue, false, "The provider bytes that one background job can transfer."},
	{"server", "max_background_storage_requests", "integer", "100000", "1 to 10000000", formValue, false, "The provider calls that one background job can make."},

	{"auth", "provider", "text", "(required)", "s3 or gcs (lower case)", formValue, false, "The storage protocol."},
	{"auth", "mode", "text", "s3: access_key with credentials, else anonymous. gcs: service_account with credentials_file, else anonymous", "s3: access_key or anonymous. gcs: service_account or anonymous", formValue, false, "How the server signs the provider requests."},
	{"auth", "endpoint", "URL", "s3: (required). gcs: https://storage.googleapis.com", "http or https, without credentials, query or fragment, and without a \"/\" at the end", formValue, false, "The base URL of the provider."},
	{"auth", "region", "text", "s3: (required)", "", formValue, false, "The region that the S3 signature uses."},
	{"auth", "access_key_id", "text", "(none)", "s3 access_key mode only; no space at the start or at the end", formValue | formEnv | formFile, false, "The S3 access key id. It is an identifier, not a secret: print-config shows it."},
	{"auth", "secret_access_key", "text", "(none)", "s3 access_key mode only; no space and no control character", formEnv | formFile, true, "The S3 secret access key. It is a secret: the form in clear text stops the start."},
	{"auth", "session_token", "text", "(none)", "s3 only; no space and no control character", formEnv | formFile, true, "The S3 session token. It is a secret: the form in clear text stops the start."},
	{"auth", "credentials_file", "file path", "(none)", "gcs service_account mode only", formValue, false, "The JSON file of a GCS service account. A relative path starts at the directory of the configuration file."},
	{"auth", "insecure_skip_verify", "boolean", "false", "", formValue, false, "Do not verify the TLS certificate of the provider. Use it only for a test."},

	{"auth.usage", "source", "text", "(required)", "garage, seaweedfs or minio, exact (lower case)", formValue, false, "The reader of the usage and of the quota. The server never guesses it from the provider."},
	{"auth.usage", "endpoint", "URL", "garage: (required), the admin API. seaweedfs: (required), the master. minio: the endpoint of the auth block", "http or https, without credentials, query or fragment, and without a \"/\" at the end", formValue, false, "The base URL of the admin API. print-config and the effective configuration in the log show it. The answers of the server and the error messages never show it."},
	{"auth.usage", "filer_endpoint", "URL", "seaweedfs: (required). Other sources: (none)", "seaweedfs only. http or https, without credentials, query or fragment, and without a \"/\" at the end", formValue, false, "The base URL of the filer of SeaweedFS. The filer gives the quota of a bucket."},
	{"auth.usage", "token", "text", "garage: (required). Other sources: (none)", "garage only; 1 to 4096 bytes, no space and no control character", formEnv | formFile, true, "The admin token of Garage. It is a secret: the form in clear text stops the start. minio signs with the S3 credentials of the auth block. seaweedfs sends no credential."},

	{"bucket", "name", "text", "the label of the block", "", formValue, false, "The name that the user interface shows."},
	{"bucket", "auth", "text", "(required)", "the label of an auth block", formValue, false, "The auth block that this bucket uses."},
	{"bucket", "bucket", "text", "(required)", "", formValue, false, "The name of the bucket at the provider."},
	{"bucket", "permissions", "list of text", "(none: no ceiling)", "read, write, delete (lower case, each one time)", formValue, false, "The operations that the server can do on this bucket. It is a ceiling: the provider and the access policy can refuse more."},
	{"bucket", "root_prefix", "text", `""`, "\"\", or a prefix that ends with \"/\" and does not start with \"/\"", formValue, false, "The part of the bucket that the browser shows. The keys are relative to it."},
	{"bucket", "max_scan_pages", "integer", "1", "0 to 1000000", formValue, false, "The 1000-entry provider pages that one listing combines. 0 = no limit."},
	{"bucket", "encryption", "text", `""`, "\"\" or sse-s3, exact (lower case). SSE-C and SSE-KMS are not supported. Only for an s3 auth block", formValue, false, "The server-side encryption that the server asks for each object that it writes: upload, copy, move, rename, metadata edit, restore of a version, extraction. sse-s3 sends x-amz-server-side-encryption: AES256. \"\" sends no encryption header: the default encryption of the bucket applies."},
	{"bucket", "quota_bytes", "integer", "(none: the limit of the provider, or no limit)", "1 to 1152921504606846976. Only with a usage block in the auth block", formValue, false, "The size limit of the bucket that the interface shows when the provider gives no limit. The server does not enforce it."},

	{"access", "mode", "text", "(required)", "authzen or open", formValue, false, "authzen: verify the identity token and ask the PDP for each action. open: no check of identity or permission. The server writes a warning at each start."},

	{"access.identity", "header", "text", `"X-Identity-Token"`, "an HTTP header name of 1 to 64 characters; not Cookie, Authorization, Host, Content-Type or Content-Length", formValue, false, "The request header that holds the identity token."},
	{"access.identity", "issuer", "text", "(required)", "1 to 1024 bytes, no control character", formValue, false, "The value that the iss claim must have."},
	{"access.identity", "audience", "text", "(required)", "1 to 256 bytes of UTF-8, no control character", formValue, false, "The id of this server at the access gateway. The aud claim must contain it. It is also the id of the service resource and the server of /.well-known/access-actions."},
	{"access.identity", "public_keys", "PEM text", "(required)", "1 to 16 PUBLIC KEY blocks: Ed25519 or P-256", formValue | formEnv | formFile, false, "The public keys of the issuer. The server verifies the signature of each token with them."},
	{"access.identity", "max_age", "duration", `"5m"`, "1s to 24h", formValue, false, "The longest life of a token (exp - iat)."},

	{"access.pdp", "url", "URL", "(required)", "http or https, with a host, without credentials, query or fragment", formValue | formEnv | formFile, false, "The base URL of the PDP. The server adds /access/v1/evaluation or /access/v1/evaluations."},
	{"access.pdp", "token", "text", "(required)", "1 to 4096 bytes, no space and no control character", formEnv | formFile, true, "The bearer token of this server at the PDP. It is a secret: the form in clear text stops the start."},
	{"access.pdp", "timeout", "duration", `"500ms"`, "10ms to 1m", formValue, false, "The longest time of one request to the PDP. After it, the decision is false."},
	{"access.pdp", "cache_ttl", "duration", `"30s"`, "0s to 1h", formValue, false, "The longest time that the server keeps a decision of the PDP. 0s = no cache."},
	{"access.pdp", "max_evaluations", "integer", "64", "1 to 1024", formValue, false, "The most evaluations in one batch request. Use the limit of the PDP or less."},
}

// keysOfBlock gives the keys of one block, in the order of the table.
func keysOfBlock(block string) []configKey {
	out := make([]configKey, 0, 16)
	for _, key := range configKeys {
		if key.Block == block {
			out = append(out, key)
		}
	}
	return out
}

// attributeNames gives each attribute name that a block accepts: the name of
// each key, and its _env and _file forms when the key has them.
func attributeNames(block string) []string {
	names := make([]string, 0, 24)
	for _, key := range keysOfBlock(block) {
		if key.Forms&formValue != 0 {
			names = append(names, key.Name)
		}
		if key.Forms&formEnv != 0 {
			names = append(names, key.Name+"_env")
		}
		if key.Forms&formFile != 0 {
			names = append(names, key.Name+"_file")
		}
	}
	return names
}

// keyOfAttribute gives the key and the form of an attribute name of a block.
func keyOfAttribute(block, attribute string) (configKey, keyForms, bool) {
	for _, key := range keysOfBlock(block) {
		switch {
		case key.Forms&formValue != 0 && attribute == key.Name:
			return key, formValue, true
		case key.Forms&formEnv != 0 && attribute == key.Name+"_env":
			return key, formEnv, true
		case key.Forms&formFile != 0 && attribute == key.Name+"_file":
			return key, formFile, true
		}
	}
	return configKey{}, 0, false
}

// recordSources notes the source of each attribute of a block: "file" for a
// value in the file, "env:VAR" or "file:/path" for an indirect form.
func recordSources(cfg *appConfig, path, blockType string, block hclBlock, baseDir string) {
	if cfg.Sources == nil {
		cfg.Sources = make(map[string]string)
	}
	for name, attr := range block.Attrs {
		key, form, ok := keyOfAttribute(blockType, name)
		if !ok {
			continue
		}
		source := "file"
		switch form {
		case formEnv:
			source = "env:" + attr.Value.String
		case formFile:
			source = "file:" + resolveConfigPath(attr.Value.String, baseDir)
		}
		cfg.Sources[path+"."+key.Name] = source
	}
}

// configReference gives the text of docs/configuration-reference.md.
func configReference() string {
	var b strings.Builder
	b.WriteString("# Configuration reference\n\n")
	b.WriteString("This document uses ASD-STE100 Simplified Technical English.\n\n")
	b.WriteString("Do not edit this file. The program makes it from the table of keys in `src/config_keys.go`.\n")
	b.WriteString("To make it again, run `go run . config-reference > ../docs/configuration-reference.md` in `src`.\n")
	b.WriteString("A test makes sure that this file and the table agree.\n\n")
	b.WriteString("## Rules\n\n")
	b.WriteString("- An unknown block, an unknown attribute or a duplicate attribute stops the start.\n")
	b.WriteString("- A value that is not in its range stops the start. The error gives the key and the line.\n")
	b.WriteString("- A key without a value in the file has its default value. A key with `(required)` must have a value.\n")
	b.WriteString("- The `access` block is mandatory. A file without it stops the start.\n")
	b.WriteString("- `s3-browser print-config -c <file>` checks the file, writes the value of each key and its source, and exits with status 0.\n")
	b.WriteString("  The source is `file`, `env:<VAR>`, `file:<path>` or `default`. The output hides each secret.\n")
	b.WriteString("- At start, the server writes the same values in its log.\n\n")
	b.WriteString("## Values from the environment or from a file\n\n")
	b.WriteString("The column *Forms* gives the forms of each key:\n\n")
	b.WriteString("- `value`: `<name> = \"...\"`. The value is in the file.\n")
	b.WriteString("- `_env`: `<name>_env = \"VAR\"`. The value is in the environment variable `VAR`.\n")
	b.WriteString("- `_file`: `<name>_file = \"/path\"`. The value is the content of the file, without the last line end.\n")
	b.WriteString("  A relative path starts at the directory of the configuration file.\n\n")
	b.WriteString("Give one form only. Two forms stop the start. A variable that does not exist, an empty value, or a file that the\n")
	b.WriteString("server cannot read stops the start. The server reads each variable and each file one time, at start. The server reads\n")
	b.WriteString("no environment variable that the file does not name.\n\n")
	b.WriteString("A secret key has *yes* in the column *Secret*. A secret accepts only `_env` and `_file`: a secret in clear text in\n")
	b.WriteString("the file stops the start. The output of `print-config` and the log show `<hidden>` for it.\n\n")
	b.WriteString("## No change of a value\n\n")
	b.WriteString("The value in the file is the value that applies. The server does not remove spaces, does not change the case, and does\n")
	b.WriteString("not add or remove a `/`. A value that does not fit stops the start. The error gives the key, the expected form and the\n")
	b.WriteString("value. An error about a secret does not show the value. A text value must not be empty and must not have a space at\n")
	b.WriteString("the start or at the end: to use the default of a key, remove the key.\n")
	for _, block := range configBlocks {
		fmt.Fprintf(&b, "\n## `%s`\n\n", block.Path)
		fmt.Fprintf(&b, "Syntax: `%s`. %s\n\n", block.Syntax, block.Description)
		b.WriteString("| Key | Type | Default | Range | Forms | Secret | Use |\n")
		b.WriteString("|---|---|---|---|---|---|---|\n")
		for _, key := range keysOfBlock(block.Path) {
			secret := "no"
			if key.Secret {
				secret = "yes"
			}
			fmt.Fprintf(&b, "| `%s` | %s | %s | %s | %s | %s | %s |\n",
				key.Name, key.Type, markdownCell(key.Default), markdownCell(key.Range), formsText(key.Forms), secret, markdownCell(key.Description))
		}
	}
	return b.String()
}

func markdownCell(value string) string {
	if value == "" {
		return " "
	}
	return strings.ReplaceAll(value, "|", "\\|")
}

func formsText(forms keyForms) string {
	parts := make([]string, 0, 3)
	if forms&formValue != 0 {
		parts = append(parts, "value")
	}
	if forms&formEnv != 0 {
		parts = append(parts, "`_env`")
	}
	if forms&formFile != 0 {
		parts = append(parts, "`_file`")
	}
	return strings.Join(parts, ", ")
}

// effectiveSetting is one line of the effective configuration.
type effectiveSetting struct {
	Name   string
	Value  string
	Source string
}

// effectiveConfiguration gives the value that applies for each key, and its
// source. It hides each secret.
func effectiveConfiguration(cfg appConfig) []effectiveSetting {
	out := make([]effectiveSetting, 0, 96)
	addBlock := func(path, blockType string, values map[string]string) {
		for _, key := range keysOfBlock(blockType) {
			value, ok := values[key.Name]
			if !ok {
				value = "<none>"
			}
			source, found := cfg.Sources[path+"."+key.Name]
			if !found {
				source = "default"
			}
			out = append(out, effectiveSetting{Name: path + "." + key.Name, Value: value, Source: source})
		}
	}
	add := func(path string, values map[string]string) {
		blockType := path
		if index := strings.IndexByte(path, ' '); index >= 0 {
			blockType = path[:index]
		}
		addBlock(path, blockType, values)
	}
	runtime := cfg.Runtime
	add("server", map[string]string{
		"listen":                              strconv.Quote(cfg.Listen),
		"job_history_limit":                   strconv.Itoa(cfg.JobHistoryLimit),
		"access_mode":                         strconv.Quote(runtime.AccessMode),
		"log_mode":                            strconv.Quote(runtime.LogMode),
		"frontend":                            strconv.Quote(cfg.Frontend),
		"allow_full_object_fallback":          strconv.FormatBool(runtime.AllowFullObjectFallback),
		"memory_limit_bytes":                  strconv.FormatInt(runtime.MemoryLimitBytes, 10),
		"max_storage_bytes_per_request":       strconv.FormatInt(runtime.MaxStorageBytesPerRequest, 10),
		"max_storage_requests_per_request":    strconv.FormatInt(runtime.MaxStorageRequestsPerRequest, 10),
		"max_range_cache_bytes":               strconv.FormatInt(runtime.MaxRangeCacheBytes, 10),
		"max_concurrent_storage_requests":     strconv.Itoa(runtime.MaxConcurrentStorageRequests),
		"max_concurrent_requests_per_storage": strconv.Itoa(runtime.MaxConcurrentRequestsPerStore),
		"session_ttl_seconds":                 strconv.Itoa(runtime.SessionTTLSeconds),
		"max_stats_folders":                   strconv.Itoa(runtime.MaxStatsFolders),
		"max_archive_entries":                 strconv.Itoa(runtime.MaxArchiveEntries),
		"max_background_storage_bytes":        strconv.FormatInt(runtime.MaxBackgroundStorageBytes, 10),
		"max_background_storage_requests":     strconv.FormatInt(runtime.MaxBackgroundStorageRequests, 10),
	})
	hidden := func(value string) string {
		if value == "" {
			return "<none>"
		}
		return "<hidden>"
	}
	for _, auth := range cfg.Authentications {
		values := map[string]string{
			"provider":             strconv.Quote(auth.Provider),
			"mode":                 strconv.Quote(auth.Mode),
			"endpoint":             strconv.Quote(auth.Endpoint),
			"access_key_id":        quotedOrNone(auth.AccessKeyID),
			"secret_access_key":    hidden(auth.SecretAccessKey),
			"session_token":        hidden(auth.SessionToken),
			"insecure_skip_verify": strconv.FormatBool(auth.InsecureSkipVerify),
		}
		if auth.Region != "" {
			values["region"] = strconv.Quote(auth.Region)
		}
		if auth.CredentialsFile != "" {
			values["credentials_file"] = strconv.Quote(auth.CredentialsFile)
		}
		add("auth "+strconv.Quote(auth.ID), values)
		if usage := auth.Usage; usage != nil {
			addBlock("auth "+strconv.Quote(auth.ID)+".usage", "auth.usage", map[string]string{
				"source":         strconv.Quote(usage.Source),
				"endpoint":       strconv.Quote(usage.Endpoint),
				"filer_endpoint": quotedOrNone(usage.FilerEndpoint),
				"token":          hidden(usage.Token),
			})
		}
	}
	for _, bucket := range cfg.Buckets {
		values := map[string]string{
			"name":           strconv.Quote(bucket.Name),
			"auth":           strconv.Quote(bucket.AuthID),
			"bucket":         strconv.Quote(bucket.Bucket),
			"root_prefix":    strconv.Quote(bucket.RootPrefix),
			"max_scan_pages": strconv.Itoa(bucket.MaxScanPages),
			"encryption":     strconv.Quote(bucket.Encryption),
		}
		if bucket.PermissionsDefined {
			values["permissions"] = quotedList(bucket.Permissions)
		}
		if bucket.QuotaBytes != 0 {
			values["quota_bytes"] = strconv.FormatInt(bucket.QuotaBytes, 10)
		}
		add("bucket "+strconv.Quote(bucket.ID), values)
	}
	access := cfg.Access
	add("access", map[string]string{"mode": strconv.Quote(access.Mode)})
	if access.enforced() {
		add("access.identity", map[string]string{
			"header":      strconv.Quote(access.Header),
			"issuer":      strconv.Quote(access.Issuer),
			"audience":    strconv.Quote(access.Audience),
			"public_keys": quotedList(identityKeyNames(access.Keys)),
			"max_age":     strconv.Quote(access.MaxAge.String()),
		})
		add("access.pdp", map[string]string{
			"url":             strconv.Quote(access.PDPURL),
			"token":           hidden(access.PDPToken),
			"timeout":         strconv.Quote(access.PDPTimeout.String()),
			"cache_ttl":       strconv.Quote(access.PDPCacheTTL.String()),
			"max_evaluations": strconv.Itoa(access.PDPMaxEvaluations),
		})
	}
	return out
}

func quotedOrNone(value string) string {
	if value == "" {
		return "<none>"
	}
	return strconv.Quote(value)
}

func quotedList(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, strconv.Quote(value))
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

// formatEffectiveConfiguration gives one line for each key: `name = value  # source`.
func formatEffectiveConfiguration(cfg appConfig) string {
	var b strings.Builder
	for _, setting := range effectiveConfiguration(cfg) {
		fmt.Fprintf(&b, "%s = %s  # %s\n", setting.Name, setting.Value, setting.Source)
	}
	return b.String()
}

// configWarnings gives the warnings of a valid configuration. The server
// writes them at each start.
func configWarnings(cfg appConfig) []string {
	warnings := make([]string, 0, 2)
	if !cfg.Access.enforced() {
		warnings = append(warnings, "config.warning access.mode = \"open\": the server checks no identity and no permission; use it only on a closed network")
	}
	return warnings
}

// parseConfigDuration reads a Go duration (for example "500ms" or "5m") and
// checks its range.
func parseConfigDuration(block hclBlock, path, name string, fallback, minimum, maximum time.Duration) (time.Duration, error) {
	raw, ok := block.stringAttr(name)
	if !ok {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, block.errorf("%s.%s must be a duration from %s to %s (for example \"500ms\" or \"5m\"), got %q", path, name, minimum, maximum, raw)
	}
	return value, nil
}
