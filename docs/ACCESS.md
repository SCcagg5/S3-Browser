# Access of humans

This document uses ASD-STE100 Simplified Technical English.

S3-Browser obeys section 11 of the MCP server contract ("Access of humans (AuthZEN)"). This section applies to
the pages, to the API and to the object gateway of S3-Browser. S3-Browser has no MCP endpoint.

## Principle

The access has three parts:

1. **Authentication.** An access gateway in front of S3-Browser identifies the human. It puts a signed identity
   token in a request header. The reverse proxy sends the request to S3-Browser. S3-Browser verifies the token on
   each request.
2. **Decision.** For each action, S3-Browser asks a PDP (Policy Decision Point) with the OpenID AuthZEN
   Authorization API 1.0. The decision depends only on the human, the action and the resource.
3. **Enforcement.** S3-Browser applies the decision on the server side, for each route. It does not trust the
   page to hide an action.

The access gateway decides only the action `access` (the entry into S3-Browser). S3-Browser decides all its other
actions.

## Configuration

The `access` block is mandatory. A file without it stops the start. Thus nobody gets the open mode by mistake.

```hcl
access {
  mode = "authzen"                       # "authzen" | "open"

  identity {
    header           = "X-Identity-Token"
    issuer           = "portal.home"
    audience         = "infra-s3"        # the id of this server at the access gateway
    public_keys_file = "/run/secrets/s3_browser_identity_keys"   # or public_keys, or public_keys_env
    max_age          = "5m"
  }

  pdp {
    url             = "http://portal-pdp.edge.svc.cluster.local:4182"   # or url_env, or url_file
    token_file      = "/run/secrets/s3_browser_pdp_token"               # or token_env
    timeout         = "500ms"
    cache_ttl       = "30s"
    max_evaluations = 64
  }
}
```

The generated list of the keys, with their defaults and their ranges, is in
[configuration-reference.md](configuration-reference.md).

| Key | Default | Use |
|---|---|---|
| `mode` | (required) | `authzen`: S3-Browser obeys all of this document. `open`: S3-Browser checks no identity and no permission. |
| `identity.header` | `X-Identity-Token` | The request header that holds the token. `Cookie`, `Authorization`, `Host`, `Content-Type` and `Content-Length` are refused. |
| `identity.issuer` | (required) | The value that the `iss` claim must have. |
| `identity.audience` | (required) | The id of this server: 1 to 256 bytes of UTF-8, no control character. The `aud` claim must contain it. It is also the `id` of the `service` resource and the `server` of the list of actions. |
| `identity.public_keys` | (required) | The public keys of the issuer in PEM: 1 to 16 `-----BEGIN PUBLIC KEY-----` blocks. Each key is Ed25519 (`EdDSA`) or P-256 (`ES256`). It has the forms `public_keys`, `public_keys_env` and `public_keys_file`. |
| `identity.max_age` | `5m` | The longest life of a token (`exp - iat`). From `1s` to `24h`. |
| `pdp.url` | (required) | The base URL of the PDP: `http` or `https`. It has the forms `url`, `url_env` and `url_file`. |
| `pdp.token_env`, `pdp.token_file` | (required) | The bearer token of this server at the PDP. It is a secret. A token in clear text (`token = "..."`) stops the start. |
| `pdp.timeout` | `500ms` | The longest time of one request to the PDP. From `10ms` to `1m`. |
| `pdp.cache_ttl` | `30s` | The longest time that S3-Browser keeps an answer of the PDP. From `0s` (no cache) to `1h`. |
| `pdp.max_evaluations` | `64` | The most questions in one batch request. From 1 to 1024. Use the limit of the PDP or less. |

These items stop the start:

- No `access` block, no `mode`, or a `mode` that is not `authzen` or `open`.
- `mode = "open"` with an `identity` block or a `pdp` block. The two contradict each other.
- `mode = "authzen"` without the `identity` block or the `pdp` block, or without one of their required keys.
- A PEM text that does not hold only Ed25519 or P-256 public keys.
- A URL of the PDP that is not `http` or `https`, or that has credentials, a query or a fragment.
- A token of the PDP that has a space, a control character or more than 4096 bytes. The error does not show the token.
- With `mode = "authzen"`, a label of a `bucket` block that has more than 256 bytes.

With `mode = "open"`, S3-Browser writes the warning `config.warning` at each start. Use the open mode only for a
server alone on a closed network. The open mode keeps the behavior of S3-Browser 1.0.13.

