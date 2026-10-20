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

`GET /api/lifecycle` gives the lifecycle rules of the bucket in `rules`. A bucket without rules gives an empty list. The details of a file use the rules to tell what happens to the object, also for tags that the person did not save yet. The answer also has the state of the editor of the rules. Refer to [Edit of the lifecycle rules](#edit-of-the-lifecycle-rules).

The listing of the provider does not give tags, and S3 has no request that lists objects by tag. The tag column and the tag filter read the tags of the files on the page. They are in the settings of the listing, behind the gear. They read 4 files at the same time and at most 100. The tag filter hides rows of this page only.

## Versions in the interface

The details of a file have a picker of versions. It shows each version with its number (v1 is the oldest), its date, its size and the change of size since the version before. A choice opens the details of that version. The tags of an older version are read only.

Each row of the picker also has frameless icon buttons: Download, Restore and Delete. They show on hover and on keyboard focus. Restore is not on the current version and needs the write permission. Delete needs the delete permission. Restore and Delete open a confirmation first, and call `POST /api/versions/restore` or `DELETE /api/versions`. A delete that a lock refuses shows the message of `409 object_locked`. After a restore or a delete, the details open again, the preview page reads the versions and the preview again, and the listing reads its folder again.

A row of the picker is a `div` with the role `option`. It has a button for the choice and the action buttons. Up and Down go from row to row. Left and Right go from the choice to the action buttons of the row. Tab goes through every button of the menu, and Escape closes it. The pickers From and To of a comparison have no action buttons.

The picker does not list the delete markers. When the current version of an object is a delete marker, the listing does not show the object, so the page cannot open its versions. This is an old limit.

The comparison of two versions runs in the browser, in the preview page and not in a dialog. The address has the parameter `compare` (the older version) and the parameter `version` (the other version). The comparison takes the place of the preview. The browser back button and the button "Back to the preview" show the preview again. The picker of the versions of the preview stays in its place and becomes the version To. The version From appears at its left, and the statistics of the change are between the two. The header gets no new row. A button closes the comparison. The picker of versions opens this address. The page reads each version with `GET /s3?key=&version=`. A version larger than 2 MiB is not read. A version with a NUL byte or with a text that is not UTF-8 is not text: the page says so, and offers the comparison of the bytes.

The page picks the view from the extension of the key. The two versions show side by side by default, as on diffchecker.com. Other views are the unified list and the patch of git.

- Text: a diff of lines (Myers), with 3 lines of context. The changed words show in a changed line. A side that has no line shows hatched. A fold hides the unchanged lines, and a click shows them.
- JSON: the modes of the preview. Raw shows the text as stored. Beautify shows the indented text, with an option to sort the keys. Tree shows the paths with their state (added, removed, changed). A branch with a change is open, and a click opens the other branches. The format and the order of the keys are not changes. A version that is not JSON gets the text views.
- CSV, TSV and PSV: two tables side by side, or one table, with the rows that were added, removed or modified and the cells that changed. A removed row and an added row that have the same first cell, or most cells equal, are one modified row.
- Patch: the patch in the unified format of git, with `diff --git`, `index`, `---`, `+++`, the hunks `@@` and the line `\ No newline at end of file`. It applies with `git apply` and `patch -p1`. The buttons copy it or download it as `<name>.patch`.

The last line of a text with no line break is not the same line as the same text with a break, as in git.

The picker of versions is also in the bar of the preview page, with the same actions. It replaces the list of versions there, and the action "Versions" of the menus. The badge with the count in the listing opens the details of the file, with the picker. The page has no table of the versions.

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

A key that an active Object Lock keeps does not stop a delete job or a move job. The job counts it in `locked`, keeps the first 20 keys in `lockedKeys`, and continues. Such a key is not in `processed` for a delete. The source of a move stays, and its copy exists. Refer to [Object Lock](#object-lock).

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

The item "Incomplete uploads" of the Actions menu opens a large window for the current folder, or for the bucket at the root. The window has a table with the key, the start, the parts, the size and the age of each upload. It has a checkbox and a frameless abort button in each row, "Abort selected", and "Abort everything older than N days" (N is 1 by default). The window tells how many uploads have no start date. A person without the write permission sees the list with no abort control. A note tells that a lifecycle rule can abort the incomplete uploads. Its button opens the window of the lifecycle rules. Refer to [Edit of the lifecycle rules](#edit-of-the-lifecycle-rules).

## Edit of the lifecycle rules

`PutBucketLifecycleConfiguration` replaces the whole configuration of a bucket. The providers do not keep the same settings, and some drop a setting without an error. The code is in `src/lifecycle.go`, behind the optional interface `BucketLifecycleWriter` of the S3 backend. The GCS backend has no lifecycle rules: it answers `501 lifecycle_unsupported`.

### The state of the editor

`GET /api/lifecycle` gives `editor` next to `rules`. `editor` has these fields:

- `hash`: the SHA-256 of the configuration as the provider sent it, and of the indexes of the editable rules. A rule that becomes "kept as is" thus also changes the hash.
- `entries`: one entry for each rule, in the order of `rules`. An editable entry has `rule`. Each other entry has `xml` (the bytes of the rule) and `reason`.
- `fields` and `hidden`: the fields that the editor offers, and the reason for each other field.
- `provider`, `providerNote`, `versioning`, `rootPrefix`, `writable`, `readOnlyReason`, `maxDays` (36500) and `maxRules` (1000).

A rule is editable when it has an ID and only these elements:

- `Status`;
- a `Filter` with a `Prefix`, one `Tag`, or an `And` with a `Prefix` and one `Tag`;
- an `Expiration` with `Days`, or with `ExpiredObjectDeleteMarker`;
- a `NoncurrentVersionExpiration` with `NoncurrentDays`, and an `AbortIncompleteMultipartUpload`.

Each field of the rule must also be offered for the instance. For an instance with a root prefix, the prefix of the rule must start with the root prefix. The editor shows the prefix after the root prefix, and the server adds the root prefix again. Thus a new rule of such an instance never applies to the whole bucket.

The editor keeps each other rule as is: a transition, an expiration on a date, a size filter, a filter with two tags or more, the old `Prefix` element outside of `Filter`, `NewerNoncurrentVersions`, or an XML attribute. It also keeps a text with spaces at the start or at the end, a tag key with `=` or `,`, and a tag value with `,`: the form cannot show them exactly. The window shows such a rule as a read-only row with the note "Kept as is", the reason and its XML. For an instance with a root prefix, a rule outside of the root prefix shows no XML and no filter: it belongs to another part of the bucket.

### The save

`PUT /api/lifecycle` has `instance`, `hash` and `rules`, the complete list of the editable rules. Each rule has `id`, `enabled`, `prefix`, `tag`, `expirationDays`, `noncurrentDays`, `abortMultipartDays` and `expiredDeleteMarker`. A zero number of days means "no such action". The server does these steps under a lock of the instance:

1. It reads the configuration again and compares its hash with `hash`. A different hash gives `409 lifecycle_changed`. The page then offers "Reload the rules".
2. It checks the rules. A refusal gives `400 invalid_lifecycle`, or `400 lifecycle_field_unsupported` for a field that the editor does not offer.
3. It writes the document: the start tag of the root as the provider sent it, the editable rules, then each other element of the root with its bytes. An editable rule that the save does not change also keeps its bytes.
4. It reads the configuration again and compares each rule with the rule that it sent.

The checks of step 2 are the limits of S3 and of AWS:

- A bucket has 1000 rules at most. An ID has 1 to 255 characters, and no other rule has the same ID. MinIO refuses two rules with one ID.
- A number of days is from 1 to 36500. A rule has one action or more.
- A rule cannot have `Days` and `ExpiredObjectDeleteMarker` in one `Expiration`.
- A rule with a tag filter cannot abort incomplete uploads or remove delete markers. AWS refuses these rules.
- A tag follows the rules of the object tags.

MinIO and Garage refuse a configuration without a rule. When no element stays, the server sends `DeleteBucketLifecycle` in place of the write.

The comparison of step 4 ignores the spaces, the namespaces and the order of the children: MinIO changes the order in `And`. A rule without an ID matches a rule with the same content, because MinIO gives an ID to such a rule. For each difference, the answer has a sentence in `warnings`, for example "The storage provider dropped the tag filter retention=30d of the rule "logs". The rule now applies to every object under logs/". The server restores nothing. The page shows the sentences and the rules as the provider keeps them. Then this process does not offer the dropped field again for the instance.

A refusal of the write by the provider gives these answers:

- `403` gives `403 lifecycle_write_denied`. `501` or `405` gives `501 lifecycle_write_unsupported`. The editor of the instance is then read only, with the reason, until a later write works.
- Another `4xx` gives `400 lifecycle_refused`. The rules of the bucket do not change.

When the read of step 4 fails, the answer is `200` with a sentence in `warnings` and no `editor`: the rules are saved, and the page reads them again.

S3 has no condition on `PutBucketLifecycleConfiguration`. The lock and the hash stop a save over a change of another window of this process, or over a change before the save. A change by another S3 client between the check and the write is lost.

### The fields of each provider

S3-Browser never writes to a bucket to find what the provider keeps. It uses a table for each provider that it knows. The facts come from requests to the providers of the test stack (refer to `test/README.md`) and from the documentation of AWS S3.

At start, the server reads the configuration of each instance with the read permission. A provider that answers `501` or `405` gets `lifecycleSupported: false` in `/api/instances`, and the page hides the item. The server also sends one `GetObject` for the key `.s3-browser-provider-probe` under the root prefix. The object does not exist. The answer tells the provider:

- An endpoint under `amazonaws.com`, or the header `Server: AmazonS3`, is AWS S3.
- `Server: MinIO` is MinIO. `Server: SeaweedFS <size> <version>` is SeaweedFS.
- Garage v2.4.1 sends no `Server` header and no request id. Its error document has a `Region` element and no `RequestId` element.
- Any other answer is a provider that S3-Browser does not know.

| Field | AWS S3 | SeaweedFS | MinIO | Garage | Provider that S3-Browser does not know |
| --- | --- | --- | --- | --- | --- |
| Expiration after N days, with a prefix | Yes | Yes | Yes | Yes | Yes |
| Tag filter | Yes | Yes | Yes | No: dropped, and the rule applies to every object under the prefix | Only when a rule of the bucket has one |
| Expiration of noncurrent versions | Yes | Yes | Yes | No: dropped | Only when a rule of the bucket has one |
| Abort of incomplete multipart uploads | Yes | Yes | No: `400` in a rule with this action only, dropped in a rule with another action | Yes | Only when a rule of the bucket has one |
| Removal of expired delete markers | Yes | Yes | Yes | No: `400` | Only when a rule of the bucket has one |

A field also needs its condition. The tag filter needs `tagsSupported`. The noncurrent versions and the delete markers need the status `Enabled` or `Suspended` from `GetBucketVersioning`. The reason of the provider table comes first in `hidden`.

The reason for this decision: a provider can drop a field without an error, as Garage does. A dropped tag filter makes a rule apply to every object under its prefix. Thus the editor offers only the expiration after N days for a provider that it does not know. A rule of the bucket that already uses a field shows that the provider keeps it, so the editor then offers the field. After each save, the comparison of step 4 finds a dropped field, and the editor does not offer it again.

The effect of the rules also depends on the provider. SeaweedFS 4.41 keeps all the fields above and applies the rules with its lifecycle worker, in a daily pass. Its TTL fast path at write is off by default and never applies to a bucket with versioning. In the test stack, an object written after a rule has no TTL. Garage applies the expiration and the abort of incomplete uploads in a daily pass. The window shows these notes.

### The window

The item "Lifecycle rules" of the Actions menu opens a large window. Each editable rule has a form: the ID, "Enabled", a frameless remove button, the prefix, the tag filter, and a checkbox and a number of days for each action. The window shows only the offered fields, and lists the other fields with their reasons. "Add a rule" adds a rule with the prefix of the current folder and no action.

Before the save, a confirmation names each action that deletes data and that is new or changed, with its prefix and its days. An example is "Objects under logs/ older than 30 days will be deleted." A save that adds or changes no such action asks nothing, for example a rule that becomes disabled.

The window is read only, with the reason, when `writable` is false or when the person cannot write in the folder. After a save, the details of a file read the rules again.

The note of the window "Incomplete uploads" has a button. Where the provider keeps the abort of incomplete uploads, the button "Add a lifecycle rule" opens the window with a new rule. This rule `abort-incomplete-uploads` aborts the uploads under the folder 7 days after their start. The person checks it and saves. On MinIO, the note gives the reason, and the button "Lifecycle rules" opens the window without a new rule.

`GET /api/lifecycle` needs `objects.read` on the bucket. `PUT /api/lifecycle` needs the read and write permissions of the instance and `objects.read` on the bucket. It needs `objects.write` on the node of the prefix of each rule that the save adds, changes or removes. A rule deletes objects. Thus a new or changed enabled rule that deletes objects, noncurrent versions or delete markers also needs the delete permission of the instance and `objects.delete` on its prefix. The abort of incomplete uploads needs `objects.write` only, as in the window "Incomplete uploads". Refer to [ACCESS.md](ACCESS.md).

## Object Lock

Object Lock keeps one version of an object: a legal hold, or a retention until a date. The code is in `src/objectlock.go`, behind the optional interface `ObjectLockManager` of the S3 backend. A bucket gets Object Lock only at its creation, and such a bucket always keeps versions. Each lock applies to one version.

### Detection

At start, the server reads `GetObjectLockConfiguration` of each instance with the read permission. The request is a read. Only the answer `ObjectLockEnabled: Enabled` gives `objectLockSupported: true` in `/api/instances`. These answers give `false`, and the page shows nothing of Object Lock:

- a bucket without Object Lock: `404 ObjectLockConfigurationNotFoundError` on SeaweedFS and MinIO;
- a provider without Object Lock: `501 NotImplemented` on Garage, or `405`;
- any other failure, for example a refusal or a timeout. The instance then hides the feature until the next start.

The GCS backend has no Object Lock: the routes answer `501 object_lock_unsupported`.

### Read

`GET /api/object-lock?key=&version=` gives the lock of one version. An empty `version` reads the current version: a HEAD request gives its id. The server reads `GetObjectRetention`, `GetObjectLegalHold` and `GetObjectLockConfiguration`. The answer has these fields:

| Field | Value |
| --- | --- |
| `version` | The version that the lock applies to. A change names it. |
| `retention` | `null`, or `mode` (`GOVERNANCE` or `COMPLIANCE`), `retainUntil` (RFC 3339, UTC) and `active` (`false` for a date in the past). |
| `legalHold` | `true` when the legal hold is on. |
| `bucketDefault` | `null`, or the default retention of the bucket: `mode` and `days` or `years`. |
| `now` | The date of the server. |
| `maxRetentionDays` | 36500, the latest date that S3-Browser sets, in days from now. |

The providers give "no lock" with different answers. SeaweedFS gives `404 ObjectLockConfigurationNotFoundError` for a version without a retention, and `404 NoSuchObjectLegalHold` without a legal hold. MinIO gives `400 NoSuchObjectLockConfiguration` for both, and AWS S3 gives `404 NoSuchObjectLockConfiguration`. The server reads each of these codes as "no lock". `NoSuchKey` stays an error.

### Change

`PUT /api/object-lock` changes the lock of one version. The body has `key`, `version` (required), and `legalHold`, `retention` (`mode` and `retainUntil`) or both. The server checks the body before a request to the provider:

- `mode` is `GOVERNANCE` or `COMPLIANCE`, in uppercase. No other value is accepted.
- `retainUntil` is an RFC 3339 date in the future and at most 36500 days from now. S3-Browser sends it with a precision of one second.
- `version` has 1 to 1024 printable ASCII characters.

A wrong value gives `400 invalid_object_lock`. The server then reads the lock of the version and applies these rules:

| Current retention | Change | Result |
| --- | --- | --- |
| None, or a date in the past | Any mode, a date in the future | Sent |
| Governance | A later date, or the same date, in Governance | Sent |
| Governance | An earlier date, or the mode Compliance | Needs `bypassGovernance: true` in the body. The server then sends `x-amz-bypass-governance-retention: true`. Without it: `409 governance_bypass_required` |
| Compliance | A later date, or the same date, in Compliance | Sent |
| Compliance | An earlier date, or the mode Governance | `409 compliance_retention`. Nobody can shorten a Compliance retention, not even the owner of the bucket |

The comparison of the dates uses the seconds: SeaweedFS keeps the seconds, and MinIO keeps the milliseconds. The server sends the retention first and then the legal hold. It does not send a part that does not change. A provider that refuses a change gives `409 object_lock_refused` with the status and the code of the provider. The answer of a save is the new state. The server writes one log line for each change. The line has the key, the version, the change, the use of the bypass and the subject of the request.

The read needs `objects.read`, and a change needs `objects.write` on the node of the key. No new right exists. The bypass also needs the bypass permission of the provider for the credentials of the instance (on AWS S3, `s3:BypassGovernanceRetention`). Refer to [ACCESS.md](ACCESS.md). S3-Browser does not set a retention at upload, and does not change the default retention of a bucket.

### Deletes that a lock refuses

The providers refuse the delete of a locked version with different answers. SeaweedFS gives `403 AccessDenied`. MinIO gives `400 InvalidRequest` with the message "Object is WORM protected and cannot be overwritten". `DeleteObjects` gives the same codes for each refused key, in the XML body of a `200` answer. The status alone does not tell a lock from a missing permission. Thus, after a refusal with one of these codes, the server reads the lock of the version. Only a legal hold or an active retention makes the error `409 object_locked`. Its message names the lock and tells what the person can do. Any other refusal stays the error of the provider.

A refusal for a lock does not change the delete permission that the instance reports. A delete without a version id is not refused on SeaweedFS and MinIO: the provider writes a delete marker, and the locked version stays. This is the correct behaviour of S3. Thus, on a bucket with `objectLockSupported`, the confirmation of the delete of a file or of a folder has the sentence "This bucket has Object Lock. The delete adds a delete marker. A version that a lock protects stays in the bucket." A warning after the delete tells the same. The code also covers a provider that refuses such a delete:

| Operation | Effect of a lock |
| --- | --- |
| Delete of a version (`DELETE /api/versions`, `DELETE /s3` with `version`) | `409 object_locked` |
| Delete of an object (`DELETE /s3`) | `409 object_locked` |
| Delete of a folder (job `delete_prefix`) | The job counts the key in `locked` and continues |
| Move of a folder (job `move_prefix`) | The copy exists, the source stays. The job counts it in `locked` |
| Rename or move of one object (`POST /api/rename`, job `move_object`) | `409 object_locked`: "The copy is made, but the source stays." |

For a batch delete, the server reads the lock of up to 100 refused keys of each batch. The other refused keys stay a failure of the job.

### The section "Retention"

When `objectLockSupported` is true, the details of a file have the section "Retention". It shows the mode, the retain-until date, the legal hold and the default retention of the bucket, for the version of the details. A frameless "Edit" button opens the form in the same window, with Save and Revert, as the sections "Metadata" and "Tags". A person without the write permission sees no button.

The form refuses an earlier date for an active Compliance retention, and says why, with no request. A change that needs the bypass of a Governance retention opens a confirmation first. It tells what the bypass does. A delete that a lock refuses shows the message of the server. A folder job with locked keys tells how many keys stay, and why.

## Encryption

The code is in `src/encryption.go`. S3-Browser shows the server-side encryption that the provider reports. It can also ask for SSE-S3 for each object that it writes. It does not support SSE-C or SSE-KMS for the writes. It never shows, asks for or keeps a key of the client.

### Encryption of the writes

The key `encryption` of a `bucket` block is `""` (the default) or `"sse-s3"`. Any other value stops the start, and the error says that SSE-C and SSE-KMS are not supported. A `gcs` bucket with `"sse-s3"` stops the start: the GCS API has no such header. Refer to [configuration-reference.md](configuration-reference.md).

With `"sse-s3"`, the S3 backend adds `x-amz-server-side-encryption: AES256` to each request that makes an object:

| Operation | Request with the header |
| --- | --- |
| Upload in one request, empty file, extraction of an archive | `PutObject` |
| Upload in parts | `CreateMultipartUpload` |
| Copy, move and rename | `CopyObject` |
| Copy in parts (copy, move, rename, metadata edit, restore) | `CreateMultipartUpload` |
| Metadata edit | `CopyObject` with `REPLACE` |
| Restore of a version | `CopyObject` |

`UploadPart`, `UploadPartCopy` and `CompleteMultipartUpload` do not send it: S3 takes the encryption of a multipart upload from its start. A request that already names an encryption keeps it. With `""`, the server sends no header, and the default encryption of the bucket applies.

A copy without the header gets the default encryption of the destination bucket, not the encryption of the source. On SeaweedFS and MinIO, a copy of an SSE-S3 object without the header is not encrypted. Thus, with `"sse-s3"`, each copy sends the header. The metadata edit and the restore of a version replace an object with itself. They also send the SSE-S3 or SSE-KMS headers of their source (`x-amz-server-side-encryption`, the KMS key id and the S3 Bucket Key), with any value of the key. Thus an SSE-KMS object stays SSE-KMS after a metadata edit or a restore.

The providers of the test stack give these results:

| Provider | `x-amz-server-side-encryption: AES256` |
| --- | --- |
| SeaweedFS 4.41 | Encrypts when the S3 server has a key encryption key (`WEED_S3_SSE_KEK`, or `s3.sse.kek` in `security.toml`). Without it: `500 InternalError` |
| MinIO RELEASE.2025-10-15T17-29-55Z | Encrypts when MinIO has a KMS (`MINIO_KMS_SECRET_KEY` or a KES server). Without it: `501 NotImplemented` |
| Garage v2.4.1 | Accepts the header with `200` and does not encrypt |

A provider that refuses the header refuses the write: no object is written without its encryption. Garage does not refuse. The probe at start finds the provider, and the server writes a warning for a Garage bucket with `"sse-s3"`.

### Display

`GET /api/media-info` gives these headers of the HEAD answer: `x-amz-server-side-encryption`, `x-amz-server-side-encryption-aws-kms-key-id`, `x-amz-server-side-encryption-bucket-key-enabled` and `x-amz-server-side-encryption-customer-algorithm`. The download gives them too. The MD5 of a key of the client does not go to the page.

A provider refuses the HEAD request of an SSE-C object without its key, with `400` and no body. The server then reads one byte with `GET`, and the text of the refusal gives the reason. SeaweedFS says "Customer provided keys", Garage says "Object is encrypted", AWS S3 and MinIO say "Server Side Encryption". For such a refusal, `GET /api/media-info` answers `200` with `customerKey: true`, and the size, the ETag and the date of the listing. MinIO accepts SSE-C only over TLS.

`GET /api/encryption?instance=` gives `uploads` (the value of the key) and `bucketDefault`. `bucketDefault` is `null`, or `algorithm` (`AES256`, `aws:kms` or `aws:kms:dsse`), `kmsKeyId` and `bucketKeyEnabled`, from `GetBucketEncryption`. At start, the server reads it for each instance with the read permission. An answer, or `404 ServerSideEncryptionConfigurationNotFoundError`, gives `bucketEncryptionSupported: true` in `/api/instances`. `501` (Garage), `405` and any other failure give `false`, and the route then answers `501 bucket_encryption_unsupported`. The route needs `objects.read` on the bucket.

The details of a file have the section "Encryption" after "Storage object". It shows the encryption of the object: SSE-S3, SSE-KMS with its key, or "Key of the client, SSE-C". It also shows the default encryption of the bucket. For an SSE-C object, a note tells that the preview, the download and the copy need the key, and the details have no metadata section. The section stays hidden when the provider reports no encryption.

The preview page of an SSE-C object shows the name and the path of the object, and the message "This object is encrypted with a key of the client (SSE-C). The browser cannot read it without that key." The link to the original and the downloads give the same message. The page uses this message only when the HEAD request fails with `400` and `GET /api/media-info` gives `customerKey: true`. Any other `400` stays an error.

### Locks in the bucket selector and in the listing

`/api/instances` gives three facts for each instance:

| Field | Value |
| --- | --- |
| `encryption` | The key `encryption` of the bucket: `""` or `"sse-s3"` |
| `defaultEncryption` | The algorithm of the default encryption of the bucket at start (`AES256`, `aws:kms`), or `""` |
| `encryptionApplied` | For `"sse-s3"` only: `"yes"` on AWS S3, MinIO and SeaweedFS, `"no"` on Garage, `"unknown"` for a provider that S3-Browser does not know |

The bucket selector shows a lock next to the name of a bucket that encrypts. The tooltip says "Encrypted: SSE-S3 for each new object" or "Default encryption of the bucket: AES256". The lock tells the truth of the provider. Garage accepts the header and does not encrypt, so a Garage bucket with `"sse-s3"` gets an open lock in the colour of a warning. For a provider that S3-Browser does not know, the tooltip says "SSE-S3 requested; the provider may not encrypt".

A listing does not give the encryption of an object. Thus the listing reads it with a HEAD request for each file on the page, as it reads the tags: 4 requests at the same time, 100 files at most. A file waits with a mark, and an answer stays for the ETag and the date of the file. An encrypted file gets a small lock at the right of its name, in the cell of the name. The tooltip names the encryption: SSE-S3, SSE-KMS with its key, or "key of the client" (SSE-C). A HEAD request of an SSE-C object fails with `400`, and `GET /api/media-info` then confirms the key of the client. A file without an encryption gets no lock.

The setting "Show the encryption of the objects" of the listing starts or stops these requests for each bucket. The browser keeps the choice in `portal.listing`. Without a choice, the setting is on for a bucket with a default encryption, or with `"sse-s3"` on a provider that does not ignore it. It is off for the other buckets, so their listing sends no HEAD request.

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

An object whose current version is a delete marker is not a live object. MinIO still lists its folder in a listing with a delimiter, and lists no key under it. For a bucket with versioning on MinIO, or on a provider that the server does not know, the listing therefore asks for one key under each folder of the page (4 requests at a time, 200 folders at most). It removes the folders that have no key. A failed request keeps its folder. SeaweedFS, AWS and Garage do not list such a folder, and the server sends no extra request to them.

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
