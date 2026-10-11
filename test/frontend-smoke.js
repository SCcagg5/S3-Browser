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
    p1["Phase 1 — VR probe"]
    p2["Phase 2 — top-K"]
    p3["Phase 3 — golden-section optimization"]
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
assert.equal(detect.resolveType('binary.doc', 'application/msword'), 'word-unavailable');
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

const index = read('src/public/index.html') + read('src/frontend/app.template.html');
const previewHTML = read('src/public/preview.html');
const favicon = read('src/public/favicon.svg');
assert.match(index, /class="root-link"[\s\S]*:class="\{ 'breadcrumb-current': !breadcrumbs\.length \}"/);
assert.match(index, /:aria-current="breadcrumbs\.length \? null : 'page'"/);
assert.equal((index.match(/class="root-link"/g) || []).length, 1, 'Root must keep one stable button element in every breadcrumb state');
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
assert.match(index, /onPrefixDownload\(row\)/);
assert.match(index, />Download as ZIP</);
assert.doesNotMatch(index, /Download page as ZIP|Download folder as ZIP/);
assert.doesNotMatch(index, /folder-zip-button/);
assert.doesNotMatch(index, /mdi-(?:aws|google-cloud)/);
assert.match(index, /mdi-database-outline/);
assert.match(index, /storage-option-title-row/);
assert.match(index, /v-if="currentInstance && instances.length > 1"/);
assert.match(index, /v-for="host in storageHosts"/);
assert.match(index, /v-for="instance in host\.instances"/);
assert.match(index, /storage-tree-popover/);
assert.match(index, /storage-host-row/);
assert.match(index, /storage-bucket-row/);
assert.match(index, /currentInstance\.host \}\} \/ \{\{ currentInstance\.id/);
assert.match(index, /is-static-switcher/);
assert.match(index, /is-loading-switcher/);
assert.match(index, /storage-switcher-loading-line is-title/);
assert.doesNotMatch(index, /storage-option-check-placeholder/);
assert.match(index, /instance\.bucket/);
assert.match(index, /host\.provider\.toUpperCase\(\)/);
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
// Viewer modules are loaded on demand by preview.js, not by script tags.
assert.doesNotMatch(previewHTML, /common\/(json-viewer|tabular|sqlite-viewer|structured-viewers)\.js/);
assert.match(read('src/public/assets/js/preview.js'), /json: \['assets\/vendor\/highlightjs\/11\/highlight\.min\.js', 'assets\/js\/common\/json-viewer\.js'\]/);
assert.match(read('src/public/assets/js/preview.js'), /await loadViewerModules\(type, archiveEntry\)/);
assert.doesNotMatch(previewHTML + index, /<script src=/);
assert.ok(index.indexOf('assets/css/browser.css') > index.indexOf('assets/css/ui.css'), 'browser.css must be the last project CSS layer of the browser page');
assert.ok(previewHTML.indexOf('assets/css/preview.css') > previewHTML.indexOf('assets/css/ui.css'), 'preview.css must be the last project CSS layer of the preview page');
assert.match(index, /class="storage-switcher-trigger has-bb-chevron"/);
assert.match(index, /class="btn has-bb-chevron bb-menu-trigger"[^>]*>\s*<i class="mdi mdi-cogs"/);
assert.match(index, /class="btn btn-primary has-bb-chevron bb-menu-trigger"[^>]*>\s*<i class="mdi mdi-plus"/);
assert.doesNotMatch(`${index}
${previewHTML}`, /<i[^>]+mdi-chevron-down/);
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

const cssRead = name => read(`src/public/assets/css/${name}.css`);
// Each stylesheet is asserted on its own so a contract cannot be satisfied by a different layer.
const cssBase = cssRead('base');
const cssUi = cssRead('ui');
const cssTreemap = cssRead('treemap');
const cssBrowser = cssRead('browser');
const cssPreview = cssRead('preview');
const cssMarkdown = cssRead('markdown');
const cssSyntax = cssRead('syntax');
const cssA11y = cssRead('a11y');
const appCSS = [cssBase, cssUi, cssTreemap, cssBrowser, cssPreview, cssMarkdown, cssSyntax, cssA11y].join('\n');
const iconsCSS = read('src/public/assets/css/icons.css');
const style = [
  'src/public/assets/css/tokens.css',
  'src/public/assets/css/base.css',
  'src/public/assets/css/ui.css',
  'src/public/assets/css/preview.css',
  'src/public/assets/css/browser.css'
].map(read).join('\n');
assert.match(cssPreview, /\.code-line-numbers/);
assert.match(cssBrowser, /text-align:\s*left/);
assert.match(cssPreview, /html\.preview-root,\s*\nbody\.preview-page\s*\{[^}]*height:\s*auto[^}]*overflow-y:\s*auto/s);
assert.match(cssPreview, /body\.preview-page\s*\{\s*overflow-x:\s*auto;/s);
assert.match(cssPreview, /\.viewer,\s*\n\.viewer\.is-scroll-contained\s*\{[^}]*overflow:\s*visible/s);
assert.match(style, /--preview-pad:\s*clamp\(\.625rem,\s*1vw,\s*1rem\)/);
assert.match(cssPreview, /\.data-preview\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
assert.match(cssUi, /\.data-table-scroll\s*\{[^}]*overflow:\s*auto/s);
assert.match(cssPreview, /\.preview-document\s*\{[^}]*width:\s*100%[^}]*margin:\s*0/s);
assert.doesNotMatch(appCSS, /\.data-preview-filterbar/);
assert.match(cssPreview, /\.data-preview-toolbar\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s);
assert.match(cssPreview, /\.data-preview-controls/);
assert.match(cssPreview, /\.data-sort-button/);
assert.doesNotMatch(appCSS, /\.data-global-filter/);
assert.match(cssPreview, /\.viewer\.is-content-tall/);
assert.match(cssPreview, /\.media-track-controls/);
assert.match(cssPreview, /\.media-track-control select:disabled/);
assert.match(cssPreview, /\.media-video-stage/);
assert.match(cssPreview, /\.mermaid-preview-svg/);
assert.match(cssPreview, /max-height:\s*min\(58vh,\s*31\.25rem\)/);
assert.match(cssBrowser, /\.browser-breadcrumbs\s*\{[^}]*overflow:\s*hidden/s);
assert.match(cssBrowser, /\.breadcrumb-line\s*\{[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap/s);
assert.match(cssBrowser, /\.head\s*\{[^}]*align-items:\s*center/s);
assert.match(style, /--browser-header-row-height:\s*3.625rem/);
assert.match(cssBrowser, /\.head\s*\{[^}]*min-height:\s*var\(--browser-header-row-height\)/s);
assert.match(cssBrowser, /\.browser-breadcrumbs\s*\{[^}]*min-height:\s*var\(--browser-header-row-height\)/s);
assert.match(cssBrowser, /\.breadcrumb-current\s*\{[^}]*flex:\s*1 1 0/s);
assert.match(cssBrowser, /\.header-tools\s*\{[^}]*flex:\s*0 0 auto[^}]*min-height:\s*var\(--browser-header-row-height\)/s);
assert.match(cssBrowser, /\.storage-switcher-trigger\s*\{[^}]*height:\s*var\(--browser-header-row-height\)/s);
assert.match(cssBrowser, /\.root-link\s*\{[^}]*color:\s*var\(--color-primary\)/s);
assert.match(cssBrowser, /\.root-link\.breadcrumb-current\s*\{[^}]*flex:\s*0 0 auto/s);
assert.match(cssBrowser, /\.breadcrumb-overflow-ellipsis/);
assert.match(cssBrowser, /\.breadcrumb-overflow-node/);
assert.match(cssBrowser, /\.upload-drop-overlay/);
assert.match(cssBrowser, /\.bb-upload-confirmation/);
assert.doesNotMatch(appCSS, /\.folder-zip-button/);
assert.match(cssPreview, /\.code-horizontal-scroll\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*clip/s);
assert.match(cssPreview, /\.code-line-numbers\s*\{[^}]*position:\s*relative[^}]*left:\s*auto/s);
assert.match(cssPreview, /\.code-source::after\s*\{[^}]*repeating-linear-gradient[^}]*opacity:\s*\.38/s);
assert.match(cssPreview, /\.spreadsheet-preview\s*\{[^}]*overflow:\s*hidden/s);
assert.match(cssPreview, /\.spreadsheet-tabs/);
assert.match(cssPreview, /\.spreadsheet-sheet-controls \+ \.data-table-scroll/);
assert.doesNotMatch(appCSS, /\.data-filter-help/);
assert.match(cssBrowser, /--container-max/);
assert.match(cssPreview, /\.preview-page \.bar \.wrap\s*\{[^}]*max-width:\s*var\(--container-max\)/s);
assert.match(cssBrowser, /\.storage-tree-popover\s*\{[^}]*position:\s*absolute[^}]*overflow-y:\s*auto/s);
assert.match(cssBrowser, /\.storage-host-row\s*\{[^}]*grid-template-columns:\s*1\.125rem 1\.5rem minmax\(0, 1fr\)/s);
assert.match(cssBrowser, /\.storage-bucket-row\s*\{[^}]*grid-template-columns:\s*1\.5rem minmax\(0, 1fr\) 1\.125rem/s);
assert.match(cssBrowser, /html:not\(\.preview-root\)\s*\{[^}]*overflow-y:\s*scroll[^}]*scrollbar-gutter:\s*stable/s);
assert.match(cssBrowser, /\.storage-switcher-trigger\.is-static:hover/);
assert.doesNotMatch(appCSS, /\.markdown-body p,[\s\S]*text-align:\s*justify/s);
assert.match(cssPreview, /\.json-tree-line/);
assert.match(cssPreview, /\.word-document/);
assert.match(cssPreview, /body\.preview-page\.is-viewport-image\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
assert.match(cssPreview, /body\.preview-page\.is-viewport-image > \.viewer \.preview-content > img\s*\{[^}]*max-height:\s*100%/s);
assert.match(cssPreview, /body\.preview-page\.is-viewport-image/);
assert.match(cssPreview, /html\.preview-root\.is-viewport-image/);
assert.match(cssPreview, /object-fit:\s*contain/);
assert.match(cssBrowser, /\.build-version/);
assert.match(cssUi, /\.select:not\(\.is-multiple\):not\(\.is-loading\)::after,\s*\n\.has-bb-chevron::after/);
assert.match(cssPreview, /icons\/mdi\/chevron-down\.svg/);
assert.doesNotMatch(appCSS, /#app \.select:not\(\.is-multiple\):not\(\.is-loading\)::after/);
assert.match(cssUi, /\.btn\s*\{[^}]*min-height:\s*var\(--control-height-md\)/s);
assert.doesNotMatch(appCSS, /\.bb-btn|\.icon-btn|\.data-tool-button/);
assert.match(cssBrowser, /\.bb-permission-result\s*\{[^}]*white-space:\s*nowrap/s);
assert.match(cssBrowser, /\.bb-permission-result\.is-allowed[^}]*color:\s*var\(--color-success\)/s);
assert.match(cssBrowser, /\.bb-permission-result\.is-denied[^}]*color:\s*var\(--color-danger\)/s);
assert.match(cssBrowser, /\.bb-permission-result\.is-unknown[^}]*color:\s*var\(--color-text-secondary\)/s);
for (const icon of ['file-outline', 'file-excel-outline', 'file-word-outline', 'file-pdf-box', 'folder', 'file-upload-outline', 'folder-upload-outline', 'database-outline']) {
  assert.equal(fs.existsSync(path.join(root, 'src/public/assets/icons/mdi', `${icon}.svg`)), true, `missing local icon ${icon}`);
  assert.match(iconsCSS, new RegExp(`\\.mdi-${icon.replaceAll('-', '\\-')} \\{ --bb-mdi-icon: url\\("\\.\\.\\/icons\\/mdi\\/${icon.replaceAll('-', '\\-')}\\.svg"\\); \\}`));
}

