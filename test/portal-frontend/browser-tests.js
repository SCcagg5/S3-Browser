// Browser tests of the "portal" interface (server.frontend = "portal"). They cover four parts:
// 1 the theme control, 2 the breadcrumb, 3 the bulk upload, 4 the access behaviour of 2.0.0.
// run.sh starts S3-Browser and Garage, puts the test objects (seed.js) and runs this file in the Playwright container.
// The tests change the answers of the server with page.route where a case needs it (403, 401, no answer, access).
const { chromium } = require('playwright');
const assert = require('assert/strict');
const BASE = process.env.BASE;
const MAIN = '-/garage/garage-main/';
const ONLY = process.env.ONLY || '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let browser;

async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', ...options });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  return page;
}

async function open(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dataTable, .empty', { timeout: 15000 });
}

function files(count, prefix, size = 1500) {
  return Array.from({ length: count }, (_, i) => ({ name: `${prefix}-${String(i + 1).padStart(4, '0')}.txt`, mimeType: 'text/plain', buffer: Buffer.alloc(size + (i % 97), 65 + (i % 26)) }));
}

async function listKeys(page, instance, prefix) {
  const keys = [];
  let token = '';
  do {
    const url = `${BASE}api/list?instance=${instance}&prefix=${encodeURIComponent(prefix)}&delimiter=%2F${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`;
    const data = await (await page.request.get(url)).json();
    for (const item of data.items || []) if (item.type !== 'prefix') keys.push(item.key);
    token = data.nextContinuationToken || '';
  } while (token);
  return keys;
}

async function deletePrefix(page, instance, prefix) {
  for (const key of await listKeys(page, instance, prefix)) {
    await page.request.delete(`${BASE}s3?instance=${instance}&key=${encodeURIComponent(key)}`);
  }
}

// Counts the PUT requests in flight at the same time (upload concurrency).
async function watchPuts(page, { delay = 0, fail = null } = {}) {
  const stats = { active: 0, max: 0, total: 0 };
  await page.route(/\/s3\?/, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    stats.total += 1;
    const verdict = fail ? fail(route.request().url(), stats) : null;
    if (verdict === 'abort') return route.abort('connectionrefused');
    if (verdict) return route.fulfill(verdict);
    stats.active += 1;
    stats.max = Math.max(stats.max, stats.active);
    try {
      if (delay) await sleep(delay);
      await route.continue();
    } finally {
      stats.active -= 1;
    }
  });
  return stats;
}

// Polls a function in the page (the page has a strict CSP, so no string evaluation).
async function until(page, fn, arg, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error(`timeout: ${fn.toString().slice(0, 120)}`);
    await sleep(100);
  }
}

