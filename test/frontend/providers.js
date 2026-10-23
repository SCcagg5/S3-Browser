// The three S3 providers of the test stack (compose.yaml, config.hcl). seed.js and browser-tests.js read this table.
// Each provider has the bucket "default" behind one instance. The flags are the facts of test/README.md: the seed
// enables what a provider has, and the smoke test checks that the page shows a feature only where the flag is true.
const PROVIDERS = {
  'seaweedfs-main': { name: 'SeaweedFS', host: 'seaweedfs:8333', region: 'us-east-1', versioning: true, tags: true },
  'minio-main': { name: 'MinIO', host: 'minio:9000', region: 'us-east-1', versioning: true, tags: true },
  'garage-main': { name: 'Garage', host: 'garage:3900', region: 'garage', versioning: false, tags: false },
};

// The buckets "locked" of the providers with Object Lock (SeaweedFS and MinIO). Each has Object Lock from its creation,
// and so versioning. Garage has no Object Lock: the tests of Object Lock check that garage-main hides it.
const LOCKED = {
  'seaweedfs-locked': { name: 'SeaweedFS', host: 'seaweedfs:8333', region: 'us-east-1', bucket: 'locked', provider: 'seaweedfs-main' },
  'minio-locked': { name: 'MinIO', host: 'minio:9000', region: 'us-east-1', bucket: 'locked', provider: 'minio-main' },
};

// The buckets "encrypted" of SeaweedFS and MinIO. Both encrypt with SSE-S3 (a test key in the stack), and the
// instances have encryption = "sse-s3". The seed enables versioning on them. The instance "garage-encrypted" has no
// entry: it uses the bucket "default" of Garage, and Garage does not encrypt. The tests of the encryption use it with
// the entry of garage-main.
const ENCRYPTED = {
  'seaweedfs-encrypted': { name: 'SeaweedFS', host: 'seaweedfs:8333', region: 'us-east-1', bucket: 'encrypted', provider: 'seaweedfs-main' },
  'minio-encrypted': { name: 'MinIO', host: 'minio:9000', region: 'us-east-1', bucket: 'encrypted', provider: 'minio-main' },
};

// The volume of the test stack: the Docker volume volume-data, at /data/volume in Stowr and at /volume in the
// Playwright container (run.sh). It has no tags, no versions, no lifecycle, no Object Lock and no encryption of S3: the
// page hides them. Its usage is the size of its file system.
const VOLUMES = {
  files: { name: 'Volume', mount: '/volume', uid: 65532 },
};

module.exports = { PROVIDERS, LOCKED, ENCRYPTED, VOLUMES };
