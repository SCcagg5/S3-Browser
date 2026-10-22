# Changes

This document uses ASD-STE100 Simplified Technical English.

## Unreleased

### Usage: what a bucket or a volume holds, and the capacity of the storage behind it

- `GET /api/usage` also gives the capacity of the storage behind a bucket, for the sources that can tell it, with the
  endpoint and the credentials of the `usage` block. No key of the configuration changes. Garage: the data partitions
  of the storage nodes (`GetClusterStatus`). SeaweedFS: the disks of each volume server of the master (`/dir/status`,
  then `/status` of each volume server). MinIO: the online drives (`storageinfo`; the credentials need
  `admin:StorageInfo`). The numbers are raw, before the replication or the erasure code. AWS S3 and an auth block
  without a `usage` block show nothing about the storage.
- The answer has `storage` (`scope`, used, total and free bytes, `percent`, `level`, `approximate`, `note`) or
  `storageError`. A failure of one part does not hide the other part. `percent`, `level` and the new field
  `constraint` are the more constraining part: the quota or the storage. `quotaPercent` and `quotaLevel` give the quota
  alone.
- A volume gives what its folder holds (`selfBytes`, the number of files, and `selfState`: `computing`, `partial` or
  `ready`), from a count in the background with a budget (1,000,000 entries, 20 seconds, 5 minutes of life, made old by
  each write of S3-Browser), and its file system as the storage.
- Interface `portal`: the usage in the bucket selector starts with the amount that the bucket holds (`3 MB`), before
  the bar and the percent. For a volume, the amount is `computing…` or `≥ 3 MB` while the count runs. A narrow
  selector drops the amount first (440 px). Each entry of the list has the same amount. The chip keeps its one-row form
  and its tooltip, and it does not act. The warning of a full bucket names the part: "The storage of this bucket is 91 %
  full: 910 GB of 1000 GB, 90 GB left." or "This volume is on a file system that is 91 % full: ...".

### Information page of a bucket

- Interface `portal`: each bucket and each volume has a read-only information page at `/-/<host>/<bucket>/?info`. It
  has four sections: identity, permissions (with the reason of each decision), storage and functions. It shows no
  endpoint, no admin URL, no token and no path of a volume on the server. Refer to the section "Information page of a
  bucket" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- The bucket selector has one set of seven state icons for each bucket and volume, always in this order: read,
  write, delete, encryption, Object Lock, versioning and lifecycle rules (with the count of the rules that are on).
  Each icon is grey (off, not available or denied), green (on or allowed) or orange (on with a problem: SSE-S3 that
  Garage does not apply, suspended versioning). The trigger and each entry of the list have the same set, after the
  name and before the usage. A volume has its three permissions and four grey icons. Each icon has a title and a hidden
  word for its state.
- The seven icons are one link to this page, in the trigger and in each entry of the list. The link is next to the
  button of the entry, not in it. Enter and Space open it.
- Removed: the red and struck-through permission icons, the separate versioning icon, the key and the padlock in the
  facts, and the button of the lifecycle rules in the trigger. The window of the rules opens from the information page.
- The selector keeps one row of 460 px at most. A narrow selector drops the amount of the usage first (440 px), then
  its short text (400 px), the usage (360 px) and the icon of the trigger (300 px). The seven icons stay at every
  width: on a window of 320 px, the selector shows the name, the seven icons and the chevron.
- The window "Bucket permissions", the popover "Usage" and the item "Usage" of the Actions menu are removed: the
  information page has their content.
- The button "Open the lifecycle rules" of the page opens the listing with `?lifecycle`, which opens the window of the
  rules.
- The information page has the visual language of the System page of ClickHouse Dash: parts with a heading, cards
  with a key-value list, gauges for the quota and the storage (the percent over a track), and status chips in the
  colours of the state icons. Two cards are side by side on a wide window; the page is one column on a phone. The page
  has no head and no tiles: the selector names the bucket. The state icons come from `assets/js/states.js`, one
  source for the selector and the page.
