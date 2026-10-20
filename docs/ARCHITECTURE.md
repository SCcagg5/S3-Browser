# Architecture

## Runtime shape

The application is one static Go binary with embedded frontend assets. It does not execute helper processes, require CGO, or write application state to disk.

The runtime can be placed in a scratch container with a read-only root filesystem. Only the HCL file and any credential files need to be mounted read-only.

## Configuration and shared provider clients

HCL defines reusable authentication objects and bucket views. Buckets referencing the same authentication share provider credentials, token refresh state, HTTP transport, and connection pool. Each bucket independently defines:

- provider bucket name;
- display name;
- virtual root prefix;
- permission ceiling;
- navigation scan limit;
- learned capability state.

## Storage interfaces

The backend separates listing, object reads, ranged reads, writes, deletion, copy/rewrite, multipart upload, and version operations. Read-only preview code receives only the operations it needs.

All provider traffic passes through:

- a global concurrency gate;
- a per-bucket concurrency gate;
- a request counter;
- a transferred-byte counter;
- request cancellation;
- strict response validation.

Provider redirects and environment-derived proxies are disabled.

## Stateless state model

The server has no local database, cache directory, checkpoint directory, or temporary-file contract.

Process memory contains only bounded live state:

- at most four active or queued background jobs;
- a small terminal-job history;
- current upload sessions;
- current preview sessions;
- short-lived range caches;
- process-local permission observations;
- short-lived Insights results.

A process restart discards all of this state. No hidden object is written to a connected bucket to replace local state.

## Upload resume protocol

A resumable upload creates a provider-side S3 multipart upload or GCS resumable session. The server returns an opaque `s3br1` token containing the encrypted and authenticated provider coordinates, target object, size, media type, chunk size, and expiry.

The token key is derived from the configured provider credential material when available. This allows another process with the same HCL credentials to open the token without a server-side record. The server then reconciles the actual provider state:

- S3: lists uploaded parts and validates contiguous part numbers and sizes;
- GCS: queries the resumable-session offset.

The process tracks at most four active upload sessions. Completed and canceled sessions are removed from process memory. Cancel also aborts the provider session when supported.

The browser currently keeps active tokens in page memory. An API client may retain the opaque token outside the server and submit it to `/api/uploads/resume` after a server restart.

## Upload checksums

An S3 upload can carry a SHA-256 checksum. The GCS provider does not use it.

The browser computes the SHA-256 digest of each chunk with `crypto.subtle`. A page that is not secure has no `crypto.subtle`. A page is secure with HTTPS or on `localhost`. Such a page sends no checksum.

The request `POST /api/uploads` has the field `checksum`. The value is `""` or `"sha256"`. The answer shows the value that the server accepts. With `sha256`, the server starts the multipart upload with `x-amz-checksum-algorithm: SHA256`.

Each chunk of such an upload needs the header `X-Checksum-Sha256`. The value is the base64 digest of the chunk. A chunk without this header gets `400 checksum_required`. A value that is not a 32-byte digest gets `400 invalid_checksum`.

The server sends the digest to the provider in `x-amz-checksum-sha256`. The provider refuses a part with other bytes. At the end, the server sends the digest of each part in `CompleteMultipartUpload`.

The answer has the field `checksumVerified`. It is `true` when the provider returned the digest of each part. The server also reads the checksum of the object. This checksum is the SHA-256 of the part digests. S3 writes it as `<digest>-<number of parts>`. Garage writes the digest only. A different value makes the upload fail.

A direct upload (`PUT /s3`) accepts the same header. The browser uses it for a file under 32 MiB. The answer has `X-Checksum-Sha256-Verified: true` when the provider returned the same digest. A provider that does not store checksums gives no confirmation. The upload still succeeds.

The resume token keeps the algorithm. After a restart, the server reads the digest of each part from the list of parts of the provider.

## Object tags and lifecycle

Only the S3 provider has object tags. A provider that does not know them answers `501`. The server turns this answer into the error `tagging_unsupported`. The interface then hides the tag controls. Garage does not support tags. SeaweedFS does.

`GET /api/tags?key=` gives the tags of an object. `PUT /api/tags` replaces the whole set. An empty set removes all tags. The server checks the limits of S3 before it sends the request. An object has at most 10 tags. A key has 1 to 128 characters and does not start with `aws:`. A value has at most 256 characters. A tag has letters, digits, spaces and `+ - = . _ : / @` only.

