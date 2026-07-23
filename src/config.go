package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const (
	configFileEnvironment = "S3_BROWSER_CONFIG_FILE"
	configHCLEnvironment  = "S3_BROWSER_CONFIG_HCL"
)

type appConfig struct {
	Listen     string
	DataDir    string
	Storages   []storageConfig
	SourceDir  string
	SourceName string
}

type storageConfig struct {
	ID                 string
	Name               string
	Provider           string
	Bucket             string
	Endpoint           string
	Region             string
	Auth               string
	AccessKeyID        string
	SecretAccessKey    string
	SessionToken       string
	CredentialsFile    string
	Permissions        []string
	PermissionsDefined bool
	RootPrefix         string
	TrashPrefix        string
	InsecureSkipVerify bool
}

func loadConfig(filename string) (appConfig, error) {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return appConfig{}, fmt.Errorf("configuration path cannot be empty")
	}
	abs, err := filepath.Abs(filename)
	if err != nil {
		return appConfig{}, fmt.Errorf("resolve config path: %w", err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return appConfig{}, fmt.Errorf("read config %q: %w", abs, err)
	}
	return decodeConfig(string(data), abs, filepath.Dir(abs))
}

func loadRuntimeConfig(configPath string) (appConfig, error) {
	configPath = strings.TrimSpace(configPath)
	if configPath == "" {
		configPath = strings.TrimSpace(os.Getenv(configFileEnvironment))
	}
	if configPath != "" {
		return loadConfig(configPath)
	}

	source := strings.TrimSpace(os.Getenv(configHCLEnvironment))
	if source == "" {
		return appConfig{}, fmt.Errorf(
			"configuration is required: pass -c <path>, set %s, or set %s",
			configFileEnvironment,
			configHCLEnvironment,
		)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		return appConfig{}, fmt.Errorf("resolve working directory for inline HCL: %w", err)
	}
	return decodeConfig(source, configHCLEnvironment, workingDirectory)
}

func configSourceConfigured(configPath string) bool {
	return strings.TrimSpace(configPath) != "" ||
		strings.TrimSpace(os.Getenv(configFileEnvironment)) != "" ||
		strings.TrimSpace(os.Getenv(configHCLEnvironment)) != ""
}

func decodeConfig(data, sourceName, sourceDir string) (appConfig, error) {
	root, err := parseHCLSubset(data)
	if err != nil {
		return appConfig{}, fmt.Errorf("parse config %q: %w", sourceName, err)
	}

	cfg := appConfig{
		Listen:     ":8080",
		DataDir:    filepath.Join(sourceDir, ".s3-browser-data"),
		SourceDir:  sourceDir,
		SourceName: sourceName,
	}

	var serverSeen bool
	ids := make(map[string]struct{})
	for _, block := range root.Blocks {
		switch block.Type {
		case "server":
			if serverSeen {
				return appConfig{}, fmt.Errorf("only one server block is allowed")
			}
			serverSeen = true
			if len(block.Labels) != 0 {
				return appConfig{}, block.errorf("server block does not accept labels")
			}
			if err := rejectUnknownAttrs(block, "listen", "data_dir"); err != nil {
				return appConfig{}, err
			}
			if err := requireAttrKinds(block, map[string]hclValueKind{"listen": hclString, "data_dir": hclString}); err != nil {
				return appConfig{}, err
			}
			if value, ok := block.stringAttr("listen"); ok {
				cfg.Listen = strings.TrimSpace(value)
			}
			if value, ok := block.stringAttr("data_dir"); ok {
				value = strings.TrimSpace(value)
				if value == "" {
					return appConfig{}, block.errorf("server.data_dir cannot be empty")
				}
				if !filepath.IsAbs(value) {
					value = filepath.Join(sourceDir, value)
				}
				cfg.DataDir = filepath.Clean(value)
			}
		case "storage":
			if len(block.Labels) != 1 {
				return appConfig{}, block.errorf("storage block requires exactly one quoted identifier")
			}
			storage, err := decodeStorageBlock(block, cfg.SourceDir)
			if err != nil {
				return appConfig{}, err
			}
			if _, exists := ids[storage.ID]; exists {
				return appConfig{}, block.errorf("duplicate storage id %q", storage.ID)
			}
			ids[storage.ID] = struct{}{}
			cfg.Storages = append(cfg.Storages, storage)
		default:
			return appConfig{}, block.errorf("unknown block type %q", block.Type)
		}
	}
	if len(root.Attrs) != 0 {
		for name, attr := range root.Attrs {
			return appConfig{}, fmt.Errorf("line %d:%d: root attribute %q is not supported; use a server block", attr.Line, attr.Column, name)
		}
	}
	if len(cfg.Storages) == 0 {
		return appConfig{}, fmt.Errorf("at least one storage block is required")
	}
	if cfg.Listen == "" {
		return appConfig{}, fmt.Errorf("server.listen cannot be empty")
	}
	return cfg, nil
}

var storageIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func decodeStorageBlock(block hclBlock, baseDir string) (storageConfig, error) {
	allowed := []string{
		"name", "provider", "bucket", "endpoint", "region", "auth",
		"access_key_id", "access_key_id_env", "access_key_id_file",
		"secret_access_key", "secret_access_key_env", "secret_access_key_file",
		"secret_key", "secret_key_env", "secret_key_file",
		"session_token", "session_token_env", "session_token_file",
		"credentials_file", "permissions", "root_prefix", "trash_prefix", "insecure_skip_verify",
	}
	if err := rejectUnknownAttrs(block, allowed...); err != nil {
		return storageConfig{}, err
	}
	kinds := make(map[string]hclValueKind, len(allowed))
	for _, name := range allowed {
		kinds[name] = hclString
	}
	kinds["permissions"] = hclList
	kinds["insecure_skip_verify"] = hclBool
	if err := requireAttrKinds(block, kinds); err != nil {
		return storageConfig{}, err
	}
	if len(block.Blocks) != 0 {
		return storageConfig{}, block.errorf("nested blocks are not supported inside storage")
	}

	storage := storageConfig{
		ID:          strings.TrimSpace(block.Labels[0]),
		Name:        strings.TrimSpace(block.Labels[0]),
		TrashPrefix: "_trash/",
	}
	if !storageIDPattern.MatchString(storage.ID) {
		return storageConfig{}, block.errorf("storage id %q must match %s", storage.ID, storageIDPattern.String())
	}

	for _, field := range []struct {
		name string
		dst  *string
	}{
		{"name", &storage.Name},
		{"provider", &storage.Provider},
		{"bucket", &storage.Bucket},
		{"endpoint", &storage.Endpoint},
		{"region", &storage.Region},
		{"auth", &storage.Auth},
		{"credentials_file", &storage.CredentialsFile},
		{"root_prefix", &storage.RootPrefix},
		{"trash_prefix", &storage.TrashPrefix},
	} {
		if value, ok := block.stringAttr(field.name); ok {
			*field.dst = value
		}
	}
	if value, ok := block.boolAttr("insecure_skip_verify"); ok {
		storage.InsecureSkipVerify = value
	}
	if values, ok := block.stringListAttr("permissions"); ok {
		storage.PermissionsDefined = true
		for _, value := range values {
			value = strings.ToLower(strings.TrimSpace(value))
			switch value {
			case permissionRead, permissionWrite, permissionDelete:
				if !containsString(storage.Permissions, value) {
					storage.Permissions = append(storage.Permissions, value)
				}
			default:
				return storageConfig{}, block.errorf("permissions contains unsupported value %q", value)
			}
		}
	}

	storage.Name = strings.TrimSpace(storage.Name)
	storage.Provider = strings.ToLower(strings.TrimSpace(storage.Provider))
	storage.Bucket = strings.TrimSpace(storage.Bucket)
	storage.Endpoint = strings.TrimRight(strings.TrimSpace(storage.Endpoint), "/")
	storage.Region = strings.TrimSpace(storage.Region)
	storage.Auth = strings.ToLower(strings.TrimSpace(storage.Auth))
	storage.RootPrefix = normalizePrefix(strings.TrimSpace(storage.RootPrefix))
	storage.TrashPrefix = normalizePrefix(strings.TrimSpace(storage.TrashPrefix))

	if storage.Name == "" {
		storage.Name = storage.ID
	}
	if storage.Provider == "" {
		return storageConfig{}, block.errorf("provider is required")
	}
	if storage.Bucket == "" {
		return storageConfig{}, block.errorf("bucket is required")
	}

	switch storage.Provider {
	case "s3":
		if storage.CredentialsFile != "" {
			return storageConfig{}, block.errorf("credentials_file is only supported for provider gcs")
		}
		if storage.Endpoint == "" {
			return storageConfig{}, block.errorf("endpoint is required for provider s3")
		}
		if storage.Region == "" {
			return storageConfig{}, block.errorf("region is required for provider s3")
		}

		accessKey, accessDefined, err := resolveSecretSource(block, "access_key_id", baseDir)
		if err != nil {
			return storageConfig{}, err
		}
		secretAccessKey, secretDefined, err := resolveSecretAliases(block, "secret_access_key", "secret_key", baseDir)
		if err != nil {
			return storageConfig{}, err
		}
		sessionToken, sessionDefined, err := resolveSecretSource(block, "session_token", baseDir)
		if err != nil {
			return storageConfig{}, err
		}
		storage.AccessKeyID = accessKey
		storage.SecretAccessKey = secretAccessKey
		storage.SessionToken = sessionToken

		if storage.Auth == "" {
			if accessDefined || secretDefined || sessionDefined {
				storage.Auth = "access_key"
			} else {
				storage.Auth = "anonymous"
			}
		}
		if storage.Auth != "access_key" && storage.Auth != "anonymous" {
			return storageConfig{}, block.errorf("s3 auth must be access_key or anonymous")
		}
		if storage.Auth == "access_key" {
			if !accessDefined || !secretDefined {
				return storageConfig{}, block.errorf("s3 access_key auth requires exactly one source for access_key_id and secret_access_key")
			}
		} else if accessDefined || secretDefined || sessionDefined {
			return storageConfig{}, block.errorf("s3 anonymous auth cannot define access credentials")
		}
		if !storage.PermissionsDefined {
			storage.PermissionsDefined = true
			storage.Permissions = []string{permissionRead}
		}
	case "gcs":
		if hasAnyS3SecretAttribute(block) {
			return storageConfig{}, block.errorf("S3 credential attributes are only supported for provider s3")
		}
		if storage.Endpoint == "" {
			storage.Endpoint = "https://storage.googleapis.com"
		}
		if storage.Auth == "" {
			if storage.CredentialsFile != "" {
				storage.Auth = "service_account"
			} else {
				storage.Auth = "anonymous"
			}
		}
		if storage.Auth != "service_account" && storage.Auth != "anonymous" {
			return storageConfig{}, block.errorf("gcs auth must be service_account or anonymous")
		}
		if storage.Auth == "service_account" && storage.CredentialsFile == "" {
			return storageConfig{}, block.errorf("gcs service_account auth requires credentials_file")
		}
		if storage.Auth == "anonymous" && storage.CredentialsFile != "" {
			return storageConfig{}, block.errorf("gcs anonymous auth cannot define credentials_file")
		}
	default:
		return storageConfig{}, block.errorf("provider must be s3 or gcs, got %q", storage.Provider)
	}

	if storage.CredentialsFile != "" && !filepath.IsAbs(storage.CredentialsFile) {
		storage.CredentialsFile = filepath.Join(baseDir, storage.CredentialsFile)
	}
	if storage.CredentialsFile != "" {
		storage.CredentialsFile = filepath.Clean(storage.CredentialsFile)
	}
	return storage, nil
}

