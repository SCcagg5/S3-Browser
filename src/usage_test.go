package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- Helpers --------------------------------------------------------------------------------------------------------

// usageRequest is one request that a fake admin API received.
type usageRequest struct {
	method string
	path   string
	query  string
	header http.Header
}

// fakeAdminAPI is an admin API for the reader tests. The handler gets each request. The fake records it first.
type fakeAdminAPI struct {
	mu       sync.Mutex
	requests []usageRequest
}

func (f *fakeAdminAPI) record(r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, usageRequest{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, header: r.Header.Clone()})
}

func (f *fakeAdminAPI) seen() []usageRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]usageRequest(nil), f.requests...)
}

// newFakeAdminAPI starts a server. The handler answers each request.
func newFakeAdminAPI(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*fakeAdminAPI, *httptest.Server) {
	t.Helper()
	fake := &fakeAdminAPI{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.record(r)
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return fake, server
}

// jsonAnswer gives a handler that sends a status and a body.
func jsonAnswer(status int, body string) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = fmt.Fprint(w, body)
	}
}

// checkNoSecret makes sure that an error shows neither a URL nor a secret.
func checkNoSecret(t *testing.T, err error, forbidden ...string) {
	t.Helper()
	for _, text := range forbidden {
		if text != "" && strings.Contains(err.Error(), text) {
			t.Fatalf("the error shows %q: %v", text, err)
		}
	}
	if strings.Contains(err.Error(), "http://") || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("the error shows a URL: %v", err)
	}
}

// --- Garage ---------------------------------------------------------------------------------------------------------

const (
	garageToken  = "garage-admin-token-value"
	garageAnswer = `{"id":"7a9c1f","globalAliases":["default"],"localAliases":[],"websiteAccess":false,"keys":[],"objects":3,"bytes":1500,"unfinishedUploads":0,"unfinishedMultipartUploads":0,"unfinishedMultipartUploadParts":0,"unfinishedMultipartUploadBytes":0,"quotas":{"maxSize":21474836480,"maxObjects":100000}}`
)

func newTestGarageReader(server *httptest.Server) *garageUsageReader {
	endpoint, _ := parseStorageEndpoint("usage", server.URL)
	return &garageUsageReader{endpoint: endpoint, client: server.Client(), token: garageToken}
}

func TestGarageUsageReaderReadsTheUsageAndTheQuota(t *testing.T) {
	fake, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, garageAnswer))
	usage, err := newTestGarageReader(server).BucketUsage(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	if usage.UsedBytes != 1500 || usage.UsedObjects != 3 || usage.LimitBytes != 21474836480 || usage.LimitObjects != 100000 || usage.Approximate {
		t.Fatalf("usage = %+v", usage)
	}
	if usage.AsOf.IsZero() {
		t.Fatal("AsOf is not set")
	}
	requests := fake.seen()
	if len(requests) != 1 {
		t.Fatalf("requests = %+v", requests)
	}
	got := requests[0]
	if got.method != http.MethodGet || got.path != "/v2/GetBucketInfo" || got.query != "globalAlias=default" {
		t.Fatalf("request = %+v", got)
	}
	if got.header.Get("Authorization") != "Bearer "+garageToken {
		t.Fatalf("Authorization = %q", got.header.Get("Authorization"))
	}
}

func TestGarageUsageReaderEscapesTheBucketName(t *testing.T) {
	fake, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, garageAnswer))
	if _, err := newTestGarageReader(server).BucketUsage(context.Background(), "a&b=c d"); err != nil {
		t.Fatal(err)
	}
	if got := fake.seen()[0].query; got != "globalAlias=a%26b%3Dc+d" {
		t.Fatalf("query = %q", got)
	}
}

// A quota of null is no limit. A missing counter is -1.
func TestGarageUsageReaderWithoutQuota(t *testing.T) {
	for name, body := range map[string]string{
		"null quotas": `{"objects":3,"bytes":1500,"quotas":null}`,
		"null limits": `{"objects":3,"bytes":1500,"quotas":{"maxSize":null,"maxObjects":null}}`,
		"zero limits": `{"objects":3,"bytes":1500,"quotas":{"maxSize":0,"maxObjects":0}}`,
		"no quotas":   `{"objects":3,"bytes":1500}`,
	} {
		_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, body))
		usage, err := newTestGarageReader(server).BucketUsage(context.Background(), "default")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if usage.LimitBytes != 0 || usage.LimitObjects != 0 || usage.UsedBytes != 1500 || usage.UsedObjects != 3 {
			t.Fatalf("%s: usage = %+v", name, usage)
		}
	}
	_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, `{}`))
	usage, err := newTestGarageReader(server).BucketUsage(context.Background(), "default")
	if err != nil || usage.UsedBytes != -1 || usage.UsedObjects != -1 {
		t.Fatalf("usage = %+v, err = %v", usage, err)
	}
}

// A refusal names the step and the HTTP status. It never shows the URL or the token.
func TestGarageUsageReaderErrorsHideTheURLAndTheToken(t *testing.T) {
	for _, test := range []struct {
		status int
		body   string
		want   string
	}{
		{http.StatusForbidden, `{"code":"AccessDenied","message":"token ` + garageToken + `"}`, "HTTP 403"},
		{http.StatusUnauthorized, ``, "HTTP 401"},
		{http.StatusNotFound, `{"code":"NoSuchBucket","message":"Bucket not found"}`, "HTTP 404"},
		{http.StatusInternalServerError, `oops`, "HTTP 500"},
	} {
		_, server := newFakeAdminAPI(t, jsonAnswer(test.status, test.body))
		_, err := newTestGarageReader(server).BucketUsage(context.Background(), "default")
		if err == nil {
			t.Fatalf("%d: no error", test.status)
		}
		if !strings.Contains(err.Error(), test.want) || !strings.Contains(err.Error(), "GetBucketInfo") {
			t.Fatalf("%d: error = %v, want %q", test.status, err, test.want)
		}
		checkNoSecret(t, err, server.URL, garageToken)
		var httpError *usageHTTPError
		if !errors.As(err, &httpError) || httpError.Status != test.status {
			t.Fatalf("%d: error is not a usageHTTPError: %#v", test.status, err)
		}
	}
}

func TestUsageHTTPErrorTexts(t *testing.T) {
	t.Parallel()
	for status, want := range map[int]string{
		http.StatusUnauthorized: "refused the credentials (HTTP 401)",
		http.StatusForbidden:    "refused the credentials (HTTP 403)",
		http.StatusNotFound:     "does not know the bucket (HTTP 404)",
		http.StatusBadGateway:   "answered HTTP 502",
	} {
		err := &usageHTTPError{Step: "step", Status: status}
		if !strings.HasPrefix(err.Error(), "step: ") || !strings.Contains(err.Error(), want) {
			t.Fatalf("%d: %q, want %q", status, err.Error(), want)
		}
	}
}

// --- SeaweedFS ------------------------------------------------------------------------------------------------------

const seaweedVolumes = `{"Version":"30GB 4.41","Volumes":{"DataCenters":{"DefaultDataCenter":{"DefaultRack":{"127.0.0.1:8080":[` +
	`{"Id":2,"Size":1000120,"Collection":"default","FileCount":1,"DeleteCount":1,"DeletedByteCount":1000045,"ReadOnly":false},` +
	`{"Id":3,"Size":1000088,"Collection":"default","FileCount":1,"DeleteCount":0,"DeletedByteCount":0,"ReadOnly":false},` +
	`{"Id":9,"Size":8,"Collection":"","FileCount":1,"DeleteCount":0,"DeletedByteCount":0},` +
	`{"Id":10,"Size":777,"Collection":"other","FileCount":1,"DeleteCount":0,"DeletedByteCount":0}` +
	`]}}},"Free":23,"Max":30}}`

