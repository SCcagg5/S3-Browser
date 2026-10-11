'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const index = read('src/public/index.html') + read('src/frontend/app.template.html');
const previewHTML = read('src/public/preview.html');
const app = read('src/public/assets/js/app.js');
const preview = read('src/public/assets/js/preview.js');
const actions = read('src/public/assets/js/common/actions.js');
const runtime = read('src/public/assets/js/common/runtime.js');
const menu = read('src/public/assets/js/common/menu.js');
const tabular = read('src/public/assets/js/common/tabular.js');
const iconsCSS = read('src/public/assets/css/icons.css');
const tokensCSS = read('src/public/assets/css/tokens.css');
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
const uiJS = read('src/public/assets/js/common/ui.js');

// Every statically referenced MDI icon except the CSS-ring loader must have a local SVG mask.
const iconSources = [];
const visitIconSources = target => {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const absolute = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') visitIconSources(absolute);
    } else if (/\.(?:html|js)$/.test(entry.name)) {
      iconSources.push(fs.readFileSync(absolute, 'utf8'));
    }
  }
};
visitIconSources(path.join(root, 'src/public'));
const usedIcons = new Set();
for (const source of iconSources) {
  for (const match of source.matchAll(/mdi-([a-z0-9-]+)/g)) {
    if (['spin', 'set', 'loading'].includes(match[1])) continue;
    usedIcons.add(match[1]);
  }
}
for (const icon of usedIcons) {
  const svg = path.join(root, 'src/public/assets/icons/mdi', `${icon}.svg`);
  assert.equal(fs.existsSync(svg), true, `missing local MDI SVG: ${icon}`);
  assert.match(iconsCSS, new RegExp(`\\.mdi-${icon.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\{[^}]*${icon}\\.svg`), `missing CSS mask for ${icon}`);
}

// Initial header and toolbar masks are fetched before Vue removes v-cloak.
const initialShellIcons = [
  'source-commit',
  'database-outline',
  'eye-outline',
  'pencil-outline',
  'delete-outline',
  'magnify',
  'refresh',
  'cogs',
  'plus',
  'chevron-down'
];
for (const icon of initialShellIcons) {
  assert.ok(index.includes(`<link rel="preload" as="image" type="image/svg+xml" crossorigin="anonymous" href="assets/icons/mdi/${icon}.svg" fetchpriority="high" data-bb-initial-icon />`), `missing initial icon preload: ${icon}`);
}
assert.match(app, /function preloadInitialShellIcons\(\)/);
assert.match(app, /document\.querySelectorAll\('link\[data-bb-initial-icon\]'\)/);
assert.match(app, /Promise\.race\(\[preloadInitialShellIcons\(\), iconWaitLimit\]\)\.then\(mountBrowser, mountBrowser\)/);
assert.doesNotMatch(app, /app\.use\(Buefy\.default[^;]+;\s*app\.mount\('#root'\)/);

// Downward disclosures have one implementation: the interaction-layer mask.
for (const source of [index, previewHTML, app, preview, actions]) {
  assert.doesNotMatch(source, /mdi-chevron-down/, 'downward disclosures must not use an icon element');
}
assert.match(cssUi, /\.select:not\(\.is-multiple\):not\(\.is-loading\)::after,\s*\n\.has-bb-chevron::after\s*\{/);
assert.match(cssPreview, /chevron-down\.svg/);
assert.ok((appCSS.match(/\.has-bb-chevron::after/g) || []).length >= 1);
assert.match(index, /storage-switcher-trigger has-bb-chevron/);
assert.match(index, /class="btn has-bb-chevron bb-menu-trigger"[^>]*>\s*<i class="mdi mdi-cogs"/);
assert.match(index, /class="btn btn-primary has-bb-chevron bb-menu-trigger"[^>]*>\s*<i class="mdi mdi-plus"/);

// The modal close button keeps its dedicated contract and is excluded from shared controls.
assert.match(cssUi, /\.btn\s*\{[^}]*min-height:\s*var\(--control-height-md\)/s);
assert.doesNotMatch(appCSS, /\.bb-btn|\.icon-btn|\.data-tool-button/);
assert.match(cssUi, /\.bb-modal-html > \.bb-modal-x\s*\{[^}]*position:\s*absolute[^}]*top:\s*-\.55rem[^}]*right:\s*-\.55rem[^}]*width:\s*2\.25rem[^}]*height:\s*2\.25rem/s);
assert.match(cssUi, /\.bb-modal-x:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--color-danger\)[^}]*background:\s*transparent/s);

