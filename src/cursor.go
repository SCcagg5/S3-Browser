package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
)

const maxSignedCursorPayloadBytes = 64 << 10

var (
	cursorSecretOnce sync.Once
	cursorSecret     [32]byte
	cursorSecretErr  error
)

func processCursorSecret() ([]byte, error) {
	cursorSecretOnce.Do(func() {
		_, cursorSecretErr = rand.Read(cursorSecret[:])
	})
	if cursorSecretErr != nil {
		return nil, cursorSecretErr
	}
	return cursorSecret[:], nil
}

func signedCursorScope(kind, instanceID, key string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(kind) + "\x00" + strings.TrimSpace(instanceID) + "\x00" + key))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func encodeSignedCursor(value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	if len(payload) == 0 || len(payload) > maxSignedCursorPayloadBytes {
		return "", errors.New("cursor payload exceeds the supported limit")
	}
	secret, err := processCursorSecret()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	signature := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func decodeSignedCursor(raw string, destination any) error {
	raw = strings.TrimSpace(raw)
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return errors.New("invalid signed cursor")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(payload) == 0 || len(payload) > maxSignedCursorPayloadBytes {
		return errors.New("invalid signed cursor payload")
	}
	// Reject non-canonical base64url spellings. Without this check, changing
	// unused trailing bits can produce a different token string that decodes to
	// the same signed bytes, which makes tamper detection and replay diagnostics
	// ambiguous even though the HMAC itself remains valid.
	if base64.RawURLEncoding.EncodeToString(payload) != parts[0] {
		return errors.New("invalid signed cursor payload")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(signature) != sha256.Size {
		return errors.New("invalid signed cursor signature")
	}
	if base64.RawURLEncoding.EncodeToString(signature) != parts[1] {
		return errors.New("invalid signed cursor signature")
	}
	secret, err := processCursorSecret()
	if err != nil {
		return err
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return errors.New("invalid signed cursor signature")
	}
	if err := json.Unmarshal(payload, destination); err != nil {
		return errors.New("invalid signed cursor payload")
	}
	return nil
}
