package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"embed"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed public
var embeddedPublic embed.FS

type application struct {
	config          appConfig
	authentications map[string]*sharedAuthentication
	instances       map[string]*storageInstance
	order           []string
	publicFS        fs.FS
	jobs            *jobManager
	uploads         *uploadManager
	sqlite          *sqliteSessionManager
	resumeTokenKey  [32]byte
	// identity and pdp exist only with access.mode = "authzen".
	identity *identityVerifier
	pdp      *pdpClient
}

func newApplication(cfg appConfig) (*application, error) {
	frontend := cfg.Frontend
	if frontend == "" {
		// A configuration that decodeConfig did not build (tests) keeps the documented default.
		frontend = frontendDefault
	}
	publicFS, err := openFrontend(frontend)
	if err != nil {
		return nil, err
	}
	concurrency := newStorageConcurrency(cfg.Runtime.MaxConcurrentStorageRequests)
	app := &application{
		config:          cfg,
		authentications: make(map[string]*sharedAuthentication, len(cfg.Authentications)),
		instances:       make(map[string]*storageInstance, len(cfg.Buckets)),
		publicFS:        publicFS,
	}
	if _, err := rand.Read(app.resumeTokenKey[:]); err != nil {
		return nil, fmt.Errorf("generate upload resume token key: %w", err)
	}
	if cfg.Access.enforced() {
		app.identity = newIdentityVerifier(cfg.Access)
		app.pdp = newPDPClient(cfg.Access)
	}
	for _, authCfg := range cfg.Authentications {
		auth, err := newSharedAuthentication(authCfg)
		if err != nil {
			app.closeAuthentications()
			return nil, fmt.Errorf("initialize auth %q: %w", authCfg.ID, err)
		}
		app.authentications[authCfg.ID] = auth
	}
	for _, bucketCfg := range cfg.Buckets {
		auth := app.authentications[bucketCfg.AuthID]
		instance, err := newStorageInstance(bucketCfg, auth, cfg.Runtime, concurrency)
		if err != nil {
			app.closeAuthentications()
			return nil, fmt.Errorf("initialize bucket %q: %w", bucketCfg.ID, err)
		}
		app.instances[bucketCfg.ID] = instance
		app.order = append(app.order, bucketCfg.ID)
	}
	app.probeVersioningSupport()
	jobs, err := newJobManager(app, cfg.JobHistoryLimit)
	if err != nil {
		app.closeAuthentications()
		return nil, err
	}
	app.jobs = jobs
	uploads, err := newUploadManager(app)
	if err != nil {
		jobs.close()
		app.closeAuthentications()
		return nil, err
	}
	app.uploads = uploads
	app.sqlite = newSQLiteSessionManager(app)
	return app, nil
}

func (a *application) probeVersioningSupport() {
	if a == nil || len(a.instances) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for _, instance := range a.instances {
		instance := instance
		wg.Add(1)
		go func() {
			defer wg.Done()
			instance.probeVersioning(ctx)
		}()
	}
	wg.Wait()
}

func (a *application) closeAuthentications() {
	if a == nil {
		return
	}
	for _, auth := range a.authentications {
		auth.close()
	}
}

func (a *application) close() {
	if a == nil {
		return
	}
	if a.sqlite != nil {
		a.sqlite.close()
	}
	if a.jobs != nil {
		a.jobs.close()
	}
	a.closeAuthentications()
	a.pdp.close()
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/instances", a.handleInstances)
	mux.HandleFunc("/api/build", a.handleBuild)
	mux.HandleFunc("/api/permissions/refresh", a.handlePermissionRefresh)
	mux.HandleFunc("/api/list", a.handleList)
	mux.HandleFunc("/api/stats", a.handleStats)
	mux.HandleFunc("/api/archive", a.handleArchive)
	mux.HandleFunc("/api/copy", a.handleCopy)
	mux.HandleFunc("/api/rename", a.handleRename)
	mux.HandleFunc("/api/delete-prefix", a.handleDeletePrefix)
	mux.HandleFunc("/api/jobs", http.NotFound)
	mux.HandleFunc("/api/jobs/", a.handleJobs)
	mux.HandleFunc("/api/uploads/resume", a.handleUploads)
	mux.HandleFunc("/api/uploads", a.handleUploads)
	mux.HandleFunc("/api/spreadsheet", a.handleSpreadsheet)
	mux.HandleFunc("/api/delimited", a.handleDelimitedPage)
	mux.HandleFunc("/api/document-count", a.handleDocumentCount)
	mux.HandleFunc("/api/document/word", a.handleWordPreview)
	mux.HandleFunc("/api/parquet", a.handleParquetPreview)
	mux.HandleFunc("/api/sqlite/sessions", a.handleSQLiteSessions)
	mux.HandleFunc("/api/sqlite/sessions/", a.handleSQLiteSessions)
	mux.HandleFunc("/api/json/raw", a.handleJSONRaw)
	mux.HandleFunc("/api/json/beautify", a.handleJSONBeautify)
	mux.HandleFunc("/api/json/summary", a.handleJSONSummary)
	mux.HandleFunc("/api/json/tree", a.handleJSONTree)
	mux.HandleFunc("/api/search", a.handleDocumentSearch)
	mux.HandleFunc("/api/media-info", a.handleMediaInfo)
	mux.HandleFunc("/api/structured-preview", a.handleStructuredPreview)
	mux.HandleFunc("/api/archive-preview", a.handleArchivePreview)
	mux.HandleFunc("/api/archive-entry", a.handleArchiveEntry)
	mux.HandleFunc("/api/archive-entry/integrity", a.handleArchiveEntryIntegrity)
	mux.HandleFunc("/api/archive-extract", a.handleArchiveExtract)
	mux.HandleFunc("/api/versions", a.handleVersions)
	mux.HandleFunc("/api/version-counts", a.handleVersionCounts)
	mux.HandleFunc("/api/versions/restore", a.handleVersionRestore)
	mux.HandleFunc("/api/integrity", a.handleIntegrity)
	mux.HandleFunc("/api/inspect", a.handleInspect)
	mux.HandleFunc("/api/image-preview", a.handleImagePreview)
	mux.HandleFunc("/healthz", a.handleHealth)
	mux.HandleFunc(accessActionsPath, a.handleAccessActions)
	mux.HandleFunc("/open/", a.handleOpenOriginal)
	mux.Handle("/", secureStaticHandler(a.publicFS))
	router := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if version := strings.TrimSpace(r.URL.Query().Get("version")); version != "" {
			r = r.WithContext(withObjectVersion(r.Context(), version))
		}
		// Object keys are opaque. Route the gateway before ServeMux so escaped
		// key bytes are not canonicalized as URL path segments.
		if r.URL.Path == "/s3" {
			a.handleObjectGateway(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/-/") {
			a.handleStorageFrontend(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
	internal := requestLogMiddleware(a.config.Runtime.LogMode, a.accessMiddleware(requestBudgetMiddleware(a.config.Runtime, sameOriginMutationMiddleware(gzipJSONMiddleware(router)))))
	return securityHeadersMiddleware(internal)
}

func (a *application) handleInstances(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	visible, decisions := a.visibleInstances(r)
	instances := make([]instanceInfo, 0, len(visible))
	for _, instance := range visible {
		instances = append(instances, withAccessCapabilities(instance.publicInfo(), decisions[instance.cfg.ID]))
	}
	defaultID := ""
	if len(visible) > 0 {
		defaultID = visible[0].cfg.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"default":   defaultID,
		"instances": instances,
		"build":     currentBuildInfo(),
		"runtime":   publicRuntimeInfo(a.config.Runtime),
	})
}

func (a *application) handleBuild(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, currentBuildInfo())
}

func (a *application) handlePermissionRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	instance, err := a.instanceFromRequest(r, "", permissionRead)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	caps := instance.refreshCapabilities(ctx)
	if a.config.Access.enforced() {
		info := instanceInfo{Capabilities: caps}
		caps = withAccessCapabilities(info, a.bucketVisibility(r, []*storageInstance{instance})[instance.cfg.ID]).Capabilities
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"instance":     instance.cfg.ID,
		"capabilities": caps,
	})
}

