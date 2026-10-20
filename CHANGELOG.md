# Changes

This document uses ASD-STE100 Simplified Technical English.

## Unreleased

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

### Tags

- New routes: `GET` and `PUT /api/tags`, `POST /api/tags/bulk` (a job for a prefix) and `GET /api/lifecycle`. A provider
  without tags answers `501`. Refer to [docs/ACCESS.md](docs/ACCESS.md) for the actions.
- In a bucket with versioning, a tag request names the version of the object (a HEAD request finds it). This avoids a
  delay of more than 10 seconds of SeaweedFS for an object made before the versioning.
- An upload can carry tags: the header `X-Amz-Tagging` of `PUT /s3` and the field `tags` of `POST /api/uploads`.

### Interface `portal`

- The test interface `portal` shows the display name of a bucket only. The permissions of the bucket are in a button at
  the left of the selector. The crumbs start with the mark of the bucket and a slash.
- The details of a file show its tags. The person can add, remove and save them. The details tell which lifecycle rules
  apply to the object. A folder has the action "Tag objects".
- The listing has the columns Name, Tags, Versions, Size and Modified. The column Versions has no title. It shows the
  icon and the count of versions for a file with more than one version. The clock that shows the exact times is at the
  left of Modified. The tag column has no title, and its tags follow the name, at the left.
- The gear at the right of the search field opens a menu, as the menu Actions: the columns to show, the filter by tag
  and the tags of the new uploads. The browser keeps the choice. The reload is an icon with no frame, as the gear.
- The menu Actions has no item "Bucket permissions" any more: the button at the left of the bucket selector has them.
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