// Context-menu geometry is the single dropdown surface contract.
assert.match(cssUi, /\.bb-menu-item,\s*\.breadcrumb-overflow-item\s*\{[^}]*min-height:\s*var\(--control-height-md\)/s);
assert.match(cssBrowser, /border-radius:\s*var\(--radius-sm\)/);
assert.match(cssBrowser, /background:\s*var\(--color-bg-hover\)/);

// One original sheet-tab visual is reused everywhere; no second DataGrid override.
assert.match(cssUi, /\.spreadsheet-tab\s*\{[^}]*height:\s*var\(--control-height-sm\)[^}]*background:\s*var\(--color-bg-subtle\)[^}]*border-radius:\s*var\(--radius-md\) var\(--radius-md\) 0 0/s);
assert.match(cssUi, /\.spreadsheet-tab\.is-active\s*\{[^}]*background:\s*var\(--color-bg-panel\)[^}]*box-shadow:\s*inset 0 -2px 0 var\(--color-primary\)/s);
assert.doesNotMatch(cssRead('browser'), /\.spreadsheet-tab\s*\{/);
assert.doesNotMatch(appCSS, /\.folder-insights-tabs \.spreadsheet-tab/);

// Permission results stay compact and neutral while unknown.
assert.match(runtime, /default: return 'Checked on use'/);
assert.match(app, /stateName === 'denied' \? 'Denied' : 'Checked on use'/);
assert.doesNotMatch(app, /Available, verified when used/);
assert.match(cssBrowser, /\.bb-permission-result\s*\{[^}]*white-space:\s*nowrap/s);
assert.match(cssBrowser, /\.bb-permission-result\.is-unknown\s*\{[^}]*background:\s*var\(--color-bg-inset\)[^}]*border-color:\s*var\(--color-border-strong\)/s);
assert.match(cssBrowser, /\.bb-permission-summary-icon\.is-allowed\s*\{[^}]*color:\s*var\(--color-primary/);
assert.doesNotMatch(cssRead('preview'), /\.bb-permission-summary(?:-row|-icon|-copy)?\s*\{/);
assert.doesNotMatch(cssRead('ui'), /\.bb-permission-summary(?:-row|-icon|-copy)?/);

// The 1% threshold is global to the selected scope and the layout is squarified.
assert.match(actions, /const tree = stats\?\.treemap \|\| null/);
assert.doesNotMatch(actions, /Files and folders below 1% of this scope/);
assert.match(actions, /function treemapChildren\(node\)/);
assert.match(actions, /function squarifyTreemapNodes\(/);
assert.match(actions, /function layoutTreemapNodes\(/);
assert.match(actions, /treemapOtherInlineMinimumHeightPixels = 26/);
assert.match(actions, /treemapOtherStackedMinimumHeightPixels = 34/);
assert.match(actions, /treemapOtherInlineMinimumWidthPixels = 180/);
assert.match(actions, /function treemapOtherReadableHeight\(width\)/);
assert.match(actions, /treemapMinimumRegularPixels = 30/);
assert.match(actions, /treemapFolderHeaderPixels = 26/);
assert.match(actions, /treemapBranchInsetPixels = 2/);
assert.match(actions, /smallest horizontal strip required/);
assert.doesNotMatch(actions, /useVerticalStrip|treemapOtherMinimumWidthPixels/);
assert.doesNotMatch(actions, /function treemapBorderColor\(depth\)/);
assert.doesNotMatch(actions, /function treemapColorIndex\(node\)/);
assert.match(actions, /function statsTypeColor\(type\)/);
assert.match(actions, /updateTreemapHover/);
assert.doesNotMatch(actions, /updateTreemapFocus/);
assert.doesNotMatch(cssRead('ui') + cssRead('browser') + cssRead('preview'), /\.folder-treemap/);
assert.match(cssTreemap, /background:\s*none/);
assert.match(cssTreemap, /\.folder-treemap\s*\{[^}]*background:\s*none[^}]*border:\s*0[^}]*border-radius:\s*0/s);
assert.match(cssTreemap, /\.folder-treemap-node\s*\{[^}]*border-radius:\s*2px/s);
assert.match(cssTreemap, /\.folder-treemap-node\.is-folder\s*\{[^}]*background:\s*var\(--color-bg-subtle\)[^}]*border:\s*1px solid var\(--color-border-strong\)[^}]*border-radius:\s*2px/s);
assert.match(cssTreemap, /\.folder-treemap-tooltip\s*\{[^}]*pointer-events:\s*none/s);
assert.match(cssTreemap, /\.folder-treemap-tooltip\s*\{[^}]*color:\s*var\(--color-text[^}]*background:\s*var\(--color-bg-panel[^}]*border:\s*1px solid var\(--color-border/s);
assert.match(cssTreemap, /\.folder-treemap-node\.is-folder\.is-branch > \.folder-treemap-label\s*\{[^}]*grid-template-rows:\s*\.75rem \.625rem[^}]*gap:\s*0/s);
assert.match(cssTreemap, /\.folder-treemap-node\.is-hovered/);
assert.doesNotMatch(cssTreemap, /z-index:\s*1200/);
assert.doesNotMatch(cssTreemap, /\.folder-treemap-focus/);
assert.match(cssTreemap, /\.folder-treemap-label\s*\{[^}]*justify-content:\s*flex-start/s);
assert.doesNotMatch(cssTreemap, /justify-content:\s*center/);
assert.doesNotMatch(actions, /has-no-header/);
assert.match(actions, /const labelName = node\.name \|\| \(kind === 'folder' \? 'Folder' : 'Unnamed'\)/);
assert.match(actions, /const canExpandFolder = isFolder[\s\S]*drawWidth >= 80[\s\S]*drawHeight >= 84/);

