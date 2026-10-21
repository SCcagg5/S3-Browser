package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"sync"
	"time"
)

// Usage and quota of a bucket.
//
// The S3 API gives no usage and no quota of a bucket. Each provider gives them in its own admin API. The usage block of
// an auth block names the reader (source) and its URLs: the server never guesses the source. Without the block, the
// server makes no admin request and the page shows no usage. One reader for each source, in its own file:
// usage_garage.go, usage_seaweedfs.go and usage_minio.go. AWS S3 has no quota: no reader.
//
// Cost and safety: each admin request is a read (GET), with a time limit of usageTimeout and a size limit for the
// answer. The server keeps the result of an instance for usageCacheTTL (a failure for usageRetryInterval), and one read
// at a time runs for an instance. A request with fresh=1 (the reload of the page, or the end of a change) reads again
// when the result is older than usageRetryInterval. The token and the URLs of the admin API never go into an answer
// or a log line: the errors of the readers name the step and the HTTP status only.
//
// The numbers are for the whole bucket, also for an instance with a root prefix.

// The sources of a usage block. They are also the names of the providers of the lifecycle probe.
const (
	usageSourceGarage    = flavourGarage
	usageSourceSeaweedFS = flavourSeaweedFS
	usageSourceMinIO     = flavourMinIO
	// usageSourceStatfs is the source of the usage of a volume: the size of its file system. A volume block has it;
	// a usage block cannot name it.
	usageSourceStatfs = "statfs"
)

const (
	// usageTimeout is the longest time of one read of the usage, with all its admin requests.
	usageTimeout = 5 * time.Second
	// usageCacheTTL is the life of a result in the cache of an instance.
	usageCacheTTL = 60 * time.Second
	// usageRetryInterval is the life of a failure in the cache, and the shortest interval between two reads with fresh=1.
	usageRetryInterval = 10 * time.Second

	// usageWarningRatio and usageErrorRatio are the levels of a used part of the limit: "warning" from 80 %, "error"
	// from 95 %.
	usageWarningRatio = 0.80
	usageErrorRatio   = 0.95
)

// bucketUsage is the usage and the quota of a bucket, the same for each source. A count that the source does not give
// is -1. A limit of 0 is no limit.
type bucketUsage struct {
	UsedBytes    int64
	UsedObjects  int64
	LimitBytes   int64
	LimitObjects int64
	Source       string
	// Approximate tells that the source counts with a delay or counts more than the objects (refer to
	// usageApproximateReasons).
	Approximate bool
	// AsOf is the time of the count at the source.
	AsOf time.Time
}

// BucketUsageReader reads the usage and the quota of one bucket from the admin API of a provider. The usage block of
// the auth block makes one reader, and the buckets of the auth block share it.
type BucketUsageReader interface {
	BucketUsage(ctx context.Context, bucket string) (bucketUsage, error)
}

// usageApproximateReasons tells why the numbers of a source are approximate. The page shows the text in a tooltip.
var usageApproximateReasons = map[string]string{
	usageSourceSeaweedFS: "SeaweedFS gives the size of the volumes of the bucket, with a delay of some seconds. The number of objects is not known.",
	usageSourceMinIO:     "MinIO counts the usage in a background scan, about one time each minute or less often on a large server.",
}

// newBucketUsageReader makes the reader of the usage block of an auth block. It gives nil without a usage block.
func newBucketUsageReader(auth authConfig, client *http.Client, creds s3Credentials) (BucketUsageReader, error) {
	usage := auth.Usage
	if usage == nil {
		return nil, nil
	}
	endpoint, err := parseStorageEndpoint("usage", usage.Endpoint)
	if err != nil {
		return nil, err
	}
	switch usage.Source {
	case usageSourceGarage:
		return &garageUsageReader{endpoint: endpoint, client: client, token: usage.Token}, nil
	case usageSourceSeaweedFS:
		filer, err := parseStorageEndpoint("usage filer", usage.FilerEndpoint)
		if err != nil {
			return nil, err
		}
		return &seaweedfsUsageReader{master: endpoint, filer: filer, client: client}, nil
	case usageSourceMinIO:
		return &minioUsageReader{endpoint: endpoint, client: client, creds: creds, region: auth.Region}, nil
	}
	return nil, fmt.Errorf("auth %q: unknown usage source %q", auth.ID, usage.Source)
}

// usageHTTPError is an answer of an admin API that is not a success. It names the step and the status, never the URL.
// Code is the error code of a JSON error document ("Code" for MinIO, "code" for Garage), when the answer has one.
type usageHTTPError struct {
	Step   string
	Status int
	Code   string
}

func (e *usageHTTPError) Error() string {
	switch e.Status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Sprintf("%s: the admin API refused the credentials (HTTP %d)", e.Step, e.Status)
	case http.StatusNotFound:
		return fmt.Sprintf("%s: the admin API does not know the bucket (HTTP %d)", e.Step, e.Status)
	}
	return fmt.Sprintf("%s: the admin API answered HTTP %d", e.Step, e.Status)
}

