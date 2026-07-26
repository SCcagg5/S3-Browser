package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type appConfig struct {
	Listen          string
	DataDir         string
	JobHistoryLimit int
	Runtime         runtimePolicy
	Authentications []authConfig
	Buckets         []bucketConfig
	SourceDir       string
	SourceName      string
}

type authConfig struct {
	ID                 string
	Provider           string
	Mode               string
	Endpoint           string
	Region             string
	AccessKeyID        string
	SecretAccessKey    string
	SessionToken       string
	CredentialsFile    string
	InsecureSkipVerify bool
}

type bucketConfig struct {
	ID                 string
	Name               string
	AuthID             string
	Provider           string
	Bucket             string
	Region             string
	Permissions        []string
	PermissionsDefined bool
	RootPrefix         string
	MaxScanPages       int
}

const (
	maxConfigurationBytes = int64(4 << 20)
	maxSecretFileBytes    = int64(1 << 20)
)

func loadConfig(filename string) (appConfig, error) {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return appConfig{}, fmt.Errorf("configuration path cannot be empty")
	}
	abs, err := filepath.Abs(filename)
	if err != nil {
		return appConfig{}, fmt.Errorf("resolve configuration path: %w", err)
	}
	data, err := readBoundedFile(abs, maxConfigurationBytes)
	if err != nil {
		return appConfig{}, fmt.Errorf("read configuration %q: %w", abs, err)
	}
	return decodeConfig(string(data), abs, filepath.Dir(abs))
}

func readBoundedFile(filename string, maximum int64) ([]byte, error) {
	if maximum < 1 {
		return nil, fmt.Errorf("file size limit must be positive")
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, fmt.Errorf("file exceeds the %d-byte limit", maximum)
	}
	return data, nil
}

func loadRuntimeConfig(configPath string) (appConfig, error) {
	configPath = strings.TrimSpace(configPath)
	if configPath == "" {
		return appConfig{}, fmt.Errorf("configuration path is required; use -c <path> or --config <path>")
	}
	return loadConfig(configPath)
}

func decodeConfig(data, sourceName, sourceDir string) (appConfig, error) {
	root, err := parseHCLSubset(data)
	if err != nil {
		return appConfig{}, fmt.Errorf("parse configuration %q: %w", sourceName, err)
	}

	cfg := appConfig{
		Listen:          ":8080",
		JobHistoryLimit: 100,
		Runtime:         defaultRuntimePolicy(),
		SourceDir:       sourceDir,
		SourceName:      sourceName,
	}

	if len(root.Attrs) != 0 {
		for name, attr := range root.Attrs {
			return appConfig{}, fmt.Errorf("line %d:%d: root attribute %q is not supported; use a block", attr.Line, attr.Column, name)
		}
	}

	var serverSeen bool
	authByID := make(map[string]authConfig)
	bucketIDs := make(map[string]struct{})
	bucketBlocks := make([]hclBlock, 0)

	for _, block := range root.Blocks {
		switch block.Type {
		case "server":
			if serverSeen {
				return appConfig{}, fmt.Errorf("only one server block is allowed")
			}
			serverSeen = true
			if err := decodeServerBlock(block, &cfg); err != nil {
				return appConfig{}, err
			}
		case "auth":
			auth, err := decodeAuthBlock(block, sourceDir)
			if err != nil {
				return appConfig{}, err
			}
			if _, exists := authByID[auth.ID]; exists {
				return appConfig{}, block.errorf("duplicate auth id %q", auth.ID)
			}
			authByID[auth.ID] = auth
			cfg.Authentications = append(cfg.Authentications, auth)
		case "bucket":
			if len(block.Labels) != 1 {
				return appConfig{}, block.errorf("bucket block requires exactly one quoted identifier")
			}
			id := strings.TrimSpace(block.Labels[0])
			if _, exists := bucketIDs[id]; exists {
				return appConfig{}, block.errorf("duplicate bucket id %q", id)
			}
			bucketIDs[id] = struct{}{}
			bucketBlocks = append(bucketBlocks, block)
		default:
			return appConfig{}, block.errorf("unknown block type %q; supported blocks are server, auth, and bucket", block.Type)
		}
	}

	if len(authByID) == 0 {
		return appConfig{}, fmt.Errorf("at least one auth block is required")
	}
	if len(bucketBlocks) == 0 {
		return appConfig{}, fmt.Errorf("at least one bucket block is required")
	}
	for _, block := range bucketBlocks {
		bucket, err := decodeBucketBlock(block, authByID)
		if err != nil {
			return appConfig{}, err
		}
		cfg.Buckets = append(cfg.Buckets, bucket)
	}

	if err := validateRuntimePolicy(&cfg); err != nil {
		return appConfig{}, err
	}
	return cfg, nil
}

