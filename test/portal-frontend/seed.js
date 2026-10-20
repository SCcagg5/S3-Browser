// Puts the test objects in the two SeaweedFS buckets through the API of S3-Browser (PUT /s3).
const crypto = require('crypto');
const fs = require('fs');
const { request } = require('playwright');
const BASE = process.env.BASE;
const S3_HOST = 'seaweedfs:8333';
const ACCESS_KEY = 'GK0123456789abcdef01234567';

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

// A request to the S3 API of SeaweedFS, signed with SigV4 (the lifecycle has no route in S3-Browser).
async function s3(method, path, query, body) {
  const secret = fs.readFileSync('/secrets/s3_secret_access_key', 'utf8').trim();
  const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers = {
    host: S3_HOST,
    'content-md5': crypto.createHash('md5').update(body).digest('base64'),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now,
  };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, query, names.map(name => `${name}:${headers[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), 'us-east-1'), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope},SignedHeaders=${names.join(';')},Signature=${hmac(signingKey, toSign).toString('hex')}`;
  const response = await fetch(`http://${S3_HOST}${path}?${query}`, { method, headers, body });
  if (!response.ok) throw new Error(`${method} ${path}?${query}: ${response.status} ${await response.text()}`);
}

// The lifecycle of the bucket "default": the objects of logs/ with the tag retention=30d expire after 30 days.
const LIFECYCLE = '<LifecycleConfiguration><Rule><ID>expire-logs</ID><Status>Enabled</Status><Filter><And><Prefix>logs/</Prefix>' +
  '<Tag><Key>retention</Key><Value>30d</Value></Tag></And></Filter><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>';

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

(async () => {
  const api = await request.newContext({ baseURL: BASE });
  // The bucket "default" keeps the versions of an object: the files of versions/ have several.
  await s3('PUT', '/default', 'versioning=', Buffer.from('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'));
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
  await s3('PUT', '/default', 'lifecycle=', Buffer.from(LIFECYCLE));
  console.log('seeded');
  await api.dispose();
})().catch(e => { console.error(e); process.exit(1); });
