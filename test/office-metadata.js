'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const detect = fs.readFileSync(path.join(root, 'src/public/assets/js/common/detect.js'), 'utf8');
const actions = fs.readFileSync(path.join(root, 'src/public/assets/js/common/actions.js'), 'utf8');

for (const extension of ['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'ppam', 'sldx', 'sldm']) {
  assert.match(detect, new RegExp(`['\"]${extension}['\"]`));
}
for (const extension of ['vsdx', 'vsdm', 'vssx', 'vssm', 'vstx', 'vstm']) {
  assert.match(detect, new RegExp(`['\"]${extension}['\"]`));
}
assert.match(actions, /Scan active worksheet/);
assert.match(actions, /kind: 'spreadsheet'/);
assert.equal(fs.existsSync(path.join(root, 'scripts')), false, 'scripts directory must not be shipped');
assert.equal(fs.existsSync(path.join(root, 'Makefile')), false, 'Makefile must not be shipped');

console.log('Office metadata and archive hygiene contracts passed');
