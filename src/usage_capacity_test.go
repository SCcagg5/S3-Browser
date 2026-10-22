package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The answers of the admin APIs come from the test stack (refer to usage_capacity.go). The numbers change.

const garageClusterStatus = `{
  "layoutVersion": 1,
  "nodes": [
    {"id": "c44aa6c7", "garageVersion": "v2.4.1", "addr": "10.0.0.1:3901", "hostname": "n1", "isUp": true, "lastSeenSecsAgo": null,
     "role": {"zone": "dc1", "tags": [], "capacity": 1000000000}, "draining": false,
     "dataPartition": {"available": 3000, "total": 4000}, "metadataPartition": {"available": 3000, "total": 4000}},
    {"id": "d55bb7d8", "garageVersion": "v2.4.1", "addr": "10.0.0.2:3901", "hostname": "n2", "isUp": true, "lastSeenSecsAgo": null,
     "role": {"zone": "dc2", "tags": [], "capacity": 1000000000}, "draining": false,
     "dataPartition": {"available": 1000, "total": 6000}, "metadataPartition": {"available": 1000, "total": 6000}},
    {"id": "e66cc8e9", "garageVersion": "v2.4.1", "addr": "10.0.0.3:3901", "hostname": "gw", "isUp": true, "lastSeenSecsAgo": null,
     "role": {"zone": "dc1", "tags": [], "capacity": null}, "draining": false,
     "dataPartition": {"available": 99999, "total": 99999}, "metadataPartition": null}
  ]
}`

func TestGarageStorageCapacityAddsTheDataPartitionsOfTheStorageNodes(t *testing.T) {
	t.Parallel()
	fake, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, garageClusterStatus))
	capacity, err := newTestGarageReader(server).StorageCapacity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if capacity.Scope != storageScopeCluster || capacity.TotalBytes != 10000 || capacity.FreeBytes != 4000 || capacity.UsedBytes != 6000 || capacity.Approximate {
		t.Fatalf("capacity = %+v", capacity)
	}
	if !strings.Contains(capacity.Note, "2 storage nodes") || !strings.Contains(capacity.Note, "before the replication") {
		t.Fatalf("note = %q", capacity.Note)
	}
	requests := fake.seen()
	if len(requests) != 1 || requests[0].path != "/v2/GetClusterStatus" || requests[0].header.Get("Authorization") != "Bearer "+garageToken {
		t.Fatalf("requests = %+v", requests)
	}
	// A storage node that is down is not counted: the numbers are approximate.
	down := strings.Replace(garageClusterStatus, `"hostname": "n2", "isUp": true`, `"hostname": "n2", "isUp": false`, 1)
	_, server = newFakeAdminAPI(t, jsonAnswer(http.StatusOK, down))
	capacity, err = newTestGarageReader(server).StorageCapacity(context.Background())
	if err != nil || capacity.TotalBytes != 4000 || !capacity.Approximate || capacity.Reason != "1 storage node did not give a data partition: it is not counted." {
		t.Fatalf("capacity with a node down = %+v, %v", capacity, err)
	}
	_, server = newFakeAdminAPI(t, jsonAnswer(http.StatusOK, `{"layoutVersion": 0, "nodes": []}`))
	if _, err := newTestGarageReader(server).StorageCapacity(context.Background()); err == nil {
		t.Fatal("a cluster without a storage node gives a capacity")
	}
	_, server = newFakeAdminAPI(t, jsonAnswer(http.StatusForbidden, `{"code":"AccessDenied","message":"Forbidden"}`))
	_, err = newTestGarageReader(server).StorageCapacity(context.Background())
	if err == nil {
		t.Fatal("a refused token gives a capacity")
	}
	checkNoSecret(t, err, garageToken, server.URL)
}

// seaweedVolumeServerStatus is the answer of GET /status of a volume server of SeaweedFS 4.41.
const seaweedVolumeServerStatus = `{"DiskStatuses":[{"dir":"/data","all":4294967296,"used":131072,"free":4294836224,"percent_free":99.99695,"percent_used":0.0030517578},` +
	`{"dir":"/data","all":4294967296,"used":131072,"free":4294836224,"percent_free":99.99695,"percent_used":0.0030517578},` +
	`{"dir":"/ssd","all":1000,"used":600,"free":400,"percent_free":40,"percent_used":60}],"Version":"30GB 4.41 de34a1a8","Volumes":null}`

