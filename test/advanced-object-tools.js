'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const index = read('src/public/index.html');
const previewHTML = read('src/public/preview.html');
const app = read('src/public/assets/js/app.js');
const preview = read('src/public/assets/js/preview.js');
const api = read('src/public/assets/js/common/api.js');
const actions = read('src/public/assets/js/common/actions.js');
const downloads = read('src/public/assets/js/common/download-manager.js');
const structured = read('src/public/assets/js/common/structured-viewers.js');
const css = read('src/public/assets/css/interaction.css');

// Download state is page-local and uses exact same-origin byte ranges.
for (const html of [index, previewHTML]) assert.match(html, /assets\/js\/common\/download-manager\.js/);
assert.match(downloads, /showSaveFilePicker/);
assert.match(downloads, /const records = new Map\(\)/);
assert.doesNotMatch(downloads, /\bindexedDB\.|\blocalStorage\.|\bsessionStorage\./);
assert.match(downloads, /Range: `bytes=\$\{start\}-\$\{end\}`/);
assert.match(downloads, /response\.status !== 206/);
assert.match(downloads, /returnedStart !== start \|\| returnedEnd !== end \|\| returnedTotal !== record\.size/);
assert.match(downloads, /crypto\.subtle\.digest\('SHA-256'/);


// Versioning is capability-gated and version counts are loaded only when supported.
assert.match(index, /v-if="canRead && versioningSupported"[^>]*@click="onRowVersions/);
assert.match(index, /object-version-count/);
assert.match(app, /async refreshVisibleVersionCounts\(\)/);
assert.match(app, /BB\.api\.versionCounts/);
assert.match(previewHTML, /id="previewVersionControl"/);
assert.match(preview, /configureVersionSelector/);
assert.match(preview, /currentInstance\?\.versioningSupported !== true/);
for (const method of ['versions', 'allVersions', 'versionCounts', 'restoreVersion', 'deleteVersion', 'integrity', 'inspect']) {
  assert.match(api, new RegExp(`async ${method}\\(`));
}
assert.doesNotMatch(api, /async compare\(/);

// Comparison exists only inside the version browser and reads both versions in the browser.
assert.match(actions, /async function compareVersions\(key, leftVersion, rightVersion/);
assert.match(actions, /fetchExactVersionRange/);
assert.match(actions, /data-version-compare-selected/);
assert.match(actions, /Choose two versions/);
assert.match(actions, /await compareVersions\(key, left\.version, right\.version/);
assert.doesNotMatch(actions, /BB\.api\.compare/);

// Details is compact and exposes explicit analyses in an inline Advanced tab.
assert.match(actions, /async function renderDetailsIntegrity\(/);
assert.match(actions, /async function renderDetailsInspection\(/);
assert.match(actions, /data-details-tab="advanced"/);
assert.match(actions, /data-details-tool-host/);
assert.match(actions, /modal\?\.classList\.add\('bb-modal--details'\)/);
assert.doesNotMatch(actions, /function verifyIntegrity\(/);
assert.doesNotMatch(actions, /function inspectObject\(/);
assert.doesNotMatch(actions, /bb-inspection/);
assert.match(css, /\.bb-modal\.bb-modal--details\s*\{[^}]*900px/s);
assert.match(css, /\.bb-overlay\.bb-overlay--top-anchored\s*\{/);
assert.match(css, /\.bb-details--file \.bb-details-body \{[^}]*height:\s*auto;[^}]*min-height:\s*0;[^}]*max-height:\s*min\(calc\(68vh \/ var\(--browser-ui-scale-active\)\), 680px\)/s);
assert.match(css, /\.bb-details--file \.bb-details-tool-host\.is-idle/);
assert.match(css, /\.bb-details-tool-host/);

// Per-object integrity and inspection are exposed only from Details and start
// only from their button event handlers.
assert.match(index, />\s*Versions</);
assert.match(previewHTML, />\s*Versions</);
for (const html of [index, previewHTML]) {
  assert.doesNotMatch(html, />\s*Verify integrity</);
  assert.doesNotMatch(html, />\s*Inspect</);
}
assert.doesNotMatch(app, /onRowIntegrity|onRowInspect/);
assert.doesNotMatch(preview, /pv-integrity|pv-inspect|BB\.actions\.verifyIntegrity|BB\.actions\.inspectObject/);
assert.match(actions, /integrityButton\?\.addEventListener\('click'/);
assert.match(actions, /inspectButton\?\.addEventListener\('click'/);
assert.equal((actions.match(/renderDetailsIntegrity\(/g) || []).length, 2);
assert.equal((actions.match(/renderDetailsInspection\(/g) || []).length, 2);
assert.match(actions, /host\.innerHTML = `<section class="bb-details-section bb-details-tool-result-section"/);
assert.match(css, /\.bb-version-pagination/);

// Indexed ZIP-compatible archives keep selective entry access and extraction.
assert.match(api, /previewPageURL\(/);
assert.match(api, /archiveEntryURL\(/);
assert.match(api, /async archiveEntryHead\(/);
assert.match(api, /async extractArchive\(/);
assert.match(structured, /archive-entry-menu/);
assert.match(structured, /className = 'bb-kebab'/);
assert.match(structured, /BB\.api\.previewPageURL/);
assert.match(structured, /Extract selected/);
assert.match(structured, /BB\.api\.extractArchive/);
assert.doesNotMatch(structured, /archive-entry-action|BB\.api\.archiveEntryIntegrity|archive-cell-type|archive-cell-crc/);

// Upload restart state is represented by an opaque client-held token, not server files.
assert.match(api, /X-S3-Browser-Resume-Token/);
assert.match(api, /resumeToken/);
const resumeTokenSource = read('src/upload_resume_token.go');
assert.match(resumeTokenSource, /uploadResumeTokenVersion = "s3br1"/);
assert.match(resumeTokenSource, /server never writes it to disk or to the connected object store/);

console.log('advanced object tools frontend contracts passed');
