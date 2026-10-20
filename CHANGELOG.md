# Changes

This document uses ASD-STE100 Simplified Technical English.

## Unreleased

### Copy, move and rename

- A copy, a move or a rename of an object from 5 GiB minus 256 MiB up goes in parts (`UploadPartCopy`). `CopyObject`
  refuses a source above 5 GiB. The copy keeps the standard headers, the user metadata and the tags of the source.
  Refer to the section "Copy in parts" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- `POST /api/copy` and `POST /api/rename` of such an object answer `202` with a job `copy_object` or `move_object`.
  The job shows `copiedBytes` and `totalBytes`. A cancel aborts the multipart upload. A smaller object gets `200` as
  before.
- The prefix jobs count the copied bytes in `copiedBytes`.
- The restore of a large version copies that version in parts.
- The interfaces show the copied bytes of a copy job, with a progress bar for one object.

### Edit of the metadata

- New routes: `GET /api/metadata` (the stored metadata of an object, from the provider) and `PUT /api/metadata` (the
  complete new state). The server copies the object onto its key with `x-amz-metadata-directive: REPLACE` and keeps
  the tags. From the threshold of the copy in parts up, the copy goes in parts. Refer to the section "Edit of the
  metadata" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- The edit sets `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`,
  `Expires` and the user metadata (`x-amz-meta-*`, 2 KiB at most). The server checks each value. A missing value is
  removed.
- The copy names the ETag that the form read (`x-amz-copy-source-if-match`). The server also compares the date. An
  object that changed after the read gives `412 object_changed`, and the form reads the new values.
- The edit of an older version makes it the current version, as a restore does.
- The action is `objects.write`. The server probes the edit of each instance at start and gives
  `metadataEditSupported` in `/api/instances`. The GCS backend answers `501`.

### Cleanup of incomplete multipart uploads

- New item "Incomplete uploads" in the Actions menu. A large window lists the incomplete multipart uploads of the folder,
  with the start, the parts, the size and the age of each. The person can abort the selected uploads, one upload with
  the button of its row, or each upload older than N days. Refer to the section "Cleanup of incomplete multipart
  uploads" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- New routes: `GET /api/multiparts` (the list, with pages) and `POST /api/multiparts/abort` (the selected uploads, or
  the new job `abort_multiparts` for the uploads older than N days).
- The list sends no prefix to the provider and filters the keys in S3-Browser: MinIO gives an empty list for a prefix
  that is not a full key. The pages follow the markers of each provider. The count and the size of the parts come from
  the first 1000 parts, and the page says "at least" for a larger upload.
- The abort by age never aborts an upload without a start date (SeaweedFS gives none) or an upload younger than 24
  hours. No abort touches an upload that the resumable-upload store of this process sends now.
- The list needs `objects.read`, and an abort needs `objects.write`. The server probes the list of each instance at
  start and gives `multipartUploadsSupported` in `/api/instances`. The GCS backend answers `501`.

### Lifecycle rules

- New item "Lifecycle rules" in the Actions menu. A large window edits the lifecycle rules of the bucket: the ID, the
  status, the prefix, a tag filter, and the actions "delete the objects after N days", "delete the noncurrent
  versions after N days", "abort the incomplete multipart uploads after N days" and "remove the expired delete
  markers". Refer to the section "Edit of the lifecycle rules" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- New route `PUT /api/lifecycle`. The server keeps each other rule byte for byte (transitions, size filters and so on)
  and writes the whole configuration. The page sends the hash of the configuration that it read. A configuration that
  changed since gives `409 lifecycle_changed`.
- Before the save, a confirmation names each new or changed action that deletes data, with its prefix and its days.
- The window offers only the fields that the provider keeps: a table for AWS S3, SeaweedFS, MinIO and Garage, from
  the answers of the provider. For another provider, the window offers the expiration after N days and the fields that
  a rule of the bucket already uses. Garage gets no tag filter: it drops the filter, and the rule then applies to every
  object under the prefix. MinIO gets no abort of incomplete uploads.