const seaweedBucketEntry = `{"FullPath":"/buckets/default","Mtime":"2026-10-21T10:00:00Z","Crtime":"2026-10-21T10:00:00Z","Mode":2147484141,"Uid":0,"Gid":0,"Mime":"","Replication":"","Collection":"default","TtlSec":0,"UserName":"","GroupNames":null,"SymlinkTarget":"","Md5":null,"FileSize":0,"Extended":null,"HardLinkId":null,"HardLinkCounter":0,"Content":null,"Remote":null,"Quota":21474836480}`

// seaweedAPIs starts a master and a filer. The answers are the arguments.
func seaweedAPIs(t *testing.T, volumes, entry string) (*seaweedfsUsageReader, *fakeAdminAPI, *fakeAdminAPI) {
	t.Helper()
	masterFake, master := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, volumes))
	filerFake, filer := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, entry))
	masterURL, _ := parseStorageEndpoint("usage", master.URL)
	filerURL, _ := parseStorageEndpoint("usage", filer.URL)
	return &seaweedfsUsageReader{master: masterURL, filer: filerURL, client: master.Client()}, masterFake, filerFake
}

func TestSeaweedFSUsageReaderReadsTheVolumesAndTheQuota(t *testing.T) {
	reader, masterFake, filerFake := seaweedAPIs(t, seaweedVolumes, seaweedBucketEntry)
	usage, err := reader.BucketUsage(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	// (1000120 - 1000045) + 1000088. The collections "other" and "" are not counted.
	if usage.UsedBytes != 75+1000088 || usage.UsedObjects != -1 || usage.LimitBytes != 21474836480 || usage.LimitObjects != 0 || !usage.Approximate {
		t.Fatalf("usage = %+v", usage)
	}
	if usage.AsOf.IsZero() {
		t.Fatal("AsOf is not set")
	}
	master := masterFake.seen()
	if len(master) != 1 || master[0].method != http.MethodGet || master[0].path != "/vol/status" {
		t.Fatalf("master requests = %+v", master)
	}
	filer := filerFake.seen()
	if len(filer) != 1 || filer[0].method != http.MethodGet || filer[0].path != "/buckets/default" || filer[0].query != "metadata=true" {
		t.Fatalf("filer requests = %+v", filer)
	}
	for _, request := range append(master, filer...) {
		if request.header.Get("Authorization") != "" {
			t.Fatalf("the request has a credential: %+v", request)
		}
	}
}

// A replica has the same id on a second node. The reader counts each id one time.
func TestSeaweedFSUsageReaderCountsAReplicaOneTime(t *testing.T) {
	volumes := `{"Volumes":{"DataCenters":{"dc1":{"rack1":{"10.0.0.1:8080":[{"Id":2,"Size":1000,"Collection":"default","DeletedByteCount":100}]},` +
		`"rack2":{"10.0.0.2:8080":[{"Id":2,"Size":1000,"Collection":"default","DeletedByteCount":100},{"Id":4,"Size":50,"Collection":"default","DeletedByteCount":0}]}},` +
		`"dc2":{"rack1":{"10.0.1.1:8080":[{"Id":2,"Size":1000,"Collection":"default","DeletedByteCount":100}]}}}}}`
	reader, _, _ := seaweedAPIs(t, volumes, seaweedBucketEntry)
	usage, err := reader.BucketUsage(context.Background(), "default")
	if err != nil || usage.UsedBytes != 900+50 {
		t.Fatalf("usage = %+v, err = %v", usage, err)
	}
}

// A node without a volume (null), no node and no data center give 0 bytes.
func TestSeaweedFSUsageReaderAcceptsEmptyVolumeLists(t *testing.T) {
	for name, volumes := range map[string]string{
		"null node list": `{"Volumes":{"DataCenters":{"dc":{"rack":{"127.0.0.1:8080":null}}}}}`,
		"no node":        `{"Volumes":{"DataCenters":{"dc":{"rack":{}}}}}`,
		"no data center": `{"Volumes":{"DataCenters":{}}}`,
		"null centers":   `{"Volumes":{"DataCenters":null}}`,
		"no volumes":     `{"Version":"30GB 4.41"}`,
	} {
		reader, _, _ := seaweedAPIs(t, volumes, seaweedBucketEntry)
		usage, err := reader.BucketUsage(context.Background(), "default")
		if err != nil || usage.UsedBytes != 0 || usage.LimitBytes != 21474836480 {
			t.Fatalf("%s: usage = %+v, err = %v", name, usage, err)
		}
	}
}

// A negative logical size (more deleted bytes than size) counts as 0.
func TestSeaweedFSUsageReaderDoesNotCountANegativeVolume(t *testing.T) {
	volumes := `{"Volumes":{"DataCenters":{"dc":{"rack":{"n":[{"Id":1,"Size":10,"Collection":"default","DeletedByteCount":50},{"Id":2,"Size":5,"Collection":"default"}]}}}}}`
	reader, _, _ := seaweedAPIs(t, volumes, seaweedBucketEntry)
	usage, err := reader.BucketUsage(context.Background(), "default")
	if err != nil || usage.UsedBytes != 5 {
		t.Fatalf("usage = %+v, err = %v", usage, err)
	}
}

// A quota of 0 is no quota. A negative value is a quota that "s3.bucket.quota -op=disable" turned off.
func TestSeaweedFSUsageReaderQuotaValues(t *testing.T) {
	for name, test := range map[string]struct {
		entry string
		want  int64
	}{
		"set":      {`{"FullPath":"/buckets/default","Quota":1048576}`, 1048576},
		"zero":     {`{"FullPath":"/buckets/default","Quota":0}`, 0},
		"negative": {`{"FullPath":"/buckets/default","Quota":-1048576}`, 0},
		"absent":   {`{"FullPath":"/buckets/default"}`, 0},
	} {
		reader, _, _ := seaweedAPIs(t, seaweedVolumes, test.entry)
		usage, err := reader.BucketUsage(context.Background(), "default")
		if err != nil || usage.LimitBytes != test.want || usage.UsedObjects != -1 || !usage.Approximate {
			t.Fatalf("%s: usage = %+v, err = %v", name, usage, err)
		}
	}
}

func TestSeaweedFSUsageReaderErrorsHideTheURL(t *testing.T) {
	// The filer does not know the bucket.
	masterFake, master := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, seaweedVolumes))
	_, filer := newFakeAdminAPI(t, jsonAnswer(http.StatusNotFound, ``))
	masterURL, _ := parseStorageEndpoint("usage", master.URL)
	filerURL, _ := parseStorageEndpoint("usage", filer.URL)
	reader := &seaweedfsUsageReader{master: masterURL, filer: filerURL, client: master.Client()}
	_, err := reader.BucketUsage(context.Background(), "default")
	if err == nil || !strings.Contains(err.Error(), "bucket entry") || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("error = %v", err)
	}
	checkNoSecret(t, err, master.URL, filer.URL)
	if len(masterFake.seen()) != 1 {
		t.Fatalf("master requests = %+v", masterFake.seen())
	}

	// The master fails: the reader does not call the filer.
	_, master = newFakeAdminAPI(t, jsonAnswer(http.StatusInternalServerError, `boom`))
	filerFake, filer := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, seaweedBucketEntry))
	masterURL, _ = parseStorageEndpoint("usage", master.URL)
	filerURL, _ = parseStorageEndpoint("usage", filer.URL)
	reader = &seaweedfsUsageReader{master: masterURL, filer: filerURL, client: master.Client()}
	_, err = reader.BucketUsage(context.Background(), "default")
	if err == nil || !strings.Contains(err.Error(), "volume status") || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("error = %v", err)
	}
	checkNoSecret(t, err, master.URL, filer.URL)
	if len(filerFake.seen()) != 0 {
		t.Fatalf("the filer got a request: %+v", filerFake.seen())
	}
}

