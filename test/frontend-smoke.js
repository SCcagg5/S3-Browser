'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const context = vm.createContext({ window: {}, console, TextDecoder, Uint8Array, URL, Blob });
context.window.window = context.window;

for (const relative of [
  'src/public/assets/js/common/detect.js',
  'src/public/assets/js/common/tabular.js'
]) {
  vm.runInContext(read(relative), context, { filename: relative });
}

const { detect, tabular } = context.window.BB;

const markedGlobal = { console };
markedGlobal.window = markedGlobal;
markedGlobal.globalThis = markedGlobal;
const markedContext = vm.createContext(markedGlobal);
vm.runInContext(read('src/public/assets/vendor/marked/12.0.2/marked.min.js'), markedContext, {
  filename: 'src/public/assets/vendor/marked/12.0.2/marked.min.js'
});
const mermaidMarkdown = `\`\`\`mermaid
flowchart TD
    in["route_indices[]<br/>+ shared_pools_data"]
    p0["Phase 0 — marginal prefilter"]
    p1["Phase 1 — sonde VR"]
    p2["Phase 2 — top-K"]
    p3["Phase 3 — optimisation golden"]
    out["Option&lt;ArbitrageOpportunity&gt;"]

    in --> p0
    p0 -->|"OFF (config)"| p1
    p1 --> p2
    p2 --> p3
    p3 --> out
\`\`\``;
const mermaidMarkup = markedGlobal.marked.parse(mermaidMarkdown);
assert.match(mermaidMarkup, /<code class="language-mermaid">/);
assert.match(mermaidMarkup, /route_indices\[\]/);
assert.match(mermaidMarkup, /Option&amp;lt;ArbitrageOpportunity&amp;gt;/);

for (const name of ['Dockerfile', 'Dockerfile.release', 'Containerfile', 'Makefile', '.env', '.env.example', '.dockerignore', '.tool-versions', 'Jenkinsfile']) {
  assert.equal(detect.resolveType(name, ''), 'code', `${name} should use the code preview`);
}
assert.equal(detect.resolveType('report.csv', 'application/octet-stream'), 'tabular');
assert.equal(detect.resolveType('report.tsv', 'text/tab-separated-values'), 'tabular');
assert.equal(detect.resolveType('report.tab', 'application/octet-stream'), 'tabular');
assert.equal(detect.resolveType('events.ndjson', ''), 'tabular');
assert.equal(detect.resolveType('dataset.parquet', ''), 'parquet');
assert.equal(detect.resolveType('contract.docx', 'application/zip'), 'word');
assert.equal(detect.resolveType('template.dotx', 'application/zip'), 'word');
assert.equal(detect.resolveType('legacy.doc', 'application/msword'), 'word-unavailable');
assert.equal(detect.resolveType('large.json', 'application/json'), 'json');
assert.equal(detect.resolveType('sheet.xls', 'application/vnd.ms-excel'), 'spreadsheet');
assert.equal(detect.resolveType('sheet.xlsx', 'application/zip'), 'spreadsheet');
assert.equal(detect.resolveType('sheet.xlsm', 'application/zip'), 'spreadsheet');
assert.equal(detect.resolveType('sheet.ods', 'application/zip'), 'sheet-unavailable');
assert.equal(detect.resolveType('camera.raf', 'application/octet-stream'), 'raw-image');
assert.equal(detect.resolveType('camera.cr3', 'application/octet-stream'), 'raw-image');
assert.equal(detect.resolveType('scan.tiff', 'application/octet-stream'), 'image-convert');
assert.equal(detect.resolveType('production.mxf', 'application/octet-stream'), 'video');
assert.equal(detect.resolveType('feature.mkv', 'application/octet-stream'), 'video');
assert.equal(detect.resolveType('recording.flac', 'application/octet-stream'), 'audio');
assert.equal(detect.resolveType('catalog.sqlite3', 'application/octet-stream'), 'sqlite');

const fullHDVariant = detect.videoVariantDescriptor('media/movie.1080p.mp4');
assert.equal(fullHDVariant.group, 'movie');
assert.equal(fullHDVariant.height, 1080);
assert.equal(fullHDVariant.original, false);
assert.equal(detect.videoVariantDescriptor('movie-720p.webm').group, 'movie');
assert.equal(detect.videoVariantDescriptor('movie-720p.webm').height, 720);
assert.equal(detect.videoVariantDescriptor('movie.mp4').original, true);

const csv = tabular.parseTextTable(
  'name,,description,\nalpha,,"line one\nline two",\n,,,\nbeta,,"a ""quoted"" value",\n',
  'csv'
);
assert.deepEqual(Array.from(csv.headers), ['name', 'description']);
assert.equal(csv.rows.length, 2);
assert.deepEqual(Array.from(csv.rowNumbers), [2, 4]);
assert.equal(csv.rows[0][1], 'line one\nline two');
assert.equal(csv.rows[1][1], 'a "quoted" value');

const tsv = tabular.parseTextTable('id\t\tvalue\n1\t\talpha\n\t\t\n2\t\tbeta\n', 'tsv');
assert.deepEqual(Array.from(tsv.headers), ['id', 'value']);
assert.deepEqual(Array.from(tsv.rowNumbers), [2, 4]);
assert.equal(tsv.rows[1][1], 'beta');
const tab = tabular.parseTextTable('id\tvalue\n1\talpha\n', 'tab');
assert.deepEqual(Array.from(tab.headers), ['id', 'value']);
assert.equal(tab.rows[0][1], 'alpha');

