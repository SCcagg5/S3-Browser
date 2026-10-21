package main

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// The usage reader of SeaweedFS: the master gives the sizes of the volumes, the filer gives the quota. Both requests
// have no credential: the master and the filer of SeaweedFS must be on a closed network.
//
// Measured on SeaweedFS 4.41:
//   - the master: GET /vol/status gives {"Volumes": {"DataCenters": {<dc>: {<rack>: {<node>: [volume, ...]}}}}}. A
//     volume has "Id", "Collection", "Size", "FileCount", "DeleteCount" and "DeletedByteCount". The volumes of a bucket
//     have the name of the bucket as their collection. The used bytes are the sum of Size - DeletedByteCount of these
//     volumes: the bytes of the deleted files stay in a volume until a compaction. "weed shell s3.bucket.list" gives
//     the same number as "logical". A replica of a volume has the same Id on another node: the reader counts each Id
//     one time. The volume servers send their sizes to the master every few seconds: the number comes with a delay.
//     The volumes count chunks, not objects: the number of objects is unknown.
//   - the filer: GET /buckets/<bucket>?metadata=true gives the entry of the bucket in JSON, with "Quota" in bytes. 0 is
//     no quota, and a negative value is a quota that "s3.bucket.quota -op=disable" turned off. An unknown bucket gives
//     404. The quota comes from "weed shell s3.bucket.quota -name=<bucket> -op=set -sizeMB=<n>".

// The size limits of the answers. A volume in /vol/status takes about 350 bytes: 16 MiB is about 45000 volumes.
const (
	maxSeaweedFSVolumeStatusBytes = 16 << 20
	maxSeaweedFSBucketEntryBytes  = 1 << 20
)

type seaweedfsUsageReader struct {
	master *url.URL
	filer  *url.URL
	client *http.Client
}

type seaweedfsVolume struct {
	ID               uint32 `json:"Id"`
	Collection       string `json:"Collection"`
	Size             int64  `json:"Size"`
	DeletedByteCount int64  `json:"DeletedByteCount"`
}

func (r *seaweedfsUsageReader) BucketUsage(ctx context.Context, bucket string) (bucketUsage, error) {
	used, err := r.usedBytes(ctx, bucket)
	if err != nil {
		return bucketUsage{}, err
	}
	limit, err := r.quota(ctx, bucket)
	if err != nil {
		return bucketUsage{}, err
	}
	return bucketUsage{UsedBytes: used, UsedObjects: -1, LimitBytes: limit, Approximate: true, AsOf: time.Now().UTC()}, nil
}

// usedBytes adds the logical size of each volume of the collection of the bucket, one time for each volume id.
func (r *seaweedfsUsageReader) usedBytes(ctx context.Context, bucket string) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.master.JoinPath("vol", "status").String(), nil)
	if err != nil {
		return 0, usageTransportError("volume status", err)
	}
	req.Header.Set("Accept", "application/json")
	var answer struct {
		Volumes struct {
			DataCenters map[string]map[string]map[string][]seaweedfsVolume `json:"DataCenters"`
		} `json:"Volumes"`
	}
	if err := getUsageJSON(r.client, req, "volume status", maxSeaweedFSVolumeStatusBytes, &answer); err != nil {
		return 0, err
	}
	sizes := make(map[uint32]int64)
	for _, racks := range answer.Volumes.DataCenters {
		for _, nodes := range racks {
			for _, volumes := range nodes {
				for _, volume := range volumes {
					if volume.Collection != bucket {
						continue
					}
					size := max(volume.Size-volume.DeletedByteCount, 0)
					sizes[volume.ID] = max(sizes[volume.ID], size)
				}
			}
		}
	}
	var total int64
	for _, size := range sizes {
		total += size
	}
	return total, nil
}

// quota reads the quota in the entry of the bucket at the filer. 0 is no quota.
func (r *seaweedfsUsageReader) quota(ctx context.Context, bucket string) (int64, error) {
	target := r.filer.JoinPath("buckets", bucket)
	target.RawQuery = url.Values{"metadata": {"true"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return 0, usageTransportError("bucket entry", err)
	}
	req.Header.Set("Accept", "application/json")
	var entry struct {
		Quota int64 `json:"Quota"`
	}
	if err := getUsageJSON(r.client, req, "bucket entry", maxSeaweedFSBucketEntryBytes, &entry); err != nil {
		return 0, err
	}
	return max(entry.Quota, 0), nil
}
