package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"
)

// The usage reader of MinIO: two requests to the admin API (/minio/admin/v3), signed with SigV4 (service "s3") and the
// S3 credentials of the auth block. The credentials need the admin actions admin:GetBucketQuota,
// admin:DataUsageInfo and admin:StorageInfo (for the capacity of the storage, usage_capacity.go), for example the policy
// "consoleAdmin" or the root user.
//
// Measured on MinIO RELEASE.2025-10-15T17-29-55Z:
//   - GET /minio/admin/v3/get-bucket-quota?bucket=<bucket> gives {"quota": <bytes>, "size": <bytes>, "rate": 0,
//     "requests": 0, "quotatype": "hard"}. A bucket without a quota gives 200 with "quota": 0. "mc quota set" and
//     PUT /minio/admin/v3/set-bucket-quota?bucket=<bucket> with {"quota": <bytes>, "quotatype": "hard"} set it, and
//     MinIO refuses a write over it. Older releases answer 404 XMinioAdminBucketQuotaNotConfigured without a quota,
//     and newer clients write the limit in "size": the reader takes "size", else "quota".
//   - GET /minio/admin/v3/datausageinfo gives "lastUpdate" and "bucketsUsageInfo": {<bucket>: {"size": <bytes>,
//     "objectsCount": <count>, ...}} for all the buckets. The scanner of MinIO makes these numbers, about one time each
//     minute on a small server: they come with a delay. A zero "lastUpdate" is a server that has not counted yet.

// The size limits of the answers. datausageinfo gives about 1 KiB for each bucket of the server.
const (
	maxMinIOQuotaBytes     = 64 << 10
	maxMinIODataUsageBytes = 16 << 20
)

type minioUsageReader struct {
	endpoint *url.URL
	client   *http.Client
	creds    s3Credentials
	region   string
}

func (r *minioUsageReader) BucketUsage(ctx context.Context, bucket string) (bucketUsage, error) {
	var quota struct {
		Quota int64 `json:"quota"`
		Size  int64 `json:"size"`
	}
	err := r.get(ctx, "get-bucket-quota", url.Values{"bucket": {bucket}}, maxMinIOQuotaBytes, &quota)
	var httpError *usageHTTPError
	if errors.As(err, &httpError) && httpError.Status == http.StatusNotFound && httpError.Code == "XMinioAdminBucketQuotaNotConfigured" {
		err = nil
	}
	if err != nil {
		return bucketUsage{}, err
	}
	var data struct {
		LastUpdate time.Time `json:"lastUpdate"`
		Buckets    map[string]struct {
			Size         int64 `json:"size"`
			ObjectsCount int64 `json:"objectsCount"`
		} `json:"bucketsUsageInfo"`
	}
	if err := r.get(ctx, "datausageinfo", nil, maxMinIODataUsageBytes, &data); err != nil {
		return bucketUsage{}, err
	}
	if data.LastUpdate.IsZero() {
		return bucketUsage{}, errors.New("datausageinfo: MinIO has not counted the usage of its buckets yet")
	}
	// A bucket that the last count does not know is newer than the count: it is empty for MinIO.
	used := data.Buckets[bucket]
	limit := quota.Size
	if limit <= 0 {
		limit = quota.Quota
	}
	return bucketUsage{
		UsedBytes: used.Size, UsedObjects: used.ObjectsCount, LimitBytes: max(limit, 0),
		Approximate: true, AsOf: data.LastUpdate.UTC(),
	}, nil
}

// get sends one signed GET request to /minio/admin/v3/<name> and decodes its JSON answer.
func (r *minioUsageReader) get(ctx context.Context, name string, query url.Values, limit int64, target any) error {
	address := r.endpoint.JoinPath("minio", "admin", "v3", name)
	if len(query) > 0 {
		address.RawQuery = canonicalQuery(query)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address.String(), nil)
	if err != nil {
		return usageTransportError(name, err)
	}
	if err := signS3Request(req, r.creds, r.region, time.Now().UTC()); err != nil {
		return errors.New(name + ": cannot sign the request")
	}
	return getUsageJSON(r.client, req, name, limit, target)
}