// --- MinIO ----------------------------------------------------------------------------------------------------------

const (
	minioKey        = "AKIATESTKEY"
	minioQuotaOK    = `{"quota":21474836480,"size":0,"rate":0,"requests":0,"quotatype":"hard"}`
	minioUsageOK    = `{"lastUpdate":"2026-10-21T10:52:20.457354406Z","objectsCount":1,"bucketsCount":3,"bucketsUsageInfo":{"default":{"size":500000,"objectsCount":1,"versionsCount":0},"other":{"size":7,"objectsCount":1}}}`
	minioNotSet     = `{"Code":"XMinioAdminBucketQuotaNotConfigured","Message":"Quota not configured","Resource":"","RequestId":"1","HostId":"h"}`
	minioNoCountYet = `{"lastUpdate":"0001-01-01T00:00:00Z","objectsCount":0,"bucketsCount":0,"bucketsUsageInfo":{}}`
)

// minioAPI starts a fake admin API of MinIO. The two answers are the status and the body of each request.
func minioAPI(t *testing.T, quotaStatus int, quota string, usageStatus int, usage string) (*minioUsageReader, *fakeAdminAPI, *httptest.Server) {
	t.Helper()
	fake, server := newFakeAdminAPI(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/minio/admin/v3/get-bucket-quota":
			jsonAnswer(quotaStatus, quota)(w, r)
		case "/minio/admin/v3/datausageinfo":
			jsonAnswer(usageStatus, usage)(w, r)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	endpoint, _ := parseStorageEndpoint("usage", server.URL)
	reader := &minioUsageReader{
		endpoint: endpoint, client: server.Client(), region: "us-east-1",
		creds: s3Credentials{AccessKeyID: minioKey, SecretAccessKey: "minio-secret-value"},
	}
	return reader, fake, server
}

func TestMinIOUsageReaderSignsAndReadsTheUsageAndTheQuota(t *testing.T) {
	reader, fake, _ := minioAPI(t, http.StatusOK, minioQuotaOK, http.StatusOK, minioUsageOK)
	usage, err := reader.BucketUsage(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	wantAsOf := time.Date(2026, 10, 21, 10, 52, 20, 457354406, time.UTC)
	if usage.UsedBytes != 500000 || usage.UsedObjects != 1 || usage.LimitBytes != 21474836480 || usage.LimitObjects != 0 || !usage.Approximate || !usage.AsOf.Equal(wantAsOf) {
		t.Fatalf("usage = %+v", usage)
	}
	requests := fake.seen()
	if len(requests) != 2 {
		t.Fatalf("requests = %+v", requests)
	}
	if requests[0].method != http.MethodGet || requests[0].path != "/minio/admin/v3/get-bucket-quota" || requests[0].query != "bucket=default" {
		t.Fatalf("quota request = %+v", requests[0])
	}
	if requests[1].method != http.MethodGet || requests[1].path != "/minio/admin/v3/datausageinfo" || requests[1].query != "" {
		t.Fatalf("usage request = %+v", requests[1])
	}
	for _, request := range requests {
		authorization := request.header.Get("Authorization")
		if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 Credential="+minioKey+"/") || !strings.Contains(authorization, "/us-east-1/s3/aws4_request") ||
			!strings.Contains(authorization, "SignedHeaders=") || !strings.Contains(authorization, "Signature=") {
			t.Fatalf("Authorization = %q", authorization)
		}
		if strings.Contains(authorization, "minio-secret-value") {
			t.Fatalf("the secret is in the header: %q", authorization)
		}
		if request.header.Get("X-Amz-Date") == "" || request.header.Get("X-Amz-Content-Sha256") == "" {
			t.Fatalf("the request is not signed: %+v", request)
		}
	}
}

// The field "size" of the quota wins when it is more than 0. Else "quota" gives the limit.
func TestMinIOUsageReaderQuotaFields(t *testing.T) {
	for name, test := range map[string]struct {
		status int
		body   string
		want   int64
	}{
		"quota":          {http.StatusOK, `{"quota":1000,"size":0,"quotatype":"hard"}`, 1000},
		"size wins":      {http.StatusOK, `{"quota":1000,"size":2000,"quotatype":"hard"}`, 2000},
		"size only":      {http.StatusOK, `{"size":2000}`, 2000},
		"no quota":       {http.StatusOK, `{"quota":0,"size":0}`, 0},
		"negative quota": {http.StatusOK, `{"quota":-5,"size":0}`, 0},
		"not configured": {http.StatusNotFound, minioNotSet, 0},
	} {
		reader, _, _ := minioAPI(t, test.status, test.body, http.StatusOK, minioUsageOK)
		usage, err := reader.BucketUsage(context.Background(), "default")
		if err != nil || usage.LimitBytes != test.want || usage.UsedBytes != 500000 {
			t.Fatalf("%s: usage = %+v, err = %v", name, usage, err)
		}
	}
}

// Another 404, a refusal or a bad answer are errors. Only the code "not configured" is no limit.
func TestMinIOUsageReaderQuotaErrors(t *testing.T) {
	for name, test := range map[string]struct {
		status int
		body   string
		want   string
	}{
		"other 404":       {http.StatusNotFound, `{"Code":"NoSuchBucket","Message":"The specified bucket does not exist"}`, "HTTP 404"},
		"404 no document": {http.StatusNotFound, ``, "HTTP 404"},
		"403":             {http.StatusForbidden, `{"Code":"XMinioAccessDenied","Message":"Access Denied."}`, "HTTP 403"},
		"500":             {http.StatusInternalServerError, `oops`, "HTTP 500"},
		"not JSON":        {http.StatusOK, `<html>`, "not the expected JSON"},
	} {
		reader, fake, server := minioAPI(t, test.status, test.body, http.StatusOK, minioUsageOK)
		_, err := reader.BucketUsage(context.Background(), "default")
		if err == nil || !strings.Contains(err.Error(), test.want) || !strings.Contains(err.Error(), "get-bucket-quota") {
			t.Fatalf("%s: error = %v, want %q", name, err, test.want)
		}
		checkNoSecret(t, err, server.URL, "minio-secret-value")
		if len(fake.seen()) != 1 {
			t.Fatalf("%s: the reader went on after the error: %+v", name, fake.seen())
		}
	}
}

func TestMinIOUsageReaderUsageErrors(t *testing.T) {
	for name, test := range map[string]struct {
		status int
		body   string
		want   string
	}{
		"zero lastUpdate": {http.StatusOK, minioNoCountYet, "has not counted the usage"},
		"no lastUpdate":   {http.StatusOK, `{"bucketsUsageInfo":{"default":{"size":5}}}`, "has not counted the usage"},
		"403":             {http.StatusForbidden, `{"Code":"XMinioAccessDenied"}`, "HTTP 403"},
		"not JSON":        {http.StatusOK, `nope`, "not the expected JSON"},
		"bad time":        {http.StatusOK, `{"lastUpdate":"yesterday"}`, "not the expected JSON"},
	} {
		reader, _, server := minioAPI(t, http.StatusOK, minioQuotaOK, test.status, test.body)
		_, err := reader.BucketUsage(context.Background(), "default")
		if err == nil || !strings.Contains(err.Error(), test.want) || !strings.Contains(err.Error(), "datausageinfo") {
			t.Fatalf("%s: error = %v, want %q", name, err, test.want)
		}
		checkNoSecret(t, err, server.URL, "minio-secret-value")
	}
}

// A bucket that the last count does not know is empty.
func TestMinIOUsageReaderBucketMissingInTheCount(t *testing.T) {
	reader, _, _ := minioAPI(t, http.StatusOK, minioQuotaOK, http.StatusOK, minioUsageOK)
	usage, err := reader.BucketUsage(context.Background(), "new-bucket")
	if err != nil || usage.UsedBytes != 0 || usage.UsedObjects != 0 || usage.LimitBytes != 21474836480 || !usage.Approximate {
		t.Fatalf("usage = %+v, err = %v", usage, err)
	}
	other, err := reader.BucketUsage(context.Background(), "other")
	if err != nil || other.UsedBytes != 7 || other.UsedObjects != 1 {
		t.Fatalf("usage = %+v, err = %v", other, err)
	}
}

func TestMinIOUsageReaderRefusesAnUnsignableRequest(t *testing.T) {
	reader, fake, _ := minioAPI(t, http.StatusOK, minioQuotaOK, http.StatusOK, minioUsageOK)
	reader.region = ""
	_, err := reader.BucketUsage(context.Background(), "default")
	if err == nil || !strings.Contains(err.Error(), "cannot sign the request") {
		t.Fatalf("error = %v", err)
	}
	if len(fake.seen()) != 0 {
		t.Fatalf("the reader sent an unsigned request: %+v", fake.seen())
	}
}

// --- Limits and failures of the admin requests ----------------------------------------------------------------------

func TestUsageReaderRefusesAnAnswerOverTheLimit(t *testing.T) {
	padding := strings.Repeat("a", maxGarageUsageBytes)
	_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, `{"objects":1,"bytes":2,"pad":"`+padding+`"}`))
	_, err := newTestGarageReader(server).BucketUsage(context.Background(), "default")
	if err == nil || !strings.Contains(err.Error(), "longer than") {
		t.Fatalf("error = %v", err)
	}
	checkNoSecret(t, err, server.URL, garageToken)
}