// PDF uses a custom canvas viewer with strict byte ranges and no browser-plugin fallback.
assert.match(preview, /function renderPDF\(url, listedMetadata = null\)/);
assert.match(preview, /PDFJS_VERSION = '4\.10\.38'/);
assert.match(preview, /The local PDF\.js renderer is missing from this build/);
assert.doesNotMatch(preview, /PDFJS_CANVAS_BUNDLE_ENABLED = false/);
assert.match(preview, /PDF previews are rendered only through the local canvas renderer/);
assert.match(preview, /new pdfjs\.PDFDataRangeTransport/);
assert.match(preview, /Range: `bytes=\$\{begin\}-\$\{end - 1\}`/);
assert.match(preview, /disableAutoFetch:\s*true/);
assert.match(preview, /disableStream:\s*true/);
assert.match(preview, /isEvalSupported:\s*false/);
assert.match(preview, /canvas\.className = 'pdf-page-canvas'/);
assert.doesNotMatch(preview, /BB\.pdfViewer\?\.render/);
assert.doesNotMatch(preview, /root: wrapper/);
assert.match(preview, /wrapper\.dataset\.renderer = 'pdfjs-canvas'/);
assert.doesNotMatch(preview, /browser-fallback/);
assert.match(preview, /searchParams\.set\('range_only', '1'\)/);
assert.doesNotMatch(preview + cssPreview, /pdf-custom-status|Still loading page/);
assert.match(cssPreview, /\.pdf-custom-preview:fullscreen\s*\{[^}]*height:\s*100vh/s);
assert.match(cssPreview, /\.viewer\[data-preview-type="word"\] > \.bb-menu-constrain\s*\{[^}]*max-width:\s*var\(--container-max\)/s);
assert.match(cssPreview, /\.word-document\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
assert.match(iconsCSS, /\.mdi-loading::before[\s\S]*border-top-color:\s*currentColor[\s\S]*animation:\s*bb-spin/s);
assert.match(cssBrowser, /\.modified-column-header[\s\S]*var\(--col-modified\)/s);
assert.match(cssBrowser, /--col-size:/);
assert.match(cssBrowser, /--col-modified:/);
assert.match(cssBrowser, /\.navigation-sort-icon\s*\{[^}]*width:\s*1rem[^}]*height:\s*1rem/s);
assert.match(cssBrowser, /\.modified-time-toggle\s*\{[^}]*background:\s*transparent[^}]*border:\s*0/s);
assert.match(cssBrowser, /\.modified-time-toggle:hover,\s*\.modified-time-toggle\.is-absolute\s*\{[^}]*color:\s*var\(--color-primary\)/s);
// The interface renders at true size: no body zoom and no viewport compensation.
assert.doesNotMatch(tokensCSS, /zoom\s*:/);
assert.doesNotMatch(tokensCSS, /body:not\(\.preview-page\)/);
assert.doesNotMatch(tokensCSS, /html \{ font-size:\s*80%/);
for (const css of [tokensCSS, appCSS]) {
  assert.doesNotMatch(css, /--browser-ui-scale/);
  assert.doesNotMatch(css, /(?:^|[;{\s])zoom\s*:/);
  assert.doesNotMatch(css, /\.calc\(/);
}
assert.doesNotMatch(runtime, /BB\.viewport|interfaceScale|toLayoutPixels|layoutRect/);
for (const source of [menu, app, preview, actions, tabular]) assert.doesNotMatch(source, /BB\.viewport/);
assert.doesNotMatch(index, /<b-dropdown[^>]*append-to-body[^>]*>\s*<template #trigger>\s*<b-button[^>]*icon-left="cogs"/s);
assert.doesNotMatch(index, /<b-dropdown[^>]*append-to-body[^>]*>\s*<template #trigger>\s*<b-button[^>]*icon-left="plus"/s);
assert.match(cssBrowser, /\.modified-header-controls\s*\{[^}]*display:\s*flex[^}]*gap:\s*var\(--space-2\)/s);
assert.match(cssBrowser, /\.modified-time-toggle\s*\{[^}]*padding:\s*0[^}]*background:\s*transparent[^}]*border:\s*0/s);
assert.match(runtime, /function formatDateTimeUTC\(value\)/);
assert.match(cssPreview, /Final PDF viewport contract/);
assert.match(cssPreview, /height:\s*100dvh/);
assert.match(cssPreview, /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
assert.doesNotMatch(index, /label="Size" width=/);
assert.doesNotMatch(index, /label="Last modified" width=/);
assert.match(cssBrowser, /--col-modified:\s*13rem/);
assert.match(cssBrowser, /\.browser-card \.table thead th\s*\{[^}]*white-space:\s*nowrap/s);
assert.doesNotMatch(index, /th-wrap/);
assert.match(cssUi, /\.bb-details-body > \.bb-details-section\s*\{[^}]*padding-bottom:/s);
assert.match(iconsCSS, /\.mdi-arrow-up\s*\{[^}]*arrow-up\.svg/);
assert.match(iconsCSS, /\.mdi-arrow-down\s*\{[^}]*arrow-down\.svg/);
assert.equal(fs.existsSync(path.join(root, 'src/public/assets/icons/mdi/arrow-up.svg')), true);
assert.equal(fs.existsSync(path.join(root, 'src/public/assets/icons/mdi/arrow-down.svg')), true);
assert.doesNotMatch(actions, />Calculated</);
assert.match(actions, /button\.hidden = true;[\s\S]*button\.remove\(\)/);
assert.doesNotMatch(preview, /nativeURL\.searchParams\.delete\('range_only'\)/);
assert.match(preview, /const rangeURL = boundedURL\.href/);
assert.match(preview, /fetch\(rangeURL,/);


// Modal overlays sit below the old centered Insights position while sharing one top edge.
assert.match(cssUi, /--bb-modal-top-offset:\s*clamp\(1\.5rem, 7vh, 5rem\)/);
assert.match(cssUi, /padding:\s*var\(--bb-modal-top-offset\) var\(--space-4\) var\(--space-4\)/);
assert.match(cssUi, /bb-modal--details,[\s\S]*bb-modal--insights/);

// Opening any modal locks both scrolling elements, including nested overlays.
assert.match(cssUi, /html\.bb-no-scroll,[\s\S]*body\.bb-no-scroll\s*\{[^}]*overflow:\s*hidden !important[^}]*overscroll-behavior:\s*none[^}]*scrollbar-gutter:\s*auto !important/);
assert.match(cssUi, /\.bb-overlay\s*\{[^}]*overscroll-behavior:\s*contain/s);
assert.match(uiJS, /let scrollLockDepth = 0/);
assert.match(uiJS, /document\.documentElement/);
assert.match(uiJS, /root\.classList\.add\('bb-no-scroll'\)/);
assert.match(uiJS, /body\.classList\.add\('bb-no-scroll'\)/);
assert.match(uiJS, /if \(scrollLockDepth > 0\) return/);
assert.match(uiJS, /window\.scrollTo\(previous\.scrollX, previous\.scrollY\)/);
assert.match(uiJS, /window\.innerWidth[\s\S]*root\.clientWidth/);
assert.doesNotMatch(uiJS, /BB\.viewport/);
assert.match(uiJS, /body\.style\.paddingRight = `\$\{computedBodyPaddingRight \+ scrollbarWidth\}px`/);
assert.match(uiJS, /root\.style\.scrollbarGutter = 'auto'/);
assert.match(uiJS, /body\.style\.paddingRight = previous\?\.bodyPaddingRight \|\| ''/);
assert.match(cssUi, /bb-overlay\.bb-overlay--top-anchored[\s\S]*overflow:\s*hidden[\s\S]*scrollbar-gutter:\s*auto/);

// Each page loads its own layer last, after the shared layers.
assert.ok(index.indexOf('assets/css/browser.css') > index.indexOf('assets/css/ui.css'));
assert.ok(previewHTML.indexOf('assets/css/preview.css') > previewHTML.indexOf('assets/css/ui.css'));
assert.doesNotMatch(index, /assets\/css\/(preview|viewers|style|interaction)\.css/);
assert.doesNotMatch(previewHTML, /assets\/css\/(browser|treemap)\.css/);

console.log(`UI normalization tests passed (${usedIcons.size} local icons checked)`);