// usageTransportError gives the reason of a failed admin request without the URL. The errors of net/http contain the
// URL, and the URL can contain the address of a private admin API.
func usageTransportError(step string, err error) error {
	var certificate *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var netError net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s: the admin API did not answer in %s", step, usageTimeout)
	case errors.Is(err, context.Canceled):
		return fmt.Errorf("%s: the request was canceled", step)
	case errors.As(err, &certificate), errors.As(err, &unknownAuthority), errors.As(err, &hostname):
		return fmt.Errorf("%s: the TLS certificate of the admin API is not valid", step)
	case errors.As(err, &netError) && netError.Timeout():
		return fmt.Errorf("%s: the admin API did not answer in %s", step, usageTimeout)
	}
	return fmt.Errorf("%s: cannot connect to the admin API", step)
}

// getUsageJSON sends one admin request and decodes its JSON answer into target. The answer must be a success and must
// not be longer than limit bytes.
func getUsageJSON(client *http.Client, req *http.Request, step string, limit int64, target any) error {
	resp, err := client.Do(req)
	if err != nil {
		return usageTransportError(step, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return usageTransportError(step, err)
	}
	if resp.StatusCode != http.StatusOK {
		var document struct {
			Code      string `json:"Code"`
			LowerCode string `json:"code"`
		}
		_ = json.Unmarshal(data, &document)
		code := document.Code
		if code == "" {
			code = document.LowerCode
		}
		return &usageHTTPError{Step: step, Status: resp.StatusCode, Code: safeProviderErrorCode(code)}
	}
	if int64(len(data)) > limit {
		return fmt.Errorf("%s: the answer of the admin API is longer than %d bytes", step, limit)
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("%s: the answer of the admin API is not the expected JSON", step)
	}
	return nil
}

// --- Storage instance -----------------------------------------------------------------------------------------------

// usageCapability is the usage reader of an instance and its cache.
type usageCapability struct {
	// reader is nil for an instance whose auth block has no usage block.
	reader BucketUsageReader
	source string

	mu     sync.Mutex
	value  bucketUsage
	err    error
	readAt time.Time
	// flight is open while a read runs. The other requests wait for it.
	flight chan struct{}
}

// errUsageUnsupported is the answer for an instance without a usage block.
var errUsageUnsupported = apiError{Status: http.StatusNotImplemented, Code: "usage_unsupported", Message: "this bucket has no usage source in the configuration"}

// usageAvailable tells if the page can show the usage of the bucket.
func (s *storageInstance) usageAvailable() bool {
	return s != nil && s.usage.reader != nil
}

// bucketUsage gives the usage of the bucket of the instance from the cache, or reads it. One read at a time runs for
// the instance: the other requests wait for its result. With fresh, a result older than usageRetryInterval is read
// again. The read does not stop when the request that started it stops, so the other requests get its result.
func (s *storageInstance) bucketUsage(ctx context.Context, fresh bool) (bucketUsage, error) {
	usage := &s.usage
	if usage.reader == nil {
		return bucketUsage{}, errUsageUnsupported
	}
	for {
		usage.mu.Lock()
		if usage.flight == nil && !usage.readAt.IsZero() {
			life := usageCacheTTL
			if usage.err != nil || fresh {
				life = usageRetryInterval
			}
			if timeNowUTC().Sub(usage.readAt) < life {
				value, err := usage.value, usage.err
				usage.mu.Unlock()
				return value, err
			}
		}
		if flight := usage.flight; flight != nil {
			usage.mu.Unlock()
			select {
			case <-flight:
				continue
			case <-ctx.Done():
				return bucketUsage{}, ctx.Err()
			}
		}
		flight := make(chan struct{})
		usage.flight = flight
		usage.mu.Unlock()
		return s.readBucketUsage(ctx, flight)
	}
}

// readBucketUsage makes one read for bucketUsage, keeps its result and opens the flight.
func (s *storageInstance) readBucketUsage(ctx context.Context, flight chan struct{}) (value bucketUsage, err error) {
	usage := &s.usage
	defer func() {
		usage.mu.Lock()
		usage.value, usage.err, usage.readAt = value, err, timeNowUTC()
		usage.flight = nil
		usage.mu.Unlock()
		close(flight)
	}()
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), usageTimeout)
	defer cancel()
	value, err = usage.reader.BucketUsage(readCtx, s.cfg.Bucket)
	if err != nil {
		log.Printf("usage.error bucket=%q source=%s: %v", s.cfg.ID, usage.source, err)
		return bucketUsage{}, err
	}
	value.Source = usage.source
	return value, nil
}

// probeUsage compares the source of the usage block with the provider that the lifecycle probe found. The source of
// the file applies. A different known provider gives a warning in the log. The probe makes no admin request.
func (s *storageInstance) probeUsage(ctx context.Context) {
	if !s.usageAvailable() || !s.permitted(permissionRead) {
		return
	}
	flavour := s.lifecycleFlavour(ctx)
	if flavour != "" && flavour != s.usage.source {
		log.Printf("config.warning bucket %q: the usage block of auth %q has source = %q, but the provider answers as %s; the server uses the source of the file", s.cfg.ID, s.cfg.AuthID, s.usage.source, flavourNames[flavour])
	}
}