type listItemJSON struct {
	Type         string     `json:"type"`
	Name         string     `json:"name"`
	Prefix       string     `json:"prefix,omitempty"`
	Key          string     `json:"key,omitempty"`
	Size         int64      `json:"size,omitempty"`
	LastModified *time.Time `json:"lastModified,omitempty"`
	ETag         string     `json:"etag,omitempty"`
	ContentType  string     `json:"contentType,omitempty"`
}

type listResponseJSON struct {
	Instance              string         `json:"instance"`
	Prefix                string         `json:"prefix"`
	Delimiter             string         `json:"delimiter"`
	Items                 []listItemJSON `json:"items"`
	NextContinuationToken string         `json:"nextContinuationToken,omitempty"`
	IsTruncated           bool           `json:"isTruncated"`
	ScanComplete          bool           `json:"scanComplete"`
	SortAvailable         bool           `json:"sortAvailable"`
	// Access gives the decisions of the listed node in the authzen mode.
	Access *listAccessJSON `json:"access,omitempty"`
}

const providerListPageSize = 1000

func scanListPages(ctx context.Context, instance *storageInstance, options listOptions, maxPages int) (listPage, bool, error) {
	if instance == nil {
		return listPage{}, false, fmt.Errorf("storage instance is nil")
	}
	if maxPages < 0 {
		return listPage{}, false, fmt.Errorf("max scan pages cannot be negative")
	}
	aggregated := listPage{}
	pageToken := options.PageToken
	for pageNumber := 0; ; pageNumber++ {
		options.MaxResults = providerListPageSize
		options.PageToken = pageToken
		page, err := instance.List(ctx, options)
		if err != nil {
			return listPage{}, false, err
		}
		aggregated.Objects = append(aggregated.Objects, page.Objects...)
		aggregated.Prefixes = append(aggregated.Prefixes, page.Prefixes...)
		next := page.NextPageToken
		if next == "" {
			aggregated.NextPageToken = ""
			return aggregated, true, nil
		}
		if next == pageToken {
			return listPage{}, false, fmt.Errorf("provider returned the same continuation token twice")
		}
		aggregated.NextPageToken = next
		if maxPages > 0 && pageNumber+1 >= maxPages {
			return aggregated, false, nil
		}
		pageToken = next
	}
}

func (a *application) handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	instance, err := a.instanceFromRequest(r, "", permissionRead)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	prefix := cleanRelativeKey(r.URL.Query().Get("prefix"))
	// A human who cannot read the node of the listing can still see the path to
	// a folder that a grant below the bucket names (the navigation filter).
	nodeAccess := a.nodeAccess(r, instance, prefix)
	navigationOnly := false
	if nodeAccess != nil && !nodeAccess.Read {
		if a.nodeResource(instance, prefix).Type != resourceBucket {
			writeAPIError(w, forbidden(actionObjectsRead))
			return
		}
		navigationOnly = true
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeAPIError(w, err)
		return
	}
	delimiter := r.URL.Query().Get("delimiter")
	if _, present := r.URL.Query()["delimiter"]; !present {
		delimiter = "/"
	}
	if delimiter != "" && delimiter != "/" {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_delimiter", Message: "delimiter must be empty or /"})
		return
	}
	pageToken := r.URL.Query().Get("continuationToken")
	page, scanComplete, err := scanListPages(r.Context(), instance, listOptions{
		Prefix:    instance.fullKey(prefix),
		Delimiter: delimiter,
		PageToken: pageToken,
	}, instance.cfg.MaxScanPages)
	if err != nil {
		writeAPIError(w, err)
		return
	}

	excludes := parseExcludes(r.URL.Query()["exclude"])
	items := make([]listItemJSON, 0, len(page.Prefixes)+len(page.Objects))
	seen := make(map[string]struct{})
	for _, fullPrefix := range page.Prefixes {
		relative, ok := instance.relativeKey(fullPrefix)
		if !ok || relative == "" || isExcluded(relative, excludes) {
			continue
		}
		relative = normalizePrefix(relative)
		name := strings.TrimSuffix(relative, "/")
		if slash := strings.LastIndexByte(name, '/'); slash >= 0 {
			name = name[slash+1:]
		}
		id := "p:" + relative
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		items = append(items, listItemJSON{Type: "prefix", Name: name + "/", Prefix: relative})
	}
	for _, object := range page.Objects {
		relative, ok := instance.relativeKey(object.Key)
		if !ok || relative == "" || isExcluded(relative, excludes) {
			continue
		}
		if strings.HasSuffix(relative, "/") && object.Size == 0 {
			continue
		}
		name := relative
		if slash := strings.LastIndexByte(name, '/'); slash >= 0 {
			name = name[slash+1:]
		}
		id := "o:" + relative
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		modified := object.LastModified
		var modifiedPtr *time.Time
		if !modified.IsZero() {
			modifiedPtr = &modified
		}
		items = append(items, listItemJSON{
			Type:         "content",
			Name:         name,
			Key:          relative,
			Size:         object.Size,
			LastModified: modifiedPtr,
			ETag:         object.ETag,
			ContentType:  object.ContentType,
		})
	}
	if navigationOnly {
		items = a.navigationFilter(r, instance, items)
	}
	sortListItems(items)
	response := listResponseJSON{
		Instance:              instance.cfg.ID,
		Prefix:                prefix,
		Delimiter:             delimiter,
		Items:                 items,
		NextContinuationToken: page.NextPageToken,
		IsTruncated:           page.NextPageToken != "",
		ScanComplete:          scanComplete,
		SortAvailable:         pageToken == "" && scanComplete,
		Access:                nodeAccess,
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// sortListItems orders folders before objects, then by case-insensitive name. The lower-cased names are computed
// once per item instead of on every comparison.
func sortListItems(items []listItemJSON) {
	type sortable struct {
		item  listItemJSON
		lower string
	}
	rows := make([]sortable, len(items))
	for index, item := range items {
		rows[index] = sortable{item: item, lower: strings.ToLower(item.Name)}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].item.Type != rows[j].item.Type {
			return rows[i].item.Type == "prefix"
		}
		return rows[i].lower < rows[j].lower
	})
	for index := range rows {
		items[index] = rows[index].item
	}
}

type aggregate struct {
	Count int64 `json:"count"`
	Bytes int64 `json:"bytes"`
}