assert.match(cssUi, /#bb-toast-host\s*\{[^}]*position:\s*fixed[^}]*right:[^}]*bottom:/s);
assert.match(cssUi, /\.bb-transfer-panel/);
assert.match(cssUi, /\.bb-transfer-list/);
assert.match(cssUi, /\.bb-transfer-item-progress/);
assert.match(cssBrowser, /font-variant-numeric:\s*tabular-nums/);
assert.match(cssUi, /Notifications: toasts and the transfer queue/);
assert.match(cssUi, /\.bb-toast,\s*\n\.bb-transfer-panel\s*\{[^}]*background:\s*var\(--color-bg-panel\)/s);
assert.match(cssUi, /\.bb-toast,\s*\.bb-transfer-panel\s*\{[^}]*color:\s*var\(--color-text\)/s);
assert.match(cssUi, /\.folder-distribution-grid/);
assert.match(cssUi, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.doesNotMatch(appCSS, /\.folder-insights-tabs \.spreadsheet-tab/);
assert.match(cssUi, /\.spreadsheet-tab\s*\{[^}]*height:\s*var\(--control-height-sm\)[^}]*background:\s*var\(--color-bg-subtle\)[^}]*border-radius:\s*var\(--radius-md\) var\(--radius-md\) 0 0/s);
assert.match(cssTreemap, /\.folder-treemap-name/);
assert.match(cssTreemap, /\.folder-treemap-size/);
assert.doesNotMatch(cssRead('ui') + cssRead('browser') + cssRead('preview'), /\.folder-treemap/);
assert.match(index, /assets\/css\/treemap\.css/);
assert.match(cssTreemap, /\.folder-treemap-label\s*\{[^}]*background:\s*none/s);
assert.match(cssTreemap, /\.folder-treemap-size\s*\{[^}]*background:\s*none/s);
assert.match(cssTreemap, /\.folder-treemap-node\.is-folder\s*\{[^}]*background:\s*var\(--color-bg-subtle\)[^}]*border:\s*1px solid var\(--color-border-strong\)[^}]*border-radius:\s*2px/s);
assert.match(cssTreemap, /\.folder-treemap-tooltip\s*\{[^}]*pointer-events:\s*none/s);
assert.match(cssTreemap, /\.folder-treemap-tooltip\s*\{[^}]*color:\s*var\(--color-text[^}]*background:\s*var\(--color-bg-panel[^}]*border:\s*1px solid var\(--color-border/s);
assert.match(cssTreemap, /\.folder-treemap-node\.is-folder\.is-branch > \.folder-treemap-label\s*\{[^}]*grid-template-rows:\s*\.75rem \.625rem[^}]*gap:\s*0/s);
assert.match(cssTreemap, /\.folder-treemap-node\.is-hovered/);
assert.doesNotMatch(cssTreemap, /z-index:\s*1200/);
assert.doesNotMatch(cssTreemap, /\.folder-treemap-focus/);
assert.match(cssTreemap, /\.folder-treemap-details/);
assert.doesNotMatch(cssTreemap, /\.folder-treemap-rule/);
assert.match(cssBrowser, /#app > \.main-content\s*\{[^}]*max-width:\s*var\(--container-max\)/s);
assert.match(index, /<footer v-if=\"build && build\.display\" class=\"app-footer\">/);
assert.match(cssUi, /\.bb-modal-html > \.bb-modal-x\s*\{[^}]*position:\s*absolute[^}]*right:\s*-\.55rem/s);
assert.doesNotMatch(appCSS, /\.folder-insights-tabs \.spreadsheet-tab/);
assert.doesNotMatch(cssBrowser, /\.build-version\s*\{[^}]*position:\s*absolute/s);

const uiSource = read('src/public/assets/js/common/ui.js');
assert.match(uiSource, /const transferGroups = new Map\(\)/);
assert.match(uiSource, /function transferGroup\(kind = 'transfer'\)/);
assert.match(uiSource, /existing && !existing\.closed/);
assert.match(uiSource, /Pause<\/span>/);
assert.match(uiSource, /Resume<\/span>/);
assert.match(uiSource, /function pauseTransfers\(\)/);
assert.match(uiSource, /function resumeTransfers\(\)/);
assert.match(uiSource, /function transferStatusRank\(item\)/);
assert.match(uiSource, /function reorderItems\(\)/);
assert.match(uiSource, /value === 'running' && recentlyTransferred/);
assert.match(uiSource, /item\.handlers\.pause\(\)/);
assert.match(uiSource, /item\.handlers\.resume\(\)/);
assert.match(uiSource, /lastActivityAt/);
assert.match(uiSource, /function reorderItems\(\)/);
assert.match(uiSource, /transferStatusRank\(left\)/);
assert.match(uiSource, /async function confirm\(\{ title = '', message = '', html = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false \}\)/);
assert.match(uiSource, /wrap\.innerHTML = String\(html \|\| ''\)/);
assert.match(uiSource, /BB\.ui = \{ alert, confirm, prompt, toast, transferGroup, enhanceTabs, replaceContent \}/);


const sqliteSource = read('src/public/assets/js/common/sqlite-viewer.js');
assert.doesNotMatch(sqliteSource, /Search the complete table|sqlite-query-toolbar/);
assert.match(sqliteSource, /deleteSQLiteSession/);
assert.match(sqliteSource, /spreadsheet-tabs/);
assert.match(sqliteSource, /keepVerticalWheelOnPage/);
assert.match(sqliteSource, /payload\.totalKnown/);
assert.match(sqliteSource, /payload\.hasMore/);
assert.match(sqliteSource, /filters: activeFilters\(\)/);
assert.match(sqliteSource, /sortColumn: state\.sortColumn/);

const apiSource = read('src/public/assets/js/common/api.js');
assert.match(apiSource, /new XMLHttpRequest\(\)/);
assert.match(apiSource, /xhr\.upload\.addEventListener\('progress'/);
assert.match(apiSource, /adaptiveUploadChunkSize/);
assert.match(apiSource, /targetDurationSeconds = 6/);
assert.match(apiSource, /resumable: true/);
assert.match(apiSource, /phase: 'retrying'/);
assert.match(apiSource, /Math\.min\(current \* 2, measuredTarget\)/);
assert.match(apiSource, /uploadStatus\(storedToken, \{ signal \}\)/);
assert.match(apiSource, /createUpload\(\{ instance, key, size: blob\.size, contentType: mime \}, \{ signal \}\)/);
assert.match(apiSource, /async listAllItems/);
assert.match(apiSource, /onPage\(\{ count: items\.length, itemsCount: items\.length, page \}\)/);
assert.match(apiSource, /async list\(\{[^}]*signal = null/s);
assert.match(apiSource, /withInstance\(path, extraParams, explicitInstance = null\)/);
assert.match(apiSource, /urlForKey\(key, explicitInstance = null, version = ''\)/);
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
assert.match(apiSource, /previewURLForKey\(key, explicitInstance = null, version = ''\)/);
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
assert.match(actionsSource, /anchor\.download = filename/);
assert.match(actionsSource, /triggerBrowserDownload\(downloadURL, safeFilename\)/);
assert.match(actionsSource, /const downloadURL = BB\.api\.openURLForKey\(key, options\.instance \|\| BB\.api\.getInstance\(\), options\.version \|\| ''\)/);
assert.doesNotMatch(actionsSource, /streamURL|fetchBytes|new Blob\(chunks|bytes=\$\{receivedBytes\}-/);
assert.match(actionsSource, /formatTransferDetail/);
assert.match(actionsSource, /showTaskFailure/);
assert.match(actionsSource, /taskNotificationShown/);
assert.match(actionsSource, /BB\.api\.mediaInfo\(key,\s*\{/);
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
assert.match(actionsSource, /Most recent files/);
assert.match(actionsSource, /BB\.runtime\.formatDateTimeUTC\(entry\?\.lastModified\)/);
assert.match(actionsSource, /Largest files/);
assert.match(actionsSource, /async function showPrefixInsights\(prefix, initialTab = 'overview'\)/);
assert.match(actionsSource, /folder-insights-tabs/);
assert.match(actionsSource, /folder-treemap/);
assert.match(actionsSource, /const tree = stats\?\.treemap \|\| null/);
assert.doesNotMatch(actionsSource, /Files and folders below 1% of this scope/);
assert.match(actionsSource, /function treemapChildren\(node\)/);
assert.match(actionsSource, /function squarifyTreemapNodes\(/);
assert.match(actionsSource, /function distributionEntries\(entries, field, maximum = 7\)/);
assert.match(actionsSource, /function layoutTreemapGroup\(/);
assert.match(actionsSource, /function collectTreemapRectangles\(/);
assert.match(actionsSource, /folder-treemap-details/);
assert.match(actionsSource, /function statsTypeColor\(type\)/);
assert.match(actionsSource, /updateTreemapHover/);
assert.doesNotMatch(actionsSource, /updateTreemapFocus/);
assert.doesNotMatch(actionsSource, /folder-treemap-focus/);
assert.doesNotMatch(actionsSource, /function treemapRectHTML\(/);
assert.match(actionsSource, /BB\.api\.previewPageURL\(clean/);

assert.doesNotMatch(index, /Background jobs|showJobs/);
assert.doesNotMatch(apiSource, /async jobs\(\)/);
const appSource = read('src/public/assets/js/app.js');
assert.match(appSource, /BB\.api\.previewPageURL\(row\.key, \{ instance: this\.instanceId \}\)/);
assert.doesNotMatch(appSource, /searchParams\.set\('listed'|url\.hash = hashValue\(row\.key\)/);
assert.match(appSource, /modifiedTimeMode: 'relative'/);
assert.match(appSource, /toggleModifiedTimeMode\(\)/);
assert.match(appSource, /formatDateTime_absolute\(date\)/);
assert.match(appSource, /BB\.runtime\.formatDateTimeUTC\(date\)/);
const runtimeSource = read('src/public/assets/js/common/runtime.js');
assert.match(runtimeSource, /case 'allowed': return 'Allowed'/);
assert.match(runtimeSource, /case 'denied': return 'Denied'/);
assert.match(runtimeSource, /default: return 'Checked on use'/);
assert.doesNotMatch(runtimeSource, /Available, verified|Available/);
assert.match(appSource, /stateName === 'allowed' \? 'Allowed' : \(stateName === 'denied' \? 'Denied' : 'Checked on use'\)/);
assert.doesNotMatch(appSource, /mdi-chevron-down/);
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
assert.match(appSource, /entry\.resumeToken = String\(upload\?\.resumeToken \|\| ''\)/);
assert.match(appSource, /BB\.api\.cancelUpload\(entry\.resumeToken\)/);
assert.match(appSource, /instanceId: this\.instanceId|const instanceId = this\.instanceId/);
assert.match(appSource, /basePrefix = this\.pathPrefix/);
assert.match(appSource, /BB\.api\.archiveURL\(\{/);
assert.match(appSource, /BB\.actions\.triggerBrowserDownload\(url, archiveName\)/);
assert.match(appSource, /Archive download started in the browser/);
assert.doesNotMatch(appSource, /window\.fflate\.zip\(/);
assert.match(appSource, /droppedUploadEntries/);
assert.doesNotMatch(appSource, /getAsFileSystemHandle/);
assert.match(appSource, /webkitGetAsEntry/);
assert.match(appSource, /showUploadSelectionError/);
assert.match(appSource, /positionBreadcrumbOverflow/);
assert.match(appSource, /viewport\.width - width - margin/);
assert.doesNotMatch(appSource, /window\.showDirectoryPicker/);
assert.match(appSource, /triggerUploadDir\(\)\s*\{[\s\S]*input\.click\(\)/);
assert.doesNotMatch(appSource, /Choose a folder/);
assert.match(appSource, /confirmFolderUpload\(entries/);
assert.match(appSource, /html:\s*`<div class="bb-upload-confirmation">/);
assert.doesNotMatch(appSource, /window\.alert\s*\(/);
assert.match(appSource, /uploadResolvedFiles/);
assert.match(appSource, /window\.addEventListener\('dragenter'/);
assert.match(appSource, /onPrefixDownload/);
assert.match(appSource, /async downloadArchive\(\{ archiveName, basePrefix = '', instanceId = '' \}\)/);
assert.match(appSource, /BB\.detect\.iconForType\(BB\.detect\.resolveType/);
assert.match(appSource, /storageHosts\(\) \{/);
assert.match(appSource, /host = \{ id, provider: String\(instance\.provider \|\| ''\), instances: \[\] \}/);
assert.match(appSource, /toggleStorageSwitcher\(\)/);
assert.match(appSource, /toggleHost\(host\)/);
assert.match(appSource, /breadcrumbVisibleStart/);
assert.match(appSource, /measureBreadcrumbs\(\)/);
assert.match(appSource, /const requiredWidth = start =>/);
assert.match(appSource, /const visibleCount = currentIndex - start \+ 1/);
assert.match(appSource, /const separatorCount = start > 0 \? visibleCount \+ 1 : visibleCount/);
assert.match(appSource, /while \(start > 0 && requiredWidth\(start - 1\) <= available\) start--/);
assert.match(appSource, /ResizeObserver\(\(\) => this\.scheduleBreadcrumbLayout\(\)\)/);
assert.match(appSource, /async showPermissionDetails\(\)/);
assert.match(appSource, /navigationSortAvailable/);
assert.match(appSource, /const initialDirection = field === 'name' \? 'asc' : 'desc'/);
assert.match(appSource, /navigationSortField = ''[\s\S]*navigationSortDirection = ''/);
assert.match(appSource, /left\?\.type === 'content' \? left\.size : 0/);
assert.match(appSource, /left\?\.dateModified instanceof Date \? left\.dateModified\.getTime\(\) : 0/);
assert.match(appSource, /scanComplete = data\.scanComplete === true/);
assert.match(appSource, /navigationSortAvailable = data\.sortAvailable === true/);
const indexSource = read('src/public/index.html') + read('src/frontend/app.template.html');
assert.match(indexSource, /class="modified-time-toggle"/);
assert.match(indexSource, /mdi-clock-outline/);
assert.match(indexSource, /formatDateTime_display\(row\.dateModified\)/);
assert.match(indexSource, /visiblePathContentTableData/);
assert.match(indexSource, /class="navigation-sort-icon" :class="\{ 'is-placeholder': !navigationSortAvailable \}"/);
assert.match(indexSource, /toggleNavigationSort\('size'\)/);
assert.match(indexSource, /toggleNavigationSort\('dateModified'\)/);
assert.match(cssBrowser, /\.navigation-sort-icon\s*\{[^}]*width:\s*1rem/s);
assert.match(cssBrowser, /\.navigation-sort-icon\.is-placeholder\s*\{\s*visibility:\s*hidden/s);
assert.match(actionsSource, /if \(created\.status === 'completed'\) return created\.stats \|\| \{\}/);
assert.match(index, /<button\s+type=\"button\"\s+class=\"storage-switcher-permissions\"/);
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
assert.doesNotMatch(previewHTML, /assets\/js\/bootstrap\.js/);
assert.match(previewSource, /is-scroll-contained/);
assert.match(previewSource, /contentHeight > shell\.clientHeight \+ 1/);
assert.doesNotMatch(previewSource, /BB\.api\.listAll\(/);
assert.match(previewSource, /previewURLForKey/);
assert.match(previewSource, /function renderPDF\(url, listedMetadata = null\)/);
assert.doesNotMatch(previewSource, /BB\.pdfViewer\?\.render/);
assert.match(previewSource, /new pdfjs\.PDFDataRangeTransport/);
assert.match(previewSource, /Range: `bytes=\$\{begin\}-\$\{end - 1\}`/);
assert.match(previewSource, /disableAutoFetch:\s*true/);
assert.match(previewSource, /disableStream:\s*true/);
assert.match(previewSource, /isEvalSupported:\s*false/);
assert.match(previewSource, /canvas\.className = 'pdf-page-canvas'/);
assert.match(previewSource, /wrapper\.dataset\.renderer = 'pdfjs-canvas'/);
assert.doesNotMatch(previewSource, /browser-fallback/);
assert.doesNotMatch(previewSource, /frame\.className = 'pdf-render-frame'/);
assert.match(previewSource, /searchParams\.set\('range_only', '1'\)/);
assert.doesNotMatch(previewSource, /nativeURL\.searchParams\.delete\('range_only'\)/);
assert.match(previewSource, /fetch\(rangeURL,/);
assert.doesNotMatch(read('src/public/assets/js/common/actions.js'), />Calculated</);
assert.match(read('src/public/assets/css/icons.css'), /\.mdi-arrow-up\s*\{[^}]*arrow-up\.svg/);
assert.match(read('src/public/assets/css/icons.css'), /\.mdi-arrow-down\s*\{[^}]*arrow-down\.svg/);

assert.match(read('src/app.go'), /bounded_range_required/);
assert.match(previewSource, /BB\.structuredViewers\.renderVideo/);
assert.doesNotMatch(previewSource, /media-sessions|media-probe|HLS\.js|hls\.js|FFmpeg/);
assert.match(previewSource, /Native audio playback is unavailable/);
assert.match(previewSource, /audio\.preload = 'metadata'/);
assert.match(read('src/public/assets/js/common/structured-viewers.js'), /video\.preload = 'metadata'/);
const structuredViewerSource = read('src/public/assets/js/common/structured-viewers.js');
assert.match(structuredViewerSource, /pageSizeCaption\.textContent = 'Items'/);
assert.match(structuredViewerSource, /\[100, 250, 500, 1000\]\.forEach/);
assert.match(structuredViewerSource, /let pageSize = 100/);
const archiveRenderer = structuredViewerSource.slice(structuredViewerSource.indexOf('function renderArchive'), structuredViewerSource.indexOf('function renderVideo'));
assert.doesNotMatch(archiveRenderer, /createTabs\(/);
assert.doesNotMatch(archiveRenderer, /Details|payload\.properties|propertyGrid\(/);
assert.match(archiveRenderer, /archive-preview-layout/);
assert.match(archiveRenderer, /contentsHeading\.textContent = 'Contents'/);
const archiveEntriesRenderer = structuredViewerSource.slice(structuredViewerSource.indexOf('function archiveEntries'), structuredViewerSource.indexOf('function epubPreview'));
assert.match(archiveEntriesRenderer, /document\.createElement\('colgroup'\)/);
assert.match(archiveEntriesRenderer, /archive-cell-name/);
assert.match(archiveEntriesRenderer, /archive-cell-compressed is-numeric/);
assert.match(archiveEntriesRenderer, /archive-cell-size is-numeric/);
assert.match(archiveEntriesRenderer, /nameContent\.className = 'archive-entry-name'/);
assert.match(archiveEntriesRenderer, /archive-entry-menu/);
assert.match(archiveEntriesRenderer, /className = 'bb-kebab'/);
assert.match(archiveEntriesRenderer, /BB\.api\.previewPageURL/);
assert.doesNotMatch(archiveEntriesRenderer, /archive-cell-type|archive-cell-crc|CRC32|entry\.type/);
assert.match(cssPreview, /viewer\[data-preview-type="archive"\] > \.bb-menu-constrain[\s\S]*--container-max/);
assert.match(cssPreview, /\.archive-entry-table[\s\S]*table-layout:\s*fixed/);
assert.match(cssPreview, /\.archive-entry-table \.archive-cell-compressed,[\s\S]*text-align:\s*right/);
assert.match(cssUi, /\.data-table-scroll\s*\{[^}]*width:\s*100%[^}]*scrollbar-gutter:\s*auto/s);
assert.match(cssUi, /\.bb-overlay\.bb-overlay--top-anchored/);
assert.match(cssUi, /\.bb-details--file \.bb-details-body\s*\{[^}]*height:\s*auto[^}]*min-height:\s*0/s);
assert.match(cssTreemap, /\.folder-treemap\s*\{[^}]*background:\s*none[^}]*border:\s*0[^}]*border-radius:\s*0/s);
assert.doesNotMatch(cssTreemap, /has-no-header/);
assert.match(cssTreemap, /\.folder-treemap-node\.is-folder > \.folder-treemap-label\s*\{[^}]*background:\s*none/s);
assert.match(cssTreemap, /\.folder-treemap-node\.is-other > \.folder-treemap-label\s*\{[^}]*background:\s*none/s);
assert.match(cssPreview, /\.archive-entry-scroll\s*\{[^}]*max-height:\s*none[^}]*overflow-x:\s*auto/s);
assert.match(cssPreview, /\.viewer\.is-certificate-preview > \.bb-menu-constrain\s*\{[^}]*max-width:\s*var\(--container-max\)/s);
assert.match(cssPreview, /\.viewer\.is-certificate-preview \.structured-preview-host\s*\{[^}]*padding:\s*0/s);
assert.match(previewSource, /setPreviewMode\(previewMode, type\)/);
assert.match(previewSource, /renderWordDocument/);
assert.match(previewSource, /BB\.api\.wordPreview\(\{ key, size, etag/);
assert.doesNotMatch(previewSource, /mammoth|cdn\.jsdelivr|unpkg/i);
assert.match(previewSource, /BB\.jsonViewer\.render/);
assert.match(previewSource, /BB\.sqliteViewer\.render/);
assert.match(previewSource, /openDocumentSearch/);
assert.match(previewSource, /String\(event\.key\)\.toLowerCase\(\) !== 'f'/);
assert.match(previewSource, /raw-image' \|\| type === 'image-convert/);
assert.match(previewSource, /document\.documentElement\.classList\.toggle\('is-viewport-image'/);
assert.match(previewSource, /return String\(new URLSearchParams\(location\.search\)\.get\('path'\) \|\| ''\)/);
assert.match(previewSource, /await BB\.api\.archiveEntryHead\(key, archiveEntry/);
assert.match(previewSource, /: await BB\.api\.head\(key, version, config\.instanceId\)/);
assert.doesNotMatch(previewSource, /listedObjectMetadata|location\.hash/);
assert.match(previewSource, /if \(type === 'tabular'\) \{[\s\S]*searchRawDocument\(key, query\)/);
assert.match(previewSource, /type === 'sqlite'/);
assert.doesNotMatch(previewSource, /contentNeedsViewport/);

assert.match(cssPreview, /\.pdf-custom-preview\s*\{[\s\S]*grid-template-rows:[^}]*gap:\s*0/s);
assert.match(cssPreview, /\.pdf-custom-error\s*\{[\s\S]*position:\s*absolute[\s\S]*z-index:\s*7/s);
assert.match(cssPreview, /\.pdf-custom-preview:fullscreen\s*\{[\s\S]*height:\s*100vh/s);
assert.match(read('src/app.go'), /object-src 'none'/);
assert.doesNotMatch(appCSS, /\.pdf-toolbar-shell|\.pdf-toolbar\s*\{|\.pdf-page-stage|\.pdf-custom-fallback/);
assert.match(cssPreview, /\.viewer\[data-preview-type="word"\] > \.bb-menu-constrain\s*\{[^}]*max-width:\s*var\(--container-max\)/s);
assert.match(cssPreview, /\.sqlite-preview \.data-table-scroll\s*\{[\s\S]*overflow-y:\s*visible/s);

const renderSource = read('src/public/assets/js/common/render.js');
assert.doesNotMatch(renderSource, /mermaid@|cdn\.jsdelivr|unpkg/i);
assert.match(renderSource, /if \(window\.mermaid\) return Promise\.resolve\(window\.mermaid\)/);
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
assert.match(index, /is-pagination-placeholder/);
assert.doesNotMatch(index, /v-if="hasPagination"/);
assert.match(index, /formatByteParts\(row\.size\)/);
assert.match(tabularSource, /data-preview-pagination\$\{paginationNeeded \? '' : ' is-pagination-placeholder'\}/);
assert.match(cssBrowser, /\.object-size\s*\{[\s\S]*grid-template-columns:\s*7ch 2\.5ch[\s\S]*font-variant-numeric:\s*tabular-nums/s);
assert.match(cssBrowser, /\.modified-column-header/);
assert.match(iconsCSS, /\.mdi-loading::before[\s\S]*border-top-color:\s*currentColor[\s\S]*animation:\s*bb-spin/s);
assert.match(detectSource, /jsx:\s*'JavaScript XML'/);
assert.match(detectSource, /tsx:\s*'TypeScript XML'/);
assert.match(detectSource, /python:\s*'Python'/);
assert.match(tabularSource, /PAGE_SIZE_OPTIONS = \[100, 250, 500, 1000\]/);
assert.match(tabularSource, /createRemoteDelimitedTable/);
assert.match(tabularSource, /BB\.api\.delimitedPage/);
assert.match(tabularSource, /BB\.api\.documentCount/);
assert.match(tabularSource, /Use Count rows to scan the complete document/);
assert.match(tabularSource, /extension === 'tsv' \|\| extension === 'tab'/);
assert.match(tabularSource, /previousScrollLeft/);
assert.match(tabularSource, /scrollLeft = previousScrollLeft/);
assert.doesNotMatch(tabularSource, /xlsx-0\.20\.3|xlsx\.full\.min|cdn\.jsdelivr|unpkg/i);
assert.match(tabularSource, /Conversion required/);
assert.match(tabularSource, /renderSpreadsheet/);
assert.match(tabularSource, /renderRemoteSpreadsheet/);
assert.match(tabularSource, /BB\.api\.spreadsheet/);
assert.match(tabularSource, /if \(descriptors\.length < 2\) return null/);
assert.match(tabularSource, /createSpreadsheetSheetControls/);
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
assert.match(tabularSource, /BB\.api\.parquetPreview/);
assert.match(tabularSource, /reads the Parquet footer, not the rows/);
assert.doesNotMatch(tabularSource, /hyparquet|cdn\.jsdelivr|unpkg/i);


console.log('frontend smoke tests passed');
