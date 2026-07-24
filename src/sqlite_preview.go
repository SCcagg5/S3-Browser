package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	maxSQLitePreviewBytes = int64(4 << 30)
	sqliteSessionTTL      = 20 * time.Minute
)

type sqliteColumnInfo struct {
	Name         string `json:"name"`
	DeclaredType string `json:"declaredType,omitempty"`
	PrimaryKey   bool   `json:"primaryKey,omitempty"`
}

type sqliteTableInfo struct {
	Name    string             `json:"name"`
	Type    string             `json:"type"`
	Columns []sqliteColumnInfo `json:"columns"`
}

type sqliteSession struct {
	ID          string
	Instance    string
	Key         string
	Path        string
	Size        int64
	Tables      []sqliteTableInfo
	Definitions map[string]sqliteTableDefinition
	CreatedAt   time.Time
	LastAccess  time.Time
}

type sqliteSessionManager struct {
	app      *application
	mu       sync.Mutex
	sessions map[string]*sqliteSession
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

type sqliteSessionRequest struct {
	Instance string `json:"instance"`
	Key      string `json:"key"`
	Size     int64  `json:"size,omitempty"`
}

type sqliteSessionResponse struct {
	ID       string            `json:"id"`
	Instance string            `json:"instance"`
	Key      string            `json:"key"`
	Size     int64             `json:"size"`
	Tables   []sqliteTableInfo `json:"tables"`
}

type sqlitePageResponse struct {
	ID              string             `json:"id"`
	Table           sqliteTableInfo    `json:"table"`
	Rows            []map[string]any   `json:"rows"`
	Page            int                `json:"page"`
	PageSize        int                `json:"pageSize"`
	HasMore         bool               `json:"hasMore"`
	TotalRows       int64              `json:"totalRows"`
	SourceTotalRows int64              `json:"sourceTotalRows"`
	Query           string             `json:"query,omitempty"`
	Columns         []sqliteColumnInfo `json:"columns"`
}

func newSQLiteSessionManager(app *application) *sqliteSessionManager {
	ctx, cancel := context.WithCancel(context.Background())
	manager := &sqliteSessionManager{
		app:      app,
		sessions: make(map[string]*sqliteSession),
		ctx:      ctx,
		cancel:   cancel,
	}
	manager.wg.Add(1)
	go manager.cleanupLoop()
	return manager
}

func (m *sqliteSessionManager) close() {
	if m == nil {
		return
	}
	m.cancel()
	m.wg.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, session := range m.sessions {
		_ = os.Remove(session.Path)
		delete(m.sessions, id)
	}
}

func (m *sqliteSessionManager) cleanupLoop() {
	defer m.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case now := <-ticker.C:
			m.cleanupExpired(now)
		}
	}
}

func (m *sqliteSessionManager) cleanupExpired(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, session := range m.sessions {
		if now.Sub(session.LastAccess) < sqliteSessionTTL {
			continue
		}
		_ = os.Remove(session.Path)
		delete(m.sessions, id)
	}
}

func (m *sqliteSessionManager) public(session *sqliteSession) sqliteSessionResponse {
	return sqliteSessionResponse{
		ID:       session.ID,
		Instance: session.Instance,
		Key:      session.Key,
		Size:     session.Size,
		Tables:   append([]sqliteTableInfo(nil), session.Tables...),
	}
}

func cloneSQLiteDefinitions(source map[string]sqliteTableDefinition) map[string]sqliteTableDefinition {
	if len(source) == 0 {
		return nil
	}
	cloned := make(map[string]sqliteTableDefinition, len(source))
	for name, definition := range source {
		copyDefinition := definition
		copyDefinition.Info.Columns = append([]sqliteColumnInfo(nil), definition.Info.Columns...)
		copyDefinition.Columns = append([]sqliteColumnDefinition(nil), definition.Columns...)
		copyDefinition.StorageOrder = append([]int(nil), definition.StorageOrder...)
		cloned[name] = copyDefinition
	}
	return cloned
}

func (m *sqliteSessionManager) get(id string) (*sqliteSession, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[id]
	if !ok {
		return nil, false
	}
	session.LastAccess = time.Now().UTC()
	copySession := *session
	copySession.Tables = append([]sqliteTableInfo(nil), session.Tables...)
	copySession.Definitions = cloneSQLiteDefinitions(session.Definitions)
	return &copySession, true
}

func (m *sqliteSessionManager) remove(id string) bool {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if ok {
		_ = os.Remove(session.Path)
	}
	return ok
}