`s3-browser print-config -c <file>` (or `s3-browser -c <file> --print-config`) shows each value with its source. It
shows the keys as their type and their JWK thumbprint (RFC 7638), for example `["Ed25519 kid=kPrK_..."]`. It shows
the token of the PDP as `<hidden>`.

## Identity token

The identity token is a JWT (RFC 7519) in the compact JWS form. S3-Browser verifies these items on each request:

| Item | Rule |
|---|---|
| Header | `alg` is `EdDSA` (Ed25519) or `ES256` (P-256, SHA-256). A header with `crit`, or a `typ` that is not `JWT`, is refused. S3-Browser never fetches a key: `jku`, `x5u` and `jwk` have no effect. S3-Browser tries each configured key of the algorithm, so a rotation can use two keys. |
| Signature | It must be valid for one of the configured keys. |
| `iss` | It must be equal to `identity.issuer`. |
| `aud` | A text equal to `identity.audience`, or a list that contains it. |
| `iat`, `exp` | Both are required. `exp` must be after the current time, with no tolerance. `iat` can be 60 seconds in the future at most. `exp - iat` must not be more than `identity.max_age`. |
| `nbf` | When it is present, it can be 60 seconds in the future at most. |
| `sub` | The name of the human: 1 to 256 bytes of UTF-8, no control character. It is the AuthZEN subject `id`. |

S3-Browser accepts the token only in the configured header. It does not accept a token in a cookie or in a query
parameter. Two copies of the header are refused. The reverse proxy must replace a header of the same name that the
client sends.

If the token is absent or not valid, S3-Browser sends status `401` with
`{"error": {"code": "unauthenticated", "message": "A valid identity token is required."}}`. It does not show a login
page and does not redirect: the access gateway does that. The log line `access.unauthenticated` gives the reason
(`missing`, `malformed`, `algorithm`, `signature`, `issuer`, `audience`, `expired`, `not_yet_valid`, `max_age`,
`subject`). The answer does not give it.

S3-Browser keeps a verified token (its SHA-256, its subject and its `exp`) in memory until its `exp`. The cache
holds 4096 tokens at most. S3-Browser checks the token when a request starts. A download that started with a valid
token continues after the `exp` of the token.

These routes need no token: `GET /healthz` and `GET /.well-known/access-actions`. Each other route needs a valid
token. The static files of the user interface need a token and no action.

## Resources and actions

S3-Browser publishes its actions at `GET /.well-known/access-actions`, without a token:

```json
{
  "server": "infra-s3",
  "resource_types": [
    { "name": "bucket", "parent": "service", "description": "One bucket block of the configuration. ..." },
    { "name": "prefix", "parent": "bucket",  "description": "One top-level folder of a bucket. ..." }
  ],
  "actions": [
    { "name": "objects.read",   "resource_types": ["service", "bucket", "prefix"], "description": "..." },
    { "name": "objects.write",  "resource_types": ["service", "bucket", "prefix"], "description": "..." },
    { "name": "objects.delete", "resource_types": ["service", "bucket", "prefix"], "description": "..." }
  ]
}
```

`server` is `identity.audience` (`s3-browser` in the open mode). The list does not contain `access`.

### The tree

```text
service (identity.audience, for example "infra-s3")
└── bucket (the label of a bucket block, for example "docker-registry")
    └── prefix (the first part of an object key, before the first "/")
```

- The id of a `bucket` is the label of its `bucket` block, not the name of the bucket at the provider. Two blocks
  that show the same provider bucket with two `root_prefix` values are two resources.
- The id of a `prefix` is the first segment of the object key, below `root_prefix`, without the `/`. For the key
  `reports/2026/q1.csv`, the prefix is `reports`.
- A key without `/` (an object at the root of the bucket) has no prefix. Its resource is the bucket.
- A first segment that no grant can name has no prefix. Such a segment has more than 256 bytes, is not UTF-8, or
  has a control character. Its resource is the bucket. Thus only a grant on the bucket or on the service covers it.

### Why one level of folders

S3-Browser declares one `prefix` level only. A type cannot be its own parent. Thus a tree of nested folders needs one
type for each level (for example `prefix1`, `prefix2`, `prefix3`). The contract permits a depth of 4 at most, so
`bucket` and three levels of folders would be the limit. A grant on a folder at a deeper level would still be
impossible. One level keeps the tree simple and the grants easy to read. A top-level folder is the usual unit of
separation in a bucket (one tenant, one project, one service). A grant on a deeper folder is not possible: give a grant
on its top-level folder.

