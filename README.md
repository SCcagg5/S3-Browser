# Object Storage Browser

Object Storage Browser is a self-hosted web interface for browsing and managing multiple S3-compatible and Google Cloud Storage buckets from one process. S3 means the protocol, not a specific vendor: the same interface works with services such as Garage, MinIO, Ceph, AWS S3, and compatible gateways.

The backend is a single Go program and uses only the Go standard library. The HCL subset parser, AWS Signature Version 4 implementation, Google service-account flow, provider clients, persistent job engine, and resumable upload coordinator are implemented in this repository.

## Main features

- Multiple named S3 and GCS instances in one interface.
- Provider-neutral storage icons and favicon.
- Read, write, and delete capabilities displayed inside the instance selector and enforced again by every server route.
- Prefix navigation, object details, preview, download, upload, copy, rename, recursive delete, and recursive statistics.
- Multi-file and folder upload by picker or drag and drop.
- S3 multipart uploads and GCS resumable uploads for large objects.
- Persistent, resumable background jobs for large recursive operations.
- One bottom-right upload panel and one download panel, with individual and global pause/resume controls.
- Transfer panels keep bandwidth-consuming items above queued, paused, failed, and completed items, even when hundreds of transfers are present.
- Folder download as ZIP from the folder menu or the current-folder Actions menu.
- Right-click menus identical to the three-dot row menus.
- Source and Markdown viewers with syntax highlighting, fixed line numbers, horizontal scrolling for long lines, an 80-character guide, justified prose, Mermaid diagrams, and support for extensionless files and dotfiles.
- CSV, TSV (`.tsv` and `.tab`), PSV, JSON Lines, NDJSON, Parquet, XLS, XLSX, and XLSM previews with filtering, sorting, pagination, multiple worksheet support, and removal of fully empty rows and columns.
- Read-only SQLite table browsing with pagination and whole-table search through the embedded pure-Go SQLite reader.
- `Ctrl`/`Cmd` + `F` full-document search for text, JSON, delimited data, the active Excel worksheet, Parquet, and the active SQLite table rather than only the currently visible page.
- Large JSON preview with three consistent worksheet-style modes: syntax-colored exact Raw pages, syntax-colored server-streamed Beautify pages, and a server-streamed Tree whose root level is expanded by default and whose array nodes display their known element counts.
- Browser-side DOCX, DOTX, DOCM, and DOTM preview with safe semantic HTML conversion.
- Range-based, one-page-at-a-time PDF.js preview.
- Audio playback for browser-compatible formats.
- Video playback is intentionally disabled: every video preview shows an explicit unavailable message and offers the original download. Video metadata remains available from the format-aware parsers used by an explicit Details action.
- Format-aware image, audio, and video metadata inspection using byte ranges rather than complete-object downloads.
- Embedded JPEG extraction for RAF and TIFF-based RAW files.
- Image and RAW previews use the complete height available below the preview navigation and keep the whole image visible without a page scrollbar.
- Storage or Folder Insights combines a compact overview and an interactive treemap in one tabbed dialog. The treemap is limited to five folder levels and 1,000 rectangles; each folder shows only children larger than 1% of that folder, while smaller children are combined into a local **Others** rectangle with an exact file count and size.

## Storage request and cost policy

Object-storage operations can be billed per request. The application therefore follows these rules:

