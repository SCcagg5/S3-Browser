package main

import (
        "context"
        "crypto/tls"
        "encoding/json"
        "encoding/xml"
        "fmt"
        "io"
        "log"
        "net/http"
        "net/url"
        "os"
        "sort"
        "strconv"
        "strings"
        "time"
		"encoding/base64"
        "github.com/aws/aws-sdk-go-v2/aws"
        v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)


type listBucketResultV2 struct {
    XMLName               xml.Name `xml:"ListBucketResult"`
    Name                  string   `xml:"Name"`
    Prefix                string   `xml:"Prefix"`
    Delimiter             string   `xml:"Delimiter"`
    MaxKeys               int      `xml:"MaxKeys"`
    IsTruncated           bool     `xml:"IsTruncated"`
    NextContinuationToken string   `xml:"NextContinuationToken"`
    CommonPrefixes        []struct{ 
		Prefix string `xml:"Prefix"` 
		} `xml:"CommonPrefixes"`
    Contents              []struct {
        Key          string    `xml:"Key"`
        LastModified time.Time `xml:"LastModified"`
        Size         int64     `xml:"Size"`
        ETag         string    `xml:"ETag"`
    } `xml:"Contents"`
}

type listItemJSON struct {
    Type         string     `json:"type"`
    Name         string     `json:"name"`
    Prefix       string     `json:"prefix,omitempty"`
    Key          string     `json:"key,omitempty"`
    Size         int64      `json:"size,omitempty"`
    LastModified *time.Time `json:"lastModified,omitempty"`
    ETag         string     `json:"etag,omitempty"`
}

type listResponseJSON struct {
    Prefix                string         `json:"prefix"`
    Delimiter             string         `json:"delimiter"`
    Items                 []listItemJSON `json:"items"`
    NextContinuationToken string         `json:"nextContinuationToken,omitempty"`
    IsTruncated           bool           `json:"isTruncated"`
}

type cfg struct {
        Endpoint string
        Region   string
        AKID     string
        Secret   string
        Bucket   string
        Port     string
}

func mustEnv(k string) string {
        v := strings.TrimSpace(os.Getenv(k))
        if v == "" {
                log.Fatalf("missing env: %s", k)
        }
        return v
}

func loadCfg() cfg {
        c := cfg{
                Endpoint: mustEnv("S3_ENDPOINT"),
                Region:   mustEnv("S3_REGION"),
                AKID:     mustEnv("S3_ACCESS_KEY_ID"),
                Secret:   mustEnv("S3_SECRET_ACCESS_KEY"),
                Bucket:   mustEnv("S3_BUCKET"),
                Port:     os.Getenv("PORT"),
        }
        if c.Port == "" {
                c.Port = "8080"
        }
        return c
}

type proxy struct {
        cfg     cfg
        origin  *url.URL
        client  *http.Client
        signer  *v4.Signer
        creds   aws.Credentials
        hostHdr string
}

func newProxy(c cfg) *proxy {
        u, err := url.Parse(strings.TrimRight(c.Endpoint, "/"))
        if err != nil {
                log.Fatalf("invalid S3_ENDPOINT: %v", err)
        }
        tr := &http.Transport{
                Proxy: http.ProxyFromEnvironment,
                TLSClientConfig: &tls.Config{
                        InsecureSkipVerify: false,
                },
        }
        return &proxy{
                cfg:     c,
                origin:  u,
                client:  &http.Client{Transport: tr, Timeout: 0},
                signer:  v4.NewSigner(),
                creds:   aws.Credentials{AccessKeyID: c.AKID, SecretAccessKey: c.Secret, Source: "static"},
                hostHdr: u.Host,
        }
}

func (p *proxy) copySafeHeaders(dst http.ResponseWriter, src *http.Response) {
        hop := map[string]bool{
                "connection":          true,
                "keep-alive":          true,
                "proxy-authenticate":  true,
                "proxy-authorization": true,
                "te":                  true,
                "trailers":            true,
                "transfer-encoding":   true,
                "upgrade":             true,
        }
        for k, vv := range src.Header {
                if hop[strings.ToLower(k)] {
                        continue
                }
                for _, v := range vv {
                        dst.Header().Add(k, v)
                }
        }
        dst.Header().Set("Access-Control-Allow-Origin", "*")
        dst.Header().Set("Access-Control-Expose-Headers", "ETag, Last-Modified, Content-Length, Content-Type")
}