func TestGetUsageJSONSizeLimitIsExact(t *testing.T) {
	body := `{"a":"` + strings.Repeat("x", 20) + `"}`
	_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, body))
	get := func(limit int64) error {
		req, _ := http.NewRequest(http.MethodGet, server.URL, nil)
		var target map[string]string
		return getUsageJSON(server.Client(), req, "step", limit, &target)
	}
	if err := get(int64(len(body))); err != nil {
		t.Fatalf("an answer of exactly the limit: %v", err)
	}
	if err := get(int64(len(body)) - 1); err == nil || !strings.Contains(err.Error(), "longer than") {
		t.Fatalf("an answer over the limit: %v", err)
	}
}

// The limit of the size does not hide a failure status: the status comes first.
func TestGetUsageJSONReportsTheStatusOfALongErrorAnswer(t *testing.T) {
	_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusForbidden, strings.Repeat("e", 4096)))
	req, _ := http.NewRequest(http.MethodGet, server.URL, nil)
	var target map[string]string
	err := getUsageJSON(server.Client(), req, "step", 10, &target)
	var httpError *usageHTTPError
	if !errors.As(err, &httpError) || httpError.Status != http.StatusForbidden {
		t.Fatalf("error = %v", err)
	}
}

func TestGetUsageJSONKeepsTheErrorCode(t *testing.T) {
	for name, body := range map[string]string{"upper": `{"Code":"MyCode"}`, "lower": `{"code":"MyCode"}`} {
		_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusNotFound, body))
		req, _ := http.NewRequest(http.MethodGet, server.URL, nil)
		var target map[string]string
		err := getUsageJSON(server.Client(), req, "step", 1024, &target)
		var httpError *usageHTTPError
		if !errors.As(err, &httpError) || httpError.Code != "MyCode" {
			t.Fatalf("%s: error = %#v", name, err)
		}
	}
}

func TestUsageReaderRefusesAnAnswerThatIsNotJSON(t *testing.T) {
	for name, body := range map[string]string{"html": `<html>login</html>`, "empty": ``, "truncated": `{"objects":`, "wrong type": `{"objects":"three"}`} {
		_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, body))
		_, err := newTestGarageReader(server).BucketUsage(context.Background(), "default")
		if err == nil || !strings.Contains(err.Error(), "not the expected JSON") {
			t.Fatalf("%s: error = %v", name, err)
		}
		checkNoSecret(t, err, server.URL, garageToken)
	}
}

// A server that is slower than the context gives the "did not answer" error, without the URL.
func TestUsageReaderTimeoutHidesTheURL(t *testing.T) {
	release := make(chan struct{})
	_, server := newFakeAdminAPI(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	t.Cleanup(func() { close(release) })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := newTestGarageReader(server).BucketUsage(ctx, "default")
	if err == nil || !strings.Contains(err.Error(), "did not answer") || !strings.Contains(err.Error(), "GetBucketInfo") {
		t.Fatalf("error = %v", err)
	}
	checkNoSecret(t, err, server.URL, garageToken)
}

func TestUsageReaderCanceledRequest(t *testing.T) {
	_, server := newFakeAdminAPI(t, jsonAnswer(http.StatusOK, garageAnswer))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := newTestGarageReader(server).BucketUsage(ctx, "default")
	if err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("error = %v", err)
	}
	checkNoSecret(t, err, server.URL)
}

func TestUsageReaderConnectionFailureHidesTheURL(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	reader := newTestGarageReader(server)
	server.Close()
	_, err := reader.BucketUsage(context.Background(), "default")
	if err == nil || !strings.Contains(err.Error(), "cannot connect to the admin API") {
		t.Fatalf("error = %v", err)
	}
	checkNoSecret(t, err, server.URL, garageToken)
}

func TestUsageReaderRefusesAnUntrustedCertificate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(jsonAnswer(http.StatusOK, garageAnswer)))
	t.Cleanup(server.Close)
	endpoint, _ := parseStorageEndpoint("usage", server.URL)
	// The default client does not trust the certificate of the test server.
	reader := &garageUsageReader{endpoint: endpoint, client: &http.Client{}, token: garageToken}
	_, err := reader.BucketUsage(context.Background(), "default")
	if err == nil || !strings.Contains(err.Error(), "TLS certificate of the admin API is not valid") {
		t.Fatalf("error = %v", err)
	}
	checkNoSecret(t, err, server.URL, garageToken)
}

// --- newBucketUsageReader -------------------------------------------------------------------------------------------