1. **Listing a folder never probes each object.** A page load performs only the provider list request required for that page. It does not issue a `HEAD`, metadata probe, or `GET` per row.
2. **File metadata is read only after an explicit Details action.** No image dimensions, EXIF, media duration, track discovery, or codec discovery runs while browsing a folder.
3. **Preview work begins only after an explicit preview action.** Images, documents, spreadsheets, JSON pages, and PDF ranges are fetched only after the user opens the object.
4. **Video playback is disabled.** Opening a video does not start FFmpeg, create HLS segments, read the media payload, or launch a background process. The original object remains downloadable.
5. **Metadata reads are format-driven.** Parsers follow signatures, declared block lengths, box tables, IFD offsets, or container indexes until the relevant metadata structure ends. They do not use a fixed 32 KiB target.
6. **Nearby ranges are coalesced within one HTTP action.** Fetched bytes live only for the active request or browser operation and are discarded afterward. There is no process-wide or persistent object-content cache.
7. **Large JSON is streamed and paged.** Raw, Beautify, and Tree operations each use one request-scoped provider stream at a time. The backend keeps only the current bounded output page, parser state, and visible tree nodes in memory. Exact line and page totals are not calculated automatically; the user can start one explicit full streaming pass from the viewer or Details when those totals are needed.
8. **Range support is mandatory for random-access inspection.** If a provider ignores a requested Range, the application rejects the operation instead of silently downloading a multi-gigabyte object.
9. **Safety limits are guards, not read targets.** Format parsers reject a single declared metadata structure larger than 128 MiB. Normal files generally require far less.
10. **Startup does not probe bucket permissions.** Configured permissions are available immediately without a billable list, HEAD, or IAM-test request. Provider verification runs only when explicitly requested through the API.
11. **Whole-document search is explicit.** `Ctrl`/`Cmd` + `F` may scan the complete selected object, worksheet, table, or Parquet dataset. It never runs during listing or preview initialization.
12. **Storage and folder insights are explicit recursive jobs.** Opening Insights lists the complete selected prefix once and reuses that single result for both the Overview and Treemap tabs, because exact distributions cannot be derived from a paginated browser listing alone.

Opening the same Details panel twice performs two explicit metadata reads; parsed object metadata and object bytes are not retained as an application cache.

## Configuration source

Configuration is loaded in this order:

1. `-c <path>` or `--config <path>`
2. `S3_BROWSER_CONFIG_FILE=<path>`
3. `S3_BROWSER_CONFIG_HCL=<complete HCL document>`

A configuration source is required. The process does not search for an implicit `config.hcl`.

```sh
./s3-browser version
./s3-browser -c /etc/s3-browser/config.hcl
```

The HCL file can contain secrets. Restrict its permissions and mount it read-only where possible:

```sh
chmod 600 /etc/s3-browser/config.hcl
```

## HCL configuration

The parser supports blocks, quoted labels, quoted strings, booleans, integers, string lists, and `#`, `//`, or `/* ... */` comments.

```hcl
server {
  listen            = ":8080"
  data_dir          = "/var/lib/s3-browser"
  job_history_limit = 100
}

storage "garage-archive" {
  name       = "Garage archive"
  provider   = "s3"
  endpoint   = "https://s3.example.internal"
  region     = "garage"
  bucket     = "archive"
  auth       = "access_key"

  # Choose exactly one source for each value.
  access_key_id_env      = "ARCHIVE_S3_ACCESS_KEY_ID"
  secret_access_key_file = "/run/secrets/archive-s3-secret-key"
  # session_token_env    = "ARCHIVE_S3_SESSION_TOKEN"

  permissions = ["read", "write", "delete"]
  root_prefix = "customers/acme/"
}

storage "public-assets" {
  name        = "Public assets"
  provider    = "s3"
  endpoint    = "https://s3.example.com"
  region      = "us-east-1"
  bucket      = "public-assets"
  auth        = "anonymous"
  permissions = ["read"]
}

storage "gcs-imports" {
  name             = "GCS imports"
  provider         = "gcs"
  bucket           = "example-imports"
  auth             = "service_account"
  credentials_file = "/run/secrets/gcs-service-account.json"

  # Optional. When omitted, the application defaults to read-only.
  permissions = ["read", "write", "delete"]
}
```

### Server attributes

| Attribute | Default | Description |
| --- | --- | --- |
| `listen` | `:8080` | HTTP listen address. |
| `data_dir` | `.s3-browser-data` beside the HCL source | Private runtime state for persistent jobs and resumable uploads. Relative paths are resolved from the HCL directory. Parsed metadata and object bytes are not retained for reuse. |
| `job_history_limit` | `100` | Maximum number of terminal background jobs retained on disk and returned by the API. Active jobs are never pruned. Allowed range: 1–10,000. |

### Common storage attributes

