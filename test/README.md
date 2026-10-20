# Integration test stack

This directory contains an isolated SeaweedFS object-storage service and the browser configuration used by smoke tests.

The SeaweedFS service is one process: it has the master, the volume server, the filer and the S3 API. `seaweedfs/Dockerfile` downloads the release 4.41 and checks its SHA-256 checksum. This version is the one of the Home repository. `seaweedfs/scripts/entrypoint.sh` creates the identity and the buckets `default` and `archive` from `config.hcl`.

`config.hcl` defines one S3 authentication shared by two buckets. Each bucket has its own permission ceiling and navigation scan limit.

The browser container:

- uses the HCL file read-only;
- runs with a read-only root filesystem;
- has no application data volume;
- retains jobs and upload sessions only in process memory;
- must start when a provider returns HTTP 501 for version listing.

Start the stack:

```sh
docker compose up --build
```

Open:

```text
http://localhost:8080/
```

To expose the application under `/s3-browser/`, configure the reverse proxy to remove that prefix before forwarding. The frontend resolves all URLs relative to the public document path and requires no HCL path setting.

The fixed credentials in `config.hcl` and `secrets/` belong only to the isolated SeaweedFS service. Do not reuse them outside this test environment. The secret key is in `secrets/s3_secret_access_key`, because the browser refuses a secret in clear text in the HCL file. The compose file mounts `secrets/` at `/config/secrets` in both containers.

## Portal test stack: three providers

