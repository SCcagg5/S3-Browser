package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	maxSQLitePreviewBytes     = int64(16 << 40)
	maxInMemorySQLiteSessions = 4
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
	Size        int64
	Source      *objectRangeSource
	Warning     string
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
	Warning  string            `json:"warning,omitempty"`
}

type sqlitePageResponse struct {
	ID               string             `json:"id"`
	Table            sqliteTableInfo    `json:"table"`
	Rows             []map[string]any   `json:"rows"`
	Page             int                `json:"page"`
	PageSize         int                `json:"pageSize"`
	HasMore          bool               `json:"hasMore"`
	TotalRows        int64              `json:"totalRows"`
	SourceTotalRows  int64              `json:"sourceTotalRows"`
	Query            string             `json:"query,omitempty"`
	Columns          []sqliteColumnInfo `json:"columns"`
	TotalKnown       bool               `json:"totalKnown"`
	SourceTotalKnown bool               `json:"sourceTotalKnown"`
	ScannedRows      int64              `json:"scannedRows"`
}
type sqliteTableQuery struct {
	Filters       map[string]string
	SortColumn    string
	SortDirection string
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
		if session.Source != nil {
			session.Source.clearCache()
		}
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
		if now.Sub(session.LastAccess) < m.app.config.Runtime.sessionTTL() {
			continue
		}
		if session.Source != nil {
			session.Source.clearCache()
		}
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
		Warning:  session.Warning,
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
	copySession.Source = session.Source
	return &copySession, true
}

func (m *sqliteSessionManager) hasSessionCapacity() bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions) < maxInMemorySQLiteSessions
}

func sqliteSessionCapacityError() error {
	return apiError{
		Status:  http.StatusTooManyRequests,
		Code:    "sqlite_session_limit_reached",
		Message: fmt.Sprintf("the server is already tracking %d active SQLite preview sessions", maxInMemorySQLiteSessions),
	}
}

func (m *sqliteSessionManager) register(session *sqliteSession) error {
	if m == nil || session == nil || strings.TrimSpace(session.ID) == "" {
		return fmt.Errorf("SQLite preview session is invalid")
	}
	m.mu.Lock()
	if _, exists := m.sessions[session.ID]; !exists && len(m.sessions) >= maxInMemorySQLiteSessions {
		m.mu.Unlock()
		return sqliteSessionCapacityError()
	}
	m.sessions[session.ID] = session
	m.mu.Unlock()
	return nil
}

func (m *sqliteSessionManager) remove(id string) bool {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if ok && session.Source != nil {
		session.Source.clearCache()
	}
	return ok
}

