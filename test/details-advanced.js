'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/public/assets/js/common/actions.js'), 'utf8');

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function fakeElement(dataset = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    dataset,
    disabled: false,
    hidden: false,
    isConnected: true,
    innerHTML: '',
    tabIndex: 0,
    classes,
    classList: {
      add(...values) { values.forEach(value => classes.add(value)); },
      remove(...values) { values.forEach(value => classes.delete(value)); },
      toggle(value, force) {
        const enabled = force === undefined ? !classes.has(value) : !!force;
        if (enabled) classes.add(value); else classes.delete(value);
        return enabled;
      }
    },
    setAttribute() {},
    addEventListener(name, listener) { listeners.set(name, listener); },
    emit(name) { return listeners.get(name)?.({ target: this }); },
    querySelector() { return null; },
    replaceChildren() { this.innerHTML = ''; },
    insertAdjacentHTML(_where, html) { this.innerHTML += html; },
    remove() { this.isConnected = false; }
  };
}

const tabs = [fakeElement({ detailsTab: 'overview' }), fakeElement({ detailsTab: 'advanced' })];
const panels = [fakeElement({ detailsPanel: 'overview' }), fakeElement({ detailsPanel: 'advanced' })];
const integrityButton = fakeElement();
const inspectButton = fakeElement();
const toolHost = fakeElement();
const modalClasses = [];
const overlayClasses = [];
let alertHTML = '';
let integrityCalls = 0;
let inspectCalls = 0;

const overlay = {
  classList: { add(value) { overlayClasses.push(value); } },
  querySelectorAll(selector) {
    if (selector === '[data-details-tab]') return tabs;
    if (selector === '[data-details-panel]') return panels;
    return [];
  },
  querySelector(selector) {
    if (selector === '[data-details-tool-host]') return toolHost;
    if (selector === '[data-details-integrity]') return integrityButton;
    if (selector === '[data-details-inspect]') return inspectButton;
    return null;
  }
};

const document = {
  createElement(tagName) {
    if (tagName === 'span') {
      return {
        value: '',
        set textContent(value) { this.value = String(value); },
        get innerHTML() { return escapeHTML(this.value); }
      };
    }
    return fakeElement();
  },
  body: { appendChild() {} },
  querySelectorAll() { return []; },
  getElementById() { return null; }
};

const BB = {
  api: {
    getInstance() { return 'bucket'; },
    async mediaInfo() {
      return { size: 123, mime: 'application/octet-stream', headers: { etag: 'etag-1' }, properties: {}, tracks: [] };
    },
    async integrity() {
      integrityCalls++;
      return {
        status: 'completed',
        integrity: { entries: [{ sha256: 'abc', md5: 'def', crc32: '1234', crc32c: '5678', providerChecksums: {}, matches: {} }] }
      };
    },
    async inspect() {
      inspectCalls++;
      return {
        detectedKind: 'binary', detectedMime: 'application/octet-stream', declaredMime: 'application/octet-stream', size: 123,
        resources: { storageRequests: 2, storageBytes: 64 }, headers: {}, structure: {}, probes: []
      };
    }
  },
  detect: {
    resolveType() { return 'other'; },
    iconForType() { return 'file-outline'; },
    extOf() { return 'bin'; }
  },
  cfg: {
    versioningSupported: false,
    capabilities: {
      details: { allowed: true },
      read: { allowed: true }
    }
  },
  ui: {
    toast() { return { update() {}, close() {} }; },
    async alert(options) {
      alertHTML = options.html || '';
      if (options.onOpen) options.onOpen({ overlay, modal: { classList: { add(value) { modalClasses.push(value); } } } });
      return true;
    },
    async prompt() { return null; },
    async confirm() { return false; }
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
  assert.equal(await BB.actions.showMetadata('object.bin'), true);
  assert.match(alertHTML, /data-details-tab="advanced"/);
  assert.match(alertHTML, /data-details-tool-host/);
  assert.deepEqual(modalClasses, ['bb-modal--details']);
  assert.deepEqual(overlayClasses, ['bb-overlay--top-anchored']);
  assert.match(alertHTML, /bb-details-tool-host is-idle/);
  assert.equal(integrityCalls, 0, 'integrity must not start while opening Details');
  assert.equal(inspectCalls, 0, 'inspection must not start while opening Details');

  integrityButton.emit('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(integrityCalls, 1);
  assert.match(toolHost.innerHTML, /Integrity verification/);
  assert.match(toolHost.innerHTML, /SHA-256/);
  assert.equal(toolHost.classes.has('has-result'), true);

  inspectButton.emit('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(inspectCalls, 1);
  assert.match(toolHost.innerHTML, /Technical inspection/);
  assert.match(toolHost.innerHTML, /Storage requests/);

  console.log('Details Advanced tab behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