func decodeServerBlock(block hclBlock, cfg *appConfig) error {
	if cfg == nil {
		return fmt.Errorf("configuration is nil")
	}
	if len(block.Labels) != 0 {
		return block.errorf("server block does not accept labels")
	}
	if len(block.Blocks) != 0 {
		return block.errorf("nested blocks are not supported inside server")
	}
	serverKinds := map[string]hclValueKind{
		"listen": hclString, "data_dir": hclString, "job_history_limit": hclNumber,
		"access_mode": hclString, "state_mode": hclString, "log_mode": hclString,
		"browser_persistence": hclBool, "allow_full_object_fallback": hclBool,
		"memory_limit_bytes": hclNumber, "max_storage_bytes_per_request": hclNumber,
		"max_storage_requests_per_request": hclNumber, "max_temp_bytes_per_session": hclNumber,
		"max_range_cache_bytes": hclNumber, "max_concurrent_storage_requests": hclNumber,
		"max_concurrent_requests_per_storage": hclNumber, "session_ttl_seconds": hclNumber,
		"max_stats_folders": hclNumber, "max_archive_entries": hclNumber,
	}
	allowed := make([]string, 0, len(serverKinds))
	for name := range serverKinds {
		allowed = append(allowed, name)
	}
	if err := rejectUnknownAttrs(block, allowed...); err != nil {
		return err
	}
	if err := requireAttrKinds(block, serverKinds); err != nil {
		return err
	}
	if value, ok := block.stringAttr("listen"); ok {
		listen, err := normalizeListenAddress(value)
		if err != nil {
			return block.errorf("server.listen: %v", err)
		}
		cfg.Listen = listen
	}
	if value, ok := block.stringAttr("data_dir"); ok {
		value = strings.TrimSpace(value)
		if value == "" {
			return block.errorf("server.data_dir cannot be empty")
		}
		if !filepath.IsAbs(value) {
			value = filepath.Join(cfg.SourceDir, value)
		}
		cfg.DataDir = filepath.Clean(value)
	}
	if value, ok := block.intAttr("job_history_limit"); ok {
		if value < 1 || value > 10000 {
			return block.errorf("server.job_history_limit must be between 1 and 10000")
		}
		cfg.JobHistoryLimit = int(value)
	}
	if value, ok := block.stringAttr("access_mode"); ok {
		cfg.Runtime.AccessMode = strings.ToLower(strings.TrimSpace(value))
	}
	if value, ok := block.stringAttr("state_mode"); ok {
		cfg.Runtime.StateMode = strings.ToLower(strings.TrimSpace(value))
	}
	if value, ok := block.stringAttr("log_mode"); ok {
		cfg.Runtime.LogMode = strings.ToLower(strings.TrimSpace(value))
	}
	if value, ok := block.boolAttr("browser_persistence"); ok {
		cfg.Runtime.BrowserPersistence = value
	}
	if value, ok := block.boolAttr("allow_full_object_fallback"); ok {
		cfg.Runtime.AllowFullObjectFallback = value
	}
	integerSettings := []struct {
		name        string
		destination *int64
	}{
		{"memory_limit_bytes", &cfg.Runtime.MemoryLimitBytes},
		{"max_storage_bytes_per_request", &cfg.Runtime.MaxStorageBytesPerRequest},
		{"max_storage_requests_per_request", &cfg.Runtime.MaxStorageRequestsPerRequest},
		{"max_temp_bytes_per_session", &cfg.Runtime.MaxTempBytesPerSession},
		{"max_range_cache_bytes", &cfg.Runtime.MaxRangeCacheBytes},
	}
	for _, setting := range integerSettings {
		if value, ok := block.intAttr(setting.name); ok {
			*setting.destination = value
		}
	}
	if value, ok := block.intAttr("max_concurrent_storage_requests"); ok {
		cfg.Runtime.MaxConcurrentStorageRequests = int(value)
	}
	if value, ok := block.intAttr("max_concurrent_requests_per_storage"); ok {
		cfg.Runtime.MaxConcurrentRequestsPerStore = int(value)
	}
	if value, ok := block.intAttr("session_ttl_seconds"); ok {
		cfg.Runtime.SessionTTLSeconds = int(value)
	}
	if value, ok := block.intAttr("max_stats_folders"); ok {
		cfg.Runtime.MaxStatsFolders = int(value)
	}
	if value, ok := block.intAttr("max_archive_entries"); ok {
		cfg.Runtime.MaxArchiveEntries = int(value)
	}
	return nil
}