// The number of visible elements whose own text contains a string.
const visibleText = (page, text) => page.evaluate(value => Array.from(document.querySelectorAll('body *'))
  .filter(node => Array.from(node.childNodes).some(child => child.nodeType === 3 && child.textContent.includes(value)))
  .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.visually-hidden')).length, text);

const forbidden = action => ({ status: 403, json: { error: { code: 'forbidden', action, message: `The action ${action} is not allowed.` } } });

// ------------------------------------------------------------------------------------------------------------------
// 1. Theme control: System / Dark / Light, saved in this browser, applied before the first paint
// ------------------------------------------------------------------------------------------------------------------

test('theme: System follows the colour scheme of the OS', async () => {
  for (const [scheme, background] of [['dark', 'rgb(13, 15, 18)'], ['light', 'rgb(246, 247, 249)']]) {
    const page = await newPage({ colorScheme: scheme });
    await open(page, MAIN);
    assert.equal(await page.getAttribute('html', 'data-theme'), null);
    assert.equal(await page.getAttribute('[data-theme-value="system"]', 'aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), background);
    await page.context().close();
  }
});

test('theme: a choice is saved in the browser and applies again after a reload', async () => {
  const page = await newPage({ colorScheme: 'dark' });
  await open(page, MAIN);
  await page.click('[data-theme-value="light"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  assert.equal(await page.evaluate(() => localStorage.getItem('portal.theme')), 'light');
  assert.equal(await page.getAttribute('[data-theme-value="light"]', 'aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 247, 249)');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await page.click('[data-theme-value="system"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('portal.theme')), null);
  assert.equal(await page.getAttribute('html', 'data-theme'), null);
  await page.context().close();
});

test('theme: the saved theme is on <html> before the body exists (no flash)', async () => {
  for (const [scheme, saved] of [['dark', 'light'], ['light', 'dark']]) {
    const page = await newPage({ colorScheme: scheme });
    await page.addInitScript(value => {
      try { localStorage.setItem('portal.theme', value); } catch (_) {}
      window.__themeAtBody = 'unset';
      new MutationObserver((records, observer) => {
        if (document.body) {
          window.__themeAtBody = document.documentElement.getAttribute('data-theme');
          window.__stylesAtBody = document.styleSheets.length;
          observer.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    }, saved);
    await open(page, MAIN);
    assert.equal(await page.evaluate(() => window.__themeAtBody), saved);
    await page.context().close();
  }
});

test('theme: the preview page and the 404 page share the choice', async () => {
  const page = await newPage({ colorScheme: 'light' });
  await open(page, MAIN);
  await page.click('[data-theme-value="dark"]');
  await page.goto(`${BASE}${MAIN}reports/2026/q3/summary.md`, { waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  assert.equal(await page.getAttribute('.previewBar [data-theme-value="dark"]', 'aria-pressed'), 'true');
  await page.goto(`${BASE}no-such-page`, { waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 2. Breadcrumb: the display name of the bucket is the root crumb, with a root marker
// ------------------------------------------------------------------------------------------------------------------

test('breadcrumb: at the root, the root crumb is the bucket display name and the current page', async () => {
  const page = await newPage();
  await open(page, MAIN);
  const root = page.locator('.crumb--root');
  assert.equal(await page.locator('.crumbs .crumb').count(), 1);
  assert.match(await root.innerText(), /Garage - primary\s*root/i);
  assert.equal(await root.getAttribute('aria-current'), 'page');
  assert.equal(await root.getAttribute('aria-label'), 'Garage - primary, bucket root');
  assert.equal(await page.textContent('#folderTitle'), 'Garage - primary');
  await page.context().close();
});

test('breadcrumb: in a folder, the root crumb leads back to the bucket root', async () => {
  const page = await newPage();
  await open(page, `${MAIN}reports/2026/q3/`);
  const names = await page.locator('.crumbs .crumb').allInnerTexts();
  assert.deepEqual(names.map(name => name.replace(/\s+/g, ' ').trim()), ['Garage - primary ROOT', 'reports', '2026', 'q3'].map(n => n.replace('ROOT', (names[0].match(/root/i) || ['root'])[0])));
  assert.equal(await page.getAttribute('.crumb--root', 'aria-current'), null);
  assert.equal(await page.getAttribute('.crumbs .crumb:last-child', 'aria-current'), 'page');
  await page.click('.crumb--root');
  await until(page, () => location.pathname.endsWith('/-/garage/garage-main/'));
  await page.waitForSelector('tr[data-name="reports"]');
  assert.equal(await page.getAttribute('.crumb--root', 'aria-current'), 'page');
  await page.goBack();
  await until(page, () => document.querySelector('#folderTitle').textContent === 'q3');
  await page.context().close();
});

test('breadcrumb: a deep path keeps the root and puts the middle folders in a menu', async () => {
  const page = await newPage();
  await open(page, `${MAIN}archive/deep/level-3/level-4/level-5/`);
  assert.equal(await page.locator('.crumb--root').count(), 1);
  assert.deepEqual(await page.locator('.crumbs > .crumb:not(.crumb--root)').allInnerTexts(), ['level-4', 'level-5']);
  await page.click('.crumb--more');
  assert.deepEqual(await page.locator('.crumbs .menu .menu__item').allInnerTexts(), ['archive', 'deep', 'level-3']);
  await page.click('.crumbs .menu .menu__item >> text=deep');
  await until(page, () => document.querySelector('#folderTitle').textContent === 'deep');
  await page.context().close();
});

test('breadcrumb: another bucket tab gives its own root crumb, and the preview path starts at the bucket', async () => {
  const page = await newPage();
  await open(page, MAIN);
  await page.click('.contentTabs__tab >> text=Garage - archive');
  await until(page, () => document.querySelector('.crumb--root')?.textContent.includes('Garage - archive'));
  assert.equal(await page.getAttribute('.contentTabs__tab[data-instance="garage-archive"]', 'aria-current'), 'page');
  await page.goto(`${BASE}${MAIN}reports/2026/q3/summary.md`, { waitUntil: 'networkidle' });
  assert.equal(await page.textContent('#instanceMeta'), 'Garage - primary');
  assert.equal((await page.textContent('#docPrefix')).trim(), '/ reports / 2026 / q3');
  assert.equal((await page.textContent('#backBtn')).trim(), 'q3');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 3. Bulk upload of hundreds of files
// ------------------------------------------------------------------------------------------------------------------

test('upload: 300 files, bounded concurrency and rendering, progress, summary', async () => {
  const page = await newPage();
  await deletePrefix(page, 'garage-main', 'bulk/');
  await open(page, `${MAIN}bulk/`);
  const puts = await watchPuts(page, { delay: 60 });
  await page.setInputFiles('#fileInput', files(300, 'bulk'));
  await page.waitForSelector('.uploadDock[data-state="running"]');
  // During the upload: overall figures, at most 4 rows of files in progress.
  await until(page, () => /^\d+ \/ 300$/.test(document.querySelector('[data-stat="files"]')?.textContent || ''));
  let maxRows = 0;
  for (let i = 0; i < 20; i += 1) {
    maxRows = Math.max(maxRows, await page.locator('.uploadDock .fileList:not(.fileList--failed) > li').count());
    await sleep(100);
  }
  assert.ok(maxRows >= 1 && maxRows <= 4, `rows in progress: ${maxRows}`);
  assert.match(await page.textContent('[data-stat="rate"]'), /\/s$|measuring/);
  assert.match(await page.textContent('[data-stat="bytes"]'), /KB \/ [\d.]+ KB/);
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 120000 });
  assert.ok(puts.max <= 4, `PUT requests at the same time: ${puts.max}`);
  assert.equal(puts.total, 300);
  assert.match(await page.textContent('.uploadDock .summary'), /^300 files uploaded \([\d.]+ KB\)\.$/);
  assert.equal(await page.textContent('[data-stat="files"]'), '300 / 300');
  assert.ok((await page.locator('.uploadDock li').count()) <= 4);
  assert.equal((await listKeys(page, 'garage-main', 'bulk/')).length, 300);
  // The listing refreshes at the end of the batch.
  await until(page, () => /300 files/.test(document.querySelector('#folderCount').textContent));
  await page.click('.uploadDock .button >> text=Close');
  assert.equal(await page.isHidden('#uploadDock'), true);
  assert.deepEqual(page.errors, []);
  await deletePrefix(page, 'garage-main', 'bulk/');
  await page.context().close();
});

test('upload: failed files with their reasons, bounded list, then "Retry failed"', async () => {
  const page = await newPage();
  await deletePrefix(page, 'garage-main', 'retry/');
  await open(page, `${MAIN}retry/`);
  let refuse = true;
  const puts = await watchPuts(page, {
    fail: url => {
      if (!refuse) return null;
      if (/key=retry%2Fdenied-/.test(url)) return forbidden('objects.write');
      if (/key=retry%2Fbroken-/.test(url)) return { status: 500, json: { error: { code: 'upstream', message: 'The provider refused the object.' } } };
      return null;
    }
  });
  await page.setInputFiles('#fileInput', [...files(55, 'denied'), ...files(5, 'broken'), ...files(40, 'fine')]);
  await page.waitForSelector('.uploadDock[data-state="failed"]', { timeout: 60000 });
  assert.equal(await page.textContent('.uploadDock__title'), '60 of 100 files failed');
  assert.equal(await page.locator('.fileList--failed > li:not(.fileList__more)').count(), 50);
  assert.equal(await page.textContent('.fileList--failed .fileList__more'), 'and 10 other files');
  assert.equal(await page.textContent('.fileList--failed li:first-child .fileList__reason'), 'Not allowed: objects.write (403).');
  const reasons = await page.locator('.fileList--failed .fileList__reason').allInnerTexts();
  assert.ok(reasons.every(reason => reason.length > 0));
  assert.match(await page.textContent('.uploadDock .summary'), /^40 files uploaded \([\d.]+ KB\), 60 failed\.$/);
  refuse = false;
  await page.click('.uploadDock .button >> text=Retry failed');
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 60000 });
  assert.equal(await page.isHidden('.fileList--failed'), true);
  assert.equal((await listKeys(page, 'garage-main', 'retry/')).length, 100);
  assert.equal(puts.total, 160);
  await deletePrefix(page, 'garage-main', 'retry/');
  await page.context().close();
});

test('upload: cancel stops the queue and the summary counts the canceled files', async () => {
  const page = await newPage();
  await deletePrefix(page, 'garage-main', 'cancel/');
  await open(page, `${MAIN}cancel/`);
  const puts = await watchPuts(page, { delay: 400 });
  await page.setInputFiles('#fileInput', files(200, 'cancel'));
  await until(page, () => Number((document.querySelector('[data-stat="files"]')?.textContent || '0').split(' ')[0]) >= 8);
  await page.click('.uploadDock .button--danger');
  await page.waitForSelector('.uploadDock[data-state="canceled"], .uploadDock[data-state="done"]', { timeout: 30000 });
  const sent = puts.total;
  await sleep(1200);
  assert.equal(puts.total, sent, 'no request after the cancel');
  assert.ok(sent < 200);
  assert.match(await page.textContent('.uploadDock .summary'), /files? uploaded .*, \d+ canceled\.$/);
  assert.equal(await page.textContent('.uploadDock__title'), 'Upload canceled');
  await deletePrefix(page, 'garage-main', 'cancel/');
  await page.context().close();
});

test('upload: an unreachable server gives one message, the queue waits, then the upload continues', async () => {
  const page = await newPage();
  await deletePrefix(page, 'garage-main', 'offline/');
  await open(page, `${MAIN}offline/`);
  let down = false;
  let tripped = false;
  const puts = await watchPuts(page, {
    delay: 30,
    fail: (url, stats) => {
      if (!tripped && stats.total > 30) {
        tripped = true;
        down = true;
      }
      return down ? 'abort' : null;
    }
  });
  await page.route(/healthz/, route => (down ? route.abort('connectionrefused') : route.continue()));
  await page.setInputFiles('#fileInput', files(150, 'offline'));
  await page.waitForSelector('.uploadDock[data-state="offline"]', { timeout: 60000 });
  await sleep(2500);
  // One message: the dock owns it; the page shows no second notice and no file is marked as failed.
  assert.equal(await visibleText(page, 'The server does not answer'), 1);
  assert.equal(await page.locator('#notices > *').count(), 0);
  assert.equal(await page.isHidden('.fileList--failed'), true);
  assert.match(await page.textContent('.uploadDock .callout'), /files? wait in the queue and nothing is lost/);
  assert.equal(await page.textContent('[data-stat="rate"]'), 'paused');
  down = false;
  await page.click('.uploadDock .callout .button >> text=Try now');
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 60000 });
  assert.match(await page.textContent('.uploadDock .summary'), /^150 files uploaded/);
  assert.equal((await listKeys(page, 'garage-main', 'offline/')).length, 150);
  assert.ok(puts.total > 150);
  await deletePrefix(page, 'garage-main', 'offline/');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 4. Access behaviour of 2.0.0: access of /api/list, hidden buckets, 401 and 403
// ------------------------------------------------------------------------------------------------------------------

async function withFolderAccess(page, access) {
  await page.route(/\/api\/list\?/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = access;
    await route.fulfill({ response, json: body });
  });
}

test('access: read only in a folder hides the upload and every change of the row menus', async () => {
  const page = await newPage();
  await withFolderAccess(page, { read: true, write: false, delete: false });
  await open(page, `${MAIN}reports/2026/q3/`);
  assert.equal(await page.isHidden('#uploadWrap'), true);
  assert.match(await page.textContent('#accessBadge'), /Read only/);
  const items = await page.locator('tr[data-name="orders.csv"] .bb-menu-item').allInnerTexts();
  assert.deepEqual(items.map(item => item.trim()), ['Details', 'Download']);
  const folderItems = await page.locator('tr').first().locator('.bb-menu-item').allInnerTexts();
  assert.ok(!folderItems.some(item => /Delete|Rename|Copy/.test(item)));
  // A file dropped on a read-only folder is refused.
  assert.equal(await page.evaluate(() => BB.page.state.folderAccess.write), false);
  await page.context().close();
});

test('access: write without delete keeps the upload and the copy, and hides the delete and the rename', async () => {
  const page = await newPage();
  await withFolderAccess(page, { read: true, write: true, delete: false });
  await open(page, `${MAIN}reports/2026/q3/`);
  assert.equal(await page.isVisible('#uploadButton'), true);
  assert.match(await page.textContent('#accessBadge'), /No delete/);
  const items = (await page.locator('tr[data-name="orders.csv"] .bb-menu-item').allInnerTexts()).map(item => item.trim());
  assert.ok(items.includes('Copy'));
  assert.ok(!items.includes('Delete') && !items.includes('Rename'));
  await page.context().close();
});

test('access: only the visible buckets have a tab; no visible bucket gives one message', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.instances = body.instances.filter(instance => instance.id === 'garage-archive');
    body.default = 'garage-archive';
    await route.fulfill({ response, json: body });
  });
  await open(page, '');
  assert.deepEqual(await page.locator('.contentTabs__tab').allInnerTexts(), ['Garage - archive']);
  assert.match(await page.textContent('.crumb--root'), /Garage - archive/);
  await page.unroute(/\/api\/instances/);
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, instances: [], default: '' } });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.empty');
  assert.match(await page.textContent('.empty'), /No bucket is available to you/);
  assert.equal(await page.locator('.contentTabs__tab').count(), 0);
  await page.context().close();
});

test('access: a bucket that refuses write and delete shows a lock on its tab and no upload', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const instance of body.instances) {
      if (instance.id !== 'garage-archive') continue;
      for (const name of ['write', 'delete']) instance.capabilities[name] = { state: 'denied', allowed: false, verified: true, source: 'access', reason: 'The access policy refuses it.' };
      for (const name of ['upload', 'overwrite', 'createFolder', 'delete', 'copy', 'move', 'rename']) instance.operations[name] = { state: 'denied', allowed: false, verified: true, source: 'access' };
    }
    await route.fulfill({ response, json: body });
  });
  await open(page, '-/garage/garage-archive/');
  assert.equal(await page.locator('.contentTabs__tab[data-instance="garage-archive"] .ic-lock').count(), 1);
  assert.equal(await page.locator('.contentTabs__tab[data-instance="garage-main"] .ic-lock').count(), 0);
  assert.equal(await page.isHidden('#uploadWrap'), true);
  assert.match(await page.textContent('#accessBadge'), /Read only/);
  await page.context().close();
});

test('access: 403 on a folder gives a clear state and a way back to the root', async () => {
  const page = await newPage();
  await page.route(/\/api\/list\?/, route => (/prefix=reports/.test(route.request().url()) ? route.fulfill(forbidden('objects.read')) : route.continue()));
  await open(page, `${MAIN}reports/`);
  assert.match(await page.textContent('.empty'), /You cannot open this folder/);
  assert.equal(await page.isHidden('#uploadWrap'), true);
  await page.click('.empty .button >> text=Go to the bucket root');
  await page.waitForSelector('tr[data-name="reports"]');
  await page.context().close();
});

test('access: 403 on an action shows the refusal of the server', async () => {
  const page = await newPage();
  await open(page, `${MAIN}reports/2026/q3/`);
  await page.route(/\/s3\?/, route => (route.request().method() === 'DELETE' ? route.fulfill(forbidden('objects.delete')) : route.continue()));
  await page.click('tr[data-name="orders.csv"] .bb-kebab');
  await page.click('.bb-menu.is-open .bb-menu-item >> text=Delete');
  await page.click('.bb-overlay .bb-btn-primary');
  await page.waitForSelector('text=The action objects.delete is not allowed.', { timeout: 10000 });
  assert.ok((await listKeys(page, 'garage-main', 'reports/2026/q3/')).includes('reports/2026/q3/orders.csv'));
  await page.context().close();
});

test('access: 401 gives one notice that asks for a new sign-in', async () => {
  const page = await newPage();
  await open(page, MAIN);
  await page.route(/\/api\//, route => route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'A valid identity token is required.' } } }));
  await page.click('tr[data-name="reports"] .nameLink');
  await page.waitForSelector('#notices .callout--danger');
  assert.equal(await page.locator('#notices > .callout').count(), 1);
  assert.match(await page.textContent('#notices'), /Your sign-in has ended\. Reload the page to sign in again/);
  assert.equal(await page.isVisible('#notices .button >> text=Reload'), true);
  assert.equal(await page.isHidden('#uploadWrap'), true);
  await page.context().close();
});

(async () => {
  browser = await chromium.launch();
  let failed = 0;
  for (const { name, fn } of tests) {
    if (ONLY && !name.includes(ONLY)) continue;
    const started = Date.now();
    try {
      await fn();
      console.log(`ok    ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${name}\n      ${String(error.message).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  await browser.close();
  console.log(failed ? `${failed} test(s) failed` : `all ${tests.filter(t => !ONLY || t.name.includes(ONLY)).length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