func (m *sqliteSessionManager) create(ctx context.Context, request sqliteSessionRequest) (*sqliteSession, error) {
	if m == nil || m.app == nil {
		return nil, apiError{Status: http.StatusServiceUnavailable, Code: "sqlite_unavailable", Message: "SQLite preview is unavailable"}
	}
	if !m.hasSessionCapacity() {
		return nil, sqliteSessionCapacityError()
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

	source, err := openObjectRangeSource(ctx, instance, key)
	if err != nil {
		return nil, err
	}
	if request.Size > 0 {
		source.SetKnownSize(request.Size)
	}
	header, err := source.ReadPrefix(100)
	if err != nil && err != io.EOF {
		return nil, err
	}
	size := source.Size()
	if size < 100 {
		return nil, apiError{Status: 422, Code: "invalid_sqlite", Message: "the object is too small to be a SQLite 3 database"}
	}
	if size > maxSQLitePreviewBytes {
		return nil, apiError{Status: http.StatusRequestEntityTooLarge, Code: "sqlite_too_large", Message: "the SQLite object exceeds the remote preview safety limit"}
	}
	warning := ""
	if len(header) >= 20 && (header[18] == 2 || header[19] == 2) {
		warning = "This database uses WAL journaling. The preview reads the main database object only and may not include uncheckpointed WAL changes."
	}
	tables, definitions, err := inspectSQLiteTablesReader(ctx, source, size)
	if err != nil {
		return nil, err
	}
	id, err := randomSQLiteID()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	session := &sqliteSession{
		ID:          id,
		Instance:    instance.cfg.ID,
		Key:         key,
		Size:        size,
		Source:      source,
		Warning:     warning,
		Tables:      tables,
		Definitions: definitions,
		CreatedAt:   now,
		LastAccess:  now,
	}
	if err := m.register(session); err != nil {
		if session.Source != nil {
			session.Source.clearCache()
		}
		return nil, err
	}
	return session, nil
}

func randomSQLiteID() (string, error) {
	buffer := make([]byte, 18)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func (m *sqliteSessionManager) tablePage(ctx context.Context, session *sqliteSession, tableName string, page, pageSize int, search string, query sqliteTableQuery, exactTotals bool) (sqlitePageResponse, error) {
	definition, ok := session.Definitions[tableName]
	if !ok {
		return sqlitePageResponse{}, apiError{Status: http.StatusBadRequest, Code: "unknown_sqlite_table", Message: "the selected table does not exist in this preview session"}
	}
	if session.Source == nil {
		return sqlitePageResponse{}, apiError{Status: http.StatusGone, Code: "sqlite_session_expired", Message: "the SQLite preview source is no longer available"}
	}
	validColumns := make(map[string]struct{}, len(definition.Info.Columns))
	for _, column := range definition.Info.Columns {
		validColumns[column.Name] = struct{}{}
	}
	for column, filter := range query.Filters {
		if _, ok := validColumns[column]; !ok {
			return sqlitePageResponse{}, apiError{Status: http.StatusBadRequest, Code: "invalid_filter_column", Message: fmt.Sprintf("unknown SQLite filter column %q", column)}
		}
		if len(filter) > 1024 {
			return sqlitePageResponse{}, apiError{Status: http.StatusBadRequest, Code: "filter_too_long", Message: "SQLite column filters are limited to 1024 characters"}
		}
	}
	if query.SortColumn != "" {
		if _, ok := validColumns[query.SortColumn]; !ok {
			return sqlitePageResponse{}, apiError{Status: http.StatusBadRequest, Code: "invalid_sort_column", Message: "sortColumn must name a visible SQLite column"}
		}
		if query.SortDirection != "asc" && query.SortDirection != "desc" {
			return sqlitePageResponse{}, apiError{Status: http.StatusBadRequest, Code: "invalid_sort_direction", Message: "sortDirection must be asc or desc"}
		}
	}
	reader := session.Source.withContext(ctx)
	result, err := querySQLiteTableReader(ctx, reader, session.Size, definition, page, pageSize, search, query.Filters, query.SortColumn, query.SortDirection, exactTotals)
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

func parseSQLiteTableQuery(r *http.Request) (sqliteTableQuery, error) {
	query := sqliteTableQuery{Filters: make(map[string]string)}
	if raw := strings.TrimSpace(r.URL.Query().Get("filters")); raw != "" {
		if len(raw) > 64<<10 {
			return sqliteTableQuery{}, apiError{Status: http.StatusBadRequest, Code: "filters_too_large", Message: "SQLite filters are too large"}
		}
		if err := json.Unmarshal([]byte(raw), &query.Filters); err != nil {
			return sqliteTableQuery{}, apiError{Status: http.StatusBadRequest, Code: "invalid_filters", Message: "filters must be a JSON object keyed by SQLite column name"}
		}
		for column, value := range query.Filters {
			if strings.TrimSpace(value) == "" {
				delete(query.Filters, column)
			}
		}
	}
	query.SortColumn = strings.TrimSpace(r.URL.Query().Get("sortColumn"))
	query.SortDirection = strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sortDirection")))
	if query.SortColumn == "" {
		query.SortDirection = ""
	}
	return query, nil
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
		exactTotals := r.URL.Query().Get("count") == "1"
		query, err := parseSQLiteTableQuery(r)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		result, err := a.sqlite.tablePage(r.Context(), session, r.URL.Query().Get("table"), page, pageSize, r.URL.Query().Get("q"), query, exactTotals)
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