- A click on the usage in the selector (the amount, the percent or the bar) opens the information page, as a click on the
  state icons does, in the trigger and in each entry of the menu. The state icons and the usage are one link (one
  element, one hover) with no tooltip: a click opens the information page, which gives each line.
- The information page has the selector of the hosts and buckets in its header, with the classes of the selector of the
  listing. An entry opens the information page of that bucket or volume. A single instance shows no selector.
- The list of the buckets is a non-modal dialog, not a listbox. The current bucket has `aria-current="true"`.
- `GET /api/instances` gives `flavour` for an S3 instance: the provider that the probe at start recognised (`aws`,
  `minio`, `seaweedfs` or `garage`). The field is absent for an unknown provider.
- Tests: the data of each provider of the portal test stack is on a tmpfs of 4 GiB, and the volume `files` on a tmpfs
  of 1 GiB, so the numbers are the same on each test host.

### Volumes

A new block `volume "<id>" { path = "..." }` shows a folder of the server as a bucket: a Docker volume, an NFS or
CephFS mount, or a FUSE mount such as `weed mount` of SeaweedFS. A configuration file of 2.1.0 starts without any
change. Refer to the section "Volume block" of [docs/CONFIGURATION.md](docs/CONFIGURATION.md) and to the section
"Volumes" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- Configuration: the keys `name`, `path`, `permissions`, `root_prefix` and `max_scan_pages`. The folder must exist and
  the process must read it at start. With `write` or `delete` (or without `permissions`), the start writes and
  removes a test file: a folder that the process cannot write stops the start. A `volume` block and a `bucket` block
  cannot have the same label. An `auth` block cannot have the label `volume` in a file with a volume. A file needs
  one `bucket` block or one `volume` block, and an `auth` block only for a `bucket` block. `print-config` and the
  generated reference have the new keys.
- Address: `/-/volume/<id>/`. `/api/instances` gives a volume with `"provider": "fs"` and `"host": "volume"`. The
  access policy names a volume as a bucket (`bucket:<id>`, and `prefix:<name>` for a top-level folder).
- Listing: real folders, also empty folders, and hidden files. The order of the keys of S3, and the last key as the
  page token. A symbolic link to a place inside the volume is followed. A link that leaves the volume, or that does
  not resolve, is refused (`403 volume_link_refused`) and shows as unreadable (`"unreadable": true` in `/api/list`). A
  key with `..` is refused (`400`).
- Reads: the weak ETag `W/"<size>-<modification time in nanoseconds>"`, the content type from the extension, ranges,
  and the conditions of HTTP.
- Writes: each write goes to a temporary file in the folder of the target, is synchronized to the disk, and replaces
  the target with one rename. The SHA-256 of the client is checked. A move and a rename are one rename. The delete
  and the move of a folder remove the folders that they empty. A key `<folder>/` makes a folder.
- Uploads: a resumable upload writes a temporary file and resumes at its size. The window "Incomplete uploads" lists
  and removes the temporary files of the stopped uploads.
- Usage: the size of the file system (`statfs`), in the selector and in the warning of a full volume.
- Interface `portal`: the item "New folder" of the Actions menu for a volume, the word "volume", a folder icon, the
  unreadable entries, and no control for tags, versions, lifecycle rules, Object Lock, encryption and the edit of the
  metadata. The selector of a volume follows the one-row header of 2.1.0: the trigger is one line of 28 px, the host
  row is one line (`volume`, `FS · 1 volume`), and the usage is a short percent with `~` for an approximate number.
- CI: only the files `src/volume_*.go` can write to the local file system.
- Tests: the Go tests of the volumes, a volume in the portal test stack, and the real test on a FUSE mount of
  SeaweedFS (`test/volume-fuse/run.sh`). Refer to [test/README.md](test/README.md).

## 2.1.0

