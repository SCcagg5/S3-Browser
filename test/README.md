# Integration test stack

This directory contains an isolated SeaweedFS object-storage service and the browser configuration used by smoke tests.

The SeaweedFS service is one process: it has the master, the volume server, the filer and the S3 API. `seaweedfs/Dockerfile` downloads the release 4.41 and checks its SHA-256 checksum. This version is the one of the Home repository. `seaweedfs/scripts/entrypoint.sh` creates the identity and the buckets `default` and `archive` from `config.hcl`. SeaweedFS supports object tags and the lifecycle, so the tests of these functions use it. Garage returns HTTP 501 for them. The seed of the browser tests enables the versioning of the bucket `default` and puts files with several versions in `versions/`, with tags on each version. Other test files have tags too.

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