- After the save, the server reads the rules again and tells in plain words what the provider changed. It restores
  nothing. It does not offer again a field that the provider dropped.
- A provider that refuses the write (`403`, `501`) makes the window read only, with the reason.
- The note of the window "Incomplete uploads" opens the window of the lifecycle rules with a new rule that aborts the
  uploads of the folder after 7 days. On MinIO, the note gives the reason why no such rule is possible.
- The action is `objects.write` on the prefix of each rule that a save adds, changes or removes. A rule that deletes
  objects, versions or delete markers also needs `objects.delete` on its prefix. The server probes the lifecycle rules
  of each instance at start and gives `lifecycleSupported` in `/api/instances`. The GCS backend answers `501`.

### Object Lock

- New section "Retention" in the details of a file, for a bucket with Object Lock. It shows the mode (Governance or
  Compliance), the retain-until date and the legal hold of the version of the details. It also shows the default
  retention of the bucket. Refer to the section "Object Lock" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- New routes: `GET /api/object-lock` and `PUT /api/object-lock`. A change names the version. It sets or removes the
  legal hold, sets a first retention, or extends a retention. A shorter Governance retention, or a change from
  Governance to Compliance, needs `bypassGovernance: true`. The server then sends
  `x-amz-bypass-governance-retention: true`. Before such a change, the page asks for a confirmation that tells what the
  bypass does.
- Nobody can shorten a Compliance retention or change it to Governance: the form refuses and says why, and the server
  answers `409 compliance_retention`.
- Before a request to the provider, the server checks the mode (a closed set), the version and the date. The date is
  RFC 3339, in the future, and at most 36500 days from now. It writes one log line for each change, with the use of the bypass.
- A delete that a lock refuses gives `409 object_locked` with a message that names the lock. The server reads the lock
  of the version after a refusal: SeaweedFS refuses with `403 AccessDenied` and MinIO with `400 InvalidRequest`. Such
  a refusal does not change the delete permission that the page shows.
- A folder delete or a folder move counts the keys that a lock keeps in `locked` and `lockedKeys` of the job, and
  continues. The page tells how many keys stay. A rename of one locked object tells that the copy is made and that the
  source stays.
- The read needs `objects.read`, and a change needs `objects.write`. The server reads the Object Lock configuration of
  each instance at start and gives `objectLockSupported` in `/api/instances`. A bucket without Object Lock, Garage
  (`501`) and the GCS backend hide the section.

### Encryption

- New key `encryption` of the `bucket` block: `""` (the default, no header) or `"sse-s3"`. With `"sse-s3"`, the
  server sends `x-amz-server-side-encryption: AES256` with each request that writes an object: the upload (one request
  or the start of a multipart upload), the copy, the move and the rename (also in parts), the metadata edit, the
  restore of a version and the extraction of an archive. Refer to the section "Encryption" of
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Any other value stops the start, with the key, the two values and the value of the file. SSE-C and SSE-KMS are not
  supported. A `gcs` bucket with `encryption = "sse-s3"` stops the start. `print-config` and the log at start show
  the value. The configuration reference has the key.
- A copy without the header gets the default encryption of the destination bucket: on SeaweedFS and MinIO, a copy of
  an encrypted object was not encrypted. The metadata edit and the restore of a version now send the SSE-S3 or SSE-KMS
  headers of their source, with any value of the key.
- New section "Encryption" in the details of a file: SSE-S3, SSE-KMS and its key, or a key of the client (SSE-C). The
  page never shows or asks for a key of the client. The details of an SSE-C object open with the size, the ETag and
  the date of the listing: the provider refuses the HEAD request without the key. The section also shows the default
  encryption of the bucket. It stays hidden when the provider reports no encryption.