`POST /api/tags/bulk` starts the job `tag_prefix`. The body has `prefix`, `add` (tags to set) and `remove` (keys to remove). The job reads the tags of each object under the prefix. It writes them again only when the result is different. An object that would have more than 10 tags stops the job with its key in the message.

An upload can carry tags. A direct upload takes the header `X-Amz-Tagging` (a query string such as `a=b&c=d`). `POST /api/uploads` takes the field `tags`. The server sends them to the provider in `x-amz-tagging`.

In a bucket with versioning, a tag request names the version of the object. The server reads it with a HEAD request. It is `null` for an object made before the versioning. SeaweedFS takes more than 10 seconds to read the tags of such an object when no version is named. A request that has `version` uses it as it is.

`GET /api/lifecycle` gives the lifecycle rules of the bucket in read-only form. A bucket without rules gives an empty list. The details of a file use the rules to tell what happens to the object, also for tags that the person did not save yet.

The listing of the provider does not give tags, and S3 has no request that lists objects by tag. The tag column and the tag filter read the tags of the files on the page. They are in the settings of the listing, behind the gear. They read 4 files at the same time and at most 100. The tag filter hides rows of this page only.

## Versions in the interface

The details of a file have a picker of versions. It shows each version with its number (v1 is the oldest), its date, its size and the change of size since the version before. A choice opens the details of that version. The tags of an older version are read only.

The comparison of two versions runs in the browser, in the preview page and not in a dialog. The address has the parameter `compare` (the older version) and the parameter `version` (the other version). The comparison takes the place of the preview. The browser back button and the button "Back to the preview" show the preview again. The picker of versions, the table of versions and the details open this address. The page reads each version with `GET /s3?key=&version=`. A version larger than 2 MiB is not read. A version with a NUL byte or with a text that is not UTF-8 is not text: the page says so, and offers the comparison of the bytes.

The page picks the view from the extension of the key. The two versions show side by side by default, as on diffchecker.com. Other views are the unified list and the patch of git.

- Text: a diff of lines (Myers), with 3 lines of context. The changed words show in a changed line. A side that has no line shows hatched. A fold hides the unchanged lines, and a click shows them.
- JSON: the same views on a text with sorted keys (an option), and the list of the paths that were added, removed or changed. The format and the order of the keys are not changes. A version that is not JSON gets the text views.
- CSV, TSV and PSV: two tables side by side, or one table, with the rows that were added, removed or modified and the cells that changed. A removed row and an added row that have the same first cell, or most cells equal, are one modified row.
- Git patch: the patch in the unified format of git, with `diff --git`, `index`, `---`, `+++`, the hunks `@@` and the line `\ No newline at end of file`. It applies with `git apply` and `patch -p1`. The buttons copy it or download it as `<name>.patch`.

The last line of a text with no line break is not the same line as the same text with a break, as in git.

The picker of versions is also in the bar of the preview page. It replaces the list of versions there, and the action "Versions" of the menus. The badge with the count in the listing opens the table of the versions, with the restore and the delete.

A diff that needs more than 2500 edits shows as a replacement of the lines. The algorithms are in `assets/js/diff.js`. They have no DOM, and `test/portal-frontend/diff-tests.js` tests them in Node.

## Tags in the listing

A tag badge has a swatch. The colour comes from the key: one of 18 colours, chosen with the hash FNV-1a. This is the way ClickHouse Dash colours a service. A click on a badge filters the page by this tag. A second click clears the filter. Ctrl, Cmd or Shift adds the tag to the other words of the filter. A row shows three badges and a count for the other tags.

## Background jobs

Jobs are memory-only and use two workers. The manager admits no more than four active or queued jobs. Terminal results are retained only up to `job_history_limit`.

Supported job types are limited to operations that can stream with bounded memory:

- prefix copy, move, and delete;
- Insights statistics;
- per-object integrity verification;
- selected archive-entry extraction;
- selected archive-entry integrity verification.

Insights uses a 100 ms synchronous fast path. A fresh completed result can be reused for 30 seconds. Longer work continues in memory and can be paused, resumed, or canceled while the process remains alive.

A job that deletes a prefix deletes the objects in batches of 1000 keys. It uses `DeleteObjects` of S3. The same applies to the deletion of the sources in a move of a prefix. The job counts a batch only after the provider deleted it. After a pause or a stop, the job continues after the last deleted key.

