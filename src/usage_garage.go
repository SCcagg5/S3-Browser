package main

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// The usage reader of Garage: one request to the admin API (v2), with the admin token as a bearer token.
//
// Measured on Garage v2.4.1: GET /v2/GetBucketInfo?globalAlias=<bucket> gives "objects", "bytes",
// "unfinishedMultipartUploadBytes" and "quotas": {"maxSize": <bytes or null>, "maxObjects": <count or null>}. null is
// no quota. A wrong token gives 403, an unknown bucket 404. The counters follow a write at once on one node. In a
// cluster they follow it after a short delay: the reader does not mark them approximate.

// maxGarageUsageBytes is the size limit of the answer of GetBucketInfo. The answer lists the keys of the bucket.
const maxGarageUsageBytes = 1 << 20

type garageUsageReader struct {
	endpoint *url.URL
	client   *http.Client
	token    string
}

func (r *garageUsageReader) BucketUsage(ctx context.Context, bucket string) (bucketUsage, error) {
	target := r.endpoint.JoinPath("v2", "GetBucketInfo")
	target.RawQuery = url.Values{"globalAlias": {bucket}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return bucketUsage{}, usageTransportError("GetBucketInfo", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Accept", "application/json")
	var answer struct {
		Objects *int64 `json:"objects"`
		Bytes   *int64 `json:"bytes"`
		Quotas  struct {
			MaxSize    *int64 `json:"maxSize"`
			MaxObjects *int64 `json:"maxObjects"`
		} `json:"quotas"`
	}
	if err := getUsageJSON(r.client, req, "GetBucketInfo", maxGarageUsageBytes, &answer); err != nil {
		return bucketUsage{}, err
	}
	usage := bucketUsage{UsedBytes: -1, UsedObjects: -1, AsOf: time.Now().UTC()}
	if answer.Bytes != nil {
		usage.UsedBytes = *answer.Bytes
	}
	if answer.Objects != nil {
		usage.UsedObjects = *answer.Objects
	}
	if answer.Quotas.MaxSize != nil && *answer.Quotas.MaxSize > 0 {
		usage.LimitBytes = *answer.Quotas.MaxSize
	}
	if answer.Quotas.MaxObjects != nil && *answer.Quotas.MaxObjects > 0 {
		usage.LimitObjects = *answer.Quotas.MaxObjects
	}
	return usage, nil
}
