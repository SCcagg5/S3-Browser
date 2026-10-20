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

At start, the server probes each instance with a tag read on a key that does not exist. A provider with tags answers "no such key". A provider without tags answers `501` or `405`. The instance then reports `tagsSupported: false` in `/api/instances`. A denied or slow probe does not count as a missing feature. The page hides the tag controls from the first load and sends no tag with an upload. Garage accepts `x-amz-tagging` and drops the tags without a word, so the server refuses an upload with tags for an instance without tags: it answers `501` with `tagging_unsupported`.

An upload can carry tags. A direct upload takes the header `X-Amz-Tagging` (a query string such as `a=b&c=d`). `POST /api/uploads` takes the field `tags`. The server sends them to the provider in `x-amz-tagging`.

In a bucket with versioning, a tag request names the version of the object. The server reads it with a HEAD request. It is `null` for an object made before the versioning. SeaweedFS takes more than 10 seconds to read the tags of such an object when no version is named. A request that has `version` uses it as it is.

`GET /api/lifecycle` gives the lifecycle rules of the bucket in read-only form. A bucket without rules gives an empty list. The details of a file use the rules to tell what happens to the object, also for tags that the person did not save yet.

The listing of the provider does not give tags, and S3 has no request that lists objects by tag. The tag column and the tag filter read the tags of the files on the page. They are in the settings of the listing, behind the gear. They read 4 files at the same time and at most 100. The tag filter hides rows of this page only.

## Versions in the interface

The details of a file have a picker of versions. It shows each version with its number (v1 is the oldest), its date, its size and the change of size since the version before. A choice opens the details of that version. The tags of an older version are read only.

The comparison of two versions runs in the browser, in the preview page and not in a dialog. The address has the parameter `compare` (the older version) and the parameter `version` (the other version). The comparison takes the place of the preview. The browser back button and the button "Back to the preview" show the preview again. The picker of the versions of the preview stays in its place and becomes the version To. The version From appears at its left, and the statistics of the change are between the two. The header gets no new row. A button closes the comparison. The picker of versions, the table of versions and the details open this address. The page reads each version with `GET /s3?key=&version=`. A version larger than 2 MiB is not read. A version with a NUL byte or with a text that is not UTF-8 is not text: the page says so, and offers the comparison of the bytes.

The page picks the view from the extension of the key. The two versions show side by side by default, as on diffchecker.com. Other views are the unified list and the patch of git.

- Text: a diff of lines (Myers), with 3 lines of context. The changed words show in a changed line. A side that has no line shows hatched. A fold hides the unchanged lines, and a click shows them.
- JSON: the modes of the preview. Raw shows the text as stored. Beautify shows the indented text, with an option to sort the keys. Tree shows the paths with their state (added, removed, changed). A branch with a change is open, and a click opens the other branches. The format and the order of the keys are not changes. A version that is not JSON gets the text views.
- CSV, TSV and PSV: two tables side by side, or one table, with the rows that were added, removed or modified and the cells that changed. A removed row and an added row that have the same first cell, or most cells equal, are one modified row.
- Patch: the patch in the unified format of git, with `diff --git`, `index`, `---`, `+++`, the hunks `@@` and the line `\ No newline at end of file`. It applies with `git apply` and `patch -p1`. The buttons copy it or download it as `<name>.patch`.

The last line of a text with no line break is not the same line as the same text with a break, as in git.

The picker of versions is also in the bar of the preview page. It replaces the list of versions there, and the action "Versions" of the menus. The badge with the count in the listing opens the table of the versions, with the restore and the delete.

A diff that needs more than 2500 edits shows as a replacement of the lines. The algorithms are in `assets/js/diff.js`. They have no DOM, and `test/portal-frontend/diff-tests.js` tests them in Node.

## Tags in the listing

A tag badge has a swatch. The colour comes from the key: one of 18 colours, chosen with the hash FNV-1a. This is the way ClickHouse Dash colours a service. A click on a badge filters the page by this tag. A second click clears the filter. Ctrl, Cmd or Shift adds the tag to the other words of the filter. A row shows three badges and a count for the other tags.

## Background jobs

Jobs are memory-only and use two workers. The manager admits no more than four active or queued jobs. Terminal results are retained only up to `job_history_limit`.

Supported job types are limited to operations that can stream with bounded memory:

- prefix copy, move, and delete;
- copy or move of one object in parts (`copy_object`, `move_object`);
- Insights statistics;
- per-object integrity verification;
- selected archive-entry extraction;
- selected archive-entry integrity verification;
- abort of the incomplete multipart uploads older than a number of days (`abort_multiparts`).