func (m *sqliteSessionManager) create(ctx context.Context, request sqliteSessionRequest) (*sqliteSession, error) {
	if m == nil || m.app == nil {
		return nil, apiError{Status: http.StatusServiceUnavailable, Code: "sqlite_unavailable", Message: "SQLite preview is unavailable"}
	}
	instance := m.app.instances[strings.TrimSpace(request.Instance)]
	if instance == nil {
		return nil, apiError{Status: http.StatusBadRequest, Code: "unknown_instance", Message: "unknown storage instance"}
	}
	if err := requirePermission(instance, permissionRead); err != nil {
		return nil, err
	}
	key := cleanRelativeKey(request.Key)
	if key == "" {
		return nil, apiError{Status: http.StatusBadRequest, Code: "invalid_key", Message: "SQLite key cannot be empty"}
	}
	if request.Size > maxSQLitePreviewBytes {
		return nil, apiError{Status: http.StatusRequestEntityTooLarge, Code: "sqlite_too_large", Message: fmt.Sprintf("SQLite previews are limited to %d GiB", maxSQLitePreviewBytes>>30)}
	}

	temporary, err := os.CreateTemp("", "object-browser-sqlite-*.db")
	if err != nil {
		return nil, fmt.Errorf("create SQLite preview file: %w", err)
	}
	path := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(path)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return nil, fmt.Errorf("protect SQLite preview file: %w", err)
	}
	response, err := instance.backend.Get(ctx, instance.fullKey(key), nil)
	if err != nil {
		cleanup()
		return nil, err
	}
	if response.Body == nil {
		cleanup()
		return nil, apiError{Status: http.StatusBadGateway, Code: "empty_sqlite_object", Message: "the storage provider returned an empty SQLite object"}
	}
	defer response.Body.Close()
	if !isSuccessfulObjectReadStatus(response.StatusCode) {
		cleanup()
		return nil, fmt.Errorf("read SQLite object: HTTP %d", response.StatusCode)
	}
	limit := &io.LimitedReader{R: response.Body, N: maxSQLitePreviewBytes + 1}
	written, err := io.CopyBuffer(temporary, limit, make([]byte, 256<<10))
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("copy SQLite object: %w", err)
	}
	if written > maxSQLitePreviewBytes {
		cleanup()
		return nil, apiError{Status: http.StatusRequestEntityTooLarge, Code: "sqlite_too_large", Message: fmt.Sprintf("SQLite previews are limited to %d GiB", maxSQLitePreviewBytes>>30)}
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return nil, fmt.Errorf("flush SQLite preview file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(path)
		return nil, err
	}

	tables, definitions, err := inspectSQLiteTables(ctx, path)
	if err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	id, err := randomSQLiteID()
	if err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	now := time.Now().UTC()
	session := &sqliteSession{
		ID:          id,
		Instance:    instance.cfg.ID,
		Key:         key,
		Path:        path,
		Size:        written,
		Tables:      tables,
		Definitions: definitions,
		CreatedAt:   now,
		LastAccess:  now,
	}
	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()
	return session, nil
}

func randomSQLiteID() (string, error) {
	buffer := make([]byte, 18)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func (m *sqliteSessionManager) tablePage(ctx context.Context, session *sqliteSession, tableName string, page, pageSize int, search string) (sqlitePageResponse, error) {
	definition, ok := session.Definitions[tableName]
	if !ok {
		return sqlitePageResponse{}, apiError{Status: http.StatusBadRequest, Code: "unknown_sqlite_table", Message: "the selected table does not exist in this preview session"}
	}
	result, err := querySQLiteTable(ctx, session.Path, definition, page, pageSize, search)
	if err != nil {
		return sqlitePageResponse{}, err
	}
	result.ID = session.ID
	return result, nil
}

func (a *application) handleSQLiteSessions(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/sqlite/sessions" {
		a.handleSQLiteSessionResource(w, r)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var request sqliteSessionRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request); err != nil {
		writeAPIError(w, apiError{Status: http.StatusBadRequest, Code: "invalid_json", Message: "invalid SQLite preview request"})
		return
	}
	session, err := a.sqlite.create(r.Context(), request)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, a.sqlite.public(session))
}

func (a *application) handleSQLiteSessionResource(w http.ResponseWriter, r *http.Request) {
	pathValue := strings.TrimPrefix(r.URL.Path, "/api/sqlite/sessions/")
	parts := strings.Split(strings.Trim(pathValue, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "sqlite_session_not_found", Message: "SQLite preview session was not found"})
		return
	}
	id := parts[0]
	if r.Method == http.MethodDelete && len(parts) == 1 {
		if !a.sqlite.remove(id) {
			writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "sqlite_session_not_found", Message: "SQLite preview session was not found"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	session, ok := a.sqlite.get(id)
	if !ok {
		writeAPIError(w, apiError{Status: http.StatusNotFound, Code: "sqlite_session_not_found", Message: "SQLite preview session was not found or expired"})
		return
	}
	if r.Method == http.MethodGet && len(parts) == 1 {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, a.sqlite.public(session))
		return
	}
	if r.Method == http.MethodGet && len(parts) == 2 && parts[1] == "table" {
		page := parseBoundedInt(r.URL.Query().Get("page"), 0, 0, 1<<30)
		pageSize := parseBoundedInt(r.URL.Query().Get("pageSize"), 100, 1, 1000)
		result, err := a.sqlite.tablePage(r.Context(), session, r.URL.Query().Get("table"), page, pageSize, r.URL.Query().Get("q"))
		if err != nil {
			writeAPIError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, result)
		return
	}
	methodNotAllowed(w, http.MethodGet, http.MethodDelete)
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