// seaweedDirStatus gives the answer of GET /dir/status of the master with volume servers at these addresses.
func seaweedDirStatus(addresses ...string) string {
	nodes := make([]string, 0, len(addresses))
	for _, address := range addresses {
		nodes = append(nodes, fmt.Sprintf(`{"Url":%q,"PublicUrl":%q,"Volumes":0,"EcShards":0,"Max":30,"VolumeIds":" "}`, address, address))
	}
	return `{"Topology":{"Max":30,"Free":30,"DataCenters":[{"Id":"DefaultDataCenter","Racks":[{"Id":"DefaultRack","DataNodes":[` +
		strings.Join(nodes, ",") + `]}]}],"Layouts":null},"TopologyId":"a009a099","Version":"30GB 4.41 de34a1a8"}`
}

func TestSeaweedFSStorageCapacityAsksEachVolumeServerOfTheMaster(t *testing.T) {
	t.Parallel()
	volumeFake, volume := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, seaweedVolumeServerStatus))
	volumeURL, _ := url.Parse(volume.URL)
	// The volume server gives the loopback address of "weed server -ip=127.0.0.1": the reader asks the host of the
	// master at that port. A second volume server does not answer.
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL, _ := url.Parse(closed.URL)
	closed.Close()
	masterFake, master := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, seaweedDirStatus("localhost:"+volumeURL.Port(), volumeURL.Host, closedURL.Host)))
	masterURL, _ := parseStorageEndpoint("usage", master.URL)
	reader := &seaweedfsUsageReader{master: masterURL, client: master.Client()}
	capacity, err := reader.StorageCapacity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if capacity.Scope != storageScopeDisks || capacity.TotalBytes != 4294968296 || capacity.UsedBytes != 131672 || capacity.FreeBytes != 4294836624 {
		t.Fatalf("capacity = %+v", capacity)
	}
	if !capacity.Approximate || capacity.Reason != "1 volume server did not answer: it is not counted." || !strings.Contains(capacity.Note, "1 volume server") {
		t.Fatalf("capacity with a closed volume server = %+v", capacity)
	}
	if requests := masterFake.seen(); len(requests) != 1 || requests[0].path != "/dir/status" {
		t.Fatalf("master requests = %+v", requests)
	}
	if requests := volumeFake.seen(); len(requests) != 1 || requests[0].path != "/status" {
		t.Fatalf("volume server requests = %+v", requests)
	}
	_, empty := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, seaweedDirStatus()))
	emptyURL, _ := parseStorageEndpoint("usage", empty.URL)
	if _, err := (&seaweedfsUsageReader{master: emptyURL, client: empty.Client()}).StorageCapacity(context.Background()); err == nil {
		t.Fatal("a master without a volume server gives a capacity")
	}
}

// minioStorageInfo is the answer of GET /minio/admin/v3/storageinfo of MinIO RELEASE.2025-10-15T17-29-55Z, with a
// second drive that is offline and a parity of 2.
const minioStorageInfo = `{"Disks":[{"endpoint":"/data","path":"/data","state":"ok","uuid":"359b0251","major":0,"minor":391,"totalspace":4294967296,"usedspace":45056,"availspace":4294922240,` +
	`"metrics":{"lastMinute":{"DiskInfo":{"count":15,"acc_time_ns":142464}},"apiCalls":{"DiskInfo":16}},"used_inodes":13,"free_inodes":105698247,"local":true,"pool_index":0,"set_index":0,"disk_index":0},` +
	`{"endpoint":"/data2","path":"/data2","state":"offline","uuid":"","totalspace":0,"usedspace":0,"availspace":0}],` +
	`"Backend":{"Type":2,"GatewayOnline":false,"OnlineDisks":null,"OfflineDisks":null,"StandardSCData":[1],"StandardSCParities":null,"RRSCData":[1],"RRSCParities":null,"TotalSets":[1],"DrivesPerSet":[2],"StandardSCParity":2,"RRSCParity":0}}`

func TestMinIOStorageCapacityAddsTheOnlineDrives(t *testing.T) {
	t.Parallel()
	fake, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, minioStorageInfo))
	endpoint, _ := parseStorageEndpoint("usage", server.URL)
	reader := &minioUsageReader{endpoint: endpoint, client: server.Client(), region: "us-east-1", creds: s3Credentials{AccessKeyID: minioKey, SecretAccessKey: "minio-secret-value"}}
	capacity, err := reader.StorageCapacity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if capacity.Scope != storageScopeDisks || capacity.TotalBytes != 4294967296 || capacity.UsedBytes != 45056 || capacity.FreeBytes != 4294922240 {
		t.Fatalf("capacity = %+v", capacity)
	}
	if capacity.Note != "raw capacity of 1 drive, before the erasure code (parity EC:2)" || !capacity.Approximate || capacity.Reason != "1 drive is offline: it is not counted." {
		t.Fatalf("capacity = %+v", capacity)
	}
	requests := fake.seen()
	if len(requests) != 1 || requests[0].path != "/minio/admin/v3/storageinfo" || !strings.HasPrefix(requests[0].header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential="+minioKey+"/") {
		t.Fatalf("requests = %+v", requests)
	}
	_, server = newFakeAdminAPI(t, jsonAnswer(http.StatusForbidden, `{"Code":"AccessDenied","Message":"Access Denied."}`))
	endpoint, _ = parseStorageEndpoint("usage", server.URL)
	reader.endpoint = endpoint
	_, err = reader.StorageCapacity(context.Background())
	if err == nil {
		t.Fatal("a refused key gives a capacity")
	}
	checkNoSecret(t, err, "minio-secret-value", server.URL)
}