Version 2.1.0 adds the test interface `portal`, many functions for S3 buckets and a first set of tests on three
providers (SeaweedFS, MinIO and Garage). Each new key of the configuration is optional. A configuration file of 2.0.0
starts without any change. The new functions show only for a bucket whose provider keeps them: the page asks the
provider at start, and hides what it does not know. A bucket of a provider that does not know a function (for example
tags on Garage) works as before.

The main additions are:

- The interface `portal` (`server.frontend = "portal"`): tags and filters, versions and the comparison of two versions,
  the edit of the metadata, lifecycle rules, Object Lock, the encryption, the usage and the quota of a bucket, the
  cleanup of incomplete uploads, and the facts of each bucket in the selector.
- Uploads with a SHA-256 checksum of each part, deletes in batches, and a copy in parts for objects above 5 GiB.
- Tests in Docker on SeaweedFS, MinIO and Garage, with a table of what each provider supports in `test/README.md`.
- New optional keys: `encryption` of the `bucket` block, `quota_bytes` of the `bucket` block, and the block `usage` of an
  `auth` block. Refer to [docs/CONFIGURATION.md](docs/CONFIGURATION.md).


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
- On a bucket with Object Lock, the confirmation of the delete of a file or of a folder says: "This bucket has Object
  Lock. The delete adds a delete marker. A version that a lock protects stays in the bucket." A warning after the
  delete says the same. A delete without a version is not refused: the provider adds a delete marker, and the locked
  version stays.
- The listing shows a small closed padlock at the right of the name of a file with a lock: a legal hold or a retention
  whose date is in the future. Its tooltip says "Object Lock: Governance until 2027-10-20 10:00 UTC", "Object Lock:
  Compliance until ...", "Object Lock: legal hold", or a retention and ", legal hold". The page reads the lock from the
  HEAD request that it sends for the encryption, so the lock adds no request. A retention whose date is past gives no
  padlock. A change of the lock in the details makes the listing read that file again.
- The gateway `/s3` gives the headers `x-amz-object-lock-mode`, `x-amz-object-lock-retain-until-date` and
  `x-amz-object-lock-legal-hold` of the provider. They were removed before.
- The bucket selector shows a closed padlock next to a bucket with Object Lock. The tooltip says "Object Lock is on" and
  the default retention of the bucket when it has one. `/api/instances` gives `objectLockDefault` (`mode`, and `days` or
  `years`), from the probe at start.
- The bar of the preview page shows the same padlock and tooltip for the version on the page.

### Menus of the header

- The item "Lifecycle rules" is no longer in the menu Actions. The chip of the lifecycle rules in the bucket selector
  opens the editor, and it shows also for a bucket without rule, to add the first one.
- The item of the folder tags reads "Tag this folder", and "Tag this bucket" at the root.
- The list of the buckets has no check and no folder icon in front of a bucket. The highlight shows the current bucket,
  and the names have more room.

### Listing of a bucket with versioning

- MinIO lists the folder of an object whose current version is a delete marker, and shows no key in it. After the
  delete of the last file of a folder, or of the folder, the page showed an empty folder that came back after a reload.
  In a bucket with versioning on MinIO (or on a provider that the server does not know), the listing with a delimiter
  now asks the provider for one key under each folder, and removes the folders with no live object. SeaweedFS, AWS and
  Garage need no such request. A request that fails keeps its folder. At most 200 folders of a page are checked.

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
- `/api/instances` gives `encryption` (the key), `defaultEncryption` (the algorithm of the default encryption of the
  bucket at start, or `""`) and `encryptionApplied` (`yes`, `no` or `unknown` for `"sse-s3"`: the provider applies the
  header, ignores it, or is not known).
- The mark of the encryption is a key (Tabler `key`), and the mark of Object Lock is a closed padlock. A padlock tells
  "lock", so it is not the mark of the encryption.
- The bucket selector shows a key next to a bucket that encrypts, with the reason in its tooltip. A Garage bucket with
  `"sse-s3"` gets a key in the colour of a warning: Garage does not encrypt.