func TestNewBucketUsageReaderChoosesTheReaderOfTheSource(t *testing.T) {
	t.Parallel()
	client := &http.Client{}
	creds := s3Credentials{AccessKeyID: "k", SecretAccessKey: "s"}
	if reader, err := newBucketUsageReader(authConfig{ID: "a"}, client, creds); reader != nil || err != nil {
		t.Fatalf("without a usage block: %v, %v", reader, err)
	}
	reader, err := newBucketUsageReader(authConfig{ID: "a", Usage: &usageConfig{Source: usageSourceGarage, Endpoint: "http://g:3903", Token: "t"}}, client, creds)
	if garage, ok := reader.(*garageUsageReader); err != nil || !ok || garage.token != "t" || garage.endpoint.Host != "g:3903" {
		t.Fatalf("garage: %#v, %v", reader, err)
	}
	reader, err = newBucketUsageReader(authConfig{ID: "a", Usage: &usageConfig{Source: usageSourceSeaweedFS, Endpoint: "http://m:9333", FilerEndpoint: "http://f:8888"}}, client, creds)
	if weed, ok := reader.(*seaweedfsUsageReader); err != nil || !ok || weed.master.Host != "m:9333" || weed.filer.Host != "f:8888" {
		t.Fatalf("seaweedfs: %#v, %v", reader, err)
	}
	reader, err = newBucketUsageReader(authConfig{ID: "a", Region: "eu", Usage: &usageConfig{Source: usageSourceMinIO, Endpoint: "http://minio:9000"}}, client, creds)
	if minio, ok := reader.(*minioUsageReader); err != nil || !ok || minio.region != "eu" || minio.creds != creds {
		t.Fatalf("minio: %#v, %v", reader, err)
	}
	if _, err = newBucketUsageReader(authConfig{ID: "a", Usage: &usageConfig{Source: "Garage", Endpoint: "http://g:3903"}}, client, creds); err == nil || !strings.Contains(err.Error(), "unknown usage source") {
		t.Fatalf("unknown source: %v", err)
	}
	if _, err = newBucketUsageReader(authConfig{ID: "a", Usage: &usageConfig{Source: usageSourceSeaweedFS, Endpoint: "http://m:9333", FilerEndpoint: "ftp://f"}}, client, creds); err == nil {
		t.Fatal("a wrong filer endpoint must give an error")
	}
}

// --- Cache and single flight ----------------------------------------------------------------------------------------

// fakeUsageReader is a BucketUsageReader that counts its calls. A call runs fn, after it waits for gate when gate is set.
type fakeUsageReader struct {
	mu      sync.Mutex
	calls   int
	buckets []string
	ctxErrs []error
	// entered gets one value at the start of each call, when it is set.
	entered chan struct{}
	// gate blocks each call until it is closed, when it is set.
	gate chan struct{}
	// fn gives the result of a call. Without it, the result is usedBytes = the number of the call.
	fn func(call int) (bucketUsage, error)
	// deadlines keeps the deadline of the context of each call.
	deadlines []time.Time
}

func (f *fakeUsageReader) BucketUsage(ctx context.Context, bucket string) (bucketUsage, error) {
	f.mu.Lock()
	f.calls++
	call := f.calls
	f.buckets = append(f.buckets, bucket)
	if deadline, ok := ctx.Deadline(); ok {
		f.deadlines = append(f.deadlines, deadline)
	}
	entered, gate, fn := f.entered, f.gate, f.fn
	f.mu.Unlock()
	if entered != nil {
		entered <- struct{}{}
	}
	if gate != nil {
		<-gate
	}
	f.mu.Lock()
	f.ctxErrs = append(f.ctxErrs, ctx.Err())
	f.mu.Unlock()
	if fn != nil {
		return fn(call)
	}
	return bucketUsage{UsedBytes: int64(call), UsedObjects: -1, LimitBytes: 1000}, nil
}

func (f *fakeUsageReader) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// usageClock is a clock that a test moves. The reader goroutines read it, so it has a lock.
type usageClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *usageClock) get() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *usageClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// replaceUsageClock replaces timeNowUTC until the end of the test. A test that uses it must not call t.Parallel.
func replaceUsageClock(t *testing.T) *usageClock {
	t.Helper()
	clock := &usageClock{now: time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)}
	original := timeNowUTC
	timeNowUTC = clock.get
	t.Cleanup(func() { timeNowUTC = original })
	return clock
}

// usageInstance gives a storage instance with a reader of the source "garage".
func usageInstance(reader BucketUsageReader) *storageInstance {
	cfg := bucketConfig{ID: "inst", Name: "inst", Bucket: "the-bucket", AuthID: "a", Provider: "s3"}
	instance := &storageInstance{cfg: cfg, caps: initialCapabilities(cfg)}
	instance.usage.reader, instance.usage.source = reader, usageSourceGarage
	return instance
}

func TestBucketUsageWithoutReaderIsUnsupported(t *testing.T) {
	t.Parallel()
	instance := usageInstance(nil)
	instance.usage.reader = nil
	if instance.usageAvailable() {
		t.Fatal("an instance without a reader must not offer the usage")
	}
	_, err := instance.bucketUsage(context.Background(), false)
	var apiErr apiError
	if !errors.As(err, &apiErr) || apiErr.Code != "usage_unsupported" || apiErr.Status != http.StatusNotImplemented {
		t.Fatalf("error = %#v", err)
	}
	var nilInstance *storageInstance
	if nilInstance.usageAvailable() {
		t.Fatal("a nil instance must not offer the usage")
	}
}