| Attribute | Required | Description |
| --- | --- | --- |
| `storage "id"` | yes | Stable API and URL identifier. Allowed characters: letters, digits, `.`, `_`, and `-`. |
| `name` | no | Human-readable label. Defaults to the identifier. |
| `provider` | yes | `s3` or `gcs`. |
| `bucket` | yes | Bucket name. |
| `endpoint` | S3 only | Base URL for the S3-compatible API. GCS defaults to `https://storage.googleapis.com`. |
| `region` | S3 only | AWS Signature Version 4 region used by the compatible endpoint. |
| `auth` | no | `access_key` or `anonymous` for S3; `service_account` or `anonymous` for GCS. |
| `permissions` | no | Application maximum: any combination of `read`, `write`, and `delete`. |
| `root_prefix` | no | Prefix exposed as the root of the instance. |
| `trash_prefix` | no | Prefix hidden from normal lists. Defaults to `_trash/`; deletion remains permanent. |
| `insecure_skip_verify` | no | Disables TLS certificate verification. Use only for isolated local testing. |

## S3 authentication sources

For every S3 credential, choose exactly one direct, environment, or file source. Sources can be mixed between credentials.

| Value | Direct HCL | Environment reference | File reference |
| --- | --- | --- | --- |
| Access key ID | `access_key_id` | `access_key_id_env` | `access_key_id_file` |
| Secret access key | `secret_access_key` or `secret_key` | `secret_access_key_env` or `secret_key_env` | `secret_access_key_file` or `secret_key_file` |
| Optional session token | `session_token` | `session_token_env` | `session_token_file` |

Relative secret-file paths are resolved from the directory containing the HCL file. Environment attributes contain the environment-variable **name**, not the secret itself. Secret files are read once during startup. Empty values and missing variables or files fail configuration loading.

Direct example:

```hcl
storage "garage" {
  name              = "Garage primary"
  provider          = "s3"
  endpoint          = "http://garage:3900"
  region            = "garage"
  bucket            = "default"
  auth              = "access_key"
  access_key_id     = "local-access-key"
  secret_access_key = "local-secret-key"
  permissions       = ["read", "write", "delete"]
}
```

## GCS authentication

A GCS service-account document remains in an external JSON file and is referenced from HCL:

```hcl
storage "gcs" {
  provider         = "gcs"
  bucket           = "example-bucket"
  auth             = "service_account"
  credentials_file = "./secrets/gcs-service-account.json"
}
```

Relative paths are resolved from the HCL directory. The service-account JSON is read during startup and is never returned to the frontend.

## Permissions

Permissions are both a UI capability and a server-side authorization boundary.

- Every API route checks the required permission.
- Disabled actions are hidden or disabled in the frontend.
- Permission icons are shown inside the storage selector.
- Clicking a permission icon on the selected instance opens its configured or explicitly verified details.
- Startup never probes a bucket merely to verify permissions. This avoids an automatic billable list/HEAD request for S3 and an automatic IAM-test request for GCS.
- `permissions` defaults to read-only when omitted. Declare the maximum actions that the application may expose.
- An operator can explicitly call `POST /api/permissions/refresh?instance=<id>` when provider verification is worth the extra request. GCS uses `testIamPermissions`. S3-compatible services can verify read access with a non-destructive list/HEAD probe, but do not expose a portable non-destructive write/delete test.

The application does not provide user accounts or RBAC. Put it behind an authentication and authorization proxy before exposing it to untrusted networks.

## Details and metadata

The Details dialog separates two sources.

### Storage object

This section contains provider-level information such as size, MIME type, last modification time, ETag, generation/version, and custom S3/GCS metadata.

For supported file formats, the first format-aware Range response is also used to populate these fields, avoiding a separate `HEAD`. Objects whose format is not inspected use one explicit `HEAD` when Details is opened.

### File metadata

This section is derived from the file structure and can include:

- image width and height;
- camera make and model;
- lens, ISO, exposure time, aperture, focal length, and orientation;
- EXIF date and GPS latitude, longitude, and altitude;
- media container, duration, codecs, and detected video/audio/subtitle tracks;
- audio title, artist, album, sample rate, channels, bit depth, and bit rate when present.

Image dimensions shown in Details come from parsed file headers, boxes, IFDs, or embedded-preview metadata. They do not depend on DOM `naturalWidth`/`naturalHeight`, and opening a preview does not enrich an application cache.

