package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	accessModeOpen    = "open"
	accessModeAuthZEN = "authzen"

	defaultIdentityHeader    = "X-Identity-Token"
	defaultIdentityMaxAge    = 5 * time.Minute
	defaultPDPTimeout        = 500 * time.Millisecond
	defaultPDPCacheTTL       = 30 * time.Second
	defaultPDPMaxEvaluations = 64

	maxIdentityKeys    = 16
	maxAccessIDBytes   = 256
	maxIssuerBytes     = 1024
	maxPDPTokenBytes   = 4096
	maxIdentityHeader  = 64
	maxPDPEvaluations  = 1024
	openModeServerName = "s3-browser"
)

// accessConfig is the typed form of the access block (docs/ACCESS.md).
type accessConfig struct {
	Mode              string
	Header            string
	Issuer            string
	Audience          string
	Keys              []identityKey
	MaxAge            time.Duration
	PDPURL            string
	PDPToken          string
	PDPTimeout        time.Duration
	PDPCacheTTL       time.Duration
	PDPMaxEvaluations int
}

// enforced tells if the server checks the identity and asks the PDP.
func (c accessConfig) enforced() bool { return c.Mode == accessModeAuthZEN }

// serverName is the id of the service resource and the server of the list of actions.
func (c accessConfig) serverName() string {
	if c.enforced() {
		return c.Audience
	}
	return openModeServerName
}

// identityKey is one public key of the issuer of the identity tokens.
type identityKey struct {
	Ed25519 ed25519.PublicKey
	P256    *ecdsa.PublicKey
	KID     string
}

func (k identityKey) algorithm() string {
	if k.Ed25519 != nil {
		return "EdDSA"
	}
	return "ES256"
}

func (k identityKey) typeName() string {
	if k.Ed25519 != nil {
		return "Ed25519"
	}
	return "P-256"
}

func identityKeyNames(keys []identityKey) []string {
	names := make([]string, 0, len(keys))
	for _, key := range keys {
		names = append(names, key.typeName()+" kid="+key.KID)
	}
	return names
}

// decodeAccessBlock reads the access block and its identity and pdp blocks.
func decodeAccessBlock(block hclBlock, cfg *appConfig, baseDir string) error {
	if len(block.Labels) != 0 {
		return block.errorf("access block does not accept labels")
	}
	if err := rejectUnknownAttrs(block, attributeNames("access")...); err != nil {
		return err
	}
	if err := requireAttrKinds(block, map[string]hclValueKind{"mode": hclString}); err != nil {
		return err
	}
	recordSources(cfg, "access", "access", block, baseDir)
	mode, ok := block.stringAttr("mode")
	if !ok {
		return block.errorf("access.mode is required: \"authzen\" or \"open\"")
	}
	if mode != accessModeAuthZEN && mode != accessModeOpen {
		return block.errorf("access.mode must be \"authzen\" or \"open\", got %q", mode)
	}
	access := accessConfig{Mode: mode}

	var identityBlock, pdpBlock *hclBlock
	for index := range block.Blocks {
		nested := &block.Blocks[index]
		switch nested.Type {
		case "identity":
			if identityBlock != nil {
				return nested.errorf("only one access.identity block is allowed")
			}
			identityBlock = nested
		case "pdp":
			if pdpBlock != nil {
				return nested.errorf("only one access.pdp block is allowed")
			}
			pdpBlock = nested
		default:
			return nested.errorf("unknown block %q in access; the blocks are identity and pdp", nested.Type)
		}
	}
	if mode == accessModeOpen {
		if identityBlock != nil || pdpBlock != nil {
			return block.errorf("access.mode = \"open\" contradicts an identity block or a pdp block; remove them or use mode = \"authzen\"")
		}
		cfg.Access = access
		return nil
	}
	if identityBlock == nil {
		return block.errorf("access.mode = \"authzen\" requires the access.identity block")
	}
	if pdpBlock == nil {
		return block.errorf("access.mode = \"authzen\" requires the access.pdp block")
	}
	if err := decodeIdentityBlock(*identityBlock, cfg, &access, baseDir); err != nil {
		return err
	}
	if err := decodePDPBlock(*pdpBlock, cfg, &access, baseDir); err != nil {
		return err
	}
	cfg.Access = access
	return nil
}