func (p *proxy) signAndDo(ctx context.Context, req *http.Request) (*http.Response, error) {
        req.Host = p.hostHdr
        req.Header.Set("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
        now := time.Now().UTC()
        if err := p.signer.SignHTTP(
                ctx, p.creds, req, "UNSIGNED-PAYLOAD", "s3", p.cfg.Region, now,
                func(o *v4.SignerOptions) { o.DisableURIPathEscaping = true },
        ); err != nil {
                return nil, err
        }
        return p.client.Do(req)
}

func (p *proxy) forwardRaw(w http.ResponseWriter, r *http.Request, method, pathUnescaped, rawPath, rawQuery string, body io.Reader, contentLength int64, contentType string) {
        ctx := r.Context()

        u := *p.origin
        u.Path = pathUnescaped
        u.RawPath = rawPath
        u.RawQuery = rawQuery

        req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
        if err != nil {
                http.Error(w, fmt.Sprintf("new request: %v", err), http.StatusInternalServerError)
                return
        }

        copyHdrs := []string{"Range", "If-None-Match", "If-Modified-Since", "Accept", "User-Agent", "Content-Type"}
        for _, h := range copyHdrs {
                if v := r.Header.Get(h); v != "" {
                        req.Header.Set(h, v)
                }
        }
        if contentType != "" {
                req.Header.Set("Content-Type", contentType)
        }
        if contentLength >= 0 {
                req.ContentLength = contentLength
                req.Header.Set("Content-Length", strconv.FormatInt(contentLength, 10))
        }

        resp, err := p.signAndDo(ctx, req)
        if err != nil {
                http.Error(w, fmt.Sprintf("upstream: %v", err), http.StatusBadGateway)
                return
        }
        defer resp.Body.Close()

        for k := range w.Header() {
                w.Header().Del(k)
        }
        p.copySafeHeaders(w, resp)
        w.WriteHeader(resp.StatusCode)

        if method != http.MethodHead {
                _, _ = io.Copy(w, resp.Body)
        }
}

func (p *proxy) handleList(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodGet && r.Method != http.MethodHead {
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        pathUnescaped := "/" + p.cfg.Bucket
        rawPath := "/" + url.PathEscape(p.cfg.Bucket)
        p.forwardRaw(w, r, r.Method, pathUnescaped, rawPath, r.URL.RawQuery, nil, 0, "")
}

func (p *proxy) splitKeyFromURL(r *http.Request) (pathUnescaped, rawPath string, err error) {
        escaped := r.URL.EscapedPath()
        keyPart := strings.TrimPrefix(escaped, "/s3/")
        keyPart = strings.TrimLeft(keyPart, "/")

        unescaped, err := url.PathUnescape(keyPart)
        if err != nil {
                return "", "", err
        }

        segs := strings.Split(unescaped, "/")
        segsClean := make([]string, 0, len(segs))
        segsEsc := make([]string, 0, len(segs))
        for _, s := range segs {
                if s == "" {
                        continue
                }
                segsClean = append(segsClean, s)
                segsEsc = append(segsEsc, url.PathEscape(s))
        }

        pathUnescaped = "/" + p.cfg.Bucket
        rawPath = "/" + url.PathEscape(p.cfg.Bucket)
        if len(segsClean) > 0 {
                pathUnescaped += "/" + strings.Join(segsClean, "/")
                rawPath += "/" + strings.Join(segsEsc, "/")
        }
        return pathUnescaped, rawPath, nil
}

func (p *proxy) handleGetObject(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodGet && r.Method != http.MethodHead {
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        pathUnescaped, rawPath, err := p.splitKeyFromURL(r)
        if err != nil {
                http.Error(w, "bad path", http.StatusBadRequest)
                return
        }
        p.forwardRaw(w, r, r.Method, pathUnescaped, rawPath, r.URL.RawQuery, nil, 0, "")
}

func (p *proxy) handlePutObject(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPut {
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        pathUnescaped, rawPath, err := p.splitKeyFromURL(r)
        if err != nil {
                http.Error(w, "bad path", http.StatusBadRequest)
                return
        }

        ct := r.Header.Get("Content-Type")
        cl := r.ContentLength
        if cl < 0 {
        }

        p.forwardRaw(w, r, http.MethodPut, pathUnescaped, rawPath, r.URL.RawQuery, r.Body, cl, ct)
}

func (p *proxy) handleDeleteObject(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodDelete {
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        pathUnescaped, rawPath, err := p.splitKeyFromURL(r)
        if err != nil {
                http.Error(w, "bad path", http.StatusBadRequest)
                return
        }
        p.forwardRaw(w, r, http.MethodDelete, pathUnescaped, rawPath, r.URL.RawQuery, nil, 0, "")
}


func (p *proxy) buildBucketURL(q url.Values) (string, string) {
        u := *p.origin
        u.Path = "/" + p.cfg.Bucket
        u.RawPath = "/" + url.PathEscape(p.cfg.Bucket)
        u.RawQuery = q.Encode()
        return u.String(), u.RawPath
}

func (p *proxy) listAllKeys(ctx context.Context, prefix string) ([]string, error) {
        type listBucketResult struct {
                XMLName               xml.Name `xml:"ListBucketResult"`
                NextContinuationToken string   `xml:"NextContinuationToken"`
                Contents              []struct {
                        Key  string `xml:"Key"`
                        Size int64  `xml:"Size"`
                } `xml:"Contents"`
        }

        var keys []string
        var token string
        for {
                q := url.Values{}
                q.Set("list-type", "2")
                if prefix != "" {
                        q.Set("prefix", prefix)
                }
                q.Set("max-keys", "1000")
                if token != "" {
                        q.Set("continuation-token", token)
                }

                u := *p.origin
                u.Path = "/" + p.cfg.Bucket
                u.RawPath = "/" + url.PathEscape(p.cfg.Bucket)
                u.RawQuery = q.Encode()

                req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
                resp, err := p.signAndDo(ctx, req)
                if err != nil {
                        return nil, err
                }
                b, err := io.ReadAll(resp.Body)
                resp.Body.Close()
                if err != nil {
                        return nil, err
                }
                if resp.StatusCode != http.StatusOK {
                        return nil, fmt.Errorf("list failed: %s", resp.Status)
                }
                var lb listBucketResult
                if err := xml.Unmarshal(b, &lb); err != nil {
                        return nil, err
                }
                for _, c := range lb.Contents {
                        keys = append(keys, c.Key)
                }
                if lb.NextContinuationToken == "" {
                        break
                }
                token = lb.NextContinuationToken
        }
        return keys, nil
}

func (p *proxy) copyObject(ctx context.Context, srcKey, dstKey string) error {
        dstUnescaped := "/" + p.cfg.Bucket + "/" + strings.TrimLeft(srcToPath(dstKey), "/")
        dstRaw := "/" + url.PathEscape(p.cfg.Bucket) + "/" + encodeKeyRaw(dstKey)

        u := *p.origin
        u.Path = dstUnescaped
        u.RawPath = dstRaw

        req, _ := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), nil)
        copySrc := "/" + p.cfg.Bucket + "/" + encodeKeyRaw(srcKey)
        req.Header.Set("x-amz-copy-source", copySrc)

        resp, err := p.signAndDo(ctx, req)
        if err != nil {
                return err
        }
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
        if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
                return fmt.Errorf("copy failed: %s", resp.Status)
        }
        return nil
}

func (p *proxy) deleteObject(ctx context.Context, key string) error {
        u := *p.origin
        u.Path = "/" + p.cfg.Bucket + "/" + strings.TrimLeft(srcToPath(key), "/")
        u.RawPath = "/" + url.PathEscape(p.cfg.Bucket) + "/" + encodeKeyRaw(key)

        req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, u.String(), nil)
        resp, err := p.signAndDo(ctx, req)
        if err != nil {
                return err
        }
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
        if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
                return fmt.Errorf("delete failed: %s", resp.Status)
        }
        return nil
}

