# Security model

## No application storage

The runtime does not create or modify:

- local state files;
- a local database;
- cache or checkpoint directories;
- temporary files;
- hidden provider objects;
- control prefixes, tags, or metadata;
- probe uploads or probe deletions.

The supplied scratch image runs with a read-only root filesystem and no data volume. Provider mutations occur only for an explicit user operation such as upload, copy, move, restore, extraction, overwrite, or delete.

Provider audit systems can still record every network request. The application cannot make reads or writes invisible to S3, GCS, Garage, or an intermediary proxy.

## Permission enforcement

The frontend adapts to known capabilities, but every backend handler independently validates its required bucket permissions.

Effective access is the intersection of:

- implemented operation;
- bucket permission ceiling;
- provider credential policy;
- object retention, encryption, and provider policy;
- optional `force_read_only` access mode.

Unknown capabilities remain usable until the provider returns an explicit denial. Observations are process-local.

## Version capability probe

Version controls are enabled only after one successful bounded version-list request at startup. A 501 response, denial, timeout, or parsing error hides all version controls for that bucket. The probe never creates, changes, or deletes an object.

Restore and permanent version deletion remain permission-gated and require explicit confirmation in the frontend.

## Upload resume token

Provider upload coordinates are sealed into an authenticated AES-GCM token returned to the client. The token is scoped to the configured authentication id and bucket instance, expires after at most 30 days, and is not written by the server.

The opaque token is sufficient to reconcile provider state after process-local state loss. It must be treated as a bearer capability: clients should not log it, place it in a URL, or disclose it.

## Provider connections

- endpoints must use HTTP or HTTPS and contain no user information, query string, or fragment;
- redirects are disabled;
- process environment proxies are ignored;
- TLS 1.2 or newer is used;
- certificate verification can be disabled only through an explicit testing attribute;
- configuration and credential files are size-bounded.

## Browser isolation

The frontend loads only same-origin assets. Runtime CDN access is absent. A restrictive CSP prevents email, EPUB, SVG, Markdown, and structured previews from loading referenced third-party resources.

Mutation requests use same-origin checks. Provider credentials never reach the browser.

## Raw private-key preview

Raw key preview is intentionally available. Read permission is required, and content remains inside the same-origin application. Deployments containing private keys should place an appropriate access-control layer at the reverse proxy and keep anonymous request logging enabled.

## Complete-object operations

Per-object integrity and browser-side version comparison are explicit. Integrity runs under finite provider-byte/request budgets and constant-memory hashing. Version comparison reads exact bounded ranges for two immutable versions of one key and retains only two small browser buffers.

The application deliberately omits global analyses that would require retaining a large exact result set.

## Archive members

Selective extraction rejects directories used as files, symbolic links, encrypted entries, absolute paths, traversal, duplicate destinations, existing destination objects, source collisions, and entries whose expanded size exceeds the configured budget.

Content is streamed from the archive directly to the provider destination. No local temporary member is created.

## Logging

Anonymous mode is the default and avoids object keys. Detailed mode should be enabled only in a controlled environment. Authorization, cookies, tokens, and credential headers are never exposed by technical inspection.
