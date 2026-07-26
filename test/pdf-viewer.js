'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/public/assets/js/common/pdf-viewer.js'), 'utf8');
assert.doesNotMatch(source, /createElement\(['"](?:iframe|embed|object)/);
assert.match(source, /Native PDF embedding is intentionally disabled/);

const BB = {};
const windowObject = { BB, window: null };
windowObject.window = windowObject;
vm.runInContext(source, vm.createContext({ window: windowObject, console }), { filename: 'pdf-viewer.js' });
assert.equal(typeof BB.pdfViewer.render, 'function');
assert.throws(() => BB.pdfViewer.render(), /Native PDF rendering is disabled/);

console.log('PDF viewer native fallback disabled tests passed');