func encodeKeyRaw(key string) string {
        segs := strings.Split(key, "/")
        enc := make([]string, 0, len(segs))
        for _, s := range segs {
                if s == "" {
                        continue
                }
                enc = append(enc, url.PathEscape(s))
        }
        return strings.Join(enc, "/")
}

func srcToPath(s string) string {
        return strings.TrimLeft(s, "/")
}


type listBucketResult struct {
        XMLName               xml.Name `xml:"ListBucketResult"`
        NextContinuationToken string   `xml:"NextContinuationToken"`
        Contents              []struct {
                Key          string    `xml:"Key"`
                LastModified time.Time `xml:"LastModified"`
                Size         int64     `xml:"Size"`
                ETag         string    `xml:"ETag"`
        } `xml:"Contents"`
}

type agg struct {
        Count int64 `json:"count"`
        Bytes int64 `json:"bytes"`
}

type statsResponse struct {
        Prefix     string         `json:"prefix"`
        Count      int64          `json:"count"`
        TotalBytes int64          `json:"totalBytes"`
        TookMs     int64          `json:"tookMs"`
        ByType     map[string]agg `json:"byType"`
        ByFolder   map[string]agg `json:"byFolder"`
        Newest     *time.Time     `json:"newest,omitempty"`
        Oldest     *time.Time     `json:"oldest,omitempty"`
}

