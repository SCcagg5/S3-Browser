// The three S3 providers of the test stack (compose.yaml, config.hcl). seed.js and browser-tests.js read this table.
// Each provider has the bucket "default" behind one instance. The flags are the facts of test/README.md: the seed
// enables what a provider has, and the smoke test checks that the page shows a feature only where the flag is true.
const PROVIDERS = {
  'seaweedfs-main': { name: 'SeaweedFS', host: 'seaweedfs:8333', region: 'us-east-1', versioning: true, tags: true },
  'minio-main': { name: 'MinIO', host: 'minio:9000', region: 'us-east-1', versioning: true, tags: true },
  'garage-main': { name: 'Garage', host: 'garage:3900', region: 'garage', versioning: false, tags: false },
};

module.exports = { PROVIDERS };
