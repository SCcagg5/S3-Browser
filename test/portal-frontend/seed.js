// Puts the test objects in the buckets of the three providers through the API of S3-Browser (PUT /s3).
const { request } = require('playwright');
const { PROVIDERS, LOCKED, ENCRYPTED } = require('./providers');
const crypto = require('crypto');
const { s3, SEED_LIFECYCLE } = require('./s3');
const BASE = process.env.BASE;

// The tags of some test objects: the header X-Amz-Tagging of the upload.
const TAGGED = {
  'config/ingest.json': 'team=data&env=prod',
  'reports/2026/q3/summary.md': 'team=finance',
  'README.md': 'team=docs',
  'src/main.go': 'lang=go&team=platform',
  'images/banner.svg': 'kind=image&team=design&env=prod&license=mit&owner=ada',
};

// The versions of the files of versions/: a text, a JSON document, a CSV file and a binary file. The comparison reads them.
const context = Array.from({ length: 12 }, (_, i) => `Context line ${i + 1}`).join('\n');
const VERSION_BODIES = {
  'versions/report.txt': [
    `# Quarterly report\n\nStatus: draft\nOrders: 120\nRevenue: 4000\n\n${context}\n\nNotes:\n- first numbers\n- no review yet\n`,
    `# Quarterly report\n\nStatus: review\nOrders: 120\nRevenue: 4100\n\n${context}\n\nNotes:\n- first numbers\n- reviewed by finance\n`,
    `# Quarterly report\n\nStatus: final\nOrders: 124\nRevenue: 4100\n\n${context}\n\nNotes:\n- first numbers\n- reviewed by finance\n- approved\n`,
  ].map(text => Buffer.from(text)),
  'versions/notes.txt': ['versions/notes.txt version 1', 'versions/notes.txt version 2'].map(text => Buffer.from(text)),
  'versions/config.json': [
    '{"service":"ingest","replicas":2,"limits":{"cpu":"500m"},"regions":["eu-west"],"legacy":true}',
    '{"service":"ingest","replicas":3,"limits":{"cpu":"500m","memory":"1Gi"},"regions":["eu-west","us-east"]}',
    '{\n  "regions": ["eu-west", "us-east"],\n  "replicas": 4,\n  "service": "ingest",\n  "limits": { "memory": "1Gi", "cpu": "500m" }\n}',
  ].map(text => Buffer.from(text)),
  'versions/orders.csv': [
    'id,customer,qty\n1,ada,5\n2,grace,7\n3,linus,9\n',
    'id,customer,qty\n1,ada,5\n2,grace,8\n3,linus,9\n4,ken,1\n',
    'id,customer,qty\n2,grace,8\n3,linus,9\n4,ken,2\n',
  ].map(text => Buffer.from(text)),
  'versions/blob.bin': [Buffer.from([0, 1, 2, 3, 4]), Buffer.from([0, 1, 2, 9, 4])],
};

// The tags of each version of the files of versions/: the latest version has the last tags.
const VERSION_TAGS = {
  'versions/report.txt': ['status=draft', 'status=review', 'status=final&team=data'],
  'versions/notes.txt': ['', 'team=docs'],
};

const md = `# Quarterly report\n\nThe numbers of **Q3 2026**, by region.\n\n| Region | Orders | Revenue |\n| --- | ---: | ---: |\n| North | 1,204 | 48,310 |\n| South | 987 | 39,072 |\n\n\`\`\`sql\nSELECT region, count() FROM orders GROUP BY region;\n\`\`\`\n\n> Figures are provisional.\n`;
const csv = 'date,region,orders,revenue\n' + Array.from({ length: 120 }, (_, i) => `2026-09-${String(1 + (i % 30)).padStart(2, '0')},${['North', 'South', 'East', 'West'][i % 4]},${100 + (i * 37) % 400},${(4000 + (i * 911) % 9000).toFixed(2)}`).join('\n') + '\n';
const json = JSON.stringify({ service: 'ingest', version: 3, replicas: 2, limits: { cpu: '500m', memory: '256Mi' }, regions: ['eu-west', 'us-east'], enabled: true, notes: null }, null, 2);
const rows = JSON.stringify(Array.from({ length: 12000 }, (_, i) => ({ id: i, name: `row-${i}`, tags: ['a', 'b'], ok: i % 2 === 0 })), null, 1);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1d2b44"/><circle cx="420" cy="150" r="90" fill="#356fe6"/><rect x="80" y="220" width="300" height="60" rx="12" fill="#93b4ff"/></svg>';
const go = 'package main\n\nimport "fmt"\n\n// main prints a greeting.\nfunc main() {\n\tfmt.Println("hello, bucket")\n}\n';

