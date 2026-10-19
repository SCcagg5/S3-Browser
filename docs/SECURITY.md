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

## Access of humans

With `access.mode = "authzen"`, each request needs a signed identity token of the access gateway, and an AuthZEN PDP decides each action on each bucket and each top-level folder. The server fails closed when the PDP does not answer. A hidden bucket and an unknown bucket get the same answer. [ACCESS.md](ACCESS.md) gives the rules. With `access.mode = "open"`, the server checks no identity: put it only on a closed network.

## Permission enforcement

The frontend adapts to known capabilities, but every backend handler independently validates its required bucket permissions.

Effective access is the intersection of:

- implemented operation;
- the decision of the PDP for the human (authzen mode);
- bucket permission ceiling;
- provider credential policy;
- object retention, encryption, and provider policy;
- optional `force_read_only` access mode.

Unknown capabilities remain usable until the provider returns an explicit denial. Observations are process-local. A denial learned from one object operation is reported for a minute but never blocks requests for other objects; only configuration, runtime policy and bucket-level probes denying a permission are enforced. A failed, cancelled or non-403 permission probe leaves the capability unknown.

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

Every route that returns object bytes (`/s3`, `/open/`, image previews and `/api/archive-entry`) carries the sandbox CSP. Archive members that are active documents or scripts (HTML, SVG, XML, JavaScript, WebAssembly) are always sent as attachments with a neutral content type, so a ZIP member can never run as a same-origin page or script. An SVG member is only delivered as an image to `<img>` requests.

## Raw private-key preview

Raw key preview is intentionally available. Read permission is required, and content remains inside the same-origin application. Deployments containing private keys should place an appropriate access-control layer at the reverse proxy and keep anonymous request logging enabled.

## Complete-object operations

Per-object integrity and browser-side version comparison are explicit. Integrity runs under finite provider-byte/request budgets and constant-memory hashing. Version comparison reads exact bounded ranges for two immutable versions of one key and retains only two small browser buffers.

The application deliberately omits global analyses that would require retaining a large exact result set.

## Resource limits

Request and transfer limits protect the shared storage slots from slow or hostile clients:

- upload bodies and downloads must make progress at least every 30 seconds, otherwise the connection is cut and the slot released;
- a request that cannot obtain a storage slot within 30 seconds answers `503 storage_busy` (background jobs queue without limit);
- paused jobs are cancelled after 30 minutes and idle upload sessions are aborted after 30 minutes;
- SQLite preview sessions expire after three idle periods at most and the oldest one is evicted when the table is full;
- preview parsers bound nesting depth, element counts, decoded sizes and output size (email parts, vCard/iCalendar lines, Parquet metadata, PDF page markers, FITS headers, spreadsheet rows/cells/pages, SQLite sorts);
- the prepared static-response cache has an entry and a byte budget and base-href depth is capped.

## Archive members

Selective extraction rejects directories used as files, symbolic links, encrypted entries, absolute paths, traversal, duplicate destinations, existing destination objects, source collisions, and entries whose expanded size exceeds the configured budget.

Content is streamed from the archive directly to the provider destination. No local temporary member is created. Extraction requires both read and write on the target, so the create-only conflict check cannot reveal object existence on a write-only target.

## Logging

Anonymous mode is the default and avoids object keys, including those carried by `/-/` browser URLs. Logged paths are quoted so control characters cannot forge log lines. Detailed mode should be enabled only in a controlled environment. Authorization, cookies, tokens, and credential headers are never exposed by technical inspection.
