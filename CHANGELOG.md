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
- The metadata tests edit a small file, a file above the threshold of the copy in parts and an older version on each
  provider. They check the date, the ETag, the versions and the tags after the save, and an object that changes while
  the form is open.
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