func validateRuntimePolicy(cfg *appConfig) error {
	if cfg == nil {
		return fmt.Errorf("configuration is nil")
	}
	listen, err := normalizeListenAddress(cfg.Listen)
	if err != nil {
		return fmt.Errorf("server.listen: %w", err)
	}
	cfg.Listen = listen
	switch cfg.Runtime.AccessMode {
	case accessModeInheritCredentials, accessModeForceReadOnly:
	default:
		return fmt.Errorf("server.access_mode must be %q or %q", accessModeInheritCredentials, accessModeForceReadOnly)
	}
	switch cfg.Runtime.StateMode {
	case stateModeEphemeral:
		if strings.TrimSpace(cfg.DataDir) != "" {
			return fmt.Errorf("server.data_dir requires state_mode = %q", stateModePersistent)
		}
		cfg.DataDir = ""
	case stateModePersistent:
		if strings.TrimSpace(cfg.DataDir) == "" {
			return fmt.Errorf("server.data_dir is required when state_mode = %q", stateModePersistent)
		}
		cfg.DataDir = filepath.Clean(cfg.DataDir)
	default:
		return fmt.Errorf("server.state_mode must be %q or %q", stateModeEphemeral, stateModePersistent)
	}
	switch cfg.Runtime.LogMode {
	case logModeAnonymous, logModeDetailed:
	default:
		return fmt.Errorf("server.log_mode must be %q or %q", logModeAnonymous, logModeDetailed)
	}
	if cfg.Runtime.BrowserPersistence && cfg.Runtime.StateMode != stateModePersistent {
		return fmt.Errorf("server.browser_persistence requires state_mode = %q", stateModePersistent)
	}
	validateRange := func(name string, value, minimum, maximum int64) error {
		if value < minimum || value > maximum {
			return fmt.Errorf("server.%s must be between %d and %d", name, minimum, maximum)
		}
		return nil
	}
	if cfg.Runtime.MemoryLimitBytes != 0 {
		if err := validateRange("memory_limit_bytes", cfg.Runtime.MemoryLimitBytes, 32<<20, 1<<50); err != nil {
			return err
		}
	}
	for _, setting := range []struct {
		name            string
		value, min, max int64
	}{
		{"max_storage_bytes_per_request", cfg.Runtime.MaxStorageBytesPerRequest, 1 << 20, 1 << 50},
		{"max_storage_requests_per_request", cfg.Runtime.MaxStorageRequestsPerRequest, 1, 10_000_000},
		{"max_temp_bytes_per_session", cfg.Runtime.MaxTempBytesPerSession, 0, 1 << 50},
		{"max_range_cache_bytes", cfg.Runtime.MaxRangeCacheBytes, 1 << 20, 4 << 30},
	} {
		if err := validateRange(setting.name, setting.value, setting.min, setting.max); err != nil {
			return err
		}
	}
	if cfg.Runtime.MaxConcurrentStorageRequests < 1 || cfg.Runtime.MaxConcurrentStorageRequests > 1024 {
		return fmt.Errorf("server.max_concurrent_storage_requests must be between 1 and 1024")
	}
	if cfg.Runtime.MaxConcurrentRequestsPerStore < 1 || cfg.Runtime.MaxConcurrentRequestsPerStore > 256 {
		return fmt.Errorf("server.max_concurrent_requests_per_storage must be between 1 and 256")
	}
	if cfg.Runtime.MaxConcurrentRequestsPerStore > cfg.Runtime.MaxConcurrentStorageRequests {
		return fmt.Errorf("server.max_concurrent_requests_per_storage cannot exceed max_concurrent_storage_requests")
	}
	if cfg.Runtime.SessionTTLSeconds < 30 || cfg.Runtime.SessionTTLSeconds > 7*24*60*60 {
		return fmt.Errorf("server.session_ttl_seconds must be between 30 and 604800")
	}
	if cfg.Runtime.MaxStatsFolders < 100 || cfg.Runtime.MaxStatsFolders > 1_000_000 {
		return fmt.Errorf("server.max_stats_folders must be between 100 and 1000000")
	}
	if cfg.Runtime.MaxArchiveEntries < 1 || cfg.Runtime.MaxArchiveEntries > 1_000_000 {
		return fmt.Errorf("server.max_archive_entries must be between 1 and 1000000")
	}
	return nil
}

var configIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func decodeAuthBlock(block hclBlock, baseDir string) (authConfig, error) {
	if len(block.Labels) != 1 {
		return authConfig{}, block.errorf("auth block requires exactly one quoted identifier")
	}
	allowed := []string{
		"provider", "mode", "endpoint", "region",
		"access_key_id", "access_key_id_file",
		"secret_access_key", "secret_access_key_file",
		"session_token", "session_token_file",
		"credentials_file", "insecure_skip_verify",
	}
	if err := rejectUnknownAttrs(block, allowed...); err != nil {
		return authConfig{}, err
	}
	kinds := make(map[string]hclValueKind, len(allowed))
	for _, name := range allowed {
		kinds[name] = hclString
	}
	kinds["insecure_skip_verify"] = hclBool
	if err := requireAttrKinds(block, kinds); err != nil {
		return authConfig{}, err
	}
	if len(block.Blocks) != 0 {
		return authConfig{}, block.errorf("nested blocks are not supported inside auth")
	}

	auth := authConfig{ID: strings.TrimSpace(block.Labels[0])}
	if !configIDPattern.MatchString(auth.ID) {
		return authConfig{}, block.errorf("auth id %q must match %s", auth.ID, configIDPattern.String())
	}
	for _, field := range []struct {
		name string
		dst  *string
	}{
		{"provider", &auth.Provider},
		{"mode", &auth.Mode},
		{"endpoint", &auth.Endpoint},
		{"region", &auth.Region},
		{"credentials_file", &auth.CredentialsFile},
	} {
		if value, ok := block.stringAttr(field.name); ok {
			*field.dst = value
		}
	}
	if value, ok := block.boolAttr("insecure_skip_verify"); ok {
		auth.InsecureSkipVerify = value
	}
	auth.Provider = strings.ToLower(strings.TrimSpace(auth.Provider))
	auth.Mode = strings.ToLower(strings.TrimSpace(auth.Mode))
	auth.Endpoint = strings.TrimRight(strings.TrimSpace(auth.Endpoint), "/")
	auth.Region = strings.TrimSpace(auth.Region)

	accessKey, accessDefined, err := resolveSecretSource(block, "access_key_id", baseDir)
	if err != nil {
		return authConfig{}, err
	}
	secretAccessKey, secretDefined, err := resolveSecretSource(block, "secret_access_key", baseDir)
	if err != nil {
		return authConfig{}, err
	}
	sessionToken, sessionDefined, err := resolveSecretSource(block, "session_token", baseDir)
	if err != nil {
		return authConfig{}, err
	}
	auth.AccessKeyID = accessKey
	auth.SecretAccessKey = secretAccessKey
	auth.SessionToken = sessionToken

	if auth.Provider == "" {
		return authConfig{}, block.errorf("provider is required")
	}
	switch auth.Provider {
	case "s3":
		if strings.TrimSpace(auth.CredentialsFile) != "" {
			return authConfig{}, block.errorf("credentials_file is only supported for provider gcs")
		}
		if auth.Endpoint == "" {
			return authConfig{}, block.errorf("endpoint is required for provider s3")
		}
		if auth.Region == "" {
			return authConfig{}, block.errorf("region is required for provider s3")
		}
		if auth.Mode == "" {
			if accessDefined || secretDefined || sessionDefined {
				auth.Mode = "access_key"
			} else {
				auth.Mode = "anonymous"
			}
		}
		switch auth.Mode {
		case "access_key":
			if !accessDefined || !secretDefined {
				return authConfig{}, block.errorf("s3 access_key mode requires access_key_id and secret_access_key")
			}
		case "anonymous":
			if accessDefined || secretDefined || sessionDefined {
				return authConfig{}, block.errorf("s3 anonymous mode cannot define access credentials")
			}
		default:
			return authConfig{}, block.errorf("s3 mode must be access_key or anonymous")
		}
	case "gcs":
		if accessDefined || secretDefined || sessionDefined {
			return authConfig{}, block.errorf("S3 credential attributes are only supported for provider s3")
		}
		if auth.Endpoint == "" {
			auth.Endpoint = "https://storage.googleapis.com"
		}
		if auth.Mode == "" {
			if strings.TrimSpace(auth.CredentialsFile) != "" {
				auth.Mode = "service_account"
			} else {
				auth.Mode = "anonymous"
			}
		}
		switch auth.Mode {
		case "service_account":
			if strings.TrimSpace(auth.CredentialsFile) == "" {
				return authConfig{}, block.errorf("gcs service_account mode requires credentials_file")
			}
		case "anonymous":
			if strings.TrimSpace(auth.CredentialsFile) != "" {
				return authConfig{}, block.errorf("gcs anonymous mode cannot define credentials_file")
			}
		default:
			return authConfig{}, block.errorf("gcs mode must be service_account or anonymous")
		}
	default:
		return authConfig{}, block.errorf("provider must be s3 or gcs, got %q", auth.Provider)
	}
	if auth.CredentialsFile != "" && !filepath.IsAbs(auth.CredentialsFile) {
		auth.CredentialsFile = filepath.Join(baseDir, auth.CredentialsFile)
	}
	if auth.CredentialsFile != "" {
		auth.CredentialsFile = filepath.Clean(auth.CredentialsFile)
	}
	if _, err := parseStorageEndpoint(auth.Provider, auth.Endpoint); err != nil {
		return authConfig{}, block.errorf("%v", err)
	}
	return auth, nil
}