func TestBucketUsageReadsTheBucketWithADeadline(t *testing.T) {
	replaceUsageClock(t)
	reader := &fakeUsageReader{}
	instance := usageInstance(reader)
	value, err := instance.bucketUsage(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if value.Source != usageSourceGarage || value.UsedBytes != 1 {
		t.Fatalf("value = %+v", value)
	}
	if reader.buckets[0] != "the-bucket" {
		t.Fatalf("bucket = %q", reader.buckets[0])
	}
	if len(reader.deadlines) != 1 || time.Until(reader.deadlines[0]) > usageTimeout || time.Until(reader.deadlines[0]) <= 0 {
		t.Fatalf("deadlines = %v", reader.deadlines)
	}
}

// N concurrent calls make one read. Each call gets the same result.
func TestBucketUsageSingleFlight(t *testing.T) {
	replaceUsageClock(t)
	const callers = 12
	reader := &fakeUsageReader{entered: make(chan struct{}, callers), gate: make(chan struct{})}
	instance := usageInstance(reader)
	values := make(chan bucketUsage, callers)
	errs := make(chan error, callers)
	var started sync.WaitGroup
	for range callers {
		started.Add(1)
		go func() {
			started.Done()
			value, err := instance.bucketUsage(context.Background(), false)
			values <- value
			errs <- err
		}()
	}
	started.Wait()
	<-reader.entered
	// The other callers wait for the read. A short pause lets them reach the wait.
	time.Sleep(50 * time.Millisecond)
	close(reader.gate)
	for range callers {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		if value := <-values; value.UsedBytes != 1 || value.Source != usageSourceGarage {
			t.Fatalf("value = %+v", value)
		}
	}
	if got := reader.callCount(); got != 1 {
		t.Fatalf("reader calls = %d, want 1", got)
	}
}

// A result lives 60 s. After that, the next call reads again.
func TestBucketUsageCacheLife(t *testing.T) {
	clock := replaceUsageClock(t)
	reader := &fakeUsageReader{}
	instance := usageInstance(reader)
	ctx := context.Background()
	read := func(want int, wantBytes int64) {
		t.Helper()
		value, err := instance.bucketUsage(ctx, false)
		if err != nil || value.UsedBytes != wantBytes || reader.callCount() != want {
			t.Fatalf("value = %+v, err = %v, calls = %d, want %d calls and %d bytes", value, err, reader.callCount(), want, wantBytes)
		}
	}
	read(1, 1)
	clock.advance(30 * time.Second)
	read(1, 1)
	clock.advance(29 * time.Second)
	read(1, 1)
	clock.advance(2 * time.Second) // 61 s after the read
	read(2, 2)
	clock.advance(59 * time.Second)
	read(2, 2)
	clock.advance(2 * time.Second)
	read(3, 3)
}

// A failure lives 10 s. It does not replace the next read, and the result of a failure has no value.
func TestBucketUsageFailureIsCachedForTenSeconds(t *testing.T) {
	clock := replaceUsageClock(t)
	failure := errors.New("GetBucketInfo: the admin API refused the credentials (HTTP 403)")
	reader := &fakeUsageReader{fn: func(call int) (bucketUsage, error) {
		if call == 1 {
			return bucketUsage{UsedBytes: 99}, failure
		}
		return bucketUsage{UsedBytes: 5}, nil
	}}
	instance := usageInstance(reader)
	ctx := context.Background()
	value, err := instance.bucketUsage(ctx, false)
	if !errors.Is(err, failure) || value != (bucketUsage{}) {
		t.Fatalf("value = %+v, err = %v", value, err)
	}
	clock.advance(9 * time.Second)
	if _, err := instance.bucketUsage(ctx, false); !errors.Is(err, failure) || reader.callCount() != 1 {
		t.Fatalf("err = %v, calls = %d", err, reader.callCount())
	}
	// fresh = true does not read again inside the 10 s.
	if _, err := instance.bucketUsage(ctx, true); !errors.Is(err, failure) || reader.callCount() != 1 {
		t.Fatalf("fresh: err = %v, calls = %d", err, reader.callCount())
	}
	clock.advance(2 * time.Second)
	value, err = instance.bucketUsage(ctx, false)
	if err != nil || value.UsedBytes != 5 || reader.callCount() != 2 {
		t.Fatalf("value = %+v, err = %v, calls = %d", value, err, reader.callCount())
	}
	// The success lives 60 s again.
	clock.advance(50 * time.Second)
	if value, err = instance.bucketUsage(ctx, false); err != nil || value.UsedBytes != 5 || reader.callCount() != 2 {
		t.Fatalf("value = %+v, err = %v, calls = %d", value, err, reader.callCount())
	}
}

// fresh = true reads again only when the result is older than 10 s.
func TestBucketUsageFreshReadsOnlyAResultOlderThanTenSeconds(t *testing.T) {
	clock := replaceUsageClock(t)
	reader := &fakeUsageReader{}
	instance := usageInstance(reader)
	ctx := context.Background()
	if _, err := instance.bucketUsage(ctx, true); err != nil || reader.callCount() != 1 {
		t.Fatalf("first call: err = %v, calls = %d", err, reader.callCount())
	}
	clock.advance(5 * time.Second)
	if value, _ := instance.bucketUsage(ctx, true); value.UsedBytes != 1 || reader.callCount() != 1 {
		t.Fatalf("5 s: value = %+v, calls = %d", value, reader.callCount())
	}
	clock.advance(6 * time.Second) // 11 s
	if value, _ := instance.bucketUsage(ctx, false); value.UsedBytes != 1 || reader.callCount() != 1 {
		t.Fatalf("11 s without fresh: value = %+v, calls = %d", value, reader.callCount())
	}
	if value, _ := instance.bucketUsage(ctx, true); value.UsedBytes != 2 || reader.callCount() != 2 {
		t.Fatalf("11 s with fresh: value = %+v, calls = %d", value, reader.callCount())
	}
	clock.advance(time.Second)
	if value, _ := instance.bucketUsage(ctx, true); value.UsedBytes != 2 || reader.callCount() != 2 {
		t.Fatalf("1 s after a fresh read: value = %+v, calls = %d", value, reader.callCount())
	}
}

// A caller that stops while another call reads gets its own error. The read goes on and gives its result.
func TestBucketUsageCanceledWaiterDoesNotCancelTheRead(t *testing.T) {
	replaceUsageClock(t)
	reader := &fakeUsageReader{entered: make(chan struct{}, 4), gate: make(chan struct{})}
	instance := usageInstance(reader)
	first := make(chan error, 1)
	go func() {
		_, err := instance.bucketUsage(context.Background(), false)
		first <- err
	}()
	<-reader.entered
	ctx, cancel := context.WithCancel(context.Background())
	second := make(chan error, 1)
	go func() {
		_, err := instance.bucketUsage(ctx, false)
		second <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-second; !errors.Is(err, context.Canceled) {
		t.Fatalf("the waiter got %v, want context.Canceled", err)
	}
	close(reader.gate)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if reader.callCount() != 1 || reader.ctxErrs[0] != nil {
		t.Fatalf("calls = %d, context errors = %v", reader.callCount(), reader.ctxErrs)
	}
	// The result is in the cache.
	if value, err := instance.bucketUsage(context.Background(), false); err != nil || value.UsedBytes != 1 || reader.callCount() != 1 {
		t.Fatalf("value = %+v, err = %v, calls = %d", value, err, reader.callCount())
	}
}

// The caller that starts the read can stop too. The read does not stop, and its result goes to the cache.
func TestBucketUsageCanceledStarterDoesNotCancelTheRead(t *testing.T) {
	replaceUsageClock(t)
	reader := &fakeUsageReader{entered: make(chan struct{}, 4), gate: make(chan struct{})}
	instance := usageInstance(reader)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := instance.bucketUsage(ctx, false)
		done <- err
	}()
	<-reader.entered
	cancel()
	close(reader.gate)
	if err := <-done; err != nil {
		t.Fatalf("the read stopped with the caller: %v", err)
	}
	if reader.ctxErrs[0] != nil {
		t.Fatalf("the context of the read was canceled: %v", reader.ctxErrs[0])
	}
	if value, err := instance.bucketUsage(context.Background(), false); err != nil || value.UsedBytes != 1 || reader.callCount() != 1 {
		t.Fatalf("value = %+v, err = %v, calls = %d", value, err, reader.callCount())
	}
}

// The wait of a caller for a read that fails ends with the same error for each caller.
func TestBucketUsageWaitersGetTheErrorOfTheRead(t *testing.T) {
	replaceUsageClock(t)
	failure := errors.New("GetBucketInfo: cannot connect to the admin API")
	reader := &fakeUsageReader{entered: make(chan struct{}, 4), gate: make(chan struct{}),
		fn: func(int) (bucketUsage, error) { return bucketUsage{}, failure }}
	instance := usageInstance(reader)
	errs := make(chan error, 4)
	for range 4 {
		go func() {
			_, err := instance.bucketUsage(context.Background(), false)
			errs <- err
		}()
	}
	<-reader.entered
	time.Sleep(50 * time.Millisecond)
	close(reader.gate)
	for range 4 {
		if err := <-errs; !errors.Is(err, failure) {
			t.Fatalf("error = %v", err)
		}
	}
	if reader.callCount() != 1 {
		t.Fatalf("reader calls = %d", reader.callCount())
	}
}

// --- Levels and answers ---------------------------------------------------------------------------------------------

func TestUsageLevel(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		value   bucketUsage
		percent float64
		level   string
	}{
		"no limit":                {bucketUsage{UsedBytes: 500, UsedObjects: 5}, 0, ""},
		"zero limits":             {bucketUsage{UsedBytes: 500, LimitBytes: 0, LimitObjects: 0}, 0, ""},
		"empty":                   {bucketUsage{UsedBytes: 0, LimitBytes: 1000}, 0, "ok"},
		"79.9 percent":            {bucketUsage{UsedBytes: 799, LimitBytes: 1000}, 79.9, "ok"},
		"80 percent":              {bucketUsage{UsedBytes: 800, LimitBytes: 1000}, 80, "warning"},
		"94.9 percent":            {bucketUsage{UsedBytes: 949, LimitBytes: 1000}, 94.9, "warning"},
		"95 percent":              {bucketUsage{UsedBytes: 950, LimitBytes: 1000}, 95, "error"},
		"full":                    {bucketUsage{UsedBytes: 1000, LimitBytes: 1000}, 100, "error"},
		"over the limit":          {bucketUsage{UsedBytes: 1500, LimitBytes: 1000}, 150, "error"},
		"rounded down":            {bucketUsage{UsedBytes: 1234, LimitBytes: 10000}, 12.3, "ok"},
		"rounded down, not up":    {bucketUsage{UsedBytes: 99999, LimitBytes: 100000}, 99.9, "error"},
		"one third":               {bucketUsage{UsedBytes: 1, LimitBytes: 3}, 33.3, "ok"},
		"just under warning":      {bucketUsage{UsedBytes: 7999, LimitBytes: 10000}, 79.9, "ok"},
		"objects only":            {bucketUsage{UsedBytes: 10, UsedObjects: 90, LimitObjects: 100}, 90, "warning"},
		"objects ratio is larger": {bucketUsage{UsedBytes: 100, LimitBytes: 1000, UsedObjects: 96, LimitObjects: 100}, 96, "error"},
		"bytes ratio is larger":   {bucketUsage{UsedBytes: 900, LimitBytes: 1000, UsedObjects: 10, LimitObjects: 100}, 90, "warning"},
		"unknown used bytes":      {bucketUsage{UsedBytes: -1, UsedObjects: -1, LimitBytes: 1000, LimitObjects: 100}, 0, ""},
		"unknown objects":         {bucketUsage{UsedBytes: 100, UsedObjects: -1, LimitBytes: 1000, LimitObjects: 100}, 10, "ok"},
	} {
		percent, level := usageLevel(test.value)
		if percent != test.percent || level != test.level {
			t.Errorf("%s: percent = %v, level = %q, want %v and %q", name, percent, level, test.percent, test.level)
		}
	}
}

