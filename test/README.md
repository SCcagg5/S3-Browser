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

The fixed credentials in `config.hcl` and `secrets/` belong only to the isolated Garage service. Do not reuse them outside this test environment. The secret key is in `secrets/s3_secret_access_key`, because the browser refuses a secret in clear text in the HCL file. The compose file mounts `secrets/` at `/config/secrets` in both containers.