- New route `GET /api/encryption` (the default encryption of the bucket and the value of the key). `GET /api/media-info`
  now gives the encryption headers of the object. The download gives them too. The action is `objects.read`. The
  server reads the default encryption of each bucket at start and gives `bucketEncryptionSupported` in
  `/api/instances`. Garage (`501`) and the GCS backend hide the default of the bucket.
- Garage v2.4.1 accepts the header and does not encrypt. The server writes a warning at start for a Garage bucket with
  `encryption = "sse-s3"`.

### Uploads and deletes

- An S3 upload can carry a SHA-256 checksum. The browser computes the digest of each chunk. The provider refuses a part
  with other bytes. The answer has `checksumVerified`. Refer to the section "Upload checksums" of
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- The request `POST /api/uploads` has the new field `checksum`. The header `X-Checksum-Sha256` of a chunk and of
  `PUT /s3` is new. Without them, an upload works as before.
- The delete of a prefix and the move of a prefix delete the objects in batches of 1000 keys (`DeleteObjects`). A
  provider that refuses the batch request gets one request for each key.

### Tests

- The test stacks use SeaweedFS 4.41 in place of Garage. The image downloads the release and checks its checksum.
  The buckets, the identities and the compose files use the name `seaweedfs`.
- The browser tests open the page at `localhost`. A secure origin gives the page `crypto.subtle`.
- The stack of the browser tests has three S3 providers: SeaweedFS 4.41, MinIO RELEASE.2025-10-15T17-29-55Z (a build
  from source) and Garage v2.4.1. A smoke test lists, uploads, downloads and deletes on each provider. It also checks
  that the page shows versions and tags only where the provider has them.
- `test/README.md` has a table of the S3 functions of each provider, from S3 requests to the test stack.
- The seed puts four incomplete multipart uploads in `mpu/` on each provider. A browser test lists them, aborts them by
  selection and by row, and checks that the abort by age keeps uploads that are too young or have no date. A second
  test checks that an upload of the resumable-upload store is not aborted.
- The metadata tests edit a small file, a file above the threshold of the copy in parts and an older version on each
  provider. They check the date, the ETag, the versions and the tags after the save, and an object that changes while
  the form is open.
- The lifecycle tests add a rule on each provider through the window, and check the confirmation, the rule that the
  editor keeps byte for byte, and the fields of each provider. Each test restores the rules of the seed. The signed S3
  requests of the tests are in `test/portal-frontend/s3.js`.
- The entrypoints of SeaweedFS and MinIO create a bucket `locked` with Object Lock, with the instances
  `seaweedfs-locked` and `minio-locked`. The health check of SeaweedFS waits for its buckets. On both providers, the Object Lock tests set
  and remove a legal hold, and try to delete a locked version. They extend and shorten a Governance retention, and
  check that a Compliance retention cannot be shortened. A test checks that Garage hides the section.
- The test image takes the build arguments `MULTIPART_COPY_THRESHOLD` and `MULTIPART_COPY_PART_SIZE`. The portal test
  stack copies in parts from 8 KiB up, in parts of 5 MiB. A browser test copies and renames a file of 11 MiB on each
  provider and compares the SHA-256 of the result. A second test restores a large version on SeaweedFS and MinIO.

### Tags

- New routes: `GET` and `PUT /api/tags`, `POST /api/tags/bulk` (a job for a prefix) and `GET /api/lifecycle`. A provider
  without tags answers `501`. Refer to [docs/ACCESS.md](docs/ACCESS.md) for the actions.
- In a bucket with versioning, a tag request names the version of the object (a HEAD request finds it). This avoids a
  delay of more than 10 seconds of SeaweedFS for an object made before the versioning.
- An upload can carry tags: the header `X-Amz-Tagging` of `PUT /s3` and the field `tags` of `POST /api/uploads`.
- The server probes the tag requests of each instance at start and gives `tagsSupported` in `/api/instances`. An instance
  without tags (Garage) hides the tag controls from the first load. The page sends no tag with an upload to it, and the
  server answers `501` to an upload that carries tags, because Garage would drop them without a word.

