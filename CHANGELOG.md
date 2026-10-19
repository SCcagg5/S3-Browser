# Changes

This document uses ASD-STE100 Simplified Technical English.

## 1.1.0

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

### Configuration

- `s3-browser print-config -c <file>` and `s3-browser -c <file> --print-config` write the value and the source of
  each key, and exit. The server writes the same values in its log at start. Secrets are hidden.
- `docs/configuration-reference.md` is generated from the table of keys in `src/config_keys.go`.
  `s3-browser config-reference` writes it.
- The S3 secrets of the `auth` block accept the `_env` form. The value in clear text is deprecated: the server writes
  a warning at start for it.
- A value of an `_env` or `_file` form of the `access` block has no change other than the removal of the last line
  end.

### Upgrade

- Add the `access` block to each configuration file. Without it, the server does not start.
- The CI permits `os.LookupEnv` only in `src/config_env.go`.