// capacityReader is a usage reader with a storage part for the tests of the answer.
type capacityReader struct {
	value      bucketUsage
	err        error
	storage    storageCapacity
	storageErr error
}

func (r *capacityReader) BucketUsage(context.Context, string) (bucketUsage, error) {
	return r.value, r.err
}
func (r *capacityReader) StorageCapacity(context.Context) (storageCapacity, error) {
	return r.storage, r.storageErr
}

func TestUsageAnswerTakesTheMoreConstrainingPart(t *testing.T) {
	t.Parallel()
	storage := func(used, total int64) storageCapacity {
		return storageCapacity{Scope: storageScopeCluster, UsedBytes: used, TotalBytes: total, FreeBytes: total - used, Note: "raw"}
	}
	for name, test := range map[string]struct {
		reader     *capacityReader
		percent    float64
		level      string
		constraint string
		quota      float64
	}{
		"storage over quota":  {&capacityReader{value: bucketUsage{UsedBytes: 50, LimitBytes: 100}, storage: storage(910, 1000)}, 91, "warning", "storage", 50},
		"quota over storage":  {&capacityReader{value: bucketUsage{UsedBytes: 93, LimitBytes: 100}, storage: storage(100, 1000)}, 93, "warning", "quota", 93},
		"no quota":            {&capacityReader{value: bucketUsage{UsedBytes: 93}, storage: storage(960, 1000)}, 96, "error", "storage", 0},
		"no limit at all":     {&capacityReader{value: bucketUsage{UsedBytes: 93}, storageErr: errors.New("down")}, 0, "", "", 0},
		"bucket part failed":  {&capacityReader{err: errors.New("GetBucketInfo: down"), storage: storage(500, 1000)}, 50, "ok", "storage", 0},
		"storage part failed": {&capacityReader{value: bucketUsage{UsedBytes: 10, LimitBytes: 100}, storageErr: errors.New("GetClusterStatus: down")}, 10, "ok", "quota", 10},
	} {
		instance := usageInstance(test.reader)
		answer := usageAnswerOf(instance, instance.usageRead(context.Background(), false))
		if answer.Percent != test.percent || answer.Level != test.level || answer.Constraint != test.constraint || answer.QuotaPercent != test.quota {
			t.Fatalf("%s: answer = %+v", name, answer)
		}
		if (test.reader.err != nil) != (answer.Error != nil) || (test.reader.err != nil) == answer.Available {
			t.Fatalf("%s: the bucket part = %+v", name, answer)
		}
		if (test.reader.storageErr != nil) != (answer.StorageError != nil) || (test.reader.storageErr != nil) == (answer.Storage != nil) {
			t.Fatalf("%s: the storage part = %+v %+v", name, answer.Storage, answer.StorageError)
		}
		if answer.Storage != nil && (answer.Storage.FreeBytes != answer.Storage.TotalBytes-answer.Storage.UsedBytes || answer.Storage.Note != "raw") {
			t.Fatalf("%s: storage = %+v", name, answer.Storage)
		}
	}
	// A reader without a storage part gives no storage.
	instance := usageInstance(&fakeUsageReader{})
	if answer := usageAnswerOf(instance, instance.usageRead(context.Background(), false)); answer.Storage != nil || answer.StorageError != nil || answer.Constraint != "quota" {
		t.Fatalf("answer without a storage part = %+v", answer)
	}
}

func TestUsageCacheKeepsAFailedPartForTheRetryIntervalOnly(t *testing.T) {
	clock := &usageClock{now: time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)}
	previous := timeNowUTC
	timeNowUTC = clock.get
	t.Cleanup(func() { timeNowUTC = previous })
	reader := &capacityReader{value: bucketUsage{UsedBytes: 1}, storageErr: errors.New("down")}
	instance := usageInstance(reader)
	if result := instance.usageRead(context.Background(), false); result.storageErr == nil || result.err != nil {
		t.Fatalf("result = %+v", result)
	}
	reader.storageErr, reader.storage = nil, storageCapacity{TotalBytes: 10, UsedBytes: 5}
	clock.advance(usageRetryInterval / 2)
	if result := instance.usageRead(context.Background(), false); result.storage != nil {
		t.Fatal("the cache did not keep the failed read for the retry interval")
	}
	clock.advance(usageRetryInterval)
	if result := instance.usageRead(context.Background(), false); result.storage == nil || result.storage.TotalBytes != 10 {
		t.Fatalf("the cache kept a failure longer than the retry interval: %+v", result)
	}
}