### Interface `portal`

- The test interface `portal` shows the display name of a bucket only. The permissions of the bucket are in a button at
  the left of the selector. The crumbs start with the mark of the bucket and a slash.
- The details of a file show its tags. The person can add, remove and save them. The details tell which lifecycle rules
  apply to the object. A folder has the action "Tag objects".
- The details of a file have the section "Metadata": the stored headers and the user metadata. A frameless "Edit" button
  opens the form in the same window, with Save and Revert. Before the save, the form tells what changes: the date, a
  new version where versioning is on, and the ETag where it changes. The section "Tags" has the same button and look:
  the tags are read only until the person clicks "Edit".
- The listing has the columns Name, Tags, Versions, Size and Modified. The column Versions has no title. It shows the
  icon and the count of versions for a file with more than one version. The clock that shows the exact times is at the
  left of Modified. The tag column has no title, and its tags follow the name, at the left.
- The gear at the right of the search field opens a menu, as the menu Actions: the columns to show, the filter by tag
  and the tags of the new uploads. The browser keeps the choice. The reload is an icon with no frame, as the gear.
- The menu Actions has no item "Bucket permissions" any more: the button at the left of the bucket selector has them.
- The tags of a row are badges with a coloured swatch, as the services of ClickHouse Dash, at the right, next to the
  versions. A click on a badge filters the page by this tag. The column of versions is narrow.
- The details of a file have a picker of versions, with the date, the size and the change of size of each version.
  The new comparison of two versions shows the difference of two texts, two JSON documents or two CSV files. The
  comparison opens from the picker and from the table of versions. The picker is also in the bar of the preview page.
  The views are side by side (the default), unified and the patch of git, with the buttons "Copy patch" and
  "Download .patch". A CSV file shows two tables side by side. The menus of actions have no item "Versions": the badge
  with the count opens them.
- The columns Size and Modified use a font with one width for every character. Their width is the width of the longest
  text that they can show. The relative time and the exact time give the same width to Modified, so the columns stay in
  place when the mode changes.
- The comparison of two versions is a part of the preview page, not a dialog. The address has the parameter `compare`.
  The picker of the versions of the preview stays in its place and becomes the version To. The version From appears at its
  left, and the statistics of the change are between the two. The header gets no new row, and a button closes the comparison. The view "Git patch" is now "Patch". The browser
  back button returns to the preview. A JSON file has the modes Raw, Beautify and Tree, as the preview. A changed line
  with marked words showed the text `[object HTMLElement]`: this is fixed.
- The details, the folder insights, the table of versions and the comparison of bytes use one window (`bb-modal--large`).
  The window is wide, fixed at the top, and has the same height for each tab. A dialog asks for it with `large: true`.
- The values and the titles of the columns Size and Modified are at the right of the column.
- The details of a file are one page, with no tab. The tools of integrity and inspection follow the sections. The arrow of the
  version picker has the size of the text. The close button of a dialog changes only the colour of its cross.
- The action button at the right of a row has no frame: only the colour of the icon changes. A file with one version has no
  version picker. The columns of the version picker line up in every row.
- A read of an older version works with SeaweedFS. The program sends no `If-Match` with a version identifier, because
  SeaweedFS compares it with the current object and answers HTTP 412.
- A JSON file that fits in one page shows its totals at once and has no button to count lines and pages. The root of
  the JSON tree stays open.

## 2.0.0

