'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const viewer = read('src/public/assets/js/common/json-viewer.js');
const api = read('src/public/assets/js/common/api.js');
const render = read('src/public/assets/js/common/render.js');
const css = read('src/public/assets/css/style.css');
const app = read('src/app.go');

assert.match(viewer, /createModeButton\('raw', 'Raw'/);
assert.match(viewer, /createModeButton\('beautify', 'Beautify'/);
assert.match(viewer, /createModeButton\('tree', 'Tree'/);
assert.match(viewer, /spreadsheet-tabs json-tabs/);
assert.match(viewer, /spreadsheet-tab json-mode-tab/);
assert.match(viewer, /BB\.api\.jsonRaw/);
assert.match(viewer, /BB\.api\.jsonBeautify/);
assert.match(viewer, /BB\.api\.jsonSummary/);
assert.doesNotMatch(viewer, /summary\?\.rawPage \|\| await BB\.api\.jsonRaw/);
assert.match(viewer, /countButton\.addEventListener\('click'/);
assert.match(viewer, /BB\.api\.jsonTree/);
assert.match(viewer, /Lines \$\{lineStart\.toLocaleString\(\)\}–\$\{lineEnd\.toLocaleString\(\)\}/);
assert.match(viewer, /json-active-pager/);
assert.match(viewer, /Count lines and pages/);
assert.match(viewer, /view\.summaryState === 'loading'/);
assert.match(viewer, /countButton\.hidden = activeMode === 'tree' \|\| view\.summaryState === 'ready'/);
assert.doesNotMatch(viewer, /Totals ready/);
assert.match(viewer, /element\$\{numeric === 1 \? '' : 's'\}/);
assert.match(viewer, /initialPayload: payload\.node\?\.container \? payload : null/);
assert.match(viewer, /setExpanded\(true\)/);
assert.doesNotMatch(viewer, /class RangeReader/);
assert.doesNotMatch(viewer, /headers:\s*\{\s*Range:/);

assert.match(api, /async jsonRaw\(/);
assert.match(api, /\/api\/json\/raw/);
assert.match(api, /async jsonBeautify\(/);
assert.match(api, /\/api\/json\/beautify/);
assert.match(api, /async jsonSummary\(/);
assert.match(api, /\/api\/json\/summary/);
assert.match(api, /async jsonTree\(/);
assert.match(api, /\/api\/json\/tree/);

assert.match(render, /function renderWrappedCode\(/);
assert.match(render, /function highlightJSONLine\(/);
assert.match(render, /json-syntax-key/);
assert.match(render, /code-horizontal-scroll/);
assert.match(render, /forwardVerticalWheel/);
assert.match(render, /page\.scrollTop \+= delta/);
assert.match(render, /event\.deltaMode === 1/);
assert.match(render, /BB\.render = \{ renderCode, renderWrappedCode/);

assert.match(css, /\.wrapped-code-line\s*\{[\s\S]*white-space:\s*pre-wrap/s);
assert.match(css, /\.wrapped-code-line\s*\{[\s\S]*overflow-wrap:\s*anywhere/s);
assert.match(css, /\.code-horizontal-scroll\s*\{[\s\S]*overflow-x:\s*auto/s);
assert.match(css, /\.code-horizontal-scroll\s*\{[\s\S]*overflow-y:\s*clip/s);
assert.match(css, /\.word-document\s*\{[\s\S]*width:\s*100%/s);
assert.match(css, /JSON modes intentionally reuse the worksheet control and tab component/);
assert.match(css, /\.json-mode-controls\s*\{[\s\S]*flex-direction:\s*row/s);
assert.match(css, /\.json-syntax-string/);

assert.match(app, /\/api\/json\/raw/);
assert.match(app, /\/api\/json\/beautify/);
assert.match(app, /\/api\/json\/summary/);
assert.match(app, /\/api\/json\/tree/);

console.log('JSON viewer frontend contracts passed');