func decodeBucketBlock(block hclBlock, authByID map[string]authConfig) (bucketConfig, error) {
	if len(block.Labels) != 1 {
		return bucketConfig{}, block.errorf("bucket block requires exactly one quoted identifier")
	}
	allowed := []string{"name", "auth", "bucket", "permissions", "root_prefix", "max_scan_pages"}
	if err := rejectUnknownAttrs(block, allowed...); err != nil {
		return bucketConfig{}, err
	}
	kinds := map[string]hclValueKind{
		"name": hclString, "auth": hclString, "bucket": hclString,
		"permissions": hclList, "root_prefix": hclString, "max_scan_pages": hclNumber,
	}
	if err := requireAttrKinds(block, kinds); err != nil {
		return bucketConfig{}, err
	}
	if len(block.Blocks) != 0 {
		return bucketConfig{}, block.errorf("nested blocks are not supported inside bucket")
	}

	bucket := bucketConfig{
		ID:           strings.TrimSpace(block.Labels[0]),
		Name:         strings.TrimSpace(block.Labels[0]),
		MaxScanPages: 1,
	}
	if !configIDPattern.MatchString(bucket.ID) {
		return bucketConfig{}, block.errorf("bucket id %q must match %s", bucket.ID, configIDPattern.String())
	}
	if value, ok := block.stringAttr("name"); ok {
		bucket.Name = strings.TrimSpace(value)
	}
	if value, ok := block.stringAttr("auth"); ok {
		bucket.AuthID = strings.TrimSpace(value)
	}
	if value, ok := block.stringAttr("bucket"); ok {
		bucket.Bucket = strings.TrimSpace(value)
	}
	if value, ok := block.stringAttr("root_prefix"); ok {
		bucket.RootPrefix = normalizePrefix(strings.TrimSpace(value))
	}
	if value, ok := block.intAttr("max_scan_pages"); ok {
		if value < 0 || value > 1_000_000 {
			return bucketConfig{}, block.errorf("max_scan_pages must be between 0 and 1000000")
		}
		bucket.MaxScanPages = int(value)
	}
	if values, ok := block.stringListAttr("permissions"); ok {
		bucket.PermissionsDefined = true
		for _, value := range values {
			value = strings.ToLower(strings.TrimSpace(value))
			switch value {
			case permissionRead, permissionWrite, permissionDelete:
				if !containsString(bucket.Permissions, value) {
					bucket.Permissions = append(bucket.Permissions, value)
				}
			default:
				return bucketConfig{}, block.errorf("permissions contains unsupported value %q", value)
			}
		}
	}
	if bucket.Name == "" {
		bucket.Name = bucket.ID
	}
	if bucket.AuthID == "" {
		return bucketConfig{}, block.errorf("auth is required")
	}
	if bucket.Bucket == "" {
		return bucketConfig{}, block.errorf("bucket is required")
	}
	auth, ok := authByID[bucket.AuthID]
	if !ok {
		return bucketConfig{}, block.errorf("auth %q is not defined", bucket.AuthID)
	}
	bucket.Provider = auth.Provider
	bucket.Region = auth.Region
	return bucket, nil
}

func resolveSecretSource(block hclBlock, name, baseDir string) (string, bool, error) {
	direct, directOK := block.stringAttr(name)
	fileName, fileOK := block.stringAttr(name + "_file")
	if !directOK && !fileOK {
		return "", false, nil
	}
	if directOK && fileOK {
		return "", false, block.errorf("only one of %s or %s_file may be defined", name, name)
	}
	var value string
	var source string
	if directOK {
		value = direct
		source = name
	} else {
		fileName = strings.TrimSpace(fileName)
		if fileName == "" {
			return "", false, block.errorf("%s_file cannot be empty", name)
		}
		if !filepath.IsAbs(fileName) {
			fileName = filepath.Join(baseDir, fileName)
		}
		cleaned := filepath.Clean(fileName)
		data, err := readBoundedFile(cleaned, maxSecretFileBytes)
		if err != nil {
			return "", false, block.errorf("read %s_file %q: %v", name, cleaned, err)
		}
		value = string(data)
		source = name + "_file"
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false, block.errorf("%s resolved from %s is empty", name, source)
	}
	return value, true, nil
}