func detectKind(key string) string {
        k := strings.ToLower(key)
        ext := ""
        if i := strings.LastIndex(k, "."); i >= 0 {
                ext = k[i+1:]
        }
        switch ext {
	case "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif":
		return "image"
	case "mp4", "mkv", "webm", "avi", "mov", "m4v", "mpg", "mpeg", "flv", "3gp", "wmv", "ogv", "mts", "m2ts", "vob":
		return "video"
	case "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "alac", "wma", "amr", "midi", "mid":
		return "audio"
	case "pdf":
		return "pdf"
	case "md", "markdown", "mdown", "mkd", "rmd":
		return "markdown"
	case "doc", "docx", "rtf", "txt", "odt":
		return "doc"
	case "xls", "xlsx", "xlsm", "xlsb", "xlt", "ods", "csv", "tsv", "numbers", "parquet":
		return "spreadsheet"
	case "ppt", "pptx", "pps", "ppsx", "odp", "key":
		return "presentation"
	case "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz", "xz", "txz", "zst":
		return "archive"
	case "gitignore", "js", "ts", "jsx", "tsx", "json", "yaml", "yml", "toml", "ini", "sh", "bash", "zsh", "ps1", "py", "rb", "php", "java", "go", "rs", "c", "cpp", "h", "cs", "swift", "sql":
		return "code"
	default:
		return "other"
	}
}