// usageLevel gives the used part of the limit in percent, with one decimal (the next decimals are cut), and the level:
// "" without a limit, "ok", "warning" from usageWarningRatio, "error" from usageErrorRatio. With a limit of bytes and a
// limit of objects, the larger part applies.
func usageLevel(value bucketUsage) (float64, string) {
	ratio := -1.0
	if value.LimitBytes > 0 && value.UsedBytes >= 0 {
		ratio = float64(value.UsedBytes) / float64(value.LimitBytes)
	}
	if value.LimitObjects > 0 && value.UsedObjects >= 0 {
		ratio = math.Max(ratio, float64(value.UsedObjects)/float64(value.LimitObjects))
	}
	switch {
	case ratio < 0:
		return 0, ""
	case ratio >= usageErrorRatio:
		return math.Floor(ratio*1000) / 10, "error"
	case ratio >= usageWarningRatio:
		return math.Floor(ratio*1000) / 10, "warning"
	}
	return math.Floor(ratio*1000) / 10, "ok"
}

// --- HTTP -----------------------------------------------------------------------------------------------------------

type usageResponse struct {
	Supported bool `json:"supported"`
	// Available is false when the read failed. Error then gives the reason, and the numbers are 0.
	Available   bool            `json:"available"`
	Error       *usageErrorJSON `json:"error,omitempty"`
	Instance    string          `json:"instance"`
	Bucket      string          `json:"bucket"`
	RootPrefix  string          `json:"rootPrefix,omitempty"`
	Source      string          `json:"source"`
	UsedBytes   int64           `json:"usedBytes"`
	UsedObjects int64           `json:"usedObjects"`
	// LimitBytes and LimitObjects are 0 without a limit. LimitSource is "provider", "config" (bucket.quota_bytes) or
	// "" without a limit.
	LimitBytes        int64     `json:"limitBytes"`
	LimitObjects      int64     `json:"limitObjects"`
	LimitSource       string    `json:"limitSource"`
	Approximate       bool      `json:"approximate"`
	ApproximateReason string    `json:"approximateReason,omitempty"`
	AsOf              time.Time `json:"asOf"`
	Percent           float64   `json:"percent"`
	Level             string    `json:"level"`
}

type usageErrorJSON struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// usageAnswer makes the answer of GET /api/usage from a result. The limit of the operator (bucket.quota_bytes)
// applies when the source gives no limit of bytes.
func usageAnswer(instance *storageInstance, value bucketUsage) usageResponse {
	answer := usageResponse{
		Supported: true, Available: true, Instance: instance.cfg.ID, Bucket: instance.cfg.Bucket, RootPrefix: instance.cfg.RootPrefix,
		Source: value.Source, UsedBytes: value.UsedBytes, UsedObjects: value.UsedObjects,
		LimitBytes: value.LimitBytes, LimitObjects: value.LimitObjects, Approximate: value.Approximate, AsOf: value.AsOf.UTC(),
	}
	if answer.LimitBytes > 0 || answer.LimitObjects > 0 {
		answer.LimitSource = "provider"
	}
	if answer.LimitBytes == 0 && instance.cfg.QuotaBytes > 0 {
		answer.LimitBytes, answer.LimitSource = instance.cfg.QuotaBytes, "config"
	}
	if answer.Approximate {
		answer.ApproximateReason = usageApproximateReasons[value.Source]
	}
	answer.Percent, answer.Level = usageLevel(bucketUsage{UsedBytes: answer.UsedBytes, UsedObjects: answer.UsedObjects, LimitBytes: answer.LimitBytes, LimitObjects: answer.LimitObjects})
	return answer
}

// handleUsage gives the usage and the quota of the bucket of an instance (GET, permission read). An instance without a
// usage block gives {"supported": false}. A failed read gives 200 with "available": false and the reason: an answer
// 502 would tell the page that the server does not answer (session.js), and a failure must not break the page.
func (a *application) handleUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, err := a.readableInstance(r, "")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeAPIError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if !instance.usageAvailable() {
		writeJSON(w, http.StatusOK, map[string]bool{"supported": false})
		return
	}
	value, err := instance.bucketUsage(r.Context(), r.URL.Query().Get("fresh") == "1")
	if err != nil {
		noun := "bucket"
		if instance.cfg.Provider == providerVolume {
			noun = "volume"
		}
		writeJSON(w, http.StatusOK, usageResponse{
			Supported: true, Instance: instance.cfg.ID, Bucket: instance.cfg.Bucket, RootPrefix: instance.cfg.RootPrefix, Source: instance.usage.source,
			Error: &usageErrorJSON{Code: "usage_unavailable", Message: "The usage of the " + noun + " is unavailable: " + err.Error() + "."},
		})
		return
	}
	writeJSON(w, http.StatusOK, usageAnswer(instance, value))
}