// statsEntry is one of the largest objects encountered by a recursive stats
// job. The bounded slice is kept as a min-heap so an arbitrarily large
// prefix can be reduced to a bounded set without retaining every object in
// memory. publicJob cloning sorts a copy for the frontend.
type statsEntry struct {
	Path         string `json:"path"`
	Bytes        int64  `json:"bytes"`
	Type         string `json:"type"`
	MIME         string `json:"mime,omitempty"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
}

type statsTreemapNode struct {
	Name         string             `json:"name"`
	Path         string             `json:"path,omitempty"`
	Bytes        int64              `json:"bytes"`
	Count        int64              `json:"count"`
	Kind         string             `json:"kind"`
	Type         string             `json:"type,omitempty"`
	MIME         string             `json:"mime,omitempty"`
	ETag         string             `json:"etag,omitempty"`
	LastModified string             `json:"lastModified,omitempty"`
	Children     []statsTreemapNode `json:"children,omitempty"`
}

type statsResponse struct {
	Instance                string               `json:"instance"`
	LayoutVersion           int                  `json:"layoutVersion,omitempty"`
	Prefix                  string               `json:"prefix"`
	Count                   int64                `json:"count"`
	TotalBytes              int64                `json:"totalBytes"`
	TookMS                  int64                `json:"tookMs"`
	ByType                  map[string]aggregate `json:"byType"`
	ByFolder                map[string]aggregate `json:"byFolder"`
	FolderLimit             int                  `json:"folderLimit,omitempty"`
	FoldersTruncated        bool                 `json:"foldersTruncated,omitempty"`
	FolderAggregatesOmitted int64                `json:"folderAggregatesOmitted,omitempty"`
	TreemapThresholdBytes   int64                `json:"treemapThresholdBytes,omitempty"`
	Treemap                 *statsTreemapNode    `json:"treemap,omitempty"`
	Largest                 []statsEntry         `json:"largest,omitempty"`
	Recent                  []statsEntry         `json:"recent,omitempty"`
	Newest                  *time.Time           `json:"newest,omitempty"`
	Oldest                  *time.Time           `json:"oldest,omitempty"`
}

func (a *application) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, err := a.instanceFromRequest(r, "", permissionRead)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	prefix := normalizePrefix(cleanRelativeKey(r.URL.Query().Get("prefix")))
	if err := a.requireAccess(r, instance, permissionRead, prefix); err != nil {
		writeAPIError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeAPIError(w, err)
		return
	}
	job, found := a.jobs.reusableStatsJob(instance.cfg.ID, prefix, time.Now().UTC())
	if !found {
		job, err = a.jobs.create(jobState{
			Type:     jobTypeStatsPrefix,
			Instance: instance.cfg.ID,
			Prefix:   prefix,
		})
		if err != nil {
			writeAPIError(w, err)
			return
		}
	}
	if job.Status == jobStatusCompleted && job.Stats != nil {
		writeJSON(w, http.StatusOK, job.public())
		return
	}
	if finished, ok := a.jobs.waitForTerminal(r.Context(), job.ID, statsInlineWait); ok {
		writeJSON(w, http.StatusOK, finished.public())
		return
	}
	writeJSON(w, http.StatusAccepted, job.public())
}

type objectOperationRequest struct {
	Instance string `json:"instance"`
	Source   string `json:"src"`
	Target   string `json:"dst"`
	IsPrefix bool   `json:"isPrefix"`
}

// accessKeys gives the source and the destination as the operation uses them,
// for the questions to the PDP.
func (o objectOperationRequest) accessKeys() (string, string) {
	source, target := cleanRelativeKey(o.Source), cleanRelativeKey(o.Target)
	if o.IsPrefix {
		return normalizePrefix(source), normalizePrefix(target)
	}
	return source, target
}

func (a *application) handleCopy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var request objectOperationRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeAPIError(w, err)
		return
	}
	instance, err := a.instanceFromRequest(r, request.Instance, permissionRead)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	source, target := request.accessKeys()
	if action, ok := a.checkAccess(r,
		accessRequirement{permissionRead, instance, source},
		accessRequirement{permissionWrite, instance, target},
	); !ok {
		writeAPIError(w, forbidden(action))
		return
	}
	for _, permission := range []string{permissionRead, permissionWrite} {
		if err := requirePermission(instance, permission); err != nil {
			writeAPIError(w, err)
			return
		}
	}
	if request.IsPrefix {
		source, target, err := validatePrefixOperation(request.Source, request.Target)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		job, err := a.jobs.create(jobState{Type: jobTypeCopyPrefix, Instance: instance.cfg.ID, Source: source, Target: target})
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, job.public())
		return
	}
	count, err := copyOrMove(r.Context(), instance, request.Source, request.Target, false, false)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"copied": count})
}

func (a *application) handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var request objectOperationRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeAPIError(w, err)
		return
	}
	instance, err := a.instanceFromRequest(r, request.Instance, permissionRead)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	source, target := request.accessKeys()
	if action, ok := a.checkAccess(r,
		accessRequirement{permissionRead, instance, source},
		accessRequirement{permissionDelete, instance, source},
		accessRequirement{permissionWrite, instance, target},
	); !ok {
		writeAPIError(w, forbidden(action))
		return
	}
	for _, permission := range []string{permissionRead, permissionWrite, permissionDelete} {
		if err := requirePermission(instance, permission); err != nil {
			writeAPIError(w, err)
			return
		}
	}
	if request.IsPrefix {
		source, target, err := validatePrefixOperation(request.Source, request.Target)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		job, err := a.jobs.create(jobState{Type: jobTypeMovePrefix, Instance: instance.cfg.ID, Source: source, Target: target})
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, job.public())
		return
	}
	count, err := copyOrMove(r.Context(), instance, request.Source, request.Target, false, true)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"moved": count})
}

type deletePrefixRequest struct {
	Instance string `json:"instance"`
	Prefix   string `json:"prefix"`
}

func (a *application) handleDeletePrefix(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var request deletePrefixRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeAPIError(w, err)
		return
	}
	instance, err := a.instanceFromRequest(r, request.Instance, permissionDelete)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	prefix := normalizePrefix(cleanRelativeKey(request.Prefix))
	if action, ok := a.checkAccess(r,
		accessRequirement{permissionRead, instance, prefix},
		accessRequirement{permissionDelete, instance, prefix},
	); !ok {
		writeAPIError(w, forbidden(action))
		return
	}
	for _, permission := range []string{permissionRead, permissionDelete} {
		if err := requirePermission(instance, permission); err != nil {
			writeAPIError(w, err)
			return
		}
	}
	if prefix == "" {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_prefix", Message: "refusing to delete the whole bucket; prefix is required"})
		return
	}
	job, err := a.jobs.create(jobState{Type: jobTypeDeletePrefix, Instance: instance.cfg.ID, Prefix: prefix})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job.public())
}

func copyOrMove(ctx context.Context, instance *storageInstance, source, target string, isPrefix, move bool) (int, error) {
	source = cleanRelativeKey(source)
	target = cleanRelativeKey(target)
	if isPrefix {
		source = normalizePrefix(source)
		target = normalizePrefix(target)
	}
	if source == "" || target == "" {
		return 0, apiError{Status: http.StatusBadRequest, Code: "invalid_path", Message: "src and dst are required"}
	}
	if source == target {
		return 0, apiError{Status: http.StatusBadRequest, Code: "same_path", Message: "src and dst must be different"}
	}
	if isPrefix && strings.HasPrefix(target, source) {
		return 0, apiError{Status: http.StatusBadRequest, Code: "recursive_destination", Message: "destination cannot be inside source prefix"}
	}
	if isPrefix && strings.HasPrefix(source, target) {
		return 0, apiError{Status: http.StatusBadRequest, Code: "overlapping_prefixes", Message: "destination cannot contain source prefix because object paths would overlap"}
	}

	if !isPrefix {
		if err := instance.Copy(ctx, instance.fullKey(source), instance.fullKey(target)); err != nil {
			return 0, err
		}
		if move {
			if err := instance.Delete(ctx, instance.fullKey(source)); err != nil {
				return 0, fmt.Errorf("copy succeeded but source deletion failed: %w", err)
			}
		}
		return 1, nil
	}

	keys, err := collectObjectKeys(ctx, instance, source)
	if err != nil {
		return 0, err
	}
	if len(keys) == 0 {
		return 0, apiError{Status: http.StatusNotFound, Code: "empty_prefix", Message: "source prefix contains no objects"}
	}
	copied := 0
	for _, key := range keys {
		relativeSuffix := strings.TrimPrefix(key, source)
		destination := target + relativeSuffix
		if err := instance.Copy(ctx, instance.fullKey(key), instance.fullKey(destination)); err != nil {
			return copied, fmt.Errorf("copy %q to %q after %d object(s): %w", key, destination, copied, err)
		}
		copied++
	}
	if move {
		fullKeys := make([]string, len(keys))
		for index, key := range keys {
			fullKeys[index] = instance.fullKey(key)
		}
		if err := instance.DeleteMany(ctx, fullKeys); err != nil {
			return copied, fmt.Errorf("all copies succeeded but the deletion of the sources failed: %w", err)
		}
	}
	return copied, nil
}

func collectObjectKeys(ctx context.Context, instance *storageInstance, prefix string) ([]string, error) {
	keys := make([]string, 0)
	err := forEachObject(ctx, instance, prefix, func(_ objectInfo, relative string) error {
		keys = append(keys, relative)
		return nil
	})
	return keys, err
}

func forEachObject(ctx context.Context, instance *storageInstance, prefix string, fn func(objectInfo, string) error) error {
	var pageToken string
	for {
		page, err := instance.List(ctx, listOptions{
			Prefix:     instance.fullKey(prefix),
			MaxResults: 1000,
			PageToken:  pageToken,
		})
		if err != nil {
			return err
		}
		for _, object := range page.Objects {
			relative, ok := instance.relativeKey(object.Key)
			if !ok {
				continue
			}
			if err := fn(object, relative); err != nil {
				return err
			}
		}
		if page.NextPageToken == "" {
			return nil
		}
		if page.NextPageToken == pageToken {
			return fmt.Errorf("provider returned the same continuation token twice")
		}
		pageToken = page.NextPageToken
	}
}

func (a *application) handleOpenOriginal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	instance, err := a.instanceFromRequest(r, "", permissionRead)
	if err != nil {
		writeGatewayError(w, err)
		return
	}
	key := cleanRelativeKey(r.URL.Query().Get("key"))
	if err := a.requireAccess(r, instance, permissionRead, key); err != nil {
		writeGatewayError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeGatewayError(w, err)
		return
	}
	if key == "" {
		writeGatewayError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "object key cannot be empty"})
		return
	}
	fullKey := instance.fullKey(key)
	version := strings.TrimSpace(r.URL.Query().Get("version"))
	filename := path.Base(key)
	if filename == "." || filename == "/" || filename == "" {
		filename = "download"
	}
	if r.Method == http.MethodHead {
		response, err := instance.HeadVersion(r.Context(), fullKey, version)
		if err != nil {
			writeGatewayError(w, err)
			return
		}
		if response.Body != nil {
			defer response.Body.Close()
		}
		copyObjectHeaders(w.Header(), response.Header)
		applyOpenOriginalHeaders(w.Header(), key, filename)
		applyObjectSafetyHeaders(w.Header())
		w.WriteHeader(response.StatusCode)
		return
	}
	response, err := instance.GetVersion(r.Context(), fullKey, version, r.Header)
	if err != nil {
		writeGatewayError(w, err)
		return
	}
	defer response.Body.Close()
	copyObjectHeaders(w.Header(), response.Header)
	applyOpenOriginalHeaders(w.Header(), key, filename)
	applyObjectSafetyHeaders(w.Header())
	w.WriteHeader(response.StatusCode)
	_, _ = copyStream(w, response.Body)
}

func applyOpenOriginalHeaders(headers http.Header, key, filename string) {
	contentType := strings.TrimSpace(headers.Get("Content-Type"))
	if isGenericObjectContentType(contentType) {
		if inferred := previewContentType(key); inferred != "" {
			contentType = inferred
			headers.Set("Content-Type", inferred)
		}
	}
	disposition := "attachment"
	if browserInlineContent(key, contentType) {
		disposition = "inline"
	}
	if value := mime.FormatMediaType(disposition, map[string]string{"filename": filename}); value != "" {
		headers.Set("Content-Disposition", value)
	} else {
		headers.Set("Content-Disposition", disposition)
	}
	headers.Set("Accept-Ranges", "bytes")
}

func browserInlineContent(key, contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])
	}
	mediaType = strings.ToLower(mediaType)
	extension := strings.ToLower(path.Ext(key))

	// Only advertise inline rendering for formats that current browsers can
	// commonly open without a plugin. A provider-supplied image/audio/video MIME
	// alone is not sufficient: unsupported codecs such as MKV, AVI or WMA must
	// download with the real object filename instead of opening as an object
	// named after the gateway route.
	inlineExtensions := map[string]struct{}{
		".pdf": {}, ".txt": {}, ".log": {}, ".css": {}, ".json": {}, ".xml": {}, ".html": {}, ".htm": {},
		".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".avif": {}, ".bmp": {}, ".ico": {}, ".svg": {},
		".mp3": {}, ".m4a": {}, ".aac": {}, ".flac": {}, ".wav": {}, ".ogg": {}, ".oga": {}, ".opus": {},
		".mp4": {}, ".m4v": {}, ".mov": {}, ".webm": {}, ".ogv": {},
	}
	if _, ok := inlineExtensions[extension]; ok {
		return true
	}

	switch mediaType {
	case "application/pdf", "text/plain", "text/css", "text/html", "application/json", "application/xml", "text/xml",
		"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml",
		"audio/mpeg", "audio/mp4", "audio/aac", "audio/flac", "audio/wav", "audio/x-wav", "audio/ogg", "audio/opus",
		"video/mp4", "video/quicktime", "video/webm", "video/ogg":
		return true
	default:
		return false
	}
}

func (a *application) handleObjectGateway(w http.ResponseWriter, r *http.Request) {
	permission := permissionRead
	switch r.Method {
	case http.MethodPut:
		permission = permissionWrite
	case http.MethodDelete:
		permission = permissionDelete
	}
	instance, err := a.instanceFromRequest(r, "", permission)
	if err != nil {
		writeGatewayError(w, err)
		return
	}
	key, err := keyFromGatewayPath(r)
	if err != nil {
		writeGatewayError(w, err)
		return
	}
	if key == "" {
		a.handleRawList(w, r, instance)
		return
	}
	if r.Method != http.MethodOptions {
		if err := a.requireAccess(r, instance, permission, key); err != nil {
			writeGatewayError(w, err)
			return
		}
	}
	fullKey := instance.fullKey(key)
	version := strings.TrimSpace(r.URL.Query().Get("version"))
	preview := r.URL.Query().Get("preview") == "1"
	rangeOnly := preview && r.URL.Query().Get("range_only") == "1"
	switch r.Method {
	case http.MethodGet:
		if err := requirePermission(instance, permissionRead); err != nil {
			writeGatewayError(w, err)
			return
		}
		if rangeOnly && !isBoundedPreviewRange(r.Header.Get("Range"), 16<<20) {
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Cache-Control", "private, no-store")
			writeJSON(w, http.StatusRequestedRangeNotSatisfiable, map[string]any{
				"error":   "bounded_range_required",
				"message": "PDF preview requires one explicit byte range no larger than 16 MiB; the complete object was not downloaded",
			})
			return
		}
		response, err := instance.GetVersion(r.Context(), fullKey, version, r.Header)
		if err != nil {
			writeGatewayError(w, err)
			return
		}
		defer response.Body.Close()
		if preview && strings.TrimSpace(r.Header.Get("Range")) != "" {
			if handled := a.writePreviewRangeResponse(w, r, instance, fullKey, key, response); handled {
				return
			}
		}
		copyObjectHeaders(w.Header(), response.Header)
		if preview {
			applyPreviewObjectHeaders(w.Header(), key)
		}
		applyObjectSafetyHeaders(w.Header())
		w.WriteHeader(response.StatusCode)
		_, _ = copyStream(w, response.Body)
	case http.MethodHead:
		if err := requirePermission(instance, permissionRead); err != nil {
			writeGatewayError(w, err)
			return
		}
		response, err := instance.HeadVersion(r.Context(), fullKey, version)
		if err != nil {
			writeGatewayError(w, err)
			return
		}
		copyObjectHeaders(w.Header(), response.Header)
		if preview {
			applyPreviewObjectHeaders(w.Header(), key)
		}
		applyObjectSafetyHeaders(w.Header())
		w.WriteHeader(response.StatusCode)
	case http.MethodPut:
		if err := requirePermission(instance, permissionWrite); err != nil {
			writeGatewayError(w, err)
			return
		}
		if err := instance.Put(r.Context(), fullKey, r.Body, r.ContentLength, r.Header.Get("Content-Type")); err != nil {
			writeGatewayError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if err := requirePermission(instance, permissionDelete); err != nil {
			writeGatewayError(w, err)
			return
		}
		if version != "" {
			if err := instance.DeleteVersion(r.Context(), fullKey, version); err != nil {
				writeGatewayError(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if err := instance.Delete(r.Context(), fullKey); err != nil {
			writeGatewayError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodOptions:
		w.Header().Set("Allow", "GET, HEAD, PUT, DELETE, OPTIONS")
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w, http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete, http.MethodOptions)
	}
}

func isBoundedPreviewRange(value string, maximumSpan int64) bool {
	if maximumSpan <= 0 {
		return false
	}
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(value), "bytes=") || strings.Contains(value, ",") {
		return false
	}
	parts := strings.SplitN(strings.TrimSpace(value[len("bytes="):]), "-", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return false
	}
	start, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil || start < 0 {
		return false
	}
	end, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
	return err == nil && end >= start && end-start+1 <= maximumSpan
}

type gatewayByteRange struct {
	start int64
	end   int64
}

func parseGatewayContentRange(value string) (gatewayByteRange, int64, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(value), "bytes ") {
		return gatewayByteRange{}, -1, fmt.Errorf("invalid content range")
	}
	raw := strings.TrimSpace(value[len("bytes "):])
	parts := strings.SplitN(raw, "/", 2)
	if len(parts) != 2 || parts[0] == "*" || parts[1] == "*" {
		return gatewayByteRange{}, -1, fmt.Errorf("invalid content range")
	}
	total, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
	if err != nil || total < 0 {
		return gatewayByteRange{}, -1, fmt.Errorf("invalid content range total")
	}
	bounds := strings.SplitN(strings.TrimSpace(parts[0]), "-", 2)
	if len(bounds) != 2 {
		return gatewayByteRange{}, -1, fmt.Errorf("invalid content range bounds")
	}
	start, err := strconv.ParseInt(strings.TrimSpace(bounds[0]), 10, 64)
	if err != nil || start < 0 {
		return gatewayByteRange{}, -1, fmt.Errorf("invalid content range start")
	}
	end, err := strconv.ParseInt(strings.TrimSpace(bounds[1]), 10, 64)
	if err != nil || end < start || (total > 0 && end >= total) {
		return gatewayByteRange{}, -1, fmt.Errorf("invalid content range end")
	}
	return gatewayByteRange{start: start, end: end}, total, nil
}

func parseGatewayByteRange(value string, total int64) (gatewayByteRange, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(value), "bytes=") || total < 0 {
		return gatewayByteRange{}, fmt.Errorf("invalid byte range")
	}
	raw := strings.TrimSpace(value[len("bytes="):])
	if raw == "" || strings.Contains(raw, ",") {
		return gatewayByteRange{}, fmt.Errorf("multiple or empty byte ranges are not supported")
	}
	parts := strings.SplitN(raw, "-", 2)
	if len(parts) != 2 {
		return gatewayByteRange{}, fmt.Errorf("invalid byte range")
	}
	left := strings.TrimSpace(parts[0])
	right := strings.TrimSpace(parts[1])
	if left == "" {
		suffix, err := strconv.ParseInt(right, 10, 64)
		if err != nil || suffix <= 0 || total == 0 {
			return gatewayByteRange{}, fmt.Errorf("invalid suffix byte range")
		}
		if suffix > total {
			suffix = total
		}
		return gatewayByteRange{start: total - suffix, end: total - 1}, nil
	}
	start, err := strconv.ParseInt(left, 10, 64)
	if err != nil || start < 0 || start >= total {
		return gatewayByteRange{}, fmt.Errorf("byte range starts beyond the object")
	}
	end := total - 1
	if right != "" {
		end, err = strconv.ParseInt(right, 10, 64)
		if err != nil || end < start {
			return gatewayByteRange{}, fmt.Errorf("invalid byte range end")
		}
		if end >= total {
			end = total - 1
		}
	}
	return gatewayByteRange{start: start, end: end}, nil
}

func (a *application) writePreviewRangeResponse(
	w http.ResponseWriter,
	r *http.Request,
	_ *storageInstance,
	_ string,
	key string,
	response objectResponse,
) bool {
	if response.Body == nil || (response.StatusCode != http.StatusPartialContent && response.StatusCode != http.StatusOK) {
		return false
	}

	upstreamRange, total, err := parseGatewayContentRange(response.Header.Get("Content-Range"))
	if err != nil {
		writeGatewayError(w, apiError{
			Status:  http.StatusBadGateway,
			Code:    "preview_range_not_supported",
			Message: "the storage provider ignored the byte-range request required for this preview; the server refused to scan or buffer the complete object",
		})
		return true
	}

	requested, err := parseGatewayByteRange(r.Header.Get("Range"), total)
	if err != nil {
		copyObjectHeaders(w.Header(), response.Header)
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		w.Header().Del("Content-Length")
		applyObjectSafetyHeaders(w.Header())
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return true
	}

	if upstreamRange != requested {
		writeGatewayError(w, apiError{
			Status:  http.StatusBadGateway,
			Code:    "preview_range_mismatch",
			Message: "the storage provider returned a different byte range than the preview requested",
		})
		return true
	}

	length := requested.end - requested.start + 1
	if advertised := strings.TrimSpace(response.Header.Get("Content-Length")); advertised != "" {
		contentLength, parseErr := strconv.ParseInt(advertised, 10, 64)
		if parseErr != nil || contentLength != length {
			writeGatewayError(w, apiError{
				Status:  http.StatusBadGateway,
				Code:    "preview_range_truncated",
				Message: "the storage provider returned an invalid byte count for the requested preview range",
			})
			return true
		}
	}

	copyObjectHeaders(w.Header(), response.Header)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", requested.start, requested.end, total))
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.Header().Del("Content-Encoding")
	applyPreviewObjectHeaders(w.Header(), key)
	applyObjectSafetyHeaders(w.Header())
	w.WriteHeader(http.StatusPartialContent)
	_, _ = copyStream(w, io.LimitReader(response.Body, length))
	return true
}

func (a *application) handleRawList(w http.ResponseWriter, r *http.Request, instance *storageInstance) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	query := r.URL.Query()
	if err := a.requireAccess(r, instance, permissionRead, cleanRelativeKey(query.Get("prefix"))); err != nil {
		writeGatewayError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeGatewayError(w, err)
		return
	}
	maxResults := parseBoundedInt(query.Get("max-keys"), 1000, 1, 1000)
	startAfter := cleanRelativeKey(query.Get("start-after"))
	if startAfter != "" {
		startAfter = instance.fullKey(startAfter)
	}
	page, err := instance.List(r.Context(), listOptions{
		Prefix:     instance.fullKey(cleanRelativeKey(query.Get("prefix"))),
		Delimiter:  query.Get("delimiter"),
		MaxResults: maxResults,
		PageToken:  query.Get("continuation-token"),
		StartAfter: startAfter,
	})
	if err != nil {
		writeGatewayError(w, err)
		return
	}
	type commonPrefix struct {
		Prefix string `xml:"Prefix"`
	}
	type content struct {
		Key          string `xml:"Key"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
		Size         int64  `xml:"Size"`
	}
	result := struct {
		XMLName               xml.Name       `xml:"ListBucketResult"`
		Xmlns                 string         `xml:"xmlns,attr"`
		Name                  string         `xml:"Name"`
		Prefix                string         `xml:"Prefix"`
		Delimiter             string         `xml:"Delimiter,omitempty"`
		MaxKeys               int            `xml:"MaxKeys"`
		IsTruncated           bool           `xml:"IsTruncated"`
		NextContinuationToken string         `xml:"NextContinuationToken,omitempty"`
		CommonPrefixes        []commonPrefix `xml:"CommonPrefixes"`
		Contents              []content      `xml:"Contents"`
	}{
		Xmlns:                 "http://s3.amazonaws.com/doc/2006-03-01/",
		Name:                  instance.cfg.Bucket,
		Prefix:                cleanRelativeKey(query.Get("prefix")),
		Delimiter:             query.Get("delimiter"),
		MaxKeys:               maxResults,
		IsTruncated:           page.NextPageToken != "",
		NextContinuationToken: page.NextPageToken,
	}
	for _, prefix := range page.Prefixes {
		if relative, ok := instance.relativeKey(prefix); ok {
			result.CommonPrefixes = append(result.CommonPrefixes, commonPrefix{Prefix: relative})
		}
	}
	for _, object := range page.Objects {
		if relative, ok := instance.relativeKey(object.Key); ok {
			result.Contents = append(result.Contents, content{
				Key:          relative,
				LastModified: object.LastModified.UTC().Format(time.RFC3339),
				ETag:         object.ETag,
				Size:         object.Size,
			})
		}
	}
	w.Header().Set("Content-Type", "application/xml")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write([]byte(xml.Header))
	_ = xml.NewEncoder(w).Encode(result)
}