`portal-frontend/compose.yaml` starts three S3 providers next to S3-Browser. `portal-frontend/run.sh` starts the stack, puts the test objects and runs the browser tests. Refer to [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md#browser-tests-of-the-portal-frontend).

| Provider | Image | Instance | Endpoint |
| --- | --- | --- | --- |
| SeaweedFS 4.41 | `seaweedfs/Dockerfile`: the release archive, with its SHA-256 checksum | `seaweedfs-main`, `seaweedfs-archive` | `http://seaweedfs:8333` |
| MinIO RELEASE.2025-10-15T17-29-55Z | `minio/Dockerfile`: a build from the Git tag, with a check of its commit | `minio-main` | `http://minio:9000` |
| Garage v2.4.1 | `garage/Dockerfile`: the binary of `dxflrs/garage:v2.4.1`, pinned by its digest | `garage-main` | `http://garage:3900` |

The MinIO project does not publish a server image or a server binary now, and its repository is archived. Thus `minio/Dockerfile` builds the last release from source. The build takes about one minute, one time. Docker keeps the image in its cache.

Each provider reads the first `access_key_id` and the first `secret_access_key_file` of `portal-frontend/config.hcl`. Thus the three `auth` blocks use the same key. Garage needs this format: `GK` and 24 hexadecimal characters for the key ID, 64 hexadecimal characters for the secret. Each entrypoint creates the bucket `default` and then writes a ready file. The health check of each provider reads this file, so the browser starts after the buckets exist. The Garage region is `garage`.

The seed (`portal-frontend/seed.js`) enables the versioning of the bucket `default` on SeaweedFS and MinIO. It puts the same objects in `smoke/` on each provider: one file with tags where the provider has tags, and one file with two versions. On SeaweedFS, the seed also puts the data of the other tests: files with several versions in `versions/`, tags, a lifecycle rule, and a JSON file, a CSV file and a binary file for the comparison. The other browser tests use SeaweedFS only.

The image of S3-Browser in this stack copies in parts from 8 KiB up, in parts of 5 MiB (the build arguments `MULTIPART_COPY_THRESHOLD` and `MULTIPART_COPY_PART_SIZE` of `browser/Dockerfile`). The seed puts `copy/source.bin` (11 MiB, three parts) with standard headers, a user metadata and tags on each provider. On SeaweedFS and MinIO, it also puts `copy/versioned.bin` with two versions. The tests of the copy in parts copy and rename `source.bin` through the page and compare the SHA-256, the headers and the tags. They also restore the older version of `versioned.bin`.

The seed also puts the objects of the metadata tests in `meta/` on each provider: `small.txt` (under the threshold of the copy in parts), `large.bin` (20000 bytes, above it) and `conflict.txt`, each with `Cache-Control: max-age=60` and the user metadata `owner`. `small.txt` and `large.bin` have tags where the provider has them. `versioned.txt` has two versions on SeaweedFS and MinIO. The metadata tests edit these objects through the details on each provider. They check each sentence that the form shows before the save against the result: the date, the ETag, the versions and the tags. They also check that the form shows and sends the stored `Cache-Control`, not the value of the gateway (`private, no-store, max-age=60`). Refer to the section "Edit of the metadata" of [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

The seed also puts four incomplete multipart uploads in `mpu/` on each provider, with S3 requests: `one-part.bin` (one part of 1 KiB), `no-part.bin`, and two uploads of `twice.bin`. The folder has `readme.txt`, so the page can open it. The test of each provider opens the window "Incomplete uploads" of the folder. It checks the parts, the age ("unknown" on SeaweedFS) and "Abort everything older than 1 day", which aborts nothing. It then aborts one upload of `twice.bin` with "Abort selected" and `one-part.bin` with the button of its row. The test aborts the last two uploads through the API. A second test starts a resumable upload through the API and checks that the window and the server do not abort it. Refer to the section "Cleanup of incomplete multipart uploads" of [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

The tests of the lifecycle editor write the rules of the bucket `default` through the S3 API of each provider first (`portal-frontend/s3.js`). At the end, each test writes the rule of the seed again on SeaweedFS and deletes the rules on MinIO and Garage: the tests of the tags read the rule of SeaweedFS. The test of each provider adds a rule through the window, with the confirmation of the deletion. It checks that the rule with a date stays byte for byte, and that the window offers only the fields that the provider keeps. A second test opens the window from the window "Incomplete uploads" with the rule that aborts the uploads, where the provider keeps it. Other tests check a change of the rules while the window is open, the changes of the provider after a save, a read-only editor, and the hidden item.

The smoke test of each provider lists `smoke/`, uploads a file with its SHA-256 checksum, downloads it and deletes it. It checks the versions and the tags where the provider has them. Where the provider does not have them, it checks that the page hides them. `portal-frontend/providers.js` has the flags of each provider.

## Functions of each provider

These facts come from S3 requests to the three providers of the portal test stack, with a check of the effect by a second request. "Yes" means that the request works and has its effect. "Dropped" means that the provider answers 200 but does not keep the setting. Other cells give the HTTP status and the S3 error code.

| Function | SeaweedFS 4.41 | MinIO 2025-10-15 | Garage v2.4.1 |
| --- | --- | --- | --- |
| Object tags (Get, Put, Delete) | Yes | Yes | 501 NotImplemented |
| Header `x-amz-tagging` on PutObject | Yes | Yes | Dropped |
| Versioning (PutBucketVersioning, ListObjectVersions) | Yes | Yes | 501 NotImplemented. GetBucketVersioning gives 200 with no status |
| GET or DELETE with `versionId` | Yes | Yes | The provider ignores `versionId`. A DELETE with any `versionId` deletes the object |
| DeleteObjects (batch delete) | Yes | Yes. A request with no checksum header gives 400 MissingContentMD5 | Yes |
| `x-amz-checksum-sha256` on PutObject | Yes. A wrong value gives 400 BadDigest | Yes. A wrong value gives 400 XAmzContentChecksumMismatch | Yes. A wrong value gives 400 InvalidDigest |
| `x-amz-checksum-sha256` on UploadPart | Yes. ListParts does not show the part checksum | Yes | Yes |
| Composite checksum of a multipart object (HEAD) | `<digest>-<parts>` | `<digest>-<parts>` | `<digest>`, with no part count |
| ListMultipartUploads | Yes. No `Initiated` date. Only `NextUploadIdMarker` for the next page | Partial. A prefix that is not a full key gives an empty list. `max-uploads` has no effect | Yes |
| ListMultipartUploads: order and pages, with three uploads of one key and `max-uploads=2` | Order of the upload ids. The pages continue with `upload-id-marker` only, and each upload comes one time | One page with all the uploads, in the order of the keys | Order of the keys. The pages continue with `key-marker` and `upload-id-marker`, and each upload comes one time |
| ListParts, AbortMultipartUpload | Yes. ListParts of an aborted upload gives 200 with no part | Yes | Yes |
| ListParts with `max-parts=1` of an upload with two parts | One part, `IsTruncated` true | One part, `IsTruncated` true | One part, `IsTruncated` true |
| ListParts or AbortMultipartUpload of an unknown upload id | 404 NoSuchUpload | ListParts: 404 NoSuchUpload. Abort: 404 NoSuchUpload, but 204 for the id of an upload of another key (the upload stays) | 404 NoSuchUpload |
| UploadPartCopy with `x-amz-copy-source-range` | Yes | Yes | Yes |
| UploadPartCopy or CopyObject of an older version | Yes | Yes | 404 NoSuchKey |
| `x-amz-copy-source-if-match` on UploadPartCopy, with the ETag of the source | Yes | Yes | Yes |
| Header `x-amz-tagging` on CreateMultipartUpload | Yes | Yes | No tags (not tested) |
| ETag of a copy in 3 parts | `<digest>-3` | `<digest>-3` | `<digest>-3` |
| CopyObject onto itself with `MetadataDirective=REPLACE` | Yes. The tags stay, the date changes, a new version comes | Yes. The tags stay, the date changes, a new version comes | Yes. The date changes |
| ETag after CopyObject REPLACE of an object in one part | The ETag stays | The ETag stays | The ETag stays |
| ETag after CopyObject REPLACE of a multipart object | The ETag stays (`<digest>-<parts>`) | The ETag changes: it becomes the MD5 of the object | The ETag stays (`<digest>-<parts>`) |
| CopyObject REPLACE with no `Content-Type` | `binary/octet-stream` | `binary/octet-stream` | No `Content-Type` |
| `x-amz-copy-source-if-match` on CopyObject, with another ETag | 412 PreconditionFailed | 412 PreconditionFailed | 412 PreconditionFailed |
| `x-amz-copy-source-if-match` on CopyObject of an older version | Compared with the ETag of that version | Compared with the ETag of that version | 404 NoSuchKey (no versions) |
| CopyObject REPLACE of a key that does not exist (the start probe of the metadata edit) | 404 NoSuchKey, no object | 404 NoSuchKey, no object | 404 NoSuchKey, no object |
| Lifecycle: expiration after N days, with a prefix | Yes | Yes | Yes |
| Lifecycle: abort of incomplete multipart uploads | Yes | 400 InvalidArgument. With an expiration in the same rule: dropped | Yes |
| Lifecycle: expiration of noncurrent versions | Yes | Yes | Dropped |
| Lifecycle: tag filter | Yes | Yes | Dropped: the rule applies to all the prefix |
| Lifecycle: removal of expired delete markers | Yes | Yes | 400 InvalidRequest |
| Lifecycle: transition to a storage class | 501 NotImplemented | 400 InvalidStorageClass | Dropped |
| Lifecycle: expiration on a date, size filter (`ObjectSizeGreaterThan`) | Yes | Yes. The children of `And` come back in another order | Yes |
| Lifecycle: the old `Prefix` element outside of `Filter` | Yes | Yes | Dropped: the rule applies to the whole bucket |
| Lifecycle: a rule with no ID | Yes, with no ID | Yes. The provider gives the rule an ID | Yes, with no ID |
| Lifecycle: two rules with one ID | Yes | 400 InvalidArgument | Yes |
| Lifecycle: a configuration with no rule | Yes | 400 InvalidArgument | 400 MalformedXML |
| Lifecycle: an empty `Filter` | Yes | Yes | The provider removes the `Filter` |
| Effect of the lifecycle rules | A lifecycle worker in a daily pass. The TTL at write is off by default, and an object written after a rule has no TTL | Not measured | Not measured |
| Header `Server` | `SeaweedFS 30GB 4.41` | `MinIO` | None. No request id. The error document has `Region` and no `RequestId` |
| Object Lock: bucket with lock, legal hold, retention | Yes. A refusal gives 403 AccessDenied | Yes. A refusal gives 400 InvalidRequest | 501 NotImplemented |
| GetObjectLockConfiguration on a bucket with no lock | 404 ObjectLockConfigurationNotFoundError | 404 ObjectLockConfigurationNotFoundError | 501 NotImplemented |
| SSE-S3 (`x-amz-server-side-encryption: AES256`) in this stack | 500 InternalError, no object | 501 NotImplemented: no KMS in this stack | Dropped: no encryption header comes back |
| GetBucketEncryption on `default` | 404 ServerSideEncryptionConfigurationNotFoundError | 404 ServerSideEncryptionConfigurationNotFoundError | 501 NotImplemented |

Notes for the code:

- Garage answers 501 NotImplemented for each function that it does not have. The message is `Unimplemented action: <name>`.
- Do not send a `versionId` to Garage. Garage gives an `x-amz-version-id` header on each write, but it keeps no versions.
- Garage drops some lifecycle settings with no error. After a write, read the configuration again and compare it.
  The lifecycle editor offers only the fields that each provider keeps. Refer to the section "Edit of the lifecycle
  rules" of [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
- Delete the lifecycle configuration with `DeleteBucketLifecycle`: MinIO and Garage refuse a configuration with no rule.
- Send `Content-MD5` or an `x-amz-checksum-*` header with DeleteObjects: MinIO refuses the request without one.
- On MinIO, list the multipart uploads with no prefix. Then S3-Browser filters the keys.
- The lock refusal codes are different: 403 AccessDenied on SeaweedFS, 400 InvalidRequest on MinIO. The bypass header does not remove a legal hold or a Compliance retention.
- SSE-S3 needs a key service. The MinIO of this stack has no `MINIO_KMS_SECRET_KEY`, and SeaweedFS has no encryption configuration.
