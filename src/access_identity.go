package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math"
	"math/big"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxIdentityTokenBytes   = 8192
	maxSubjectBytes         = 256
	identityClockSkew       = 60
	identityCacheMaxEntries = 4096
)

// identityResult is the result of the check of one identity token. Reason is
// empty for a valid token. Else it is one of: missing, malformed, algorithm,
// signature, issuer, audience, expired, not_yet_valid, max_age, subject.
type identityResult struct {
	Subject   string
	ExpiresAt int64
	Reason    string
}

func (r identityResult) ok() bool { return r.Reason == "" }

type cachedIdentity struct {
	subject   string
	expiresAt int64
}

// identityVerifier verifies the identity tokens of the access gateway
// (contract 11.3). It keeps the SHA-256 of each valid token, with its subject,
// until the token expires.
type identityVerifier struct {
	issuer   string
	audience string
	maxAge   int64
	keys     []identityKey

	mu    sync.Mutex
	cache map[[32]byte]cachedIdentity
}

func newIdentityVerifier(cfg accessConfig) *identityVerifier {
	return &identityVerifier{
		issuer:   cfg.Issuer,
		audience: cfg.Audience,
		maxAge:   int64(cfg.MaxAge / time.Second),
		keys:     cfg.Keys,
		cache:    make(map[[32]byte]cachedIdentity),
	}
}

// verify checks one token at the time now (Unix seconds).
func (v *identityVerifier) verify(token string, now int64) identityResult {
	if token == "" {
		return identityResult{Reason: "missing"}
	}
	if len(token) > maxIdentityTokenBytes {
		return identityResult{Reason: "malformed"}
	}
	digest := sha256.Sum256([]byte(token))
	v.mu.Lock()
	if cached, found := v.cache[digest]; found {
		if now < cached.expiresAt {
			v.mu.Unlock()
			return identityResult{Subject: cached.subject, ExpiresAt: cached.expiresAt}
		}
		delete(v.cache, digest)
		v.mu.Unlock()
		return identityResult{Reason: "expired"}
	}
	v.mu.Unlock()

	result := v.verifyUncached(token, now)
	if !result.ok() {
		return result
	}
	v.mu.Lock()
	if len(v.cache) >= identityCacheMaxEntries {
		for key, entry := range v.cache {
			if entry.expiresAt <= now {
				delete(v.cache, key)
			}
		}
		if len(v.cache) >= identityCacheMaxEntries {
			v.cache = make(map[[32]byte]cachedIdentity)
		}
	}
	v.cache[digest] = cachedIdentity{subject: result.Subject, expiresAt: result.ExpiresAt}
	v.mu.Unlock()
	return result
}

func (v *identityVerifier) verifyUncached(token string, now int64) identityResult {
	refused := func(reason string) identityResult { return identityResult{Reason: reason} }
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return refused("malformed")
	}
	decode := base64.RawURLEncoding.Strict()
	headerBytes, err := decode.DecodeString(parts[0])
	if err != nil {
		return refused("malformed")
	}
	payloadBytes, err := decode.DecodeString(parts[1])
	if err != nil {
		return refused("malformed")
	}
	signature, err := decode.DecodeString(parts[2])
	if err != nil {
		return refused("malformed")
	}

	var header map[string]json.RawMessage
	if err := json.Unmarshal(headerBytes, &header); err != nil || header == nil {
		return refused("malformed")
	}
	var algorithm string
	if raw, ok := header["alg"]; !ok || json.Unmarshal(raw, &algorithm) != nil {
		return refused("algorithm")
	}
	if algorithm != "EdDSA" && algorithm != "ES256" {
		return refused("algorithm")
	}
	// An extension that this verifier does not know must stop the token (RFC 7515, 4.1.11).
	if _, ok := header["crit"]; ok {
		return refused("malformed")
	}
	if raw, ok := header["typ"]; ok {
		var typ string
		if json.Unmarshal(raw, &typ) != nil || !strings.EqualFold(typ, "JWT") {
			return refused("malformed")
		}
	}

	signingInput := []byte(token[:len(parts[0])+1+len(parts[1])])
	if !v.signatureValid(algorithm, signingInput, signature) {
		return refused("signature")
	}

	var claims map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil || claims == nil {
		return refused("malformed")
	}
	var issuer string
	if raw, ok := claims["iss"]; !ok || json.Unmarshal(raw, &issuer) != nil || issuer != v.issuer {
		return refused("issuer")
	}
	if !audienceContains(claims["aud"], v.audience) {
		return refused("audience")
	}
	rawExp, expOK := claims["exp"]
	rawIat, iatOK := claims["iat"]
	if !expOK || !iatOK {
		return refused("max_age")
	}
	exp, okExp := numericDate(rawExp)
	iat, okIat := numericDate(rawIat)
	if !okExp || !okIat {
		return refused("malformed")
	}
	if now >= exp {
		return refused("expired")
	}
	if iat > now+identityClockSkew {
		return refused("not_yet_valid")
	}
	if exp < iat || exp-iat > v.maxAge {
		return refused("max_age")
	}
	if rawNbf, ok := claims["nbf"]; ok {
		nbf, valid := numericDate(rawNbf)
		if !valid {
			return refused("malformed")
		}
		if nbf > now+identityClockSkew {
			return refused("not_yet_valid")
		}
	}
	var subject string
	if raw, ok := claims["sub"]; !ok || json.Unmarshal(raw, &subject) != nil {
		return refused("subject")
	}
	if subject == "" || len(subject) > maxSubjectBytes || !utf8.ValidString(subject) || hasControlCharacter(subject) {
		return refused("subject")
	}
	return identityResult{Subject: subject, ExpiresAt: exp}
}

// signatureValid tries each configured key of the algorithm. Thus a rotation
// can use two keys.
func (v *identityVerifier) signatureValid(algorithm string, signingInput, signature []byte) bool {
	for _, key := range v.keys {
		if key.algorithm() != algorithm {
			continue
		}
		switch algorithm {
		case "EdDSA":
			if len(signature) == ed25519.SignatureSize && ed25519.Verify(key.Ed25519, signingInput, signature) {
				return true
			}
		case "ES256":
			if len(signature) != 64 {
				continue
			}
			digest := sha256.Sum256(signingInput)
			r := new(big.Int).SetBytes(signature[:32])
			s := new(big.Int).SetBytes(signature[32:])
			if ecdsa.Verify(key.P256, digest[:], r, s) {
				return true
			}
		}
	}
	return false
}

// audienceContains reads the aud claim: a text, or a list of texts.
func audienceContains(raw json.RawMessage, audience string) bool {
	if len(raw) == 0 {
		return false
	}
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single == audience
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return false
	}
	for _, item := range list {
		var value string
		if json.Unmarshal(item, &value) == nil && value == audience {
			return true
		}
	}
	return false
}

// numericDate reads a NumericDate of RFC 7519: a number of seconds.
func numericDate(raw json.RawMessage) (int64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !(trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')) {
		return 0, false
	}
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	if decoder.Decode(&number) != nil {
		return 0, false
	}
	if value, err := number.Int64(); err == nil {
		return value, true
	}
	value, err := number.Float64()
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > 9e15 {
		return 0, false
	}
	return int64(math.Floor(value)), true
}
