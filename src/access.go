package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// The access of humans (docs/ACCESS.md, contract section 11).
//
// The resource tree:
//
//	service (access.identity.audience)
//	└── bucket (the label of a bucket block)
//	    └── prefix (the first part of an object key, before the first "/")
//
// Each operation asks the PDP with the match "node" on its exact resource. The
// list of buckets and the navigation ask with the match "subtree".

const (
	actionObjectsRead   = "objects.read"
	actionObjectsWrite  = "objects.write"
	actionObjectsDelete = "objects.delete"

	resourceService = "service"
	resourceBucket  = "bucket"
	resourcePrefix  = "prefix"

	accessActionsPath = "/.well-known/access-actions"
)

type accessResourceType struct {
	Name        string `json:"name"`
	Parent      string `json:"parent"`
	Description string `json:"description"`
}

type accessActionInfo struct {
	Name          string   `json:"name"`
	ResourceTypes []string `json:"resource_types"`
	Description   string   `json:"description"`
	permission    string
}

var accessResourceTypes = []accessResourceType{
	{Name: resourceBucket, Parent: resourceService, Description: "One bucket block or one volume block of the configuration. The id is the label of the block, for example \"docker-registry\"."},
	{Name: resourcePrefix, Parent: resourceBucket, Description: "One top-level folder of a bucket or of a volume. The id is the part of the object key before the first \"/\", below root_prefix."},
}

var accessActions = []accessActionInfo{
	{
		Name: actionObjectsRead, ResourceTypes: []string{resourceService, resourceBucket, resourcePrefix}, permission: permissionRead,
		Description: "List, preview, inspect and download objects. See the versions, the Insights and the archive entries. Check the integrity of an object.",
	},
	{
		Name: actionObjectsWrite, ResourceTypes: []string{resourceService, resourceBucket, resourcePrefix}, permission: permissionWrite,
		Description: "Upload objects, make folders and restore a version. Be the destination of a copy, a move or an archive extraction.",
	},
	{
		Name: actionObjectsDelete, ResourceTypes: []string{resourceService, resourceBucket, resourcePrefix}, permission: permissionDelete,
		Description: "Delete objects, versions and folders. Be the source of a move or a rename.",
	},
}

// actionOf gives the action of the access policy for a permission of the bucket.
func actionOf(permission string) string {
	for _, action := range accessActions {
		if action.permission == permission {
			return action.Name
		}
	}
	return "unknown"
}

// accessActionsDocument gives the document of GET /.well-known/access-actions.
func (a *application) accessActionsDocument() map[string]any {
	return map[string]any{
		"server":         a.config.Access.serverName(),
		"resource_types": accessResourceTypes,
		"actions":        accessActions,
	}
}

func (a *application) handleAccessActions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	writeJSON(w, http.StatusOK, a.accessActionsDocument())
}

// accessRequest is the identity of the human of one request.
type accessRequest struct {
	Subject   string
	RequestID string
}

type accessRequestKey struct{}

func accessFromContext(ctx context.Context) *accessRequest {
	value, _ := ctx.Value(accessRequestKey{}).(*accessRequest)
	return value
}

// requestLogInfo lets the inner middleware give the subject to the request log.
type requestLogInfo struct {
	Subject   string
	RequestID string
}

type requestLogKey struct{}

func requestLogInfoFromContext(ctx context.Context) *requestLogInfo {
	value, _ := ctx.Value(requestLogKey{}).(*requestLogInfo)
	return value
}

// accessExempt tells the routes that need no identity token.
func accessExempt(r *http.Request) bool {
	return r.URL.Path == "/healthz" || r.URL.Path == accessActionsPath
}

