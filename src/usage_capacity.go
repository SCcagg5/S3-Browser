package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// The capacity of the storage behind the buckets, for the usage readers that can read it. The numbers are raw: the
// replication or the erasure code of the provider uses more than one byte of the disks for one byte of an object.
// Each request is a GET of the admin API of the usage block, with the same credentials and the same size limits.
//
// Measured on the test stack (each provider on a tmpfs of 4 GiB):
//   - Garage v2.4.1: GET /v2/GetClusterStatus gives "nodes": [{"id", "isUp", "role": {"zone", "capacity"} or null,
//     "dataPartition": {"available", "total"}, "metadataPartition": {...}}]. A node with a role stores data; a gateway
//     node has no capacity. The admin API does not give the replication factor (GetClusterLayout gives
//     "zoneRedundancy" only). /v1/status answers 400: v1 is no longer supported.
//   - SeaweedFS 4.41: the master gives no bytes of the disks: GET /dir/status gives the volume servers in
//     "Topology": {"DataCenters": [{"Racks": [{"DataNodes": [{"Url", "PublicUrl", "Max", ...}]}]}]} with the counts of
//     volumes. GET http://<volume server>/status gives "DiskStatuses": [{"dir", "all", "used", "free",
//     "percent_used"}]: the file system of each folder of the volume server. A volume server that listens on a
//     loopback address (127.0.0.1, as "weed server -ip=127.0.0.1" of the test stack) is on the host of the master: the
//     reader asks the host of the master, at the port of the volume server.
//   - MinIO RELEASE.2025-10-15T17-29-55Z: GET /minio/admin/v3/storageinfo gives "Disks": [{"state", "totalspace",
//     "usedspace", "availspace", ...}] and "Backend": {"StandardSCParity", ...}. "usedspace" + "availspace" can be less
//     than "totalspace": the file system keeps blocks for itself.

const (
	// maxCapacityAnswerBytes is the size limit of the answer of GetClusterStatus, /dir/status and /status.
	maxCapacityAnswerBytes = 1 << 20
	// maxMinIOStorageInfoBytes is the size limit of storageinfo: it has the metrics of each drive.
	maxMinIOStorageInfoBytes = 16 << 20
	// maxSeaweedFSVolumeServers is the largest number of volume servers that one read asks, capacityWorkers at a time.
	maxSeaweedFSVolumeServers = 64
	capacityWorkers           = 4
)

// --- Garage ---------------------------------------------------------------------------------------------------------

func (r *garageUsageReader) StorageCapacity(ctx context.Context) (storageCapacity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint.JoinPath("v2", "GetClusterStatus").String(), nil)
	if err != nil {
		return storageCapacity{}, usageTransportError("GetClusterStatus", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Accept", "application/json")
	var answer struct {
		Nodes []struct {
			IsUp bool `json:"isUp"`
			Role *struct {
				Capacity *int64 `json:"capacity"`
			} `json:"role"`
			DataPartition *struct {
				Available int64 `json:"available"`
				Total     int64 `json:"total"`
			} `json:"dataPartition"`
		} `json:"nodes"`
	}
	if err := getUsageJSON(r.client, req, "GetClusterStatus", maxCapacityAnswerBytes, &answer); err != nil {
		return storageCapacity{}, err
	}
	capacity := storageCapacity{Scope: storageScopeCluster, AsOf: time.Now().UTC()}
	counted, missing := 0, 0
	for _, node := range answer.Nodes {
		// A node without a role, or a gateway node (no capacity), stores no data.
		if node.Role == nil || node.Role.Capacity == nil {
			continue
		}
		if !node.IsUp || node.DataPartition == nil || node.DataPartition.Total <= 0 {
			missing++
			continue
		}
		counted++
		capacity.TotalBytes += node.DataPartition.Total
		capacity.FreeBytes += max(node.DataPartition.Available, 0)
	}
	if counted == 0 {
		return storageCapacity{}, fmt.Errorf("GetClusterStatus: no storage node gives its data partition")
	}
	capacity.UsedBytes = max(capacity.TotalBytes-capacity.FreeBytes, 0)
	capacity.Note = fmt.Sprintf("raw capacity of the data partitions of %s, before the replication (the admin API does not give the replication factor)", plural(counted, "storage node"))
	if missing > 0 {
		capacity.Approximate = true
		capacity.Reason = fmt.Sprintf("%s did not give a data partition: %s not counted.", plural(missing, "storage node"), pronoun(missing))
	}
	return capacity, nil
}

// --- SeaweedFS ------------------------------------------------------------------------------------------------------

type seaweedfsDiskStatus struct {
	Dir  string `json:"dir"`
	All  int64  `json:"all"`
	Used int64  `json:"used"`
	Free int64  `json:"free"`
}

func (r *seaweedfsUsageReader) StorageCapacity(ctx context.Context) (storageCapacity, error) {
	servers, err := r.volumeServers(ctx)
	if err != nil {
		return storageCapacity{}, err
	}
	if len(servers) == 0 {
		return storageCapacity{}, fmt.Errorf("volume servers: the master knows no volume server")
	}
	asked := servers
	if len(asked) > maxSeaweedFSVolumeServers {
		asked = asked[:maxSeaweedFSVolumeServers]
	}
	disks := make([][]seaweedfsDiskStatus, len(asked))
	failed := make([]bool, len(asked))
	work := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < capacityWorkers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range work {
				status, err := r.diskStatus(ctx, asked[index])
				disks[index], failed[index] = status, err != nil
			}
		}()
	}
	for index := range asked {
		work <- index
	}
	close(work)
	wg.Wait()
	capacity := storageCapacity{Scope: storageScopeDisks, AsOf: time.Now().UTC()}
	counted, missing := 0, 0
	for index := range asked {
		if failed[index] {
			missing++
			continue
		}
		counted++
		seen := make(map[string]bool)
		for _, disk := range disks[index] {
			if disk.All <= 0 || seen[disk.Dir] {
				continue
			}
			seen[disk.Dir] = true
			capacity.TotalBytes += disk.All
			capacity.UsedBytes += max(disk.Used, 0)
			capacity.FreeBytes += max(disk.Free, 0)
		}
	}
	if counted == 0 || capacity.TotalBytes == 0 {
		return storageCapacity{}, fmt.Errorf("volume server status: no volume server gives its disks")
	}
	capacity.Note = fmt.Sprintf("raw capacity of the disks of %s, before the replication", plural(counted, "volume server"))
	switch {
	case missing > 0:
		capacity.Approximate = true
		capacity.Reason = fmt.Sprintf("%s did not answer: %s not counted.", plural(missing, "volume server"), pronoun(missing))
	case len(servers) > len(asked):
		capacity.Approximate = true
		capacity.Reason = fmt.Sprintf("Stowr asks %d volume servers at most: %d are not counted.", maxSeaweedFSVolumeServers, len(servers)-len(asked))
	}
	return capacity, nil
}

