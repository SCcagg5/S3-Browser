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
  querySelectorAll() { return []; },
  getElementById() { return null; }
};

let jobResult = {
  status: 'completed',
  processed: 8,
  stats: {
    count: 8,
    totalBytes: 1000,
    treemapThresholdBytes: 10,
    byType: {
      archive: { count: 3, bytes: 750 },
      other: { count: 5, bytes: 250 }
    },
    treemap: {
      name: 'folder', path: 'folder/', bytes: 1000, count: 8, kind: 'folder', type: 'folder',
      children: [
        {
          name: 'prometheus', path: 'folder/prometheus/', bytes: 750, count: 3, kind: 'folder', type: 'folder',
          children: [
            { name: 'prometheus_linux_amd64.tgz', path: 'folder/prometheus/prometheus_linux_amd64.tgz', bytes: 500, count: 1, kind: 'file', type: 'archive', mime: 'application/gzip', etag: 'etag-a' },
            { name: 'prometheus_darwin_arm64.tgz', path: 'folder/prometheus/prometheus_darwin_arm64.tgz', bytes: 250, count: 1, kind: 'file', type: 'archive' }
          ]
        },
        { name: 'Others', path: 'folder/', bytes: 250, count: 5, kind: 'other', type: 'other' }
      ]
    },
    recent: [
      { path: 'folder/prometheus/prometheus_linux_amd64.tgz', bytes: 500, type: 'archive', lastModified: '2026-01-03T00:00:00Z' }
    ],
    largest: [
      { path: 'folder/prometheus/prometheus_linux_amd64.tgz', bytes: 500, type: 'archive', mime: 'application/gzip', etag: 'etag-a', lastModified: '2026-01-03T00:00:00Z' }
    ]
  }
};

const toast = { update() {}, close() {} };
const BB = {
  runtime: {
    formatDateTimeUTC(value) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace('T', ' ') : '';
    }
  },
  api: {
    getInstance() { return 'garage-main'; },
    stats() { return Promise.resolve({ id: 'job-fixture' }); },
    waitForJob(_job, { onUpdate }) {
      onUpdate(jobResult);
      return Promise.resolve(jobResult);
    }
  },
  detect: { iconForType() { return 'file-outline'; } },
  cfg: { capabilities: { read: { allowed: true }, insights: { allowed: true } } },
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
  assert.match(capturedHTML, /data-insights-panel="treemap"/);
  assert.doesNotMatch(capturedHTML, /Files and folders below|data-group-threshold/);
  assert.doesNotMatch(capturedHTML, /folder-treemap-focus/);
  assert.match(capturedHTML, /folder-treemap-tooltip/);
  assert.match(capturedHTML, /folder-treemap is-layout-pending/);
  assert.match(capturedHTML, /aria-busy="true"/);
  assert.doesNotMatch(capturedHTML, /folder-treemap-node/);
  assert.match(capturedHTML, /Most recent files/);
  assert.match(capturedHTML, /Largest files/);
  assert.match(capturedHTML, /2026-01-03 00:00:00/);

  // Semantic grouping and single-child contraction are backend responsibilities.
  assert.doesNotMatch(source, /function buildTreemapTree\(/);
  assert.doesNotMatch(source, /function groupedTreemapChildren\(/);
  assert.doesNotMatch(source, /function flattenedTreemapChildren\(/);
  assert.match(source, /const tree = stats\?\.treemap \|\| null/);
  assert.doesNotMatch(source, /Files and folders below 1% of this scope/);
  assert.match(source, /function treemapChildren\(node\)/);
  assert.match(source, /function squarifyTreemapNodes\(/);
  assert.match(source, /function layoutTreemapNodes\(/);
  assert.match(source, /function renderTreemap\(map, nodes\)/);
  assert.match(source, /function fitTreemapLabels\(map\)/);
  assert.doesNotMatch(source, /updateTreemapFocus/);
  assert.match(source, /updateTreemapHover/);
  assert.match(source, /data-treemap-tooltip/);
  assert.match(source, /BB\.api\.previewPageURL\(clean/);
  assert.match(source, /const treemapOtherInlineMinimumHeightPixels = 26/);
  assert.match(source, /const treemapOtherStackedMinimumHeightPixels = 34/);
  assert.match(source, /const treemapOtherInlineMinimumWidthPixels = 180/);
  assert.match(source, /function treemapOtherReadableHeight\(width\)/);
  assert.match(source, /const treemapMinimumRegularPixels = 30/);
  assert.match(source, /const treemapFolderHeaderPixels = 26/);
  assert.match(source, /const treemapBranchInsetPixels = 2/);
  assert.doesNotMatch(source, /function treemapBorderColor\(depth\)/);
  assert.doesNotMatch(source, /function treemapColorIndex\(node\)/);
  assert.match(source, /function statsTypeColor\(type\)/);
  assert.match(source, /--segment-color:\$\{statsTypeColor\(entry\.name\)\}/);
  assert.match(source, /const color = statsTypeColor\(node\.type \|\| 'other'\)/);
  assert.match(source, /folder-treemap-details/);
  assert.doesNotMatch(source, /has-no-header/);
  assert.match(source, /const labelName = node\.name \|\| \(kind === 'folder' \? 'Folder' : 'Unnamed'\)/);
  assert.match(source, /const canExpandFolder = isFolder[\s\S]*drawWidth >= 80[\s\S]*drawHeight >= 84/);
  assert.match(source, /smallest horizontal strip required/);
  assert.match(source, /Math\.min\(treemapOtherReadableHeight\(width\), maximumHeight\)/);
  assert.doesNotMatch(source, /useVerticalStrip|treemapOtherMinimumWidthPixels/);
  assert.match(source, /String\(node\?\.kind \|\| ''\) === 'other'/);
  assert.doesNotMatch(source, /is-vertical/);
  assert.doesNotMatch(source, /treemapOtherMinimumShare/);

  console.log('stats viewer behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