func (p *proxy) handleStats(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodGet {
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        prefix := r.URL.Query().Get("prefix")

        start := time.Now()
        ctx := r.Context()

        out := statsResponse{
                Prefix:   prefix,
                ByType:   map[string]agg{},
                ByFolder: map[string]agg{},
        }

        var token string
        for {
                q := url.Values{}
                q.Set("list-type", "2")
                if prefix != "" {
                        q.Set("prefix", prefix)
                }
                q.Set("max-keys", "1000")
                if token != "" {
                        q.Set("continuation-token", token)
                }

                u := *p.origin
                u.Path = "/" + p.cfg.Bucket
                u.RawPath = "/" + url.PathEscape(p.cfg.Bucket)
                u.RawQuery = q.Encode()

                req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
                if err != nil {
                        http.Error(w, fmt.Sprintf("new request: %v", err), http.StatusInternalServerError)
                        return
                }
                resp, err := p.signAndDo(ctx, req)
                if err != nil {
                        http.Error(w, fmt.Sprintf("upstream: %v", err), http.StatusBadGateway)
                        return
                }
                body, err := io.ReadAll(resp.Body)
                resp.Body.Close()
                if err != nil {
                        http.Error(w, fmt.Sprintf("read: %v", err), http.StatusBadGateway)
                        return
                }
                if resp.StatusCode != http.StatusOK {
                        http.Error(w, fmt.Sprintf("list failed: %s", resp.Status), resp.StatusCode)
                        return
                }

                var lb listBucketResult
                if err := xml.Unmarshal(body, &lb); err != nil {
                        http.Error(w, fmt.Sprintf("xml: %v", err), http.StatusBadGateway)
                        return
                }

                for _, c := range lb.Contents {
                        if strings.HasSuffix(c.Key, "/") && c.Size == 0 {
                                continue
                        }
                        out.Count++
                        out.TotalBytes += c.Size

                        if out.Newest == nil || c.LastModified.After(*out.Newest) {
                                t := c.LastModified
                                out.Newest = &t
                        }
                        if out.Oldest == nil || c.LastModified.Before(*out.Oldest) {
                                t := c.LastModified
                                out.Oldest = &t
                        }

                        kind := detectKind(c.Key)
                        aggT := out.ByType[kind]
                        aggT.Count++
                        aggT.Bytes += c.Size
                        out.ByType[kind] = aggT

                        rest := c.Key
                        if prefix != "" && strings.HasPrefix(rest, prefix) {
                                rest = strings.TrimPrefix(rest, prefix)
                        }
                        if i := strings.IndexByte(rest, '/'); i >= 0 {
                                folder := rest[:i+1]
                                ag := out.ByFolder[folder]
                                ag.Count++
                                ag.Bytes += c.Size
                                out.ByFolder[folder] = ag
                        }
                }

                if lb.NextContinuationToken == "" {
                        break
                }
                token = lb.NextContinuationToken
        }

        type kv struct {
                Name string
                A    agg
        }
        var folders []kv
        for k, v := range out.ByFolder {
                folders = append(folders, kv{Name: k, A: v})
        }
        sort.Slice(folders, func(i, j int) bool {
                if folders[i].A.Bytes == folders[j].A.Bytes {
                        return folders[i].Name < folders[j].Name
                }
                return folders[i].A.Bytes > folders[j].A.Bytes
        })
        if len(folders) > 1000 {
                folders = folders[:1000]
        }
        trimmed := make(map[string]agg, len(folders))
        for _, it := range folders {
                trimmed[it.Name] = it.A
        }
        out.ByFolder = trimmed

        out.TookMs = time.Since(start).Milliseconds()

        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(out)
}


type renameRequest struct {
        Src      string `json:"src"`  
        Dst      string `json:"dst"`  
        IsPrefix bool   `json:"isPrefix"` 
}

type renameResponse struct {
        Moved int   `json:"moved"`
        Took  int64 `json:"tookMs"`
}

func (p *proxy) handleRename(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        ctx := r.Context()
        var req renameRequest
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                http.Error(w, "bad json", http.StatusBadRequest)
                return
        }

        start := time.Now()
        moved := 0

        if req.IsPrefix {
                src := strings.TrimLeft(req.Src, "/")
                if src != "" && !strings.HasSuffix(src, "/") {
                        src += "/"
                }
                dst := strings.TrimLeft(req.Dst, "/")
                if dst != "" && !strings.HasSuffix(dst, "/") {
                        dst += "/"
                }
                keys, err := p.listAllKeys(ctx, src)
                if err != nil {
                        http.Error(w, fmt.Sprintf("list: %v", err), http.StatusBadGateway)
                        return
                }
                for _, k := range keys {
                        if strings.HasSuffix(k, "/") {
                                continue
                        }
                        newKey := dst + strings.TrimPrefix(k, src)
                        if err := p.copyObject(ctx, k, newKey); err != nil {
                                http.Error(w, fmt.Sprintf("copy %s -> %s: %v", k, newKey, err), http.StatusBadGateway)
                                return
                        }
                        if err := p.deleteObject(ctx, k); err != nil {
                                http.Error(w, fmt.Sprintf("delete %s: %v", k, err), http.StatusBadGateway)
                                return
                        }
                        moved++
                }
        } else {
                if err := p.copyObject(ctx, req.Src, req.Dst); err != nil {
                        http.Error(w, fmt.Sprintf("copy %s -> %s: %v", req.Src, req.Dst, err), http.StatusBadGateway)
                        return
                }
                if err := p.deleteObject(ctx, req.Src); err != nil {
                        http.Error(w, fmt.Sprintf("delete %s: %v", req.Src, err), http.StatusBadGateway)
                        return
                }
                moved = 1
        }

        out := renameResponse{Moved: moved, Took: time.Since(start).Milliseconds()}
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(out)
}