func (a *application) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "instances": len(a.instances)})
}

// instanceFromRequest finds the bucket of a request: the instance of the body,
// else the query parameter instance, else the first bucket. The permission
// gives the action of the 403 answer for a hidden or an unknown bucket in the
// authzen mode. The handler then asks the action on its exact resource.
func (a *application) instanceFromRequest(r *http.Request, bodyInstance, permission string) (*storageInstance, error) {
	id := strings.TrimSpace(bodyInstance)
	if id == "" {
		id = strings.TrimSpace(r.URL.Query().Get("instance"))
	}
	if id == "" && len(a.order) > 0 {
		id = a.order[0]
	}
	return a.resolveInstance(r, id, permission)
}

func requirePermission(instance *storageInstance, permission string) error {
	if instance.permitted(permission) {
		return nil
	}
	return apiError{
		Status:  http.StatusForbidden,
		Code:    "permission_denied",
		Message: fmt.Sprintf("instance %q does not expose %s permission", instance.cfg.ID, permission),
	}
}

func keyFromGatewayPath(r *http.Request) (string, error) {
	if r.URL.Path != "/s3" {
		return "", apiError{Status: http.StatusBadRequest, Code: "invalid_path", Message: "invalid object gateway path"}
	}
	values, present := r.URL.Query()["key"]
	if !present {
		return "", nil
	}
	if len(values) != 1 {
		return "", apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "exactly one key query parameter is required"}
	}
	key := cleanRelativeKey(values[0])
	if key == "" {
		return "", apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "object key cannot be empty"}
	}
	return key, nil
}