- The listing shows a small key at the right of the name of an encrypted file, with the encryption in its tooltip. The
  page reads it with a HEAD request for the files on the page: 4 requests at the same time, 100 files at most, one
  request for each file. The new setting "Show the encryption and the lock of the objects" starts or stops it for each
  bucket. It is on by default for a bucket that encrypts or that has Object Lock, and off for the other buckets. A
  choice that the browser kept with the old name of the setting still applies.
- The bar of the preview page shows the key and the padlock of the version on the page, next to its size, with the
  tooltips of the listing. The marks come from the HEAD request of the preview: a version in `?version=` shows its own
  state. The comparison shows no mark.
- The preview page of an object with a key of the client (SSE-C) shows the name and the path of the object, the key
  with the tooltip "Encrypted with a key of the client (SSE-C)", and the message "This object is encrypted with a key of
  the client (SSE-C). The browser cannot read it without that key." The title was "Loading" and the message
  "HTTP 400". The link to the original and the downloads give the same message.

### Usage and quota of a bucket

- New optional block `usage` in an `s3` auth block: `source` (`garage`, `seaweedfs` or `minio`), `endpoint`,
  `filer_endpoint` (SeaweedFS only) and the secret `token` (Garage only, `token_env` or `token_file`). The server never
  guesses the source. A key of another source, a `usage` block in a `gcs` auth block, and `minio` with the mode
  `anonymous` stop the start. `print-config` shows the URLs and hides the token. Refer to the section "Usage and quota
  of a bucket" of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- New key `quota_bytes` of the `bucket` block: a size limit that the interface shows when the provider gives no
  limit. It needs a `usage` block in the auth block. The server does not enforce it.
- New route `GET /api/usage` (action `objects.read`): the used bytes, the objects, the limit, the used part and its
  level (`ok`, `warning` from 80 %, `error` from 95 %). The numbers are for the whole bucket. A failed read answers
  `200` with `available: false` and the reason. `/api/instances` gives `usageSupported`.
- The readers: the admin API v2 of Garage (`GetBucketInfo`, with the admin token), the master and the filer of SeaweedFS
  (the sizes of the volumes and the quota of the bucket), and the admin API of MinIO (`get-bucket-quota` and
  `datausageinfo`, signed with the S3 credentials). The numbers of SeaweedFS and MinIO are approximate. AWS S3 has no
  quota: give no block.
- Each admin request is a `GET` with a time limit of 5 seconds and a size limit for its answer. The server keeps the
  result of each instance for 60 seconds (a failure for 10 seconds), and one read at a time runs for an instance. The
  token and the URLs of the admin API never go into an answer or into a log line.

### Interface `portal`: facts of the buckets in the selector, warning of a full bucket, summary of the details

- The trigger of the bucket selector shows the facts of the current bucket: the encryption (a key), Object Lock (a
  padlock, with the default retention), the lifecycle rules (an hourglass and the count) and the usage, a thin bar
  with the part of the limit (`62 %`) or the used bytes (`12.3 GB`). The tooltip has the whole text (`12.3 GB of
  20 GB`). Each fact has a tooltip and shows only when it is true. An
  approximate number starts with `~`. The bar has the colour of a warning from 80 % and of an error from 95 %.
- The versioning icon (Tabler `git-commit`, the tooltip says "Versioning: on" or "Versioning: suspended") is directly
  after the read, write and delete icons of the bucket, in the trigger and in each bucket of the list. It is not a part
  of the button of the permissions, and it does not act. A bucket that never had versioning shows no versioning icon.
- The trigger of the selector is one line of 28 px at every width: the name, the permission and versioning icons, the
  facts and the chevron. It is never on two lines. The selector is 460 px wide (less when the header has less space),
  and the list of the buckets has the same left and right edges. A narrower selector drops facts in this order: the
  short text of the usage, the usage, the key, the padlock and the versioning icon, then the lifecycle button. The
  tooltip of the trigger gives each fact. The facts never wrap and the name gets an ellipsis.