Insights uses a 100 ms synchronous fast path. A fresh completed result can be reused for 30 seconds. Longer work continues in memory and can be paused, resumed, or canceled while the process remains alive.

A job that deletes a prefix deletes the objects in batches of 1000 keys. It uses `DeleteObjects` of S3. The same applies to the deletion of the sources in a move of a prefix. The job counts a batch only after the provider deleted it. After a pause or a stop, the job continues after the last deleted key.

A provider that refuses `DeleteObjects` with `501` or `405` gets one request for each key. The server remembers this refusal. A key with a character that XML cannot carry always gets its own request. The GCS provider has no batch delete.

## Copy in parts

`CopyObject` of S3 refuses a source above 5 GiB. Thus a copy, a move, a rename and the restore of a version use a copy in parts from a threshold up. The threshold is 5 GiB minus 256 MiB. The engine is in the S3 backend (`src/s3_copy.go`), behind the optional interface `ObjectMultipartCopier`. The GCS backend does not have it: its copy has no such limit.

The engine does these steps:

1. It reads the source with `HEAD`, with `versionId` when the copy names a version. It gets the size, the ETag and the headers.
2. It reads the tags of the source. A source with `x-amz-tagging-count: 0` needs no request. A provider without tags (`501` or `405`) gives no tag.
3. It sends `CreateMultipartUpload` with `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Expires`, the `x-amz-meta-*` headers and `x-amz-tagging`.
4. It sends one `UploadPartCopy` for each part of 256 MiB, with `x-amz-copy-source-range`. Four parts go at the same time. Above 10000 parts, the parts become larger.
5. It sends `CompleteMultipartUpload`.

Each part has `x-amz-copy-source-if-match` with the ETag of the source. A source that changes during the copy makes the copy fail. On an error or a cancel, the engine sends `AbortMultipartUpload`. The abort has its own time limit of 30 seconds, because the context of the copy can be canceled. No byte of the object goes through S3-Browser.

Each request of the engine takes a slot of the concurrency gates of the bucket. Thus the limits `max_concurrent_requests_per_storage` and `max_concurrent_storage_requests` apply. A request of the engine waits for its slot with no time limit.

The engine has an options structure: the source version, new metadata, new tags, other headers of `CreateMultipartUpload`, the ETag that the caller read, and a progress function. When the options give an ETag, a source with another ETag stops the copy with `412` before the upload starts. The metadata edit uses the same engine with new metadata.

`POST /api/copy` and `POST /api/rename` of one object first read its size with `HEAD`. Under the threshold, the copy stays one synchronous `CopyObject` request, and the answer is `200`. From the threshold up, the answer is `202` with a job `copy_object` or `move_object`. The job has `totalBytes`, the size of the source, and `copiedBytes`, which grows after each copied part. A move deletes the source after the copy. A pause or a cancel aborts the multipart upload. A resume starts the copy again from the first part. The jobs of one object use the background request budget (`max_background_storage_requests`).

A prefix copy and a prefix move use the size of each object in the listing. An object from the threshold up goes in parts. The job counts `copiedBytes`, with the parts of the object in progress.

The restore of a version from the threshold up uses the engine with the version as the source. It is a synchronous request, as before.

The threshold and the part size are unexported variables. Go tests set them. The test image sets them at build with `-ldflags -X main.multipartCopyThresholdBuild=<bytes> -X main.multipartCopyPartSizeBuild=<bytes>` (Docker build arguments `MULTIPART_COPY_THRESHOLD` and `MULTIPART_COPY_PART_SIZE` of `test/browser/Dockerfile`). These are not configuration keys. A release build leaves them empty. A value that is not an integer in its range stops the program at start. The log shows each value that the build changed.

## Edit of the metadata

`GET /api/metadata?key=&version=` gives the stored metadata of an object, or of one version: the standard headers `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Expires`, and the user metadata (`x-amz-meta-*`). The server reads them with a HEAD request to the provider. The gateway `/s3` puts `private, no-store` in front of the `Cache-Control` of the provider, so the page does not read the values from the gateway. The answer also has `etag`, `lastModified`, `version`, `size`, `multipartETag` (the ETag has the form `<digest>-<parts>`), `copyInParts` (the save copies the object in parts) and `maxMetadataBytes`.

`PUT /api/metadata` replaces the metadata. The body has `key`, `version` (optional), `etag` and `lastModified` (the values that the form read), `headers` and `metadata` (a list of `key` and `value`). The body gives the complete state: a header or a user metadata that the body does not give is removed. The answer is the new state of the current object. The server checks each value before it sends a request:

- The six headers are a closed set. An unknown field in `headers` or in the body gives `400 invalid_json`.
- Each value has 1 to 1024 printable ASCII characters, with no space at the start or the end. `Content-Type` is a media type, `Content-Disposition` is `inline` or `attachment` with parameters, `Content-Encoding` and `Content-Language` are lists of tokens, `Cache-Control` is a list of directives, `Expires` is an HTTP date in GMT.
- A user metadata key has lowercase letters, digits, `.`, `_` and `-`, and starts with a letter or a digit. Each key is unique. A value has printable ASCII characters and is not empty. The keys and the values have 2048 bytes at most in total, as in S3.

A wrong value gives `400 invalid_metadata` with the name of the field. The server then does these steps:

1. It reads the object (or the version) with HEAD. An ETag or a modification date that is not the value of the form gives `412 object_changed`. SeaweedFS, MinIO and Garage keep the ETag when only the metadata changes, so the date is necessary.
2. Under the threshold of the copy in parts, it sends `CopyObject` onto the same key with `x-amz-metadata-directive: REPLACE`, `x-amz-tagging-directive: COPY` and `x-amz-copy-source-if-match` with the ETag of the form. A provider answer `412` also gives `412 object_changed`.
3. From the threshold up, it uses the engine of the copy in parts, with the new metadata at `CreateMultipartUpload`, the tags of the source and the ETag of the form.

The copy also sends the storage class, the website redirect and the server-side encryption of the source again, when the HEAD answer has them. Else AWS would change them. An object with an encryption key of the customer (SSE-C) gives `400`: S3-Browser does not have the key.

A request with `version` copies that version onto the key. The version becomes the current version, as a restore does. The tags of that version stay.

The action is `objects.write` on the node of the key (refer to [ACCESS.md](ACCESS.md)). No new right exists.

At start, the server probes each instance that has the write permission: a copy with REPLACE of an object that does not exist, with an ETag that no object has. A provider with `CopyObject` answers "no such key" and writes nothing. A provider without it answers `501` or `405`, and the instance then reports `metadataEditSupported: false` in `/api/instances`. A later `501` of an edit has the same effect. The GCS backend has no edit: it answers `501 metadata_unsupported`, and the page hides the button.

The details of a file have the section "Metadata" with the stored values and a frameless "Edit" button. The form is in the same window, with Save and Revert, as the tags section. Before the save, the form tells what changes. The browser tests check each sentence on each provider of the test stack:

| Sentence of the form | When | SeaweedFS 4.41 | MinIO 2025-10-15 | Garage v2.4.1 |
| --- | --- | --- | --- | --- |
| The modification date changes. | Always | Yes | Yes | Yes |
| A new version is created. | Versioning is on | Yes | Yes | No versioning: the sentence is not shown |
| This version becomes the current version. | The form shows an older version | Yes | Yes | No versioning |
| The ETag changes: S3-Browser copies an object of this size in parts. | `copyInParts` | Yes (`<digest>-<parts>`) | Yes | Yes |
| The ETag can change: the object was uploaded in parts. | `multipartETag`, under the threshold | No: the ETag stays | Yes: the ETag becomes the MD5 of the object | No: the ETag stays |
| (No sentence) | One part, under the threshold | The ETag stays | The ETag stays | The ETag stays |

In the test stack, each multipart object is above the threshold of 8 KiB, so the page copies it in parts. The row of a multipart object under the threshold comes from S3 requests to the three providers (the table of [test/README.md](../test/README.md)).

On all three providers, the tags stay. A copy with REPLACE and no `Content-Type` gives `binary/octet-stream` on SeaweedFS and MinIO, and no `Content-Type` on Garage. `x-amz-copy-source-if-match` with another ETag gives `412` on all three. For a copy of an older version, the three compare it with the ETag of that version.

## Cleanup of incomplete multipart uploads

An incomplete multipart upload keeps its parts on the provider until a person completes it or aborts it. The parts use storage, but no listing shows them. The code is in `src/multiparts.go`, behind the optional interface `MultipartUploadLister` of the S3 backend.

`GET /api/multiparts?prefix=&max=&token=` gives the incomplete uploads under `prefix`. The answer has `uploads`, `nextToken`, `now` (the clock of the server), `minimumAbortAgeHours` and `partsPageSize`. Each upload has `key`, `uploadId`, `initiated`, `parts`, `bytes`, `partsAtLeast`, `partsUnknown` and `active`. `max` is from 1 to 500, and the default is 100. Another value gives `400 invalid_multipart_request`.

