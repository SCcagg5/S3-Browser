// Browser tests of the "portal" interface (server.frontend = "portal"). They cover these parts:
// 1 the theme selector, 2 the breadcrumb and the toolbar row, the header and the bucket selector, 3 the bulk upload,
// 4 the access behaviour of 2.0.0, 5 one smoke test on each S3 provider (SeaweedFS, MinIO and Garage), 6 the copy in
// parts on each provider, 7 the edit of the metadata on each provider, 8 the cleanup of the incomplete multipart
// uploads on each provider, 9 the editor of the lifecycle rules on each provider, 10 Object Lock (retention and legal
// hold) on the providers with a bucket with Object Lock, 11 encryption (SSE-S3 of the writes, and the display of SSE-S3,
// SSE-KMS, SSE-C and the default encryption of the bucket).
// run.sh starts S3-Browser and the three providers, puts the test objects (seed.js) and runs this file in the
// Playwright container. The tests of parts 1 to 4 use SeaweedFS.
// The tests change the answers of the server with page.route where a case needs it (403, 401, no answer, access).
const { chromium } = require('playwright');
const assert = require('assert/strict');
const { PROVIDERS, LOCKED, ENCRYPTED } = require('./providers');
const { s3, s3Head, readLifecycle, writeLifecycle, restoreLifecycle } = require('./s3');
const BASE = process.env.BASE;
const MAIN = '-/seaweedfs/seaweedfs-main/';
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

// Chooses a theme with the theme selector of the header: the button, then the option of its menu.
async function chooseTheme(page, value, scope = '') {
  await page.click(`${scope} [data-theme-trigger]`.trim());
  await page.click(`${scope} [data-theme-value="${value}"]`.trim());
}

const forbidden = action => ({ status: 403, json: { error: { code: 'forbidden', action, message: `The action ${action} is not allowed.` } } });

// ------------------------------------------------------------------------------------------------------------------
// 1. Theme control: System / Dark / Light, saved in this browser, applied before the first paint
// ------------------------------------------------------------------------------------------------------------------

test('theme: System follows the colour scheme of the OS', async () => {
  for (const [scheme, background] of [['dark', 'rgb(13, 15, 18)'], ['light', 'rgb(246, 247, 249)']]) {
    const page = await newPage({ colorScheme: scheme });
    await open(page, MAIN);
    assert.equal(await page.getAttribute('html', 'data-theme'), null);
    assert.equal(await page.getAttribute('[data-theme-value="system"]', 'aria-selected'), 'true');
    assert.equal(await page.getAttribute('[data-theme-trigger]', 'aria-label'), 'Theme: system');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), background);
    await page.context().close();
  }
});