### Actions

| Action | Resource types | What it permits |
|---|---|---|
| `objects.read` | `service`, `bucket`, `prefix` | List, preview, inspect and download objects. See the versions, the Insights and the archive entries. Check the integrity of an object. |
| `objects.write` | `service`, `bucket`, `prefix` | Upload objects, make folders and restore a version. Change the tags and the metadata of an object. Abort an incomplete multipart upload. Be the destination of a copy, a move or an archive extraction. |
| `objects.delete` | `service`, `bucket`, `prefix` | Delete objects, versions and folders. Be the source of a move or a rename. |

S3-Browser has no administration of a bucket (no creation, no policy, no lifecycle). Thus it has no action for it.
When you remove or rename an action, or change its resource types, write the change in the release notes.

### Grants

The PDP keeps the grants (for example portal). A grant has the form `<action> on service:<id>[/<type>:<id>]...`. Each
id is percent-encoded (RFC 3986). A grant covers the resource that it names and each resource below it. Examples:

| Grant | Covers |
|---|---|
| `objects.read on service:infra-s3` | Each object of each bucket. |
| `objects.read on service:infra-s3/bucket:docker-registry` | Each object of the bucket `docker-registry`. |
| `objects.write on service:infra-s3/bucket:clickhouse-system/prefix:backups` | The objects of `clickhouse-system` whose key starts with `backups/`. |
| `objects.read on service:infra-s3/bucket:logs/prefix:team%20a` | The objects of `logs` whose key starts with `team a/`. |

## Decisions

### The resource of each route

Each operation asks the PDP with the match `node` on its exact resource. The resource of a key is the prefix of its
top-level folder, else the bucket.