// The percent is the used part with one decimal, and the next decimals are cut. A float error must not lower a round value.
func TestUsageLevelPercentIsExactForRoundValues(t *testing.T) {
	t.Parallel()
	for used := int64(0); used <= 1000; used++ {
		percent, _ := usageLevel(bucketUsage{UsedBytes: used, LimitBytes: 1000})
		if want := float64(used) / 10; percent != want {
			t.Fatalf("used %d of 1000: percent = %v, want %v", used, percent, want)
		}
	}
}

func usageAnswerInstance(quota int64) *storageInstance {
	instance := usageInstance(&fakeUsageReader{})
	instance.cfg.QuotaBytes = quota
	instance.cfg.RootPrefix = "tenant/"
	return instance
}

func TestUsageAnswerLimitSource(t *testing.T) {
	t.Parallel()
	asOf := time.Date(2026, 10, 21, 10, 0, 0, 0, time.FixedZone("x", 3600))
	for name, test := range map[string]struct {
		quota       int64
		value       bucketUsage
		limitBytes  int64
		limitSource string
		percent     float64
		level       string
	}{
		"no limit anywhere":      {0, bucketUsage{UsedBytes: 100, UsedObjects: 1}, 0, "", 0, ""},
		"provider limit":         {0, bucketUsage{UsedBytes: 100, LimitBytes: 1000}, 1000, "provider", 10, "ok"},
		"provider wins":          {500, bucketUsage{UsedBytes: 100, LimitBytes: 1000}, 1000, "provider", 10, "ok"},
		"config without limit":   {200, bucketUsage{UsedBytes: 100}, 200, "config", 50, "ok"},
		"config limit is full":   {200, bucketUsage{UsedBytes: 199}, 200, "config", 99.5, "error"},
		"config and objects":     {1000, bucketUsage{UsedBytes: 100, UsedObjects: 9, LimitObjects: 10}, 1000, "config", 90, "warning"},
		"unknown used with conf": {200, bucketUsage{UsedBytes: -1, UsedObjects: -1}, 200, "config", 0, ""},
	} {
		test.value.Source, test.value.AsOf = usageSourceGarage, asOf
		answer := usageAnswer(usageAnswerInstance(test.quota), test.value)
		if !answer.Supported || !answer.Available || answer.Error != nil || answer.Instance != "inst" || answer.Bucket != "the-bucket" || answer.RootPrefix != "tenant/" || answer.Source != usageSourceGarage {
			t.Errorf("%s: answer = %+v", name, answer)
		}
		if answer.LimitBytes != test.limitBytes || answer.LimitSource != test.limitSource || answer.Percent != test.percent || answer.Level != test.level {
			t.Errorf("%s: limit %d from %q, percent %v, level %q; want %d, %q, %v, %q", name, answer.LimitBytes, answer.LimitSource, answer.Percent, answer.Level, test.limitBytes, test.limitSource, test.percent, test.level)
		}
		if !answer.AsOf.Equal(asOf) || answer.AsOf.Location() != time.UTC {
			t.Errorf("%s: asOf = %v", name, answer.AsOf)
		}
	}
}

func TestUsageAnswerApproximateReason(t *testing.T) {
	t.Parallel()
	instance := usageAnswerInstance(0)
	for source, want := range map[string]bool{usageSourceGarage: false, usageSourceSeaweedFS: true, usageSourceMinIO: true} {
		answer := usageAnswer(instance, bucketUsage{Source: source, Approximate: want})
		if answer.Approximate != want || (answer.ApproximateReason != "") != want {
			t.Errorf("%s: approximate = %v, reason = %q", source, answer.Approximate, answer.ApproximateReason)
		}
	}
	// Each source with a reason has a text in the table.
	for _, source := range []string{usageSourceSeaweedFS, usageSourceMinIO} {
		if usageApproximateReasons[source] == "" {
			t.Errorf("no approximate reason for %s", source)
		}
	}
}

// --- HTTP handler ---------------------------------------------------------------------------------------------------