// accessMiddleware verifies the identity token of each request (contract 11.3).
// The token comes only from the configured header, never from a cookie or a
// query parameter. Two copies of the header are refused.
func (a *application) accessMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.config.Access.enforced() || accessExempt(r) {
			next.ServeHTTP(w, r)
			return
		}
		requestID := requestIDFrom(r)
		values := r.Header.Values(a.config.Access.Header)
		result := identityResult{Reason: "missing"}
		switch {
		case a.identity == nil:
			result = identityResult{Reason: "missing"}
		case len(values) == 1:
			result = a.identity.verify(values[0], time.Now().Unix())
		case len(values) > 1:
			result = identityResult{Reason: "malformed"}
		}
		if !result.ok() {
			log.Printf("access.unauthenticated request_id=%s method=%s path=%q reason=%s",
				requestID, r.Method, loggedRequestPath(a.config.Runtime.LogMode, r.URL.Path), result.Reason)
			if !isSafeHTTPMethod(r.Method) {
				w.Header().Set("Connection", "close")
			}
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]any{
				"code": "unauthenticated", "message": "A valid identity token is required.",
			}})
			return
		}
		if info := requestLogInfoFromContext(r.Context()); info != nil {
			info.Subject = result.Subject
			info.RequestID = requestID
		}
		ctx := context.WithValue(r.Context(), accessRequestKey{}, &accessRequest{Subject: result.Subject, RequestID: requestID})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requestIDFrom keeps a valid X-Request-ID of the client (1 to 128 characters
// of A-Z, a-z, 0-9, '.', '_', ':' and '-'). Else it makes a new random id.
func requestIDFrom(r *http.Request) string {
	value := r.Header.Get("X-Request-ID")
	valid := value != "" && len(value) <= 128
	for i := 0; valid && i < len(value); i++ {
		c := value[i]
		valid = c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-'
	}
	if valid {
		return value
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(random[:])
}

// forbidden gives the 403 answer of an action. The answer never gives the
// reason of the PDP.
func forbidden(action string) apiError {
	return apiError{Status: http.StatusForbidden, Code: "forbidden", Message: "The action " + action + " is not allowed.", Action: action}
}

func (a *application) serviceResource() accessResource {
	return accessResource{Type: resourceService, ID: a.config.Access.serverName()}
}

func (a *application) bucketResource(instance *storageInstance) accessResource {
	return accessResource{
		Type:      resourceBucket,
		ID:        instance.cfg.ID,
		Ancestors: []accessNode{{Type: resourceService, ID: a.config.Access.serverName()}},
	}
}

// topLevelSegment gives the part of a key before its first "/". A key without
// "/" is at the root of the bucket. A part that no grant can name (more than
// 256 bytes, not UTF-8, or with a control character) has no prefix resource.
func topLevelSegment(key string) (string, bool) {
	index := strings.IndexByte(key, '/')
	if index <= 0 {
		return "", false
	}
	segment := key[:index]
	if !validAccessID(segment) {
		return "", false
	}
	return segment, true
}

// nodeResource gives the most specific resource of a key or a list prefix: the
// prefix resource of its top-level folder, else the bucket. Only a grant on the
// bucket or on the service covers a key at the root of the bucket, or a key
// whose top-level folder no grant can name.
func (a *application) nodeResource(instance *storageInstance, key string) accessResource {
	segment, ok := topLevelSegment(key)
	if !ok {
		return a.bucketResource(instance)
	}
	return accessResource{
		Type: resourcePrefix,
		ID:   segment,
		Ancestors: []accessNode{
			{Type: resourceService, ID: a.config.Access.serverName()},
			{Type: resourceBucket, ID: instance.cfg.ID},
		},
	}
}

// decide asks the PDP. In the open mode, each decision is true. In the authzen
// mode, a request without a verified subject gets false for each question.
func (a *application) decide(r *http.Request, questions []accessQuestion) []accessDecision {
	out := make([]accessDecision, len(questions))
	if !a.config.Access.enforced() {
		for index := range out {
			out[index] = accessDecision{Allowed: true, Source: "open"}
		}
		return out
	}
	identity := accessFromContext(r.Context())
	if a.pdp == nil || identity == nil || identity.Subject == "" {
		for index := range out {
			out[index] = accessDecision{Allowed: false, Source: "error"}
		}
		return out
	}
	return a.pdp.decide(r.Context(), identity.RequestID, identity.Subject, questions)
}

// accessRequirement is one action on the node of one key of one bucket.
type accessRequirement struct {
	Permission string
	Instance   *storageInstance
	Key        string
}

// checkAccess asks the match "node" for each requirement, in one batch. It
// gives the first action that the PDP refuses.
func (a *application) checkAccess(r *http.Request, requirements ...accessRequirement) (string, bool) {
	if !a.config.Access.enforced() {
		return "", true
	}
	questions := make([]accessQuestion, 0, len(requirements))
	for _, requirement := range requirements {
		if requirement.Instance == nil {
			return actionOf(requirement.Permission), false
		}
		questions = append(questions, accessQuestion{
			Action:   actionOf(requirement.Permission),
			Resource: a.nodeResource(requirement.Instance, requirement.Key),
		})
	}
	for index, decision := range a.decide(r, questions) {
		if !decision.Allowed {
			return questions[index].Action, false
		}
	}
	return "", true
}

// requireAccess asks the action of a permission on the node of each key. It
// gives the 403 error of the action when one decision is false.
func (a *application) requireAccess(r *http.Request, instance *storageInstance, permission string, keys ...string) error {
	if !a.config.Access.enforced() {
		return nil
	}
	if len(keys) == 0 {
		keys = []string{""}
	}
	requirements := make([]accessRequirement, 0, len(keys))
	for _, key := range keys {
		requirements = append(requirements, accessRequirement{Permission: permission, Instance: instance, Key: key})
	}
	if action, ok := a.checkAccess(r, requirements...); !ok {
		return forbidden(action)
	}
	return nil
}

// bucketVisibility asks, in one batch, each action on each bucket with the
// match "subtree". A bucket is visible when one of its decisions is true: a
// grant on the service, on the bucket or on a prefix of the bucket. The result
// maps the id of each bucket to the decision of each permission.
func (a *application) bucketVisibility(r *http.Request, instances []*storageInstance) map[string]map[string]bool {
	out := make(map[string]map[string]bool, len(instances))
	questions := make([]accessQuestion, 0, len(instances)*len(accessActions))
	for _, instance := range instances {
		out[instance.cfg.ID] = make(map[string]bool, len(accessActions))
		for _, action := range accessActions {
			questions = append(questions, accessQuestion{Action: action.Name, Resource: a.bucketResource(instance), Subtree: true})
		}
	}
	decisions := a.decide(r, questions)
	index := 0
	for _, instance := range instances {
		for _, action := range accessActions {
			out[instance.cfg.ID][action.permission] = decisions[index].Allowed
			index++
		}
	}
	return out
}

func anyAllowed(decisions map[string]bool) bool {
	for _, allowed := range decisions {
		if allowed {
			return true
		}
	}
	return false
}

// bucketVisible tells if the human holds one action on the bucket or below it.
func (a *application) bucketVisible(r *http.Request, instance *storageInstance) bool {
	if !a.config.Access.enforced() {
		return true
	}
	return anyAllowed(a.bucketVisibility(r, []*storageInstance{instance})[instance.cfg.ID])
}

// resolveInstance finds the bucket of a request. In the authzen mode, a hidden
// bucket and an unknown bucket get the same 403 answer with the action of the
// permission. An unknown bucket asks the action on the service: thus a human
// with a grant on the service still gets 404 for an unknown bucket.
func (a *application) resolveInstance(r *http.Request, id, permission string) (*storageInstance, error) {
	instance, ok := a.instances[id]
	if !a.config.Access.enforced() {
		if !ok {
			return nil, apiError{Status: http.StatusNotFound, Code: "unknown_instance", Message: fmt.Sprintf("storage instance %q does not exist", id)}
		}
		return instance, nil
	}
	action := actionOf(permission)
	if !ok {
		decisions := a.decide(r, []accessQuestion{{Action: action, Resource: a.serviceResource()}})
		if !decisions[0].Allowed {
			return nil, forbidden(action)
		}
		return nil, apiError{Status: http.StatusNotFound, Code: "unknown_instance", Message: fmt.Sprintf("storage instance %q does not exist", id)}
	}
	if !a.bucketVisible(r, instance) {
		return nil, forbidden(action)
	}
	return instance, nil
}

// visibleInstances gives the buckets that the human can see, in the order of
// the configuration, and the decisions of each one (match "subtree").
func (a *application) visibleInstances(r *http.Request) ([]*storageInstance, map[string]map[string]bool) {
	all := make([]*storageInstance, 0, len(a.order))
	for _, id := range a.order {
		all = append(all, a.instances[id])
	}
	if !a.config.Access.enforced() {
		return all, nil
	}
	decisions := a.bucketVisibility(r, all)
	visible := make([]*storageInstance, 0, len(all))
	for _, instance := range all {
		if anyAllowed(decisions[instance.cfg.ID]) {
			visible = append(visible, instance)
		}
	}
	return visible, decisions
}

// withAccessCapabilities marks as denied each permission that the human holds
// nowhere in the bucket. The user interface then hides these actions.
func withAccessCapabilities(info instanceInfo, decisions map[string]bool) instanceInfo {
	if decisions == nil {
		return info
	}
	for _, permission := range []string{permissionRead, permissionWrite, permissionDelete} {
		if !decisions[permission] {
			info.Capabilities.set(permission, deniedCapability("access", "the access policy does not give "+actionOf(permission)+" in this bucket", true))
		}
	}
	read, write, remove := info.Capabilities.Read, info.Capabilities.Write, info.Capabilities.Delete
	info.Operations = map[string]capabilityState{
		"list": read, "preview": read, "download": read,
		"upload": write, "overwrite": write, "createFolder": write,
		"copy":   combineCapabilityStates(read, write),
		"move":   combineCapabilityStates(read, write, remove),
		"rename": combineCapabilityStates(read, write, remove),
		"delete": remove,
	}
	return info
}

// listAccessJSON gives the decisions of the node of a listing (match "node").
// The user interface uses them to hide the upload and the delete controls.
type listAccessJSON struct {
	Read   bool `json:"read"`
	Write  bool `json:"write"`
	Delete bool `json:"delete"`
}

func (a *application) nodeAccess(r *http.Request, instance *storageInstance, key string) *listAccessJSON {
	if !a.config.Access.enforced() {
		return nil
	}
	resource := a.nodeResource(instance, key)
	questions := make([]accessQuestion, 0, len(accessActions))
	for _, action := range accessActions {
		questions = append(questions, accessQuestion{Action: action.Name, Resource: resource})
	}
	decisions := a.decide(r, questions)
	return &listAccessJSON{Read: decisions[0].Allowed, Write: decisions[1].Allowed, Delete: decisions[2].Allowed}
}

// navigationFilter keeps the items of a listing whose top-level folder the
// human can read or reach (objects.read, match "subtree"). The server uses it
// when the human cannot read the bucket itself. An item at the root of the
// bucket needs a grant on the bucket, so the filter removes it.
func (a *application) navigationFilter(r *http.Request, instance *storageInstance, items []listItemJSON) []listItemJSON {
	nodes := make(map[string]int)
	questions := make([]accessQuestion, 0)
	itemNode := make([]int, len(items))
	for index, item := range items {
		key := item.Key
		if item.Type == "prefix" {
			key = item.Prefix
		}
		resource := a.nodeResource(instance, key)
		if resource.Type != resourcePrefix {
			itemNode[index] = -1
			continue
		}
		position, found := nodes[resource.ID]
		if !found {
			position = len(questions)
			nodes[resource.ID] = position
			questions = append(questions, accessQuestion{Action: actionObjectsRead, Resource: resource, Subtree: true})
		}
		itemNode[index] = position
	}
	decisions := a.decide(r, questions)
	kept := items[:0]
	for index, item := range items {
		if itemNode[index] >= 0 && decisions[itemNode[index]].Allowed {
			kept = append(kept, item)
		}
	}
	return kept
}

// jobRequirements gives the decisions that a job needs. The server asks them
// again for each read and each control of the job. A job type without
// requirements is refused (fail closed).
func (a *application) jobRequirements(job jobState) ([]accessRequirement, bool) {
	source := a.instances[job.Instance]
	switch job.Type {
	case jobTypeCopyPrefix, jobTypeCopyObject:
		return []accessRequirement{{permissionRead, source, job.Source}, {permissionWrite, source, job.Target}}, true
	case jobTypeMovePrefix, jobTypeMoveObject:
		return []accessRequirement{{permissionRead, source, job.Source}, {permissionDelete, source, job.Source}, {permissionWrite, source, job.Target}}, true
	case jobTypeDeletePrefix:
		return []accessRequirement{{permissionRead, source, job.Prefix}, {permissionDelete, source, job.Prefix}}, true
	case jobTypeTagPrefix, jobTypeAbortMultiparts:
		return []accessRequirement{{permissionRead, source, job.Prefix}, {permissionWrite, source, job.Prefix}}, true
	case jobTypeStatsPrefix:
		return []accessRequirement{{permissionRead, source, job.Prefix}}, true
	case jobTypeIntegrity:
		if job.IntegrityRequest == nil {
			return nil, false
		}
		return []accessRequirement{{permissionRead, source, job.IntegrityRequest.Key}}, true
	case jobTypeArchiveEntryIntegrity:
		if job.ArchiveEntryIntegrityRequest == nil {
			return nil, false
		}
		return []accessRequirement{{permissionRead, source, job.ArchiveEntryIntegrityRequest.Key}}, true
	case jobTypeExtractArchive:
		target := a.instances[job.TargetInstance]
		return []accessRequirement{{permissionRead, source, job.Source}, {permissionWrite, target, job.Target}, {permissionRead, target, job.Target}}, true
	default:
		return nil, false
	}
}

// jobAllowed tells if the human holds each decision of the job (match "node").
func (a *application) jobAllowed(r *http.Request, job jobState) bool {
	if !a.config.Access.enforced() {
		return true
	}
	requirements, ok := a.jobRequirements(job)
	if !ok {
		return false
	}
	_, allowed := a.checkAccess(r, requirements...)
	return allowed
}

// readableInstance finds the bucket of a read request and asks objects.read on
// the node of its key (match "node").
func (a *application) readableInstance(r *http.Request, key string) (*storageInstance, error) {
	instance, err := a.instanceFromRequest(r, "", permissionRead)
	if err != nil {
		return nil, err
	}
	if err := a.requireAccess(r, instance, permissionRead, key); err != nil {
		return nil, err
	}
	return instance, nil
}