| Route | Action | Resource |
|---|---|---|
| `GET /api/list` | `objects.read` | The node of `prefix`. Refer to [Navigation](#navigation). |
| `GET`, `HEAD /s3?key=`, `GET /open/...` | `objects.read` | The node of `key`. |
| `GET /s3` without `key` (the S3 list) | `objects.read` | The node of `prefix`. A `prefix` without `/` is the bucket. |
| `PUT /s3?key=` | `objects.write` | The node of `key`. |
| `DELETE /s3?key=` (also with `version`) | `objects.delete` | The node of `key`. |
| The previews and the metadata: `/api/spreadsheet`, `/api/delimited`, `/api/document-count`, `/api/document/word`, `/api/parquet`, `/api/json/...`, `/api/search`, `/api/media-info`, `/api/structured-preview`, `/api/archive-preview`, `/api/archive-entry`, `/api/image-preview`, `/api/inspect` | `objects.read` | The node of `key`. |
| `POST /api/sqlite/sessions` and each request of a session | `objects.read` | The node of the key of the session. |
| `GET /api/stats` (Insights), `GET /api/archive` (ZIP of a folder) | `objects.read` | The node of `prefix`. The root of the bucket is the bucket. |
| `GET /api/versions` | `objects.read` | The node of `key`. |
| `DELETE /api/versions` | `objects.delete` | The node of `key`. |
| `POST /api/version-counts` | `objects.read` | The node of each key, in one batch. |
| `POST /api/versions/restore` | `objects.read` and `objects.write` | The node of `key`. |
| `POST /api/integrity`, `POST /api/archive-entry/integrity` | `objects.read` | The node of `key`. |
| `POST /api/copy` | `objects.read` on `src`, `objects.write` on `dst` | The node of each. |
| `POST /api/rename` | `objects.read` and `objects.delete` on `src`, `objects.write` on `dst` | The node of each. |
| `POST /api/delete-prefix` | `objects.read` and `objects.delete` | The node of `prefix`. |
| `GET /api/tags` | `objects.read` | The node of `key`. |
| `PUT /api/tags` | `objects.write` | The node of `key`. |
| `POST /api/tags/bulk` | `objects.read` and `objects.write` | The node of `prefix`. The root of the bucket is the bucket. |
| `GET /api/metadata` | `objects.read` | The node of `key`. |
| `PUT /api/metadata` | `objects.write` | The node of `key`. |
| `GET /api/multiparts` | `objects.read` | The node of `prefix`. The root of the bucket is the bucket. |
| `POST /api/multiparts/abort` with `uploads` | `objects.write` | The node of each `key`. |
| `POST /api/multiparts/abort` with `olderThanDays` | `objects.read` and `objects.write` | The node of `prefix`. The root of the bucket is the bucket. |
| `GET /api/lifecycle` | `objects.read` | The bucket. |
| `POST /api/archive-extract` | `objects.read` on the archive; `objects.write` and `objects.read` on the target folder | The target folder of the target bucket. An empty target is the bucket. |
| `POST /api/uploads` and each request with an upload resume token | `objects.write` | The node of the key of the upload. |
| `GET /api/jobs/<id>`, `POST /api/jobs/<id>/<pause\|resume\|cancel>` | The actions of the request that made the job | The resources of that request. |
| `POST /api/permissions/refresh` | None | The bucket must be visible. |
| `GET /api/instances`, `GET /api/build`, the pages and the static files | None | A valid token only. `GET /api/instances` shows only the visible buckets. |

Rules:

- A request without `instance` names the first bucket of the configuration, as in 1.0.13.
- A batch asks all the questions of one route in one request, for example the source and the destination of a copy.
- A job, an upload session and a SQLite session keep their resources. Each request on them asks the PDP again. For a
  job or a SQLite session, a human who does not hold the decisions gets the answer of a job or a session that does
  not exist (`404`). For an upload, the answer is `403` with `objects.write`.
- The decisions of the PDP do not replace the other limits. The `permissions` of the bucket block,
  `server.access_mode = "force_read_only"` and the policy of the provider still apply.

### Hidden buckets

S3-Browser shows only the buckets on which the human holds one action at least:

- One batch asks each action on each bucket, with the match `subtree`. A bucket is visible when one decision on the
  bucket is `true`. A grant on the service, on the bucket or on a prefix of the bucket makes the bucket visible.
- `GET /api/instances` lists only the visible buckets. `default` is the first visible bucket. For each action that
  the human holds nowhere in a bucket, `capabilities` and `operations` show `denied` with the source `access`.
- A request for a hidden bucket gets the same answer as a request for a bucket that does not exist: `403` with the
  action of the route. For a bucket that does not exist, S3-Browser asks the action on the service. Thus a human with
  a grant on the service gets `404` (`unknown_instance`), and the other humans get `403`.
- The page of a hidden bucket (`/-/<auth>/<bucket>/...`) is the `404` page of a bucket that does not exist.
- `GET /healthz` still counts all the buckets.

### Navigation

A human with a grant on a prefix only must still see the path to that prefix:

- `GET /api/list` asks the three actions on the node of the listing (match `node`). The answer gives the decisions
  in `access` (`read`, `write`, `delete`). The user interface uses `write` and `delete` to hide the upload and the
  delete controls in the folder.
- When `read` is `false` on the bucket, S3-Browser lists the bucket and keeps only the items of the top-level folders
  that the human can read. It asks `objects.read` on each of these prefixes with the match `subtree`, in batches of
  `pdp.max_evaluations` questions. It removes the objects at the root of the bucket.
- When `read` is `false` on a prefix, the answer is `403`. A prefix has no level below it.
- A `subtree` decision only shows or hides a navigation element. Each operation asks `node` on its exact resource.

Example: a human holds only `objects.read on service:infra-s3/bucket:clickhouse-system/prefix:backups`. The bucket
`clickhouse-system` is visible, and its root shows only the folder `backups/`. The objects of `backups/` open. An
object at the root, another folder, Insights of the whole bucket and an upload get `403`.

### Requests to the PDP

S3-Browser asks the PDP with AuthZEN:

```json
POST {pdp.url}/access/v1/evaluation
{
  "subject":  { "type": "user", "id": "<sub of the identity token>" },
  "action":   { "name": "objects.read" },
  "resource": {
    "type": "prefix",
    "id": "backups",
    "properties": { "ancestors": [ { "type": "service", "id": "infra-s3" }, { "type": "bucket", "id": "clickhouse-system" } ] }
  },
  "context":  { }
}
```

- A question on the service has no `ancestors`. A question on a bucket has the ancestors `[service]`. A question on a
  prefix has the ancestors `[service, bucket]`.
- For more than one question, S3-Browser sends one batch to `POST {pdp.url}/access/v1/evaluations`. The subject is at
  the top. Only a question of the navigation has a `context`: `{"match": "subtree"}`. The other questions use the
  default match `node`. A batch has `pdp.max_evaluations` questions at most. S3-Browser sends more batches for more
  questions.
- Each call has `Authorization: Bearer <pdp token>` and `X-Request-ID`. The id is the `X-Request-ID` of the request
  (1 to 128 characters of `A-Z`, `a-z`, `0-9`, `.`, `_`, `:` and `-`), else a new random id.
- **Fail closed.** No answer before `pdp.timeout`, a connection error, a redirect, a status that is not `200`, a body
  that is larger than 256 KiB, and a body that is not a valid answer give the decision `false` for each question of
  the call. S3-Browser writes the line `access.pdp_failed` and never keeps a failure.
- A `false` decision with `"context": {"reason": "unknown_subject"}` tells that the PDP does not know the subject.
  S3-Browser has no resource that a human owns. Thus it only writes the reason in the log. Every other `false`
  decision means "no permission".
- S3-Browser keeps an answer for `pdp.cache_ttl` at most. The key is the subject, the action, the chain of the
  resource and the match. Thus a `subtree` answer never answers a `node` question. A change of the policy applies after
  `cache_ttl` at most.
- The cache holds 16384 answers and 8 MiB at most. When the cache is full, S3-Browser removes the expired answers. If
  the cache is still full, S3-Browser empties it. These bounds are not settings.

## Enforcement

- S3-Browser checks the decision of each route before the route reads or changes the storage, also when the page does
  not show the action.
- If the decision is `false`, S3-Browser sends status `403` with
  `{"error": {"code": "forbidden", "action": "<action>", "message": "The action <action> is not allowed."}}`. The
  answer does not give the reason of the PDP. The object gateway (`/s3`, `/open/`) sends the same JSON body.
- The user interface hides what the human cannot do. It reads `capabilities` of `GET /api/instances` for the bucket,
  and `access` of `GET /api/list` for the folder. A control that the page hides is not a permission: the server still
  checks each request.

## Logs and traces

- For each decision, the log has one line `access.decision` with `request_id`, `subject`, `action`, `resource`,
  `match` (`node` or `subtree`), `decision`, `source` (`pdp`, `cache` or `error`) and `reason` (`unknown_subject`, or
  empty). `resource` is the chain with the ids percent-encoded, for example
  `service:infra-s3/bucket:clickhouse-system/prefix:backups`.
- The request log adds `subject` and `request_id` to each request with a verified token. The anonymous log mode still
  hides the object keys of the paths. The subject is not hidden: the contract requires it.
- `access.unauthenticated` and `access.pdp_failed` are the lines of a refused token and of a failed call to the PDP.
- S3-Browser has no OpenTelemetry export. Thus the call to the PDP is not a CLIENT span. This is a difference from
  contract 11.7.

## Deviation from AuthZEN: TLS

AuthZEN requires a secure connection to the PDP. S3-Browser accepts `https` and verifies the certificate with the
system roots. It also accepts `http` for a private network. With `http`, the deployment must limit the network to
S3-Browser and the PDP. For example, a NetworkPolicy admits only the pods of S3-Browser to the port of the PDP.

## Upgrade from 1.0.13

S3-Browser 2.0.0 adds the access of humans. [CHANGELOG.md](../CHANGELOG.md) gives all the upgrade steps of 2.0.0.

- Add the `access` block. `access { mode = "open" }` keeps the behavior of 1.0.13.
- For `authzen`, give the public key of the access gateway and a token at the PDP. Then give the grants in the PDP.
  The PDP must read `properties.ancestors`, the match of the `context`, and the top-level `resource_types` of the list
  of actions (contract 11.4 and 11.5).
- A human with only the action `access` of the gateway sees no bucket.

## Tests

`src/access_test.go` starts the server in the `authzen` mode with a fake PDP (`src/access_fake_pdp_test.go`). The fake
PDP applies the prefix rule of the grants and the match `subtree`, and checks the chain of each resource. The tests
cover a grant on one bucket, a grant on one prefix, a grant on the service, hidden and unknown buckets, a read-only
human, the jobs, a PDP that fails or is slow, and the tokens that are not valid. A test sends each route as a human
without a grant, and as a human with a grant on another folder. `src/access_identity_test.go`,
`src/access_pdp_test.go` and `src/access_config_test.go` test the token, the client of the PDP and the configuration.