func cleanRelativeKey(value string) string {
	// Object keys are opaque strings, not filesystem paths. Preserve repeated
	// separators, dot segments and backslashes; only the gateway's leading slash
	// is structural and must be removed.
	return strings.TrimLeft(strings.ReplaceAll(value, "\x00", ""), "/")
}

func parseExcludes(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = cleanRelativeKey(strings.TrimSpace(part))
			if part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

func isExcluded(relative string, excludes []string) bool {
	for _, exclude := range excludes {
		if strings.HasPrefix(relative, exclude) {
			return true
		}
	}
	return false
}

func parseBoundedInt(raw string, fallback, minimum, maximum int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum {
		return fallback
	}
	if value > maximum {
		return maximum
	}
	return value
}

func copyObjectHeaders(destination, source http.Header) {
	allowed := map[string]bool{
		"accept-ranges":       true,
		"cache-control":       true,
		"content-disposition": true,
		"content-encoding":    true,
		"content-language":    true,
		"content-length":      true,
		"content-range":       true,
		"content-type":        true,
		"etag":                true,
		"expires":             true,
		"last-modified":       true,
		"vary":                true,
		"x-amz-version-id":    true,
		"x-goog-generation":   true,
		"x-goog-hash":         true,
	}
	for name, values := range source {
		lower := strings.ToLower(name)
		if !allowed[lower] && !strings.HasPrefix(lower, "x-amz-meta-") && !strings.HasPrefix(lower, "x-goog-meta-") {
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func applyPreviewObjectHeaders(headers http.Header, key string) {
	headers.Set("Accept-Ranges", "bytes")
	existing := strings.TrimSpace(headers.Get("Content-Type"))
	if isGenericObjectContentType(existing) {
		if inferred := previewContentType(key); inferred != "" {
			headers.Set("Content-Type", inferred)
		}
	}
	filename := path.Base(strings.TrimSpace(key))
	if filename == "." || filename == "/" || filename == "" {
		headers.Set("Content-Disposition", "inline")
		return
	}
	if value := mime.FormatMediaType("inline", map[string]string{"filename": filename}); value != "" {
		headers.Set("Content-Disposition", value)
	} else {
		headers.Set("Content-Disposition", "inline")
	}
}

func isGenericObjectContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil {
		mediaType = strings.TrimSpace(strings.SplitN(value, ";", 2)[0])
	}
	switch strings.ToLower(mediaType) {
	case "", "application/octet-stream", "binary/octet-stream", "application/binary", "application/unknown":
		return true
	default:
		return false
	}
}

func previewContentType(key string) string {
	extension := strings.ToLower(path.Ext(key))
	known := map[string]string{
		".mp4":   "video/mp4",
		".m4v":   "video/x-m4v",
		".mov":   "video/quicktime",
		".webm":  "video/webm",
		".mkv":   "video/x-matroska",
		".mxf":   "application/mxf",
		".avi":   "video/x-msvideo",
		".ogv":   "video/ogg",
		".mpg":   "video/mpeg",
		".mpeg":  "video/mpeg",
		".m2ts":  "video/mp2t",
		".mts":   "video/mp2t",
		".ts":    "video/mp2t",
		".vob":   "video/dvd",
		".mp3":   "audio/mpeg",
		".m4a":   "audio/mp4",
		".aac":   "audio/aac",
		".flac":  "audio/flac",
		".wav":   "audio/wav",
		".ogg":   "audio/ogg",
		".opus":  "audio/ogg; codecs=opus",
		".aif":   "audio/aiff",
		".aiff":  "audio/aiff",
		".jpg":   "image/jpeg",
		".jpeg":  "image/jpeg",
		".png":   "image/png",
		".gif":   "image/gif",
		".webp":  "image/webp",
		".avif":  "image/avif",
		".svg":   "image/svg+xml",
		".bmp":   "image/bmp",
		".ico":   "image/x-icon",
		".vcf":   "text/vcard; charset=utf-8",
		".vcard": "text/vcard; charset=utf-8",
		".ics":   "text/calendar; charset=utf-8",
		".ifb":   "text/calendar; charset=utf-8",
		".eml":   "message/rfc822",
		".mime":  "message/rfc822",
		".pem":   "application/x-pem-file",
		".crt":   "application/x-x509-ca-cert",
		".cer":   "application/pkix-cert",
		".der":   "application/pkix-cert",
		".tif":   "image/tiff",
		".tiff":  "image/tiff",
		".pdf":   "application/pdf",
	}
	if value := known[extension]; value != "" {
		return value
	}
	return mime.TypeByExtension(extension)
}

func applyObjectSafetyHeaders(headers http.Header) {
	// Bucket objects share the application's origin. Sandbox any object that a
	// browser may interpret as an active document so uploaded HTML/SVG cannot
	// execute with access to the browser API.
	headers.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'")
	headers.Set("Cross-Origin-Resource-Policy", "same-origin")
	headers.Set("X-Content-Type-Options", "nosniff")
}

type apiError struct {
	Status  int
	Code    string
	Message string
	// Action is the action of the access policy of a 403 answer.
	Action string
}

func (e apiError) Error() string { return e.Message }

func decodeJSONBody(r *http.Request, destination any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, (1<<20)+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return apiError{Status: http.StatusBadRequest, Code: "invalid_json", Message: "invalid JSON body: " + err.Error()}
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return apiError{Status: http.StatusBadRequest, Code: "invalid_json", Message: "JSON body must contain one object"}
	}
	return nil
}

func writeAPIError(w http.ResponseWriter, err error) {
	if budgetErr, ok := resourceLimitAPIError(err); ok {
		err = budgetErr
	}
	status := statusFromError(err)
	code := "storage_error"
	message := publicStorageError(err)
	var apiErr apiError
	if errors.As(err, &apiErr) {
		status = apiErr.Status
		code = apiErr.Code
		message = apiErr.Message
		if apiErr.Action != "" {
			writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "action": apiErr.Action}})
			return
		}
	} else {
		var upstream *upstreamError
		if errors.As(err, &upstream) {
			if providerCode := safeProviderErrorCode(upstream.Code); providerCode != "" {
				code = strings.ToLower(providerCode)
			}
		}
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}