func decodeIdentityBlock(block hclBlock, cfg *appConfig, access *accessConfig, baseDir string) error {
	const path = "access.identity"
	if len(block.Labels) != 0 {
		return block.errorf("%s block does not accept labels", path)
	}
	if len(block.Blocks) != 0 {
		return block.errorf("nested blocks are not supported inside %s", path)
	}
	if err := rejectUnknownAttrs(block, attributeNames(path)...); err != nil {
		return err
	}
	if err := requireStringAttrs(block); err != nil {
		return err
	}
	recordSources(cfg, path, path, block, baseDir)

	access.Header = defaultIdentityHeader
	if value, ok := block.stringAttr("header"); ok {
		if err := validateIdentityHeader(value); err != nil {
			return block.errorf("%s.header: %v, got %q", path, err, value)
		}
		access.Header = value
	}
	issuer, ok := block.stringAttr("issuer")
	if !ok {
		return block.errorf("%s.issuer is required", path)
	}
	if issuer == "" || len(issuer) > maxIssuerBytes || !utf8.ValidString(issuer) || hasControlCharacter(issuer) {
		return block.errorf("%s.issuer must have 1 to %d bytes of UTF-8 without a control character, got %q", path, maxIssuerBytes, issuer)
	}
	access.Issuer = issuer
	audience, ok := block.stringAttr("audience")
	if !ok {
		return block.errorf("%s.audience is required: the id of this server at the access gateway", path)
	}
	if !validAccessID(audience) {
		return block.errorf("%s.audience must have 1 to %d bytes of UTF-8 without a control character, got %q", path, maxAccessIDBytes, audience)
	}
	access.Audience = audience

	pemText, defined, err := resolveValueSource(block, path, "public_keys", baseDir, formValue|formEnv|formFile)
	if err != nil {
		return err
	}
	if !defined {
		return block.errorf("%s.public_keys is required: give public_keys, public_keys_env or public_keys_file", path)
	}
	keys, err := parseIdentityPublicKeys(pemText)
	if err != nil {
		return block.errorf("%s.public_keys: %v", path, err)
	}
	access.Keys = keys

	access.MaxAge, err = parseConfigDuration(block, path, "max_age", defaultIdentityMaxAge, time.Second, 24*time.Hour)
	return err
}

func decodePDPBlock(block hclBlock, cfg *appConfig, access *accessConfig, baseDir string) error {
	const path = "access.pdp"
	if len(block.Labels) != 0 {
		return block.errorf("%s block does not accept labels", path)
	}
	if len(block.Blocks) != 0 {
		return block.errorf("nested blocks are not supported inside %s", path)
	}
	if _, ok := block.Attrs["token"]; ok {
		return block.errorf("%s.token is a secret: use token_env or token_file, not the value in clear text", path)
	}
	if err := rejectUnknownAttrs(block, attributeNames(path)...); err != nil {
		return err
	}
	kinds := map[string]hclValueKind{"max_evaluations": hclNumber}
	for _, name := range attributeNames(path) {
		if _, ok := kinds[name]; !ok {
			kinds[name] = hclString
		}
	}
	if err := requireAttrKinds(block, kinds); err != nil {
		return err
	}
	recordSources(cfg, path, path, block, baseDir)

	rawURL, defined, err := resolveValueSource(block, path, "url", baseDir, formValue|formEnv|formFile)
	if err != nil {
		return err
	}
	if !defined {
		return block.errorf("%s.url is required: give url, url_env or url_file", path)
	}
	if err := validatePDPURL(rawURL); err != nil {
		return block.errorf("%s.url: %v, got %q", path, err, rawURL)
	}
	access.PDPURL = strings.TrimRight(rawURL, "/")

	token, defined, err := resolveValueSource(block, path, "token", baseDir, formEnv|formFile)
	if err != nil {
		return err
	}
	if !defined {
		return block.errorf("%s.token is required: give token_env or token_file", path)
	}
	if len(token) > maxPDPTokenBytes || strings.ContainsFunc(token, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
		// The error never shows the token.
		return block.errorf("%s.token must have 1 to %d bytes without a space or a control character", path, maxPDPTokenBytes)
	}
	access.PDPToken = token

	if access.PDPTimeout, err = parseConfigDuration(block, path, "timeout", defaultPDPTimeout, 10*time.Millisecond, time.Minute); err != nil {
		return err
	}
	if access.PDPCacheTTL, err = parseConfigDuration(block, path, "cache_ttl", defaultPDPCacheTTL, 0, time.Hour); err != nil {
		return err
	}
	access.PDPMaxEvaluations = defaultPDPMaxEvaluations
	if value, ok := block.intAttr("max_evaluations"); ok {
		if value < 1 || value > maxPDPEvaluations {
			return block.errorf("%s.max_evaluations must be from 1 to %d, got %d", path, maxPDPEvaluations, value)
		}
		access.PDPMaxEvaluations = int(value)
	}
	return nil
}