const objects = {
  'seaweedfs-main': {
    'reports/2026/q3/summary.md': md,
    'reports/2026/q3/orders.csv': csv,
    'reports/2026/q2/summary.md': md.replace('Q3', 'Q2'),
    'reports/2026/q1/summary.md': md.replace('Q3', 'Q1'),
    'reports/2025/annual.md': md.replace('Quarterly', 'Annual'),
    'config/ingest.json': json,
    'config/app.yaml': 'service: ingest\nreplicas: 2\nlimits:\n  cpu: 500m\n',
    'images/banner.svg': svg,
    'src/main.go': go,
    'logs/2026-10-18.log': Array.from({ length: 200 }, (_, i) => `2026-10-18T10:${String(i % 60).padStart(2, '0')}:00Z INFO request ${i} served in ${(i * 7) % 90} ms`).join('\n'),
    'archive/deep/level-3/level-4/level-5/notes.md': '# Deep notes\n\nA file five folders down.\n',
    'README.md': '# Main bucket\n\nTest data of the portal interface.\n',
    'big/rows.json': rows,
    'big/blob-6mb.bin': 'x'.repeat(6 * 1024 * 1024),
  },
  'seaweedfs-archive': {
    'backups/2026-10-01.tar': 'backup'.repeat(20000),
    'backups/2026-10-08.tar': 'backup'.repeat(26000),
    'exports/users.csv': 'id,name\n1,Ada\n2,Grace\n',
  }
};

// The objects of the smoke test of each provider (smoke/). hello.txt has tags where the provider has them, and
// versioned.txt has two versions where the provider keeps them.
const SMOKE = instance => ({
  'smoke/hello.txt': [`Hello from ${PROVIDERS[instance].name}.\n`],
  'smoke/data.json': [JSON.stringify({ provider: PROVIDERS[instance].name, ok: true })],
  'smoke/versioned.txt': ['versioned.txt version 1\n', 'versioned.txt version 2\n'],
});

// The objects of the test of the copy in parts (copy/). The test image copies in parts from 8 KiB up, in parts of
// 5 MiB: source.bin gives three parts. It has the standard headers, a user metadata and, where the provider has them,
// tags. versioned.bin has two versions where the provider keeps them.
const COPY_SOURCE = Buffer.alloc(11 * 1024 * 1024 + 123);
for (let i = 0; i < COPY_SOURCE.length; i += 1) COPY_SOURCE[i] = (i * 31 + (i >> 9)) & 255;
const COPY_HEADERS = { 'content-type': 'application/x-copy-test', 'cache-control': 'max-age=600', 'content-disposition': 'attachment; filename="source.bin"', 'x-amz-meta-origin': 'seed' };

// The objects of the test of the metadata (meta/). small.txt stays under the threshold of the copy in parts (one
// CopyObject request), large.bin is above it. Both have a Cache-Control, a user metadata and, where the provider has
// them, tags. versioned.txt has two versions where the provider keeps them. conflict.txt is for the test of an object
// that changes while the form is open.
const META_SMALL = 'small metadata file\n';
const META_LARGE = Buffer.alloc(20000, 'm');
const META_HEADERS = { 'cache-control': 'max-age=60', 'x-amz-meta-owner': 'ada' };

