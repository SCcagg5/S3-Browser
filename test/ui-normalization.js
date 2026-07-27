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
const actions = read('src/public/assets/js/common/actions.js');
const runtime = read('src/public/assets/js/common/runtime.js');
const menu = read('src/public/assets/js/common/menu.js');
const tabular = read('src/public/assets/js/common/tabular.js');
const iconsCSS = read('src/public/assets/css/icons.css');
const tokensCSS = read('src/public/assets/css/tokens.css');
const componentsCSS = read('src/public/assets/css/components.css');
const dataGridCSS = read('src/public/assets/css/data-grid.css');
const interactionCSS = read('src/public/assets/css/interaction.css');
const styleCSS = read('src/public/assets/css/style.css');
const uiCSS = read('src/public/assets/css/ui.css');
const uiJS = read('src/public/assets/js/common/ui.js');
const treemapCSS = read('src/public/assets/css/treemap.css');
const viewersCSS = read('src/public/assets/css/viewers.css');

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
  assert.ok(index.includes(`<link rel="preload" as="image" type="image/svg+xml" href="assets/icons/mdi/${icon}.svg" fetchpriority="high" data-bb-initial-icon />`), `missing initial icon preload: ${icon}`);
}
assert.match(app, /function preloadInitialShellIcons\(\)/);
assert.match(app, /document\.querySelectorAll\('link\[data-bb-initial-icon\]'\)/);
assert.match(app, /Promise\.race\(\[preloadInitialShellIcons\(\), iconWaitLimit\]\)\.then\(mountBrowser, mountBrowser\)/);
assert.doesNotMatch(app, /app\.use\(Buefy\.default[^;]+;\s*app\.mount\('#root'\)/);

// Downward disclosures have one implementation: the interaction-layer mask.
for (const source of [index, previewHTML, app, preview, actions]) {
  assert.doesNotMatch(source, /mdi-chevron-down/, 'downward disclosures must not use an icon element');
}
assert.match(interactionCSS, /\.select:not\(\.is-multiple\):not\(\.is-loading\)::after,\s*\n\.has-bb-chevron::after\s*\{/);
assert.match(interactionCSS, /chevron-down\.svg/);
assert.equal((interactionCSS.match(/\.has-bb-chevron::after/g) || []).length, 3);
assert.match(index, /storage-switcher-trigger has-bb-chevron/);
assert.match(index, /class="has-bb-chevron" icon-pack="mdi" icon-left="cogs"/);
assert.match(index, /class="has-bb-chevron" icon-pack="mdi" icon-left="plus"/);

// The modal close button keeps its dedicated contract and is excluded from shared controls.
assert.match(componentsCSS, /\.bb-btn:not\(\.bb-modal-x\)/);
assert.match(uiCSS, /\.bb-modal-html > \.bb-modal-x\s*\{[^}]*position:\s*absolute[^}]*top:\s*-\.55rem[^}]*right:\s*-\.55rem[^}]*width:\s*2\.25rem[^}]*height:\s*2\.25rem/s);
assert.match(uiCSS, /\.bb-modal-x:hover\s*\{[^}]*color:\s*red[^}]*background-color:\s*transparent !important/s);
const interactionRules = interactionCSS.replace(/\/\*[\s\S]*?\*\//g, '');
assert.doesNotMatch(interactionRules, /bb-modal-x/);

// Context-menu geometry is the single dropdown surface contract.
assert.match(interactionCSS, /\.bb-menu-popover,\s*\n\.dropdown-content,\s*\n\.breadcrumb-overflow-popover\s*\{/);
assert.match(interactionCSS, /\.bb-menu-item,\s*\n\.dropdown-item,/);
assert.match(interactionCSS, /min-height:\s*34px/);
assert.match(interactionCSS, /border-radius:\s*6px/);
assert.match(interactionCSS, /background:\s*#f3f4f6/);

// One original sheet-tab visual is reused everywhere; no second DataGrid override.
assert.match(styleCSS, /\.spreadsheet-tab\s*\{[^}]*height:\s*34px[^}]*background:\s*#f8fafc[^}]*border-radius:\s*7px 7px 0 0/s);
assert.match(styleCSS, /\.spreadsheet-tab\.is-active\s*\{[^}]*background:\s*#fff[^}]*box-shadow:\s*inset 0 -2px 0 var\(--primary-color\)/s);
assert.doesNotMatch(dataGridCSS, /\.spreadsheet-tab\s*\{/);
assert.doesNotMatch(interactionCSS, /\.spreadsheet-tab\s*\{/);
assert.doesNotMatch(uiCSS, /\.folder-insights-tabs \.spreadsheet-tab/);

// Permission results stay compact and neutral while unknown.
assert.match(runtime, /default: return 'On use'/);
assert.match(app, /stateName === 'denied' \? 'Denied' : 'On use'/);
assert.doesNotMatch(app, /Available, verified when used/);
assert.match(interactionCSS, /\.bb-permission-result\s*\{[^}]*white-space:\s*nowrap/s);
assert.match(interactionCSS, /\.bb-permission-result\.is-unknown\s*\{[^}]*background:\s*#f2f4f7[^}]*border-color:\s*#d0d5dd/s);
assert.match(interactionCSS, /\.bb-permission-summary-icon\.is-allowed\s*\{[^}]*color:\s*var\(--primary-color/);
assert.doesNotMatch(styleCSS, /\.bb-permission-summary(?:-row|-icon|-copy)?\s*\{/);
assert.doesNotMatch(componentsCSS, /\.bb-permission-summary(?:-row|-icon|-copy)?/);

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
assert.doesNotMatch(uiCSS, /\.folder-treemap/);
assert.doesNotMatch(interactionCSS, /\.folder-treemap/);
assert.match(treemapCSS, /background:\s*none/);
assert.match(treemapCSS, /\.folder-treemap\s*\{[^}]*background:\s*none[^}]*border:\s*0[^}]*border-radius:\s*0/s);
assert.match(treemapCSS, /\.folder-treemap-node\s*\{[^}]*border-radius:\s*2px/s);
assert.match(treemapCSS, /\.folder-treemap-node\.is-folder\s*\{[^}]*background:\s*#f8fafc[^}]*border:\s*1px solid #c7d0dc[^}]*border-radius:\s*2px/s);
assert.match(treemapCSS, /\.folder-treemap-tooltip\s*\{[^}]*pointer-events:\s*none/s);
assert.match(treemapCSS, /\.folder-treemap-tooltip\s*\{[^}]*color:\s*var\(--color-text[^}]*background:\s*var\(--color-bg-panel[^}]*border:\s*1px solid var\(--color-border/s);
assert.match(treemapCSS, /\.folder-treemap-node\.is-folder\.is-branch > \.folder-treemap-label\s*\{[^}]*grid-template-rows:\s*12px 10px[^}]*gap:\s*0/s);
assert.match(treemapCSS, /\.folder-treemap-node\.is-hovered/);
assert.doesNotMatch(treemapCSS, /z-index:\s*1200/);
assert.doesNotMatch(treemapCSS, /\.folder-treemap-focus/);
assert.match(treemapCSS, /\.folder-treemap-label\s*\{[^}]*justify-content:\s*flex-start/s);
assert.doesNotMatch(treemapCSS, /justify-content:\s*center/);
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
assert.doesNotMatch(preview + viewersCSS, /pdf-custom-status|Still loading page/);
assert.match(viewersCSS, /\.pdf-custom-preview:fullscreen\s*\{[^}]*height:\s*calc\(100vh \/ var\(--browser-ui-scale-active\)\)/s);
assert.match(viewersCSS, /\.viewer\[data-preview-type="word"\] > \.bb-menu-constrain\s*\{[^}]*max-width:\s*var\(--browser-container-max\)/s);
assert.match(viewersCSS, /\.word-document\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
assert.match(interactionCSS, /\.mdi-loading::before[\s\S]*border-top-color:\s*currentColor[\s\S]*animation:\s*bb-loader-spin/s);
assert.match(interactionCSS, /modified-column-header[\s\S]*navigation-meta-right-pad/s);
assert.match(interactionCSS, /--navigation-size-column:\s*clamp/);
assert.match(interactionCSS, /--navigation-modified-column:\s*clamp/);
assert.match(interactionCSS, /\.navigation-sort-icon \.mdi\s*\{[^}]*translateY\(1\.5px\)/s);
assert.match(interactionCSS, /\.modified-time-toggle\s*\{[^}]*background:\s*transparent[^}]*border:\s*0[^}]*border-radius:\s*0/s);
assert.match(interactionCSS, /\.modified-time-toggle:hover,[\s\S]*background:\s*transparent[\s\S]*border:\s*0/s);
assert.match(tokensCSS, /--browser-ui-scale:\s*\.8/);
assert.match(tokensCSS, /--browser-ui-scale-active:\s*1/);
assert.match(tokensCSS, /:root\s*\{[^}]*--browser-ui-scale-active:\s*var\(--browser-ui-scale\)/s);
assert.match(tokensCSS, /body\s*\{[^}]*zoom:\s*var\(--browser-ui-scale-active\)/s);
assert.doesNotMatch(tokensCSS, /body:not\(\.preview-page\)/);
assert.doesNotMatch(tokensCSS, /html \{ font-size:\s*80%/);
for (const css of [styleCSS, uiCSS, viewersCSS, interactionCSS]) {
  const uncompensated = css.replace(/calc\((?:\d+(?:\.\d+)?|\.\d+)(?:dvh|svh|lvh|vh|vw) \/ var\(--browser-ui-scale-active\)\)/g, '');
  assert.doesNotMatch(uncompensated, /(?:^|[^a-z0-9.-])(?:\d+(?:\.\d+)?|\.\d+)(?:dvh|svh|lvh|vh|vw)\b/i);
  assert.doesNotMatch(css, /\.calc\(/);
}
assert.match(runtime, /function interfaceScale\(\)/);
assert.match(runtime, /function toLayoutPixels\(value\)/);
assert.match(runtime, /function layoutRect\(target\)/);
assert.match(runtime, /function layoutViewport\(\)/);
assert.match(runtime, /BB\.viewport = \{/);
assert.match(menu, /BB\.viewport\?\.rect\(icon\)/);
assert.match(menu, /BB\.viewport\?\.toLayoutPixels\(anchorPoint\.x\)/);
assert.match(app, /const viewport = BB\.viewport\?\.size\(\)/);
assert.match(preview, /BB\.viewport\?\.rect\(bar\)/);
assert.match(actions, /BB\.viewport\?\.rect\(map\)/);
assert.match(tabular, /BB\.viewport\?\.toLayoutPixels\(event\.clientX\)/);
assert.doesNotMatch(index, /<b-dropdown[^>]*append-to-body[^>]*>\s*<template #trigger>\s*<b-button[^>]*icon-left="cogs"/s);
assert.doesNotMatch(index, /<b-dropdown[^>]*append-to-body[^>]*>\s*<template #trigger>\s*<b-button[^>]*icon-left="plus"/s);
assert.match(interactionCSS, /\.modified-header-controls\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*1\.5rem minmax\(max-content, 1fr\)[^}]*column-gap:\s*\.5rem/s);
assert.match(interactionCSS, /\.modified-time-toggle\s*\{[^}]*margin:\s*0[^}]*background:\s*transparent[^}]*border:\s*0/s);
assert.match(runtime, /function formatDateTimeUTC\(value\)/);
assert.match(interactionCSS, /Final PDF viewport contract/);
assert.match(interactionCSS, /height:\s*calc\(100dvh \/ var\(--browser-ui-scale-active\)\) !important/);
assert.match(interactionCSS, /grid-template-rows:\s*auto minmax\(0, 1fr\) !important/);
assert.doesNotMatch(index, /label="Size" width=/);
assert.doesNotMatch(index, /label="Last modified" width=/);
assert.match(interactionCSS, /--navigation-modified-column:\s*clamp\(11\.75rem, calc\(15vw \/ var\(--browser-ui-scale-active\)\), 13\.25rem\)/);
assert.match(interactionCSS, /\.modified-header-controls \.navigation-sort-button > span:first-child\s*\{[^}]*min-width:\s*max-content[^}]*overflow:\s*visible/s);
assert.match(interactionCSS, /th\.modified-column-header \.th-wrap\s*\{[^}]*padding-right:\s*0 !important/s);
assert.match(uiCSS, /\.bb-details-body > \.bb-details-section\s*\{[^}]*padding-bottom:/s);
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
assert.match(interactionCSS, /--bb-modal-top-offset:\s*clamp\(2rem, calc\(15vh \/ var\(--browser-ui-scale-active\)\), 11rem\)/);
assert.match(interactionCSS, /padding:\s*var\(--bb-modal-top-offset\) 1rem 1rem/);
assert.match(interactionCSS, /bb-modal--details,[\s\S]*bb-modal--insights/);

// Opening any modal locks both scrolling elements, including nested overlays.
assert.match(uiCSS, /html\.bb-no-scroll,[\s\S]*body\.bb-no-scroll\s*\{[^}]*overflow:\s*hidden !important[^}]*overscroll-behavior:\s*none[^}]*scrollbar-gutter:\s*auto !important/);
assert.match(uiCSS, /\.bb-overlay\s*\{[^}]*overscroll-behavior:\s*contain/s);
assert.match(uiJS, /let scrollLockDepth = 0/);
assert.match(uiJS, /document\.documentElement/);
assert.match(uiJS, /root\.classList\.add\('bb-no-scroll'\)/);
assert.match(uiJS, /body\.classList\.add\('bb-no-scroll'\)/);
assert.match(uiJS, /if \(scrollLockDepth > 0\) return/);
assert.match(uiJS, /window\.scrollTo\(previous\.scrollX, previous\.scrollY\)/);
assert.match(uiJS, /window\.innerWidth[\s\S]*root\.clientWidth/);
assert.match(uiJS, /BB\.viewport\?\.toLayoutPixels/);
assert.match(uiJS, /body\.style\.paddingRight = `\$\{computedBodyPaddingRight \+ layoutScrollbarWidth\}px`/);
assert.match(uiJS, /root\.style\.scrollbarGutter = 'auto'/);
assert.match(uiJS, /body\.style\.paddingRight = previous\?\.bodyPaddingRight \|\| ''/);
assert.match(interactionCSS, /bb-overlay\.bb-overlay--top-anchored[\s\S]*overflow:\s*hidden[\s\S]*scrollbar-gutter:\s*auto/);

// The final interaction layer is loaded after all other component CSS.
for (const html of [index, previewHTML]) {
  const interaction = html.indexOf('assets/css/interaction.css');
  assert.ok(interaction > html.indexOf('assets/css/viewers.css'));
  assert.ok(interaction > html.indexOf('assets/css/data-grid.css'));
}

console.log(`UI normalization tests passed (${usedIcons.size} local icons checked)`);