The adaptive readers cover common and many less-common layouts, including JPEG, PNG, GIF, WebP, BMP, PSD/PSB, TGA, ICO, DDS, PCX, SGI, QOI, farbfeld, FITS, PNM/PAM, Radiance HDR, OpenEXR, JPEG 2000, SVG, TIFF/BigTIFF, RAF, many TIFF-derived RAW formats, HEIF/AVIF/CR3, MP4/MOV/M4A, Matroska/WebM, MP3, FLAC, WAV, and Ogg. Proprietary formats can still omit fields when the required structure is undocumented or not present.

## Image previews

Browser-compatible images are served unchanged.

For RAF and TIFF-based RAW files, the server first follows declared offsets and returns an embedded JPEG when one exists. This is not a generated thumbnail; those JPEG bytes are already part of the source object.

When the browser cannot display the original and no usable embedded JPEG exists, the UI reports that preview is unavailable and keeps the original download action. The server does not download the complete RAW object to generate a derivative and does not invoke ImageMagick or another external converter.

## Video and audio previews

Audio files supported by the browser are streamed unchanged with HTTP Range support.

Video playback is deliberately disabled for every video extension and MIME type. The preview page displays **Video preview is disabled** and keeps the original download action available. This avoids browser-specific codec behavior, hidden full-object reads, transcodes, HLS generation, orphan FFmpeg processes, and unexpected CPU usage on small servers.

The **Details** action remains separate from preview. Format-aware MP4/MOV, Matroska/WebM, and other parsers try to read duration, resolution, codecs, and track metadata directly from container headers. No FFmpeg or FFprobe process is started. Unsupported or unusually structured files can therefore leave some fields empty rather than triggering an expensive external probe.

## Word document previews

DOCX, DOTX, DOCM, and DOTM files are converted to safe semantic HTML in the browser with a pinned Mammoth browser module. Embedded images, headings, lists, tables, footnotes, and common inline formatting are displayed when represented by the document structure. Macros are never executed.

The browser must download the complete OOXML package for conversion, so Word preview is limited to 128 MiB. Legacy binary DOC/DOT files, ODT, RTF, and Pages files show an explicit unavailable message instead of binary characters.

The converted Word document uses the same responsive maximum width and horizontal alignment as the main object-navigation container.

## Source-code previews

Source files use the page scrollbar vertically. When a line exceeds the available width, only the source column scrolls horizontally; the line-number gutter remains fixed. Moving the mouse wheel over that horizontal scroller continues to scroll the page vertically.

## Large JSON previews

JSON and GeoJSON files use the same worksheet-style tab component as spreadsheet previews and expose three modes:

- **Raw** preserves the source bytes, applies safe JSON syntax coloring, and returns at most 256 KiB or 2,000 logical lines per page. Long logical lines wrap visually without changing the underlying text.
- **Beautify** formats and syntax-colors JSON incrementally on the server. The continuation cursor contains only the source byte offset and the small parser state required to resume; the complete document is never materialized.
- **Tree** is parsed on the server with a constant-memory streaming scanner. The root level is expanded by default, nested object and array nodes are fetched only when opened, and each response contains at most 50 children by default. Array nodes display an exact element count when the parser already had to traverse the container; a paged root array displays a growing `N+` count until its last page makes the exact total known.

The Raw, Beautify, and Tree tabs share one control row. Raw and Beautify immediately show the visible line range and current page without scanning the complete object. A separate **Count lines and pages** action performs one explicit sequential streaming pass and then adds exact total lines and pages to the current viewer. The same explicit operation is available from Details. No total-count scan runs while listing or opening the first preview page.

Every page or node expansion issues one explicit range stream for that action and closes it as soon as the requested output is complete. The backend retains only a 64 KiB input buffer, a bounded 256 KiB text page, short scalar previews, and the visible response nodes. It does not cache JSON bytes, indexes, parsed documents, total-count results, or continuation results between requests.

Tree responses include the absolute byte offset of each container. Expanding a nested node therefore starts directly at that node instead of rescanning from the beginning. Standard JSON is sequential, so locating a later sibling still requires scanning past any earlier value in the same container; this scan is streaming and can process an object larger than server RAM.