const jsonl = tabular.parseJSONLines('{"id":1,"name":"alpha","blank":""}\n\n{"id":2,"extra":true,"blank":null}\n');
assert.deepEqual(Array.from(jsonl.headers), ['id', 'name', 'extra']);
assert.deepEqual(Array.from(jsonl.rowNumbers), [1, 3]);
assert.equal(jsonl.rows.length, 2);

const queryRows = [
  ['10', 'Beta', '2026-01-02'],
  ['2', 'alpha', '2026-01-01'],
  ['30', 'alphabet', '2026-01-03'],
  ['', 'empty', '']
];
const numericFilterAndSort = tabular.applyTableQuery(queryRows, {
  filters: ['>2', '', ''],
  sortColumn: 0,
  sortDirection: 'desc'
});
assert.deepEqual(numericFilterAndSort.map(row => Array.from(row)), [
  ['30', 'alphabet', '2026-01-03'],
  ['10', 'Beta', '2026-01-02']
]);
const exactColumnFilter = tabular.applyTableQuery(queryRows, { filters: ['', '=alpha', ''] });
assert.deepEqual(exactColumnFilter.map(row => Array.from(row)), [['2', 'alpha', '2026-01-01']]);
assert.equal(tabular.compareTableValues('2', '10') < 0, true);
assert.equal(tabular.compareTableValues('2026-01-01', '2026-01-02') < 0, true);
assert.deepEqual({ ...tabular.parseColumnFilter('>= 12') }, { operator: '>=', value: '12' });

const fakeXLSX = {
  utils: {
    decode_range(reference) {
      if (reference === 'A2:E6') return { s: { r: 1, c: 0 }, e: { r: 5, c: 4 } };
      if (reference === 'A2:E10') return { s: { r: 1, c: 0 }, e: { r: 9, c: 4 } };
      throw new Error(`Unexpected range ${reference}`);
    },
    encode_col(column) { return String.fromCharCode(65 + column); },
    sheet_to_json(worksheet) { return worksheet.matrix; }
  }
};
const worksheetData = tabular.spreadsheetSheetData(fakeXLSX, {
  '!ref': 'A2:E6',
  '!fullref': 'A2:E10',
  matrix: [
    ['A', '', 2, '', ''],
    ['', '', '', '', ''],
    ['B', '', 3, '', ''],
    ['', '', '', '', ''],
    ['C', '', 4, '', '']
  ]
});
assert.deepEqual(Array.from(worksheetData.headers), ['A', 'C']);
assert.deepEqual(Array.from(worksheetData.rowNumbers), [2, 4, 6]);
assert.equal(worksheetData.rowNumberOffset, 1);
assert.equal(worksheetData.rows.length, 3);
assert.deepEqual(Array.from(worksheetData.rows[1]), ['B', '3']);
assert.equal(worksheetData.truncatedRows, true);