func decodeUsageMap(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestUsageAPIWithoutUsageBlock(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	recorder := doJSON(app, http.MethodGet, "/api/usage?instance=rw", nil)
	payload := decodeUsageMap(t, recorder)
	if len(payload) != 1 || payload["supported"] != false {
		t.Fatalf("payload = %s", recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestUsageAPIGivesTheUsageOfTheBucket(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	asOf := time.Date(2026, 10, 21, 10, 52, 20, 0, time.UTC)
	reader := &fakeUsageReader{fn: func(int) (bucketUsage, error) {
		return bucketUsage{UsedBytes: 850, UsedObjects: 7, LimitBytes: 1000, Approximate: true, AsOf: asOf}, nil
	}}
	instance := app.instances["rw"]
	instance.usage.reader, instance.usage.source = reader, usageSourceMinIO
	recorder := doJSON(app, http.MethodGet, "/api/usage?instance=rw", nil)
	payload := decodeUsageMap(t, recorder)
	want := map[string]any{
		"supported": true, "available": true, "instance": "rw", "bucket": "rw-bucket", "rootPrefix": "tenant/", "source": "minio",
		"usedBytes": 850.0, "usedObjects": 7.0, "limitBytes": 1000.0, "limitObjects": 0.0, "limitSource": "provider",
		"approximate": true, "percent": 85.0, "level": "warning", "asOf": "2026-10-21T10:52:20Z",
	}
	for key, value := range want {
		if payload[key] != value {
			t.Errorf("%s = %v, want %v", key, payload[key], value)
		}
	}
	if reason, _ := payload["approximateReason"].(string); reason == "" {
		t.Errorf("no approximateReason: %s", recorder.Body.String())
	}
	if _, present := payload["error"]; present {
		t.Errorf("error in the payload: %s", recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	// A second request comes from the cache.
	doJSON(app, http.MethodGet, "/api/usage?instance=rw", nil)
	if reader.callCount() != 1 {
		t.Fatalf("reader calls = %d", reader.callCount())
	}
}

func TestUsageAPIGivesTheLimitOfTheOperator(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	instance := app.instances["rw"]
	instance.cfg.QuotaBytes = 400
	instance.usage.reader = &fakeUsageReader{fn: func(int) (bucketUsage, error) {
		return bucketUsage{UsedBytes: 100, UsedObjects: -1}, nil
	}}
	instance.usage.source = usageSourceGarage
	payload := decodeUsageMap(t, doJSON(app, http.MethodGet, "/api/usage?instance=rw", nil))
	if payload["limitBytes"] != 400.0 || payload["limitSource"] != "config" || payload["percent"] != 25.0 || payload["level"] != "ok" || payload["approximate"] != false {
		t.Fatalf("payload = %v", payload)
	}
	if _, present := payload["approximateReason"]; present {
		t.Fatalf("payload = %v", payload)
	}
}

// A failed read gives HTTP 200, "available": false and the error. The message hides the URL and the token.
func TestUsageAPIFailedReadGives200(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	instance := app.instances["rw"]
	instance.usage.reader = &fakeUsageReader{fn: func(int) (bucketUsage, error) {
		return bucketUsage{}, &usageHTTPError{Step: "GetBucketInfo", Status: http.StatusForbidden}
	}}
	instance.usage.source = usageSourceGarage
	recorder := doJSON(app, http.MethodGet, "/api/usage?instance=rw", nil)
	payload := decodeUsageMap(t, recorder)
	if payload["supported"] != true || payload["available"] != false || payload["instance"] != "rw" || payload["source"] != "garage" || payload["usedBytes"] != 0.0 {
		t.Fatalf("payload = %s", recorder.Body.String())
	}
	failure, _ := payload["error"].(map[string]any)
	if failure["code"] != "usage_unavailable" || !strings.Contains(fmt.Sprint(failure["message"]), "HTTP 403") {
		t.Fatalf("error = %v", payload["error"])
	}
}

func TestUsageAPIMethodAndInstance(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	app.instances["rw"].usage.reader = &fakeUsageReader{}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		recorder := doJSON(app, method, "/api/usage?instance=rw", nil)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d", method, recorder.Code)
		}
		if allow := recorder.Header().Get("Allow"); allow != http.MethodGet {
			t.Fatalf("%s Allow = %q", method, allow)
		}
	}
	if recorder := doJSON(app, http.MethodGet, "/api/usage?instance=missing", nil); recorder.Code < 400 || recorder.Code >= 500 {
		t.Fatalf("an unknown instance gives status %d", recorder.Code)
	}
}

// The handler needs the permission read.
func TestUsageAPIRequiresTheReadPermission(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	instance := app.instances["rw"]
	reader := &fakeUsageReader{}
	instance.usage.reader = reader
	instance.cfg.Permissions = []string{permissionWrite}
	instance.caps = initialCapabilities(instance.cfg)
	recorder := doJSON(app, http.MethodGet, "/api/usage?instance=rw", nil)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if reader.callCount() != 0 {
		t.Fatal("the reader ran without the read permission")
	}
}

// fresh=1 reads again a result that is older than 10 s.
func TestUsageAPIFreshReloadsAnOldResult(t *testing.T) {
	clock := replaceUsageClock(t)
	app, _, _ := testApplication(t)
	reader := &fakeUsageReader{}
	instance := app.instances["rw"]
	instance.usage.reader, instance.usage.source = reader, usageSourceGarage
	get := func(target string) float64 {
		value, _ := decodeUsageMap(t, doJSON(app, http.MethodGet, target, nil))["usedBytes"].(float64)
		return value
	}
	if get("/api/usage?instance=rw") != 1 {
		t.Fatal("first read")
	}
	clock.advance(5 * time.Second)
	if get("/api/usage?instance=rw&fresh=1") != 1 || reader.callCount() != 1 {
		t.Fatalf("fresh after 5 s: calls = %d", reader.callCount())
	}
	clock.advance(6 * time.Second)
	if get("/api/usage?instance=rw") != 1 || reader.callCount() != 1 {
		t.Fatalf("no fresh after 11 s: calls = %d", reader.callCount())
	}
	if get("/api/usage?instance=rw&fresh=1") != 2 || reader.callCount() != 2 {
		t.Fatalf("fresh after 11 s: calls = %d", reader.callCount())
	}
	// Only fresh=1 asks for a new read.
	clock.advance(11 * time.Second)
	if get("/api/usage?instance=rw&fresh=true") != 2 || reader.callCount() != 2 {
		t.Fatalf("fresh=true: calls = %d", reader.callCount())
	}
}

func TestInstancesTellIfTheUsageIsSupported(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	app.instances["rw"].usage.reader = &fakeUsageReader{}
	recorder := doJSON(app, http.MethodGet, "/api/instances", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Instances []map[string]any `json:"instances"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	got := map[string]any{}
	for _, info := range payload.Instances {
		value, present := info["usageSupported"]
		if !present {
			t.Fatalf("instance %v has no usageSupported", info["id"])
		}
		got[fmt.Sprint(info["id"])] = value
	}
	if len(got) != 2 || got["rw"] != true || got["readonly"] != false {
		t.Fatalf("usageSupported = %v", got)
	}
}

// The probe of the usage makes no admin request, and a source that differs from the provider is only a warning.
func TestProbeUsageMakesNoAdminRequest(t *testing.T) {
	t.Parallel()
	app, _, _ := testApplication(t)
	reader := &fakeUsageReader{}
	instance := app.instances["rw"]
	instance.usage.reader, instance.usage.source = reader, usageSourceGarage
	fake, server := newFakeEncryptionS3(t)
	fake.server = "MinIO"
	instance.backend = newAnonymousS3BackendForTest(t, server.URL, "bucket")
	instance.probeUsage(context.Background())
	app.instances["readonly"].probeUsage(context.Background())
	if reader.callCount() != 0 {
		t.Fatalf("the probe read the usage: %d calls", reader.callCount())
	}
}
