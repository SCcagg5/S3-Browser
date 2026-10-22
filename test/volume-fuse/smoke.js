// The browser smoke test of a volume on a real FUSE mount of SeaweedFS (weed mount). run.sh runs it in the Playwright
// container, on the network of the service "mount". The volume "sw" is /mnt/sw/s3b of that container (config.hcl):
// the test sees it only through the page and the API. It makes the folder smoke/ and removes it at the end.
const { chromium } = require('playwright');
const assert = require('assert/strict');
const crypto = require('crypto');
const BASE = process.env.BASE;
const VOLUME = '-/volume/sw/';
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const steps = [];
const step = (name, fn) => steps.push({ name, fn });

async function open(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dataTable, .empty', { timeout: 15000 });
}

// A FUSE mount can show a change with a delay: the checks of the API wait up to 15 seconds.
async function eventually(check, what) {
  for (let tries = 0; tries < 150; tries += 1) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`${what}: no change after 15 seconds`);
}

async function listNames(page, prefix) {
  const answer = await (await page.request.get(`${BASE}api/list?instance=sw&prefix=${encodeURIComponent(prefix)}`)).json();
  return (answer.items || []).map(item => item.name).sort();
}

async function getBody(page, key, headers = {}) {
  const response = await page.request.get(`${BASE}s3?instance=sw&key=${encodeURIComponent(key)}`, { headers });
  return { status: response.status(), headers: response.headers(), body: await response.body() };
}

async function rowAction(page, name, action, value) {
  await page.click(`tr[data-name="${name}"] .bb-kebab`);
  await page.click(`.bb-menu.is-open .bb-menu-item >> text=${action}`);
  if (value !== undefined) await page.fill('.bb-overlay .bb-input', value);
  await page.click('.bb-overlay .bb-btn-primary');
}

let page;

step('the volume on the mount is an instance with the host word volume and the usage of the mount', async () => {
  const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === 'sw');
  assert.equal(info.provider, 'fs');
  assert.equal(info.host, 'volume');
  assert.equal(info.tagsSupported, false);
  const usage = await (await page.request.get(`${BASE}api/usage?instance=sw`)).json();
  assert.equal(usage.source, 'statfs');
  assert.equal(usage.storage.scope, 'filesystem');
  assert.ok(usage.storage.totalBytes > 0, JSON.stringify(usage));
  // A FUSE file system can count with a delay: the capacity is approximate, with its reason.
  assert.equal(usage.storage.approximate, true, JSON.stringify(usage));
  assert.match(usage.storage.approximateReason, /FUSE or network file system/);
  console.log(`      statfs of the mount: ${usage.storage.usedBytes} bytes used of ${usage.storage.totalBytes}, ${usage.storage.freeBytes} free`);
  await open(page, VOLUME);
  await page.waitForSelector('.storageSwitcher__facts [data-fact="usage"]');
});

