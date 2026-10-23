// Requests to the S3 API of the providers of the test stack, signed with SigV4. seed.js and browser-tests.js use
// them for what has no route in Stowr, or to check the result of a page action on the provider.
const crypto = require('crypto');
const fs = require('fs');
const { PROVIDERS, LOCKED, ENCRYPTED } = require('./providers');
const ACCESS_KEY = 'GK0123456789abcdef01234567';

// A request to the provider of an instance (the versioning and the lifecycle of a bucket have no route in
// Stowr). The instance is a key of PROVIDERS, LOCKED or ENCRYPTED. The extra headers are signed too. It gives the
// status, the headers (names in lowercase) and the text of the answer.
async function s3Raw(instance, method, path, query, body = Buffer.alloc(0), extra = {}) {
  const { host, region } = PROVIDERS[instance] || LOCKED[instance] || ENCRYPTED[instance];
  const secret = fs.readFileSync('/secrets/s3_secret_access_key', 'utf8').trim();
  const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers = {
    host,
    'content-md5': crypto.createHash('md5').update(body).digest('base64'),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now,
  };
  for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
  const names = Object.keys(headers).sort();
  const canonical = [method, path, query, names.map(name => `${name}:${headers[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope},SignedHeaders=${names.join(';')},Signature=${hmac(signingKey, toSign).toString('hex')}`;
  const response = await fetch(`http://${host}${path}?${query}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
  const text = await response.text();
  return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text };
}

// Like s3Raw, and it gives the text of the answer. It fails on an error status.
async function s3(instance, method, path, query, body = Buffer.alloc(0), extra = {}) {
  const answer = await s3Raw(instance, method, path, query, body, extra);
  if (!answer.ok) throw Object.assign(new Error(`${method} ${path}?${query}: ${answer.status} ${answer.text}`), { status: answer.status, text: answer.text });
  return answer.text;
}

// The headers of the HEAD answer of an object (names in lowercase). The path has the bucket, for example
// '/encrypted/enc/a.txt'. It fails on an error status.
async function s3Head(instance, path, query = '') {
  const answer = await s3Raw(instance, 'HEAD', path, query);
  if (!answer.ok) throw new Error(`HEAD ${path}: ${answer.status}`);
  return answer.headers;
}

// The lifecycle of the bucket "default" of SeaweedFS that seed.js writes: the objects of logs/ with the tag
// retention=30d expire after 30 days. The tests of the tags read it, and the tests of the lifecycle editor restore it.
const SEED_LIFECYCLE = '<LifecycleConfiguration><Rule><ID>expire-logs</ID><Status>Enabled</Status><Filter><And><Prefix>logs/</Prefix>' +
  '<Tag><Key>retention</Key><Value>30d</Value></Tag></And></Filter><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>';

// The lifecycle configuration of the bucket "default" of an instance as the provider sends it, or '' for none.
async function readLifecycle(instance) {
  try {
    return await s3(instance, 'GET', '/default', 'lifecycle=');
  } catch (error) {
    if (error.status === 404 && /NoSuchLifecycleConfiguration/.test(error.text)) return '';
    throw error;
  }
}

// Writes the configuration, or deletes it for ''.
async function writeLifecycle(instance, xml) {
  if (!xml) await s3(instance, 'DELETE', '/default', 'lifecycle=');
  else await s3(instance, 'PUT', '/default', 'lifecycle=', Buffer.from(xml));
}

// The configuration of the seed: SEED_LIFECYCLE on SeaweedFS, none on the other providers.
const restoreLifecycle = instance => writeLifecycle(instance, instance === 'seaweedfs-main' ? SEED_LIFECYCLE : '');

module.exports = { s3, s3Raw, s3Head, SEED_LIFECYCLE, readLifecycle, writeLifecycle, restoreLifecycle };
