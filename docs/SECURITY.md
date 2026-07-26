# Security model

## Storage behavior

Normal browsing never creates provider-side test objects, hidden prefixes, cache objects, tags, multipart uploads, or metadata changes. Provider mutations occur only for explicit user actions such as upload, copy, move, rename, overwrite, or delete.

Provider audit systems can still record reads and writes. The application cannot make network requests invisible to the storage provider.

## Permission enforcement

The frontend adapts to known capabilities, but it is not a security boundary. Every API handler validates the required operation again.

Effective access is the intersection of:

- the operation implemented by the application;
- the configured bucket permission ceiling;
- the provider credential policy;
- provider object retention, versioning, encryption, and policy constraints;
- optional global `force_read_only` mode.

Unknown provider capabilities remain tentatively usable. An explicit provider denial is learned in memory and reflected in the interface.

## Provider connections

- provider endpoints must use HTTP or HTTPS and contain no user information, query string, or fragment;
- redirects are not followed;
- environment proxy settings are not used;
- TLS 1.2 or newer is required;
- certificate verification can be disabled only by an explicit HCL testing option;
- credential files are bounded before parsing.

## Browser isolation

The application serves a restrictive content security policy and no runtime CDN URLs. Email, EPUB, SVG, Markdown, and structured previews never fetch referenced third-party resources.

Mutation requests are protected by same-origin checks. Secrets remain on the backend and are never returned to the browser.

## Logging

Anonymous logging is the default and avoids recording object keys. Detailed logging should be enabled only in a controlled environment.

## Private-key previews

Raw private-key preview is available because it was explicitly required by the application contract. Access to that preview is governed by read permission. Deployments handling private keys should add strong user authentication at the reverse proxy and avoid detailed request logging.