func resolveSecretAliases(block hclBlock, primary, alias, baseDir string) (string, bool, error) {
	primaryCount := secretSourceCount(block, primary)
	aliasCount := secretSourceCount(block, alias)
	if primaryCount > 0 && aliasCount > 0 {
		return "", false, block.errorf("use either %s or %s credential fields, not both", primary, alias)
	}
	if aliasCount > 0 {
		return resolveSecretSource(block, alias, baseDir)
	}
	return resolveSecretSource(block, primary, baseDir)
}

func resolveSecretSource(block hclBlock, name, baseDir string) (string, bool, error) {
	direct, directOK := block.stringAttr(name)
	envName, envOK := block.stringAttr(name + "_env")
	fileName, fileOK := block.stringAttr(name + "_file")
	count := 0
	for _, defined := range []bool{directOK, envOK, fileOK} {
		if defined {
			count++
		}
	}
	if count == 0 {
		return "", false, nil
	}
	if count != 1 {
		return "", false, block.errorf("only one of %s, %s_env, or %s_file may be defined", name, name, name)
	}

	var value string
	var source string
	switch {
	case directOK:
		value = direct
		source = name
	case envOK:
		envName = strings.TrimSpace(envName)
		if envName == "" {
			return "", false, block.errorf("%s_env cannot be empty", name)
		}
		var exists bool
		value, exists = os.LookupEnv(envName)
		if !exists {
			return "", false, block.errorf("environment variable %q referenced by %s_env is not set", envName, name)
		}
		source = name + "_env"
	case fileOK:
		fileName = strings.TrimSpace(fileName)
		if fileName == "" {
			return "", false, block.errorf("%s_file cannot be empty", name)
		}
		if !filepath.IsAbs(fileName) {
			fileName = filepath.Join(baseDir, fileName)
		}
		data, err := os.ReadFile(filepath.Clean(fileName))
		if err != nil {
			return "", false, block.errorf("read %s_file %q: %v", name, filepath.Clean(fileName), err)
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

func secretSourceCount(block hclBlock, name string) int {
	count := 0
	for _, candidate := range []string{name, name + "_env", name + "_file"} {
		if _, ok := block.Attrs[candidate]; ok {
			count++
		}
	}
	return count
}

func hasAnyS3SecretAttribute(block hclBlock) bool {
	for _, base := range []string{"access_key_id", "secret_access_key", "secret_key", "session_token"} {
		if secretSourceCount(block, base) > 0 {
			return true
		}
	}
	return false
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
		want := map[hclValueKind]string{hclString: "a quoted string", hclBool: "a boolean", hclList: "a string list"}[kind]
		return fmt.Errorf("line %d:%d: attribute %q must be %s", attr.Line, attr.Column, name, want)
	}
	return nil
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
// by this project: blocks, quoted labels, attributes, strings, booleans and
// string lists. Keeping it local avoids pulling a full HCL dependency into the
// single static binary.

type hclValueKind int

const (
	hclString hclValueKind = iota
	hclBool
	hclList
)

type hclValue struct {
	Kind   hclValueKind
	String string
	Bool   bool
	List   []hclValue
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