func writeGatewayError(w http.ResponseWriter, err error) {
	w.Header().Set("Cache-Control", "no-store")
	if budgetErr, ok := resourceLimitAPIError(err); ok {
		err = budgetErr
	}
	status := statusFromError(err)
	message := publicStorageError(err)
	var apiErr apiError
	if errors.As(err, &apiErr) {
		// The 403 of the access policy has the same JSON body on each route.
		if apiErr.Action != "" {
			writeAPIError(w, apiErr)
			return
		}
		status = apiErr.Status
		message = apiErr.Message
	}
	http.Error(w, message, status)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func methodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

func detectKind(key, contentType string) string {
	mime := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch {
	case strings.HasPrefix(mime, "image/"):
		return "image"
	case strings.HasPrefix(mime, "video/"):
		return "video"
	case strings.HasPrefix(mime, "audio/"):
		return "audio"
	case mime == "application/pdf":
		return "pdf"
	case strings.Contains(mime, "sqlite"):
		return "database"
	}

	name := strings.ToLower(path.Base(key))
	extension := strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")
	switch extension {
	case "png", "jpg", "jpeg", "jpe", "gif", "webp", "bmp", "dib", "svg", "avif", "heif", "heic", "tif", "tiff", "qoi", "ico", "cur",
		"raw", "raf", "dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "pef", "rwl", "x3f", "iiq", "3fr", "fff", "mef", "mos", "mrw":
		return "image"
	case "mp4", "mkv", "webm", "avi", "mov", "m4v", "mpg", "mpeg", "flv", "3gp", "wmv", "ogv", "m2ts", "vob", "mxf", "m2v", "asf", "rm", "rmvb":
		return "video"
	case "mp3", "flac", "wav", "wave", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif", "alac", "wma", "amr", "midi", "mid":
		return "audio"
	case "pdf":
		return "pdf"
	case "md", "markdown", "mdown", "mkd", "rmd":
		return "markdown"
	case "doc", "docx", "docm", "dot", "dotx", "dotm", "rtf", "odt", "pages":
		return "document"
	case "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "ods", "csv", "tsv", "tab", "psv", "numbers", "parquet", "arrow", "feather":
		return "spreadsheet"
	case "ppt", "pptx", "pptm", "pps", "ppsx", "odp":
		return "presentation"
	case "sqlite", "sqlite3", "db", "db3", "s3db", "sl3":
		return "database"
	case "vcf", "vcard":
		return "contact"
	case "ics", "ifb":
		return "calendar"
	case "eml", "mime", "mht", "mhtml":
		return "email"
	case "pem", "crt", "cer", "cert", "der", "csr", "req", "p7b", "p7c", "spc", "pfx", "p12", "key", "pub":
		return "certificate"
	case "zip", "jar", "war", "ear", "apk", "aar", "xpi", "crx", "vsix", "epub", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz", "xz", "txz", "zst":
		return "archive"
	case "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "geojson", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "hcl", "tf", "tfvars", "sh", "bash", "zsh", "fish", "ps1", "py", "pyw", "pyi", "rb", "php", "java", "kt", "kts", "go", "mod", "sum", "work", "rs", "c", "cc", "cpp", "cxx", "h", "hpp", "hxx", "cs", "swift", "sql", "css", "scss", "sass", "less", "html", "htm", "xhtml", "xml", "proto", "graphql", "gql", "diff", "patch":
		return "code"
	case "txt", "log", "conf", "cfg", "properties":
		return "text"
	}
	switch name {
	case "dockerfile", "containerfile", "makefile", "gnumakefile", "jenkinsfile", "procfile", "gemfile", "rakefile", "vagrantfile", "caddyfile", "justfile", "taskfile", "earthfile", "brewfile", "podfile":
		return "code"
	}
	if strings.HasPrefix(name, ".env") || strings.HasPrefix(name, ".git") || strings.HasPrefix(name, ".docker") {
		return "code"
	}
	return "other"
}

const frontendBasePlaceholder = "{{APP_BASE}}"

func (a *application) handleStorageFrontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	if frontendDepth(r.URL.Path) > maxFrontendDepth {
		http.NotFound(w, r)
		return
	}
	relative := strings.TrimPrefix(r.URL.Path, "/-/")
	if relative == "" {
		a.notFoundPage(w, r)
		return
	}
	trailingSlash := strings.HasSuffix(r.URL.Path, "/")
	segments := strings.Split(strings.TrimSuffix(relative, "/"), "/")
	if len(segments) >= 2 {
		hostID, bucketID := segments[0], segments[1]
		// A hidden bucket gets the same 404 page as an unknown bucket.
		if instance, ok := a.instances[bucketID]; ok && instance != nil && instance.cfg.AuthID == hostID && a.bucketVisible(r, instance) {
			if len(segments) == 2 && !trailingSlash {
				target := bucketID + "/"
				if r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				w.Header().Set("Location", target)
				w.WriteHeader(http.StatusPermanentRedirect)
				return
			}
			requested := "/preview.html"
			if trailingSlash {
				requested = "/index.html"
			}
			serveEmbeddedFrontend(w, r, a.publicFS, requested, frontendBaseHref(r.URL.Path))
			return
		}
	}

	// Keep previously shared /-/<instance>/... links usable. The first request
	// is redirected to the canonical /-/<host>/<bucket>/... route while
	// preserving the public application prefix and the opaque encoded key.
	legacyID := segments[0]
	legacy, ok := a.instances[legacyID]
	if !ok || legacy == nil || !a.bucketVisible(r, legacy) {
		a.notFoundPage(w, r)
		return
	}
	escapedRelative := strings.TrimPrefix(r.URL.EscapedPath(), "/-/")
	rest := ""
	if separator := strings.IndexByte(escapedRelative, '/'); separator >= 0 {
		rest = escapedRelative[separator:]
	}
	if rest == "" {
		rest = "/"
	}
	target := frontendBaseHref(r.URL.Path) + "-/" + url.PathEscape(legacy.cfg.AuthID) + "/" + url.PathEscape(legacy.cfg.ID) + rest
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	w.Header().Set("Location", target)
	w.WriteHeader(http.StatusPermanentRedirect)
	return
}

