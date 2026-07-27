'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/public/assets/js/common/runtime.js'), 'utf8');
const context = vm.createContext({
  window: {},
  document: { baseURI: 'http://localhost/s3-browser/' },
  URL,
  Date,
  Number,
  Map
});
context.window.window = context.window;
vm.runInContext(source, context, { filename: 'runtime.js' });

const format = context.window.BB.runtime.formatDateTimeUTC;
assert.equal(format('2026-07-26T14:36:46.779Z'), '2026-07-26 14:36:46');
assert.equal(format(new Date('1981-01-01T01:01:02Z')), '1981-01-01 01:01:02');
assert.equal(format('not-a-date'), '');
assert.equal(format(''), '');

console.log('date formatting contract passed');