## PDF previews

PDF.js runs in the browser and requests byte ranges through the existing object endpoint. It renders one page at a time and disables automatic whole-document fetching.

Range chunks are selected from the known object size to balance request count and over-read:

- up to 32 MiB: 256 KiB;
- 32–512 MiB: 1 MiB;
- 512 MiB–4 GiB: 2 MiB;
- above 4 GiB: 4 MiB.

The viewer has no unnecessary top padding and uses the page scrollbar. Its control bar is anchored to a viewport-wide centering rail, so changing the canvas zoom cannot shift the controls horizontally. Very large, non-linearized PDFs can still be slow before page one because PDF.js must read the trailer, xref data, catalog, and page tree required by the document structure.

## Structured data and spreadsheets

CSV, TSV (`.tsv` or `.tab`), PSV, JSON Lines, and NDJSON previews provide per-column filters, typed sorting, and pagination. Fully empty rows and columns are hidden.

CSV, TSV, TAB, and PSV objects larger than 32 MiB use a server-side streaming pager. Only the requested rows and bounded cell previews are returned to the browser; the complete object is not loaded into browser memory. Exact row and column counts are deliberately omitted until the user chooses **Count rows** in the viewer or **Count rows and columns** in Details, because that operation must scan the complete document. Small delimited files continue to use the local interactive viewer.

Source files, Markdown, logs, configuration, and other text documents report their line count after an explicit Details action. Parquet reports its row and top-level-column counts from the footer, while XLSX/XLSM reports worksheet, row, and column counts from the workbook structures.

XLS uses a bounded browser-side SheetJS reader. XLSX and XLSM are parsed server-side from ZIP/XML byte ranges:

- the complete workbook is not sent to the browser;
- worksheet selection, filtering, sorting, and pagination are performed per request;
- 100, 250, 500, or 1,000 rows can be returned per page;
- fully empty rows and columns are hidden;
- hidden worksheets are identified;
- VBA macros are never executed;
- no workbook file or parsed workbook is retained for reuse after the request.

Parquet is parsed on demand in the browser using range requests and pinned browser modules.

Pressing `Ctrl`/`Cmd` + `F` opens application search instead of browser-page search when a supported structured viewer is active:

- text, JSON, CSV, TSV, PSV, JSON Lines, and NDJSON are scanned as request-scoped streams by the backend;
- XLSX/XLSM search is applied to the complete active worksheet by the server-side worksheet reader;
- Parquet search traverses all rows through range reads in the browser and keeps only a bounded match list;
- SQLite search is executed against the complete active table.

Search is intentionally never automatic. Depending on the format and query it may read the complete logical document and therefore incur provider transfer and request costs.

## SQLite previews

SQLite 3 files (`.sqlite`, `.sqlite3`, `.db`, `.db3`, `.s3db`, and `.sl3`) are opened read-only by the embedded pure-Go page and B-tree reader. The viewer lists ordinary non-system tables, uses the same worksheet-style tabs as spreadsheet and JSON modes, pages 100, 250, 500, or 1,000 rows, reports the exact total row count for the active table or filtered result, truncates very large cell values in the response, and never executes SQL supplied by the browser. Switching tables keeps the tabs and search controls visible while a loader covers only the table area. Vertical wheel input over the horizontally scrollable table continues to move the page.

SQLite requires random page access. After an explicit preview action the backend downloads one private temporary working copy and reads the database format directly inside the Go process. The file is deleted when the preview closes or the short session expires. It is not a reusable cache and is never created during listing or Details. The default safety limit is 4 GiB. No `sqlite3` executable, CGO library, or shared object is required. Virtual tables, views that require SQL execution, encrypted databases, and databases whose current state exists only in an external WAL are not evaluated by this read-only structural reader.

## Storage and folder insights

One **Storage insights** action is shown at the storage root, and one **Folder insights** action is shown inside a folder or on a folder row. A single persistent recursive statistics job feeds both tabs of the same dialog:

- **Overview** keeps Objects and Total size on one row, places the elapsed time at the bottom, and shows proportional distributions by stored bytes and object count.
- **Treemap** displays an interactive WinDirStat-style size map. Rectangle area represents stored size; hover shows path, size, and file count; clicking a folder navigates into it and clicking a file opens its preview. Parent title strips are reserved outside their child layout, and labels are measured against the actual rectangle before details are shown, preventing text overlap.

At every displayed folder level, only children representing strictly more than 1% of their parent are shown individually. Smaller children and objects omitted from the bounded largest-object set are combined into a local **Others** rectangle with their exact aggregate size and file count. This can produce a separate **Others** rectangle inside each subfolder. The renderer remains limited to five levels and 1,000 rectangles.

## Background jobs

Large recursive copy, move, delete, and folder-statistics operations run as persistent jobs with checkpoints. States are:

```text
queued
running
paused
completed
failed
canceled
```

Interrupted running jobs resume from their last completed object after process restart. Job state is stored under `data_dir/jobs`. The `server.job_history_limit` setting retains only the newest terminal jobs; queued, running, and paused jobs are never pruned. Long-running task notifications stay in the bottom-right area, update in place, and are replaced by their final result before dismissal.

```text
GET  /api/jobs
GET  /api/jobs/<job-id>
POST /api/jobs/<job-id>/pause
POST /api/jobs/<job-id>/resume
POST /api/jobs/<job-id>/cancel
```

## Large uploads

Uploads below 32 MiB use direct `PUT`. Larger files use S3 multipart or GCS resumable sessions.

The browser measures throughput and adjusts later parts toward an approximately six-second transfer time while respecting provider requirements:

- S3 non-final parts remain at least 5 MiB and the 10,000-part limit is respected;
- GCS chunks remain aligned to 256 KiB;
- transient failures use bounded exponential backoff with jitter.

Upload session state is stored under `data_dir/uploads`. Provider upload IDs and GCS session URLs are not returned to the browser. Pausing keeps the provider session; canceling aborts it. Multiple selected files and dropped folders can upload concurrently.

Chrome or the operating system can display a native security confirmation for a `webkitdirectory` picker. Page code cannot suppress or style that browser-owned dialog. Drag and drop usually avoids opening the directory picker.

## Downloads and ZIP archives

Downloads stream through the browser with progress, throughput, ETA, pause/resume, retry, and cancel controls. Upload and download panels keep transfers with recent byte progress at the top, followed by other running, preparing, queued, paused, failed, completed, and canceled entries. After the application transfer reaches 100%, the completed `Blob` is handed to a real `<a download>` element so the result appears in the browser's Downloads list.

Folder ZIP downloads preserve relative paths and use the same download panel. ZIP creation currently occurs in browser memory, so very large archives can require significant client memory.

## Build and run

### Upgrading an existing source directory

Extract releases into an empty directory whenever possible. Older media-enabled
releases contained `media_sessions.go`, `media_source_cache.go`, and related
process files that are not part of the self-contained runtime. Leaving those
files beside the current sources causes duplicate declarations and references
to the removed media manager.

The current archive includes migration tombstones, a root `.dockerignore`, and
a defensive cleanup step in the Docker builder, so Docker builds are protected
even when the archive is unpacked over an older tree. For a local non-Docker
build, a clean extraction remains the recommended approach.

Go 1.22 or newer is required. Node.js is used only for frontend tests. The runtime has no external command dependency: SQLite parsing, metadata inspection, storage access, jobs, and previews supported by the self-contained profile are implemented in the Go binary or embedded browser assets.

The release binary is built with `CGO_ENABLED=0` and the `netgo` and `osusergo` build tags. It has no ELF interpreter or shared-library dependency and can therefore run as the only executable in a `scratch` container.

The release version, full source commit, short source commit, and build date are injected with linker flags. The global navigation and preview header display `version · short-commit`; the complete values are available from `GET /api/build`, the `build` field of `GET /api/instances`, and the `s3-browser version` command.

```sh
cd src
go test ./...
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build \
  -tags=netgo,osusergo \
  -trimpath \
  -ldflags="-s -w -buildid= -X main.buildVersion=dev -X main.buildCommit=$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  -o s3-browser .
./s3-browser -c /etc/s3-browser/config.hcl
```