const index = read('src/public/index.html');
const previewHTML = read('src/public/preview.html');
const favicon = read('src/public/favicon.svg');
assert.match(index, /v-else class="breadcrumb-current" aria-current="page"/);
assert.doesNotMatch(index, /@click="goToPrefix\(crumb\.prefix\)"[^>]*v-else/);
assert.match(index, /hiddenBreadcrumbs/);
assert.match(index, /visibleBreadcrumbs/);
assert.match(index, /ref="breadcrumbRegion"/);
assert.match(index, /ref="breadcrumbLine"/);
assert.match(index, /breadcrumb-overflow-ellipsis/);
assert.match(index, /Inside storage root/);
assert.match(index, /Inside \$\{hiddenBreadcrumbs\[index - 1\]\.name\}/);
assert.match(index, /Math\.min\(index, 6\) \* 0\.65/);
assert.match(index, /upload-drop-overlay/);
assert.match(index, /Drop files or folders to upload/);
assert.match(index, /<input type="file" ref="fileInput"[^>]*multiple/);
assert.match(index, /onPrefixDownload\(props\.row\)/);
assert.match(index, />Download as ZIP</);
assert.doesNotMatch(index, /Download page as ZIP|Download folder as ZIP/);
assert.doesNotMatch(index, /folder-zip-button/);
assert.doesNotMatch(index, /mdi-(?:aws|google-cloud)/);
assert.match(index, /mdi-database-outline/);
assert.match(index, /storage-option-title-row/);
assert.match(index, /v-if="instances.length > 1"/);
assert.match(index, /v-for="instance in otherInstances"/);
assert.match(index, /is-static-switcher/);
assert.doesNotMatch(index, /storage-option-check-placeholder/);
assert.match(index, /instance\.bucket/);
assert.match(index, /instance\.provider\.toUpperCase\(\)/);
assert.match(index, /currentInsightsLabel/);
assert.match(index, /build-version/);
assert.match(index, /build\.display/);
assert.match(index, /> Insights</);
assert.doesNotMatch(index, />\s*Permission details\s*</);
assert.doesNotMatch(index, />\s*Refresh permissions\s*</);
assert.doesNotMatch(index, />\s*Storage permissions\s*</);
assert.match(index, /rel="icon" type="image\/svg\+xml" href="favicon\.svg\?v=2"/);
assert.match(previewHTML, /<html lang="en" class="preview-root">/);
assert.match(previewHTML, /<body class="preview-page">/);
assert.match(previewHTML, /id="previewBuild"/);
assert.match(previewHTML, /common\/json-viewer\.js/);
const jsonViewerSource = read('src/public/assets/js/common/json-viewer.js');
assert.match(jsonViewerSource, /createModeButton\('raw', 'Raw'/);
assert.match(jsonViewerSource, /createModeButton\('beautify', 'Beautify'/);
assert.match(jsonViewerSource, /createModeButton\('tree', 'Tree'/);
assert.match(jsonViewerSource, /spreadsheet-tabs json-tabs/);
assert.match(jsonViewerSource, /initialPayload: payload\.node\?\.container \? payload : null/);
assert.match(jsonViewerSource, /BB\.api\.jsonSummary/);
assert.match(jsonViewerSource, /Lines \${lineStart\.toLocaleString\(\)}–\${lineEnd\.toLocaleString\(\)}/);
assert.match(jsonViewerSource, /element\${numeric === 1 \? '' : 's'}/);
assert.match(jsonViewerSource, /json-active-pager/);
assert.match(previewHTML, /rel="icon" type="image\/svg\+xml" href="favicon\.svg\?v=2"/);
assert.match(favicon, /viewBox="0 0 512 512"/);
assert.match(favicon, /#167df0/i);
assert.doesNotMatch(favicon, /<rect\b/i);

const style = read('src/public/assets/css/style.css');
assert.match(style, /\.code-line-numbers/);
assert.match(style, /text-align:\s*left/);
assert.match(style, /html\.preview-root,\s*\nbody\.preview-page\s*\{[^}]*height:\s*auto[^}]*overflow-y:\s*auto/s);
assert.match(style, /body\.preview-page\s*\{\s*overflow-x:\s*auto;/s);
assert.match(style, /\.viewer,\s*\n\.viewer\.is-scroll-contained\s*\{[^}]*overflow:\s*visible/s);
assert.match(style, /--preview-pad:\s*clamp\(\.625rem,\s*1vw,\s*1rem\)/);
assert.match(style, /\.data-preview\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
assert.match(style, /\.data-table-scroll\s*\{[^}]*overflow:\s*auto/s);
assert.match(style, /\.preview-document\s*\{[^}]*width:\s*100%[^}]*margin:\s*0/s);
assert.doesNotMatch(style, /\.data-preview-filterbar/);
assert.match(style, /\.data-preview-toolbar\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s);
assert.match(style, /\.data-preview-controls/);
assert.match(style, /\.data-sort-button/);
assert.doesNotMatch(style, /\.data-global-filter/);
assert.match(style, /\.viewer\.is-content-tall/);
assert.match(style, /\.media-track-controls/);
assert.match(style, /\.media-track-control select:disabled/);
assert.match(style, /\.media-video-stage/);
assert.match(style, /\.media-resolution-overlay/);
assert.match(style, /\.mermaid-preview-svg/);
assert.match(style, /max-height:\s*min\(58vh,\s*500px\)/);
assert.match(style, /\.browser-breadcrumbs\s*\{[^}]*overflow:\s*hidden/s);
assert.match(style, /\.browser-breadcrumbs h1\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow:\s*hidden/s);
assert.match(style, /\.head\s*\{[^}]*overflow:\s*visible/s);
assert.match(style, /\.breadcrumb-current\s*\{[^}]*flex:\s*1 1 0/s);
assert.match(style, /\.header-tools\s*\{[^}]*flex:\s*0 0 auto/s);
assert.match(style, /\.breadcrumb-overflow-ellipsis/);
assert.match(style, /\.breadcrumb-overflow-node/);
assert.match(style, /\.upload-drop-overlay/);
assert.match(style, /\.bb-upload-confirmation/);
assert.doesNotMatch(style, /\.folder-zip-button/);
assert.match(style, /\.code-horizontal-scroll\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*clip/s);
assert.match(style, /\.code-line-numbers\s*\{[^}]*position:\s*relative[^}]*left:\s*auto/s);
assert.match(style, /\.code-source::after\s*\{[^}]*repeating-linear-gradient[^}]*opacity:\s*\.38/s);
assert.match(style, /\.spreadsheet-preview\s*\{[^}]*overflow:\s*hidden/s);
assert.match(style, /\.spreadsheet-tabs/);
assert.match(style, /\.spreadsheet-sheet-controls \+ \.data-table-scroll/);
assert.match(style, /\.spreadsheet-sheet-host/);
assert.match(style, /\.spreadsheet-sheet-host > div\s*\{[^}]*width:\s*100%/s);
assert.doesNotMatch(style, /\.data-filter-help/);
assert.match(style, /--app-container-max/);
assert.match(style, /\.preview-page \.bar \.wrap\s*\{[^}]*max-width:\s*var\(--app-container-max\)/s);
assert.match(style, /\.storage-switcher \.dropdown-item\s*\{[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\)/s);
assert.match(style, /\.storage-switcher-trigger\.is-static:hover/);
assert.match(style, /\.markdown-body p,[\s\S]*text-align:\s*justify/s);
assert.match(style, /\.json-tree-line/);
assert.match(style, /\.word-document/);
assert.match(style, /body\.preview-page\.is-viewport-image\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
assert.match(style, /body\.preview-page\.is-viewport-image > \.viewer \.preview-content > img\s*\{[^}]*max-height:\s*100%/s);
assert.match(style, /\.toolbar \.dropdown-item > \.mdi/);
assert.match(style, /body\.preview-page\.is-viewport-image/);
assert.match(style, /html\.preview-root\.is-viewport-image/);
assert.match(style, /object-fit:\s*contain/);
assert.match(style, /\.toolbar \.dropdown-item > \.mdi/);
assert.match(style, /\.build-version/);

const uiCSS = read('src/public/assets/css/ui.css');
assert.match(uiCSS, /#bb-toast-host\s*\{[^}]*position:\s*fixed[^}]*right:[^}]*bottom:/s);
assert.match(uiCSS, /\.bb-transfer-panel/);
assert.match(uiCSS, /\.bb-transfer-list/);
assert.match(uiCSS, /\.bb-transfer-item-progress/);
assert.match(uiCSS, /font-variant-numeric:\s*tabular-nums/);
assert.match(uiCSS, /Dashboard-aligned notification theme/);
assert.match(uiCSS, /\.bb-toast,\s*\n\.bb-transfer-panel\s*\{[^}]*background:\s*#fff/s);
assert.match(uiCSS, /\.bb-toast strong,[\s\S]*color:\s*var\(--bb-text\)/);
assert.match(uiCSS, /\.folder-distribution-grid/);
assert.match(uiCSS, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(uiCSS, /\.folder-insights-tabs \.spreadsheet-tab/);
assert.match(uiCSS, /\.folder-treemap-name/);
assert.match(uiCSS, /\.folder-treemap-size/);
assert.match(uiCSS, /@media screen and \(min-width: 1200px\)[\s\S]*--browser-shell-max:\s*1152px/);
assert.match(uiCSS, /@media screen and \(min-width: 1408px\)[\s\S]*--browser-shell-max:\s*1344px/);
assert.match(uiCSS, /\.bb-modal-html > \.bb-modal-x\s*\{[^}]*position:\s*absolute[^}]*right:\s*-\.55rem/s);
assert.match(uiCSS, /#app \.build-version\s*\{[^}]*top:\s*\.08rem/s);

const uiSource = read('src/public/assets/js/common/ui.js');
assert.match(uiSource, /const transferGroups = new Map\(\)/);
assert.match(uiSource, /function transferGroup\(kind = 'transfer'\)/);
assert.match(uiSource, /existing && !existing\.closed/);
assert.match(uiSource, /Pause all/);
assert.match(uiSource, /Resume all/);
assert.match(uiSource, /function pauseAll\(\)/);
assert.match(uiSource, /function resumeAll\(\)/);
assert.match(uiSource, /function transferStatusRank\(item\)/);
assert.match(uiSource, /function reorderItems\(\)/);
assert.match(uiSource, /value === 'running' && recentlyTransferred/);
assert.match(uiSource, /item\.handlers\.pause\(\)/);
assert.match(uiSource, /item\.handlers\.resume\(\)/);
assert.match(uiSource, /lastActivityAt/);
assert.match(uiSource, /function reorderItems\(\)/);
assert.match(uiSource, /transferStatusRank\(left\)/);
assert.match(uiSource, /async function confirm\(\{ title = '', message = '', html = '', confirmLabel = 'OK', cancelLabel = 'Cancel' \}\)/);
assert.match(uiSource, /wrap\.innerHTML = String\(html \|\| ''\)/);
assert.match(uiSource, /BB\.ui = \{ alert, confirm, prompt, toast, transferGroup \}/);


const sqliteSource = read('src/public/assets/js/common/sqlite-viewer.js');
assert.match(sqliteSource, /Search the complete table/);
assert.match(sqliteSource, /deleteSQLiteSession/);
assert.match(sqliteSource, /spreadsheet-tabs/);
assert.match(sqliteSource, /sqlite-table-host/);
assert.match(sqliteSource, /keepVerticalWheelOnPage/);
assert.match(sqliteSource, /tableHost\.replaceChildren\(table\)/);
assert.match(sqliteSource, /payload\.totalRows/);
assert.match(sqliteSource, /payload\.sourceTotalRows/);

const apiSource = read('src/public/assets/js/common/api.js');
assert.match(apiSource, /new XMLHttpRequest\(\)/);
assert.match(apiSource, /xhr\.upload\.addEventListener\('progress'/);
assert.match(apiSource, /adaptiveUploadChunkSize/);
assert.match(apiSource, /targetDurationSeconds = 6/);
assert.match(apiSource, /resumable: true/);
assert.match(apiSource, /phase: 'retrying'/);
assert.match(apiSource, /Math\.min\(current \* 2, measuredTarget\)/);
assert.match(apiSource, /uploadStatus\(storedID, \{ signal \}\)/);
assert.match(apiSource, /createUpload\(\{ instance, key, size: blob\.size, contentType: mime \}, \{ signal \}\)/);
assert.match(apiSource, /async listAllItems/);
assert.match(apiSource, /onPage\(\{ count: items\.length, itemsCount: items\.length, page \}\)/);
assert.match(apiSource, /async list\(\{[^}]*signal = null/s);
assert.match(apiSource, /withInstance\(path, extraParams, explicitInstance = null\)/);
assert.match(apiSource, /urlForKey\(key, explicitInstance = null\)/);
assert.match(apiSource, /const instance = String\(options\.instance \|\| selectedInstance\(\)\)/);
assert.match(apiSource, /const instance = options\.instance \?\? null/);
assert.match(apiSource, /value !== undefined && value !== null/);
assert.doesNotMatch(apiSource, /value !== ''/);
assert.match(apiSource, /async spreadsheet\(/);
assert.match(apiSource, /\/api\/spreadsheet/);
assert.match(apiSource, /async delimitedPage\(/);
assert.match(apiSource, /\/api\/delimited/);
assert.match(apiSource, /async documentCount\(/);
assert.match(apiSource, /\/api\/document-count/);
assert.match(apiSource, /async jsonRaw\(/);
assert.match(apiSource, /\/api\/json\/raw/);
assert.match(apiSource, /async jsonBeautify\(/);
assert.match(apiSource, /\/api\/json\/beautify/);
assert.match(apiSource, /async jsonTree\(/);
assert.match(apiSource, /async searchDocument\(/);
assert.match(apiSource, /\/api\/search/);
assert.match(apiSource, /async createSQLiteSession\(/);
assert.match(apiSource, /async sqliteTable\(/);
assert.match(apiSource, /async deleteSQLiteSession\(/);
assert.match(apiSource, /\/api\/json\/tree/);
assert.match(apiSource, /async mediaInfo\(/);
assert.match(apiSource, /\/api\/media-info/);
assert.match(apiSource, /async searchDocument\(/);
assert.match(apiSource, /\/api\/search/);
assert.match(apiSource, /async createSQLiteSession\(/);
assert.match(apiSource, /\/api\/sqlite\/sessions/);
assert.match(apiSource, /imagePreviewURL\(/);
assert.match(apiSource, /\/api\/image-preview/);
assert.match(apiSource, /previewURLForKey\(key, explicitInstance = null\)/);
assert.doesNotMatch(apiSource, /async mediaProbe\(/);
assert.doesNotMatch(apiSource, /async createMediaSession\(/);
assert.doesNotMatch(apiSource, /async mediaSession\(/);
assert.doesNotMatch(apiSource, /async heartbeatMediaSession\(/);
assert.doesNotMatch(apiSource, /async deleteMediaSession\(/);
assert.doesNotMatch(apiSource, /\/api\/media-sessions/);

const actionsSource = read('src/public/assets/js/common/actions.js');
assert.match(actionsSource, /File details ready/);
assert.match(actionsSource, /Computing storage insights/);
assert.match(actionsSource, /persistent:\s*true,[\s\S]*status:\s*'loading'/);
assert.match(actionsSource, /notification\.update\(jobCompletionMessage/);
assert.match(actionsSource, /showSaveFilePicker/);
assert.match(actionsSource, /anchor\.download = filename/);
assert.match(actionsSource, /URL\.revokeObjectURL\(href\), 60000/);
assert.match(actionsSource, /const group = transferGroup\('download'\)/);
assert.match(actionsSource, /const downloadURL = BB\.api\.urlForKey\(key, BB\.api\.getInstance\(\)\)/);
assert.match(actionsSource, /streamURL\(downloadURL/);
assert.match(actionsSource, /onPause: pause/);
assert.match(actionsSource, /onResume: resume/);
assert.match(actionsSource, /onCancel: cancel/);
assert.match(actionsSource, /error\.transferState = checkpoint\(\)/);
assert.match(actionsSource, /headers\.Range = `bytes=\$\{receivedBytes\}-`/);
assert.match(actionsSource, /headers\['If-Range'\] = etag/);
assert.match(actionsSource, /formatTransferDetail/);
assert.match(actionsSource, /showTaskFailure/);
assert.match(actionsSource, /taskNotificationShown/);
assert.match(actionsSource, /BB\.api\.mediaInfo\(key, options\)/);
assert.match(actionsSource, /Resolution/);
assert.match(actionsSource, /Duration/);
assert.match(actionsSource, /Codec/);
assert.match(actionsSource, /Storage object/);
assert.match(actionsSource, /File metadata/);
assert.match(actionsSource, /Custom metadata/);
assert.match(actionsSource, /x-amz-meta-\|x-goog-meta-/);
assert.doesNotMatch(actionsSource, /content-security-policy/);
assert.doesNotMatch(actionsSource, /x-frame-options/);
assert.match(actionsSource, /selectable in preview/);
assert.match(actionsSource, /rendered when selected/);
assert.match(actionsSource, /formatBitRate/);
assert.match(actionsSource, /track\.frameRate/);
assert.match(actionsSource, /Distribution by size/);
assert.match(actionsSource, /Distribution by object count/);
assert.match(actionsSource, /async function showPrefixInsights\(prefix, initialTab = 'overview'\)/);
assert.match(actionsSource, /folder-insights-tabs/);
assert.match(actionsSource, /folder-treemap/);
assert.match(actionsSource, /slice\(0, treemapMaximumRectangles\)/);
assert.match(actionsSource, /treemapMinimumShare = 0\.01/);
assert.match(actionsSource, /const nodes = groupedTreemapChildren\(tree\)/);
assert.match(actionsSource, /function distributionEntries\(entries, field, maximum = 7\)/);
assert.match(actionsSource, /function layoutTreemapGroup\(/);
assert.match(actionsSource, /function collectTreemapRectangles\(/);
assert.doesNotMatch(actionsSource, /function treemapRectHTML\(/);
assert.match(actionsSource, /url\.searchParams\.set\('listed', '1'\)/);

const appSource = read('src/public/assets/js/app.js');
assert.match(appSource, /function createUploadManager\(browser\)/);
assert.match(appSource, /const group = BB\.ui\.transferGroup\('upload'\)/);
assert.match(appSource, /function add\(uploadEntries\) \{\s*const group = BB\.ui\.transferGroup\('upload'\)/);
assert.doesNotMatch(appSource, /const pending = \[\];\s*const group = BB\.ui\.transferGroup\('upload'\)/);
assert.match(appSource, /const concurrency = 4/);
assert.match(appSource, /while \(activeCount < concurrency && pending\.length\)/);
assert.match(appSource, /onPause: \(\) => pause\(entry\)/);
assert.match(appSource, /onResume: \(\) => resume\(entry\)/);
assert.match(appSource, /onCancel: \(\) => cancel\(entry\)/);
assert.match(appSource, /return \{ add \}/);
assert.match(appSource, /instance: entry\.instanceId/);
assert.match(appSource, /entry\.uploadId = String\(upload\?\.id \|\| ''\)/);
assert.match(appSource, /BB\.api\.cancelUpload\(entry\.uploadId\)/);
assert.match(appSource, /instanceId: this\.instanceId|const instanceId = this\.instanceId/);
assert.match(appSource, /basePrefix = this\.pathPrefix/);
assert.match(appSource, /BB\.api\.urlForKey\(source\.key, instanceId\)/);
assert.match(appSource, /const group = BB\.ui\.transferGroup\('download'\)/);
assert.match(appSource, /creating ZIP/);
assert.match(appSource, /window\.fflate\.zip\(archiveInput/);
assert.match(appSource, /droppedUploadEntries/);
assert.doesNotMatch(appSource, /getAsFileSystemHandle/);
assert.match(appSource, /webkitGetAsEntry/);
assert.match(appSource, /showUploadSelectionError/);
assert.match(appSource, /positionBreadcrumbOverflow/);
assert.match(appSource, /window\.innerWidth - width - margin/);
assert.doesNotMatch(appSource, /window\.showDirectoryPicker/);
assert.match(appSource, /triggerUploadDir\(\)\s*\{[\s\S]*input\.click\(\)/);
assert.doesNotMatch(appSource, /Choose a folder/);
assert.match(appSource, /confirmFolderUpload\(entries/);
assert.match(appSource, /html:\s*`<div class="bb-upload-confirmation">/);
assert.doesNotMatch(appSource, /window\.alert\s*\(/);
assert.match(appSource, /uploadResolvedFiles/);
assert.match(appSource, /window\.addEventListener\('dragenter'/);
assert.match(appSource, /onPrefixDownload/);
assert.match(appSource, /BB\.api\.listAllItems/);
assert.match(appSource, /BB\.detect\.iconForType\(BB\.detect\.resolveType/);
assert.match(appSource, /otherInstances\(\) \{ return this\.instances\.filter/);
assert.match(appSource, /breadcrumbVisibleStart/);
assert.match(appSource, /measureBreadcrumbs\(\)/);
assert.match(appSource, /const requiredWidth = start =>/);
assert.match(appSource, /const visibleCount = currentIndex - start \+ 1/);
assert.match(appSource, /const separatorCount = start > 0 \? visibleCount \+ 1 : visibleCount/);
assert.match(appSource, /while \(start > 0 && requiredWidth\(start - 1\) <= available\) start--/);
assert.match(appSource, /ResizeObserver\(\(\) => this\.scheduleBreadcrumbLayout\(\)\)/);
assert.match(appSource, /async showPermissionDetails\(\)/);
assert.match(index, /storage-switcher-permissions is-interactive/);
assert.doesNotMatch(appSource, /async refreshPermissions\(/);
assert.match(appSource, /onRowContextMenu\(event\)/);
assert.match(appSource, /BB\.menu\.openAt\(menu, event\.clientX, event\.clientY\)/);
assert.match(appSource, /document\.addEventListener\('contextmenu'/);
assert.match(appSource, /onPrefixInsights\(row\)/);
assert.match(appSource, /onCurrentInsights\(\)/);
assert.match(appSource, /currentInsightsLabel\(\)/);

const backendSource = read('src/app.go');
const configSource = read('src/config.go');
const jobsSource = read('src/jobs.go');
const buildInfoSource = read('src/build_info.go');
assert.match(configSource, /job_history_limit/);
assert.match(jobsSource, /pruneHistory/);
assert.match(buildInfoSource, /shortCommit/);
assert.doesNotMatch(backendSource, /\/api\/media-source/);
assert.doesNotMatch(backendSource, /\/api\/media-probe/);
assert.doesNotMatch(backendSource, /\/api\/media-sessions/);
assert.match(backendSource, /\/api\/image-preview/);
assert.match(backendSource, /\/api\/search/);
assert.match(backendSource, /\/api\/delimited/);
assert.match(backendSource, /\/api\/document-count/);
assert.match(backendSource, /\/api\/build/);
assert.match(backendSource, /\/api\/sqlite\/sessions/);

const browserDockerfile = read('test/browser/Dockerfile');
assert.match(browserDockerfile, /^FROM scratch AS runtime$/m);
assert.match(browserDockerfile, /CGO_ENABLED=0/);
assert.match(browserDockerfile, /-tags=netgo,osusergo/);
assert.match(browserDockerfile, /-buildid=/);
assert.match(browserDockerfile, /COPY --from=builder \/out\/rootfs\/ \/$/m);
assert.doesNotMatch(browserDockerfile, /FROM alpine:.*runtime-tools/);
assert.doesNotMatch(browserDockerfile, /ffmpeg|imagemagick|sqlite3?/i);
assert.match(browserDockerfile, /USER 65532:65532/);

const goreleaserSource = read('src/.goreleaser.yaml');
assert.match(goreleaserSource, /CGO_ENABLED=0/);
assert.match(goreleaserSource, /- netgo/);
assert.match(goreleaserSource, /- osusergo/);
assert.match(goreleaserSource, /- -trimpath/);
assert.match(goreleaserSource, /-s -w -buildid=/);
assert.match(goreleaserSource, /- arm64/);

const releaseWorkflow = read('.github/workflows/release.yaml');
assert.match(releaseWorkflow, /Verify statically linked release binary/);
assert.match(releaseWorkflow, /\.\/test\/scratch-runtime\.sh/);

const composeSource = read('test/docker-compose.yaml');
assert.match(composeSource, /target: runtime/);
assert.doesNotMatch(composeSource, /BROWSER_RUNTIME_TARGET/);

const previewSource = read('src/public/assets/js/preview.js');
assert.match(previewSource, /is-scroll-contained/);
assert.match(previewSource, /contentHeight > shell\.clientHeight \+ 1/);
assert.doesNotMatch(previewSource, /BB\.api\.listAll\(/);
assert.match(previewSource, /previewURLForKey/);
assert.match(previewSource, /pdfjs-dist@4\.10\.38/);
assert.match(previewSource, /function pdfRangeChunkSize\(\)/);
assert.match(previewSource, /toolbarRail\.className = 'pdf-toolbar-rail'/);
assert.match(previewSource, /toolbarSpacer\.className = 'pdf-toolbar-spacer'/);
assert.match(previewSource, /rangeChunkSize:\s*pdfRangeChunkSize\(\)/);
assert.match(previewSource, /disableAutoFetch:\s*true/);
assert.match(previewSource, /disableStream:\s*true/);
assert.match(previewSource, /documentTask\?\.destroy/);
assert.match(previewSource, /Video preview is disabled/);
assert.doesNotMatch(previewSource, /media-sessions|media-probe|HLS\.js|hls\.js|FFmpeg/);
assert.match(previewSource, /Native audio playback is unavailable/);
assert.match(previewSource, /renderWordDocument/);
assert.match(previewSource, /mammoth@1\.12\.0/);
assert.match(previewSource, /BB\.jsonViewer\.render/);
assert.match(previewSource, /BB\.sqliteViewer\.render/);
assert.match(previewSource, /openDocumentSearch/);
assert.match(previewSource, /String\(event\.key\)\.toLowerCase\(\) !== 'f'/);
assert.match(previewSource, /raw-image' \|\| type === 'image-convert/);
assert.match(previewSource, /document\.documentElement\.classList\.toggle\('is-viewport-image'/);
assert.match(previewSource, /listedObjectMetadata\(\) \|\| await BB\.api\.head\(key\)/);
assert.match(previewSource, /if \(type === 'tabular'\) \{[\s\S]*searchRawDocument\(key, query\)/);
assert.match(previewSource, /type === 'sqlite'/);
assert.doesNotMatch(previewSource, /contentNeedsViewport/);

assert.match(style, /\.pdf-preview\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
assert.match(style, /\.pdf-toolbar-rail\s*\{[\s\S]*position:\s*fixed[\s\S]*right:\s*0[\s\S]*left:\s*0/s);
assert.match(style, /\.sqlite-table-host \.data-table-scroll\s*\{[\s\S]*overflow-y:\s*visible/s);

const renderSource = read('src/public/assets/js/common/render.js');
assert.match(renderSource, /mermaid@11\.16\.0/);
assert.match(renderSource, /prepareMermaidBlocks/);
assert.match(renderSource, /pre > code\.language-mermaid/);
assert.match(renderSource, /securityLevel:\s*'strict'/);
assert.match(renderSource, /htmlLabels:\s*false/);
assert.match(renderSource, /flowchart:\s*\{ htmlLabels:\s*false/);
assert.match(renderSource, /sanitizeMermaidSVG/);
assert.match(renderSource, /classList\.add\('mermaid-preview-svg'\)/);
assert.match(renderSource, /MERMAID_DISPLAY_MAX_WIDTH = 680/);
assert.match(renderSource, /MERMAID_DISPLAY_MAX_HEIGHT = 500/);
assert.match(renderSource, /imported\.setAttribute\('width', String\(displayWidth\)\)/);
assert.doesNotMatch(renderSource, /setAttribute\('width',\s*'100%'\)/);
assert.match(renderSource, /--code-content-width/);
assert.match(renderSource, /longestLine \* 8\.25 \+ 120/);
assert.doesNotMatch(renderSource, /data:image\/svg\+xml/);

const detectSource = read('src/public/assets/js/common/detect.js');
assert.match(detectSource, /spreadsheet:\s*'file-excel-outline'/);
assert.match(detectSource, /json:\s*'code-json'/);
assert.match(detectSource, /word:\s*'file-word-outline'/);
assert.match(detectSource, /'raw-image':\s*'file-image-outline'/);
assert.match(detectSource, /sqlite:\s*'database-search-outline'/);
assert.match(detectSource, /qoi/);
assert.match(detectSource, /farbfeld/);
assert.match(detectSource, /fits/);

const tabularSource = read('src/public/assets/js/common/tabular.js');
assert.match(tabularSource, /PAGE_SIZE_OPTIONS = \[100, 250, 500, 1000\]/);
assert.match(tabularSource, /createRemoteDelimitedTable/);
assert.match(tabularSource, /BB\.api\.delimitedPage/);
assert.match(tabularSource, /BB\.api\.documentCount/);
assert.match(tabularSource, /Use Count rows to scan the complete document/);
assert.match(tabularSource, /extension === 'tsv' \|\| extension === 'tab'/);
assert.match(tabularSource, /previousScrollLeft/);
assert.match(tabularSource, /scrollLeft = previousScrollLeft/);
assert.match(tabularSource, /xlsx-0\.20\.3\/package\/dist\/xlsx\.full\.min\.js/);
assert.match(tabularSource, /renderSpreadsheet/);
assert.match(tabularSource, /renderRemoteSpreadsheet/);
assert.match(tabularSource, /BB\.api\.spreadsheet/);
assert.match(tabularSource, /if \(descriptors\.length < 2\) return null/);
assert.match(tabularSource, /workbook\.SheetNames/);
assert.match(tabularSource, /beforeTableFactory/);
assert.match(tabularSource, /spreadsheet-sheet-controls/);
assert.match(tabularSource, /controls\.className = 'data-preview-controls'/);
assert.match(tabularSource, /if \(allowFilters\) \{[\s\S]*controls\.appendChild\(filterToggle\)/);
assert.match(tabularSource, /if \(clear\) controls\.appendChild\(clear\)/);
assert.match(tabularSource, /controls\.appendChild\(pageSizeLabel\)/);
assert.match(tabularSource, /controls\.appendChild\(pagination\)/);
assert.match(tabularSource, /if \(values\.every\(isEmptyCell\)\) return/);
assert.match(tabularSource, /if \(nonEmptyRows\.some\(entry => !isEmptyCell\(entry\.values\[column\]\)\)\)/);
assert.match(tabularSource, /Workbook macros are not executed/);
assert.doesNotMatch(tabularSource, /Visible sheet \${/);
assert.doesNotMatch(tabularSource, /Search all columns/);
assert.doesNotMatch(tabularSource, /data-global-filter/);
assert.doesNotMatch(tabularSource, /Column filters use contains matching by default/);
assert.doesNotMatch(tabularSource, /Plain text means contains/);
assert.match(tabularSource, /root\.documentSearch = async query/);
assert.match(tabularSource, /Searching the complete Parquet document/);

function loadActions(fetchImplementation) {
  const actionWindow = {
    BB: { api: {}, detect: {} },
    setTimeout,
    clearTimeout
  };
  actionWindow.window = actionWindow;
  const actionContext = vm.createContext({
    window: actionWindow,
    document: {
      createElement() {
        return {
          textContent: '',
          style: {},
          appendChild() {},
          remove() {},
          click() {},
          get innerHTML() { return this.textContent; }
        };
      },
      body: { appendChild() {} }
    },
    console,
    Blob,
    Uint8Array,
    DOMException,
    AbortController,
    ReadableStream,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    fetch: fetchImplementation
  });
  vm.runInContext(read('src/public/assets/js/common/actions.js'), actionContext, {
    filename: 'src/public/assets/js/common/actions.js'
  });
  return actionWindow.BB.actions;
}

async function assertDownloadAbortIsImmediate() {
  const actions = loadActions(async () => {
    let timer = 0;
    let emitted = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        return new Promise(resolve => {
          timer = setTimeout(() => {
            emitted += 64;
            controller.enqueue(new Uint8Array(64));
            if (emitted >= 1024) controller.close();
            resolve();
          }, 12);
        });
      },
      cancel() { clearTimeout(timer); }
    }), { headers: { 'Content-Length': '1024' } });
  });

  const controller = new AbortController();
  const transfer = actions.streamURL('/slow-object', { signal: controller.signal, totalBytes: 1024 });
  setTimeout(() => controller.abort(), 24);
  await assert.rejects(transfer, error => error?.name === 'AbortError' && error?.transferState?.receivedBytes >= 0);
}

async function assertDownloadResumeUsesRange() {
  let request = 0;
  const actions = loadActions(async (_url, options = {}) => {
    request++;
    const headers = options.headers || {};
    if (request === 1) {
      assert.equal(headers.Range, undefined);
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (sent) return;
          sent = true;
          controller.enqueue(Uint8Array.from([0, 1, 2, 3]));
        }
      }), {
        status: 200,
        headers: { 'Content-Length': '10', ETag: '"checkpoint"' }
      });
    }
    assert.equal(headers.Range, 'bytes=4-');
    assert.equal(headers['If-Range'], '"checkpoint"');
    return new Response(Uint8Array.from([4, 5, 6, 7, 8, 9]), {
      status: 206,
      headers: {
        'Content-Length': '6',
        'Content-Range': 'bytes 4-9/10',
        ETag: '"checkpoint"'
      }
    });
  });

  const firstController = new AbortController();
  let checkpoint = null;
  try {
    await actions.streamURL('/resumable-object', {
      signal: firstController.signal,
      totalBytes: 10,
      onProgress(progress) {
        if (progress.receivedBytes >= 4) firstController.abort();
      }
    });
    assert.fail('The first transfer should have been paused');
  } catch (error) {
    assert.equal(error?.name, 'AbortError');
    checkpoint = error.transferState;
  }
  assert.equal(checkpoint.receivedBytes, 4);
  assert.equal(checkpoint.totalBytes, 10);
  assert.equal(checkpoint.etag, '"checkpoint"');

  const result = await actions.streamURL('/resumable-object', { resumeState: checkpoint, totalBytes: 10 });
  assert.equal(result.receivedBytes, 10);
  assert.equal(result.totalBytes, 10);
  assert.deepEqual(Array.from(new Uint8Array(await result.blob.arrayBuffer())), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(request, 2);
}

Promise.resolve()
  .then(assertDownloadAbortIsImmediate)
  .then(assertDownloadResumeUsesRange)
  .then(() => console.log('frontend smoke tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
