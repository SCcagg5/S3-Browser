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

## Background jobs

Jobs are memory-only and use two workers. The manager admits no more than four active or queued jobs. Terminal results are retained only up to `job_history_limit`.

Supported job types are limited to operations that can stream with bounded memory:

- prefix copy, move, and delete;
- Insights statistics;
- per-object integrity verification;
- selected archive-entry extraction;
- selected archive-entry integrity verification.

Insights uses a 100 ms synchronous fast path. A fresh completed result can be reused for 30 seconds. Longer work continues in memory and can be paused, resumed, or canceled while the process remains alive.


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

## Frontend path model

Assets and API URLs are relative to `document.baseURI`. A path-stripping reverse proxy can therefore expose the same build at `/`, `/s3-browser/`, or another prefix without an HCL public-path setting or a frontend rebuild.