type deletePrefixRequest struct {
        Prefix string `json:"prefix"`
}
type deletePrefixResponse struct {
        Deleted int   `json:"deleted"`
        Took    int64 `json:"tookMs"`
}

func (p *proxy) handleDeletePrefix(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        ctx := r.Context()
        var req deletePrefixRequest
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                http.Error(w, "bad json", http.StatusBadRequest)
                return
        }
        pfx := strings.TrimLeft(req.Prefix, "/")
        if pfx != "" && !strings.HasSuffix(pfx, "/") {
                pfx += "/"
        }

        start := time.Now()
        keys, err := p.listAllKeys(ctx, pfx)
        if err != nil {
                http.Error(w, fmt.Sprintf("list: %v", err), http.StatusBadGateway)
                return
        }
        deleted := 0
        for _, k := range keys {
                if err := p.deleteObject(ctx, k); err != nil {
                        http.Error(w, fmt.Sprintf("delete %s: %v", k, err), http.StatusBadGateway)
                        return
                }
                deleted++
        }
        out := deletePrefixResponse{Deleted: deleted, Took: time.Since(start).Milliseconds()}
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(out)
}

type ffCursor struct {
    Phase string `json:"p"`         
    After string `json:"a,omitempty"`
}


func encodeCursor(c ffCursor) string {
	b, _ := json.Marshal(c)
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "=")
}
func decodeCursor(s string) (ffCursor, error) {
    if s == "" {
        return ffCursor{Phase: "dir"}, nil
    }
    if m := len(s) % 4; m != 0 {
        s += strings.Repeat("=", 4-m)
    }
    var c ffCursor
    b, err := base64.URLEncoding.DecodeString(s)
    if err != nil {
        return ffCursor{}, err
    }
    if err := json.Unmarshal(b, &c); err != nil {
        return ffCursor{}, err
    }
    if c.Phase == "" {
        c.Phase = "dir"
    }
    return c, nil
}

func (p *proxy) s3ListPage(ctx context.Context, prefix, delimiter, startAfter string, maxKeys int) (*listBucketResultV2, error) {
    if delimiter == "" { delimiter = "/" }
    if maxKeys <= 0 || maxKeys > 1000 { maxKeys = 1000 }

    q := url.Values{}
    q.Set("list-type", "2")
    q.Set("delimiter", delimiter)
    q.Set("max-keys", strconv.Itoa(maxKeys))
    if prefix != "" { q.Set("prefix", prefix) }
    if startAfter != "" { q.Set("start-after", startAfter) }

    u := *p.origin
    u.Path = "/" + p.cfg.Bucket
    u.RawPath = "/" + url.PathEscape(p.cfg.Bucket)
    u.RawQuery = q.Encode()

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
    if err != nil { return nil, err }

    resp, err := p.signAndDo(ctx, req)
    if err != nil { return nil, err }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        b, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("list failed: %s %s", resp.Status, strings.TrimSpace(string(b)))
    }
    b, err := io.ReadAll(resp.Body)
    if err != nil { return nil, err }

    var lb listBucketResultV2
    if err := xml.Unmarshal(b, &lb); err != nil { return nil, err }
    return &lb, nil
}
func parseExcludes(r *http.Request) []string {
    vals := r.URL.Query()["exclude"]
    if len(vals) == 0 {
        if s := r.URL.Query().Get("exclude"); s != "" {
            vals = strings.Split(s, ",")
        }
    }
    out := make([]string, 0, len(vals))
    for _, v := range vals {
        v = strings.TrimSpace(strings.TrimLeft(v, "/"))
        if v == "" { continue }
        out = append(out, v)
    }
    return out
}
func isExcluded(rel string, excludes []string) bool {
    for _, ex := range excludes {
        if strings.HasPrefix(rel, ex) { return true }
    }
    return false
}

