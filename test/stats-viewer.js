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
    recent: [
      { path: 'folder/sub/new.bin', bytes: 42, type: 'other', lastModified: '2026-01-03T00:00:00Z' },
      { path: 'folder/a.jpg', bytes: 500, type: 'image', mime: 'image/jpeg', lastModified: '2026-01-01T00:00:00Z' }
    ],
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
  assert.ok(others.some(rectangle => /data-size="2"/.test(rectangle) && /data-count="1"/.test(rectangle)), 'a child below 1% of the selected scope must be grouped');
  assert.doesNotMatch(rectangles.join(''), /tiny-1\.bin|tiny-2\.bin|tiny\.bin/, 'items below 1% of the selected scope must not be displayed as treemap rectangles');
  assert.match(capturedHTML, /Most recent files/);
  assert.match(capturedHTML, /Largest files/);
  assert.match(capturedHTML, /new\.bin/);
  assert.match(capturedHTML, /<small>other · 42 B<\/small>/);

  const sourceText = fs.readFileSync(path.join(root, 'src/public/assets/js/common/actions.js'), 'utf8');
  assert.match(sourceText, /layoutTreemapGroup\(nodes, 0, 0, 100, 100, 1, rectangleList, scopeTotalBytes\)/);
  assert.match(sourceText, /treemapMinimumShare = 0\.01/);
  assert.match(sourceText, /url\.searchParams\.set\('listed', '1'\)/);
  assert.match(sourceText, /function squarifyTreemapNodes\(nodes, x, y, width, height\)/);
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

  // Exactly one percent remains visible; only values strictly below the
  // selected-scope threshold are folded into Others.
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
  assert.match(capturedHTML, /tiny-root/, 'a top-level folder at exactly 1% must remain visible');
  assert.match(capturedHTML, /folder-treemap-node is-other[^>]*data-depth="2"[^>]*data-size="10"[^>]*data-count="2"/, 'children below the global threshold must be grouped inside the visible one-percent folder');
  assert.doesNotMatch(capturedHTML, /folder-treemap-name">(?:a|b)\.bin</, 'sub-threshold files must not be displayed as treemap rectangles');


  // Regression fixture matching the reported 12.43 MiB scope: 30–40 KiB
  // entries are well below the global 1% threshold (~127.3 KiB) and must not
  // survive merely because they sit inside a small nested folder.
  jobResult = {
    status: 'completed',
    processed: 4,
    stats: {
      count: 4,
      totalBytes: 13038876,
      byType: { other: { count: 4, bytes: 13038876 } },
      byFolder: {
        'project/': { count: 4, bytes: 13038876 },
        'project/large/': { count: 1, bytes: 12968876 },
        'project/small/': { count: 3, bytes: 70000 }
      },
      largest: [
        { path: 'project/large/main.bin', bytes: 12968876, type: 'other' },
        { path: 'project/small/forty.bin', bytes: 40000, type: 'other' },
        { path: 'project/small/thirty.bin', bytes: 30000, type: 'other' }
      ]
    }
  };
  capturedHTML = '';
  assert.equal(await BB.actions.showPrefixStats(''), true);
  assert.match(capturedHTML, /data-group-threshold="130388\.76"/, 'the threshold must be exactly 1% of the selected scope bytes');
  assert.doesNotMatch(capturedHTML, /folder-treemap-name">(?:forty|thirty)\.bin|folder-treemap-name">small</, '30–40 KiB values must not render as independent rectangles');
  assert.match(capturedHTML, /folder-treemap-node is-other[^>]*data-size="70000"[^>]*data-count="3"/, 'sub-threshold entries must be aggregated with exact bytes and count');
  assert.match(capturedHTML, /below 1% of this scope/, 'the UI must explain the global grouping rule');

  console.log('stats viewer behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
