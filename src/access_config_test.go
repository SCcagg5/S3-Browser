package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	testAudience = "infra-s3"
	testIssuer   = "portal.home"
	testPDPToken = "pdp-test-token-0123456789abcdef0123456789"
)

func newTestIdentityKey(t *testing.T) (ed25519.PrivateKey, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return private, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

const accessTestStorage = `
auth "public" {
  provider = "s3"
  mode     = "anonymous"
  endpoint = "http://localhost:9000"
  region   = "test"
}

bucket "logs" {
  auth   = "public"
  bucket = "logs"
}
`

// writeAccessFixtures writes a public key file and a token file next to the configuration.
func writeAccessFixtures(t *testing.T, dir string) {
	t.Helper()
	_, publicPEM := newTestIdentityKey(t)
	if err := os.WriteFile(filepath.Join(dir, "keys.pem"), []byte(publicPEM), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pdp_token"), []byte(testPDPToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

const authzenAccessBlock = `
access {
  mode = "authzen"
  identity {
    issuer           = "portal.home"
    audience         = "infra-s3"
    public_keys_file = "keys.pem"
  }
  pdp {
    url        = "http://portal-pdp.edge.svc.cluster.local:4182"
    token_file = "pdp_token"
  }
}
`

func decodeAccessTestConfig(t *testing.T, access string) (appConfig, error) {
	t.Helper()
	dir := t.TempDir()
	writeAccessFixtures(t, dir)
	return decodeConfig(accessTestStorage+access, filepath.Join(dir, "config.hcl"), dir)
}

func TestAccessConfigAuthZENDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := decodeAccessTestConfig(t, authzenAccessBlock)
	if err != nil {
		t.Fatal(err)
	}
	access := cfg.Access
	if !access.enforced() || access.Header != "X-Identity-Token" || access.Audience != "infra-s3" || access.Issuer != "portal.home" {
		t.Fatalf("access = %+v", access)
	}
	if access.MaxAge.String() != "5m0s" || access.PDPTimeout.String() != "500ms" || access.PDPCacheTTL.String() != "30s" || access.PDPMaxEvaluations != 64 {
		t.Fatalf("defaults = %+v", access)
	}
	if access.PDPToken != testPDPToken {
		t.Fatal("the token file must lose only its last line end")
	}
	if len(access.Keys) != 1 {
		t.Fatalf("keys = %d", len(access.Keys))
	}
}

func TestAccessConfigRefusals(t *testing.T) {
	t.Parallel()
	replace := func(old, new string) string { return strings.Replace(authzenAccessBlock, old, new, 1) }
	for name, test := range map[string]struct {
		access string
		want   string
	}{
		"no access block":      {"", "the access block is required"},
		"no mode":              {"access {}", "access.mode is required"},
		"bad mode":             {`access { mode = "closed" }`, `access.mode must be "authzen" or "open"`},
		"two access blocks":    {"access { mode = \"open\" }\naccess { mode = \"open\" }", "only one access block"},
		"open with identity":   {"access {\n mode = \"open\"\n identity { issuer = \"x\" }\n}", "contradicts"},
		"authzen without pdp":  {"access {\n mode = \"authzen\"\n identity { issuer = \"x\" }\n}", "requires the access.pdp block"},
		"unknown attribute":    {replace(`mode = "authzen"`, "mode = \"authzen\"\n  modes = \"x\""), `unknown attribute "modes"`},
		"unknown block":        {replace("pdp {", "policy {}\n  pdp {"), `unknown block "policy"`},
		"clear token":          {replace(`token_file = "pdp_token"`, `token = "abc"`), "token is a secret"},
		"two token forms":      {replace(`token_file = "pdp_token"`, "token_file = \"pdp_token\"\n    token_env = \"X\""), "give only one of token, token_env and token_file"},
		"missing variable":     {replace(`token_file = "pdp_token"`, `token_env = "STOWR_TEST_NO_SUCH_VARIABLE"`), `the environment variable "STOWR_TEST_NO_SUCH_VARIABLE" does not exist`},
		"missing token file":   {replace(`token_file = "pdp_token"`, `token_file = "nope"`), "token_file: cannot read"},
		"no token":             {replace(`token_file = "pdp_token"`, ""), "access.pdp.token is required"},
		"no audience":          {replace(`audience         = "infra-s3"`, ""), "access.identity.audience is required"},
		"bad keys":             {replace(`public_keys_file = "keys.pem"`, `public_keys = "not a key"`), "access.identity.public_keys"},
		"cookie header":        {replace(`issuer           = "portal.home"`, "issuer = \"portal.home\"\n    header = \"Cookie\""), "access.identity.header"},
		"https URL with query": {replace(`url        = "http://portal-pdp.edge.svc.cluster.local:4182"`, `url = "https://pdp?x=1"`), "access.pdp.url"},
		"ftp URL":              {replace(`url        = "http://portal-pdp.edge.svc.cluster.local:4182"`, `url = "ftp://pdp"`), "must use http or https"},
		"long max age":         {replace(`public_keys_file = "keys.pem"`, "public_keys_file = \"keys.pem\"\n    max_age = \"48h\""), "access.identity.max_age"},
		"short timeout":        {replace(`token_file = "pdp_token"`, "token_file = \"pdp_token\"\n    timeout = \"1ms\""), "access.pdp.timeout"},
		"max evaluations zero": {replace(`token_file = "pdp_token"`, "token_file = \"pdp_token\"\n    max_evaluations = 0"), "access.pdp.max_evaluations"},
	} {
		_, err := decodeAccessTestConfig(t, test.access)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("%s: error = %v, want %q", name, err, test.want)
		}
		if strings.Contains(err.Error(), testPDPToken) {
			t.Fatalf("%s: the error shows the token", name)
		}
	}
}

func TestAccessConfigReadsTheEnvironmentOnlyWhenTheFileNamesIt(t *testing.T) {
	t.Setenv("STOWR_TEST_PDP_TOKEN", "token-from-env")
	t.Setenv("STOWR_TEST_PDP_URL", "http://pdp.internal:4182/base/")
	access := strings.Replace(authzenAccessBlock, `token_file = "pdp_token"`, `token_env = "STOWR_TEST_PDP_TOKEN"`, 1)
	access = strings.Replace(access, `url        = "http://portal-pdp.edge.svc.cluster.local:4182"`, `url_env = "STOWR_TEST_PDP_URL"`, 1)
	cfg, err := decodeAccessTestConfig(t, access)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Access.PDPToken != "token-from-env" || cfg.Access.PDPURL != "http://pdp.internal:4182/base" {
		t.Fatalf("access = %+v", cfg.Access)
	}
	printed := formatEffectiveConfiguration(cfg)
	for _, want := range []string{
		`access.pdp.token = <hidden>  # env:STOWR_TEST_PDP_TOKEN`,
		`access.pdp.url = "http://pdp.internal:4182/base"  # env:STOWR_TEST_PDP_URL`,
		`access.identity.audience = "infra-s3"  # file`,
		`access.identity.max_age = "5m0s"  # default`,
		`access.identity.public_keys = ["Ed25519 kid=`,
		`server.listen = ":8080"  # default`,
		`bucket "logs".bucket = "logs"  # file`,
		`auth "public".secret_access_key = <none>  # default`,
	} {
		if !strings.Contains(printed, want) {
			t.Fatalf("print-config misses %q:\n%s", want, printed)
		}
	}
	if strings.Contains(printed, "token-from-env") {
		t.Fatal("print-config shows the token")
	}
	if strings.Contains(printed, "keys.pem") && !strings.Contains(printed, "# file:") {
		t.Fatal("the source of public_keys must be file:<path>")
	}
}

func TestAccessConfigOpenModeWarns(t *testing.T) {
	t.Parallel()
	cfg, err := decodeAccessTestConfig(t, `access { mode = "open" }`)
	if err != nil {
		t.Fatal(err)
	}
	warnings := strings.Join(configWarnings(cfg), "\n")
	if !strings.Contains(warnings, `access.mode = "open"`) {
		t.Fatalf("warnings = %q", warnings)
	}
	if strings.Contains(formatEffectiveConfiguration(cfg), "access.pdp") {
		t.Fatal("the open mode has no pdp keys")
	}
}

func TestAuthSecretsAcceptTheEnvironmentForm(t *testing.T) {
	t.Setenv("STOWR_TEST_SECRET", "secret-from-env")
	dir := t.TempDir()
	cfg, err := decodeConfig(`
auth "s3" {
  provider              = "s3"
  endpoint              = "http://localhost:9000"
  region                = "test"
  access_key_id         = "clear-key"
  secret_access_key_env = "STOWR_TEST_SECRET"
}
bucket "b" {
  auth   = "s3"
  bucket = "b"
}
access { mode = "open" }
`, filepath.Join(dir, "config.hcl"), dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Authentications[0].SecretAccessKey != "secret-from-env" || cfg.Authentications[0].Mode != "access_key" {
		t.Fatalf("auth = %+v", cfg.Authentications[0])
	}
	printed := formatEffectiveConfiguration(cfg)
	if !strings.Contains(printed, `auth "s3".secret_access_key = <hidden>  # env:STOWR_TEST_SECRET`) || strings.Contains(printed, "secret-from-env") ||
		!strings.Contains(printed, `auth "s3".access_key_id = "clear-key"  # file`) {
		t.Fatalf("print-config:\n%s", printed)
	}

}

// TestConfigurationReferenceIsCurrent makes sure that docs/configuration-reference.md
// is the text that the table of keys gives.
func TestConfigurationReferenceIsCurrent(t *testing.T) {
	t.Parallel()
	if _, err := os.Stat(filepath.Join("..", "README.md")); err != nil {
		// The image build copies only src: the repository root is not there.
		t.Skip("the repository root is not present")
	}
	data, err := os.ReadFile(filepath.Join("..", "docs", "configuration-reference.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != configReference() {
		t.Fatal("docs/configuration-reference.md is not current: run `go run . config-reference > ../docs/configuration-reference.md` in src")
	}
}

func TestEveryAttributeOfTheTableIsDecoded(t *testing.T) {
	t.Parallel()
	seen := map[string]bool{}
	for _, key := range configKeys {
		name := key.Block + "." + key.Name
		if seen[name] {
			t.Fatalf("duplicate key %s", name)
		}
		seen[name] = true
		if key.Description == "" || key.Type == "" || key.Forms == 0 {
			t.Fatalf("key %s is not complete", name)
		}
		if key.Secret && key.Block == "access.pdp" && key.Forms&formValue != 0 {
			t.Fatalf("the secret %s must accept only _env and _file", name)
		}
	}
	blocks := map[string]bool{}
	for _, block := range configBlocks {
		blocks[block.Path] = true
	}
	for _, key := range configKeys {
		if !blocks[key.Block] {
			t.Fatalf("key %s.%s has no block", key.Block, key.Name)
		}
	}
}
