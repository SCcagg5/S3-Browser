package main

import (
	"bytes"
	"context"
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
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed public
var embeddedPublic embed.FS

type application struct {
	config    appConfig
	instances map[string]*storageInstance
	order     []string
	publicFS  fs.FS
	jobs      *jobManager
	uploads   *uploadManager
	sqlite    *sqliteSessionManager
}

func newApplication(cfg appConfig) (*application, error) {
	publicFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		return nil, fmt.Errorf("open embedded frontend: %w", err)
	}
	app := &application{
		config:    cfg,
		instances: make(map[string]*storageInstance, len(cfg.Storages)),
		publicFS:  publicFS,
	}
	for _, storageCfg := range cfg.Storages {
		instance, err := newStorageInstance(storageCfg)
		if err != nil {
			return nil, fmt.Errorf("initialize storage %q: %w", storageCfg.ID, err)
		}
		app.instances[storageCfg.ID] = instance
		app.order = append(app.order, storageCfg.ID)
	}
	if cfg.DataDir == "" {
		cfg.DataDir = filepath.Join(cfg.SourceDir, ".s3-browser-data")
		app.config.DataDir = cfg.DataDir
	}
	jobs, err := newJobManager(app, cfg.DataDir, cfg.JobHistoryLimit)
	if err != nil {
		return nil, err
	}
	app.jobs = jobs
	uploads, err := newUploadManager(app, cfg.DataDir)
	if err != nil {
		jobs.close()
		return nil, err
	}
	app.uploads = uploads
	app.sqlite = newSQLiteSessionManager(app)
	return app, nil
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
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/instances", a.handleInstances)
	mux.HandleFunc("/api/build", a.handleBuild)
	mux.HandleFunc("/api/permissions/refresh", a.handlePermissionRefresh)
	mux.HandleFunc("/api/list", a.handleList)
	mux.HandleFunc("/api/stats", a.handleStats)
	mux.HandleFunc("/api/copy", a.handleCopy)
	mux.HandleFunc("/api/rename", a.handleRename)
	mux.HandleFunc("/api/delete-prefix", a.handleDeletePrefix)
	mux.HandleFunc("/api/jobs", a.handleJobs)
	mux.HandleFunc("/api/jobs/", a.handleJobs)
	mux.HandleFunc("/api/uploads", a.handleUploads)
	mux.HandleFunc("/api/uploads/", a.handleUploads)
	mux.HandleFunc("/api/spreadsheet", a.handleSpreadsheet)
	mux.HandleFunc("/api/delimited", a.handleDelimitedPage)
	mux.HandleFunc("/api/document-count", a.handleDocumentCount)
	mux.HandleFunc("/api/sqlite/sessions", a.handleSQLiteSessions)
	mux.HandleFunc("/api/sqlite/sessions/", a.handleSQLiteSessions)
	mux.HandleFunc("/api/json/raw", a.handleJSONRaw)
	mux.HandleFunc("/api/json/beautify", a.handleJSONBeautify)
	mux.HandleFunc("/api/json/summary", a.handleJSONSummary)
	mux.HandleFunc("/api/json/tree", a.handleJSONTree)
	mux.HandleFunc("/api/search", a.handleDocumentSearch)
	mux.HandleFunc("/api/media-info", a.handleMediaInfo)
	mux.HandleFunc("/api/image-preview", a.handleImagePreview)
	mux.HandleFunc("/healthz", a.handleHealth)
	mux.Handle("/", secureStaticHandler(a.publicFS))
	router := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// net/http.ServeMux canonicalizes dot segments and repeated slashes. S3
		// and GCS object keys are opaque, so route the object gateway before the
		// mux to preserve the exact escaped key supplied by the client.
		if r.URL.Path == "/s3" || strings.HasPrefix(r.URL.Path, "/s3/") {
			a.handleObjectGateway(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
	return requestLogMiddleware(securityHeadersMiddleware(router))
}

func (a *application) handleInstances(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instances := make([]instanceInfo, 0, len(a.order))
	for _, id := range a.order {
		instances = append(instances, a.instances[id].publicInfo())
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"default":   a.order[0],
		"instances": instances,
		"build":     currentBuildInfo(),
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
	instance, err := a.instanceFromRequest(r, "")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	caps := instance.refreshCapabilities(ctx)
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
}

func (a *application) handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	instance, err := a.instanceFromRequest(r, "")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeAPIError(w, err)
		return
	}
	prefix := cleanRelativeKey(r.URL.Query().Get("prefix"))
	delimiter := r.URL.Query().Get("delimiter")
	if _, present := r.URL.Query()["delimiter"]; !present {
		delimiter = "/"
	}
	if delimiter != "" && delimiter != "/" {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_delimiter", Message: "delimiter must be empty or /"})
		return
	}
	maxResults := parseBoundedInt(r.URL.Query().Get("max"), 50, 1, 1000)
	page, err := instance.backend.List(r.Context(), listOptions{
		Prefix:     instance.fullKey(prefix),
		Delimiter:  delimiter,
		MaxResults: maxResults,
		PageToken:  r.URL.Query().Get("continuationToken"),
	})
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
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Type != items[j].Type {
			return items[i].Type == "prefix"
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	response := listResponseJSON{
		Instance:              instance.cfg.ID,
		Prefix:                prefix,
		Delimiter:             delimiter,
		Items:                 items,
		NextContinuationToken: page.NextPageToken,
		IsTruncated:           page.NextPageToken != "",
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

type aggregate struct {
	Count int64 `json:"count"`
	Bytes int64 `json:"bytes"`
}

// statsEntry is one of the largest objects encountered by a recursive stats
// job. The persisted slice is kept as a min-heap so an arbitrarily large
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

type statsResponse struct {
	Instance      string               `json:"instance"`
	LayoutVersion int                  `json:"layoutVersion,omitempty"`
	Prefix        string               `json:"prefix"`
	Count         int64                `json:"count"`
	TotalBytes    int64                `json:"totalBytes"`
	TookMS        int64                `json:"tookMs"`
	ByType        map[string]aggregate `json:"byType"`
	ByFolder      map[string]aggregate `json:"byFolder"`
	Largest       []statsEntry         `json:"largest,omitempty"`
	Newest        *time.Time           `json:"newest,omitempty"`
	Oldest        *time.Time           `json:"oldest,omitempty"`
}

func (a *application) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	instance, err := a.instanceFromRequest(r, "")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeAPIError(w, err)
		return
	}
	prefix := normalizePrefix(cleanRelativeKey(r.URL.Query().Get("prefix")))
	job, err := a.jobs.create(persistentJob{
		Type:     jobTypeStatsPrefix,
		Instance: instance.cfg.ID,
		Prefix:   prefix,
	})
	if err != nil {
		writeAPIError(w, err)
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
	instance, err := a.instanceFromRequest(r, request.Instance)
	if err != nil {
		writeAPIError(w, err)
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
		job, err := a.jobs.create(persistentJob{Type: jobTypeCopyPrefix, Instance: instance.cfg.ID, Source: source, Target: target})
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
	instance, err := a.instanceFromRequest(r, request.Instance)
	if err != nil {
		writeAPIError(w, err)
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
		job, err := a.jobs.create(persistentJob{Type: jobTypeMovePrefix, Instance: instance.cfg.ID, Source: source, Target: target})
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
	instance, err := a.instanceFromRequest(r, request.Instance)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	for _, permission := range []string{permissionRead, permissionDelete} {
		if err := requirePermission(instance, permission); err != nil {
			writeAPIError(w, err)
			return
		}
	}
	prefix := normalizePrefix(cleanRelativeKey(request.Prefix))
	if prefix == "" {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_prefix", Message: "refusing to delete the whole bucket; prefix is required"})
		return
	}
	job, err := a.jobs.create(persistentJob{Type: jobTypeDeletePrefix, Instance: instance.cfg.ID, Prefix: prefix})
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
		if err := instance.backend.Copy(ctx, instance.fullKey(source), instance.fullKey(target)); err != nil {
			return 0, err
		}
		if move {
			if err := instance.backend.Delete(ctx, instance.fullKey(source)); err != nil {
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
		if err := instance.backend.Copy(ctx, instance.fullKey(key), instance.fullKey(destination)); err != nil {
			return copied, fmt.Errorf("copy %q to %q after %d object(s): %w", key, destination, copied, err)
		}
		copied++
	}
	if move {
		deleted := 0
		for _, key := range keys {
			if err := instance.backend.Delete(ctx, instance.fullKey(key)); err != nil {
				return copied, fmt.Errorf("all copies succeeded but deletion of %q failed after %d object(s): %w", key, deleted, err)
			}
			deleted++
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
		page, err := instance.backend.List(ctx, listOptions{
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

func (a *application) handleObjectGateway(w http.ResponseWriter, r *http.Request) {
	instance, err := a.instanceFromRequest(r, "")
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
	fullKey := instance.fullKey(key)
	preview := r.URL.Query().Get("preview") == "1"
	switch r.Method {
	case http.MethodGet:
		if err := requirePermission(instance, permissionRead); err != nil {
			writeGatewayError(w, err)
			return
		}
		response, err := instance.backend.Get(r.Context(), fullKey, r.Header)
		if err != nil {
			writeGatewayError(w, err)
			return
		}
		defer response.Body.Close()
		if preview && r.Header.Get("Range") != "" && response.StatusCode != http.StatusPartialContent {
			writeGatewayError(w, apiError{
				Status:  http.StatusBadGateway,
				Code:    "preview_range_unsupported",
				Message: "the storage provider did not honor the byte-range request required for this preview",
			})
			return
		}
		copyObjectHeaders(w.Header(), response.Header)
		if preview {
			applyPreviewObjectHeaders(w.Header(), key)
		}
		applyObjectSafetyHeaders(w.Header())
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	case http.MethodHead:
		if err := requirePermission(instance, permissionRead); err != nil {
			writeGatewayError(w, err)
			return
		}
		response, err := instance.backend.Head(r.Context(), fullKey)
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
		if err := instance.backend.Put(r.Context(), fullKey, r.Body, r.ContentLength, r.Header.Get("Content-Type")); err != nil {
			writeGatewayError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if err := requirePermission(instance, permissionDelete); err != nil {
			writeGatewayError(w, err)
			return
		}
		if err := instance.backend.Delete(r.Context(), fullKey); err != nil {
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

func (a *application) handleRawList(w http.ResponseWriter, r *http.Request, instance *storageInstance) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		writeGatewayError(w, err)
		return
	}
	query := r.URL.Query()
	maxResults := parseBoundedInt(query.Get("max-keys"), 1000, 1, 1000)
	startAfter := cleanRelativeKey(query.Get("start-after"))
	if startAfter != "" {
		startAfter = instance.fullKey(startAfter)
	}
	page, err := instance.backend.List(r.Context(), listOptions{
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

func (a *application) instanceFromRequest(r *http.Request, bodyInstance string) (*storageInstance, error) {
	id := strings.TrimSpace(bodyInstance)
	if id == "" {
		id = strings.TrimSpace(r.URL.Query().Get("instance"))
	}
	if id == "" && len(a.order) > 0 {
		id = a.order[0]
	}
	instance, ok := a.instances[id]
	if !ok {
		return nil, apiError{Status: http.StatusNotFound, Code: "unknown_instance", Message: fmt.Sprintf("storage instance %q does not exist", id)}
	}
	return instance, nil
}

func requirePermission(instance *storageInstance, permission string) error {
	if instance.allowed(permission) {
		return nil
	}
	return apiError{
		Status:  http.StatusForbidden,
		Code:    "permission_denied",
		Message: fmt.Sprintf("instance %q does not expose %s permission", instance.cfg.ID, permission),
	}
}

func keyFromGatewayPath(r *http.Request) (string, error) {
	// The query form is preferred by the frontend because browser URL parsers
	// normalize path segments such as "." and ".." before issuing a request.
	// A query value preserves the exact object key, including repeated slashes
	// and dot segments. The path form remains available for compatibility.
	if r.URL.Path == "/s3" || r.URL.Path == "/s3/" {
		if values, present := r.URL.Query()["key"]; present {
			if len(values) != 1 {
				return "", apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "exactly one key query parameter is required"}
			}
			key := cleanRelativeKey(values[0])
			if key == "" {
				return "", apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "object key cannot be empty"}
			}
			return key, nil
		}
		return "", nil
	}

	escaped := r.URL.EscapedPath()
	if !strings.HasPrefix(escaped, "/s3/") {
		return "", apiError{Status: http.StatusBadRequest, Code: "invalid_path", Message: "invalid object path"}
	}
	key, err := url.PathUnescape(strings.TrimPrefix(escaped, "/s3/"))
	if err != nil {
		return "", apiError{Status: http.StatusBadRequest, Code: "invalid_path", Message: "object path is not valid URL encoding"}
	}
	key = cleanRelativeKey(key)
	if key == "" {
		return "", nil
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
		".mp4":  "video/mp4",
		".m4v":  "video/x-m4v",
		".mov":  "video/quicktime",
		".webm": "video/webm",
		".mkv":  "video/x-matroska",
		".mxf":  "application/mxf",
		".avi":  "video/x-msvideo",
		".ogv":  "video/ogg",
		".mpg":  "video/mpeg",
		".mpeg": "video/mpeg",
		".m2ts": "video/mp2t",
		".mts":  "video/mp2t",
		".ts":   "video/mp2t",
		".vob":  "video/dvd",
		".mp3":  "audio/mpeg",
		".m4a":  "audio/mp4",
		".aac":  "audio/aac",
		".flac": "audio/flac",
		".wav":  "audio/wav",
		".ogg":  "audio/ogg",
		".opus": "audio/ogg; codecs=opus",
		".aif":  "audio/aiff",
		".aiff": "audio/aiff",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".webp": "image/webp",
		".avif": "image/avif",
		".svg":  "image/svg+xml",
		".bmp":  "image/bmp",
		".tif":  "image/tiff",
		".tiff": "image/tiff",
		".pdf":  "application/pdf",
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
	status := statusFromError(err)
	code := "storage_error"
	message := publicStorageError(err)
	var apiErr apiError
	if errors.As(err, &apiErr) {
		status = apiErr.Status
		code = apiErr.Code
		message = apiErr.Message
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
	status := statusFromError(err)
	message := publicStorageError(err)
	var apiErr apiError
	if errors.As(err, &apiErr) {
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
	case "ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key":
		return "presentation"
	case "sqlite", "sqlite3", "db", "db3", "s3db", "sl3":
		return "database"
	case "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz", "xz", "txz", "zst":
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

func secureStaticHandler(root fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			methodNotAllowed(w, http.MethodGet, http.MethodHead)
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
		serveEmbeddedFile(w, r, root, requested)
	})
}

func serveEmbeddedFile(w http.ResponseWriter, r *http.Request, root fs.FS, requested string) {
	name := strings.TrimPrefix(requested, "/")
	file, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if contentType := mime.TypeByExtension(path.Ext(requested)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	if strings.HasPrefix(requested, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if seeker, ok := file.(io.ReadSeeker); ok {
		http.ServeContent(w, r, info.Name(), time.Time{}, seeker)
		return
	}
	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "read embedded file", http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, info.Name(), time.Time{}, bytes.NewReader(data))
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

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

func requestLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		loggedPath := r.URL.Path
		if strings.HasPrefix(loggedPath, "/s3/") {
			loggedPath = "/s3/<object>"
		}
		log.Printf("%s %s %d %dB %s", r.Method, loggedPath, status, recorder.bytes, time.Since(start).Round(time.Millisecond))
	})
}