The server reads the list with these rules:

- It sends `ListMultipartUploads` with no prefix. MinIO gives an empty list for a prefix that is not a full key. The server keeps the uploads under the root prefix of the instance and under `prefix`.
- It sends the next request with the markers that the provider sent, as the provider sent them. SeaweedFS sends only `NextUploadIdMarker`. Garage and AWS send `NextKeyMarker` and `NextUploadIdMarker`. MinIO ignores `max-uploads` and sends all the uploads in one page.
- `nextToken` has the markers and a position in the page. Thus the next answer can start in the middle of a page that has more uploads than the request asked for.
- One answer reads 10 pages of the provider at most. A provider that sends the same markers again gives `502 provider_paging`, not a loop.
- For each upload, the server sends one `ListParts` with `max-parts=1000`, four at the same time. An upload with more parts gets `partsAtLeast: true`: the count and the size are those of the first 1000 parts. An upload that the provider no longer knows (`404 NoSuchUpload`) is not in the answer.

`initiated` is the `Initiated` date of the provider. SeaweedFS gives no date. The page then shows "unknown" for the start and the age.

`POST /api/multiparts/abort` has two forms. The body gives one of them. Both forms, or none, give `400 invalid_multipart_request`.

- `uploads`, a list of 1 to 1000 `key` and `uploadId`, aborts each upload at any age. The page asks for a confirmation first. The answer is `200` with `aborted`, `skipped` and `failed`. An upload that the provider no longer knows counts as aborted.
- `olderThanDays` (1 to 36500) and `prefix` start the job `abort_multiparts`. The answer is `202` with the job. The job reads the whole list and aborts each upload under `prefix` that started before the cutoff. The cutoff is the time of the request minus `olderThanDays` days. A resumed job uses the same cutoff.

The job counts `aborted`, `skippedUndated`, `skippedRecent`, `skippedActive` and `failed` in `multipartAbort`. These safety rules apply:

- The job never aborts an upload without a start date. The provider does not let S3-Browser know its age.
- The job never aborts an upload younger than 24 hours, also when the cutoff is later.
- No request aborts an upload that the resumable-upload store of this process sends now (status `uploading`, `src/uploads.go`). The list shows such an upload with `active: true`.

`GET /api/multiparts` needs `objects.read` on the node of `prefix`. An abort needs `objects.write`: on the node of each key, or on the node of `prefix` for the job. The job also needs `objects.read`. Refer to [ACCESS.md](ACCESS.md).

At start, the server sends `ListMultipartUploads` with `max-uploads=1` to each instance that has the read permission. A provider that answers `501` or `405` gets `multipartUploadsSupported: false` in `/api/instances`, and the page hides the item. The GCS backend has no list: it answers `501 multipart_unsupported`.

The item "Incomplete uploads" of the Actions menu opens a large window for the current folder, or for the bucket at the root. The window has a table with the key, the start, the parts, the size and the age of each upload. It has a checkbox and a frameless abort button in each row, "Abort selected", and "Abort everything older than N days" (N is 1 by default). The window tells how many uploads have no start date. A person without the write permission sees the list with no abort control. A note tells that a lifecycle rule can abort the incomplete uploads.

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
- `assets/js/app.js` is the browser page. `uploads.js` is the bulk upload. `tags.js` and `metadata.js` are the sections of the details that edit the tags and the metadata. `theme.js` applies the theme before the first paint. `session.js` gives one message for an ended sign-in (401) or a server that does not answer.
- `assets/css/dialogs.css` and `assets/css/viewers.css` have the rules of the default tree for the dialogs and the previews. Each colour is a token of `portal.css`, so these rules follow the theme.
- `assets/icons/tabler/` has one Tabler icon (MIT) for each name. `assets/css/icons.css` gives the icon for each `mdi-*` name of the shared scripts.

The tree does not contain `assets/vendor/`: a small overlay file system (`src/frontend.go`) gives that directory from the default tree, so the binary contains the vendored libraries one time. No other file of the default tree is visible through the overlay.

The two trees have different fingerprints, because the fingerprint covers all the files of the selected tree. The server also adds the fingerprint to each `@import` of a stylesheet.

## Frontend path model

Assets and API URLs are relative to `document.baseURI`. A path-stripping reverse proxy can therefore expose the same build at `/`, `/s3-browser/`, or another prefix without an HCL public-path setting or a frontend rebuild.
