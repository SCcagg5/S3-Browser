package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
	"time"
)

func signES256Token(t *testing.T, key *ecdsa.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	encode := func(value map[string]any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	input := encode(header) + "." + encode(claims)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	signature := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func testVerifier(t *testing.T, pemText string) *identityVerifier {
	t.Helper()
	keys, err := parseIdentityPublicKeys(pemText)
	if err != nil {
		t.Fatal(err)
	}
	return newIdentityVerifier(accessConfig{Issuer: testIssuer, Audience: testAudience, MaxAge: 5 * time.Minute, Keys: keys})
}

func TestIdentityVerifierAcceptsES256AndAudienceLists(t *testing.T) {
	t.Parallel()
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&ecKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	_, edPEM := newTestIdentityKey(t)
	// Two keys: a rotation keeps the old key and the new key.
	verifier := testVerifier(t, edPEM+string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})))
	now := time.Now().Unix()
	token := signES256Token(t, ecKey, map[string]any{"alg": "ES256"}, map[string]any{
		"iss": testIssuer, "sub": "erin", "aud": []string{"other", testAudience}, "iat": float64(now) + 0.5, "exp": now + 60,
	})
	result := verifier.verify(token, now)
	if !result.ok() || result.Subject != "erin" {
		t.Fatalf("ES256 token: %+v", result)
	}
	// The cache keeps a valid token until its exp only.
	if again := verifier.verify(token, now+61); again.Reason != "expired" {
		t.Fatalf("cached token after exp: %+v", again)
	}
	// An ES256 token cannot use an EdDSA key, and the reverse.
	wrong := signES256Token(t, ecKey, map[string]any{"alg": "EdDSA"}, map[string]any{
		"iss": testIssuer, "sub": "erin", "aud": testAudience, "iat": now, "exp": now + 60,
	})
	if result := verifier.verify(wrong, now); result.Reason != "signature" {
		t.Fatalf("wrong algorithm: %+v", result)
	}
}

func TestIdentityVerifierReasons(t *testing.T) {
	t.Parallel()
	key, publicPEM := newTestIdentityKey(t)
	verifier := testVerifier(t, publicPEM)
	now := int64(1_800_000_000)
	base := map[string]any{"iss": testIssuer, "sub": "bob", "aud": testAudience, "iat": now, "exp": now + 300}
	with := func(changes map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range base {
			out[k] = v
		}
		for k, v := range changes {
			if v == nil {
				delete(out, k)
			} else {
				out[k] = v
			}
		}
		return out
	}
	header := map[string]any{"alg": "EdDSA"}
	for name, test := range map[string]struct {
		token  string
		reason string
	}{
		"valid":           {signTestToken(t, key, header, base), ""},
		"missing":         {"", "missing"},
		"two parts":       {"a.b", "malformed"},
		"padding":         {signTestToken(t, key, header, base) + "=", "malformed"},
		"algorithm":       {signTestToken(t, key, map[string]any{"alg": "HS256"}, base), "algorithm"},
		"issuer":          {signTestToken(t, key, header, with(map[string]any{"iss": "x"})), "issuer"},
		"audience":        {signTestToken(t, key, header, with(map[string]any{"aud": []string{"x"}})), "audience"},
		"expired":         {signTestToken(t, key, header, with(map[string]any{"exp": now})), "expired"},
		"not yet valid":   {signTestToken(t, key, header, with(map[string]any{"nbf": now + 61})), "not_yet_valid"},
		"skew accepted":   {signTestToken(t, key, header, with(map[string]any{"nbf": now + 60})), ""},
		"max age":         {signTestToken(t, key, header, with(map[string]any{"exp": now + 301})), "max_age"},
		"quoted date":     {signTestToken(t, key, header, with(map[string]any{"exp": "1800000300"})), "malformed"},
		"control subject": {signTestToken(t, key, header, with(map[string]any{"sub": "bo\nb"})), "subject"},
		"long subject":    {signTestToken(t, key, header, with(map[string]any{"sub": strings.Repeat("s", 257)})), "subject"},
		"number subject":  {signTestToken(t, key, header, with(map[string]any{"sub": 7})), "subject"},
	} {
		result := verifier.verify(test.token, now)
		if result.Reason != test.reason {
			t.Fatalf("%s: reason %q, want %q", name, result.Reason, test.reason)
		}
	}
}

func TestParseIdentityPublicKeysRefusesOtherText(t *testing.T) {
	t.Parallel()
	_, publicPEM := newTestIdentityKey(t)
	keys, err := parseIdentityPublicKeys(publicPEM)
	if err != nil || len(keys) != 1 || keys[0].typeName() != "Ed25519" || len(keys[0].KID) != 43 {
		t.Fatalf("keys = %+v, err = %v", keys, err)
	}
	for name, text := range map[string]string{
		"empty":       "",
		"private key": "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
		"garbage":     publicPEM + "garbage",
		"not a key":   "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
		"seventeen":   strings.Repeat(publicPEM, 17),
	} {
		if _, err := parseIdentityPublicKeys(text); err == nil {
			t.Fatalf("%s: no error", name)
		}
	}
}

func TestJWKThumbprintOfRFC8037(t *testing.T) {
	t.Parallel()
	// RFC 8037, appendix A.3: the thumbprint of the Ed25519 key of appendix A.2.
	jwk := `{"crv":"Ed25519","kty":"OKP","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}`
	if got := jwkThumbprint(jwk); got != "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k" {
		t.Fatalf("thumbprint = %s", got)
	}
}

func signTestToken(t *testing.T, key ed25519.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	encode := func(value map[string]any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	input := encode(header) + "." + encode(claims)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(input)))
}