- Each bucket of the list is one line too, with its root prefix after the name in small muted text. Each host of the
  list is one line: its name, the provider and the number of buckets.
- The chip of the lifecycle rules opens the rules. It is a button next to the trigger, not in it. The keyboard goes
  from the trigger to the permission icons, then to this chip.
- Each bucket in the list of the selector has the same facts, with the values of that bucket. The page reads the
  usage of every bucket at load and when the list opens, 4 at a time, with "…" while a read waits.
- `/api/instances` gives `versioningState` (`enabled`, `suspended` or `off`) and `lifecycleRules` (the number of rules)
  of each bucket. The probe at start reads them, and a request of `/api/instances` reads them again in the background
  after 60 seconds. A failed read hides the fact and never stops the start.
- The chips of the header and the "i" popover of a phone are removed: the selector has their facts.
- The page reads the usage when a bucket opens, after a change of the objects, and after a click on the reload icon. A
  failed read shows no number: the tooltip gives the reason.
- A bucket that uses 90 % or more of its limit of bytes gets a warning: a banner at the top of the listing with
  `role="alert"` ("This bucket is 93 % full: 18.6 GB used of 20 GB. New uploads can fail.", and "This bucket is full"
  from 100 %), a red border and an alert icon on the trigger, the alert icon and a red bar in the list, and the text in
  the tooltip of the upload button. The upload stays possible. A full bucket other than the current one puts a small
  alert icon on the trigger: "Another bucket is almost full: <name>". A bucket without a limit never warns.
- The tooltip of each bucket in the bucket selector has its usage.
- The details of a file start with a strip of pills: the version (`v5 of 5`), the encryption, the lock and the number
  of tags. A click on a pill opens its section, or the version picker. The sections other than "Storage object" and
  "Tags" start closed. A chevron button opens and closes each section, with the mouse or the keyboard. The browser
  keeps the choice of each section.
- On a wide window, the details of a file show the sections in two columns. The first column has Storage object,
  Encryption and Metadata. The second column has Tags, Retention, File metadata and Document dimensions. A narrow
  window or a phone shows one column. The tool cards Verify integrity and Inspect file keep the full width under the
  columns. The tab order does not change.

### Interface `portal`: height of the header, opaque menus

- The header has the height of the header of ClickHouse Dash at every width from 320 px: one row of 45 px (44 px and
  its border line), and 57 px on a coarse pointer. A measurement of the Dash header in a browser, with its own
  stylesheet, gives these values. The bucket selector and the theme button are 28 px high, as the host picker of
  ClickHouse Dash (44 px on a coarse pointer).
- A narrow window keeps the one row. At 600 px and less, the name of the brand and the text of "Back to panel" go (the
  chevron stays). At 420 px and less, the version goes. The mark of the brand stays.
- The header has the full width of the window, as the header of ClickHouse Dash: the brand at the left gutter, the
  bucket selector and the theme button at the right gutter. The gutter of the header is the gutter of ClickHouse Dash:
  12 px, and 10 px at 820 px and less. The bar of the preview page does the same. The content of
  the page keeps its centred column of 1400 px.
- The bar of the preview page is one row of 45 px too (57 px on a coarse pointer): the way back, the name of the file,
  its size and its path on one line, then the tools. The path gets an ellipsis before the name. At 760 px and less,
  the path and the date of the version go. A comparison keeps one row from 761 px; below, its versions and its
  statistics take a row under the name.
- The theme selector is the theme selector of ClickHouse Dash, pixel for pixel, in the list header, in the preview bar
  and on the page 404. The icons are the SVG icons of Dash (inline, 18 px, a stroke of 1.5) in place of the masked
  icons of 16 px with a stroke of 1.75. The button is 34 x 28 px with 6 px corners at every width, and its icon is
  in muted text at 82 % until the pointer, the focus or the menu gives the colour of the text. The focus ring is on
  the edge of the button. The choices of the menu are 34 x 32 px, and the edge of the menu has the colour of Dash.