A provider that refuses `DeleteObjects` with `501` or `405` gets one request for each key. The server remembers this refusal. A key with a character that XML cannot carry always gets its own request. The GCS provider has no batch delete.

## Insights treemap normalization

The statistics worker builds the semantic treemap on the backend after the complete Insights scan finishes. The backend:

- calculates the exact global one-percent byte threshold using integer arithmetic;
- groups sub-threshold direct children into exact `Others` aggregates;
- preserves exact bytes and object counts for every emitted node;
- contracts folder chains that contain only one child and therefore introduce no real branch;
- removes a sole `Others` child because the parent already represents the same exact scope;
- returns an immutable `treemap` tree plus `treemapThresholdBytes`.

The browser performs only geometric squarified layout, label fitting, focus feedback, and navigation. It does not reconstruct folders, regroup data, or decide which single-child nodes to remove.

## Version capability and version access

At startup, each bucket performs one bounded version-list probe. A successful provider response enables version controls. HTTP 501, access denial, timeout, malformed response, or any other error disables them for that bucket without failing application startup.

When available:

- `/api/versions` pages exact versions or generations of one key;
- `/api/version-counts` counts exact non-delete-marker versions for visible keys;
- object, metadata, preview, inspection, and integrity endpoints accept an exact version identifier;
- restore and permanent exact-version deletion call the provider implementation.

The frontend never offers version controls for a bucket that failed the probe.

## Browser-only version comparison

Comparison is deliberately limited to two immutable versions returned for the same object key. The browser obtains exact version sizes, reads both versions through strict 2 MiB Range requests, compares blocks, and stops at the first differing byte.

The backend has no generic comparison route and does not retain comparison state or content.

## Large-object readers

Range-aware readers use exact start and end offsets, validate HTTP 206 and `Content-Range`, bind sessions to ETag/generation when available, and reject expanded or full-object responses.

Caches are byte-bounded LRU structures. Parsers read format indexes, headers, trailers, central directories, and directly referenced members rather than accumulating complete objects.

Complete-object work is allowed only after an explicit action such as per-object integrity verification. It streams through small fixed buffers under background byte/request budgets.

## Archive extraction

ZIP-compatible archives use their central directory. A selected member is read from its exact compressed ranges, decompressed as a stream, and written directly to the explicit destination object.

The server never writes a temporary archive or member to disk. Unsafe paths, symbolic links, encrypted members, collisions, oversized expansion, and existing destinations are rejected. An interrupted provider upload is aborted where the provider API allows it.

## Frontend trees

The binary embeds two frontend trees. The HCL key `server.frontend` selects one tree at start (see [Configuration](CONFIGURATION.md#frontend-selection)). The server then gives only the files of that tree.

- `default` is `src/public/`.
- `portal` is `src/frontends/portal/`. It is a test of the s3-browser interface: the header of ClickHouse Dash, the bucket selector of the default interface, the parts of the portal and the dense tables of ClickHouse Dash. The top of `assets/css/portal.css` gives the design rules as tokens.

The `portal` tree contains its own pages and scripts:

- `assets/js/common/` has copies of the shared scripts of the default tree (API, previews, dialogs). `preview.js` is a copy with the header of the portal.
- `assets/js/app.js` is the browser page. `uploads.js` is the bulk upload. `theme.js` applies the theme before the first paint. `session.js` gives one message for an ended sign-in (401) or a server that does not answer.
- `assets/css/dialogs.css` and `assets/css/viewers.css` have the rules of the default tree for the dialogs and the previews. Each colour is a token of `portal.css`, so these rules follow the theme.
- `assets/icons/tabler/` has one Tabler icon (MIT) for each name. `assets/css/icons.css` gives the icon for each `mdi-*` name of the shared scripts.

The tree does not contain `assets/vendor/`: a small overlay file system (`src/frontend.go`) gives that directory from the default tree, so the binary contains the vendored libraries one time. No other file of the default tree is visible through the overlay.

The two trees have different fingerprints, because the fingerprint covers all the files of the selected tree. The server also adds the fingerprint to each `@import` of a stylesheet.

## Frontend path model

Assets and API URLs are relative to `document.baseURI`. A path-stripping reverse proxy can therefore expose the same build at `/`, `/s3-browser/`, or another prefix without an HCL public-path setting or a frontend rebuild.