// The incomplete multipart uploads of the test of the cleanup (mpu/): one upload with one part, one without a part,
// and two uploads of one key. The folder has one object, so the page can open it. The test aborts the uploads.
const MPU_PART = Buffer.alloc(1024, 'p');
async function seedIncompleteUploads(instance) {
  const create = async key => /<UploadId>([^<]+)<\/UploadId>/.exec(await s3(instance, 'POST', `/default/${key}`, 'uploads=', Buffer.alloc(0)))[1];
  const onePart = await create('mpu/one-part.bin');
  await s3(instance, 'PUT', '/default/mpu/one-part.bin', `partNumber=1&uploadId=${encodeURIComponent(onePart)}`, MPU_PART);
  await create('mpu/no-part.bin');
  await create('mpu/twice.bin');
  await create('mpu/twice.bin');
}

(async () => {
  const api = await request.newContext({ baseURL: BASE });
  const put = async (instance, key, body, headers) => {
    const res = await api.put(`s3?instance=${encodeURIComponent(instance)}&key=${encodeURIComponent(key)}`, { data: Buffer.from(body), headers });
    if (!res.ok()) throw new Error(`${instance}/${key}: ${res.status()} ${await res.text()}`);
  };
  // The bucket "default" keeps the versions of an object where the provider can: the files of versions/ have several.
  for (const [instance, provider] of Object.entries(PROVIDERS)) {
    if (provider.versioning) await s3(instance, 'PUT', '/default', 'versioning=', Buffer.from('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'));
  }
  // The providers get their smoke objects at the same time: the versions need one second between them.
  await Promise.all(Object.entries(PROVIDERS).map(async ([instance, provider]) => {
    for (const [key, bodies] of Object.entries(SMOKE(instance))) {
      for (let version = 0; version < bodies.length; version += 1) {
        const headers = { 'Content-Type': key.endsWith('.json') ? 'application/json' : 'text/plain' };
        if (provider.tags && key === 'smoke/hello.txt') headers['X-Amz-Tagging'] = 'team=qa&env=test';
        await put(instance, key, bodies[version], headers);
        if (version + 1 < bodies.length) await new Promise(resolve => setTimeout(resolve, 1100));
      }
    }
  }));
  for (const [instance, provider] of Object.entries(PROVIDERS)) {
    await s3(instance, 'PUT', '/default/copy/source.bin', '', COPY_SOURCE, { ...COPY_HEADERS, ...(provider.tags ? { 'x-amz-tagging': 'team=copy' } : {}) });
  }
  for (const [instance, provider] of Object.entries(PROVIDERS)) {
    const tags = provider.tags ? { 'x-amz-tagging': 'team=meta' } : {};
    await s3(instance, 'PUT', '/default/meta/small.txt', '', Buffer.from(META_SMALL), { 'content-type': 'text/plain', ...META_HEADERS, ...tags });
    await s3(instance, 'PUT', '/default/meta/large.bin', '', META_LARGE, { 'content-type': 'application/octet-stream', ...META_HEADERS, ...tags });
    await s3(instance, 'PUT', '/default/meta/conflict.txt', '', Buffer.from('conflict\n'), { 'content-type': 'text/plain', ...META_HEADERS });
  }
  await Promise.all(Object.entries(PROVIDERS).filter(([, provider]) => provider.versioning).map(async ([instance]) => {
    await s3(instance, 'PUT', '/default/meta/versioned.txt', '', Buffer.from('versioned metadata v1\n'), { 'content-type': 'text/plain', 'x-amz-meta-rev': '1' });
    await new Promise(resolve => setTimeout(resolve, 1100));
    await s3(instance, 'PUT', '/default/meta/versioned.txt', '', Buffer.from('versioned metadata v2\n'), { 'content-type': 'text/markdown', 'x-amz-meta-rev': '2' });
  }));
  await Promise.all(Object.entries(PROVIDERS).filter(([, provider]) => provider.versioning).map(async ([instance]) => {
    await put(instance, 'copy/versioned.bin', Buffer.alloc(20000, 'a'), { 'Content-Type': 'application/octet-stream' });
    await new Promise(resolve => setTimeout(resolve, 1100));
    await put(instance, 'copy/versioned.bin', Buffer.alloc(20000, 'b'), { 'Content-Type': 'application/octet-stream' });
  }));
  for (const [instance, files] of Object.entries(objects)) {
    for (const [key, body] of Object.entries(files)) {
      const type = key.endsWith('.svg') ? 'image/svg+xml' : key.endsWith('.json') ? 'application/json' : key.endsWith('.md') ? 'text/markdown' : key.endsWith('.csv') ? 'text/csv' : 'application/octet-stream';
      const headers = { 'Content-Type': type };
      if (instance === 'seaweedfs-main' && TAGGED[key]) headers['X-Amz-Tagging'] = TAGGED[key];
      const res = await api.put(`s3?instance=${encodeURIComponent(instance)}&key=${encodeURIComponent(key)}`, { data: Buffer.from(body), headers });
      if (!res.ok()) throw new Error(`${instance}/${key}: ${res.status()} ${await res.text()}`);
    }
  }
  for (const [key, bodies] of Object.entries(VERSION_BODIES)) {
    for (let version = 1; version <= bodies.length; version += 1) {
      const headers = { 'Content-Type': key.endsWith('.json') ? 'application/json' : key.endsWith('.csv') ? 'text/csv' : key.endsWith('.bin') ? 'application/octet-stream' : 'text/plain' };
      if (VERSION_TAGS[key]?.[version - 1]) headers['X-Amz-Tagging'] = VERSION_TAGS[key][version - 1];
      const res = await api.put(`s3?instance=seaweedfs-main&key=${encodeURIComponent(key)}`, { data: bodies[version - 1], headers });
      if (!res.ok()) throw new Error(`${key}: ${res.status()} ${await res.text()}`);
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }
  for (const instance of Object.keys(PROVIDERS)) {
    await put(instance, 'mpu/readme.txt', 'The incomplete uploads of this folder are test data.\n', { 'Content-Type': 'text/plain' });
    await seedIncompleteUploads(instance);
  }
  // The buckets "locked" have Object Lock from their creation. Each test of Object Lock makes its own objects: the seed
  // only gives the folder lock/ an object, so that the page opens it.
  for (const instance of Object.keys(LOCKED)) {
    await put(instance, 'lock/readme.txt', 'The tests of Object Lock make their objects in this folder.\n', { 'Content-Type': 'text/plain' });
  }
  // The buckets "encrypted" keep the versions of an object: the tests of the restore need them.
  for (const instance of Object.keys(ENCRYPTED)) {
    await s3(instance, 'PUT', '/encrypted', 'versioning=', Buffer.from('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'));
  }
  // The objects of the folder enc/ of the buckets "default": an object with a key of the client (SSE-C) on SeaweedFS and
  // Garage (MinIO refuses SSE-C over HTTP), and an object with SSE-KMS on MinIO (SeaweedFS answers 500 to aws:kms). The
  // key of the client is random, lives only in this process, and nobody can read the object again.
  const customerKey = crypto.randomBytes(32);
  const customerHeaders = {
    'content-type': 'text/plain',
    'x-amz-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-server-side-encryption-customer-key': customerKey.toString('base64'),
    'x-amz-server-side-encryption-customer-key-md5': crypto.createHash('md5').update(customerKey).digest('base64'),
  };
  for (const instance of ['seaweedfs-main', 'garage-main']) {
    await s3(instance, 'PUT', '/default/enc/customer-key.txt', '', Buffer.from('An object with a key of the client.\n'), customerHeaders);
  }
  await s3('minio-main', 'PUT', '/default/enc/kms.txt', '', Buffer.from('An object with SSE-KMS.\n'), { 'content-type': 'text/plain', 'x-amz-server-side-encryption': 'aws:kms' });
  await s3('seaweedfs-main', 'PUT', '/default', 'lifecycle=', Buffer.from(SEED_LIFECYCLE));
  console.log('seeded');
  await api.dispose();
})().catch(e => { console.error(e); process.exit(1); });