- The menus open with a short move and no fade, so the page never shows through a menu, also in its first frame. This
  applies to the theme menu, the list of the buckets, the menus Actions and settings, the version picker and the
  suggestions of the metadata editor. Each menu has the opaque colour `--panel`.
- An open menu of the header is above the upload dock.
- New browser tests: the header is one row of 45 px (57 px on a coarse pointer) at 14 widths from 320 to 1920 px, in
  the two themes, also with "Back to panel", with no horizontal scroll. The trigger is one row of 28 px (44 px) at each
  width for five instances, a long name with every fact and a full bucket, one bucket and a failed read of the usage.
  Each bucket and each host of the list is one line, and the list has the edges of the trigger. The bar of the preview
  is one row at each width. At 1920, 1440 and 1000 px, the brand and the way back are 12 px from the left edge and the
  theme button 12 px from the right edge (10 px at 820 and 390 px), on the list page and the preview page. The background of each menu has an alpha of 1, the menu has an opacity of 1 in its first frame,
  and no element of the page is over it, in the two themes.

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
- The browser tests restore and delete versions with the buttons of the picker, in the details and in the preview, and
  check the permissions of the buttons. The Object Lock test deletes the locked version with the Delete button of the
  picker. Other tests check the keys of the buckets and of the files, the count of the HEAD requests, the SSE-C
  message of the preview and of the downloads, and the sentence of Object Lock in the confirmation of a delete.
- On `seaweedfs-locked` and `minio-locked`, a test writes a file with a legal hold, one with a Governance retention,
  one with a Compliance retention, one with a past retention, one plain file, and one file with SSE-S3 and a lock. It
  checks the marks and the tooltips of the listing and of the preview, the padlock of the bucket, the setting, and the
  count of the HEAD requests: one for each file, and no request of `/api/object-lock`. On the buckets `encrypted`, a
  test writes a version without encryption and a version with SSE-S3, and checks the marks of the preview and the
  section "Encryption" of the details for each version.
- A test checks that each label of the treemap has a contrast ratio of 4.5 or more on its tile, also the tile "Others",
  in the light and the dark theme. A test checks that the overview of the insights has no scrollbar at 1440x900,
  1366x768 and 1280x720.
- A test opens the popover of suggestions of the metadata editor, and chooses a value with the mouse and with the
  keyboard. It also types a free value.
- The test stack gives the bucket `default` of each provider a quota of 20 GiB (Garage also 100000 objects): the
  entrypoints of Garage (admin token in `test/secrets/garage_admin_token`), SeaweedFS (`s3.bucket.quota`) and MinIO
  (`set-bucket-quota`). The Garage admin API listens on the network of the stack. `config.hcl` has a `usage` block in
  each auth block, and `seaweedfs-archive` has `quota_bytes`. The browser tests check the facts of the bucket selector
  on each provider, a bucket with no quota, the limit of `quota_bytes`, an instance without usage, a failed read, the growth of
  the usage after an upload on Garage and SeaweedFS, the tooltips of the selector, the pills of the details and the
  sections that close with the keyboard.
- Other tests check the facts of `seaweedfs-locked` and of the encrypted buckets, the facts of each bucket in the list,
  4 reads of the usage at a time, and the chip of the lifecycle rules (mouse and keyboard). The versioning icon is
  within 12 px of the delete icon, and Garage has none. Tests answer `/api/usage` with 91 %, 100 % and 50 % and
  check the banner, its role, its texts, the marks of the selector, the mark of another full bucket, and no warning
  without a limit. A test checks that Storage object and Tags are side by side in the details at 1440 px, and one under
  the other at 390 px. The settings menu has no part wider
  than the menu at 390 and 1280 px. Each column is on by default on `seaweedfs-main`, and Garage hides Tags and
  Versions. A saved choice wins over the default. The permission icons of the selector open the permissions with the
  mouse, Enter and Space.
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

- The test interface `portal` shows the display name of a bucket only. The crumbs start with the mark of the bucket and
  a slash.