Version 2.0.0 is a major version: a configuration file of 1.0.x does not start without changes. Refer to
[Upgrade from 1.0.x](#upgrade-from-10x).

### Access of humans (AuthZEN)

- New mandatory `access` block. `mode = "open"` keeps the behavior of 1.0.13. `mode = "authzen"` obeys section 11 of
  the MCP server contract. Refer to [docs/ACCESS.md](docs/ACCESS.md).
- With `authzen`, each request needs a signed identity token (JWT, `EdDSA` or `ES256`) in the header
  `identity.header`. A token that is absent or not valid gets `401`. `GET /healthz` and
  `GET /.well-known/access-actions` need no token.
- `GET /.well-known/access-actions` publishes the tree `service` > `bucket` > `prefix` and the actions
  `objects.read`, `objects.write` and `objects.delete`.
- Each route asks the PDP with the match `node` on its exact resource: the top-level folder of the key, else the
  bucket. A refused action gets `403` with the name of the action.
- `GET /api/instances` shows only the buckets on which the human holds one action (one batch, match `subtree`). The
  root of a bucket shows only the folders that the human can read when the human cannot read the bucket.
- A hidden bucket and an unknown bucket get the same answer.
- The server fails closed when the PDP does not answer, and keeps the decisions for `pdp.cache_ttl` at most.
- Each decision has a log line `access.decision`. The request log adds `subject` and `request_id`.
- The user interface hides the upload and the delete controls of a folder that the human cannot change.

### Configuration (strict)

- `s3-browser print-config -c <file>` and `s3-browser -c <file> --print-config` write the value and the source of
  each key, and exit. The server writes the same values in its log at start. Secrets are hidden.
- `docs/configuration-reference.md` is generated from the table of keys in `src/config_keys.go`.
  `s3-browser config-reference` writes it.
- A secret accepts only `_env` and `_file`. A secret in clear text in the file stops the start. The secrets are
  `auth.secret_access_key`, `auth.session_token` and `access.pdp.token`. `auth.access_key_id` is an identifier: it
  keeps the value form, and `print-config` shows it.
- The value of a `_file` form applies without its last line end, and with no other change. A secret with a space or a
  control character stops the start. The error does not show the secret.
- The server never changes a value to make it fit. Before 2.0.0, it removed spaces, changed the case of `provider`,
  `mode`, `access_mode`, `log_mode` and `permissions`, removed the `/` at the end of `endpoint`, changed `root_prefix`
  (`"/tenant"` became `"tenant/"`), and removed a duplicate permission. Now each of these values stops the start.
  The error gives the key, the expected form and the value.
- An empty text value (for example `name = ""`) stops the start. To use the default of a key, remove the key.
- The only environment variables that the server reads are the ones that an `_env` attribute names. Only
  `src/config_env.go` reads them, and the CI checks it.

### Tests

- `test/smoke.sh` uses the current upload API: each chunk sends the resume token in
  `X-S3-Browser-Resume-Token` to `PUT /api/uploads`. Insights accepts `200` (done at once) or `202` (a job).
- The Garage test stack reads the S3 secret from `test/secrets/s3_secret_access_key`.

### Upgrade from 1.0.x

Do these steps on each configuration file before you start 2.0.0. Then run `s3-browser print-config -c <file>`: it
stops with the error of each value that does not fit.

1. Add the `access` block. `access { mode = "open" }` keeps the behavior of 1.0.x. For `authzen`, refer to
   [docs/ACCESS.md](docs/ACCESS.md).
2. Move each secret out of the file. Replace `secret_access_key = "..."` with `secret_access_key_file = "/path"` or
   `secret_access_key_env = "VAR"`. Do the same for `session_token`.
3. Write `provider`, `mode`, `server.access_mode`, `server.log_mode` and each item of `permissions` in lower case,
   without spaces. Remove a duplicate item of `permissions`.
4. Remove the `/` at the end of `endpoint`.
5. Write `root_prefix` as `""` or as a prefix that ends with `/` and does not start with `/`. For example, write
   `"tenant-a/"`, not `"/tenant-a"` or `"tenant-a"`.
6. Remove the spaces at the start and at the end of each text value, and remove each key with an empty value.
7. Make sure that each file of a `_file` form holds only the value and one optional line end.