func rejectUnknownAttrs(block hclBlock, allowed ...string) error {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		allowedSet[name] = struct{}{}
	}
	for name, attr := range block.Attrs {
		if _, ok := allowedSet[name]; !ok {
			return fmt.Errorf("line %d:%d: unknown attribute %q in %s block", attr.Line, attr.Column, name, block.Type)
		}
	}
	return nil
}

func requireAttrKinds(block hclBlock, kinds map[string]hclValueKind) error {
	for name, attr := range block.Attrs {
		kind, ok := kinds[name]
		if !ok || attr.Value.Kind == kind {
			continue
		}
		want := map[hclValueKind]string{hclString: "a quoted string", hclBool: "a boolean", hclList: "a string list", hclNumber: "an integer"}[kind]
		return fmt.Errorf("line %d:%d: attribute %q must be %s", attr.Line, attr.Column, name, want)
	}
	return nil
}

func normalizeListenAddress(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("cannot be empty")
	}
	if strings.Contains(value, "://") {
		return "", fmt.Errorf("must be a host:port address, not a URL")
	}
	_, port, err := net.SplitHostPort(value)
	if err != nil {
		return "", fmt.Errorf("must be a valid host:port address: %w", err)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", fmt.Errorf("port must be an integer between 1 and 65535")
	}
	return value, nil
}