### Scratch container

The default final stage in `test/browser/Dockerfile` is `FROM scratch`. It contains only:

- the statically linked `s3-browser` binary;
- the CA certificate bundle required for HTTPS S3 and GCS endpoints;
- minimal numeric user metadata;
- `/data`, `/tmp`, and `/config` directories.

It runs as the numeric non-root user `65532:65532`. `/data` is declared as a volume and should be used as `server.data_dir` when persistent jobs or resumable uploads must survive container replacement.

```sh
docker build -f test/browser/Dockerfile -t s3-browser .
docker run --rm -p 8080:8080 \
  -v "$PWD/config.hcl:/config/config.hcl:ro" \
  -v s3-browser-data:/data \
  s3-browser
```

The scratch image intentionally has no shell, package manager, FFmpeg/FFprobe, ImageMagick, or `sqlite3` executable. The application does not invoke any of them. Core bucket browsing, uploads, downloads, persistent jobs, the embedded SQLite reader, format-aware metadata parsing, and all embedded frontend assets are available directly from the static binary. A RAW image without a browser-readable original or a usable embedded JPEG reports that preview is unavailable instead of starting an external converter.

The release workflow verifies both the static ELF properties and a real health check from the scratch image before GoReleaser publishes Linux AMD64 and ARM64 archives.

Run frontend checks from the repository root:

```sh
node test/frontend-smoke.js
node test/json-viewer.js
node test/transfer-controls.js
node test/stats-viewer.js
node test/sqlite-viewer.js
```

Health check:

```sh
./s3-browser healthcheck -c /etc/s3-browser/config.hcl
# or
./s3-browser healthcheck --url http://127.0.0.1:8080/healthz
```

Preview-related API routes:

```text
GET /api/build
GET /api/delimited
GET /api/document-count
GET /api/spreadsheet
GET /api/json/raw
GET /api/json/beautify
GET /api/json/summary
GET /api/json/tree
GET /api/search
GET /api/stats
GET /api/jobs
GET /api/jobs/<id>
GET /api/media-info
GET /api/image-preview
POST /api/sqlite/sessions
GET  /api/sqlite/sessions/<id>/table
DELETE /api/sqlite/sessions/<id>
```

JSON pages and tree responses, metadata, spreadsheet responses, and generated image-preview responses use `Cache-Control: no-store`. Direct object responses preserve safe provider headers, including the provider's cache policy. The server itself does not retain object content, parsed metadata, workbooks, or generated image previews as a reusable application cache.

## Browser modules

The frontend lazily loads pinned modules only when needed:

- Mammoth for DOCX-family Word documents;
- PDF.js for PDF;
- Mermaid for Markdown diagrams;
- SheetJS for legacy XLS;
- hyparquet and its optional codecs for Parquet.

Deployments without browser Internet access should self-host the pinned files and update the corresponding URLs in `src/public/assets/js`.

## Local Garage integration stack

```sh
cd test
./setup.sh
docker compose up --build -d
./smoke.sh
```

The stack exposes two independent Garage buckets and mounts persistent job/upload state. It always builds the self-contained scratch runtime. Video preview remains disabled. See `test/README.md` for cleanup commands.

## Security

- Put the application behind TLS and an authentication/RBAC proxy.
- Do not commit production HCL, secret value files, or GCS service-account files.
- Mount configuration and secrets read-only with restrictive filesystem permissions.
- Persist `data_dir` privately when jobs or resumable uploads must survive restarts.
- Scope cloud IAM to the required bucket and prefix. `root_prefix` is an application boundary, not a replacement for IAM.
- Never use `insecure_skip_verify` in production.
- Apply CPU, memory, process, and temporary-filesystem limits appropriate for the deployment.
- Object responses filter unsafe headers and apply a sandboxed content security policy for active content.
- A Google service-account private key was exposed during the original project discussion. It must be revoked and replaced; it is not included in this repository.

## Repository layout

```text
.github/   CI and release workflows
src/       Go backend, embedded frontend, and unit tests
test/      Local Garage stack and dependency-free frontend/integration tests
README.md  Runtime and configuration documentation
```