// maxFrontendDepth is the deepest request path (in segments) that gets a frontend page. The base href grows with the
// depth and is part of the prepared-response cache key, so an unbounded depth would let a client mint large entries.
const maxFrontendDepth = 32

// frontendDepth counts the directory levels a browser climbs to leave requestPath, empty segments included.
func frontendDepth(requestPath string) int {
	clean := strings.Trim(strings.TrimSpace(requestPath), "/")
	if clean == "" {
		return 0
	}
	depth := len(strings.Split(clean, "/"))
	if !strings.HasSuffix(requestPath, "/") {
		depth--
	}
	if depth < 0 {
		return 0
	}
	return depth
}

// frontendBaseHref never returns more than maxFrontendDepth levels; callers refuse deeper paths before serving pages.
func frontendBaseHref(requestPath string) string {
	depth := min(frontendDepth(requestPath), maxFrontendDepth)
	if depth < 1 {
		return "./"
	}
	return strings.Repeat("../", depth)
}

// notFoundPage answers a browser navigation to an unknown address with the styled 404 page, and every other
// request (assets, API clients) with the plain "404 page not found".
func (a *application) notFoundPage(w http.ResponseWriter, r *http.Request) {
	notFoundPage(w, r, a.publicFS)
}

func notFoundPage(w http.ResponseWriter, r *http.Request, root fs.FS) {
	if r.Method != http.MethodGet || !strings.Contains(r.Header.Get("Accept"), "text/html") {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(root, "404.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	data = bytes.ReplaceAll(data, []byte(frontendBasePlaceholder), []byte(frontendBaseHref(r.URL.Path)))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(data)
}

func serveEmbeddedFrontend(w http.ResponseWriter, r *http.Request, root fs.FS, requested, baseHref string) {
	name := strings.TrimPrefix(requested, "/")
	version := frontendVersion(root)
	entry, err := preparedStatic(version, name, baseHref, func() ([]byte, error) {
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return nil, err
		}
		if bytes.Contains(data, []byte(frontendBasePlaceholder)) {
			data = bytes.ReplaceAll(data, []byte(frontendBasePlaceholder), []byte(baseHref))
		}
		return versionHTML(data, version), nil
	})
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveFrontendEntry(w, r, path.Base(requested), "text/html; charset=utf-8", "no-cache", entry)
}

func secureStaticHandler(root fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			methodNotAllowed(w, http.MethodGet, http.MethodHead)
			return
		}
		if frontendDepth(r.URL.Path) > maxFrontendDepth {
			http.NotFound(w, r)
			return
		}
		requested := path.Clean("/" + r.URL.Path)
		if requested == "/" {
			requested = "/index.html"
		} else {
			last := requested[strings.LastIndex(requested, "/")+1:]
			if !strings.Contains(last, ".") {
				candidate := requested + ".html"
				if _, err := fs.Stat(root, strings.TrimPrefix(candidate, "/")); err == nil {
					requested = candidate
				}
			}
		}
		if requested == "/index.html" || requested == "/preview.html" {
			serveEmbeddedFrontend(w, r, root, requested, frontendBaseHref(r.URL.Path))
			return
		}
		serveEmbeddedFile(w, r, root, requested)
	})
}