// volumeServers gives the address (host:port) of each volume server of the master, one time each. A loopback address
// is the host of the master, at the port of the volume server.
func (r *seaweedfsUsageReader) volumeServers(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.master.JoinPath("dir", "status").String(), nil)
	if err != nil {
		return nil, usageTransportError("master status", err)
	}
	req.Header.Set("Accept", "application/json")
	var answer struct {
		Topology struct {
			DataCenters []struct {
				Racks []struct {
					DataNodes []struct {
						URL       string `json:"Url"`
						PublicURL string `json:"PublicUrl"`
					} `json:"DataNodes"`
				} `json:"Racks"`
			} `json:"DataCenters"`
		} `json:"Topology"`
	}
	if err := getUsageJSON(r.client, req, "master status", maxCapacityAnswerBytes, &answer); err != nil {
		return nil, err
	}
	var servers []string
	seen := make(map[string]bool)
	for _, center := range answer.Topology.DataCenters {
		for _, rack := range center.Racks {
			for _, node := range rack.DataNodes {
				address := node.URL
				if address == "" {
					address = node.PublicURL
				}
				host, port, err := net.SplitHostPort(address)
				if err != nil || port == "" {
					continue
				}
				if ip := net.ParseIP(host); host == "localhost" || ip != nil && ip.IsLoopback() {
					host = r.master.Hostname()
				}
				address = net.JoinHostPort(host, port)
				if !seen[address] {
					seen[address] = true
					servers = append(servers, address)
				}
			}
		}
	}
	return servers, nil
}

// diskStatus reads the disks of one volume server, with the scheme of the master.
func (r *seaweedfsUsageReader) diskStatus(ctx context.Context, address string) ([]seaweedfsDiskStatus, error) {
	target := url.URL{Scheme: r.master.Scheme, Host: address, Path: "/status"}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, usageTransportError("volume server status", err)
	}
	req.Header.Set("Accept", "application/json")
	var answer struct {
		DiskStatuses []seaweedfsDiskStatus `json:"DiskStatuses"`
	}
	if err := getUsageJSON(r.client, req, "volume server status", maxCapacityAnswerBytes, &answer); err != nil {
		return nil, err
	}
	return answer.DiskStatuses, nil
}

// --- MinIO ----------------------------------------------------------------------------------------------------------

func (r *minioUsageReader) StorageCapacity(ctx context.Context) (storageCapacity, error) {
	var answer struct {
		Disks []struct {
			State      string `json:"state"`
			TotalSpace int64  `json:"totalspace"`
			UsedSpace  int64  `json:"usedspace"`
			AvailSpace int64  `json:"availspace"`
		} `json:"Disks"`
		Backend struct {
			StandardSCParity int `json:"StandardSCParity"`
		} `json:"Backend"`
	}
	if err := r.get(ctx, "storageinfo", nil, maxMinIOStorageInfoBytes, &answer); err != nil {
		return storageCapacity{}, err
	}
	capacity := storageCapacity{Scope: storageScopeDisks, AsOf: time.Now().UTC()}
	counted, missing := 0, 0
	for _, disk := range answer.Disks {
		if disk.State != "ok" || disk.TotalSpace <= 0 {
			missing++
			continue
		}
		counted++
		capacity.TotalBytes += disk.TotalSpace
		capacity.UsedBytes += max(disk.UsedSpace, 0)
		capacity.FreeBytes += max(disk.AvailSpace, 0)
	}
	if counted == 0 {
		return storageCapacity{}, fmt.Errorf("storageinfo: no drive is online")
	}
	capacity.Note = fmt.Sprintf("raw capacity of %s, before the erasure code", plural(counted, "drive"))
	if parity := answer.Backend.StandardSCParity; parity > 0 {
		capacity.Note += fmt.Sprintf(" (parity EC:%d)", parity)
	}
	if missing > 0 {
		capacity.Approximate = true
		capacity.Reason = fmt.Sprintf("%s %s offline: %s not counted.", plural(missing, "drive"), map[bool]string{true: "is", false: "are"}[missing == 1], pronoun(missing))
	}
	return capacity, nil
}

// plural gives "1 node" or "3 nodes".
func plural(count int, noun string) string {
	if count == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", count, noun)
}

// pronoun gives "it is" or "they are" for a count.
func pronoun(count int) string {
	if count == 1 {
		return "it is"
	}
	return "they are"
}