step('New folder makes a folder on the mount, and a small upload is checked with SHA-256', async () => {
  await page.click('#actionsButton');
  await page.click('#newFolderItem');
  await page.fill('.bb-overlay .bb-input', 'smoke');
  await page.click('.bb-overlay .bb-btn-primary');
  await page.waitForSelector('tr[data-name="smoke"]');
  await page.click('tr[data-name="smoke"] .nameLink');
  await page.waitForSelector('.empty, .dataTable');
  await page.setInputFiles('#fileInput', [{ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from weed mount\n') }]);
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 30000 });
  assert.match(await page.textContent('.uploadDock .summary'), /^1 file uploaded \([\d.]+ B\), 1 checked with SHA-256\.$/);
  await page.click('.uploadDock .button >> text=Close');
  await page.waitForSelector('tr[data-name="hello.txt"]');
  assert.equal((await getBody(page, 'smoke/hello.txt')).body.toString(), 'hello from weed mount\n');
});

step('rename and copy of a file, and a read with a range', async () => {
  await rowAction(page, 'hello.txt', 'Rename', 'renamed.txt');
  await page.waitForSelector('tr[data-name="renamed.txt"]');
  await eventually(async () => !(await listNames(page, 'smoke/')).includes('hello.txt'), 'the source of the rename');
  await rowAction(page, 'renamed.txt', 'Copy', 'copy.txt');
  await page.waitForSelector('tr[data-name="copy.txt"]');
  assert.equal((await getBody(page, 'smoke/copy.txt')).body.toString(), 'hello from weed mount\n');
  const range = await getBody(page, 'smoke/copy.txt', { Range: 'bytes=6-9' });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 6-9/22');
  assert.equal(range.body.toString(), 'from');
  assert.match(range.headers.etag, /^W\/"22-\d+"$/);
});

step('a large upload resumes after a lost chunk; its temporary file is an incomplete upload until the end', async () => {
  const content = Buffer.alloc(40 * 1024 * 1024);
  for (let index = 0; index < content.length; index += 4096) content.writeUInt32BE(index, index);
  let chunks = 0;
  let during = null;
  await page.route(/\/api\/uploads$/, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    chunks += 1;
    if (chunks === 2) {
      during = await (await page.request.get(`${BASE}api/multiparts?instance=sw&prefix=smoke/`)).json();
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await page.setInputFiles('#fileInput', [{ name: 'large.bin', mimeType: 'application/octet-stream', buffer: content }]);
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 180000 });
  await page.unroute(/\/api\/uploads$/);
  await page.click('.uploadDock .button >> text=Close');
  assert.ok(chunks >= 3, `chunks: ${chunks}`);
  assert.equal(during.uploads.length, 1, JSON.stringify(during));
  assert.equal(during.uploads[0].key, 'smoke/large.bin');
  assert.equal(during.uploads[0].active, true);
  const stored = await getBody(page, 'smoke/large.bin');
  assert.equal(stored.body.length, content.length);
  assert.equal(sha256(stored.body), sha256(content));
  assert.equal((await (await page.request.get(`${BASE}api/multiparts?instance=sw&prefix=smoke/`)).json()).uploads.length, 0);
  // The count of the folder of the volume: the two files of smoke/ (the copy of hello.txt and the large file).
  let usage;
  await eventually(async () => {
    usage = await (await page.request.get(`${BASE}api/usage?instance=sw`)).json();
    return usage.selfState === 'ready' && usage.selfBytes === content.length + 2 * 22;
  }, 'the size of the folder of the volume');
  assert.equal(usage.usedObjects, 3);
  console.log(`      the volume holds ${usage.selfBytes} bytes in ${usage.usedObjects} files; statfs: ${usage.storage.usedBytes} of ${usage.storage.totalBytes}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.storageSwitcher__facts [data-fact="usage"][data-used-bytes]');
  // The selector shows the amount that the folder holds; the information page gives the files and the storage.
  assert.equal(await page.textContent('.storageSwitcher__facts .bucketUsage__amount'), '40 MB');
  await page.click('.storageSwitcher__facts [data-fact="usage"]');
  await page.waitForURL(/\?info$/);
  await page.waitForSelector('[data-gauge="storage"]');
  assert.match(await page.textContent('[data-gauge="holds"]'), /This volume holds.*40 MB.*3 files/s);
  assert.match(await page.textContent('[data-gauge="storage"]'), /Approximate.*~[\d.]+ (B|KB|MB|GB) used of [\d.]+ (GB|TB).*Free[\d.]+ (GB|TB)/s);
  await page.goBack({ waitUntil: 'networkidle' });
});

step('copy, rename and delete of a folder with a nested folder', async () => {
  for (const key of ['smoke/tree/a.txt', 'smoke/tree/deep/b.txt']) {
    const response = await page.request.put(`${BASE}s3?instance=sw&key=${encodeURIComponent(key)}`, { data: Buffer.from(key) });
    assert.equal(response.status(), 204, key);
  }
  await page.request.put(`${BASE}s3?instance=sw&key=${encodeURIComponent('smoke/tree/void/')}`, { data: Buffer.alloc(0) });
  await open(page, `${VOLUME}smoke/`);
  await rowAction(page, 'tree', 'Copy', 'tree-copy');
  await page.waitForSelector('tr[data-name="tree-copy"]', { timeout: 60000 });
  await eventually(async () => (await listNames(page, 'smoke/tree-copy/')).join(',') === 'a.txt,deep/,void/', 'the copy of the folder');
  await rowAction(page, 'tree-copy', 'Rename', 'tree-moved');
  await page.waitForSelector('tr[data-name="tree-moved"]', { timeout: 60000 });
  await eventually(async () => !(await listNames(page, 'smoke/')).includes('tree-copy/'), 'the source of the move of the folder');
  assert.equal((await getBody(page, 'smoke/tree-moved/deep/b.txt')).body.toString(), 'smoke/tree/deep/b.txt');
  await rowAction(page, 'tree-moved', 'Delete');
  await page.waitForSelector('tr[data-name="tree-moved"]', { state: 'detached', timeout: 60000 });
  await eventually(async () => !(await listNames(page, 'smoke/')).includes('tree-moved/'), 'the delete of the folder');
});

step('the delete of the folder smoke/ leaves the volume empty', async () => {
  await open(page, VOLUME);
  await rowAction(page, 'smoke', 'Delete');
  await page.waitForSelector('tr[data-name="smoke"]', { state: 'detached', timeout: 60000 });
  await eventually(async () => (await listNames(page, '')).length === 0, 'the delete of smoke/');
  const usage = await (await page.request.get(`${BASE}api/usage?instance=sw&fresh=1`)).json();
  console.log(`      after the writes: the volume holds ${usage.selfBytes} bytes (${usage.selfState}); statfs: ${usage.storage
    ? `${usage.storage.usedBytes} bytes used of ${usage.storage.totalBytes}` : usage.storageError?.message}`);
});

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let failed = 0;
  for (const { name, fn } of steps) {
    const started = Date.now();
    try {
      await fn();
      console.log(`ok    ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${name}\n      ${String(error.message).split('\n').slice(0, 6).join('\n      ')}`);
      break;
    }
  }
  if (!failed && errors.length) {
    failed += 1;
    console.log(`FAIL  page errors: ${errors.join('; ')}`);
  }
  await browser.close();
  console.log(failed ? 'the smoke test on the FUSE mount failed' : `all ${steps.length} steps passed`);
  process.exit(failed ? 1 : 0);
})();
