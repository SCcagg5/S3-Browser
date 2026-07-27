'use strict';

(async () => {

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const index = read('src/public/index.html');
const preview = read('src/public/preview.html');
const runtime = read('src/public/assets/js/common/runtime.js');
const api = read('src/public/assets/js/common/api.js');
const app = read('src/public/assets/js/app.js');
const actions = read('src/public/assets/js/common/actions.js');
const previewJS = read('src/public/assets/js/preview.js');
const backend = read('src/app.go');
const example = read('config.example.hcl');

for (const [name, html] of [['index', index], ['preview', preview]]) {
  assert.match(html, /<base href="\{\{APP_BASE\}\}" \/>/, `${name} must expose the server-injected application base`);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\{\{)/i.test(value)) continue;
    assert.equal(value.startsWith('/'), false, `${name} contains a root-relative asset: ${value}`);
  }
}

assert.match(runtime, /new URL\('\.', document\.baseURI\)/);
assert.ok(runtime.includes("new URL(text.replace(/^\\/+/, ''), applicationRoot)"));
assert.match(runtime, /function currentStorageRoute\(\)/);
assert.match(runtime, /function browserPageURL\(instance, prefix = ''\)/);
assert.match(runtime, /function previewPageURL\(instance, key = ''\)/);
assert.match(runtime, /text === '\.' \|\| text === '\.\.'/);
assert.match(api, /BB\.runtime\.resolveURL\(path\)/);
assert.match(api, /BB\.runtime\.resolvePath\(path\)/);
assert.match(api, /browserPageURL\(prefix = ''/);
assert.match(api, /BB\.runtime\.previewPageURL\(selected, clean\)/);
assert.match(app, /replaceBrowserLocation\(this\.pathPrefix\)/);
assert.match(app, /window\.addEventListener\('popstate'/);
assert.match(actions, /BB\.api\.browserPageURL\(ensurePrefix\(clean\)/);
assert.match(previewJS, /BB\.api\.browserPageURL\(parentPrefix\(key\)/);
assert.match(previewJS, /replacePreviewLocation\(currentKey\(\)\)/);
assert.doesNotMatch(`${app}\n${previewJS}`, /location\.(?:href|assign)\s*=\s*['"]\//);

assert.match(backend, /strings\.HasPrefix\(r\.URL\.Path, "\/-\/"\)/);
assert.match(backend, /func \(a \*application\) handleStorageFrontend/);
assert.match(backend, /func frontendBaseHref/);
assert.match(backend, /frontendBasePlaceholder = "\{\{APP_BASE\}\}"/);
assert.doesNotMatch(backend, /publicPrefix/);
assert.doesNotMatch(example, /public_prefix/);
assert.ok((example.match(/auth\s+"primary-s3"/g) || []).length === 1);
assert.ok((example.match(/auth\s*=\s*"primary-s3"/g) || []).length >= 2);
assert.match(example, /bucket\s+"documents"[\s\S]*permissions\s*=\s*\["read", "write", "delete"\][\s\S]*max_scan_pages\s*=\s*15/);
assert.match(example, /bucket\s+"archive"[\s\S]*permissions\s*=\s*\["read"\][\s\S]*max_scan_pages\s*=\s*0/);

const requested = [];
const location = {
  href: 'https://example.test/s3-browser/index.html',
  pathname: '/s3-browser/index.html',
  search: '',
  hash: ''
};
const sandbox = {
  URL,
  Map,
  DOMException,
  setTimeout,
  clearTimeout,
  location,
  document: { baseURI: 'https://example.test/s3-browser/index.html' },
  localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} },
  fetch: async value => {
    requested.push(String(value));
    return { ok: true, json: async () => ({ instances: [] }) };
  },
  XMLHttpRequest: function XMLHttpRequest() {},
  console
};
sandbox.window = sandbox;
sandbox.window.BB = { detect: {} };
vm.createContext(sandbox);
vm.runInContext(runtime, sandbox, { filename: 'runtime.js' });
vm.runInContext(api, sandbox, { filename: 'api.js' });
sandbox.BB.api.setInstance('documents');

assert.equal(
  sandbox.BB.api.urlForKey('folder/file.txt'),
  'https://example.test/s3-browser/s3?instance=documents&key=folder%2Ffile.txt'
);
assert.equal(
  sandbox.BB.api.browserPageURL('folder/subfolder/', { instance: 'documents' }),
  'https://example.test/s3-browser/-/documents/folder/subfolder/'
);
assert.equal(
  sandbox.BB.api.browserPageURL('', { instance: '-' }),
  'https://example.test/s3-browser/-/-/'
);
assert.equal(
  sandbox.BB.api.previewPageURL('folder/file name #1.txt', { instance: 'documents' }),
  'https://example.test/s3-browser/-/documents/folder/file%20name%20%231.txt'
);
assert.equal(
  sandbox.BB.api.previewPageURL('folder/../~private//file.txt', { instance: 'api' }),
  'https://example.test/s3-browser/-/api/folder/~../~~private/~/file.txt'
);

location.href = 'https://example.test/s3-browser/-/documents/folder/~../~~private/~/file.txt?version=v1';
location.pathname = '/s3-browser/-/documents/folder/~../~~private/~/file.txt';
location.search = '?version=v1';
assert.deepEqual(
  { ...sandbox.BB.runtime.storageRoute() },
  { instance: 'documents', path: 'folder/../~private//file.txt', view: 'preview' }
);

location.href = 'https://example.test/s3-browser/-/api/folder/~../';
location.pathname = '/s3-browser/-/api/folder/~../';
location.search = '';
assert.deepEqual(
  { ...sandbox.BB.runtime.storageRoute() },
  { instance: 'api', path: 'folder/../', view: 'browser' }
);

await sandbox.BB.api.instances();
assert.equal(requested[0], '/s3-browser/api/instances');
assert.equal(requested[0].includes('/s3-browser/s3-browser/'), false);
await sandbox.BB.api.spreadsheet({ key: 'book.xlsx', instance: 'documents' });
assert.match(requested[1], /^\/s3-browser\/api\/spreadsheet\?/);
assert.equal(requested[1].includes('/s3-browser/s3-browser/'), false);

console.log('relative-path, friendly-route and shared-auth frontend contracts passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