- The read, write and delete icons of the bucket selector are a button of their own: a click, Enter or Space opens the
  permissions of the bucket. Its tooltip names the permissions. The rest of the selector opens the list of the
  buckets. The page has no shield button.
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
  and the tags of the new uploads. The menu is as wide as its longest line needs, and a long text wraps in it. The
  column "Encryption and lock" is in the same group as the other columns. The button "Reset to defaults" tells in its
  tooltip what it resets. The reload is an icon with no frame, as the gear.
- Each column is on by default: Tags, Versions, Size, Modified and "Encryption and lock". A column that the instance
  cannot have stays hidden (Tags and Versions on Garage). The browser keeps only the choices of the person, in
  `portal.listing` (version 2). A column that an older version kept with its old default takes the new default.
- The listing has no totals at its foot. The range of the page and the rows stay.
- The menu Actions has no item "Bucket permissions" any more: the permission icons of the bucket selector open them.
- The tags of a row are badges with a coloured swatch, as the services of ClickHouse Dash, at the right, next to the
  versions. A click on a badge filters the page by this tag. The column of versions is narrow.
- The details of a file have a picker of versions, with the date, the size and the change of size of each version.
  The new comparison of two versions shows the difference of two texts, two JSON documents or two CSV files. The
  comparison opens from the picker. The picker is also in the bar of the preview page.
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
- The details, the folder insights and the comparison of bytes use one window (`bb-modal--large`).
  The window is wide, fixed at the top, and has the same height for each tab. A dialog asks for it with `large: true`.
- Each row of the version picker has frameless icon buttons Download, Restore and Delete. They show on hover and on
  keyboard focus. Restore needs the write permission and is not on the current version. Delete needs the delete
  permission. After a restore or a delete, the details, the preview and the listing show the new versions. The
  pickers From and To of a comparison have no buttons. The item "All versions and actions…" and its table of versions
  are removed. The badge with the count of versions opens the details of the file.
- In a large window, the element that scrolls ends at the right edge of the window, so its scrollbar is at the edge. Its
  content keeps a gap of 20 px at the right. The Key column of the incomplete uploads keeps its width on a narrow
  window.
- The values and the titles of the columns Size and Modified are at the right of the column.
- The details of a file are one page, with no tab. The tools of integrity and inspection follow the sections. The arrow of the
  version picker has the size of the text. The close button of a dialog changes only the colour of its cross.
- The action button at the right of a row has no frame: only the colour of the icon changes. A file with one version has no
  version picker. The columns of the version picker line up in every row.
- A read of an older version works with SeaweedFS. The program sends no `If-Match` with a version identifier, because
  SeaweedFS compares it with the current object and answers HTTP 412.
- A JSON file that fits in one page shows its totals at once and has no button to count lines and pages. The root of
  the JSON tree stays open.
- The version picker has no text "Current" or "Older". The newest version is the current version: a small dot of the
  accent colour marks it, with the tooltip "Current". The dot is the first column of the menu, and the first element of
  the button for the current version. Two versions with the same date put the current version first.
- In the bar of the preview page, the version picker has no right margin. That margin is for the close cross of the
  details window, and only the details window keeps it.
- The metadata editor has a grid of labels and fields. Each field has the width of its value: for example 28
  characters for Content-Type and 14 for Content-Language. The suggestions show in a small popover with the look of the
  other menus: the guessed Content-Type first, the common types, Cache-Control values, encodings, languages and dates.
  Down, Up, Enter and Escape work, and a free value stays possible. The native list of the browser is gone.
- The folder insights show "computed in N ms" in the subtitle, after the count and the size. The footer and the blocks
  of totals are gone. The overview fits in the window with no scrollbar at 1440x900, 1366x768 and 1280x720: the lists of
  files share the height that is left, and each list scrolls when it is too long.
- The label of each treemap tile is black or white: the colour with the higher contrast on the tile. The tile "Others"
  has its label in the colour of the text on a light tint: its label had the colour of its tile.

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