func normalizePrefix(value string) string {
	value = strings.TrimLeft(value, "/")
	if value == "" {
		return ""
	}
	return strings.TrimRight(value, "/") + "/"
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// The parser below intentionally supports the small, documented HCL subset used
// by this project: blocks, quoted labels, attributes, strings, integers,
// booleans and string lists. Keeping it local avoids pulling a full HCL dependency into the
// single static binary.

type hclValueKind int

const (
	hclString hclValueKind = iota
	hclBool
	hclList
	hclNumber
)

type hclValue struct {
	Kind   hclValueKind
	String string
	Bool   bool
	List   []hclValue
	Number int64
	Line   int
	Column int
}

type hclAttr struct {
	Name   string
	Value  hclValue
	Line   int
	Column int
}

type hclBlock struct {
	Type   string
	Labels []string
	Attrs  map[string]hclAttr
	Blocks []hclBlock
	Line   int
	Column int
}

func (b hclBlock) errorf(format string, args ...any) error {
	return fmt.Errorf("line %d:%d: %s", b.Line, b.Column, fmt.Sprintf(format, args...))
}

func (b hclBlock) stringAttr(name string) (string, bool) {
	attr, ok := b.Attrs[name]
	if !ok {
		return "", false
	}
	if attr.Value.Kind != hclString {
		return "", false
	}
	return attr.Value.String, true
}

func (b hclBlock) boolAttr(name string) (bool, bool) {
	attr, ok := b.Attrs[name]
	if !ok || attr.Value.Kind != hclBool {
		return false, false
	}
	return attr.Value.Bool, true
}

func (b hclBlock) intAttr(name string) (int64, bool) {
	attr, ok := b.Attrs[name]
	if !ok || attr.Value.Kind != hclNumber {
		return 0, false
	}
	return attr.Value.Number, true
}

func (b hclBlock) stringListAttr(name string) ([]string, bool) {
	attr, ok := b.Attrs[name]
	if !ok || attr.Value.Kind != hclList {
		return nil, false
	}
	out := make([]string, 0, len(attr.Value.List))
	for _, value := range attr.Value.List {
		if value.Kind != hclString {
			return nil, false
		}
		out = append(out, value.String)
	}
	return out, true
}

type hclTokenKind int

const (
	tokenEOF hclTokenKind = iota
	tokenIdent
	tokenString
	tokenNumber
	tokenLBrace
	tokenRBrace
	tokenLBracket
	tokenRBracket
	tokenEqual
	tokenComma
)

type hclToken struct {
	Kind   hclTokenKind
	Text   string
	Line   int
	Column int
}

type hclLexer struct {
	source string
	pos    int
	line   int
	column int
}

func newHCLLexer(source string) *hclLexer {
	return &hclLexer{source: source, line: 1, column: 1}
}

func (l *hclLexer) nextToken() (hclToken, error) {
	if err := l.skipSpaceAndComments(); err != nil {
		return hclToken{}, err
	}
	if l.pos >= len(l.source) {
		return hclToken{Kind: tokenEOF, Line: l.line, Column: l.column}, nil
	}
	line, column := l.line, l.column
	ch := l.source[l.pos]
	switch ch {
	case '{':
		l.advanceByte()
		return hclToken{Kind: tokenLBrace, Text: "{", Line: line, Column: column}, nil
	case '}':
		l.advanceByte()
		return hclToken{Kind: tokenRBrace, Text: "}", Line: line, Column: column}, nil
	case '[':
		l.advanceByte()
		return hclToken{Kind: tokenLBracket, Text: "[", Line: line, Column: column}, nil
	case ']':
		l.advanceByte()
		return hclToken{Kind: tokenRBracket, Text: "]", Line: line, Column: column}, nil
	case '=':
		l.advanceByte()
		return hclToken{Kind: tokenEqual, Text: "=", Line: line, Column: column}, nil
	case ',':
		l.advanceByte()
		return hclToken{Kind: tokenComma, Text: ",", Line: line, Column: column}, nil
	case '"':
		return l.scanString()
	default:
		if ch >= '0' && ch <= '9' {
			start := l.pos
			for l.pos < len(l.source) && l.source[l.pos] >= '0' && l.source[l.pos] <= '9' {
				l.advanceByte()
			}
			return hclToken{Kind: tokenNumber, Text: l.source[start:l.pos], Line: line, Column: column}, nil
		}
		if isIdentStart(rune(ch)) {
			start := l.pos
			for l.pos < len(l.source) && isIdentPart(rune(l.source[l.pos])) {
				l.advanceByte()
			}
			return hclToken{Kind: tokenIdent, Text: l.source[start:l.pos], Line: line, Column: column}, nil
		}
		return hclToken{}, fmt.Errorf("line %d:%d: unexpected character %q", line, column, ch)
	}
}

func (l *hclLexer) skipSpaceAndComments() error {
	for l.pos < len(l.source) {
		ch := l.source[l.pos]
		if unicode.IsSpace(rune(ch)) {
			l.advanceByte()
			continue
		}
		if ch == '#' {
			l.skipLine()
			continue
		}
		if ch == '/' && l.pos+1 < len(l.source) {
			next := l.source[l.pos+1]
			if next == '/' {
				l.skipLine()
				continue
			}
			if next == '*' {
				startLine, startColumn := l.line, l.column
				l.advanceByte()
				l.advanceByte()
				for l.pos+1 < len(l.source) && !(l.source[l.pos] == '*' && l.source[l.pos+1] == '/') {
					l.advanceByte()
				}
				if l.pos+1 >= len(l.source) {
					return fmt.Errorf("line %d:%d: unterminated block comment", startLine, startColumn)
				}
				l.advanceByte()
				l.advanceByte()
				continue
			}
		}
		break
	}
	return nil
}

func (l *hclLexer) skipLine() {
	for l.pos < len(l.source) {
		ch := l.source[l.pos]
		l.advanceByte()
		if ch == '\n' {
			return
		}
	}
}

func (l *hclLexer) scanString() (hclToken, error) {
	line, column := l.line, l.column
	start := l.pos
	l.advanceByte()
	for l.pos < len(l.source) {
		ch := l.source[l.pos]
		if ch == '\n' || ch == '\r' {
			return hclToken{}, fmt.Errorf("line %d:%d: quoted strings cannot contain a raw newline", line, column)
		}
		if ch == '\\' {
			l.advanceByte()
			if l.pos >= len(l.source) {
				break
			}
			l.advanceByte()
			continue
		}
		l.advanceByte()
		if ch == '"' {
			raw := l.source[start:l.pos]
			value, err := strconv.Unquote(raw)
			if err != nil {
				return hclToken{}, fmt.Errorf("line %d:%d: invalid string: %w", line, column, err)
			}
			return hclToken{Kind: tokenString, Text: value, Line: line, Column: column}, nil
		}
	}
	return hclToken{}, fmt.Errorf("line %d:%d: unterminated string", line, column)
}

func (l *hclLexer) advanceByte() {
	if l.pos >= len(l.source) {
		return
	}
	if l.source[l.pos] == '\n' {
		l.line++
		l.column = 1
	} else {
		l.column++
	}
	l.pos++
}

func isIdentStart(r rune) bool {
	return unicode.IsLetter(r) || r == '_'
}

func isIdentPart(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'
}

type hclParser struct {
	lexer  *hclLexer
	peeked *hclToken
}

func parseHCLSubset(source string) (hclBlock, error) {
	p := &hclParser{lexer: newHCLLexer(source)}
	root := hclBlock{Type: "root", Attrs: map[string]hclAttr{}, Line: 1, Column: 1}
	if err := p.parseBody(&root, false); err != nil {
		return hclBlock{}, err
	}
	return root, nil
}

func (p *hclParser) parseBody(target *hclBlock, stopAtBrace bool) error {
	for {
		tok, err := p.peek()
		if err != nil {
			return err
		}
		if tok.Kind == tokenEOF {
			if stopAtBrace {
				return fmt.Errorf("line %d:%d: expected closing brace", target.Line, target.Column)
			}
			return nil
		}
		if tok.Kind == tokenRBrace {
			if !stopAtBrace {
				return fmt.Errorf("line %d:%d: unexpected closing brace", tok.Line, tok.Column)
			}
			_, _ = p.next()
			return nil
		}
		if tok.Kind != tokenIdent {
			return fmt.Errorf("line %d:%d: expected attribute or block name", tok.Line, tok.Column)
		}
		name, _ := p.next()
		next, err := p.peek()
		if err != nil {
			return err
		}
		if next.Kind == tokenEqual {
			_, _ = p.next()
			value, err := p.parseValue()
			if err != nil {
				return err
			}
			if _, exists := target.Attrs[name.Text]; exists {
				return fmt.Errorf("line %d:%d: duplicate attribute %q", name.Line, name.Column, name.Text)
			}
			target.Attrs[name.Text] = hclAttr{Name: name.Text, Value: value, Line: name.Line, Column: name.Column}
			continue
		}

		block := hclBlock{Type: name.Text, Attrs: map[string]hclAttr{}, Line: name.Line, Column: name.Column}
		for next.Kind == tokenString || next.Kind == tokenIdent {
			label, _ := p.next()
			block.Labels = append(block.Labels, label.Text)
			next, err = p.peek()
			if err != nil {
				return err
			}
		}
		if next.Kind != tokenLBrace {
			return fmt.Errorf("line %d:%d: expected '=' or '{' after %q", next.Line, next.Column, name.Text)
		}
		_, _ = p.next()
		if err := p.parseBody(&block, true); err != nil {
			return err
		}
		target.Blocks = append(target.Blocks, block)
	}
}

func (p *hclParser) parseValue() (hclValue, error) {
	tok, err := p.next()
	if err != nil {
		return hclValue{}, err
	}
	switch tok.Kind {
	case tokenString:
		return hclValue{Kind: hclString, String: tok.Text, Line: tok.Line, Column: tok.Column}, nil
	case tokenNumber:
		value, parseErr := strconv.ParseInt(tok.Text, 10, 64)
		if parseErr != nil {
			return hclValue{}, fmt.Errorf("line %d:%d: invalid integer %q", tok.Line, tok.Column, tok.Text)
		}
		return hclValue{Kind: hclNumber, Number: value, Line: tok.Line, Column: tok.Column}, nil
	case tokenIdent:
		switch tok.Text {
		case "true":
			return hclValue{Kind: hclBool, Bool: true, Line: tok.Line, Column: tok.Column}, nil
		case "false":
			return hclValue{Kind: hclBool, Bool: false, Line: tok.Line, Column: tok.Column}, nil
		default:
			return hclValue{}, fmt.Errorf("line %d:%d: bare value %q is not supported; quote strings", tok.Line, tok.Column, tok.Text)
		}
	case tokenLBracket:
		list := hclValue{Kind: hclList, Line: tok.Line, Column: tok.Column}
		for {
			next, err := p.peek()
			if err != nil {
				return hclValue{}, err
			}
			if next.Kind == tokenRBracket {
				_, _ = p.next()
				return list, nil
			}
			value, err := p.parseValue()
			if err != nil {
				return hclValue{}, err
			}
			if value.Kind != hclString {
				return hclValue{}, fmt.Errorf("line %d:%d: lists may only contain strings", value.Line, value.Column)
			}
			list.List = append(list.List, value)
			next, err = p.peek()
			if err != nil {
				return hclValue{}, err
			}
			if next.Kind == tokenComma {
				_, _ = p.next()
				continue
			}
			if next.Kind != tokenRBracket {
				return hclValue{}, fmt.Errorf("line %d:%d: expected ',' or ']'", next.Line, next.Column)
			}
		}
	default:
		return hclValue{}, fmt.Errorf("line %d:%d: expected a value", tok.Line, tok.Column)
	}
}

func (p *hclParser) peek() (hclToken, error) {
	if p.peeked != nil {
		return *p.peeked, nil
	}
	tok, err := p.lexer.nextToken()
	if err != nil {
		return hclToken{}, err
	}
	p.peeked = &tok
	return tok, nil
}

func (p *hclParser) next() (hclToken, error) {
	if p.peeked != nil {
		tok := *p.peeked
		p.peeked = nil
		return tok, nil
	}
	return p.lexer.nextToken()
}