func (p *proxy) handleListJSON(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodGet && r.Method != http.MethodHead {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }
    ctx := r.Context()

    prefix := strings.TrimLeft(r.URL.Query().Get("prefix"), "/")
    delimiter := r.URL.Query().Get("delimiter")
    if delimiter == "" { delimiter = "/" }

    limit := 50
    if s := r.URL.Query().Get("max"); s != "" {
        if v, err := strconv.Atoi(s); err == nil && v > 0 { limit = v }
    }

        excludes := parseExcludes(r)

        cur, err := decodeCursor(r.URL.Query().Get("continuationToken"))
    if err != nil {
        http.Error(w, "bad continuationToken", http.StatusBadRequest)
        return
    }
    if cur.Phase != "dir" && cur.Phase != "file" { cur.Phase = "dir" }

    items := make([]listItemJSON, 0, limit)
    next := ffCursor{Phase: cur.Phase, After: cur.After}
    hasMore := false

    seenDirs := map[string]struct{}{}
    const maxAttempts = 200
    attempts := 0

    for len(items) < limit && attempts < maxAttempts {
        attempts++

        innerMax := 1000
        if cur.Phase == "file" {
            innerMax = limit
            if innerMax > 1000 { innerMax = 1000 }
        }

        sa := cur.After
        if cur.Phase == "dir" && sa != "" {
            if strings.HasSuffix(sa, delimiter) && len(delimiter) == 1 {
                sa = strings.TrimSuffix(sa, delimiter) + string(delimiter[0]+1)
            } else {
                sa = sa + "~"
            }
        }
        if prefix != "" && sa != "" { sa = prefix + sa }

        lb, err := p.s3ListPage(ctx, prefix, delimiter, sa, innerMax)
        if err != nil {
            http.Error(w, fmt.Sprintf("upstream: %v", err), http.StatusBadGateway)
            return
        }

        progress := false

        if cur.Phase == "dir" {
                        for _, cp := range lb.CommonPrefixes {
                rel := cp.Prefix
                if prefix != "" && strings.HasPrefix(rel, prefix) {
                    rel = strings.TrimPrefix(rel, prefix)
                }
                if rel == "" || !strings.HasSuffix(rel, "/") { continue }
                if isExcluded(rel, excludes) { continue }

                if _, ok := seenDirs[cp.Prefix]; ok { continue }
                seenDirs[cp.Prefix] = struct{}{}

                name := strings.TrimSuffix(rel, "/")
                if i := strings.LastIndexByte(name, '/'); i >= 0 { name = name[i+1:] }

                items = append(items, listItemJSON{
                    Type:   "prefix",
                    Name:   name + "/",
                    Prefix: cp.Prefix,                 })
                cur.After = rel
                progress = true
                if len(items) >= limit { break }
            }

            if len(items) >= limit {
                hasMore = true
                next = ffCursor{Phase: "dir", After: cur.After}
                break
            }

            if !progress {
                if len(lb.Contents) > 0 {
                    lastKey := lb.Contents[len(lb.Contents)-1].Key
                    rel := lastKey
                    if prefix != "" && strings.HasPrefix(rel, prefix) {
                        rel = strings.TrimPrefix(rel, prefix)
                    }
                                        cur.After = rel
                    continue
                }
                                if !lb.IsTruncated {
                    cur.Phase = "file"
                    cur.After = ""
                    continue
                }
                                continue
            }

                        continue
        }

                if cur.Phase == "file" {
            for _, c := range lb.Contents {
                if strings.HasSuffix(c.Key, "/") && c.Size == 0 { continue }
                rel := c.Key
                if prefix != "" && strings.HasPrefix(rel, prefix) {
                    rel = strings.TrimPrefix(rel, prefix)
                }
                if isExcluded(rel, excludes) { continue }

                name := c.Key
                if i := strings.LastIndexByte(name, '/'); i >= 0 { name = name[i+1:] }
                t := c.LastModified
                items = append(items, listItemJSON{
                    Type:         "content",
                    Name:         name,
                    Key:          c.Key,
                    Size:         c.Size,
                    LastModified: &t,
                    ETag:         c.ETag,
                })
                cur.After = rel
                progress = true
                if len(items) >= limit { break }
            }

            if len(items) >= limit {
                hasMore = true
                next = ffCursor{Phase: "file", After: cur.After}
                break
            }
            if !progress {
                hasMore = false
                break
            }
            continue
        }
    }

    out := listResponseJSON{
        Prefix:    prefix,
        Delimiter: delimiter,
        Items:     items,
    }
    if hasMore {
        out.IsTruncated = true
        out.NextContinuationToken = encodeCursor(next)
    } else {
        out.IsTruncated = false
    }
    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(out)
}




