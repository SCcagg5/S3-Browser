// Browser tests of the "portal" interface (server.frontend = "portal"). They cover these parts:
// 1 the theme selector, 2 the breadcrumb and the toolbar row, the header and the bucket selector, 3 the bulk upload,
// 4 the access behaviour of 2.0.0.
// run.sh starts S3-Browser and SeaweedFS, puts the test objects (seed.js) and runs this file in the Playwright container.
// The tests change the answers of the server with page.route where a case needs it (403, 401, no answer, access).
const { chromium } = require('playwright');
const assert = require('assert/strict');
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
  // Remove one and save again; Revert undoes an edit that is not saved.
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

// ------------------------------------------------------------------------------------------------------------------
// 2d. Listing: columns, settings, icon buttons
// ------------------------------------------------------------------------------------------------------------------

test('listing: the columns are Name, Tags, Versions, Size and Modified, with the clock at the left of Modified', async () => {
  const page = await newPage();
  await open(page, `${MAIN}config/`);
  await page.click('#settingsButton');
  await page.check('[data-column="tags"]');
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
  // The column Versions has the count of versions of a file; a folder has none.
  await until(page, () => /^\d+$/.test(document.querySelector('tr[data-name="ingest.json"] .col-versions')?.textContent.trim() || ''));
  assert.equal((await page.textContent('tr[data-name="app.yaml"] .col-versions')).trim().length > 0, true);
  assert.equal(await page.locator('tr[data-name="ingest.json"] .nameCell .versionCount').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('listing: the settings and the reload are icons with no frame, and their colour changes under the pointer', async () => {
  const page = await newPage();
  await open(page, MAIN);
  const order = await page.evaluate(() => ['#searchForm', '#settingsButton', '#refreshButton', '#actionsButton'].map(selector => document.querySelector(selector).getBoundingClientRect().left));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `search, settings, reload, Actions: ${order}`);
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

test('listing: the settings unfold, choose the columns, stay in the browser and reset', async () => {
  const page = await newPage();
  await open(page, MAIN);
  const height = () => page.locator('#listSettings').evaluate(node => node.getBoundingClientRect().height);
  assert.equal(await height(), 0);
  assert.equal(await page.getAttribute('#settingsButton', 'aria-expanded'), 'false');
  await page.click('#settingsButton');
  assert.equal(await page.getAttribute('#settingsButton', 'aria-expanded'), 'true');
  await until(page, () => document.querySelector('#listSettings').getBoundingClientRect().height > 20);
  assert.deepEqual(await page.locator('#listSettings [data-column]').evaluateAll(nodes => nodes.map(node => `${node.dataset.column}:${node.checked}:${node.disabled}`)),
    ['name:true:true', 'tags:false:false', 'versions:true:false', 'size:true:false', 'modified:true:false']);
  await page.uncheck('[data-column="size"]');
  await page.uncheck('[data-column="modified"]');
  assert.equal(await page.locator('th.col-size').isVisible(), false);
  assert.equal(await page.locator('th.col-modified').isVisible(), false);
  assert.equal(await page.locator('td.col-size').first().isVisible(), false);
  // The choice stays after a reload.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dataTable');
  assert.equal(await page.locator('th.col-size').isVisible(), false);
  assert.equal(await page.locator('th.col-modified').isVisible(), false);
  assert.equal(await height(), 0);
  await page.click('#settingsButton');
  assert.equal(await page.isChecked('[data-column="size"]'), false);
  await page.click('#settingsReset');
  assert.equal(await page.locator('th.col-size').isVisible(), true);
  assert.equal(await page.locator('th.col-modified').isVisible(), true);
  // The panel folds again.
  await page.click('#settingsButton');
  await until(page, () => document.querySelector('#listSettings').getBoundingClientRect().height === 0);
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
  assert.match(await page.textContent('.storageHost__row'), /seaweedfs\s*S3 · 2 buckets/);
  assert.equal(await page.getAttribute('.storageHost__row', 'aria-expanded'), 'true');
  assert.deepEqual(await page.locator('.storageBucket strong').allInnerTexts(), ['SeaweedFS - primary', 'SeaweedFS - archive']);
  assert.equal(await page.getAttribute('.storageBucket[data-instance="seaweedfs-main"]', 'aria-selected'), 'true');
  assert.equal(await page.locator('.storageBucket[data-instance="seaweedfs-main"] .storageBucket__check').count(), 1);
  const columns = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll('.storageBucket'));
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
