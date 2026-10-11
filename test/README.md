# Integration test stack

This directory contains an isolated Garage object-storage service and the browser configuration used by smoke tests.

`config.hcl` defines one S3 authentication shared by two buckets. Each bucket has its own permission ceiling and navigation scan limit.

The browser container:

- uses the HCL file read-only;
- runs with a read-only root filesystem;
- has no application data volume;
- retains jobs and upload sessions only in process memory;
- must continue to start when Garage returns HTTP 501 for version listing.

Start the stack:

```sh
docker compose up --build
```

Open:

```text
http://localhost:8080/
```

To expose the application under `/s3-browser/`, configure the reverse proxy to remove that prefix before forwarding. The frontend resolves all URLs relative to the public document path and requires no HCL path setting.

The fixed credentials in `config.hcl` belong only to the isolated Garage service. Do not reuse them outside this test environment.

## Browser behaviour tests

`test/e2e/` drives a real Chrome against a running stack. The `test/*.js` files pin source text and tokens; these
cover what only a browser shows: keyboard focus after menus, dialogs, paging and re-renders, focus rings that a
scroller clips, vertical swipes on touch screens, 200% text, forced colours, reduced motion and axe-core in both
themes.

```sh
docker compose up --build -d        # this stack
cd e2e && npm install               # playwright-core and axe-core, dev only
CHROME_PATH=/usr/bin/google-chrome BB_E2E_URL=http://127.0.0.1:8080 npm test
```

The run uploads its fixtures under `e2e-fixtures/` in `garage-main` and deletes them afterwards. `BB_E2E_FILTER`
runs only the checks whose name contains the given text. These tests are not part of the application and are not
run by the CI workflows.
