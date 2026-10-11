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

// The listing avoids Intl (its first use costs ~20ms of main-thread time); the output must match it exactly.
const { groupDigits, formatRelativeTime } = context.window.BB.runtime;
const numbers = new Intl.NumberFormat('en-US');
for (const value of [0, 5, 999, 1000, 1023, 12345, 1234567, 1000000000, 123456789012]) {
  assert.equal(groupDigits(value), numbers.format(value), `digit grouping of ${value}`);
}
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
for (const unit of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year']) {
  for (const value of [-1200, -12, -3, -2, -1, 0, 1, 2, 3, 12, 1200]) {
    assert.equal(formatRelativeTime(value, unit), relative.format(value, unit), `${value} ${unit}`);
  }
}

console.log('date formatting contract passed');