func serveEmbeddedFile(w http.ResponseWriter, r *http.Request, root fs.FS, requested string) {
	name := strings.TrimPrefix(requested, "/")
	info, err := fs.Stat(root, name)
	if err != nil || info.IsDir() {
		notFoundPage(w, r, root)
		return
	}
	extension := strings.ToLower(path.Ext(requested))
	contentType := mime.TypeByExtension(extension)
	if extension == ".mjs" {
		contentType = "text/javascript; charset=utf-8"
	}
	version := frontendVersion(root)
	entry, err := preparedStatic(version, name, "", func() ([]byte, error) {
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return nil, err
		}
		if extension == ".css" {
			data = versionCSS(data, version)
		}
		return data, nil
	})
	if err != nil {
		http.Error(w, "read embedded file", http.StatusInternalServerError)
		return
	}
	// Vendored libraries live under a versioned path, so their bytes never change for a given URL. First-party
	// files are cacheable for a year when the request carries the fingerprint of this build (the pages add it to
	// every URL); without it they are revalidated with a content ETag, so a 304 is the worst case.
	cacheControl := "no-cache"
	if strings.HasPrefix(requested, "/assets/vendor/") || r.URL.Query().Get("v") == version {
		cacheControl = "public, max-age=31536000, immutable"
	}
	serveFrontendEntry(w, r, info.Name(), contentType, cacheControl, entry)
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:")
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/s3" {
			w.Header().Set("Cache-Control", "private, no-store")
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	count, err := r.ResponseWriter.Write(data)
	r.bytes += int64(count)
	return count, err
}

func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func requestLogMiddleware(mode string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		info := &requestLogInfo{}
		next.ServeHTTP(recorder, r.WithContext(context.WithValue(r.Context(), requestLogKey{}, info)))
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		loggedPath := loggedRequestPath(mode, r.URL.Path)
		// %q keeps a decoded %0A or other control byte in the path from forging log lines.
		if info.Subject != "" {
			log.Printf("%s %q %d %dB %s subject=%q request_id=%s", r.Method, loggedPath, status, recorder.bytes, time.Since(start).Round(time.Millisecond), info.Subject, info.RequestID)
			return
		}
		log.Printf("%s %q %d %dB %s", r.Method, loggedPath, status, recorder.bytes, time.Since(start).Round(time.Millisecond))
	})
}

// loggedRequestPath hides the object keys and the ids of a path in the
// anonymous log mode.
func loggedRequestPath(mode, loggedPath string) string {
	if mode == logModeDetailed {
		return loggedPath
	}
	switch {
	case strings.HasPrefix(loggedPath, "/api/jobs/"):
		return "/api/jobs/<id>"
	case strings.HasPrefix(loggedPath, "/api/uploads/"):
		return "/api/uploads/<id>"
	case strings.HasPrefix(loggedPath, "/api/sqlite/sessions/"):
		return "/api/sqlite/sessions/<id>"
	case strings.HasPrefix(loggedPath, "/-/"):
		// Frontend routes carry the decoded object key or prefix in the path.
		return "/-/<path>"
	}
	return loggedPath
}
