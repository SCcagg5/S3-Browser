# Integration test stack

This directory contains an isolated Garage object-storage stack and the browser configuration used by smoke tests.

`config.hcl` uses one S3 authentication for two buckets. Each bucket has its own permission list and listing scan limit. Persistent state is stored under `/data` so restart and orphan-state behavior can be tested.

Start the stack:

```sh
docker compose up --build
```

Open:

```text
http://localhost:8080/
```

To test a public prefix such as `/s3-browser/`, configure the reverse proxy to remove that prefix before forwarding to the application. The frontend uses relative URLs and requires no HCL path setting.

The credentials in `config.hcl` are deterministic values used only by the local Garage container. Do not reuse them outside this test environment.
