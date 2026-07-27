package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

const uploadResumeTokenVersion = "s3br1"

// uploadResumeDescriptor contains only the provider session coordinates needed
// to reconstruct an upload after process memory has been lost. The descriptor
// is encrypted and authenticated before it is returned to the client. The
// server never writes it to disk or to the connected object store.
type uploadResumeDescriptor struct {
	Instance         string `json:"i"`
	Key              string `json:"k"`
	Provider         string `json:"p"`
	ContentType      string `json:"ct"`
	TotalSize        int64  `json:"s"`
	ChunkSize        int64  `json:"cs"`
	ProviderUploadID string `json:"u,omitempty"`
	SessionURL       string `json:"r,omitempty"`
	IssuedAt         int64  `json:"iat"`
	ExpiresAt        int64  `json:"exp"`
}

func (a *application) uploadResumeCipherKey(instance *storageInstance) [32]byte {
	if a == nil || instance == nil {
		return [32]byte{}
	}
	auth := a.authentications[instance.cfg.AuthID]
	material := ""
	if auth != nil {
		switch auth.cfg.Provider {
		case "s3":
			material = auth.s3Creds.SecretAccessKey + "\x00" + auth.s3Creds.SessionToken
		case "gcs":
			if auth.gcsToken != nil {
				material = auth.gcsToken.info.ClientEmail + "\x00" + auth.gcsToken.info.PrivateKey
			}
		}
	}
	if material == "" {
		material = string(a.resumeTokenKey[:])
	}
	return sha256.Sum256([]byte("s3-browser-transfer-resume-v1\x00" + instance.cfg.AuthID + "\x00" + material))
}

func (a *application) sealUploadResumeToken(instance *storageInstance, upload uploadSession) (string, error) {
	if instance == nil {
		return "", fmt.Errorf("storage instance is nil")
	}
	issuedAt := upload.CreatedAt.UTC()
	if issuedAt.IsZero() {
		issuedAt = time.Now().UTC()
	}
	descriptor := uploadResumeDescriptor{
		Instance: instance.cfg.ID, Key: upload.Key, Provider: upload.Provider,
		ContentType: upload.ContentType, TotalSize: upload.TotalSize, ChunkSize: upload.ChunkSize,
		ProviderUploadID: upload.ProviderUploadID, SessionURL: upload.SessionURL,
		IssuedAt: issuedAt.Unix(), ExpiresAt: issuedAt.Add(30 * 24 * time.Hour).Unix(),
	}
	plain, err := json.Marshal(descriptor)
	if err != nil {
		return "", fmt.Errorf("encode upload resume token: %w", err)
	}
	key := a.uploadResumeCipherKey(instance)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("create upload resume cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create upload resume cipher mode: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate upload resume nonce: %w", err)
	}
	instancePart := base64.RawURLEncoding.EncodeToString([]byte(instance.cfg.ID))
	aad := []byte(uploadResumeTokenVersion + "." + instancePart)
	sealed := gcm.Seal(nonce, nonce, plain, aad)
	return uploadResumeTokenVersion + "." + instancePart + "." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (a *application) openUploadResumeToken(token string) (uploadResumeDescriptor, *storageInstance, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != uploadResumeTokenVersion {
		return uploadResumeDescriptor{}, nil, apiError{Status: 400, Code: "invalid_resume_token", Message: "upload resume token is invalid"}
	}
	instanceBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return uploadResumeDescriptor{}, nil, apiError{Status: 400, Code: "invalid_resume_token", Message: "upload resume token is invalid"}
	}
	instance := a.instances[string(instanceBytes)]
	if instance == nil {
		return uploadResumeDescriptor{}, nil, apiError{Status: 404, Code: "unknown_instance", Message: "storage instance was not found"}
	}
	sealed, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return uploadResumeDescriptor{}, nil, apiError{Status: 400, Code: "invalid_resume_token", Message: "upload resume token is invalid"}
	}
	key := a.uploadResumeCipherKey(instance)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return uploadResumeDescriptor{}, nil, fmt.Errorf("create upload resume cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return uploadResumeDescriptor{}, nil, fmt.Errorf("create upload resume cipher mode: %w", err)
	}
	if len(sealed) < gcm.NonceSize() {
		return uploadResumeDescriptor{}, nil, apiError{Status: 400, Code: "invalid_resume_token", Message: "upload resume token is invalid"}
	}
	nonce, ciphertext := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	aad := []byte(parts[0] + "." + parts[1])
	plain, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return uploadResumeDescriptor{}, nil, apiError{Status: 400, Code: "invalid_resume_token", Message: "upload resume token could not be verified"}
	}
	var descriptor uploadResumeDescriptor
	if err := json.Unmarshal(plain, &descriptor); err != nil {
		return uploadResumeDescriptor{}, nil, apiError{Status: 400, Code: "invalid_resume_token", Message: "upload resume token is invalid"}
	}
	if descriptor.Instance != instance.cfg.ID || descriptor.Provider != instance.cfg.Provider || cleanRelativeKey(descriptor.Key) == "" || descriptor.TotalSize < 0 {
		return uploadResumeDescriptor{}, nil, apiError{Status: 400, Code: "invalid_resume_token", Message: "upload resume token does not match the configured storage"}
	}
	issuedAt := time.Unix(descriptor.IssuedAt, 0).UTC()
	expiresAt := time.Unix(descriptor.ExpiresAt, 0).UTC()
	now := time.Now().UTC()
	if descriptor.IssuedAt <= 0 || descriptor.ExpiresAt <= 0 ||
		now.After(expiresAt) || issuedAt.After(now.Add(5*time.Minute)) ||
		expiresAt.Before(issuedAt) || expiresAt.Sub(issuedAt) > 30*24*time.Hour {
		return uploadResumeDescriptor{}, nil, apiError{Status: 410, Code: "resume_token_expired", Message: "upload resume token has expired"}
	}
	return descriptor, instance, nil
}

func uploadIDFromResumeToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("upl_%x", sum[:16])
}