// requireStringAttrs makes sure that each attribute of the block is a text.
func requireStringAttrs(block hclBlock) error {
	kinds := make(map[string]hclValueKind, len(block.Attrs))
	for name := range block.Attrs {
		kinds[name] = hclString
	}
	return requireAttrKinds(block, kinds)
}

func validateIdentityHeader(value string) error {
	if value == "" || len(value) > maxIdentityHeader {
		return fmt.Errorf("must have 1 to %d characters", maxIdentityHeader)
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return fmt.Errorf("must contain only letters, digits and '-'")
		}
	}
	switch http.CanonicalHeaderKey(value) {
	case "Cookie", "Authorization", "Host", "Content-Type", "Content-Length":
		return fmt.Errorf("cannot be Cookie, Authorization, Host, Content-Type or Content-Length")
	}
	return nil
}

func validatePDPURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("is not a URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("must use http or https")
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return fmt.Errorf("must have a host")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return fmt.Errorf("must not contain credentials, a query or a fragment")
	}
	return nil
}

// validAccessID tells if a value can be the id of a resource of the access
// policy: 1 to 256 bytes of UTF-8 without a control character (contract 11.5).
func validAccessID(value string) bool {
	return value != "" && len(value) <= maxAccessIDBytes && utf8.ValidString(value) && !hasControlCharacter(value)
}

func hasControlCharacter(value string) bool {
	for _, r := range value {
		if r < 0x20 || (r >= 0x7f && r < 0xa0) {
			return true
		}
	}
	return false
}

// parseIdentityPublicKeys reads 1 to 16 PEM blocks "PUBLIC KEY". Each key is
// Ed25519 or P-256. Any other text stops the start.
func parseIdentityPublicKeys(text string) ([]identityKey, error) {
	rest := []byte(text)
	keys := make([]identityKey, 0, 2)
	for {
		if strings.TrimSpace(string(rest)) == "" {
			break
		}
		block, remaining := pem.Decode(rest)
		if block == nil {
			return nil, fmt.Errorf("key %d is not a PEM block (only -----BEGIN PUBLIC KEY----- blocks are accepted)", len(keys)+1)
		}
		if block.Type != "PUBLIC KEY" || len(block.Headers) != 0 {
			return nil, fmt.Errorf("key %d is a PEM block %q; only PUBLIC KEY blocks are accepted", len(keys)+1, block.Type)
		}
		if len(keys) == maxIdentityKeys {
			return nil, fmt.Errorf("more than %d keys", maxIdentityKeys)
		}
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("key %d is not a valid public key: %v", len(keys)+1, err)
		}
		switch key := parsed.(type) {
		case ed25519.PublicKey:
			jwk := `{"crv":"Ed25519","kty":"OKP","x":"` + base64.RawURLEncoding.EncodeToString(key) + `"}`
			keys = append(keys, identityKey{Ed25519: key, KID: jwkThumbprint(jwk)})
		case *ecdsa.PublicKey:
			if key.Curve != elliptic.P256() {
				return nil, fmt.Errorf("key %d is an ECDSA key of a curve that is not P-256", len(keys)+1)
			}
			x := key.X.FillBytes(make([]byte, 32))
			y := key.Y.FillBytes(make([]byte, 32))
			jwk := `{"crv":"P-256","kty":"EC","x":"` + base64.RawURLEncoding.EncodeToString(x) + `","y":"` + base64.RawURLEncoding.EncodeToString(y) + `"}`
			keys = append(keys, identityKey{P256: key, KID: jwkThumbprint(jwk)})
		default:
			return nil, fmt.Errorf("key %d is not an Ed25519 key or a P-256 key", len(keys)+1)
		}
		rest = remaining
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("no key: give at least one -----BEGIN PUBLIC KEY----- block")
	}
	return keys, nil
}

// jwkThumbprint gives the JWK thumbprint of RFC 7638 (SHA-256, base64url).
func jwkThumbprint(canonicalJWK string) string {
	digest := sha256.Sum256([]byte(canonicalJWK))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