func withCORS(h http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Access-Control-Allow-Origin", "*")
                w.Header().Set("Vary", "Origin")
                if r.Method == http.MethodOptions {
                        w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, DELETE, POST, OPTIONS")
                        w.Header().Set("Access-Control-Allow-Headers",
                                "Content-Type, Content-Length, Range, If-None-Match, If-Modified-Since, Accept, User-Agent")
                        w.WriteHeader(http.StatusNoContent)
                        return
                }
                h.ServeHTTP(w, r)
        })
}

func spaFileServer(root string) http.Handler {
	fs := http.FileServer(http.Dir(root))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if path == "/" {
			http.ServeFile(w, r, root+"/index.html")
			return
		}

		if !strings.Contains(path[strings.LastIndex(path, "/")+1:], ".") {
			htmlPath := root + path + ".html"
			if _, err := os.Stat(htmlPath); err == nil {
				http.ServeFile(w, r, htmlPath)
				return
			}
		}

		fs.ServeHTTP(w, r)
	})
}


func (p *proxy) routes() http.Handler {
        mux := http.NewServeMux()
	mux.HandleFunc("/api/list", p.handleListJSON)
        mux.HandleFunc("/api/stats", p.handleStats)
        mux.HandleFunc("/api/rename", p.handleRename)
        mux.HandleFunc("/api/delete-prefix", p.handleDeletePrefix)

        mux.Handle("/", spaFileServer("/public"))

        mux.HandleFunc("/s3", func(w http.ResponseWriter, r *http.Request) {
                switch r.Method {
                case http.MethodGet, http.MethodHead:
                        p.handleList(w, r)
                case http.MethodOptions:
                        w.WriteHeader(http.StatusNoContent)
                default:
                        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                }
        })

        mux.HandleFunc("/s3/", func(w http.ResponseWriter, r *http.Request) {
                switch r.Method {
                case http.MethodGet, http.MethodHead:
                        p.handleGetObject(w, r)
                case http.MethodPut:
                        p.handlePutObject(w, r)
                case http.MethodDelete:
                        p.handleDeleteObject(w, r)
                case http.MethodOptions:
                        w.WriteHeader(http.StatusNoContent)
                default:
                        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                }
        })

        mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
                ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
                defer cancel()
                _ = ctx
                w.WriteHeader(http.StatusOK)
                _, _ = w.Write([]byte("ok\n"))
        })

        return withCORS(mux)
}

func main() {
        c := loadCfg()
        p := newProxy(c)
        addr := ":" + c.Port
        log.Printf("garage-s3-proxy listening on %s (bucket=%s, endpoint=%s)", addr, c.Bucket, c.Endpoint)
        if err := http.ListenAndServe(addr, p.routes()); err != nil {
                log.Fatal(err)
        }
}