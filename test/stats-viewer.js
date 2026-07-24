'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/public/assets/js/common/actions.js'), 'utf8');
let capturedHTML = '';

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

const document = {
  createElement(tagName) {
    if (tagName === 'span') {
      return {
        value: '',
        set textContent(value) { this.value = String(value); },
        get innerHTML() { return escapeHTML(this.value); }
      };
    }
    return {};
  },
  querySelectorAll() { return []; }
};

let jobResult = {
  status: 'completed',
  processed: 6,
  stats: {
    count: 6,
    totalBytes: 1000,
    byType: {
      image: { count: 1, bytes: 500 },
      other: { count: 5, bytes: 500 }
    },
    byFolder: {
      'sub/': { count: 3, bytes: 300 },
      'another/': { count: 2, bytes: 200 }
    },
    largest: [
      {
        path: 'folder/a.jpg',
        bytes: 500,
        type: 'image',
        mime: 'image/jpeg',
        etag: 'etag-a',
        lastModified: '2026-01-01T00:00:00Z'
      },
      { path: 'folder/sub/b.bin', bytes: 294, type: 'other' },
      { path: 'folder/sub/tiny-1.bin', bytes: 3, type: 'other' },
      { path: 'folder/sub/tiny-2.bin', bytes: 3, type: 'other' },
      { path: 'folder/another/c.bin', bytes: 198, type: 'other' },
      { path: 'folder/another/tiny.bin', bytes: 2, type: 'other' }
    ]
  }
};

const toast = { update() {}, close() {} };
const BB = {
  api: {
    getInstance() { return 'garage-main'; },
    stats() { return Promise.resolve({ id: 'job-fixture' }); },
    waitForJob(_job, { onUpdate }) {
      onUpdate(jobResult);
      return Promise.resolve(jobResult);
    }
  },
  detect: {},
  cfg: { capabilities: { read: { allowed: true } } },
  ui: {
    toast() { return toast; },
    alert(options) {
      capturedHTML = options.html || '';
      return Promise.resolve(true);
    },
    prompt() { return Promise.resolve(null); },
    confirm() { return Promise.resolve(false); }
  }
};

const windowObject = { BB, setTimeout, clearTimeout };
windowObject.window = windowObject;
const context = vm.createContext({
  window: windowObject,
  document,
  console,
  location: { href: 'http://example.test/index.html', hash: '' },
  URL,
  Blob,
  DOMException,
  setTimeout,
  clearTimeout,
  requestAnimationFrame() { return 1; }
});

vm.runInContext(source, context, { filename: 'src/public/assets/js/common/actions.js' });

(async () => {
  assert.equal(await BB.actions.showPrefixStats('folder/'), true);
  assert.match(capturedHTML, /Folder insights/);
  assert.match(capturedHTML, /folder-insights-tabs/);
  assert.match(capturedHTML, /data-insights-panel=\"overview\"/);
  assert.match(capturedHTML, /data-insights-panel=\"treemap\"/);
  assert.match(capturedHTML, /data-mime="image\/jpeg"/);
  assert.match(capturedHTML, /data-etag="etag-a"/);

  const rectangles = capturedHTML.match(/<div class="folder-treemap-node[^>]*>.*?<\/div>/gs) || [];
  assert.equal(rectangles.length, 7, 'two folders must each retain their own local Others rectangle');
  rectangles.forEach(rectangle => {
    assert.equal((rectangle.match(/folder-treemap-node/g) || []).length, 1, 'treemap rectangles must be flat siblings');
    assert.match(rectangle, /data-depth="\d+"/, 'treemap rectangles must retain their depth for stacking');
    assert.match(rectangle, /z-index:\d+/, 'deeper rectangles must remain above their parents');
    assert.match(rectangle, /folder-treemap-label/, 'every rectangle must expose a measurable label before fitting');
  });
  const others = rectangles.filter(rectangle => /is-other/.test(rectangle));
  assert.equal(others.length, 2, 'small entries must be grouped independently inside each folder');
  assert.ok(others.some(rectangle => /data-size="6"/.test(rectangle) && /data-count="2"/.test(rectangle)), 'subfolder Others must include exact size and file count');
  assert.ok(others.some(rectangle => /data-size="2"/.test(rectangle) && /data-count="1"/.test(rectangle)), 'a child representing exactly 1% must be grouped');
  assert.doesNotMatch(capturedHTML, /tiny-1\.bin|tiny-2\.bin|tiny\.bin/, 'items at or below 1% must not be displayed individually');

  const sourceText = fs.readFileSync(path.join(root, 'src/public/assets/js/common/actions.js'), 'utf8');
  assert.match(sourceText, /layoutTreemapGroup\(nodes, 0, 0, 100, 100/);
  assert.match(sourceText, /treemapMinimumShare = 0\.01/);
  assert.match(sourceText, /url\.searchParams\.set\('listed', '1'\)/);
  assert.match(sourceText, /function fitTreemapLabels\(map\)/);
  assert.match(sourceText, /is-micro/);
  assert.match(sourceText, /is-vertical/);
  assert.match(sourceText, /data-header-ratio/);

  assert.equal(await BB.actions.showPrefixDetails('folder/'), true);
  assert.match(capturedHTML, /Folder insights/);
  assert.match(capturedHTML, /folder-details-summary/);
  assert.match(capturedHTML, /folder-details-footer">Computed in/);
  assert.match(capturedHTML, /folder-treemap/);
  assert.doesNotMatch(capturedHTML, /image<\/div><div class="kv-v">/);

  // The selected scope root must apply the same <=1% aggregation as every
  // nested folder. This mirrors a real stats response where a small
  // top-level project folder sits beside a much larger media folder.
  jobResult = {
    status: 'completed',
    processed: 3,
    stats: {
      count: 3,
      totalBytes: 1000,
      byType: { other: { count: 3, bytes: 1000 } },
      byFolder: {
        'large/': { count: 1, bytes: 990 },
        'tiny-root/': { count: 2, bytes: 10 }
      },
      largest: [
        { path: 'scope/large/large.bin', bytes: 990, type: 'other' },
        { path: 'scope/tiny-root/a.bin', bytes: 6, type: 'other' },
        { path: 'scope/tiny-root/b.bin', bytes: 4, type: 'other' }
      ]
    }
  };
  capturedHTML = '';
  assert.equal(await BB.actions.showPrefixStats('scope/'), true);
  assert.doesNotMatch(capturedHTML, /tiny-root/, 'a top-level folder at exactly 1% must be grouped at the selected scope root');
  assert.match(capturedHTML, /folder-treemap-node is-other[^>]*data-depth="1"[^>]*data-size="10"[^>]*data-count="2"/, 'root-level Others must retain the grouped folder size and file count');

  console.log('stats viewer behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