func TestVolumeSizerCountsTheFilesInTheBackground(t *testing.T) {
	t.Parallel()
	base := volumeTempDir(t)
	root := filepath.Join(base, "volume")
	writeVolumeFile(t, base, "outside/big.bin", strings.Repeat("x", 5000))
	writeVolumeFile(t, root, "a.txt", "12345")
	writeVolumeFile(t, root, "deep/b.txt", "1234567890")
	writeVolumeFile(t, root, "deep/.hidden", "123")
	writeVolumeFile(t, root, "deep/.s3b-tmp-0123456789abcdef0123456789abcdef-part.bin", strings.Repeat("t", 1000))
	if err := os.Symlink(filepath.Join(base, "outside"), filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("a.txt", filepath.Join(root, "again")); err != nil {
		t.Fatal(err)
	}
	sizer := newVolumeSizer(root)
	done := sizer.wait()
	if first := sizer.snapshot(); first.state != volumeSizeComputing {
		t.Fatalf("the first read = %+v", first)
	}
	<-done
	count := sizer.snapshot()
	// The links are not followed, and the temporary file of an upload is not counted.
	if count.state != volumeSizeReady || count.bytes != 18 || count.files != 3 {
		t.Fatalf("count = %+v", count)
	}
	// The count stays: no new walk without a change.
	if again := sizer.snapshot(); again.state != volumeSizeReady {
		t.Fatalf("second read = %+v", again)
	}
	// A write makes the count old: the next read starts a new walk.
	writeVolumeFile(t, root, "c.txt", "1234567")
	done = sizer.wait()
	sizer.invalidate()
	if next := sizer.snapshot(); next.state != volumeSizeComputing {
		t.Fatalf("read after a change = %+v", next)
	}
	<-done
	if count := sizer.snapshot(); count.bytes != 25 || count.files != 4 {
		t.Fatalf("count after a change = %+v", count)
	}
	// A walk that reaches its budget gives "partial": at least the count.
	small := newVolumeSizer(root)
	small.entries = 3
	done = small.wait()
	small.snapshot()
	<-done
	if count := small.snapshot(); count.state != volumeSizePartial || count.files >= 4 {
		t.Fatalf("count with a budget = %+v", count)
	}
}

func TestVolumeUsageGivesTheFolderAndItsFileSystem(t *testing.T) {
	t.Parallel()
	root := volumeTempDir(t)
	writeVolumeFile(t, root, "report.txt", strings.Repeat("r", 1200))
	app := volumeTestApplication(t, root, "")
	instance, backend := volumeInstance(t, app)
	reader := instance.usage.reader.(*volumeUsageReader)
	reader.statfs = func(string) (uint64, uint64, bool, error) { return 1000, 90, true, nil }
	done := backend.sizer.wait()
	backend.sizer.snapshot()
	<-done
	answer := usageAnswerOf(instance, instance.usageRead(context.Background(), false))
	if !answer.Available || answer.SelfBytes == nil || *answer.SelfBytes != 1200 || answer.SelfState != volumeSizeReady || answer.UsedObjects != 1 || answer.LimitBytes != 0 {
		t.Fatalf("answer = %+v", answer)
	}
	storage := answer.Storage
	if storage == nil || storage.Scope != storageScopeFilesystem || storage.TotalBytes != 1000 || storage.UsedBytes != 910 || storage.FreeBytes != 90 ||
		storage.Percent != 91 || !storage.Approximate || storage.ApproximateReason != volumeDelayedReason {
		t.Fatalf("storage = %+v", storage)
	}
	if answer.Percent != 91 || answer.Level != "warning" || answer.Constraint != "storage" {
		t.Fatalf("answer = %+v", answer)
	}
	// An upload makes the count of the folder old.
	if got := gatewayRequest(t, app, http.MethodPut, "more.txt", []byte("12345"), nil); got.Code != http.StatusNoContent {
		t.Fatalf("PUT = %d", got.Code)
	}
	done = backend.sizer.wait()
	if next := usageAnswerOf(instance, instance.usageRead(context.Background(), false)); next.SelfState != volumeSizeComputing {
		t.Fatalf("answer after an upload = %+v", next)
	}
	<-done
	if next := usageAnswerOf(instance, instance.usageRead(context.Background(), false)); *next.SelfBytes != 1205 {
		t.Fatalf("answer after the walk = %+v", next)
	}
}