test('theme: a choice is saved in the browser and applies again after a reload', async () => {
  const page = await newPage({ colorScheme: 'dark' });
  await open(page, MAIN);
  // The selector of ClickHouse Dash: the menu opens under the button, and closes after a choice.
  assert.equal(await page.isHidden('#themeMenu'), true);
  await page.click('[data-theme-trigger]');
  assert.equal(await page.isVisible('#themeMenu'), true);
  assert.equal(await page.getAttribute('[data-theme-trigger]', 'aria-expanded'), 'true');
  await page.click('[data-theme-value="light"]');
  assert.equal(await page.isHidden('#themeMenu'), true);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  assert.equal(await page.evaluate(() => localStorage.getItem('portal.theme')), 'light');
  assert.equal(await page.getAttribute('[data-theme-value="light"]', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('[data-theme-trigger]', 'aria-label'), 'Theme: light');
  // The button shows the icon of the current choice.
  assert.equal(await page.isVisible('[data-theme-trigger] .themeIcon--light'), true);
  assert.equal(await page.isHidden('[data-theme-trigger] .themeIcon--system'), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 247, 249)');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await chooseTheme(page, 'system');
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
  await chooseTheme(page, 'dark');
  await page.goto(`${BASE}${MAIN}reports/2026/q3/summary.md`, { waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  assert.equal(await page.getAttribute('.previewBar [data-theme-value="dark"]', 'aria-selected'), 'true');
  await page.goto(`${BASE}no-such-page`, { waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 2. Breadcrumb: the bucket mark and a slash, with no frame, then the folders
// ------------------------------------------------------------------------------------------------------------------

test('breadcrumb: at the root, the bucket mark and a slash, with no frame and no text', async () => {
  const page = await newPage();
  await open(page, MAIN);
  const root = page.locator('.crumb--root');
  assert.equal(await page.locator('.crumbs .crumb').count(), 1);
  assert.equal((await root.innerText()).trim(), '');
  assert.equal(await root.locator('.ic').count(), 1);
  assert.equal((await page.textContent('.crumbs .crumbs__sep')).trim(), '/');
  assert.equal(await root.getAttribute('aria-current'), 'page');
  assert.equal(await root.getAttribute('aria-label'), 'SeaweedFS - primary, bucket root');
  const frame = await root.evaluate(node => { const style = getComputedStyle(node); return [style.borderTopWidth, style.backgroundColor]; });
  assert.deepEqual(frame, ['0px', 'rgba(0, 0, 0, 0)']);
  // No visible folder title: the heading stays for screen readers.
  assert.equal(await page.textContent('#folderTitle'), 'SeaweedFS - primary, bucket root');
  assert.equal(await page.evaluate(() => document.getElementById('folderTitle').classList.contains('visually-hidden')), true);
  assert.equal(await page.locator('.part__title').count(), 0);
  await page.context().close();
});

test('breadcrumb: the pointer changes the colour of a crumb and draws no frame or background', async () => {
  const page = await newPage();
  await open(page, `${MAIN}reports/2026/`);
  const look = selector => page.locator(selector).evaluate(node => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, border: style.borderTopWidth, icon: getComputedStyle(node.querySelector('.ic') || node).color };
  });
  const folder = '.crumbs .crumb:not(.crumb--root):not([aria-current])';
  const before = await look(folder);
  await page.hover(folder);
  const after = await look(folder);
  assert.notEqual(after.color, before.color);
  assert.equal(after.background, 'rgba(0, 0, 0, 0)');
  assert.equal(after.border, '0px');
  const rootBefore = await look('.crumb--root');
  await page.hover('.crumb--root');
  const rootAfter = await look('.crumb--root');
  assert.notEqual(rootAfter.icon, rootBefore.icon);
  assert.equal(rootAfter.background, 'rgba(0, 0, 0, 0)');
  await page.context().close();
});

test('breadcrumb: in a folder, the mark leads back to the bucket root', async () => {
  const page = await newPage();
  await open(page, `${MAIN}reports/2026/q3/`);
  const names = await page.locator('.crumbs .crumb').allInnerTexts();
  assert.deepEqual(names.map(name => name.trim()), ['', 'reports', '2026', 'q3']);
  assert.deepEqual(await page.locator('.crumbs .crumbs__sep').allInnerTexts(), ['/', '/', '/']);
  assert.equal(await page.getAttribute('.crumb--root', 'aria-current'), null);
  assert.equal(await page.getAttribute('.crumbs .crumb:last-of-type', 'aria-current'), 'page');
  await page.click('.crumb--root');
  await until(page, () => location.pathname.endsWith('/-/seaweedfs/seaweedfs-main/'));
  await page.waitForSelector('tr[data-name="reports"]');
  assert.equal(await page.getAttribute('.crumb--root', 'aria-current'), 'page');
  assert.equal(await page.locator('.crumbs .crumb').count(), 1);
  await page.goBack();
  await until(page, () => document.querySelector('#folderTitle').textContent.startsWith('q3,'));
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
  await until(page, () => document.querySelector('#folderTitle').textContent.startsWith('deep,'));
  await page.context().close();
});

test('breadcrumb: the crumbs and the toolbar share one row on a desktop, and the toolbar has its own row on a phone', async () => {
  const rows = async page => page.evaluate(() => {
    const crumbs = document.querySelector('#crumbs').getBoundingClientRect();
    const toolbar = document.querySelector('.browserHead > .toolbar').getBoundingClientRect();
    return { crumbsTop: crumbs.top, crumbsBottom: crumbs.bottom, toolbarTop: toolbar.top, crumbsRight: crumbs.right, toolbarLeft: toolbar.left,
      overflow: document.scrollingElement.scrollWidth - window.innerWidth };
  });
  const desktop = await newPage({ viewport: { width: 1280, height: 860 } });
  for (const path of [MAIN, `${MAIN}reports/2026/q3/`, `${MAIN}archive/deep/level-3/level-4/level-5/`]) {
    await open(desktop, path);
    const box = await rows(desktop);
    assert.ok(Math.abs(box.toolbarTop - box.crumbsTop) < 12 || box.toolbarTop < box.crumbsBottom, `one row at ${path}: ${JSON.stringify(box)}`);
    assert.ok(box.crumbsRight <= box.toolbarLeft + 1, `the crumbs come first at ${path}`);
    assert.equal(box.overflow, 0);
  }
  await desktop.context().close();
  const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const path of [MAIN, `${MAIN}reports/2026/q3/`]) {
    await open(phone, path);
    const box = await rows(phone);
    assert.ok(box.toolbarTop >= box.crumbsBottom - 1, `the toolbar under the crumbs at ${path}: ${JSON.stringify(box)}`);
    assert.ok(box.overflow <= 0, `no horizontal scroll at ${path}`);
  }
  await phone.context().close();
});

test('breadcrumb: another bucket gives its own root crumb, and the preview path starts at the bucket', async () => {
  const page = await newPage();
  await open(page, MAIN);
  await page.click('.storageSwitcher__trigger');
  await page.click('.storageBucket[data-instance="seaweedfs-archive"]');
  await until(page, () => document.querySelector('.storageSwitcher__trigger strong')?.textContent === 'SeaweedFS - archive');
  assert.equal(await page.getAttribute('.crumb--root', 'aria-label'), 'SeaweedFS - archive, bucket root');
  await page.goto(`${BASE}${MAIN}reports/2026/q3/summary.md`, { waitUntil: 'networkidle' });
  assert.equal(await page.textContent('#instanceMeta'), 'SeaweedFS - primary');
  assert.equal((await page.textContent('#docPrefix')).trim(), '/ reports / 2026 / q3');
  assert.equal((await page.textContent('#backBtn')).trim(), 'q3');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 2b. JSON preview: totals, tabs joined to the panel, root of the tree
// ------------------------------------------------------------------------------------------------------------------

test('json: a file that fits in one page shows its totals and no count button', async () => {
  const page = await newPage();
  await page.goto(`${BASE}${MAIN}config/ingest.json`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.json-range-label');
  assert.match(await page.textContent('.json-range-label'), /^Lines 1–\d+ of \d+ · page 1 of 1$/);
  assert.equal(await page.locator('.json-count-button').isVisible(), false);
  await page.click('[data-mode="beautify"]');
  await until(page, () => /^Lines 1–\d+ of \d+ · page 1 of 1$/.test(document.querySelector('.json-range-label')?.textContent || ''));
  assert.equal(await page.locator('.json-count-button').isVisible(), false);
  await page.context().close();
});

test('json: a file of several pages keeps the count button until the totals are known', async () => {
  const page = await newPage();
  await page.goto(`${BASE}${MAIN}big/rows.json`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.json-range-label');
  assert.match(await page.textContent('.json-range-label'), /^Lines 1–[\d,]+ · page 1$/);
  assert.equal(await page.locator('.json-count-button').isVisible(), true);
  await page.click('.json-count-button');
  await until(page, () => /of [\d,]+ · page 1 of [\d,]+$/.test(document.querySelector('.json-range-label')?.textContent || ''));
  assert.equal(await page.locator('.json-count-button').isVisible(), false);
  await page.context().close();
});

test('json: the tabs touch the left edge, the active tab joins the panel, and the panel has no open corner', async () => {
  const page = await newPage();
  await page.goto(`${BASE}${MAIN}config/ingest.json`, { waitUntil: 'networkidle' });
  for (const mode of ['raw', 'beautify', 'tree']) {
    await page.click(`[data-mode="${mode}"]`);
    await until(page, () => !document.querySelector('.json-panel:not([hidden]) .is-loading, .json-panel:not([hidden]).is-loading'));
    const box = await page.evaluate(mode => {
      const panel = document.querySelector('.json-panel:not([hidden]) .wrapped-code-viewer, .json-tree-panel:not([hidden])');
      const tab = document.querySelector(`[data-mode="${mode}"]`).getBoundingClientRect();
      const first = document.querySelector('[data-mode="raw"]').getBoundingClientRect();
      const controls = document.querySelector('.json-mode-controls').getBoundingClientRect();
      const style = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      return { firstLeft: first.left, controlsLeft: controls.left, panelLeft: rect.left, panelTop: rect.top,
        tabBottom: tab.bottom, controlsBottom: controls.bottom, radius: style.borderTopLeftRadius, top: style.borderTopWidth };
    }, mode);
    assert.equal(box.firstLeft, box.controlsLeft, `the first tab at the left edge (${mode}): ${JSON.stringify(box)}`);
    assert.equal(box.firstLeft, box.panelLeft, `the first tab and the panel share the left edge (${mode})`);
    assert.equal(box.radius, '0px', `no top corner on the panel (${mode})`);
    assert.equal(box.top, '0px');
    assert.ok(box.tabBottom >= box.controlsBottom, `the active tab reaches the panel (${mode}): ${JSON.stringify(box)}`);
    assert.ok(Math.abs(box.panelTop - box.controlsBottom) < 1.01, `the panel starts at the line of the tabs (${mode}): ${JSON.stringify(box)}`);
  }
  await page.context().close();
});

test('json: the root of the tree stays open and cannot be closed', async () => {
  const page = await newPage();
  await page.goto(`${BASE}${MAIN}config/ingest.json`, { waitUntil: 'networkidle' });
  await page.click('[data-mode="tree"]');
  await page.waitForSelector('.json-tree-node .json-tree-children:not([hidden])');
  const root = page.locator('.json-tree-panel > .json-tree-node > .json-tree-line .json-tree-toggle');
  assert.equal(await root.isDisabled(), true);
  assert.equal(await root.evaluate(node => getComputedStyle(node).visibility), 'hidden');
  await page.click('.json-tree-panel > .json-tree-node > .json-tree-line .json-tree-key', { force: true });
  await page.dblclick('.json-tree-panel > .json-tree-node > .json-tree-line', { force: true });
  assert.equal(await page.locator('.json-tree-panel > .json-tree-node > .json-tree-children').isVisible(), true);
  // A child still opens and closes.
  const child = page.locator('.json-tree-children .json-tree-node:has(.json-tree-type.is-object) > .json-tree-line .json-tree-toggle').first();
  await child.click();
  await page.waitForSelector('.json-tree-children .json-tree-children:not([hidden])');
  await child.click();
  assert.equal(await page.locator('.json-tree-children .json-tree-children:not([hidden])').count(), 0);
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 2c. Tags: details, lifecycle, column and filter, folder job, tags of the uploads
// ------------------------------------------------------------------------------------------------------------------

async function apiTags(page, key, instance = 'seaweedfs-main') {
  const response = await page.request.get(`${BASE}api/tags?instance=${instance}&key=${encodeURIComponent(key)}`);
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).tags.map(tag => `${tag.key}=${tag.value}`);
}

async function setApiTags(page, key, tags, instance = 'seaweedfs-main') {
  const response = await page.request.put(`${BASE}api/tags`, { data: { instance, key, tags } });
  assert.equal(response.status(), 200, await response.text());
}

async function openDetails(page, name) {
  await page.click(`tr[data-name="${name}"] .bb-kebab`);
  await page.click(`tr[data-name="${name}"] .bb-menu-item >> text=Details`);
  await page.waitForSelector('.bb-details--file');
}

test('tags: the details of a file show its tags, add, remove and save', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  await openDetails(page, 'ingest.json');
  await page.waitForSelector('[data-tags-section] .tagChip');
  assert.deepEqual(await page.locator('[data-tags-section] .tagChip').allInnerTexts().then(items => items.map(item => item.replace(/\s+/g, ' ').trim()).sort()), ['env prod', 'team data']);
  // The tags are read only until the frameless button Edit opens the form.
  assert.equal(await page.isHidden('[data-tags-section] .tagEditor__form'), true);
  assert.equal(await page.locator('[data-tags-section] .tagChip__remove').count(), 0);
  await page.click('[data-tag-edit]');
  assert.equal(await page.isDisabled('[data-tag-save]'), true);
  // A wrong tag is refused with a reason, a good tag joins the list.
  await page.fill('[data-tags-section] input[aria-label="Tag key"]', 'aws:reserved');
  await page.click('[data-tag-add]');
  assert.match(await page.textContent('.tagEditor__message'), /reserved/);
  await page.fill('[data-tags-section] input[aria-label="Tag key"]', 'owner');
  await page.fill('[data-tags-section] input[aria-label="Tag value"]', 'ada');
  await page.click('[data-tag-add]');
  assert.equal(await page.locator('[data-tags-section] .tagChip').count(), 3);
  assert.equal(await page.isDisabled('[data-tag-save]'), false);
  await page.click('[data-tag-save]');
  await until(page, () => document.querySelector('.tagEditor__message')?.textContent === 'The tags are saved.');
  assert.deepEqual((await apiTags(page, 'config/ingest.json')).sort(), ['env=prod', 'owner=ada', 'team=data']);
  // The save closes the form. Remove one and save again; Revert undoes an edit that is not saved.
  assert.equal(await page.isHidden('[data-tags-section] .tagEditor__form'), true);
  await page.click('[data-tag-edit]');
  await page.click('[data-tags-section] .tagChip:has-text("owner") .tagChip__remove');
  await page.click('[data-tag-revert]');
  assert.equal(await page.locator('[data-tags-section] .tagChip').count(), 3);
  await page.click('[data-tags-section] .tagChip:has-text("owner") .tagChip__remove');
  await page.click('[data-tag-save]');
  await until(page, () => document.querySelector('.tagEditor__message')?.textContent === 'The tags are saved.');
  assert.deepEqual((await apiTags(page, 'config/ingest.json')).sort(), ['env=prod', 'team=data']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('tags: the limit of ten tags and the characters of S3 are checked in the page', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  await openDetails(page, 'app.yaml');
  await page.click('[data-tag-edit]');
  await page.waitForSelector('[data-tags-section] .tagEditor__form');
  for (let index = 0; index < 10; index += 1) {
    await page.fill('[data-tags-section] input[aria-label="Tag key"]', `k${index}`);
    await page.click('[data-tag-add]');
  }
  assert.equal(await page.locator('[data-tags-section] .tagChip').count(), 10);
  assert.equal(await page.isDisabled('[data-tag-add]'), true);
  assert.match(await page.textContent('.tagEditor__count'), /10 of 10/);
  await page.click('[data-tag-revert]');
  await page.fill('[data-tags-section] input[aria-label="Tag value"]', 'a&b');
  await page.fill('[data-tags-section] input[aria-label="Tag key"]', 'bad');
  await page.click('[data-tag-add]');
  assert.match(await page.textContent('.tagEditor__message'), /letters, digits/);
  assert.deepEqual(await apiTags(page, 'config/app.yaml'), []);
  await page.context().close();
});

test('tags: the details show what the lifecycle rules do to the object, before the save', async () => {
  const page = await newPage();
  await open(page, `${MAIN}logs/`);
  await openDetails(page, '2026-10-18.log');
  await page.click('[data-tag-edit]');
  await page.waitForSelector('[data-tags-section] .tagEditor__form');
  assert.equal(await page.locator('.tagEditor__notes').isVisible(), false);
  await page.fill('[data-tags-section] input[aria-label="Tag key"]', 'retention');
  await page.fill('[data-tags-section] input[aria-label="Tag value"]', '30d');
  await page.click('[data-tag-add]');
  assert.match(await page.textContent('.tagEditor__notes'), /Rule expire-logs \(prefix logs\/, tag retention=30d\): the object expires 30 days after its creation\./);
  await page.click('[data-tags-section] .tagChip:has-text("retention") .tagChip__remove');
  assert.equal(await page.locator('.tagEditor__notes').isVisible(), false);
  await page.context().close();
});

test('tags: a provider without tags (501) has no tags section and no tag control', async () => {
  const page = await newPage();
  await page.route(/\/api\/tags/, route => route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: { code: 'tagging_unsupported', message: 'no tags' } }) }));
  await open(page, `${MAIN}config/`);
  await openDetails(page, 'ingest.json');
  await sleep(500);
  assert.equal(await page.locator('[data-tags-section]').count(), 0);
  await page.click('.bb-modal-x');
  await page.waitForSelector('.bb-overlay', { state: 'detached' });
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await until(page, () => document.querySelector('[data-column="tags"]').closest('label').hidden === true);
  assert.equal(await page.locator('#tagFilterToggle').isHidden(), true);
  assert.equal(await page.locator('#tagFilterWrap').isHidden(), true);
  assert.equal(await page.locator('th.col-tags').isVisible(), false);
  await page.context().close();
});

test('tags: the tag column and the tag filter come from the settings of the listing', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  assert.equal(await page.isHidden('#tagFilterWrap'), true);
  assert.equal(await page.locator('th.col-tags').isVisible(), false);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await page.waitForSelector('tr[data-name="ingest.json"] .tagChip');
  assert.equal(await page.locator('th.col-tags').isVisible(), true);
  assert.deepEqual(await page.locator('tr[data-name="ingest.json"] .tagChip').allInnerTexts().then(items => items.map(item => item.replace(/\s+/g, ' ').trim()).sort()), ['env prod', 'team data']);
  assert.equal(await page.isHidden('#tagFilterWrap'), true);
  await page.check('#tagFilterToggle');
  assert.equal(await page.isVisible('#tagFilterWrap'), true);
  await page.fill('#tagFilter', 'team=data');
  await until(page, () => document.querySelector('tr[data-name="app.yaml"]').hidden === true);
  assert.equal(await page.isVisible('tr[data-name="ingest.json"]'), true);
  assert.equal((await page.textContent('#tagStatus')).trim(), '1 of 2');
  await page.fill('#tagFilter', 'env');
  await until(page, () => document.querySelector('tr[data-name="ingest.json"]').hidden === false);
  await page.fill('#tagFilter', 'team=finance');
  await until(page, () => document.querySelector('tr[data-name="ingest.json"]').hidden === true);
  await page.fill('#tagFilter', '');
  await until(page, () => document.querySelector('tr[data-name="app.yaml"]').hidden === false);
  // The filter works with no tag column: it reads the tags itself.
  await page.uncheck('[data-column="tags"]');
  assert.equal(await page.locator('th.col-tags').isVisible(), false);
  await page.fill('#tagFilter', 'team=data');
  await until(page, () => document.querySelector('tr[data-name="app.yaml"]').hidden === true);
  // Turn the filter off: the field goes and every row comes back.
  await page.uncheck('#tagFilterToggle');
  assert.equal(await page.isHidden('#tagFilterWrap'), true);
  await until(page, () => document.querySelector('tr[data-name="app.yaml"]').hidden === false);
  await page.click('#settingsReset');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('tags: the tag column of versioned files shows no pending mark, and the details of an older version show its tags', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('tr[data-name="report.txt"] .tagChip');
  await page.waitForSelector('tr[data-name="notes.txt"] .tagChip');
  const chipsOf = async name => (await page.locator(`tr[data-name="${name}"] .tagChip`).allInnerTexts()).map(item => item.replace(/\s+/g, ' ').trim()).sort();
  assert.deepEqual(await chipsOf('report.txt'), ['status final', 'team data']);
  assert.deepEqual(await chipsOf('notes.txt'), ['team docs']);
  assert.equal(await page.locator('.tagChips__pending').count(), 0);
  assert.equal(await page.locator('td.col-tags', { hasText: 'Reading' }).count(), 0);
  assert.equal((await page.textContent('th.col-tags')).trim(), 'Tags');
  assert.equal(await page.locator('th.col-tags .visually-hidden').count(), 1);
  // The details of an older version show the tags of that version, and the tags are read only there.
  await openDetails(page, 'report.txt');
  await page.waitForSelector('[data-tags-section] .tagChip');
  assert.equal(await page.isVisible('[data-tag-edit]'), true);
  await page.click('.versionPicker__button');
  await page.click('.versionPicker__item[aria-selected="false"] >> nth=1');
  await until(page, () => document.querySelector('[data-tags-section] .tagChip')?.textContent.includes('draft'));
  assert.equal(await page.isHidden('[data-tags-section] .tagEditor__form'), true);
  assert.equal(await page.isHidden('[data-tag-edit]'), true);
  assert.equal(await page.locator('[data-tags-section] .tagChip__remove').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('tags: the tags float at the right, next to the versions, and the column of versions is narrow', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('tr[data-name="ingest.json"] .tagChip');
  const boxes = await page.evaluate(() => {
    const row = document.querySelector('tr[data-name="ingest.json"]');
    const chips = [...row.querySelectorAll('.tagChip')].map(chip => chip.getBoundingClientRect());
    const name = row.querySelector('.nameLink').getBoundingClientRect();
    return { chipsRight: Math.max(...chips.map(box => box.right)), chipsLeft: Math.min(...chips.map(box => box.left)), nameRight: name.right,
      versionsLeft: document.querySelector('th.col-versions').getBoundingClientRect().left, versionsWidth: document.querySelector('th.col-versions').getBoundingClientRect().width,
      sizeLeft: document.querySelector('th.col-size').getBoundingClientRect().left };
  });
  assert.ok(boxes.versionsLeft - boxes.chipsRight < 24, `the tags next to the versions: ${JSON.stringify(boxes)}`);
  const tops = await page.locator('tr[data-name="ingest.json"] .tagChip').evaluateAll(chips => chips.map(chip => Math.round(chip.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, `the tags on one line: ${tops}`);
  assert.ok(await page.locator('tr[data-name="ingest.json"]').evaluate(row => row.getBoundingClientRect().height) < 45);
  assert.ok(boxes.chipsLeft - boxes.nameRight > 100, `the tags far from the name: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.versionsWidth < 70, `the column of versions is narrow: ${JSON.stringify(boxes)}`);
  await open(page, '');
  await page.waitForSelector('tr[data-name="README.md"] .tagChip');
  assert.deepEqual((await page.locator('tr[data-name="README.md"] .tagChip').allInnerTexts()).map(item => item.replace(/\s+/g, ' ').trim()), ['team docs']);
  await page.context().close();
});

test('tags: a row shows three tags and a count for the other ones', async () => {
  const page = await newPage();
  await open(page, `${MAIN}images/`);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('tr[data-name="banner.svg"] .tagChip');
  assert.equal(await page.locator('tr[data-name="banner.svg"] .tagChip').count(), 3);
  assert.equal((await page.textContent('tr[data-name="banner.svg"] .tagMore')).trim(), '+2');
  const title = await page.getAttribute('tr[data-name="banner.svg"] .tagMore', 'title');
  assert.equal(title.split(', ').length, 2);
  // The details have the five tags.
  await openDetails(page, 'banner.svg');
  await page.waitForSelector('[data-tags-section] .tagChip');
  assert.equal(await page.locator('[data-tags-section] .tagChip').count(), 5);
  await page.context().close();
});

test('tags: a tag is a badge with a swatch whose colour comes from the key, and a click filters by the tag', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('tr[data-name="ingest.json"] .tagChip');
  // The swatch and the colour: the same key has the same colour, two keys have two colours (here: team and env).
  const colours = await page.locator('tr[data-name="ingest.json"] .tagChip').evaluateAll(chips => chips.map(chip => [chip.dataset.tag, getComputedStyle(chip.querySelector('.tagSwatch')).backgroundColor]));
  assert.equal(colours.length, 2);
  assert.notEqual(colours[0][1], colours[1][1]);
  assert.equal(await page.locator('tr[data-name="ingest.json"] .tagChip .tagSwatch').count(), 2);
  assert.equal(await page.isHidden('#tagFilterWrap'), true);
  // A click on a tag turns the filter on and fills it. The rows with no such tag go.
  await page.click('tr[data-name="ingest.json"] .tagChip[data-tag="team=data"] .tagChip__pick');
  assert.equal(await page.isVisible('#tagFilterWrap'), true);
  assert.equal(await page.inputValue('#tagFilter'), 'team=data');
  await until(page, () => document.querySelector('tr[data-name="app.yaml"]').hidden === true);
  assert.equal(await page.locator('tr[data-name="ingest.json"] .tagChip[data-tag="team=data"].is-active').count(), 1);
  assert.equal(await page.locator('tr[data-name="ingest.json"] .tagChip[data-tag="env=prod"].is-active').count(), 0);
  // Another tag replaces the filter. Ctrl adds a word. A second click on the only tag clears the filter.
  await page.click('tr[data-name="ingest.json"] .tagChip[data-tag="env=prod"] .tagChip__pick');
  assert.equal(await page.inputValue('#tagFilter'), 'env=prod');
  await page.click('tr[data-name="ingest.json"] .tagChip[data-tag="team=data"] .tagChip__pick', { modifiers: ['Control'] });
  assert.equal(await page.inputValue('#tagFilter'), 'env=prod team=data');
  assert.equal(await page.locator('tr[data-name="ingest.json"] .tagChip.is-active').count(), 2);
  await page.click('tr[data-name="ingest.json"] .tagChip[data-tag="team=data"] .tagChip__pick', { modifiers: ['Control'] });
  assert.equal(await page.inputValue('#tagFilter'), 'env=prod');
  await page.click('tr[data-name="ingest.json"] .tagChip[data-tag="env=prod"] .tagChip__pick');
  assert.equal(await page.inputValue('#tagFilter'), '');
  await until(page, () => document.querySelector('tr[data-name="app.yaml"]').hidden === false);
  // The choice of the filter stays turned on, as a setting.
  assert.equal(await page.isVisible('#tagFilterWrap'), true);
  await page.click('#settingsButton');
  assert.equal(await page.isChecked('#tagFilterToggle'), true);
  await page.click('#settingsReset');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('tags: a value with spaces keeps its quotes in the filter', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  await setApiTags(page, 'config/app.yaml', [{ key: 'owner', value: 'data team' }]);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('tr[data-name="app.yaml"] .tagChip');
  await page.click('tr[data-name="app.yaml"] .tagChip .tagChip__pick');
  assert.equal(await page.inputValue('#tagFilter'), 'owner="data team"');
  await until(page, () => document.querySelector('tr[data-name="ingest.json"]').hidden === true);
  assert.equal(await page.isVisible('tr[data-name="app.yaml"]'), true);
  await page.click('#settingsButton');
  await page.click('#settingsReset');
  await setApiTags(page, 'config/app.yaml', []);
  await page.context().close();
});

test('tags: a folder job sets and removes tags on every object, and keeps the other tags', async () => {
  const page = await newPage();
  await open(page, `${MAIN}reports/2026/`);
  const keys = ['reports/2026/q1/summary.md', 'reports/2026/q2/summary.md', 'reports/2026/q3/summary.md', 'reports/2026/q3/orders.csv'];
  await open(page, `${MAIN}reports/`);
  await page.click('tr[data-name="2026"] .bb-kebab');
  await page.click('tr[data-name="2026"] .bb-menu-item >> text=Tag objects');
  await page.waitForSelector('[data-tag-form]');
  await page.fill('[data-tag-form] textarea', 'batch=yes, bad&key');
  await page.click('[data-tag-form] .bb-btn-primary');
  assert.match(await page.textContent('[data-tag-form] .tagEditor__message'), /letters, digits/);
  await page.fill('[data-tag-form] textarea', 'batch=yes, stage=one');
  await page.click('[data-tag-form] .bb-btn-primary');
  await until(page, () => !document.querySelector('[data-tag-form]'));
  await until(page, async () => true);
  for (const key of keys) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const tags = await apiTags(page, key);
      if (tags.includes('batch=yes')) break;
      assert.ok(Date.now() < deadline, `${key} was not tagged: ${tags}`);
      await sleep(300);
    }
    assert.ok((await apiTags(page, key)).includes('stage=one'));
  }
  assert.deepEqual((await apiTags(page, 'reports/2026/q3/summary.md')).sort(), ['batch=yes', 'stage=one', 'team=finance']);
  // Remove the two keys with a second job.
  await page.click('tr[data-name="2026"] .bb-kebab');
  await page.click('tr[data-name="2026"] .bb-menu-item >> text=Tag objects');
  await page.waitForSelector('[data-tag-form]');
  await page.fill('[data-tag-form] input', 'batch, stage');
  await page.click('[data-tag-form] .bb-btn-primary');
  await until(page, () => !document.querySelector('[data-tag-form]'));
  for (const key of keys) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const tags = await apiTags(page, key);
      if (!tags.includes('batch=yes') && !tags.includes('stage=one')) break;
      assert.ok(Date.now() < deadline, `${key} kept its tags: ${tags}`);
      await sleep(300);
    }
  }
  assert.deepEqual(await apiTags(page, 'reports/2026/q3/summary.md'), ['team=finance']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('tags: the uploads of the browser carry the tags that the person sets in the settings', async () => {
  const page = await newPage();
  await deletePrefix(page, 'seaweedfs-main', 'tagged/');
  await open(page, `${MAIN}tagged/`);
  assert.equal(await page.locator('#uploadTagsItem').count(), 0);
  await page.click('#settingsButton');
  await page.fill('#uploadTagsInput', 'team=up, bad&key');
  await page.press('#uploadTagsInput', 'Enter');
  assert.match(await page.textContent('#uploadTagsMessage'), /letters, digits/);
  assert.equal(await page.getAttribute('#uploadTagsInput', 'aria-invalid'), 'true');
  await page.fill('#uploadTagsInput', 'team=up, source=browser');
  await page.press('#uploadTagsInput', 'Enter');
  await until(page, () => document.querySelector('#uploadTagsMessage').textContent === 'The next uploads carry these tags.');
  assert.equal(await page.inputValue('#uploadTagsInput'), 'team=up, source=browser');
  // The choice stays after a reload.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dataTable, .empty');
  await page.click('#settingsButton');
  assert.equal(await page.inputValue('#uploadTagsInput'), 'team=up, source=browser');
  await page.setInputFiles('#fileInput', files(2, 'tagged'));
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 60000 });
  for (const key of ['tagged/tagged-0001.txt', 'tagged/tagged-0002.txt']) {
    assert.deepEqual((await apiTags(page, key)).sort(), ['source=browser', 'team=up']);
  }
  // A multipart upload carries them too.
  await page.setInputFiles('#fileInput', [{ name: 'large-tagged.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(33 * 1024 * 1024, 3) }]);
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 120000 });
  assert.deepEqual((await apiTags(page, 'tagged/large-tagged.bin')).sort(), ['source=browser', 'team=up']);
  // No tag: the next uploads have none.
  await page.fill('#uploadTagsInput', '');
  await page.press('#uploadTagsInput', 'Enter');
  await page.setInputFiles('#fileInput', files(1, 'plain'));
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 60000 });
  assert.deepEqual(await apiTags(page, 'tagged/plain-0001.txt'), []);
  await deletePrefix(page, 'seaweedfs-main', 'tagged/');
  await page.context().close();
});

test('tags: an instance that keeps no tags gets no tag at upload, and the tag settings are hidden', async () => {
  const page = await newPage();
  // The server tells that the instance has no tags (as for Garage). The saved tags of the uploads are not sent.
  await page.addInitScript(() => localStorage.setItem('portal.uploadTags', JSON.stringify([{ key: 'team', value: 'up' }])));
  await page.route('**/api/instances*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const instance of body.instances || []) instance.tagsSupported = false;
    await route.fulfill({ response, json: body });
  });
  const sent = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().includes('/s3?')) sent.push({ kind: 'put', tagging: request.headers()['x-amz-tagging'] || '' });
    if (request.method() === 'POST' && request.url().includes('/api/uploads')) sent.push({ kind: 'create', tags: (JSON.parse(request.postData() || '{}').tags || []).length });
  });
  await open(page, `${MAIN}config/`);
  await page.click('#settingsButton');
  assert.equal(await page.locator('#uploadTagsSetting').isVisible(), false);
  assert.equal(await page.locator('[data-column="tags"]').isVisible(), false);
  await page.keyboard.press('Escape');
  await page.setInputFiles('#fileInput', [{ name: 'notag.txt', mimeType: 'text/plain', buffer: Buffer.from('no tag') }, { name: 'notag-large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(33 * 1024 * 1024, 5) }]);
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 120000 });
  assert.ok(sent.length >= 2, JSON.stringify(sent));
  for (const item of sent) assert.ok(item.kind === 'put' ? item.tagging === '' : item.tags === 0, JSON.stringify(item));
  assert.deepEqual(await apiTags(page, 'config/notag.txt'), []);
  await deletePrefix(page, 'seaweedfs-main', 'config/notag');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 2d. Listing: columns, settings, icon buttons
// ------------------------------------------------------------------------------------------------------------------

test('listing: the columns are Name, Tags, Versions, Size and Modified, with the clock at the left of Modified', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('tr[data-name="ingest.json"] .tagChip');
  const heads = await page.locator('thead th').evaluateAll(nodes => nodes.filter(node => node.offsetParent !== null).map(node => node.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(heads.slice(0, 5), ['Name', 'Tags', 'Versions', 'Size', 'Modified']);
  const boxes = await page.evaluate(() => {
    const left = selector => document.querySelector(selector).getBoundingClientRect().left;
    return { tags: left('th.col-tags'), versions: left('th.col-versions'), size: left('th.col-size'), modified: left('th.col-modified'),
      clockRight: document.querySelector('.timeToggle').getBoundingClientRect().right, sortLeft: document.querySelector('th.col-modified .sortHead').getBoundingClientRect().left };
  });
  assert.ok(boxes.tags < boxes.versions && boxes.versions < boxes.size && boxes.size < boxes.modified, JSON.stringify(boxes));
  assert.ok(boxes.clockRight <= boxes.sortLeft, `the clock at the left of Modified: ${JSON.stringify(boxes)}`);
  // A file with one version has nothing in the column Versions: the icon and the count show for several versions.
  assert.equal(await page.locator('tr[data-name="ingest.json"] .versionCount').count(), 0);
  assert.equal(await page.locator('tr[data-name="ingest.json"] .nameCell .versionCount').count(), 0);
  await page.keyboard.press('Escape');
  await open(page, `${MAIN}versions/`);
  await page.waitForSelector('tr[data-name="report.txt"] .versionCount');
  assert.equal((await page.textContent('tr[data-name="report.txt"] .versionCount')).trim(), '3');
  assert.equal(await page.getAttribute('tr[data-name="report.txt"] .versionCount', 'title'), '3 versions: open the details');
  assert.equal(await page.locator('tr[data-name="report.txt"] .versionCount .ic-git-commit').count(), 1);
  assert.equal((await page.textContent('tr[data-name="notes.txt"] .versionCount')).trim(), '2');
  assert.equal(await page.locator('th.col-versions .visually-hidden').count(), 1);
  // The Details of the file list the three versions.
  await openDetails(page, 'report.txt');
  await page.waitForSelector('.versionPicker__button');
  assert.match(await page.textContent('.versionPicker__button'), /v3.*Current/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('listing: the settings and the reload are icons with no frame, and their colour changes under the pointer', async () => {
  const page = await newPage();
  await open(page, MAIN);
  const order = await page.evaluate(() => ['#searchForm', '#settingsButton', '#refreshButton', '#actionsButton'].map(selector => document.querySelector(selector).getBoundingClientRect().left));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `search, settings, reload, Actions: ${order}`);
  const gap = await page.evaluate(() => document.querySelector('#refreshButton').getBoundingClientRect().left - document.querySelector('#settingsButton').getBoundingClientRect().right);
  assert.ok(gap <= 8, `the gear and the reload are close: ${gap}px`);
  for (const selector of ['#settingsButton', '#refreshButton']) {
    const look = () => page.locator(selector).evaluate(node => { const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor, border: style.borderTopWidth }; });
    const rest = await look();
    assert.equal(rest.background, 'rgba(0, 0, 0, 0)', selector);
    assert.equal(rest.border, '0px', selector);
    await page.hover(selector);
    await until(page, (arg) => getComputedStyle(document.querySelector(arg.selector)).color !== arg.color, { selector, color: rest.color });
    const hover = await look();
    assert.equal(hover.background, 'rgba(0, 0, 0, 0)', selector);
    assert.equal(hover.border, '0px', selector);
    await page.mouse.move(5, 400);
  }
  await page.context().close();
});

test('listing: the settings are a menu under the gear, choose the columns, stay in the browser and reset', async () => {
  const page = await newPage();
  await open(page, MAIN);
  assert.equal(await page.isHidden('#settingsMenu'), true);
  assert.equal(await page.getAttribute('#settingsButton', 'aria-expanded'), 'false');
  await page.click('#settingsButton');
  assert.equal(await page.isVisible('#settingsMenu'), true);
  assert.equal(await page.getAttribute('#settingsButton', 'aria-expanded'), 'true');
  const place = await page.evaluate(() => {
    const gear = document.querySelector('#settingsButton').getBoundingClientRect();
    const menu = document.querySelector('#settingsMenu').getBoundingClientRect();
    return { gearBottom: gear.bottom, menuTop: menu.top, gearRight: gear.right, menuRight: menu.right, width: window.innerWidth };
  });
  assert.ok(place.menuTop >= place.gearBottom, `the menu under the gear: ${JSON.stringify(place)}`);
  assert.ok(place.menuRight <= place.width, `the menu in the window: ${JSON.stringify(place)}`);
  assert.deepEqual(await page.locator('#settingsMenu [data-column]').evaluateAll(nodes => nodes.map(node => `${node.dataset.column}:${node.checked}:${node.disabled}`)),
    ['name:true:true', 'tags:false:false', 'versions:true:false', 'size:true:false', 'modified:true:false']);
  // A click on a column keeps the menu open, like the fields of a form.
  await page.uncheck('[data-column="size"]');
  await page.uncheck('[data-column="modified"]');
  assert.equal(await page.isVisible('#settingsMenu'), true);
  assert.equal(await page.locator('th.col-size').isVisible(), false);
  assert.equal(await page.locator('th.col-modified').isVisible(), false);
  assert.equal(await page.locator('td.col-size').first().isVisible(), false);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#settingsMenu', { state: 'hidden' });
  // The choice stays after a reload.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dataTable');
  assert.equal(await page.locator('th.col-size').isVisible(), false);
  assert.equal(await page.locator('th.col-modified').isVisible(), false);
  await page.click('#settingsButton');
  assert.equal(await page.isChecked('[data-column="size"]'), false);
  // A click outside closes the menu.
  await page.click('#crumbs', { force: true });
  await page.waitForSelector('#settingsMenu', { state: 'hidden' });
  await page.click('#settingsButton');
  await page.click('#settingsReset');
  await page.waitForSelector('#settingsMenu', { state: 'hidden' });
  assert.equal(await page.locator('th.col-size').isVisible(), true);
  assert.equal(await page.locator('th.col-modified').isVisible(), true);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('listing: the menu Actions has no item of bucket permissions (the button at the left of the selector has them)', async () => {
  const page = await newPage();
  await open(page, MAIN);
  await page.click('#actionsButton');
  const items = (await page.locator('#actionsMenu .menu__item').allInnerTexts()).map(item => item.trim());
  assert.ok(items.length >= 2, `items: ${items}`);
  assert.ok(!items.some(item => /permission/i.test(item)), `items: ${items}`);
  assert.equal(await page.locator('#accessItem').count(), 0);
  assert.equal(await page.locator('#tagsItem').count(), 0);
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 2e. Versions: the picker of the details and the comparison of two versions
// ------------------------------------------------------------------------------------------------------------------

async function openCompareFromDetails(page, name) {
  await openDetails(page, name);
  await page.click('.versionPicker__button');
  await page.click('.versionPicker__compare');
  // The comparison is a page of its own, not a dialog.
  await page.waitForSelector('.versionComparePage .versionDiff');
  assert.equal(await page.locator('.bb-overlay').count(), 0);
  assert.match(page.url(), /[?&]compare=/);
}

// Chooses a version in the picker From or To of the comparison. The index is the row of the menu (0 is the newest).
async function pickVersion(page, side, index) {
  await page.click(`.versionDiff__${side} .versionPicker__button`);
  await page.click(`.versionPicker__menu:not([hidden]) .versionPicker__item >> nth=${index}`);
}

const cleanText = items => items.map(item => item.replace(/\s+/g, ' ').trim());

test('versions: the picker of the details lists each version with its date, its size and its change', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await openDetails(page, 'report.txt');
  assert.equal(await page.locator('select[data-details-version]').count(), 0);
  assert.match(await page.textContent('.versionPicker__button'), /v3.*Current.*3/);
  assert.equal(await page.getAttribute('.versionPicker__button', 'aria-expanded'), 'false');
  await page.click('.versionPicker__button');
  assert.equal(await page.isVisible('.versionPicker__menu'), true);
  assert.equal(await page.getAttribute('.versionPicker__button', 'aria-expanded'), 'true');
  const items = cleanText(await page.locator('.versionPicker__item').allInnerTexts());
  assert.equal(items.length, 3);
  assert.match(items[0], /^v3 .*Current/);
  assert.match(items[1], /^v2 /);
  assert.match(items[2], /^v1 .*first version/);
  assert.match(items[0], /\+\d+ B/);
  assert.equal(await page.getAttribute('.versionPicker__item >> nth=0', 'aria-selected'), 'true');
  assert.match(await page.textContent('.versionPicker__compare'), /Compare v3 with v2/);
  // The columns line up: the number, the date, the size and the id start at the same place in every row.
  const columns = await page.evaluate(() => Array.from(document.querySelectorAll('.versionPicker__item')).map(row => ['.versionPicker__number', '.versionPicker__when', '.versionPicker__size', '.versionPicker__meta'].map(selector => Math.round(row.querySelector(selector).getBoundingClientRect().left * 10) / 10)));
  for (const row of columns.slice(1)) assert.deepEqual(row, columns[0], `columns: ${JSON.stringify(columns)}`);
  // The menu stays in the window, under the button.
  const place = await page.evaluate(() => {
    const menu = document.querySelector('.versionPicker__menu').getBoundingClientRect();
    const button = document.querySelector('.versionPicker__button').getBoundingClientRect();
    return { top: menu.top, bottom: button.bottom, left: menu.left, right: menu.right, width: window.innerWidth };
  });
  assert.ok(place.top >= place.bottom && place.left >= 0 && place.right <= place.width, JSON.stringify(place));
  // Each row is an option with the button of the choice and the action buttons. The current version has no Restore.
  assert.equal(await page.locator('.versionPicker__item[role="option"] > button.versionPicker__choose').count(), 3);
  assert.deepEqual(await page.locator('.versionPicker__item >> nth=0').locator('[data-version-action]').evaluateAll(nodes => nodes.map(node => node.dataset.versionAction)), ['download', 'remove']);
  assert.deepEqual(await page.locator('.versionPicker__item >> nth=1').locator('[data-version-action]').evaluateAll(nodes => nodes.map(node => node.dataset.versionAction)), ['download', 'restore', 'remove']);
  assert.equal(await page.getAttribute('.versionPicker__item >> nth=1 >> [data-version-action="restore"]', 'aria-label'), 'Restore v2');
  assert.equal(await page.locator('.versionPicker__item >> nth=1 >> [data-version-action="remove"]').evaluate(node => node.classList.contains('iconButton')), true);
  // The action buttons show on hover and on keyboard focus.
  await page.mouse.move(0, 0);
  await until(page, () => getComputedStyle(document.querySelectorAll('.versionPicker__actions')[2]).opacity === '0');
  await page.hover('.versionPicker__item >> nth=2');
  await until(page, () => getComputedStyle(document.querySelectorAll('.versionPicker__actions')[2]).opacity === '1');
  await page.mouse.move(0, 0);
  // Keyboard: Up and Down move between the rows, Right and Left between the choice and the actions, Escape closes and
  // gives the focus back.
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.versionPicker__item')?.dataset.version !== undefined && document.activeElement.classList.contains('versionPicker__choose')), true);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.versionAction), 'download');
  await until(page, () => getComputedStyle(document.activeElement.closest('.versionPicker__actions')).opacity === '1');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.versionAction), 'restore');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.versionAction), 'remove');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('versionPicker__choose')), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.versionPicker__menu', { state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement.className.includes('versionPicker__button')), true);
  assert.equal(await page.isVisible('.bb-details--file'), true);
  // A choice opens the details of that version.
  await page.click('.versionPicker__button');
  await page.click('.versionPicker__item >> nth=2');
  await until(page, () => /v1.*Older/.test(document.querySelector('.versionPicker__button')?.textContent || ''));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: the comparison of two text versions, unified and side by side, with the changed words', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await openCompareFromDetails(page, 'report.txt');
  assert.match(await page.textContent('.versionDiff__from .versionPicker__button'), /^From\s*v2/);
  assert.match(await page.textContent('.versionDiff__to .versionPicker__button'), /^To\s*v3/);
  // The two pickers and the summary of the change are on one line.
  const line = await page.evaluate(() => ['.versionDiff__from', '.versionDiff__to', '.versionDiff__summary'].map(selector => { const box = document.querySelector(selector).getBoundingClientRect(); return Math.round(box.top + box.height / 2); }));
  assert.ok(Math.max(...line) - Math.min(...line) <= 12, `lines ${line}`);
  assert.match(await page.textContent('.versionDiff__summary'), /^\+\d+ B/);
  await page.waitForSelector('.diff__table');
  // The default view has the two versions side by side.
  assert.equal(await page.locator('.diff__table.is-split').count(), 1);
  assert.equal(await page.getAttribute('.segmented__item[data-value="split"]', 'aria-pressed'), 'true');
  await page.click('.segmented__item[data-value="unified"]');
  await page.waitForSelector('.diff__table:not(.is-split)');
  const stats = cleanText(await page.locator('.diffStat').allInnerTexts());
  assert.deepEqual(stats, ['+3', '−2']);
  assert.doesNotMatch(await page.textContent('.versionDiff__summary'), /null/);
  const removed = cleanText(await page.locator('.diff__row--del .diff__text').allInnerTexts()).map(item => item.replace(/^−\s*/, ''));
  const added = cleanText(await page.locator('.diff__row--add .diff__text').allInnerTexts()).map(item => item.replace(/^\+\s*/, ''));
  assert.deepEqual(removed, ['Status: review', 'Orders: 120']);
  assert.deepEqual(added, ['Status: final', 'Orders: 124', '- approved']);
  // The words that changed are marked in a changed line.
  assert.deepEqual(cleanText(await page.locator('.diff__row--add mark').allInnerTexts()).filter(Boolean).slice(0, 2), ['final', '124']);
  // The 12 lines of context between the two edits are folded; a click shows them.
  assert.equal(await page.locator('.diff__fold').count(), 1);
  assert.match(await page.textContent('.diff__fold'), /\d+ unchanged lines/);
  const before = await page.locator('.diff__row').count();
  await page.click('.diff__expand');
  assert.ok(await page.locator('.diff__row').count() > before + 5);
  assert.equal(await page.locator('.diff__fold').count(), 0);
  // Side by side.
  await page.click('.segmented__item[data-value="split"]');
  await page.waitForSelector('.diff__table.is-split');
  assert.equal(await page.locator('.diff__table.is-split thead th').count(), 2);
  assert.ok(await page.locator('.diff__table.is-split .diff__row--mod').count() >= 2);
  // The whole file, with no fold.
  await page.check('[data-diff-whole]');
  assert.equal(await page.locator('.diff__fold').count(), 0);
  // Swap the two versions: the additions become removals.
  await page.click('.versionDiff__swap');
  await page.waitForSelector('.diffStat');
  assert.deepEqual(cleanText(await page.locator('.diffStat').allInnerTexts()).slice(0, 2), ['+2', '−3']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: the comparison of two JSON versions has the modes Raw, Beautify and Tree, as the preview', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await openCompareFromDetails(page, 'config.json');
  // Beautify is the first mode: the two documents are indented and side by side.
  await page.waitForSelector('.diff__table.is-split');
  assert.deepEqual(cleanText(await page.locator('[aria-label="Format"] .segmented__item').allInnerTexts()), ['Raw', 'Beautify', 'Tree']);
  assert.equal(await page.getAttribute('.segmented__item[data-value="beautify"]', 'aria-pressed'), 'true');
  const nodes = () => page.evaluate(() => Array.from(document.querySelectorAll('.jsonTree__node')).map(node => `${node.className.match(/--(added|removed|changed|same)/)[1]} ${node.querySelector('.jsonTree__label').textContent}`));
  // Tree: v2 -> v3 has one change, replicas 3 to 4. The format and the order of the keys are not changes.
  await page.click('.segmented__item[data-value="tree"]');
  await page.waitForSelector('.jsonTree');
  { const got = await nodes(); assert.equal(JSON.stringify(got), JSON.stringify(['changed $', 'changed replicas']), JSON.stringify(got)); }
  assert.match(cleanText(await page.locator('.jsonTree__node--changed .jsonTree__change').allInnerTexts())[0], /3 to 4/);
  assert.match(cleanText(await page.locator('.jsonTree__same').allInnerTexts())[0], /^\d+ unchanged$/);
  assert.equal(await page.locator('.versionDiff__actions').count(), 0);
  // The unchanged values show with the option.
  await page.check('[data-diff-whole]');
  assert.ok((await nodes()).includes('same service'));
  await page.uncheck('[data-diff-whole]');
  // v1 -> v3. The keys are in alphabetical order.
  await pickVersion(page, 'from', 2);
  await until(page, () => document.querySelectorAll('.jsonTree__node').length >= 7);
  { const got = await nodes(); assert.equal(JSON.stringify(got), JSON.stringify(['changed $', 'removed legacy', 'changed limits', 'added memory', 'changed regions', 'added [1]', 'changed replicas']), JSON.stringify(got)); }
  assert.deepEqual(cleanText(await page.locator('.diffStat').allInnerTexts()).slice(0, 1), ['4 paths changed']);
  // A branch closes and opens.
  await page.click('.jsonTree__node--changed:has(> .jsonTree__row .jsonTree__label:text-is("limits")) > .jsonTree__row .jsonTree__toggle');
  assert.equal(await page.locator('.jsonTree__label:text-is("memory")').isVisible(), false);
  // Raw: the text as it is stored. Beautify: indented. Both have the views of the text.
  await page.click('.segmented__item[data-value="raw"]');
  await page.waitForSelector('.diff__table.is-split');
  assert.equal(await page.locator('[data-diff-sort]').count(), 0);
  assert.match(await page.textContent('.diff__table.is-split'), /\{"service":"ingest"/);
  // The text starts at the left of each side: the number column is narrow.
  const columns = await page.evaluate(() => { const row = document.querySelector('.diff__table.is-split tbody tr.diff__row'); const cells = Array.from(row.children).map(cell => cell.getBoundingClientRect()); return { number: cells[0].width, gap: cells[1].left - cells[0].right, text: cells[1].width, side: cells[2].left - cells[0].left }; });
  assert.ok(columns.number <= 80, `number column ${columns.number}px`);
  assert.ok(Math.abs(columns.side - (columns.number + columns.text)) < 2);
  // A changed line with marked words has no text of an object in it.
  assert.doesNotMatch(await page.textContent('.versionDiff__view'), /\[object /);
  assert.ok(await page.locator('.diff__table.is-split mark').count() >= 1);
  await page.click('.segmented__item[data-value="beautify"]');
  await page.waitForSelector('.diff__table.is-split');
  assert.equal(await page.locator('[data-diff-sort]').count(), 1);
  assert.match(await page.textContent('.diff__table.is-split'), /"service": "ingest"/);
  await page.click('.segmented__item[data-value="unified"]');
  await page.waitForSelector('.diff__table:not(.is-split)');
  assert.equal(await page.locator('.diff__row--add').count() > 0, true);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: the comparison of two CSV versions shows the rows and the cells that changed', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await openCompareFromDetails(page, 'orders.csv');
  await page.waitForSelector('.diff__table--csvsplit');
  await page.click('.segmented__item[data-value="table"]');
  await page.waitForSelector('.diff__table--csv:not(.diff__table--csvsplit)');
  // v2 -> v3: the row 1 is removed, the quantity of the row 4 changed.
  assert.deepEqual(cleanText(await page.locator('.diffStat').allInnerTexts()), ['0 added', '1 removed', '1 modified']);
  assert.equal(await page.locator('.diff__row--del').count(), 1);
  assert.equal(await page.locator('.diff__row--mod').count(), 1);
  assert.deepEqual(cleanText(await page.locator('.csvCell--changed').allInnerTexts()), ['1 to 2']);
  assert.match(cleanText(await page.locator('.diff__row--del').allInnerTexts())[0], /1 ada 5/);
  // v1 -> v2: a row added, a quantity changed.
  await pickVersion(page, 'from', 2);
  await pickVersion(page, 'to', 1);
  await until(page, () => document.querySelectorAll('.diffStat').length === 3 && document.querySelector('.diffStat').textContent.startsWith('1 added'));
  assert.deepEqual(cleanText(await page.locator('.diffStat').allInnerTexts()), ['1 added', '0 removed', '1 modified']);
  assert.deepEqual(cleanText(await page.locator('.csvCell--changed').allInnerTexts()), ['7 to 8']);
  // The unchanged rows are folded; the option shows them.
  await page.check('[data-diff-whole]');
  assert.equal(await page.locator('.diff__row--eq').count() >= 2, true);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: a version that is not text gives a clear message and the comparison of the bytes', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await openCompareFromDetails(page, 'blob.bin');
  await page.waitForSelector('.diff__empty');
  assert.match(await page.textContent('.versionDiff__view'), /not text/);
  assert.equal(await page.locator('.versionDiff__view .bb-btn >> text=Compare the bytes').count(), 1);
  await page.context().close();
});

test('versions: two versions with the same content say so', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await openCompareFromDetails(page, 'notes.txt');
  await page.waitForSelector('.diffStat');
  assert.deepEqual(cleanText(await page.locator('.diffStat').allInnerTexts()), ['+1', '−1']);
  await pickVersion(page, 'from', 0);
  await pickVersion(page, 'to', 0);
  await until(page, () => /two different versions/.test(document.querySelector('.versionDiff__view')?.textContent || ''));
  await page.context().close();
});

test('versions: the menu of a row has no separate action of versions, and the badge of the count opens the details', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await page.waitForSelector('tr[data-name="orders.csv"] .versionCount');
  await page.click('tr[data-name="orders.csv"] .bb-kebab');
  const items = cleanText(await page.locator('tr[data-name="orders.csv"] .bb-menu-item').allInnerTexts());
  assert.ok(items.length >= 3 && !items.some(item => /version/i.test(item)), `items: ${items}`);
  await page.keyboard.press('Escape');
  // The badge is a button: it opens the details of the file, with the version picker. The page has no table of the
  // versions.
  await page.click('tr[data-name="report.txt"] .versionCount');
  await page.waitForSelector('.bb-details--file .bb-details-head .versionPicker__button');
  assert.match(await page.textContent('.bb-details-name'), /^report\.txt$/);
  await page.click('.versionPicker__button');
  assert.equal(await page.locator('.versionPicker__item').count(), 3);
  assert.equal(await page.locator('.versionPicker__all, [data-version-select], [data-version-compare-selected]').count(), 0);
  assert.equal(await visibleText(page, 'All versions and actions'), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: the preview page has the same picker, with no select and no separate action', async () => {
  const page = await newPage();
  await page.goto(`${BASE}${MAIN}versions/report.txt`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.versionPicker__button');
  assert.equal(await page.locator('#previewVersionSelect').count(), 0);
  assert.match(await page.textContent('.versionPicker__button'), /v3.*Current/);
  await page.click('#previewKebabBtn');
  assert.equal(await page.locator('#pv-versions').count(), 0);
  const actions = cleanText(await page.locator('#previewMenu .bb-menu-item').allInnerTexts());
  assert.ok(!actions.some(item => /^versions$/i.test(item)), `actions: ${actions}`);
  await page.keyboard.press('Escape');
  // A choice changes the version of the preview and the label of the picker.
  await page.click('.versionPicker__button');
  assert.equal(await page.locator('.versionPicker__item').count(), 3);
  await page.click('.versionPicker__item >> nth=2');
  await until(page, () => /v1.*Older/.test(document.querySelector('.versionPicker__button')?.textContent || ''));
  assert.match(page.url(), /version=/);
  // The comparison opens from the picker.
  const headerBefore = await page.evaluate(() => document.querySelector('.previewBar').getBoundingClientRect().height);
  await page.click('.versionPicker__button');
  await page.click('.versionPicker__compare');
  await page.waitForSelector('.versionComparePage .diff__table');
  assert.equal(await page.locator('.bb-overlay').count(), 0);
  assert.match(page.url(), /compare=/);
  assert.equal(await page.locator('.versionDiff__from .versionPicker__button, .versionDiff__to .versionPicker__button').count(), 2);
  assert.equal(await page.locator('select').count(), 0);
  // No back button, no title and no line of the path in the page.
  assert.equal(await page.locator('.versionComparePage__back, .versionComparePage__title, .versionDiff__file').count(), 0);
  // The header has no new row. The picker stays in its place and becomes the version To. The version From is at its left, and
  // the statistics are between the two.
  const place = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    return {
      header: box('.previewBar').height, from: box('#compareFrom'), stats: box('#compareStats'), to: box('#previewVersionControl'),
      toIsPicker: document.querySelector('#previewVersionControl').classList.contains('versionDiff__to') && !document.querySelector('#previewVersionControl').hidden,
      inHeader: Boolean(document.querySelector('.previewBar #compareFrom .versionPicker__button')),
      bar: Boolean(document.querySelector('#compareBar'))
    };
  });
  assert.ok(Math.abs(place.header - headerBefore) < 1.5, `header ${headerBefore}px, then ${place.header}px`);
  assert.equal(place.inHeader, true);
  assert.equal(place.toIsPicker, true);
  assert.equal(place.bar, false);
  assert.ok(place.from.right <= place.stats.left + 1 && place.stats.right <= place.to.left + 1, JSON.stringify(place));
  assert.match(await page.textContent('#compareFrom'), /^From/);
  assert.match(await page.textContent('#previewVersionControl'), /^To/);
  // The comparison is in the page: the browser back button returns to the preview, and so does the button of the page.
  await page.goBack();
  await until(page, () => !document.querySelector('.versionComparePage') && document.querySelector('#viewer')?.textContent.includes('Status'));
  assert.doesNotMatch(page.url(), /compare=/);
  await page.click('.versionPicker__button');
  await page.click('.versionPicker__compare');
  await page.waitForSelector('.versionComparePage .diff__table');
  await page.click('#compareClose');
  await until(page, () => !document.querySelector('.versionComparePage') && document.querySelector('#viewer')?.textContent.includes('Status'));
  assert.doesNotMatch(page.url(), /compare=/);
  // The picker of the preview has the actions of the versions and no item of a table of the versions. The pickers From
  // and To of a comparison have no action.
  await page.click('.versionPicker__button');
  assert.equal(await page.locator('.versionPicker__menu:not([hidden]) [data-version-action="download"]').count(), 3);
  assert.equal(await page.locator('.versionPicker__menu:not([hidden]) [data-version-action="restore"]').count(), 2);
  assert.equal(await page.locator('.versionPicker__all').count(), 0);
  await page.click('.versionPicker__compare');
  await page.waitForSelector('.versionComparePage .diff__table');
  for (const side of ['from', 'to']) {
    await page.click(`.versionDiff__${side} .versionPicker__button`);
    assert.equal(await page.locator('.versionPicker__menu:not([hidden]) .versionPicker__item').count(), 3);
    assert.equal(await page.locator('.versionPicker__menu:not([hidden]) [data-version-action]').count(), 0);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: the git patch has the format of git, and can be copied and downloaded', async () => {
  const page = await newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  await open(page, `${MAIN}versions/`);
  await openCompareFromDetails(page, 'report.txt');
  await page.waitForSelector('.diff__table');
  await page.click('.segmented__item[data-value="git"]');
  await page.waitForSelector('.gitPatch');
  const patch = await page.locator('.gitPatch').evaluate(node => node.textContent);
  const lines = patch.split('\n');
  assert.match(lines[0], /^diff --git a\/versions\/report\.txt b\/versions\/report\.txt$/);
  assert.match(lines[1], /^index [0-9a-f]{1,7}\.\.[0-9a-f]{1,7} 100644$/);
  assert.equal(lines[2], '--- a/versions/report.txt');
  assert.equal(lines[3], '+++ b/versions/report.txt');
  assert.match(lines[4], /^@@ -1,7 \+1,7 @@$/);
  assert.ok(lines.includes('-Status: review') && lines.includes('+Status: final') && lines.includes('-Orders: 120') && lines.includes('+Orders: 124'));
  assert.ok(lines.includes('+- approved'));
  assert.ok(patch.endsWith('\n'));
  assert.equal(await page.locator('.gitPatch__line--hunk').count(), 2);
  assert.equal(await page.locator('.gitPatch__line--add').count(), 3);
  assert.equal(await page.locator('.gitPatch__line--del').count(), 2);
  // Copy and download give the same text as the page.
  await page.click('[data-diff-copy]');
  await until(page, async () => (await navigator.clipboard.readText()).startsWith('diff --git'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), patch);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-diff-download]')]);
  assert.equal(download.suggestedFilename(), 'report.txt.patch');
  const stream = await download.createReadStream();
  let body = '';
  for await (const chunk of stream) body += chunk;
  assert.equal(body, patch);
  // The patch of two other versions follows the choice of the versions.
  await pickVersion(page, 'from', 2);
  await until(page, () => /@@ -1,\d+ \+1,\d+ @@/.test(document.querySelector('.gitPatch')?.textContent || '') && document.querySelector('.gitPatch').textContent.includes('-Status: draft'));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: the JSON patch follows the option that sorts the keys, and the CSV has two tables side by side', async () => {
  const page = await newPage();
  await open(page, `${MAIN}versions/`);
  await openCompareFromDetails(page, 'config.json');
  await page.waitForSelector('.diff__table.is-split');
  // v2 -> v3: the document has the same data, with other keys order and format. Sorted keys: one change.
  assert.equal(await page.isChecked('[data-diff-sort]'), true);
  await page.click('.segmented__item[data-value="git"]');
  await page.waitForSelector('.gitPatch');
  assert.equal(await page.locator('.gitPatch__line--add').count(), 1);
  await page.uncheck('[data-diff-sort]');
  await until(page, () => document.querySelectorAll('.gitPatch__line--add').length > 1);
  await open(page, `${MAIN}versions/`);
  // The CSV side by side: the rows before at the left, the rows after at the right, with the changed cells.
  await openCompareFromDetails(page, 'orders.csv');
  await page.waitForSelector('.diff__table--csvsplit');
  assert.equal(await page.locator('.diff__table--csvsplit thead th').count(), 2);
  assert.ok(await page.locator('.diff__table--csvsplit .csvCell--cut.is-del').count() >= 1);
  assert.ok(await page.locator('.diff__table--csvsplit .csvCell--cut.is-add').count() >= 1);
  assert.ok(await page.locator('.diff__table--csvsplit .is-empty').count() >= 1);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('versions: an older version of a JSON file opens in the preview, with its ETag, without HTTP 412', async () => {
  const page = await newPage();
  const list = await (await page.request.get(`${BASE}api/versions?instance=seaweedfs-main&key=versions/config.json`)).json();
  const older = list.versions.find(version => !version.isCurrent);
  assert.ok(older, 'config.json needs an older version');
  for (const endpoint of ['raw', 'summary', 'tree']) {
    const response = await page.request.get(`${BASE}api/json/${endpoint}?instance=seaweedfs-main&key=versions/config.json&version=${older.version}&etag=${encodeURIComponent('"' + older.etag + '"')}`);
    assert.equal(response.status(), 200, `${endpoint}: ${await response.text()}`);
  }
  await page.goto(`${BASE}${MAIN}versions/config.json?version=${older.version}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.json-range-label', { timeout: 8000 }).catch(async () => assert.fail((await page.evaluate(() => document.querySelector('main, body').innerHTML)).slice(0, 1500)));
  assert.match(await page.textContent('.json-range-label'), /^Lines 1–\d+ of \d+/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('windows: the details and the folder insights use one window, with the same classes, width, top edge and height', async () => {
  const page = await newPage({ viewport: { width: 1600, height: 900 } });
  await open(page, `${MAIN}versions/`);
  const box = () => page.evaluate(() => {
    const overlay = document.querySelector('.bb-overlay');
    const modal = document.querySelector('.bb-modal');
    const body = document.querySelector('.bb-modal .bb-details-body');
    const rect = modal.getBoundingClientRect();
    const inner = modal.querySelector('.bb-modal-body');
    return { overlay: overlay.className.replace(/\s*is-open\s*/, ' ').trim(), modal: modal.className.trim(), top: rect.top, width: rect.width, height: rect.height, body: body.getBoundingClientRect().height, transform: getComputedStyle(modal).transform,
      padding: getComputedStyle(inner).padding, gap: rect.right - body.getBoundingClientRect().right, contentGap: parseFloat(getComputedStyle(body).paddingRight) };
  });
  const settled = () => until(page, () => getComputedStyle(document.querySelector('.bb-modal')).transform === 'none');
  const close = async () => { await page.click('.bb-modal-x'); await page.waitForSelector('.bb-overlay', { state: 'detached' }); };
  // The details, with its two tabs.
  await openDetails(page, 'report.txt');
  await settled();
  const details = await box();
  // The body of the window has no padding at the right: the element that scrolls ends at the edge of the window (its
  // border), and its content keeps a gap.
  assert.equal(details.padding, '8px 0px 16px 20px');
  assert.ok(details.gap <= 1.5, `gap ${details.gap}px`);
  assert.ok(details.contentGap >= 16, `content gap ${details.contentGap}px`);
  assert.equal(details.modal, 'bb-modal bb-modal--large');
  assert.equal(details.overlay, 'bb-overlay bb-overlay--large');
  assert.ok(details.width >= 900, `width ${details.width}px`);
  assert.ok(details.top < 200, `top ${details.top}px`);
  // One page, with no tab: the sections and the tools (integrity, inspection) are in the same window.
  assert.equal(await page.locator('[data-details-tab], .bb-details-tabs').count(), 0);
  assert.equal(await page.locator('[data-details-tool-card="integrity"]').count(), 1);
  assert.equal(await page.locator('[data-details-tool-card="inspection"]').count(), 1);
  assert.equal(await page.locator('[data-tags-section]').isVisible(), true);
  // The arrow of the picker has the size of the text, and the close button changes only its colour.
  const look = await page.evaluate(() => {
    const arrow = document.querySelector('.bb-details-head .versionPicker__button .mdi-chevron-down').getBoundingClientRect();
    return { arrow: arrow.width, before: getComputedStyle(document.querySelector('.bb-modal-x')).color };
  });
  assert.ok(look.arrow <= 20, `arrow ${look.arrow}px`);
  await page.hover('.bb-modal-x');
  await until(page, before => getComputedStyle(document.querySelector('.bb-modal-x')).color !== before, look.before);
  const after = await page.evaluate(() => { const style = getComputedStyle(document.querySelector('.bb-modal-x')); return { background: style.backgroundColor, border: style.borderTopColor }; });
  assert.equal(after.background, 'rgba(0, 0, 0, 0)');
  assert.equal(after.border, 'rgba(0, 0, 0, 0)');
  await close();
  // The folder insights.
  await page.click('#actionsButton');
  await page.click('#insightsItem');
  await page.waitForSelector('.bb-details--insights');
  await settled();
  const insights = await box();
  for (const other of [insights]) {
    assert.equal(other.modal, details.modal);
    assert.equal(other.overlay, details.overlay);
    assert.ok(Math.abs(other.width - details.width) < 0.5, `width ${other.width}px, ${details.width}px`);
    assert.ok(Math.abs(other.top - details.top) < 0.5, `top ${other.top}px, ${details.top}px`);
    assert.ok(Math.abs(other.body - details.body) < 0.5, `body ${other.body}px, ${details.body}px`);
    assert.equal(other.padding, details.padding);
    assert.ok(other.gap <= 1.5 && other.contentGap >= 16, JSON.stringify(other));
  }
  await page.context().close();
});

test('versions: a file with one version has no version picker; the action button of a row has no frame', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  // The button of the row: no frame and no fill, only the colour changes.
  const kebab = page.locator('tr[data-name="ingest.json"] .bb-kebab');
  const before = await kebab.evaluate(node => getComputedStyle(node).color);
  await kebab.hover();
  await until(page, previous => getComputedStyle(document.querySelector('tr[data-name="ingest.json"] .bb-kebab')).color !== previous, before);
  const style = await kebab.evaluate(node => { const css = getComputedStyle(node); return { background: css.backgroundColor, border: css.borderTopWidth }; });
  assert.equal(style.background, 'rgba(0, 0, 0, 0)');
  assert.equal(style.border, '0px');
  // One version: no picker in the details, and none in the preview page.
  await openDetails(page, 'ingest.json');
  assert.equal(await page.locator('.bb-details-head .versionPicker__button, [data-details-versions]').count(), 0);
  await page.goto(`${BASE}${MAIN}config/ingest.json`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.json-range-label');
  assert.equal(await page.locator('#previewVersionControl').isVisible(), false);
  assert.equal(await page.locator('.versionPicker__button').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// Makes a file of seaweedfs-main with three versions (one second between them, so that the dates differ).
async function makeVersionedObject(key) {
  for (let number = 1; number <= 3; number += 1) {
    await s3('seaweedfs-main', 'PUT', `/default/${key}`, '', Buffer.from(`${key} version ${number}\n`), { 'content-type': 'text/plain' });
    if (number < 3) await sleep(1100);
  }
}

// The versions with data of a file, the newest first, as the picker lists them.
const dataVersions = async (page, instance, key) => (await (await page.request.get(`${BASE}api/versions?instance=${instance}&key=${encodeURIComponent(key)}`)).json()).versions
  .filter(version => !version.deleteMarker).sort((left, right) => new Date(right.lastModified) - new Date(left.lastModified));

test('versions: the picker of the details restores and deletes a version, with a confirmation, and the details and the listing follow', async () => {
  const page = await newPage();
  const key = `actions/restore-${Date.now()}.txt`;
  const name = key.split('/').pop();
  await makeVersionedObject(key);
  const [v3, v2, v1] = await dataVersions(page, 'seaweedfs-main', key);
  await open(page, `${MAIN}actions/`);
  await until(page, row => document.querySelector(`tr[data-name="${row}"] .versionCount`)?.textContent.trim() === '3', name);
  await openDetails(page, name);
  // Restore v1: a confirmation, then a new current version with the content of v1.
  await pickerAction(page, v1.version, 'restore');
  assert.match(await page.textContent(`${confirmWindow} .bb-modal-body`), new RegExp(`Create a new current version of "${key}" from ${v1.version}`));
  await page.click(`${confirmWindow} .bb-btn-primary`);
  await page.waitForSelector('.bb-toast >> text=Version restored.');
  assert.equal((await dataVersions(page, 'seaweedfs-main', key)).length, 4);
  assert.equal((await getObject(page, 'seaweedfs-main', key)).body.toString(), `${key} version 1\n`);
  // The details open again on the current version, and the badge of the listing counts 4 versions.
  await until(page, () => /v4.*Current/.test(document.querySelector('.bb-details-head .versionPicker__button')?.textContent || ''));
  await until(page, row => document.querySelector(`tr[data-name="${row}"] .versionCount`)?.textContent.trim() === '4', name);
  // Delete v2: a confirmation, then the version is gone.
  await pickerAction(page, v2.version, 'remove');
  assert.match(await page.textContent(`${confirmWindow} .bb-modal-body`), new RegExp(`Permanently delete exact version ${v2.version} of "${key}"`));
  await page.click(`${confirmWindow} .bb-btn-primary`);
  await page.waitForSelector('.bb-toast >> text=Version deleted.');
  assert.deepEqual((await dataVersions(page, 'seaweedfs-main', key)).map(version => version.version).filter(id => [v1.version, v2.version, v3.version].includes(id)), [v3.version, v1.version]);
  await until(page, () => /v3.*Current/.test(document.querySelector('.bb-details-head .versionPicker__button')?.textContent || ''));
  await until(page, row => document.querySelector(`tr[data-name="${row}"] .versionCount`)?.textContent.trim() === '3', name);
  // A cancel does nothing.
  await pickerAction(page, v1.version, 'remove');
  await page.click(`${confirmWindow} .bb-btn:not(.bb-btn-primary)`);
  await sleep(300);
  assert.equal((await dataVersions(page, 'seaweedfs-main', key)).length, 3);
  // Download gives the version to the download of the page.
  await page.evaluate(() => { BB.downloads.download = async options => { window.downloaded = options; return null; }; });
  await pickerAction(page, v3.version, 'download');
  await until(page, () => Boolean(window.downloaded));
  const downloaded = await page.evaluate(() => window.downloaded);
  assert.equal(downloaded.key, key);
  assert.equal(downloaded.version, v3.version);
  assert.deepEqual(page.errors, []);
  await deletePrefix(page, 'seaweedfs-main', 'actions/');
  await page.context().close();
});

test('versions: the picker of the preview deletes the version that the page shows, and restores a version', async () => {
  const page = await newPage();
  const key = `actions/preview-${Date.now()}.txt`;
  await makeVersionedObject(key);
  const [, v2, v1] = await dataVersions(page, 'seaweedfs-main', key);
  await page.goto(`${BASE}${MAIN}${key}?version=${encodeURIComponent(v2.version)}`, { waitUntil: 'networkidle' });
  await until(page, text => document.querySelector('#viewer')?.textContent.includes(text), `${key} version 2`);
  assert.match(await page.textContent('#previewVersionControl .versionPicker__button'), /v2.*Older/);
  // The delete of the version of the page: the page shows the current version.
  await page.click('#previewVersionControl .versionPicker__button');
  await page.hover(`.versionPicker__item[data-version="${v2.version}"]`);
  await page.click(`.versionPicker__item[data-version="${v2.version}"] [data-version-action="remove"]`);
  await page.click('.bb-overlay .bb-btn-primary');
  await page.waitForSelector('.bb-toast >> text=Version deleted.');
  await until(page, text => document.querySelector('#viewer')?.textContent.includes(text), `${key} version 3`);
  assert.doesNotMatch(page.url(), /version=/);
  assert.match(await page.textContent('#previewVersionControl .versionPicker__button'), /v2.*Current/);
  // The restore of v1 makes a new current version: the page shows it.
  await page.click('#previewVersionControl .versionPicker__button');
  await page.hover(`.versionPicker__item[data-version="${v1.version}"]`);
  await page.click(`.versionPicker__item[data-version="${v1.version}"] [data-version-action="restore"]`);
  await page.click('.bb-overlay .bb-btn-primary');
  await page.waitForSelector('.bb-toast >> text=Version restored.');
  await until(page, () => /v3.*Current/.test(document.querySelector('#previewVersionControl .versionPicker__button')?.textContent || ''));
  await until(page, text => document.querySelector('#viewer')?.textContent.includes(text), `${key} version 1`);
  assert.deepEqual(page.errors, []);
  await deletePrefix(page, 'seaweedfs-main', 'actions/');
  await page.context().close();
});

test('versions: the picker shows Restore only with the write permission and Delete only with the delete permission', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const instance of body.instances) {
      if (instance.id !== 'seaweedfs-main') continue;
      for (const name of ['write', 'delete']) instance.capabilities[name] = { state: 'denied', allowed: false, verified: true, source: 'access', reason: 'The access policy refuses it.' };
      for (const name of ['upload', 'overwrite', 'createFolder', 'delete', 'copy', 'move', 'rename']) instance.operations[name] = { state: 'denied', allowed: false, verified: true, source: 'access' };
    }
    await route.fulfill({ response, json: body });
  });
  await open(page, `${MAIN}versions/`);
  await openDetails(page, 'report.txt');
  await page.click('.bb-details-head .versionPicker__button');
  assert.equal(await page.locator('.versionPicker__menu:not([hidden]) .versionPicker__item').count(), 3);
  assert.deepEqual(await page.locator('.versionPicker__menu:not([hidden]) [data-version-action]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.versionAction))]), ['download']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('listing: Size and Modified use a font with one width for every character, and their width is the longest text', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  const look = await page.evaluate(() => {
    const cell = selector => { const node = document.querySelector(selector); const style = getComputedStyle(node); return { font: style.fontFamily, width: node.getBoundingClientRect().width, ch: parseFloat(style.fontSize) * 0.6 }; };
    return { size: cell('td.col-size'), modified: cell('td.col-modified'), nameWidth: document.querySelector('th:first-child').getBoundingClientRect().width, tableWidth: document.querySelector('.dataTable').getBoundingClientRect().width, modifiedLeft: document.querySelector('th.col-modified').getBoundingClientRect().left };
  });
  assert.match(look.size.font, /mono/i);
  assert.match(look.modified.font, /mono/i);
  // The width is the one of the longest text, the exact time with 19 characters, plus the padding of the cell.
  assert.ok(look.modified.width > look.modified.ch * 19, `Modified: ${look.modified.width}px`);
  assert.ok(look.modified.width < look.modified.ch * 19 + 20 + 24, `Modified: ${look.modified.width}px`);
  assert.ok(look.size.width < look.size.ch * 7 + 20 + 24, `Size: ${look.size.width}px`);
  // The values and the titles are at the right of the columns.
  const align = await page.evaluate(() => ['td.col-size', 'td.col-modified', 'th.col-size', 'th.col-modified'].map(selector => getComputedStyle(document.querySelector(selector)).textAlign));
  assert.deepEqual(align, ['right', 'right', 'right', 'right']);
  // The column keeps its width when the person changes between the relative and the exact time.
  await page.click('.timeToggle');
  await until(page, () => document.querySelector('.dataTable').classList.contains('is-exact-time'));
  const exact = await page.evaluate(() => ({ modified: document.querySelector('td.col-modified').getBoundingClientRect().width, left: document.querySelector('th.col-modified').getBoundingClientRect().left, table: document.querySelector('.dataTable').getBoundingClientRect().width }));
  assert.ok(Math.abs(exact.modified - look.modified.width) < 0.5, `exact ${exact.modified}px, relative ${look.modified.width}px`);
  assert.ok(Math.abs(exact.table - look.tableWidth) < 0.5);
  assert.ok(Math.abs(exact.left - look.modifiedLeft) < 0.5, `left ${exact.left}px, before ${look.modifiedLeft}px`);
  await page.click('.timeToggle');
  // The width does not change with the value: two rows have the same width, and two digits have the same width.
  const widths = await page.evaluate(() => {
    const measure = text => { const span = document.createElement('span'); span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; span.className = 'modifiedCell'; document.querySelector('td.col-modified').append(span); span.textContent = text; const width = span.getBoundingClientRect().width; span.remove(); return width; };
    return [measure('11'), measure('88'), measure('iiii')];
  });
  assert.ok(Math.abs(widths[0] - widths[1]) < 0.01);
  assert.ok(Math.abs(widths[1] * 2 - widths[2]) < 0.01);
  await page.context().close();
});

test('header: the brand and the version of ClickHouse Dash, in the centred column of the page', async () => {
  const page = await newPage({ viewport: { width: 1700, height: 900 } });
  await open(page, MAIN);
  const build = (await (await page.request.get(`${BASE}api/instances`)).json()).build;
  assert.equal(await page.textContent('.appBrand__name'), 'S3 Browser');
  const version = String(build.version || build.display);
  assert.ok((await page.textContent('#versionBadge')).startsWith(version));
  assert.match(await page.getAttribute('#versionBadge', 'title'), /^Server version\n/);
  const box = await page.evaluate(() => {
    const inner = document.querySelector('.appHeader__inner').getBoundingClientRect();
    const main = document.querySelector('#browser').getBoundingClientRect();
    const header = document.querySelector('.appHeader').getBoundingClientRect();
    return { innerLeft: inner.left, innerRight: inner.right, mainLeft: main.left, mainRight: main.right, header: header.width };
  });
  assert.equal(box.header, 1700);
  assert.ok(Math.abs(box.innerLeft - box.mainLeft) <= 25 && Math.abs(box.innerRight - box.mainRight) <= 25, JSON.stringify(box));
  // The theme selector is at the right end of the column, after the bucket selector.
  const order = await page.evaluate(() => {
    const switcher = document.querySelector('#storageSwitcher').getBoundingClientRect();
    const theme = document.querySelector('.themeSelect').getBoundingClientRect();
    return switcher.right <= theme.left;
  });
  assert.equal(order, true);
  // Without a path prefix, the page is the root of the site: no "Back to panel".
  assert.equal(await page.isHidden('#backLink'), true);
  await page.context().close();
});

test('selector: the bucket selector of the default interface, by host, with the permissions', async () => {
  const page = await newPage();
  await open(page, MAIN);
  const trigger = page.locator('.storageSwitcher__trigger');
  assert.equal(await trigger.locator('strong').innerText(), 'SeaweedFS - primary');
  assert.equal(await trigger.locator('small').count(), 0);
  const edge = await page.evaluate(() => {
    const dots = document.querySelector('.storageSwitcher__trigger .permDots').getBoundingClientRect();
    const chevron = document.querySelector('.storageSwitcher__chevron').getBoundingClientRect();
    const name = document.querySelector('.storageSwitcher__trigger strong').getBoundingClientRect();
    return { dotsRight: dots.right, chevronLeft: chevron.left, nameRight: name.right, dotsLeft: dots.left };
  });
  assert.ok(edge.chevronLeft - edge.dotsRight < 24 && edge.dotsLeft > edge.nameRight, `the permission dots at the right: ${JSON.stringify(edge)}`);
  const details = await trigger.getAttribute('title');
  assert.match(details, /id: seaweedfs-main/);
  assert.match(details, /host: seaweedfs/);
  assert.match(details, /bucket: default/);
  assert.equal(await trigger.locator('.permDot').count(), 3);
  assert.equal(await page.isHidden('#storageSwitcherMenu'), true);
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  // One host for each provider of the test stack; the host of the current bucket is open.
  assert.deepEqual(await page.locator('.storageHost__row').evaluateAll(rows => rows.map(row => row.dataset.host)), ['seaweedfs', 'minio', 'garage']);
  assert.match(await page.textContent('.storageHost__row'), /seaweedfs\s*S3 · 4 buckets/);
  assert.equal(await page.getAttribute('.storageHost__row', 'aria-expanded'), 'true');
  assert.deepEqual(await page.locator('.storageHost[data-host="seaweedfs"] .storageBucket strong').allInnerTexts(), ['SeaweedFS - primary', 'SeaweedFS - archive', 'SeaweedFS - locked', 'SeaweedFS - encrypted']);
  assert.equal(await page.getAttribute('.storageBucket[data-instance="seaweedfs-main"]', 'aria-selected'), 'true');
  assert.equal(await page.locator('.storageBucket[data-instance="seaweedfs-main"] .storageBucket__check').count(), 1);
  const columns = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll('.storageHost[data-host="seaweedfs"] .storageBucket'));
    return {
      checkRight: box('.storageBucket[data-instance="seaweedfs-main"] .storageBucket__check').right,
      folderLeft: box('.storageBucket[data-instance="seaweedfs-main"] .ic-folder').left,
      folders: rows.map(row => Math.round(row.querySelector('.ic-folder').getBoundingClientRect().left)),
      dots: rows.map(row => Math.round(row.querySelector('.permDots').getBoundingClientRect().right))
    };
  });
  assert.ok(columns.checkRight <= columns.folderLeft, `the check before the folder icon: ${JSON.stringify(columns)}`);
  assert.equal(new Set(columns.folders).size, 1, `the folder icons in one column: ${JSON.stringify(columns)}`);
  assert.equal(new Set(columns.dots).size, 1, `the permission dots in one column: ${JSON.stringify(columns)}`);
  // A click on the host closes its list; Escape closes the menu.
  await page.click('.storageHost__row');
  assert.equal(await page.isHidden('.storageHost__buckets'), true);
  await page.click('.storageHost__row');
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#storageSwitcherMenu'), true);
  // The keyboard: ArrowDown opens the menu on the current bucket.
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.instance), 'seaweedfs-main');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.instance), 'seaweedfs-archive');
  await page.keyboard.press('Enter');
  await until(page, () => location.pathname.endsWith('/-/seaweedfs/seaweedfs-archive/'));
  assert.match(await page.locator('.storageSwitcher__trigger').innerText(), /SeaweedFS - archive/);
  // A click outside closes the menu.
  await page.click('.storageSwitcher__trigger');
  await page.click('#listing');
  assert.equal(await page.isHidden('#storageSwitcherMenu'), true);
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 3. Bulk upload of hundreds of files
// ------------------------------------------------------------------------------------------------------------------

test('selector: an icon button at the left of the selector opens the permissions; the menu has no foot', async () => {
  const page = await newPage();
  await open(page, MAIN);
  const geometry = await page.evaluate(() => {
    const button = document.querySelector('#permButton').getBoundingClientRect();
    const trigger = document.querySelector('.storageSwitcher__trigger').getBoundingClientRect();
    return { buttonRight: button.right, triggerLeft: trigger.left, buttonHeight: button.height, triggerHeight: trigger.height,
      text: document.querySelector('#permButton').textContent.trim() };
  });
  assert.ok(geometry.buttonRight <= geometry.triggerLeft - 8, `the button at the left of the selector: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.text, '');
  assert.equal(Math.round(geometry.buttonHeight), Math.round(geometry.triggerHeight));
  assert.equal(await page.getAttribute('#permButton', 'aria-label'), 'Permissions of this bucket');
  assert.equal(await page.locator('#permButton .ic-shield-check').count(), 1);
  const look = () => page.locator('#permButton').evaluate(node => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, border: style.borderTopColor };
  });
  const rest = await look();
  assert.equal(rest.background, 'rgba(0, 0, 0, 0)');
  assert.equal(rest.border, 'rgba(0, 0, 0, 0)');
  await page.hover('#permButton');
  await until(page, previous => getComputedStyle(document.querySelector('#permButton')).color !== previous, rest.color);
  const hover = await look();
  assert.notEqual(hover.color, rest.color);
  assert.equal(hover.background, 'rgba(0, 0, 0, 0)');
  assert.equal(hover.border, 'rgba(0, 0, 0, 0)');
  await page.mouse.move(5, 400);
  await page.click('.storageSwitcher__trigger');
  assert.equal(await page.locator('.storageSwitcher__menu .button').count(), 0);
  assert.equal(await page.locator('.storageSwitcher__menu', { hasText: 'Permissions of this bucket' }).count(), 0);
  await page.keyboard.press('Escape');
  await page.click('#permButton');
  await page.waitForSelector('.permList');
  assert.match(await page.textContent('.permissions'), /SeaweedFS - primary/);
  assert.equal(await page.locator('.permRow').count(), 3);
  await page.context().close();
});

test('selector: on a phone the permission button is at the left of the selector, on its row', async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await open(page, MAIN);
  const box = await page.evaluate(() => {
    const button = document.querySelector('#permButton').getBoundingClientRect();
    const trigger = document.querySelector('.storageSwitcher__trigger').getBoundingClientRect();
    return { buttonRight: button.right, triggerLeft: trigger.left, buttonTop: button.top, triggerTop: trigger.top,
      overflow: document.scrollingElement.scrollWidth - window.innerWidth };
  });
  assert.ok(box.buttonRight <= box.triggerLeft, `the button at the left: ${JSON.stringify(box)}`);
  assert.ok(Math.abs(box.buttonTop - box.triggerTop) < 2, `the same row: ${JSON.stringify(box)}`);
  assert.ok(box.overflow <= 0);
  await page.context().close();
});

test('selector: the open menu has a rounded top-left corner and a top line up to the vertical border of the selector', async () => {
  const page = await newPage();
  await open(page, MAIN);
  await page.click('.storageSwitcher__trigger');
  const box = await page.evaluate(() => {
    const trigger = document.querySelector('.storageSwitcher__trigger');
    const menu = document.querySelector('#storageSwitcherMenu');
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    const triggerStyle = getComputedStyle(trigger);
    return { stub: t.left - m.left, right: t.right - m.right, top: style.borderTopWidth, radius: style.borderTopLeftRadius,
      rightRadius: style.borderTopRightRadius, triggerBottomLeft: triggerStyle.borderBottomLeftRadius, triggerBottom: t.bottom, menuTop: m.top,
      triggerZ: triggerStyle.zIndex, menuZ: style.zIndex };
  });
  assert.equal(box.stub, 8, `the menu goes 8 px past the left border of the selector: ${JSON.stringify(box)}`);
  assert.equal(box.right, 0);
  assert.equal(box.top, '1px');
  assert.equal(box.radius, '8px');
  assert.equal(box.rightRadius, '0px');
  assert.equal(box.triggerBottomLeft, '0px');
  assert.ok(box.menuTop <= box.triggerBottom, `the menu touches the selector: ${JSON.stringify(box)}`);
  assert.ok(Number(box.triggerZ) > Number(box.menuZ), 'the selector covers the line of the menu under it');
  await page.context().close();
});

test('upload: 300 files, bounded concurrency and rendering, progress, summary', async () => {
  const page = await newPage();
  await deletePrefix(page, 'seaweedfs-main', 'bulk/');
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
  assert.match(await page.textContent('.uploadDock .summary'), /^300 files uploaded \([\d.]+ KB\), 300 checked with SHA-256\.$/);
  assert.equal(await page.textContent('[data-stat="files"]'), '300 / 300');
  assert.ok((await page.locator('.uploadDock li').count()) <= 4);
  assert.equal((await listKeys(page, 'seaweedfs-main', 'bulk/')).length, 300);
  // The listing refreshes at the end of the batch.
  await until(page, () => /300 files/.test(document.querySelector('#folderCount')?.textContent || ''));
  await page.click('.uploadDock .button >> text=Close');
  assert.equal(await page.isHidden('#uploadDock'), true);
  assert.deepEqual(page.errors, []);
  await deletePrefix(page, 'seaweedfs-main', 'bulk/');
  await page.context().close();
});

test('upload: a page without crypto.subtle uploads with no checksum', async () => {
  const page = await newPage();
  await page.addInitScript(() => { Object.defineProperty(window, 'crypto', { value: { getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: crypto.randomUUID?.bind(crypto) } }); });
  await deletePrefix(page, 'seaweedfs-main', 'nosum/');
  await open(page, `${MAIN}nosum/`);
  await page.setInputFiles('#fileInput', files(3, 'nosum'));
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 60000 });
  assert.match(await page.textContent('.uploadDock .summary'), /^3 files uploaded \([\d.]+ KB\)\.$/);
  assert.equal((await listKeys(page, 'seaweedfs-main', 'nosum/')).length, 3);
  await deletePrefix(page, 'seaweedfs-main', 'nosum/');
  await page.context().close();
});

test('upload: a large file goes in parts, each part carries its SHA-256, and the provider confirms them', async () => {
  const page = await newPage();
  await deletePrefix(page, 'seaweedfs-main', 'sum/');
  await open(page, `${MAIN}sum/`);
  const requests = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/uploads')) requests.push(request.headers()['x-checksum-sha256'] || ''); });
  await page.setInputFiles('#fileInput', [{ name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(33 * 1024 * 1024, 7) }]);
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 120000 });
  assert.match(await page.textContent('.uploadDock .summary'), /^1 file uploaded \([\d.]+ MB\), 1 checked with SHA-256\.$/);
  assert.ok(requests.length >= 2, `chunks: ${requests.length}`);
  assert.ok(requests.every(value => /^[A-Za-z0-9+/]{43}=$/.test(value)), `every chunk has a digest: ${requests}`);
  assert.equal((await listKeys(page, 'seaweedfs-main', 'sum/')).length, 1);
  await deletePrefix(page, 'seaweedfs-main', 'sum/');
  await page.context().close();
});

test('upload: failed files with their reasons, bounded list, then "Retry failed"', async () => {
  const page = await newPage();
  await deletePrefix(page, 'seaweedfs-main', 'retry/');
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
  assert.match(await page.textContent('.uploadDock .summary'), /^40 files uploaded \([\d.]+ KB\), 40 checked with SHA-256, 60 failed\.$/);
  refuse = false;
  await page.click('.uploadDock .button >> text=Retry failed');
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 60000 });
  assert.equal(await page.isHidden('.fileList--failed'), true);
  assert.equal((await listKeys(page, 'seaweedfs-main', 'retry/')).length, 100);
  assert.equal(puts.total, 160);
  await deletePrefix(page, 'seaweedfs-main', 'retry/');
  await page.context().close();
});

test('upload: cancel stops the queue and the summary counts the canceled files', async () => {
  const page = await newPage();
  await deletePrefix(page, 'seaweedfs-main', 'cancel/');
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
  await deletePrefix(page, 'seaweedfs-main', 'cancel/');
  await page.context().close();
});

test('upload: an unreachable server gives one message, the queue waits, then the upload continues', async () => {
  const page = await newPage();
  await deletePrefix(page, 'seaweedfs-main', 'offline/');
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
  assert.equal((await listKeys(page, 'seaweedfs-main', 'offline/')).length, 150);
  assert.ok(puts.total > 150);
  await deletePrefix(page, 'seaweedfs-main', 'offline/');
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
  // SeaweedFS lists versions: the menu can have Versions, a read action. No item changes the object.
  assert.deepEqual(items.map(item => item.trim()).filter(item => item !== 'Versions'), ['Details', 'Download']);
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

test('access: the selector shows only the visible buckets; no visible bucket gives one message', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.instances = body.instances.filter(instance => instance.id === 'seaweedfs-archive');
    body.default = 'seaweedfs-archive';
    await route.fulfill({ response, json: body });
  });
  await open(page, '');
  // One visible bucket: the selector is static (no menu), as in the default interface.
  assert.equal(await page.locator('button.storageSwitcher__trigger').count(), 0);
  assert.match(await page.textContent('.storageSwitcher__trigger'), /SeaweedFS - archive/);
  assert.equal(await page.locator('#storageSwitcherMenu').count(), 0);
  assert.equal(await page.getAttribute('.crumb--root', 'aria-label'), 'SeaweedFS - archive, bucket root');
  await page.unroute(/\/api\/instances/);
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, instances: [], default: '' } });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.empty');
  assert.match(await page.textContent('.empty'), /No bucket is available to you/);
  assert.match(await page.textContent('.storageSwitcher__trigger'), /No bucket/);
  assert.equal(await page.locator('.storageBucket').count(), 0);
  await page.context().close();
});

test('access: a bucket that refuses write and delete shows it in the selector, and no upload', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const instance of body.instances) {
      if (instance.id !== 'seaweedfs-archive') continue;
      for (const name of ['write', 'delete']) instance.capabilities[name] = { state: 'denied', allowed: false, verified: true, source: 'access', reason: 'The access policy refuses it.' };
      for (const name of ['upload', 'overwrite', 'createFolder', 'delete', 'copy', 'move', 'rename']) instance.operations[name] = { state: 'denied', allowed: false, verified: true, source: 'access' };
    }
    await route.fulfill({ response, json: body });
  });
  await open(page, '-/seaweedfs/seaweedfs-archive/');
  const states = await page.locator('.storageSwitcher__trigger .permDot').evaluateAll(nodes => nodes.map(node => `${node.dataset.permission}:${node.dataset.state}`));
  assert.deepEqual(states.slice(1), ['write:denied', 'delete:denied']);
  await page.click('.storageSwitcher__trigger');
  const main = await page.locator('.storageBucket[data-instance="seaweedfs-main"] .permDot').evaluateAll(nodes => nodes.map(node => node.dataset.state));
  assert.ok(!main.includes('denied'));
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
  assert.ok((await listKeys(page, 'seaweedfs-main', 'reports/2026/q3/')).includes('reports/2026/q3/orders.csv'));
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

// ------------------------------------------------------------------------------------------------------------------
// 5. Providers: the same smoke test on each provider of providers.js
// ------------------------------------------------------------------------------------------------------------------

for (const [instance, provider] of Object.entries(PROVIDERS)) {
  test(`providers: ${provider.name} lists, uploads, downloads and deletes; versions and tags show only where it has them`, async () => {
    const page = await newPage();
    // The resumable download asks for a file with showSaveFilePicker, and a headless browser cannot answer. Without
    // the picker, the page uses the plain download of the browser.
    await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }));
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    assert.equal(info.versioningSupported, provider.versioning);
    await open(page, `-/${info.host}/${instance}/smoke/`);
    assert.deepEqual((await page.locator('tbody tr[data-name]').evaluateAll(rows => rows.map(row => row.dataset.name))).sort(), ['data.json', 'hello.txt', 'versioned.txt']);
    // Versions: the badge of the count where the provider keeps versions, else no column and no setting.
    if (provider.versioning) {
      await page.waitForSelector('tr[data-name="versioned.txt"] .versionCount');
      assert.match(await page.textContent('tr[data-name="versioned.txt"] .versionCount'), /2/);
    } else {
      assert.equal(await page.locator('th.col-versions').isVisible(), false);
      assert.equal(await page.locator('.versionCount').count(), 0);
    }
    // Tags: the chips in the details where the provider has tags, else no section, and the settings hide the column.
    await openDetails(page, 'hello.txt');
    if (provider.tags) {
      await page.waitForSelector('[data-tags-section] .tagChip');
      assert.deepEqual((await page.locator('[data-tags-section] .tagChip').allInnerTexts()).map(item => item.replace(/\s+/g, ' ').trim()).sort(), ['env test', 'team qa']);
    } else {
      await sleep(500);
      assert.equal(await page.locator('[data-tags-section]').count(), 0);
    }
    await page.click('.bb-modal-x');
    await page.waitForSelector('.bb-overlay', { state: 'detached' });
    await page.click('#settingsButton');
    assert.equal(await page.locator('#versionsSetting').isHidden(), !provider.versioning);
    if (!provider.tags) {
      // The server probed the tag requests at start: the controls are hidden from the first load, with no tag read.
      assert.equal(await page.locator('[data-column="tags"]').isHidden(), true);
      assert.equal(await page.locator('#uploadTagsSetting').isHidden(), true);
      assert.equal(await page.locator('th.col-tags').isVisible(), false);
    }
    await page.keyboard.press('Escape');
    // Upload, download and delete of one file.
    const body = `smoke upload on ${provider.name}\n`;
    await page.setInputFiles('#fileInput', [{ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from(body) }]);
    await page.waitForSelector('.uploadDock[data-state="done"]', { timeout: 30000 });
    // The three providers check the SHA-256 checksum of the upload and give it back.
    assert.match(await page.textContent('.uploadDock .summary'), /^1 file uploaded \([\d.]+ B\), 1 checked with SHA-256\.$/);
    await page.click('.uploadDock .button >> text=Close');
    await page.waitForSelector('tr[data-name="upload.txt"]');
    await page.click('tr[data-name="upload.txt"] .bb-kebab');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.bb-menu.is-open .bb-menu-item >> text=Download')]);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), body);
    await page.click('tr[data-name="upload.txt"] .bb-kebab');
    await page.click('.bb-menu.is-open .bb-menu-item >> text=Delete');
    await page.click('.bb-overlay .bb-btn-primary');
    await page.waitForSelector('tr[data-name="upload.txt"]', { state: 'detached' });
    assert.ok(!(await listKeys(page, instance, 'smoke/')).includes('smoke/upload.txt'));
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

// ------------------------------------------------------------------------------------------------------------------
// 6. Copy in parts (UploadPartCopy): the test image copies in parts from 8 KiB up, in parts of 5 MiB
// ------------------------------------------------------------------------------------------------------------------

const sha256 = buffer => require('crypto').createHash('sha256').update(buffer).digest('hex');

async function getObject(page, instance, key) {
  const response = await page.request.get(`${BASE}s3?instance=${instance}&key=${encodeURIComponent(key)}`);
  assert.equal(response.status(), 200, `${key}: ${response.status()}`);
  return { body: await response.body(), headers: response.headers() };
}

// Opens the menu of a row, chooses an action, and gives a new name in the prompt.
async function rowActionWithName(page, name, action, value) {
  await page.click(`tr[data-name="${name}"] .bb-kebab`);
  await page.click(`.bb-menu.is-open .bb-menu-item >> text=${action}`);
  await page.fill('.bb-overlay .bb-input', value);
  await page.click('.bb-overlay .bb-btn-primary');
}

for (const [instance, provider] of Object.entries(PROVIDERS)) {
  test(`copy in parts: ${provider.name} copies and renames a large file as a job, with its bytes, headers, metadata and tags`, async () => {
    const page = await newPage();
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    const source = await getObject(page, instance, 'copy/source.bin');
    assert.equal(source.body.length, 11 * 1024 * 1024 + 123);
    const jobs = [];
    page.on('response', async response => {
      if (/\/api\/(copy|rename|jobs\/)/.test(response.url())) jobs.push(await response.json().catch(() => ({})));
    });
    await open(page, `-/${info.host}/${instance}/copy/`);
    // The copy: the server answers with a job, and the job counts the copied bytes.
    await rowActionWithName(page, 'source.bin', 'Copy', 'copied.bin');
    await page.waitForSelector('tr[data-name="copied.bin"]', { timeout: 60000 });
    const copyJob = jobs.find(job => job.type === 'copy_object' && job.status === 'completed');
    assert.ok(copyJob, JSON.stringify(jobs));
    assert.equal(copyJob.totalBytes, source.body.length);
    assert.equal(copyJob.copiedBytes, source.body.length);
    const copied = await getObject(page, instance, 'copy/copied.bin');
    assert.equal(sha256(copied.body), sha256(source.body));
    // The copy is a multipart object of three parts.
    assert.match(copied.headers.etag, /-3"?$/);
    for (const name of ['content-type', 'cache-control', 'content-disposition', 'x-amz-meta-origin']) {
      assert.equal(copied.headers[name], source.headers[name], name);
    }
    assert.equal(copied.headers['content-type'], 'application/x-copy-test');
    assert.equal(copied.headers['x-amz-meta-origin'], 'seed');
    if (provider.tags) assert.deepEqual(await apiTags(page, 'copy/copied.bin', instance), ['team=copy']);
    // The rename: a move job, the source goes away.
    await rowActionWithName(page, 'copied.bin', 'Rename', 'moved.bin');
    await page.waitForSelector('tr[data-name="moved.bin"]', { timeout: 60000 });
    await page.waitForSelector('tr[data-name="copied.bin"]', { state: 'detached' });
    assert.ok(jobs.some(job => job.type === 'move_object' && job.status === 'completed'));
    const moved = await getObject(page, instance, 'copy/moved.bin');
    assert.equal(sha256(moved.body), sha256(source.body));
    // The gateway adds "private, no-store" to Cache-Control: the value of the provider follows it.
    assert.equal(moved.headers['cache-control'], source.headers['cache-control']);
    assert.match(moved.headers['cache-control'], /max-age=600$/);
    if (provider.tags) assert.deepEqual(await apiTags(page, 'copy/moved.bin', instance), ['team=copy']);
    assert.ok(!(await listKeys(page, instance, 'copy/')).includes('copy/copied.bin'));
    await page.request.delete(`${BASE}s3?instance=${instance}&key=${encodeURIComponent('copy/moved.bin')}`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

for (const [instance, provider] of Object.entries(PROVIDERS).filter(([, item]) => item.versioning)) {
  test(`copy in parts: ${provider.name} restores an older version above the threshold from that version`, async () => {
    const page = await newPage();
    const key = 'copy/versioned.bin';
    const list = await (await page.request.get(`${BASE}api/versions?instance=${instance}&key=${key}`)).json();
    const older = list.versions.find(version => !version.isCurrent && !version.deleteMarker);
    assert.ok(older, JSON.stringify(list));
    const response = await page.request.post(`${BASE}api/versions/restore`, { data: { instance, key, version: older.version } });
    assert.equal(response.status(), 200, await response.text());
    const restored = await getObject(page, instance, key);
    assert.equal(sha256(restored.body), sha256(Buffer.alloc(20000, 'a')));
    assert.match(restored.headers.etag, /-1"?$/);
    await page.context().close();
  });
}

// ------------------------------------------------------------------------------------------------------------------
// 7. Metadata: the edit in the details. A copy onto the key (CopyObject with x-amz-metadata-directive: REPLACE), or a
// copy in parts from 8 KiB up. Each test checks what the page says before the save against the result.
// ------------------------------------------------------------------------------------------------------------------

async function apiMetadata(page, instance, key) {
  const response = await page.request.get(`${BASE}api/metadata?instance=${instance}&key=${encodeURIComponent(key)}`);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

async function versionCount(page, instance, key) {
  const list = await (await page.request.get(`${BASE}api/versions?instance=${instance}&key=${encodeURIComponent(key)}`)).json();
  return (list.versions || []).filter(version => !version.deleteMarker).length;
}

// Opens the details of a file and the form of its metadata.
async function openMetadataForm(page, name) {
  await openDetails(page, name);
  await page.waitForSelector('[data-metadata-section] .metaEditor__view');
  assert.equal(await page.isHidden('[data-metadata-section] .metaEditor__form'), true);
  await page.click('[data-metadata-edit]');
  await page.waitForSelector('[data-metadata-section] .metaEditor__form', { state: 'visible' });
}

const metadataNotes = async page => cleanText(await page.locator('[data-metadata-section] .metaEditor__notes li').allInnerTexts());

// Saves the form. The details then open again on the current version: the function waits for the values of the new
// window.
async function saveMetadata(page, text) {
  await page.evaluate(() => { document.querySelector('[data-metadata-section]').dataset.before = 'save'; });
  await page.click('[data-metadata-save]');
  await until(page, value => {
    const sections = Array.from(document.querySelectorAll('[data-metadata-section]'));
    return sections.length === 1 && !sections[0].dataset.before && !!sections[0].querySelector('.metaEditor__view:not([hidden])')?.textContent.includes(value);
  }, text);
}

for (const [instance, provider] of Object.entries(PROVIDERS)) {
  test(`metadata: ${provider.name} edits the type and a user metadata; the date changes, the ETag stays, a new version comes where versioning is on`, async () => {
    const page = await newPage();
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    assert.equal(info.metadataEditSupported, true);
    const key = 'meta/small.txt';
    const before = await apiMetadata(page, instance, key);
    assert.equal(before.copyInParts, false);
    assert.equal(before.multipartETag, false);
    // The gateway puts its own Cache-Control in front of the stored value. The form has the stored value.
    const head = await page.request.head(`${BASE}s3?instance=${instance}&key=${encodeURIComponent(key)}`);
    assert.equal(head.headers()['cache-control'], 'private, no-store, max-age=60');
    const versionsBefore = provider.versioning ? await versionCount(page, instance, key) : 0;
    await open(page, `-/${info.host}/${instance}/meta/`);
    await openMetadataForm(page, 'small.txt');
    assert.equal(await page.inputValue('[data-metadata-header="cacheControl"]'), 'max-age=60');
    assert.equal(await page.inputValue('[data-metadata-header="contentType"]'), 'text/plain');
    assert.equal(await page.inputValue('[data-metadata-value="owner"]'), 'ada');
    // Before the save the page says what changes: the date, and a new version where versioning is on. The ETag of an
    // object in one part stays, so the page says nothing about it.
    const notes = await metadataNotes(page);
    assert.ok(notes.some(note => /modification date changes/.test(note)), notes.join(' | '));
    assert.equal(notes.some(note => /new version/.test(note)), provider.versioning, notes.join(' | '));
    assert.ok(!notes.some(note => /ETag/.test(note)), notes.join(' | '));
    assert.equal(await page.isDisabled('[data-metadata-save]'), true);
    await page.fill('[data-metadata-header="contentType"]', 'application/json');
    // S3 keeps the keys in lowercase: the field does the same.
    await page.fill('[data-metadata-section] input[aria-label="Metadata key"]', 'Reviewer');
    await page.fill('[data-metadata-section] input[aria-label="Metadata value"]', 'grace');
    await page.click('[data-metadata-add]');
    await page.waitForSelector('[data-metadata-value="reviewer"]');
    assert.match(await page.textContent('.metaEditor__count'), /^21 of 2,048 bytes$/);
    await saveMetadata(page, 'grace');
    const after = await apiMetadata(page, instance, key);
    assert.equal(after.headers.contentType, 'application/json');
    // The value of the provider, not the value of the gateway: the edit sent the stored value back.
    assert.equal(after.headers.cacheControl, 'max-age=60');
    assert.deepEqual(after.metadata, [{ key: 'owner', value: 'ada' }, { key: 'reviewer', value: 'grace' }]);
    assert.notEqual(after.lastModified, before.lastModified);
    assert.equal(after.etag, before.etag);
    if (provider.versioning) {
      assert.equal(await versionCount(page, instance, key), versionsBefore + 1);
      assert.notEqual(after.version, before.version);
      await page.waitForSelector('.bb-details--file .versionPicker__button');
      assert.equal(await page.locator('.bb-details--file .versionPicker__button').count(), 1);
    }
    if (provider.tags) assert.deepEqual(await apiTags(page, key, instance), ['team=meta']);
    assert.equal((await getObject(page, instance, key)).body.toString(), 'small metadata file\n');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  test(`metadata: ${provider.name} copies a file above the threshold in parts with the new metadata, and its ETag changes`, async () => {
    const page = await newPage();
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    const key = 'meta/large.bin';
    const before = await apiMetadata(page, instance, key);
    assert.equal(before.copyInParts, true);
    const versionsBefore = provider.versioning ? await versionCount(page, instance, key) : 0;
    const sum = sha256((await getObject(page, instance, key)).body);
    await open(page, `-/${info.host}/${instance}/meta/`);
    await openMetadataForm(page, 'large.bin');
    assert.ok((await metadataNotes(page)).some(note => /The ETag changes: S3-Browser copies an object of this size in parts\./.test(note)));
    await page.click('[data-metadata-remove="owner"]');
    await page.fill('[data-metadata-header="cacheControl"]', 'no-cache');
    await page.fill('[data-metadata-section] input[aria-label="Metadata key"]', 'stage');
    await page.fill('[data-metadata-section] input[aria-label="Metadata value"]', 'done');
    await page.press('[data-metadata-section] input[aria-label="Metadata value"]', 'Enter');
    await saveMetadata(page, 'done');
    const after = await apiMetadata(page, instance, key);
    assert.deepEqual(after.headers, { contentType: 'application/octet-stream', cacheControl: 'no-cache' });
    assert.deepEqual(after.metadata, [{ key: 'stage', value: 'done' }]);
    assert.notEqual(after.etag, before.etag);
    assert.match(after.etag, /-1$/);
    assert.notEqual(after.lastModified, before.lastModified);
    assert.equal(sha256((await getObject(page, instance, key)).body), sum);
    if (provider.versioning) assert.equal(await versionCount(page, instance, key), versionsBefore + 1);
    if (provider.tags) assert.deepEqual(await apiTags(page, key, instance), ['team=meta']);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

for (const [instance, provider] of Object.entries(PROVIDERS).filter(([, item]) => item.versioning)) {
  test(`metadata: ${provider.name} saves the metadata of an older version as the new current version`, async () => {
    const page = await newPage();
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    const key = 'meta/versioned.txt';
    const versionsBefore = await versionCount(page, instance, key);
    await open(page, `-/${info.host}/${instance}/meta/`);
    await openDetails(page, 'versioned.txt');
    await page.waitForSelector('[data-metadata-section] .metaEditor__view');
    await page.click('.versionPicker__button');
    await page.click('.versionPicker__menu:not([hidden]) .versionPicker__item >> nth=1');
    await until(page, () => document.querySelector('[data-metadata-section] .metaEditor__view')?.textContent.includes('text/plain'));
    await page.click('[data-metadata-edit]');
    assert.equal(await page.inputValue('[data-metadata-value="rev"]'), '1');
    assert.ok((await metadataNotes(page)).some(note => /This version becomes the current version, as a restore does\./.test(note)));
    await page.fill('[data-metadata-value="rev"]', '1-restored');
    await saveMetadata(page, '1-restored');
    const after = await apiMetadata(page, instance, key);
    assert.deepEqual(after.metadata, [{ key: 'rev', value: '1-restored' }]);
    assert.equal(after.headers.contentType, 'text/plain');
    assert.equal((await getObject(page, instance, key)).body.toString(), 'versioned metadata v1\n');
    assert.equal(await versionCount(page, instance, key), versionsBefore + 1);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('metadata: an object that changes while the form is open is not overwritten; the form reads the new values', async () => {
  const page = await newPage();
  const key = 'meta/conflict.txt';
  await open(page, `${MAIN}meta/`);
  await openMetadataForm(page, 'conflict.txt');
  await page.fill('[data-metadata-value="owner"]', 'from-the-form');
  // Another person changes the metadata: the ETag stays, the date changes.
  const read = await apiMetadata(page, 'seaweedfs-main', key);
  const other = await page.request.put(`${BASE}api/metadata`, { data: { instance: 'seaweedfs-main', key, etag: read.etag, lastModified: read.lastModified, headers: read.headers, metadata: [{ key: 'owner', value: 'other-person' }] } });
  assert.equal(other.status(), 200, await other.text());
  await page.click('[data-metadata-save]');
  await until(page, () => /The object changed after the form read it/.test(document.querySelector('.metaEditor__message')?.textContent || ''));
  assert.equal(await page.inputValue('[data-metadata-value="owner"]'), 'other-person');
  assert.equal(await page.isDisabled('[data-metadata-save]'), true);
  assert.deepEqual((await apiMetadata(page, 'seaweedfs-main', key)).metadata, [{ key: 'owner', value: 'other-person' }]);
  // The values are checked in the page before the save, and the server checks them again.
  await page.fill('[data-metadata-header="expires"]', 'tomorrow');
  await page.click('[data-metadata-save]');
  assert.match(await page.textContent('.metaEditor__message'), /Expires is an HTTP date/);
  const refused = await page.request.put(`${BASE}api/metadata`, { data: { instance: 'seaweedfs-main', key, etag: read.etag, headers: { expires: 'tomorrow' }, metadata: [] } });
  assert.equal(refused.status(), 400);
  assert.equal((await refused.json()).error.code, 'invalid_metadata');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('metadata: without the edit, the details keep the custom metadata and show no Edit button', async () => {
  const page = await newPage();
  // An instance that the server marked without the edit (a provider that refused it, or GCS).
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.instances) item.metadataEditSupported = false;
    await route.fulfill({ response, json: body });
  });
  await open(page, `${MAIN}meta/`);
  await openDetails(page, 'small.txt');
  await page.waitForSelector('[data-metadata-fallback]:not([hidden])');
  assert.equal(await page.locator('[data-metadata-section]').count(), 0);
  assert.equal(await page.locator('[data-metadata-edit]').count(), 0);
  await page.context().close();
  // A provider that answers 501 to the read of the metadata: the section goes and the custom metadata stays.
  const second = await newPage();
  await second.route(/\/api\/metadata/, route => route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: { code: 'metadata_unsupported', message: 'no edit' } }) }));
  await open(second, `${MAIN}meta/`);
  await openDetails(second, 'small.txt');
  await second.waitForSelector('[data-metadata-fallback]:not([hidden])');
  assert.equal(await second.locator('[data-metadata-section]').count(), 0);
  assert.match(await second.textContent('[data-metadata-fallback]'), /owner/);
  await second.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 8. Incomplete uploads: the list of the incomplete multipart uploads of a folder, and the abort. seed.js puts four
// uploads in mpu/ on each provider: one-part.bin (one part of 1 KiB), no-part.bin, and twice.bin two times.
// ------------------------------------------------------------------------------------------------------------------

async function apiMultiparts(page, instance, prefix) {
  const response = await page.request.get(`${BASE}api/multiparts?instance=${instance}&prefix=${encodeURIComponent(prefix)}`);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

// Opens the window of the incomplete uploads from the Actions menu, and waits for the table or the empty state.
async function openMultiparts(page) {
  await page.click('#actionsButton');
  await page.click('#multipartsItem');
  await until(page, () => Array.from(document.querySelectorAll('[data-multiparts] .multiparts__table, [data-multiparts] .multiparts__empty')).some(node => !node.hidden), null, 15000);
}

const multipartRows = page => page.locator('[data-multiparts] tr[data-upload-id]').evaluateAll(rows => rows.map(row => row.dataset.key).sort());
// The confirmation opens over the large window: its button is in the small window.
const confirmAbort = page => page.click('.bb-overlay:not(.bb-overlay--large) .bb-btn-primary');

for (const [instance, provider] of Object.entries(PROVIDERS)) {
  test(`incomplete uploads: ${provider.name} lists the uploads of a folder and aborts one of a key with two uploads, then one with a part`, async () => {
    const page = await newPage();
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    assert.equal(info.multipartUploadsSupported, true);
    const before = await apiMultiparts(page, instance, 'mpu/');
    assert.deepEqual(before.uploads.map(upload => upload.key).sort(), ['mpu/no-part.bin', 'mpu/one-part.bin', 'mpu/twice.bin', 'mpu/twice.bin']);
    const onePart = before.uploads.find(upload => upload.key === 'mpu/one-part.bin');
    assert.equal(onePart.parts, 1);
    assert.equal(onePart.bytes, 1024);
    // SeaweedFS gives no start date. MinIO and Garage give one.
    assert.equal(before.uploads.every(upload => Boolean(upload.initiated)), provider.name !== 'SeaweedFS', JSON.stringify(before.uploads));
    // The incomplete uploads make no object: the folder lists its one file only.
    assert.deepEqual(await listKeys(page, instance, 'mpu/'), ['mpu/readme.txt']);
    await open(page, `-/${info.host}/${instance}/mpu/`);
    await openMultiparts(page);
    assert.deepEqual(await multipartRows(page), ['mpu/no-part.bin', 'mpu/one-part.bin', 'mpu/twice.bin', 'mpu/twice.bin']);
    const row = `[data-multiparts] tr[data-upload-id="${onePart.uploadId}"]`;
    assert.equal((await page.textContent(`${row} .multiparts__parts`)).trim(), '1');
    if (provider.name === 'SeaweedFS') {
      assert.equal((await page.textContent(`${row} .multiparts__age`)).trim(), 'unknown');
      assert.match(await page.textContent('[data-multipart-undated-note]'), /gives no start date for 4 uploads/);
    } else {
      assert.notEqual((await page.textContent(`${row} .multiparts__age`)).trim(), 'unknown');
      assert.equal(await page.isHidden('[data-multipart-undated-note]'), true);
    }
    assert.match(await page.textContent('[data-multiparts] .multiparts__note'), /lifecycle rule/);
    // Abort everything older than 1 day: the uploads are a few seconds old (or without a date), so all stay.
    assert.equal(await page.inputValue('[data-multipart-older-days]'), '1');
    await page.click('[data-multipart-abort-older]');
    await confirmAbort(page);
    await until(page, () => document.querySelector('[data-multipart-message]')?.dataset.tone === 'ok');
    const olderMessage = await page.textContent('[data-multipart-message]');
    if (provider.name === 'SeaweedFS') assert.match(olderMessage, /4 uploads without a start date stayed/);
    else assert.match(olderMessage, /No upload was older than 1 day/);
    assert.equal((await apiMultiparts(page, instance, 'mpu/')).uploads.length, 4);
    // Abort selected: one of the two uploads of twice.bin. The other upload of the key stays.
    const [first, second] = before.uploads.filter(upload => upload.key === 'mpu/twice.bin');
    await page.check(`[data-multiparts] tr[data-upload-id="${first.uploadId}"] [data-multipart-select]`);
    await page.click('[data-multipart-abort-selected]');
    await confirmAbort(page);
    await page.waitForSelector(`[data-multiparts] tr[data-upload-id="${first.uploadId}"]`, { state: 'detached' });
    await page.waitForSelector(`[data-multiparts] tr[data-upload-id="${second.uploadId}"]`);
    assert.match(await page.textContent('[data-multipart-message]'), /1 upload aborted/);
    // The abort button of a row: the upload with a part.
    await page.click(`${row} [data-multipart-abort-one]`);
    await confirmAbort(page);
    await page.waitForSelector(row, { state: 'detached' });
    assert.deepEqual((await apiMultiparts(page, instance, 'mpu/')).uploads.map(upload => upload.uploadId).sort(),
      [second.uploadId, before.uploads.find(upload => upload.key === 'mpu/no-part.bin').uploadId].sort());
    // The last two uploads go through the API; the window then shows its empty state.
    const rest = (await apiMultiparts(page, instance, 'mpu/')).uploads.map(({ key, uploadId }) => ({ key, uploadId }));
    const aborted = await page.request.post(`${BASE}api/multiparts/abort`, { data: { instance, uploads: rest } });
    assert.equal(aborted.status(), 200, await aborted.text());
    assert.equal((await aborted.json()).aborted.length, 2);
    await page.click('.bb-modal--large .bb-modal-x');
    await page.waitForSelector('.bb-overlay', { state: 'detached' });
    await openMultiparts(page);
    assert.equal((await page.textContent('[data-multiparts] .multiparts__empty')).trim(), 'No incomplete upload');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('incomplete uploads: an upload that this S3-Browser sends now cannot be aborted', async () => {
  const page = await newPage();
  // A resumable upload of the page: the server creates the multipart upload and keeps the session.
  const created = await page.request.post(`${BASE}api/uploads`, { data: { instance: 'seaweedfs-main', key: 'mpu/active.bin', size: 6 * 1024 * 1024, contentType: 'application/octet-stream' } });
  assert.equal(created.status(), 201, await created.text());
  const session = await created.json();
  try {
    const listed = (await apiMultiparts(page, 'seaweedfs-main', 'mpu/')).uploads.find(upload => upload.key === 'mpu/active.bin');
    assert.equal(listed.active, true);
    await open(page, `${MAIN}mpu/`);
    await openMultiparts(page);
    const row = `[data-multiparts] tr[data-upload-id="${listed.uploadId}"]`;
    assert.match(await page.textContent(row), /Uploading now/);
    assert.equal(await page.locator(`${row} [data-multipart-select]`).count(), 0);
    assert.equal(await page.locator(`${row} [data-multipart-abort-one]`).count(), 0);
    // The server refuses it too.
    const refused = await (await page.request.post(`${BASE}api/multiparts/abort`, { data: { instance: 'seaweedfs-main', uploads: [{ key: 'mpu/active.bin', uploadId: listed.uploadId }] } })).json();
    assert.equal(refused.aborted.length, 0);
    assert.equal(refused.skipped.length, 1);
  } finally {
    await page.request.delete(`${BASE}api/uploads`, { headers: { 'X-S3-Browser-Resume-Token': session.resumeToken } });
  }
  assert.equal((await apiMultiparts(page, 'seaweedfs-main', 'mpu/')).uploads.some(upload => upload.key === 'mpu/active.bin'), false);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('incomplete uploads: the item is hidden for an instance without the list', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.instances) item.multipartUploadsSupported = false;
    await route.fulfill({ response, json: body });
  });
  await open(page, `${MAIN}mpu/`);
  await page.click('#actionsButton');
  assert.equal(await page.isHidden('#multipartsItem'), true);
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 9. Lifecycle rules: the editor of the Actions menu. Each test writes the rules of the bucket through the S3 API of
// the provider first, and restores the rules of the seed at the end: the tests of the tags read the rule of SeaweedFS.
// ------------------------------------------------------------------------------------------------------------------

// A rule with an expiration on a date: the editor keeps it as is, and the three providers keep it.
const KEPT_RULE = '<Rule><ID>keep-date</ID><Filter><Prefix>archive/</Prefix></Filter><Status>Enabled</Status><Expiration><Date>2030-01-01T00:00:00Z</Date></Expiration></Rule>';
// The fields that each provider keeps (test/README.md). The buckets of SeaweedFS and MinIO have versioning.
const LIFECYCLE_FIELDS = {
  'seaweedfs-main': { tagFilter: true, noncurrentExpiration: true, abortMultipart: true, expiredDeleteMarker: true },
  'minio-main': { tagFilter: true, noncurrentExpiration: true, abortMultipart: false, expiredDeleteMarker: true },
  'garage-main': { tagFilter: false, noncurrentExpiration: false, abortMultipart: true, expiredDeleteMarker: false },
};

// Opens the window of the lifecycle rules from the Actions menu, and waits for the rules.
async function openLifecycle(page) {
  await page.click('#actionsButton');
  await page.click('#lifecycleItem');
  await until(page, () => !document.querySelector('[data-lifecycle] .lifecycle__intro')?.hidden, null, 15000);
}

const confirmLifecycle = page => page.click('.bb-overlay:not(.bb-overlay--large) .bb-btn-primary');
const lifecycleMessage = page => page.textContent('[data-lifecycle-message]');
// The raw XML of one rule in a configuration, as the provider sends it.
const ruleXML = (xml, id) => (xml.match(new RegExp(`<Rule>(?:(?!</Rule>).)*<ID>${id}</ID>(?:(?!</Rule>).)*</Rule>`, 's')) || [''])[0];

for (const [instance, provider] of Object.entries(PROVIDERS)) {
  test(`lifecycle: ${provider.name} adds a rule after a confirmation of the deletion, keeps the other rule, and offers only the fields that it keeps`, async () => {
    const page = await newPage();
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    assert.equal(info.lifecycleSupported, true);
    await writeLifecycle(instance, `<LifecycleConfiguration>${KEPT_RULE}</LifecycleConfiguration>`);
    const keptBefore = ruleXML(await readLifecycle(instance), 'keep-date');
    assert.ok(keptBefore, 'the provider keeps the rule with a date');
    try {
      await open(page, `-/${info.host}/${instance}/smoke/`);
      await openLifecycle(page);
      // The rule with a date is a read-only row with its reason and its XML.
      const kept = '[data-lifecycle-kept="keep-date"]';
      assert.match(await page.textContent(kept), /Kept as is/);
      assert.match(await page.textContent(kept), /It expires the objects on a date\. S3-Browser writes it back unchanged\./);
      assert.equal(await page.locator('[data-lifecycle-rule]').count(), 0);
      await page.click('[data-lifecycle-add]');
      const rule = page.locator('[data-lifecycle-rule]').last();
      // The fields of the provider: the others are listed with the reason.
      const fields = LIFECYCLE_FIELDS[instance];
      assert.equal(await rule.locator('[data-lifecycle-tag]').count(), fields.tagFilter ? 1 : 0);
      assert.equal(await rule.locator('[data-lifecycle-action="noncurrent"]').count(), fields.noncurrentExpiration ? 1 : 0);
      assert.equal(await rule.locator('[data-lifecycle-action="abort"]').count(), fields.abortMultipart ? 1 : 0);
      assert.equal(await rule.locator('[data-lifecycle-action="deleteMarker"]').count(), fields.expiredDeleteMarker ? 1 : 0);
      const hidden = await page.locator('[data-lifecycle-hidden] li').evaluateAll(items => items.map(item => item.dataset.field).sort());
      assert.deepEqual(hidden, Object.keys(fields).filter(field => !fields[field]).sort());
      if (instance === 'minio-main') assert.match(await page.textContent('[data-lifecycle-hidden] li[data-field="abortMultipart"]'), /MinIO does not keep the abort/);
      if (instance === 'garage-main') assert.match(await page.textContent('[data-lifecycle-hidden] li[data-field="tagFilter"]'), /Garage drops the tag filter/);
      // The new rule starts with the folder of the listing and no action.
      assert.equal(await rule.locator('[data-lifecycle-prefix]').inputValue(), 'smoke/');
      await page.click('[data-lifecycle-save]');
      assert.match(await lifecycleMessage(page), /has no action: choose at least one/);
      await rule.locator('[data-lifecycle-id]').fill('lc-test');
      await rule.locator('[data-lifecycle-action="expiration"]').check();
      await rule.locator('[data-lifecycle-days="expiration"]').fill('30');
      await page.click('[data-lifecycle-save]');
      await page.waitForSelector('[data-lifecycle-confirm]');
      assert.deepEqual(cleanText(await page.locator('[data-lifecycle-confirm] li').allInnerTexts()), ['Objects under smoke/ older than 30 days will be deleted.']);
      await confirmLifecycle(page);
      await until(page, () => document.querySelector('[data-lifecycle-message]')?.dataset.tone === 'ok');
      assert.equal(await lifecycleMessage(page), 'The lifecycle rules are saved.');
      assert.equal(await page.locator('[data-lifecycle-warnings] li').count(), 0);
      // The provider has the new rule, and the other rule with its bytes.
      const after = await readLifecycle(instance);
      assert.match(ruleXML(after, 'lc-test'), /<Prefix>smoke\/<\/Prefix>/);
      assert.match(ruleXML(after, 'lc-test'), /<Days>30<\/Days>/);
      assert.equal(ruleXML(after, 'keep-date'), keptBefore);
      // After a reload of the page, the window shows the rule.
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.dataTable, .empty');
      await openLifecycle(page);
      const saved = page.locator('[data-lifecycle-rule]');
      assert.equal(await saved.count(), 1);
      assert.equal(await saved.locator('[data-lifecycle-id]').inputValue(), 'lc-test');
      assert.equal(await saved.locator('[data-lifecycle-prefix]').inputValue(), 'smoke/');
      assert.equal(await saved.locator('[data-lifecycle-action="expiration"]').isChecked(), true);
      assert.equal(await saved.locator('[data-lifecycle-days="expiration"]').inputValue(), '30');
      assert.equal(await page.locator(kept).count(), 1);
      // A save without a change of a deletion asks nothing: the rule is disabled.
      await saved.locator('[data-lifecycle-enabled]').uncheck();
      await page.click('[data-lifecycle-save]');
      await until(page, () => document.querySelector('[data-lifecycle-message]')?.dataset.tone === 'ok');
      assert.match(ruleXML(await readLifecycle(instance), 'lc-test'), /<Status>Disabled<\/Status>/);
      assert.deepEqual(page.errors, []);
    } finally {
      await restoreLifecycle(instance);
      await page.context().close();
    }
  });
}

test('lifecycle: a change of the rules after the window read them stops the save, and the window reads them again', async () => {
  const page = await newPage();
  try {
    await open(page, `${MAIN}logs/`);
    await openLifecycle(page);
    // The rule of the seed has a tag filter, which SeaweedFS keeps: the window edits it.
    const seed = page.locator('[data-lifecycle-rule]');
    assert.equal(await seed.count(), 1);
    assert.equal(await seed.locator('[data-lifecycle-tag]').inputValue(), 'retention=30d');
    await writeLifecycle('seaweedfs-main', `<LifecycleConfiguration>${ruleXML(await readLifecycle('seaweedfs-main'), 'expire-logs')}${KEPT_RULE}</LifecycleConfiguration>`);
    await seed.locator('[data-lifecycle-days="expiration"]').fill('45');
    await page.click('[data-lifecycle-save]');
    await page.waitForSelector('[data-lifecycle-confirm]');
    assert.deepEqual(cleanText(await page.locator('[data-lifecycle-confirm] li').allInnerTexts()), ['Objects under logs/ with the tag retention=30d older than 45 days will be deleted.']);
    await confirmLifecycle(page);
    await until(page, () => document.querySelector('[data-lifecycle-message]')?.dataset.tone === 'error');
    assert.match(await lifecycleMessage(page), /changed after this window read them/);
    assert.match(ruleXML(await readLifecycle('seaweedfs-main'), 'expire-logs'), /<Days>30<\/Days>/);
    await page.click('[data-lifecycle-reload]');
    await page.waitForSelector('[data-lifecycle-kept="keep-date"]');
    assert.equal(await page.locator('[data-lifecycle-rule] [data-lifecycle-days="expiration"]').inputValue(), '30');
    assert.deepEqual(page.errors, []);
  } finally {
    await restoreLifecycle('seaweedfs-main');
    await page.context().close();
  }
});

for (const [instance, provider] of Object.entries(PROVIDERS)) {
  test(`lifecycle: ${provider.name}: the window of the incomplete uploads opens the editor${LIFECYCLE_FIELDS[instance].abortMultipart ? ' with a rule that aborts them' : ' and says that the provider does not keep such a rule'}`, async () => {
    const page = await newPage();
    const info = (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);
    const offered = LIFECYCLE_FIELDS[instance].abortMultipart;
    try {
      await open(page, `-/${info.host}/${instance}/mpu/`);
      await openMultiparts(page);
      await page.waitForSelector('[data-multipart-lifecycle]');
      const note = await page.textContent('[data-multipart-lifecycle-note]');
      if (offered) {
        assert.equal((await page.textContent('[data-multipart-lifecycle]')).trim(), 'Add a lifecycle rule');
        assert.doesNotMatch(note, /does not keep/);
      } else {
        assert.equal((await page.textContent('[data-multipart-lifecycle]')).trim(), 'Lifecycle rules');
        assert.match(note, /a number of days after their start\. MinIO does not keep the abort of incomplete multipart uploads/);
      }
      await page.click('[data-multipart-lifecycle]');
      await until(page, () => document.querySelectorAll('.bb-modal--large').length === 1 && !document.querySelector('[data-lifecycle] .lifecycle__intro')?.hidden, null, 15000);
      if (!offered) {
        assert.equal(await page.locator('[data-lifecycle-rule]').count(), 0);
        return;
      }
      // The new rule comes after the rules of the bucket (SeaweedFS has the rule of the seed).
      assert.equal(await page.locator('[data-lifecycle-rule]').count(), instance === 'seaweedfs-main' ? 2 : 1);
      const rule = page.locator('[data-lifecycle-rule]').last();
      assert.equal(await rule.locator('[data-lifecycle-id]').inputValue(), 'abort-incomplete-uploads');
      assert.equal(await rule.locator('[data-lifecycle-prefix]').inputValue(), 'mpu/');
      assert.equal(await rule.locator('[data-lifecycle-action="abort"]').isChecked(), true);
      assert.equal(await rule.locator('[data-lifecycle-days="abort"]').inputValue(), '7');
      assert.equal(await rule.locator('[data-lifecycle-action="expiration"]').isChecked(), false);
      await page.click('[data-lifecycle-save]');
      await page.waitForSelector('[data-lifecycle-confirm]');
      assert.deepEqual(cleanText(await page.locator('[data-lifecycle-confirm] li').allInnerTexts()), ['Incomplete multipart uploads under mpu/ older than 7 days will be aborted, and their parts deleted.']);
      await confirmLifecycle(page);
      await until(page, () => document.querySelector('[data-lifecycle-message]')?.dataset.tone === 'ok');
      assert.match(ruleXML(await readLifecycle(instance), 'abort-incomplete-uploads'), /<DaysAfterInitiation>7<\/DaysAfterInitiation>/);
      assert.deepEqual(page.errors, []);
    } finally {
      await restoreLifecycle(instance);
      await page.context().close();
    }
  });
}

test('lifecycle: the window shows what the provider changed, and a read-only editor has no Save', async () => {
  const page = await newPage();
  let readOnly = false;
  await page.route(/\/api\/lifecycle/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (route.request().method() === 'PUT') body.warnings = ['The storage provider dropped the tag filter retention=30d of the rule "expire-logs".'];
    if (readOnly && body.editor) Object.assign(body.editor, { writable: false, readOnlyReason: 'The storage provider refused the change (HTTP 403 AccessDenied).' });
    await route.fulfill({ response, json: body });
  });
  try {
    await open(page, `${MAIN}logs/`);
    await openLifecycle(page);
    await page.locator('[data-lifecycle-rule] [data-lifecycle-enabled]').uncheck();
    await page.click('[data-lifecycle-save]');
    await until(page, () => document.querySelectorAll('[data-lifecycle-warnings] li').length === 1);
    assert.equal(await lifecycleMessage(page), 'The rules are saved, but the storage provider changed them:');
    assert.match(await page.textContent('[data-lifecycle-warnings]'), /dropped the tag filter retention=30d/);
    await page.click('.bb-modal--large .bb-modal-x');
    await page.waitForSelector('.bb-overlay', { state: 'detached' });
    readOnly = true;
    await openLifecycle(page);
    assert.match(await page.textContent('[data-lifecycle-readonly]'), /You cannot change the rules here\. The storage provider refused the change \(HTTP 403 AccessDenied\)\./);
    assert.equal(await page.locator('[data-lifecycle-rule]').count(), 0);
    assert.equal(await page.locator('[data-lifecycle-view="expire-logs"]').count(), 1);
    for (const control of ['[data-lifecycle-save]', '[data-lifecycle-add]', '[data-lifecycle-revert]']) assert.equal(await page.isHidden(control), true);
    assert.deepEqual(page.errors, []);
  } finally {
    await restoreLifecycle('seaweedfs-main');
    await page.context().close();
  }
});

test('lifecycle: the item is hidden for an instance without lifecycle rules', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.instances) item.lifecycleSupported = false;
    await route.fulfill({ response, json: body });
  });
  await open(page, MAIN);
  await page.click('#actionsButton');
  assert.equal(await page.isHidden('#lifecycleItem'), true);
  assert.equal(await page.isVisible('#multipartsItem'), true);
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 10. Object Lock: the section "Retention" of the details (the legal hold and the retention of one version), and the
// refusal of the delete of a locked version. The buckets "locked" of SeaweedFS and MinIO have Object Lock. Each test
// makes its own objects with a unique key, and deletes them at the end: the retention dates are a few seconds ahead.
// The pages open with the time zone UTC, so that the fields of a date have the UTC time.
// ------------------------------------------------------------------------------------------------------------------

// Makes an object of the locked bucket with one or two versions (the versions need one second between them).
async function makeLockedObject(instance, key, versions = 1) {
  for (let number = 1; number <= versions; number += 1) {
    await s3(instance, 'PUT', `/locked/${key}`, '', Buffer.from(`${key} version ${number}\n`), { 'content-type': 'text/plain' });
    if (number < versions) await sleep(1100);
  }
}

const lockUrl = (instance, key, version = '') => `${BASE}api/object-lock?instance=${instance}&key=${encodeURIComponent(key)}&version=${encodeURIComponent(version)}`;

async function apiLock(page, instance, key, version = '') {
  const response = await page.request.get(lockUrl(instance, key, version));
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

async function putLock(page, instance, key, version, change) {
  return page.request.put(`${BASE}api/object-lock`, { data: { instance, key, version, ...change } });
}

async function apiVersions(page, instance, key) {
  return (await (await page.request.get(`${BASE}api/versions?instance=${instance}&key=${encodeURIComponent(key)}`)).json()).versions || [];
}

// A date for the field "Retain until": the UTC time, some seconds from now.
// Chromium gives the value of a "datetime-local" input without ":00" for the second 0, and page.fill then fails: the
// date never has the second 0.
const lockField = seconds => {
  const date = new Date(Date.now() + seconds * 1000);
  if (date.getUTCSeconds() === 0) date.setUTCSeconds(1);
  return date.toISOString().slice(0, 19);
};

const lockText = (page, field) => page.textContent(`[data-lock-section] [data-lock-field="${field}"]`).then(text => text.trim());

async function closeWindow(page) {
  await page.click('.bb-modal-x');
  await page.waitForSelector('.bb-overlay', { state: 'detached' });
}

// Opens the details of the file and waits for the section Retention.
async function openLockDetails(page, name) {
  await openDetails(page, name);
  await page.waitForSelector('[data-lock-section] [data-lock-field="legalHold"]');
}

// Clicks Save and waits for the message of the section. The form closes.
async function saveLock(page) {
  await page.click('[data-lock-save]');
  await until(page, () => document.querySelector('[data-lock-message]')?.textContent === 'The retention is saved.');
  assert.equal(await page.isHidden('[data-lock-section] .lockEditor__form'), true);
}

// The small window of a confirmation, over the large window.
const confirmWindow = '.bb-overlay:not(.bb-overlay--large)';

// Opens the version picker of the open details and clicks an action button (download, restore or remove) of a version.
async function pickerAction(page, version, action) {
  await page.click('.bb-details-head .versionPicker__button');
  await page.hover(`.versionPicker__item[data-version="${version}"]`);
  await page.click(`.versionPicker__item[data-version="${version}"] [data-version-action="${action}"]`);
}

const lockedHostOf = async (page, instance) => (await (await page.request.get(`${BASE}api/instances`)).json()).instances.find(item => item.id === instance);

for (const [instance, provider] of Object.entries(LOCKED)) {
  test(`object lock: ${provider.name} sets a legal hold, refuses the delete of the version with a clear message, and deletes it after the hold goes`, async () => {
    const page = await newPage({ timezoneId: 'UTC' });
    const info = await lockedHostOf(page, instance);
    assert.equal(info.objectLockSupported, true);
    const key = `lock/hold-${Date.now()}.txt`;
    const name = key.split('/').pop();
    await makeLockedObject(instance, key, 2);
    const held = (await apiVersions(page, instance, key)).find(version => version.isCurrent);
    await open(page, `-/${info.host}/${instance}/lock/`);
    await openLockDetails(page, name);
    assert.equal(await lockText(page, 'mode'), 'No retention');
    assert.equal(await lockText(page, 'legalHold'), 'Off');
    assert.equal(await lockText(page, 'default'), 'None');
    assert.equal(await page.isHidden('[data-lock-section] .lockEditor__form'), true);
    await page.click('[data-lock-edit]');
    await page.waitForSelector('[data-lock-legal-hold]', { state: 'visible' });
    assert.equal(await page.isDisabled('[data-lock-save]'), true);
    await page.check('[data-lock-legal-hold]');
    await saveLock(page);
    assert.equal(await lockText(page, 'legalHold'), 'On');
    const state = await apiLock(page, instance, key);
    assert.equal(state.legalHold, true);
    assert.equal(state.version, held.version);
    assert.equal(state.retention, null);
    // The version picker of the details: the delete of the locked version fails, and the toast says why.
    await pickerAction(page, held.version, 'remove');
    await page.click(`${confirmWindow} .bb-btn-primary`);
    await page.waitForSelector('.bb-toast.is-error');
    const toast = await page.textContent('.bb-toast.is-error');
    assert.match(toast, /Object Lock/);
    assert.match(toast, /legal hold/);
    assert.equal(await versionCount(page, instance, key), 2);
    await page.click('.versionPicker__button');
    assert.equal(await page.locator(`.versionPicker__item[data-version="${held.version}"] [data-version-action="remove"]`).count(), 1);
    await page.keyboard.press('Escape');
    await closeWindow(page);
    // The hold goes off in the details, and then the delete works.
    await openLockDetails(page, name);
    await page.click('[data-lock-edit]');
    await page.uncheck('[data-lock-legal-hold]');
    await saveLock(page);
    assert.equal(await lockText(page, 'legalHold'), 'Off');
    assert.equal((await apiLock(page, instance, key)).legalHold, false);
    // The delete works now. The details open again, and a file with one version has no picker.
    await pickerAction(page, held.version, 'remove');
    await page.click(`${confirmWindow} .bb-btn-primary`);
    await page.waitForSelector('.bb-toast >> text=Version deleted.');
    assert.equal(await versionCount(page, instance, key), 1);
    await until(page, () => !document.querySelector('.bb-details-head .versionPicker__button') && document.querySelector('[data-lock-section] [data-lock-field="legalHold"]'));
    // The other version has no lock: the delete works, and the object is gone.
    const rest = (await apiVersions(page, instance, key)).find(version => !version.deleteMarker);
    const removed = await page.request.delete(`${BASE}api/versions?instance=${instance}&key=${encodeURIComponent(key)}&version=${encodeURIComponent(rest.version)}`);
    assert.equal(removed.status(), 204);
    assert.equal(await versionCount(page, instance, key), 0);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  test(`object lock: ${provider.name} extends a Governance retention, needs the bypass to shorten it, and the bypass works`, async () => {
    const page = await newPage({ timezoneId: 'UTC' });
    const info = await lockedHostOf(page, instance);
    const key = `lock/governance-${Date.now()}.txt`;
    const name = key.split('/').pop();
    await makeLockedObject(instance, key);
    await open(page, `-/${info.host}/${instance}/lock/`);
    await openLockDetails(page, name);
    // A first retention of one minute.
    await page.click('[data-lock-edit]');
    await page.waitForSelector('[data-lock-until]', { state: 'visible' });
    assert.equal(await page.inputValue('[data-lock-until]'), '');
    assert.equal(await page.inputValue('[data-lock-mode]'), 'GOVERNANCE');
    await page.fill('[data-lock-until]', lockField(60));
    await saveLock(page);
    assert.equal(await lockText(page, 'mode'), 'Governance');
    assert.match(await lockText(page, 'until'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);
    assert.match(await page.textContent('[data-lock-note]'), /Users with the bypass right can shorten or remove it\./);
    let state = await apiLock(page, instance, key);
    assert.equal(state.retention.mode, 'GOVERNANCE');
    assert.equal(state.retention.active, true);
    const first = state.retention.retainUntil;
    // A later date: no confirmation.
    await page.click('[data-lock-edit]');
    await page.fill('[data-lock-until]', lockField(120));
    await saveLock(page);
    assert.equal(await page.locator(confirmWindow).count(), 0);
    state = await apiLock(page, instance, key);
    assert.ok(Date.parse(state.retention.retainUntil) > Date.parse(first) + 30000, `${state.retention.retainUntil} after ${first}`);
    const extended = state.retention.retainUntil;
    // An earlier date: the page asks first and names the bypass. Cancel changes nothing.
    await page.click('[data-lock-edit]');
    const shorter = lockField(10);
    await page.fill('[data-lock-until]', shorter);
    await page.click('[data-lock-save]');
    await page.waitForSelector(confirmWindow);
    const dialog = await page.textContent(confirmWindow);
    assert.match(dialog, /Bypass the Governance retention/);
    assert.match(dialog, /x-amz-bypass-governance-retention/);
    assert.match(dialog, /shortens the Governance retention/);
    await page.click(`${confirmWindow} button:has-text("Cancel")`);
    await page.waitForSelector(confirmWindow, { state: 'detached' });
    assert.equal((await apiLock(page, instance, key)).retention.retainUntil, extended);
    assert.equal(await page.isVisible('[data-lock-section] .lockEditor__form'), true);
    // The same change, confirmed: the bypass goes with the request.
    await page.click('[data-lock-save]');
    await page.waitForSelector(confirmWindow);
    await page.click(`${confirmWindow} .bb-btn-primary`);
    await until(page, () => document.querySelector('[data-lock-message]')?.textContent === 'The retention is saved.');
    state = await apiLock(page, instance, key);
    assert.equal(state.retention.retainUntil, `${shorter}Z`);
    assert.equal(state.retention.mode, 'GOVERNANCE');
    assert.equal(await lockText(page, 'until'), `${shorter.replace('T', ' ')} UTC`);
    // The retention ends, and then the version goes.
    const end = Date.now() + 25000;
    while ((await apiLock(page, instance, key)).retention?.active && Date.now() < end) await sleep(500);
    assert.equal((await apiLock(page, instance, key)).retention.active, false);
    const removed = await page.request.delete(`${BASE}api/versions?instance=${instance}&key=${encodeURIComponent(key)}&version=${encodeURIComponent(state.version)}`);
    assert.equal(removed.status(), 204, await removed.text());
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  test(`object lock: ${provider.name} never shortens a Compliance retention`, async () => {
    const page = await newPage({ timezoneId: 'UTC' });
    const info = await lockedHostOf(page, instance);
    const key = `lock/compliance-${Date.now()}.txt`;
    const name = key.split('/').pop();
    await makeLockedObject(instance, key);
    await open(page, `-/${info.host}/${instance}/lock/`);
    await openLockDetails(page, name);
    await page.click('[data-lock-edit]');
    await page.selectOption('[data-lock-mode]', 'COMPLIANCE');
    await page.fill('[data-lock-until]', lockField(25));
    await saveLock(page);
    assert.equal(await lockText(page, 'mode'), 'Compliance');
    assert.match(await page.textContent('[data-lock-note]'), /Nobody can shorten or remove it before this date, not even the owner of the bucket\./);
    const state = await apiLock(page, instance, key);
    assert.equal(state.retention.mode, 'COMPLIANCE');
    // An earlier date: the page refuses it and sends no request.
    const puts = [];
    page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/object-lock')) puts.push(request.url()); });
    await page.click('[data-lock-edit]');
    assert.equal(await page.isDisabled('[data-lock-mode]'), true);
    await page.fill('[data-lock-until]', lockField(10));
    await page.click('[data-lock-save]');
    const refusal = await page.textContent('[data-lock-message]');
    assert.match(refusal, /A Compliance retention cannot be shortened/);
    assert.match(refusal, /nobody can shorten or remove it before \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC, not even the owner of the bucket\./);
    assert.equal(await page.getAttribute('[data-lock-message]', 'data-tone'), 'error');
    assert.equal(await page.locator(confirmWindow).count(), 0);
    await sleep(300);
    assert.deepEqual(puts, []);
    assert.equal((await apiLock(page, instance, key)).retention.retainUntil, state.retention.retainUntil);
    // The server has the same rule.
    const earlier = await putLock(page, instance, key, state.version, { retention: { mode: 'COMPLIANCE', retainUntil: `${lockField(10)}Z` } });
    assert.equal(earlier.status(), 409);
    assert.equal((await earlier.json()).error.code, 'compliance_retention');
    const governance = await putLock(page, instance, key, state.version, { retention: { mode: 'GOVERNANCE', retainUntil: `${lockField(40)}Z` }, bypassGovernance: true });
    assert.equal(governance.status(), 409);
    assert.equal((await governance.json()).error.code, 'compliance_retention');
    // A later date works.
    const later = await putLock(page, instance, key, state.version, { retention: { mode: 'COMPLIANCE', retainUntil: `${lockField(35)}Z` } });
    assert.equal(later.status(), 200, await later.text());
    assert.ok(Date.parse((await later.json()).retention.retainUntil) > Date.parse(state.retention.retainUntil));
    // The retention ends, and then the version goes.
    const end = Date.now() + 45000;
    while ((await apiLock(page, instance, key)).retention?.active && Date.now() < end) await sleep(500);
    assert.equal((await apiLock(page, instance, key)).retention.active, false);
    const removed = await page.request.delete(`${BASE}api/versions?instance=${instance}&key=${encodeURIComponent(key)}&version=${encodeURIComponent(state.version)}`);
    assert.equal(removed.status(), 204, await removed.text());
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('object lock: the Retention section is hidden on Garage and on a bucket without Object Lock', async () => {
  const page = await newPage();
  const instances = (await (await page.request.get(`${BASE}api/instances`)).json()).instances;
  const flags = Object.fromEntries(instances.map(item => [item.id, item.objectLockSupported]));
  for (const instance of ['garage-main', 'seaweedfs-main', 'minio-main']) assert.equal(flags[instance], false, instance);
  for (const instance of Object.keys(LOCKED)) assert.equal(flags[instance], true, instance);
  for (const instance of ['garage-main', 'seaweedfs-main']) {
    const info = instances.find(item => item.id === instance);
    await open(page, `-/${info.host}/${instance}/smoke/`);
    await openDetails(page, 'hello.txt');
    await page.waitForSelector('[data-details-tool-card="integrity"]');
    await page.waitForSelector('[data-metadata-section] .metaEditor__view');
    assert.equal(await page.locator('[data-lock-section]').count(), 0, instance);
    assert.equal(await visibleText(page, 'Retention'), 0, instance);
    const response = await page.request.get(lockUrl(instance, 'smoke/hello.txt'));
    assert.equal(response.status(), 501, instance);
    assert.equal((await response.json()).error.code, 'object_lock_unsupported');
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

for (const [instance, provider] of Object.entries(LOCKED)) {
  test(`object lock: ${provider.name}: the delete of a file and of a folder says that a version with a lock stays, before and after`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    const stamp = Date.now();
    const key = `lockdel/file-${stamp}.txt`;
    const folder = `lockdel/folder-${stamp}/`;
    await makeLockedObject(instance, key);
    await makeLockedObject(instance, `${folder}inner.txt`);
    await open(page, `-/${info.host}/${instance}/lockdel/`);
    // The file: the confirmation has the sentence of Object Lock, and a warning follows the delete.
    await page.click(`tr[data-name="file-${stamp}.txt"] .bb-kebab`);
    await page.click('.bb-menu.is-open .bb-menu-item >> text=Delete');
    await page.waitForSelector('.bb-overlay [data-lock-delete-note]');
    assert.equal((await page.textContent('[data-lock-delete-note]')).trim(), 'This bucket has Object Lock. The delete adds a delete marker. A version that a lock protects stays in the bucket.');
    assert.doesNotMatch(await page.textContent('.bb-overlay .bb-modal-body'), /Permanently/);
    await page.click('.bb-overlay .bb-btn-primary');
    await page.waitForSelector('.bb-toast.is-warning');
    assert.match(await page.textContent('.bb-toast.is-warning'), /lock protects stay in the bucket.*delete marker/s);
    await page.waitForSelector(`tr[data-name="file-${stamp}.txt"]`, { state: 'detached' });
    // The version stays, behind a delete marker.
    const versions = await apiVersions(page, instance, key);
    assert.equal(versions.filter(version => !version.deleteMarker).length, 1);
    assert.equal(versions.filter(version => version.deleteMarker).length, 1);
    // The folder: the same sentence and the same warning.
    await page.evaluate(() => document.querySelectorAll('.bb-toast').forEach(node => node.remove()));
    await page.click(`tr[data-name="folder-${stamp}"] .bb-kebab`);
    await page.click('.bb-menu.is-open .bb-menu-item >> text=Delete');
    await page.waitForSelector('.bb-overlay [data-lock-delete-note]');
    await page.click('.bb-overlay .bb-btn-primary');
    await page.waitForSelector('.bb-toast.is-warning', { timeout: 30000 });
    assert.match(await page.textContent('.bb-toast.is-warning'), new RegExp(`${folder}: the delete added a delete marker`));
    assert.equal((await apiVersions(page, instance, `${folder}inner.txt`)).filter(version => !version.deleteMarker).length, 1);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

// A bucket with versioning: a delete adds a delete marker. MinIO still lists the folder of such an object with a delimiter,
// and the folder is empty. The page must not show it, after the delete of the last file, and after the delete of a folder.
const GHOST_INSTANCES = [
  { id: 'minio-main', bucket: 'default' }, { id: 'seaweedfs-main', bucket: 'default' },
  { id: 'minio-locked', bucket: 'locked' }, { id: 'seaweedfs-locked', bucket: 'locked' },
];

async function purgeVersions(page, instance, key) {
  for (const version of await apiVersions(page, instance, key)) {
    await page.request.delete(`${BASE}api/versions?instance=${instance}&key=${encodeURIComponent(key)}&version=${encodeURIComponent(version.version)}`);
  }
}

const listedNames = async (page, instance, prefix) => ((await (await page.request.get(`${BASE}api/list?instance=${instance}&prefix=${encodeURIComponent(prefix)}`)).json()).items || []).map(item => item.name);

for (const { id: instance, bucket } of GHOST_INSTANCES) {
  test(`listing: ${instance}: a folder with no live object is not listed, after the delete of its last file and after the delete of the folder`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    assert.equal(info.versioningSupported, true);
    const stamp = Date.now();
    const parent = 'ghost-tests/';
    const single = `${parent}one-${stamp}/a.txt`;
    const many = [`${parent}many-${stamp}/a.txt`, `${parent}many-${stamp}/b.txt`];
    const keep = `${parent}keep-${stamp}/a.txt`;
    for (const key of [single, ...many, keep]) await s3(instance, 'PUT', `/${bucket}/${key}`, '', Buffer.from(`${key}\n`), { 'content-type': 'text/plain' });
    try {
      assert.deepEqual((await listedNames(page, instance, parent)).sort(), [`keep-${stamp}/`, `many-${stamp}/`, `one-${stamp}/`]);
      // The last file of a folder: after the delete, the folder is not in the parent.
      await open(page, `-/${info.host}/${instance}/${parent}one-${stamp}/`);
      await page.click('tr[data-name="a.txt"] .bb-kebab');
      await page.click('.bb-menu.is-open .bb-menu-item >> text=Delete');
      await page.click('.bb-overlay .bb-btn-primary');
      await page.waitForSelector('tr[data-name="a.txt"]', { state: 'detached' });
      await open(page, `-/${info.host}/${instance}/${parent}`);
      assert.equal(await page.locator(`tr[data-name="one-${stamp}"]`).count(), 0);
      assert.deepEqual((await listedNames(page, instance, parent)).sort(), [`keep-${stamp}/`, `many-${stamp}/`]);
      // A folder with two files: the delete of the folder, then a reload.
      await page.click(`tr[data-name="many-${stamp}"] .bb-kebab`);
      await page.click('.bb-menu.is-open .bb-menu-item >> text=Delete');
      await page.click('.bb-overlay .bb-btn-primary');
      await page.waitForSelector(`tr[data-name="many-${stamp}"]`, { state: 'detached', timeout: 30000 });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.dataTable, .empty');
      assert.equal(await page.locator(`tr[data-name="many-${stamp}"]`).count(), 0);
      assert.deepEqual(await listedNames(page, instance, parent), [`keep-${stamp}/`]);
      // The folder with a live file stays.
      assert.equal(await page.locator(`tr[data-name="keep-${stamp}"]`).count(), 1);
      assert.deepEqual(page.errors, []);
    } finally {
      for (const key of [single, ...many, keep]) await purgeVersions(page, instance, key);
      await page.context().close();
    }
  });
}

test('object lock: a bucket without Object Lock has no sentence of Object Lock in the confirmation of a delete', async () => {
  const page = await newPage();
  await open(page, `${MAIN}smoke/`);
  await page.click('tr[data-name="hello.txt"] .bb-kebab');
  await page.click('.bb-menu.is-open .bb-menu-item >> text=Delete');
  await page.waitForSelector('.bb-overlay .bb-modal-text');
  assert.match(await page.textContent('.bb-overlay .bb-modal-body'), /^Permanently delete "smoke\/hello\.txt"\?$/);
  assert.equal(await page.locator('[data-lock-delete-note]').count(), 0);
  await page.click('.bb-overlay .bb-btn:not(.bb-btn-primary):not(.bb-modal-x)');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------------------------
// 11. Encryption: the key encryption = "sse-s3" of a bucket, and the section "Encryption" of the details. The buckets
// "encrypted" of SeaweedFS and MinIO really encrypt (a test key in the stack). The instance garage-encrypted has the
// bucket "default" of Garage: Garage accepts the header and does not encrypt. The tests of the writes make their
// source objects with s3(), without the header, and so they show that the server adds it. Each test makes its own
// objects with a unique key in the folder enc/ and deletes them.
// ------------------------------------------------------------------------------------------------------------------

const ENCRYPTION_XML = '<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>';
const encryptionText = (page, field) => page.textContent(`[data-encryption-section] [data-encryption-field="${field}"]`).then(text => text.trim());
const encryptionStamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

// The path of an object for s3(), with its bucket, and the HEAD headers on the provider.
const encryptedPath = (instance, key) => `/${ENCRYPTED[instance].bucket}/${key}`;
const headEncrypted = (instance, key) => s3Head(instance, encryptedPath(instance, key));

// Waits until the HEAD of an object gives the header of SSE-S3 (a job of the page ends a short time before the listing).
async function assertSSE(instance, key, algorithm = 'AES256') {
  const headers = await headEncrypted(instance, key);
  assert.equal(headers['x-amz-server-side-encryption'], algorithm, `${key}: ${JSON.stringify(headers)}`);
  return headers;
}

// Waits for the section Encryption of the details with its row "object".
async function openEncryptionDetails(page, name) {
  await openDetails(page, name);
  await page.waitForSelector('[data-encryption-section] [data-encryption-field="object"]');
}

// Waits for the details of a file whose provider reports no encryption: the page removes the section.
async function openDetailsWithoutEncryption(page, name) {
  await openDetails(page, name);
  await page.waitForSelector('[data-details-tool-card="integrity"]');
  await until(page, () => !document.querySelector('[data-encryption-section]'));
}

// An upload through the page: the input, then the end of the queue and the new row.
async function uploadWithPage(page, name, buffer, timeout = 60000) {
  await page.setInputFiles('#fileInput', [{ name, mimeType: 'application/octet-stream', buffer }]);
  await page.waitForSelector('.uploadDock[data-state="done"]', { timeout });
  await page.click('.uploadDock .button >> text=Close');
  await page.waitForSelector(`tr[data-name="${name}"]`);
}

// A write through the server (PUT /s3): it adds the header of the encryption of the instance.
async function putWithServer(page, instance, key, body, headers = { 'Content-Type': 'text/plain' }) {
  const response = await page.request.put(`${BASE}s3?instance=${instance}&key=${encodeURIComponent(key)}`, { data: Buffer.from(body), headers });
  assert.equal(response.ok(), true, `${response.status()} ${await response.text()}`);
}

// A write on the provider with no encryption header: the source of the tests of the copy, the edit and the restore.
async function putPlain(instance, key, body, extra = {}) {
  await s3(instance, 'PUT', encryptedPath(instance, key), '', Buffer.from(body), { 'content-type': 'text/plain', ...extra });
  assert.equal((await headEncrypted(instance, key))['x-amz-server-side-encryption'], undefined, `${key} has no encryption`);
}

async function deleteEncrypted(page, instance, ...keys) {
  for (const key of keys) await page.request.delete(`${BASE}s3?instance=${instance}&key=${encodeURIComponent(key)}`);
}

// Waits until the object exists on the provider (the job of a move has no row to wait for in the folder of the page).
async function waitForHead(instance, key, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await headEncrypted(instance, key);
    } catch (error) {
      if (Date.now() > end) throw error;
      await sleep(300);
    }
  }
}

for (const [instance, provider] of Object.entries(ENCRYPTED)) {
  test(`encryption: ${provider.name} encrypts an upload of the page, and the details say SSE-S3; a plain object has no section`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    assert.equal(info.bucketEncryptionSupported, true);
    const answer = await (await page.request.get(`${BASE}api/encryption?instance=${instance}`)).json();
    assert.equal(answer.uploads, 'sse-s3');
    assert.equal(answer.bucketDefault, null);
    const stamp = encryptionStamp();
    const key = `enc/upload-${stamp}.txt`;
    const plain = `enc/plain-${stamp}.txt`;
    await putPlain(instance, plain, 'plain on the provider\n');
    await open(page, `-/${info.host}/${instance}/enc/`);
    await uploadWithPage(page, `upload-${stamp}.txt`, Buffer.from('uploaded by the page\n'));
    const head = await assertSSE(instance, key);
    assert.equal(head['x-amz-server-side-encryption-aws-kms-key-id'], undefined);
    await openEncryptionDetails(page, `upload-${stamp}.txt`);
    assert.equal(await page.textContent('[data-encryption-section] .bb-details-section-title'), ' Encryption');
    assert.equal(await encryptionText(page, 'object'), 'SSE-S3 (AES256)');
    // The bucket has no default encryption: the page shows no row for it, and no row of a key.
    assert.equal(await page.locator('[data-encryption-field="default"], [data-encryption-field="kmsKey"], [data-encryption-note]').count(), 0);
    assert.equal(await page.locator('.bb-details--file [data-details-tool-card="integrity"]').count(), 1);
    await closeWindow(page);
    // The provider does not encrypt this object: the section is removed.
    await openDetailsWithoutEncryption(page, `plain-${stamp}.txt`);
    assert.deepEqual(page.errors, []);
    await deleteEncrypted(page, instance, key, plain);
    await page.context().close();
  });

  test(`encryption: ${provider.name} encrypts the copy, the rename and the move of an object that has no encryption`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    const stamp = encryptionStamp();
    const key = `enc/source-${stamp}.txt`;
    const names = { copy: `copy-${stamp}.txt`, rename: `renamed-${stamp}.txt` };
    const moved = `enc/moved/moved-${stamp}.txt`;
    await putPlain(instance, key, 'a small object\n');
    await open(page, `-/${info.host}/${instance}/enc/`);
    await rowActionWithName(page, `source-${stamp}.txt`, 'Copy', names.copy);
    await page.waitForSelector(`tr[data-name="${names.copy}"]`, { timeout: 60000 });
    await assertSSE(instance, `enc/${names.copy}`);
    // The source stays as it was.
    assert.equal((await headEncrypted(instance, key))['x-amz-server-side-encryption'], undefined);
    await rowActionWithName(page, names.copy, 'Rename', names.rename);
    await page.waitForSelector(`tr[data-name="${names.rename}"]`, { timeout: 60000 });
    await page.waitForSelector(`tr[data-name="${names.copy}"]`, { state: 'detached' });
    await assertSSE(instance, `enc/${names.rename}`);
    await openEncryptionDetails(page, names.rename);
    assert.equal(await encryptionText(page, 'object'), 'SSE-S3 (AES256)');
    await closeWindow(page);
    // A move into another folder: the same request as the rename of a path.
    const response = await page.request.post(`${BASE}api/rename`, { data: { instance, src: key, dst: moved, isPrefix: false } });
    assert.equal(response.status() < 300, true, await response.text());
    await waitForHead(instance, moved);
    await assertSSE(instance, moved);
    assert.deepEqual(page.errors, []);
    await deleteEncrypted(page, instance, names.rename, moved);
    await page.context().close();
  });

  test(`encryption: ${provider.name} encrypts the copy in parts and the rename of a large object`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    const stamp = encryptionStamp();
    const key = `enc/large-${stamp}.bin`;
    const copy = `copy-large-${stamp}.bin`;
    const renamed = `renamed-large-${stamp}.bin`;
    // 20000 bytes are above the threshold of the test image (8192): the copy goes in parts (CreateMultipartUpload).
    await putPlain(instance, key, 'L'.repeat(20000));
    await open(page, `-/${info.host}/${instance}/enc/`);
    await rowActionWithName(page, `large-${stamp}.bin`, 'Copy', copy);
    await page.waitForSelector(`tr[data-name="${copy}"]`, { timeout: 60000 });
    const head = await assertSSE(instance, `enc/${copy}`);
    // An object that has the ETag of a multipart object came from a copy in parts.
    assert.match(head.etag, /-1"?$/);
    assert.equal((await getObject(page, instance, `enc/${copy}`)).body.toString(), 'L'.repeat(20000));
    await rowActionWithName(page, copy, 'Rename', renamed);
    await page.waitForSelector(`tr[data-name="${renamed}"]`, { timeout: 60000 });
    await page.waitForSelector(`tr[data-name="${copy}"]`, { state: 'detached' });
    assert.match((await assertSSE(instance, `enc/${renamed}`)).etag, /-1"?$/);
    await openEncryptionDetails(page, renamed);
    assert.equal(await encryptionText(page, 'object'), 'SSE-S3 (AES256)');
    assert.deepEqual(page.errors, []);
    await deleteEncrypted(page, instance, key, `enc/${renamed}`);
    await page.context().close();
  });

  test(`encryption: ${provider.name} encrypts the edit of the metadata, of a small and of a large object`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    const stamp = encryptionStamp();
    const keys = [`enc/meta-small-${stamp}.txt`, `enc/meta-large-${stamp}.bin`];
    await putPlain(instance, keys[0], 'a small object\n', { 'x-amz-meta-owner': 'ada' });
    await putPlain(instance, keys[1], 'M'.repeat(20000), { 'x-amz-meta-owner': 'ada' });
    await open(page, `-/${info.host}/${instance}/enc/`);
    for (const key of keys) {
      const name = key.split('/').pop();
      await openMetadataForm(page, name);
      await page.fill('[data-metadata-value="owner"]', 'grace');
      await saveMetadata(page, 'grace');
      await assertSSE(instance, key);
      assert.equal((await apiMetadata(page, instance, key)).metadata[0].value, 'grace');
      // The details open again on the new version: they say SSE-S3.
      await page.waitForSelector('[data-encryption-section] [data-encryption-field="object"]');
      assert.equal(await encryptionText(page, 'object'), 'SSE-S3 (AES256)');
      await closeWindow(page);
    }
    // The large object went in parts.
    assert.match((await headEncrypted(instance, keys[1])).etag, /-1"?$/);
    assert.deepEqual(page.errors, []);
    await deleteEncrypted(page, instance, ...keys);
    await page.context().close();
  });

  test(`encryption: ${provider.name} encrypts the restore of an older version that has no encryption`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    const stamp = encryptionStamp();
    const key = `enc/restore-${stamp}.txt`;
    await putPlain(instance, key, 'version 1, no encryption\n');
    await sleep(1100);
    await putWithServer(page, instance, key, 'version 2, from the page\n');
    await assertSSE(instance, key);
    const versions = await apiVersions(page, instance, key);
    const older = versions.find(version => !version.isCurrent && !version.deleteMarker);
    assert.ok(older, JSON.stringify(versions));
    const response = await page.request.post(`${BASE}api/versions/restore`, { data: { instance, key, version: older.version } });
    assert.equal(response.status(), 200, await response.text());
    await assertSSE(instance, key);
    assert.equal((await getObject(page, instance, key)).body.toString(), 'version 1, no encryption\n');
    assert.equal((await apiVersions(page, instance, key)).filter(version => !version.deleteMarker).length, 3);
    await open(page, `-/${info.host}/${instance}/enc/`);
    await openEncryptionDetails(page, key.split('/').pop());
    assert.equal(await encryptionText(page, 'object'), 'SSE-S3 (AES256)');
    assert.deepEqual(page.errors, []);
    await deleteEncrypted(page, instance, key);
    await page.context().close();
  });

  test(`encryption: ${provider.name} encrypts a multipart upload of the page`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    const stamp = encryptionStamp();
    const name = `parts-${stamp}.bin`;
    await open(page, `-/${info.host}/${instance}/enc/`);
    const requests = [];
    page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/uploads')) requests.push(request.url()); });
    // 33 MiB are above the threshold of the resumable upload of the page (32 MiB).
    await uploadWithPage(page, name, Buffer.alloc(33 * 1024 * 1024, 5), 120000);
    assert.ok(requests.length >= 2, `chunks: ${requests.length}`);
    const head = await assertSSE(instance, `enc/${name}`);
    assert.match(head.etag, /-\d+"?$/);
    await openEncryptionDetails(page, name);
    assert.equal(await encryptionText(page, 'object'), 'SSE-S3 (AES256)');
    assert.deepEqual(page.errors, []);
    await deleteEncrypted(page, instance, `enc/${name}`);
    await page.context().close();
  });
}

test('encryption: MinIO keeps the SSE-KMS of the source in the edit of the metadata and in the restore', async () => {
  const page = await newPage();
  const instance = 'minio-encrypted';
  const info = await lockedHostOf(page, instance);
  const key = `enc/kms-${encryptionStamp()}.txt`;
  const kms = { 'x-amz-server-side-encryption': 'aws:kms' };
  await s3(instance, 'PUT', encryptedPath(instance, key), '', Buffer.from('kms version 1\n'), { 'content-type': 'text/plain', 'x-amz-meta-rev': '1', ...kms });
  await sleep(1100);
  await s3(instance, 'PUT', encryptedPath(instance, key), '', Buffer.from('kms version 2\n'), { 'content-type': 'text/plain', 'x-amz-meta-rev': '2', ...kms });
  assert.equal((await headEncrypted(instance, key))['x-amz-server-side-encryption'], 'aws:kms');
  await open(page, `-/${info.host}/${instance}/enc/`);
  const name = key.split('/').pop();
  await openMetadataForm(page, name);
  await page.fill('[data-metadata-value="rev"]', '2-edited');
  await saveMetadata(page, '2-edited');
  // The source says aws:kms and the instance asks for AES256: the edit keeps the encryption of the source.
  const edited = await assertSSE(instance, key, 'aws:kms');
  assert.match(edited['x-amz-server-side-encryption-aws-kms-key-id'], /s3-browser-test/);
  await page.waitForSelector('[data-encryption-section] [data-encryption-field="kmsKey"]');
  assert.equal(await encryptionText(page, 'object'), 'SSE-KMS (aws:kms)');
  await closeWindow(page);
  const older = (await apiVersions(page, instance, key)).find(version => !version.isCurrent && !version.deleteMarker);
  const response = await page.request.post(`${BASE}api/versions/restore`, { data: { instance, key, version: older.version } });
  assert.equal(response.status(), 200, await response.text());
  assert.equal((await assertSSE(instance, key, 'aws:kms'))['x-amz-server-side-encryption-aws-kms-key-id'], edited['x-amz-server-side-encryption-aws-kms-key-id']);
  assert.deepEqual(page.errors, []);
  await deleteEncrypted(page, instance, key);
  await page.context().close();
});

test('encryption: an upload to an instance without encryption gives no encryption section', async () => {
  const page = await newPage();
  const info = await lockedHostOf(page, 'seaweedfs-main');
  const name = `plain-${encryptionStamp()}.txt`;
  await open(page, `-/${info.host}/seaweedfs-main/enc/`);
  await uploadWithPage(page, name, Buffer.from('uploaded to the bucket without encryption\n'));
  assert.equal((await s3Head('seaweedfs-main', `/default/enc/${name}`))['x-amz-server-side-encryption'], undefined);
  await openDetailsWithoutEncryption(page, name);
  assert.deepEqual(page.errors, []);
  await deleteEncrypted(page, 'seaweedfs-main', `enc/${name}`);
  await page.context().close();
});

for (const instance of ['seaweedfs-main', 'minio-main']) {
  test(`encryption: ${PROVIDERS[instance].name} shows the default encryption of the bucket, and no row for an object that has none`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    assert.equal(info.bucketEncryptionSupported, true);
    const before = await (await page.request.get(`${BASE}api/encryption?instance=${instance}`)).json();
    assert.equal(before.uploads, '');
    assert.equal(before.bucketDefault, null);
    await s3(instance, 'PUT', '/default', 'encryption=', Buffer.from(ENCRYPTION_XML));
    try {
      const answer = await (await page.request.get(`${BASE}api/encryption?instance=${instance}`)).json();
      assert.equal(answer.bucketDefault.algorithm, 'AES256');
      await open(page, `-/${info.host}/${instance}/smoke/`);
      await openDetails(page, 'hello.txt');
      await page.waitForSelector('[data-encryption-section] [data-encryption-field="default"]');
      assert.equal(await encryptionText(page, 'default'), 'SSE-S3 (AES256)');
      // The object was stored before the default: the provider reports no encryption for it.
      assert.equal(await page.locator('[data-encryption-field="object"]').count(), 0);
      assert.equal(await page.locator('[data-encryption-note]').count(), 0);
      assert.deepEqual(page.errors, []);
    } finally {
      await s3(instance, 'DELETE', '/default', 'encryption=');
    }
    // The bucket ends as it started: no default, and so no section.
    assert.equal((await (await page.request.get(`${BASE}api/encryption?instance=${instance}`)).json()).bucketDefault, null);
    await page.reload({ waitUntil: 'networkidle' });
    await open(page, `-/${info.host}/${instance}/smoke/`);
    await openDetailsWithoutEncryption(page, 'hello.txt');
    await page.context().close();
  });
}

test('encryption: MinIO shows the SSE-KMS of an object with its KMS key', async () => {
  const page = await newPage();
  const info = await lockedHostOf(page, 'minio-main');
  await open(page, `-/${info.host}/minio-main/enc/`);
  await openEncryptionDetails(page, 'kms.txt');
  assert.equal(await encryptionText(page, 'object'), 'SSE-KMS (aws:kms)');
  assert.match(await encryptionText(page, 'kmsKey'), /^arn:aws:kms:s3-browser-test/);
  assert.equal(await page.locator('[data-encryption-note]').count(), 0);
  // The object has a normal HEAD answer, so the metadata section stays.
  await page.waitForSelector('[data-metadata-section] .metaEditor__view');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

for (const instance of ['seaweedfs-main', 'garage-main']) {
  test(`encryption: ${PROVIDERS[instance].name} opens the details of an object with a key of the client (SSE-C), and never asks for the key`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    // The provider refuses the HEAD with 400: the server answers 200 and says that the key is the key of the client.
    const response = await page.request.get(`${BASE}api/media-info?instance=${instance}&key=${encodeURIComponent('enc/customer-key.txt')}`);
    assert.equal(response.status(), 200, await response.text());
    const media = await response.json();
    assert.equal(media.customerKey, true);
    assert.equal(media.size, 'An object with a key of the client.\n'.length);
    assert.ok(!JSON.stringify(media).includes('customer-key-md5'), 'the answer has no hash of the key');
    await open(page, `-/${info.host}/${instance}/enc/`);
    await openDetails(page, 'customer-key.txt');
    await page.waitForSelector('[data-encryption-section] [data-encryption-field="object"]');
    assert.match(await encryptionText(page, 'object'), /^Key of the client/);
    assert.match(await page.textContent('[data-encryption-note]'), /key of the client/);
    // The size comes from the listing: the section "Storage object" has it.
    const storage = await page.locator('.bb-details-section', { hasText: 'Storage object' }).innerText();
    assert.match(storage.replace(/\s+/g, ' '), /Size 36 B/);
    assert.equal(await page.locator('[data-metadata-section]').count(), 0);
    // The page has no field for a key.
    assert.equal(await page.locator('.bb-details--file input[type="password"], [data-encryption-section] input, [data-encryption-section] textarea').count(), 0);
    assert.equal(await visibleText(page, 'customer-key-md5'), 0);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('encryption: Garage accepts an upload with encryption = "sse-s3" and shows no encryption; garage-main has no default row', async () => {
  const page = await newPage();
  const instances = (await (await page.request.get(`${BASE}api/instances`)).json()).instances;
  const flags = Object.fromEntries(instances.map(item => [item.id, item.bucketEncryptionSupported]));
  assert.deepEqual(flags, {
    'seaweedfs-main': true, 'seaweedfs-archive': true, 'seaweedfs-locked': true, 'seaweedfs-encrypted': true,
    'minio-main': true, 'minio-locked': true, 'minio-encrypted': true,
    'garage-main': false, 'garage-encrypted': false,
  });
  for (const instance of ['garage-main', 'garage-encrypted']) {
    const response = await page.request.get(`${BASE}api/encryption?instance=${instance}`);
    assert.equal(response.status(), 501, instance);
    assert.equal((await response.json()).error.code, 'bucket_encryption_unsupported');
  }
  const info = instances.find(item => item.id === 'garage-encrypted');
  const name = `garage-${encryptionStamp()}.txt`;
  await open(page, `-/${info.host}/garage-encrypted/enc/`);
  await uploadWithPage(page, name, Buffer.from('uploaded to Garage\n'));
  assert.equal((await getObject(page, 'garage-encrypted', `enc/${name}`)).body.toString(), 'uploaded to Garage\n');
  // Garage does not encrypt: the HEAD says nothing, so the details have no section (and no default row).
  assert.equal((await s3Head('garage-main', `/default/enc/${name}`))['x-amz-server-side-encryption'], undefined);
  await openDetailsWithoutEncryption(page, name);
  await closeWindow(page);
  await deleteEncrypted(page, 'garage-encrypted', `enc/${name}`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// The preview page of an object with a key of the client: the name and the path in the bar, and the message. The
// link to the original and the download give the message too.
const CUSTOMER_KEY_TEXT = 'This object is encrypted with a key of the client (SSE-C). The browser cannot read it without that key.';

for (const instance of ['seaweedfs-main', 'garage-main']) {
  test(`encryption: ${PROVIDERS[instance].name}: the preview, the link to the original and the download of an SSE-C object say why they cannot read it`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    await page.goto(`${BASE}-/${info.host}/${instance}/enc/customer-key.txt`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.preview-error');
    assert.equal(await page.textContent('#docName'), 'customer-key.txt');
    assert.equal(await page.textContent('#docPrefix'), ' / enc');
    assert.equal(await page.textContent('.preview-error strong'), 'Encrypted with a key of the client');
    assert.equal(await page.textContent('.preview-error p'), CUSTOMER_KEY_TEXT);
    assert.doesNotMatch(await page.textContent('#viewer'), /HTTP 400/);
    assert.match(await page.title(), /^customer-key\.txt - /);
    // The link to the original opens no page: it gives the message.
    let pages = 0;
    page.context().on('page', () => { pages += 1; });
    await page.click('#openRawBtn');
    await page.waitForSelector('.bb-toast.is-error');
    assert.match(await page.textContent('.bb-toast.is-error'), /key of the client \(SSE-C\)\. The browser cannot read it/);
    assert.equal(pages, 0);
    await page.evaluate(() => document.querySelectorAll('.bb-toast').forEach(node => node.remove()));
    // The download of the page.
    await page.click('#previewKebabBtn');
    await page.click('#pv-download');
    await page.waitForSelector('.bb-toast.is-error');
    assert.match(await page.textContent('.bb-toast.is-error'), /key of the client \(SSE-C\)/);
    assert.equal(await page.locator('.bb-toast >> text=Resumable download was unavailable').count(), 0);
    // The download of the listing.
    await open(page, `-/${info.host}/${instance}/enc/`);
    await page.click('tr[data-name="customer-key.txt"] .bb-kebab');
    await page.click('.bb-menu.is-open .bb-menu-item >> text=Download');
    await page.waitForSelector('.bb-toast.is-error');
    assert.match(await page.textContent('.bb-toast.is-error'), /key of the client \(SSE-C\)/);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('encryption: an other answer 400 of the provider is not an SSE-C object: the preview names the error', async () => {
  const page = await newPage();
  await page.route(/\/s3\?/, route => (route.request().method() === 'HEAD' && route.request().url().includes('hello.txt') ? route.fulfill({ status: 400, body: '' }) : route.continue()));
  await page.goto(`${BASE}${MAIN}smoke/hello.txt`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.preview-error');
  assert.equal(await page.textContent('#docName'), 'hello.txt');
  assert.equal(await page.textContent('.preview-error strong'), 'Preview unavailable');
  assert.match(await page.textContent('.preview-error p'), /HTTP 400/);
  assert.equal(await page.locator('.preview-error .mdi-lock-outline').count(), 0);
  await page.context().close();
});

// The lock of a bucket in the bucket selector: the trigger and the entries of the menu.
const bucketLockOf = (page, instance) => page.evaluate(id => {
  const node = document.querySelector(`.storageBucket[data-instance="${id}"] [data-bucket-lock]`);
  return node ? { icon: node.dataset.bucketLock, title: node.title, tone: node.className } : null;
}, instance);

test('encryption: the bucket selector shows a lock for a bucket that encrypts, and an open lock for Garage, which does not', async () => {
  const page = await newPage();
  const instances = (await (await page.request.get(`${BASE}api/instances`)).json()).instances;
  const facts = Object.fromEntries(instances.map(item => [item.id, [item.encryption, item.defaultEncryption, item.encryptionApplied || '']]));
  assert.deepEqual(facts['seaweedfs-encrypted'], ['sse-s3', '', 'yes']);
  assert.deepEqual(facts['minio-encrypted'], ['sse-s3', '', 'yes']);
  assert.deepEqual(facts['garage-encrypted'], ['sse-s3', '', 'no']);
  assert.deepEqual(facts['seaweedfs-main'], ['', '', '']);
  await open(page, MAIN);
  for (const instance of ['seaweedfs-encrypted', 'minio-encrypted']) {
    assert.deepEqual(await bucketLockOf(page, instance), { icon: 'lock', title: 'Encrypted: SSE-S3 for each new object', tone: 'bucketLock is-on' }, instance);
  }
  for (const instance of ['seaweedfs-main', 'minio-main', 'garage-main', 'seaweedfs-locked']) assert.equal(await bucketLockOf(page, instance), null, instance);
  const garage = await bucketLockOf(page, 'garage-encrypted');
  assert.equal(garage.icon, 'lock-open');
  assert.match(garage.title, /^SSE-S3 requested; the provider does not encrypt/);
  assert.equal(await page.locator('.storageSwitcher__trigger [data-bucket-lock]').count(), 0);
  // The trigger of the selector shows the lock of the open bucket.
  const info = instances.find(item => item.id === 'seaweedfs-encrypted');
  await open(page, `-/${info.host}/seaweedfs-encrypted/`);
  assert.equal(await page.getAttribute('.storageSwitcher__trigger [data-bucket-lock]', 'title'), 'Encrypted: SSE-S3 for each new object');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// Counts the HEAD requests of the page to the objects, and the most of them at the same time.
async function watchHeads(page, delay = 0) {
  const stats = { total: 0, active: 0, max: 0, keys: [] };
  await page.route(/\/s3\?/, async route => {
    if (route.request().method() !== 'HEAD') return route.continue();
    stats.total += 1;
    stats.active += 1;
    stats.max = Math.max(stats.max, stats.active);
    stats.keys.push(new URL(route.request().url()).searchParams.get('key'));
    try {
      if (delay) await sleep(delay);
      await route.continue();
    } finally {
      stats.active -= 1;
    }
  });
  return stats;
}

const noLockPending = page => until(page, () => !document.querySelector('.nameLock__pending'));
const fileLock = (page, name) => page.evaluate(row => document.querySelector(`tr[data-name="${row}"] .nameLock__icon`)?.title || '', name);

for (const [instance, provider] of Object.entries(ENCRYPTED)) {
  test(`encryption: ${provider.name}: the listing shows a lock next to the name of an encrypted file, by default, and no new column`, async () => {
    const page = await newPage();
    const info = await lockedHostOf(page, instance);
    const stamp = encryptionStamp();
    const plain = `enc/plain-${stamp}.txt`;
    await putPlain(instance, plain, 'plain on the provider\n');
    await open(page, `-/${info.host}/${instance}/enc/`);
    const columns = await page.locator('.dataTable thead th').count();
    await uploadWithPage(page, `locked-${stamp}.txt`, Buffer.from('uploaded by the page\n'));
    await noLockPending(page);
    assert.equal(await fileLock(page, `locked-${stamp}.txt`), 'Encrypted: SSE-S3');
    assert.equal(await fileLock(page, `plain-${stamp}.txt`), '');
    // The lock is in the cell of the name, at the right of the name.
    const place = await page.evaluate(row => {
      const name = document.querySelector(`tr[data-name="${row}"] .nameLink`).getBoundingClientRect();
      const lock = document.querySelector(`tr[data-name="${row}"] .nameLock__icon`).getBoundingClientRect();
      return { name: name.right, lock: lock.left, cell: document.querySelector(`tr[data-name="${row}"] .nameLock`).closest('td') === document.querySelector(`tr[data-name="${row}"] td`) };
    }, `locked-${stamp}.txt`);
    assert.ok(place.cell && place.lock >= place.name, JSON.stringify(place));
    assert.equal(await page.locator('.dataTable thead th').count(), columns);
    await page.click('#settingsButton');
    assert.equal(await page.isChecked('#encryptionToggle'), true);
    assert.deepEqual(page.errors, []);
    await deleteEncrypted(page, instance, plain, `enc/locked-${stamp}.txt`);
    await page.context().close();
  });
}

test('encryption: the setting starts the locks of seaweedfs-main, stays in the browser, and shows SSE-C and SSE-KMS', async () => {
  const page = await newPage();
  const heads = await watchHeads(page);
  await open(page, `${MAIN}enc/`);
  await sleep(500);
  // An instance that does not encrypt: no request and no lock.
  assert.equal(heads.total, 0);
  assert.equal(await page.locator('.nameLock__icon, .nameLock__pending').count(), 0);
  await page.click('#settingsButton');
  assert.equal(await page.isChecked('#encryptionToggle'), false);
  await page.check('#encryptionToggle');
  await page.keyboard.press('Escape');
  await noLockPending(page);
  // The HEAD of an SSE-C object fails with 400: the details confirm it.
  assert.equal(await fileLock(page, 'customer-key.txt'), 'Encrypted with a key of the client (SSE-C)');
  const files = await page.locator('.dataTable tbody tr[data-type="content"]').count();
  assert.ok(heads.total >= 1 && heads.total <= files, `${heads.total} HEAD for ${files} files`);
  // The choice stays after a reload, for this bucket only.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dataTable');
  await noLockPending(page);
  assert.equal(await fileLock(page, 'customer-key.txt'), 'Encrypted with a key of the client (SSE-C)');
  // MinIO gives the key of an SSE-KMS object.
  const minio = await lockedHostOf(page, 'minio-main');
  await open(page, `-/${minio.host}/minio-main/enc/`);
  await sleep(300);
  assert.equal(await page.locator('.nameLock__icon, .nameLock__pending').count(), 0);
  await page.click('#settingsButton');
  await page.check('#encryptionToggle');
  await page.keyboard.press('Escape');
  await noLockPending(page);
  assert.match(await fileLock(page, 'kms.txt'), /^Encrypted: SSE-KMS, key arn:aws:kms:s3-browser-test/);
  // The setting goes off, and the reset gives the default again.
  await page.click('#settingsButton');
  await page.uncheck('#encryptionToggle');
  assert.equal(await page.locator('.nameLock__icon').count(), 0);
  await open(page, `${MAIN}enc/`);
  await page.click('#settingsButton');
  await page.click('#settingsReset');
  await sleep(300);
  assert.equal(await page.locator('.nameLock__icon, .nameLock__pending').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('encryption: the locks of the listing read at most 100 files, 4 at the same time, and read a file one time', async () => {
  const page = await newPage();
  const prefix = `encmany-${Date.now()}/`;
  for (let start = 0; start < 120; start += 10) {
    await Promise.all(Array.from({ length: 10 }, (_, index) => s3('seaweedfs-encrypted', 'PUT', `/encrypted/${prefix}file-${String(start + index).padStart(3, '0')}.txt`, '', Buffer.from('x'), { 'content-type': 'text/plain' })));
  }
  const info = await lockedHostOf(page, 'seaweedfs-encrypted');
  const heads = await watchHeads(page, 60);
  await open(page, `-/${info.host}/seaweedfs-encrypted/${prefix}`);
  await noLockPending(page);
  // One page of 50 rows: 50 requests, 4 at most at the same time.
  assert.equal(heads.total, 50);
  assert.ok(heads.max <= 4, `max ${heads.max}`);
  assert.equal(new Set(heads.keys).size, 50);
  // A new drawing of the page (the exact times) and a new listing read nothing again.
  await page.click('.timeToggle');
  await page.click('#refreshButton');
  await page.waitForSelector('.tableBox:not(.is-busy)');
  await sleep(800);
  assert.equal(heads.total, 50);
  // 500 rows on a page: the page reads the first 100 rows only, and the 50 rows that it read stay.
  await page.selectOption('.tableFoot select', '500');
  await noLockPending(page);
  assert.equal(heads.total, 100);
  assert.equal(new Set(heads.keys).size, 100);
  assert.ok(heads.max <= 4, `max ${heads.max}`);
  assert.equal(await page.locator('tbody tr:nth-child(n+101) .nameLock__pending, tbody tr:nth-child(n+101) .nameLock__icon').count(), 0);
  assert.deepEqual(page.errors, []);
  await deletePrefix(page, 'seaweedfs-encrypted', prefix);
  await page.context().close();
});

test('encryption: Garage: the setting is off for garage-encrypted, and on it shows no lock, because Garage does not encrypt', async () => {
  const page = await newPage();
  const info = await lockedHostOf(page, 'garage-encrypted');
  const heads = await watchHeads(page);
  await open(page, `-/${info.host}/garage-encrypted/enc/`);
  await sleep(500);
  assert.equal(heads.total, 0);
  await page.click('#settingsButton');
  assert.equal(await page.isChecked('#encryptionToggle'), false);
  await page.check('#encryptionToggle');
  await page.keyboard.press('Escape');
  const name = `garage-lock-${encryptionStamp()}.txt`;
  await uploadWithPage(page, name, Buffer.from('uploaded to Garage\n'));
  await noLockPending(page);
  assert.ok(heads.total >= 1);
  assert.equal(await fileLock(page, name), '');
  // The SSE-C object of Garage has its lock.
  assert.equal(await fileLock(page, 'customer-key.txt'), 'Encrypted with a key of the client (SSE-C)');
  assert.deepEqual(page.errors, []);
  await deleteEncrypted(page, 'garage-encrypted', `enc/${name}`);
  await page.context().close();
});

test('encryption: a default encryption of the bucket gives the lock of the bucket and starts the locks of the files', async () => {
  const page = await newPage();
  await page.route(/\/api\/instances/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const instance of body.instances) if (instance.id === 'seaweedfs-main') instance.defaultEncryption = 'AES256';
    await route.fulfill({ response, json: body });
  });
  const heads = await watchHeads(page);
  await open(page, `${MAIN}enc/`);
  assert.equal(await page.getAttribute('.storageSwitcher__trigger [data-bucket-lock]', 'title'), 'Default encryption of the bucket: AES256');
  await noLockPending(page);
  assert.ok(heads.total >= 1);
  assert.equal(await fileLock(page, 'customer-key.txt'), 'Encrypted with a key of the client (SSE-C)');
  await page.click('#settingsButton');
  assert.equal(await page.isChecked('#encryptionToggle'), true);
  assert.deepEqual(page.errors, []);
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
