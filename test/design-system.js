'use strict';

// Design system contract: tokens, themes, contrast, framework-free markup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'src/public');
const cssDir = path.join(publicDir, 'assets/css');
const read = file => fs.readFileSync(file, 'utf8');
const cssFiles = fs.readdirSync(cssDir).filter(name => name.endsWith('.css'));
const css = Object.fromEntries(cssFiles.map(name => [name, read(path.join(cssDir, name))]));
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------- Tokens and themes ----------
function declarations(block) {
  const result = new Map();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) result.set(match[1], match[2].trim());
  return result;
}
const tokens = strip(css['tokens.css']);
const rootBlock = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('@media (pointer: coarse)'));
const darkStart = tokens.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = tokens.slice(darkStart, tokens.indexOf('@media (prefers-contrast: more)'));
const light = declarations(rootBlock);
const dark = new Map([...light, ...declarations(darkBlock)]);
assert.match(tokens, /color-scheme:\s*light dark/);
assert.ok(darkStart > 0, 'tokens.css must define a dark theme');
assert.match(read(path.join(publicDir, 'index.html')), /<meta name="color-scheme" content="light dark"/);
assert.match(read(path.join(publicDir, 'preview.html')), /<meta name="color-scheme" content="light dark"/);
assert.match(read(path.join(publicDir, '404.html')), /<meta name="color-scheme" content="light dark"/);

// Every surface and text colour must be re-declared for dark mode, except the documented invariants.
const invariant = new Set([
  '--color-on-solid', '--color-inverse-text', '--color-viewer-bg', '--color-media-bg',
  '--color-other-tile', '--color-other-tile-text', '--color-other-tile-line', '--color-tile-label-shadow', '--color-other-tile-label-shadow'
]);
for (const name of light.keys()) {
  if (!/^--(color|syntax)-/.test(name) || invariant.has(name)) continue;
  assert.ok(declarations(darkBlock).has(name), `${name} has no dark value`);
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const surfaces = ['--color-bg-page', '--color-bg-panel', '--color-bg-subtle', '--color-bg-hover', '--color-bg-inset'];
const texts = ['--color-text-strong', '--color-text', '--color-text-secondary', '--color-text-muted', '--color-primary', '--color-danger', '--color-success', '--color-warning'];
for (const [theme, values] of [['light', light], ['dark', dark]]) {
  for (const text of texts) {
    for (const surface of surfaces) {
      const ratio = contrast(values.get(text), values.get(surface));
      assert.ok(ratio >= 4.5, `${theme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
  for (const [text, surface] of [['--color-primary', '--color-primary-soft'], ['--color-danger', '--color-danger-soft'], ['--color-success', '--color-success-soft'], ['--color-warning', '--color-warning-soft'], ['--color-text', '--color-primary-soft']]) {
    const ratio = contrast(values.get(text), values.get(surface));
    assert.ok(ratio >= 4.5, `${theme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
  }
  for (const surface of surfaces) {
    const ratio = contrast(values.get('--color-control-border'), values.get(surface));
    assert.ok(ratio >= 3, `${theme}: form field border on ${surface} is ${ratio.toFixed(2)}:1 (WCAG 1.4.11 needs 3:1)`);
  }
  for (const solid of ['--color-primary-solid', '--color-primary-hover', '--color-danger-solid', '--color-danger-hover']) {
    const ratio = contrast(values.get('--color-on-solid'), values.get(solid));
    assert.ok(ratio >= 4.5, `${theme}: white on ${solid} is ${ratio.toFixed(2)}:1`);
  }
  for (const name of [...values.keys()].filter(key => key.startsWith('--syntax-') && key !== '--syntax-bg')) {
    const ratio = contrast(values.get(name), values.get('--syntax-bg'));
    assert.ok(ratio >= 4.5, `${theme}: ${name} on --syntax-bg is ${ratio.toFixed(2)}:1`);
  }
}
for (const name of [...light.keys()].filter(key => key.startsWith('--chart-'))) {
  const ratio = contrast('#ffffff', light.get(name));
  assert.ok(ratio >= 4.5, `${name} behind white labels is ${ratio.toFixed(2)}:1`);
}

// ---------- No literal colours, no framework, small important budget ----------
for (const [name, text] of Object.entries(css)) {
  if (name === 'tokens.css') continue;
  const code = strip(text);
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, `${name} contains a literal hex colour`);
  const rgb = [...code.matchAll(/rgba?\([^)]*\)/g)].map(match => match[0]);
  assert.deepEqual(rgb, [], `${name} contains literal colours`);
  assert.doesNotMatch(code, /zoom\s*:/, `${name} must not use zoom`);
  for (const match of code.matchAll(/z-index:\s*(-?\d+)/g)) {
    assert.ok(Math.abs(Number(match[1])) < 10, `${name} declares z-index ${match[1]}: overlays must use a --z-* token`);
  }
  for (const match of code.matchAll(/font-size:\s*([\d.]+)(px|rem)\s*[;}]/g)) {
    const px = match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1]);
    assert.ok(px >= 12, `${name} declares a ${px}px font size, below the 12px floor`);
  }
}
const importantAllowlist = new Map([
  ['base.css', 1],        // the hidden attribute must beat component display rules
  ['ui.css', 4],          // scroll lock (x2) and the two layout-preserving hidden elements
  ['a11y.css', 1],        // the keyboard focus ring
  ['preview.css', 0],
  ['browser.css', 0]
]);
let importantTotal = 0;
for (const [name, text] of Object.entries(css)) {
  const count = (strip(text).match(/!important/g) || []).length;
  importantTotal += count;
  assert.ok(count <= (importantAllowlist.get(name) ?? 0), `${name} uses ${count} !important declarations`);
}
assert.ok(importantTotal <= 6, `!important budget exceeded: ${importantTotal}`);

for (const file of ['index.html', 'preview.html', '404.html']) {
  const html = read(path.join(publicDir, file));
  assert.doesNotMatch(html, /buefy/i, `${file} must not depend on Buefy`);
  assert.doesNotMatch(html, /<b-[a-z]/, `${file} must not contain framework components`);
  for (const href of html.matchAll(/assets\/css\/([\w-]+\.css)/g)) {
    assert.ok(cssFiles.includes(href[1]), `${file} links a missing stylesheet ${href[1]}`);
  }
  assert.ok(html.indexOf('assets/css/a11y.css') > html.indexOf('assets/css/tokens.css'), `${file} must load a11y.css after the other layers`);
}
assert.equal(fs.existsSync(path.join(publicDir, 'assets/vendor/buefy')), false);

// Every stylesheet must be linked by a page.
const linked = new Set();
for (const file of ['index.html', 'preview.html']) {
  for (const href of read(path.join(publicDir, file)).matchAll(/assets\/css\/([\w-]+\.css)/g)) linked.add(href[1]);
}
for (const name of cssFiles) assert.ok(linked.has(name), `${name} is not linked by any page`);

// ---------- Every icon referenced by the markup or scripts must exist ----------
const iconCSS = css['icons.css'];
const iconFiles = new Set(fs.readdirSync(path.join(publicDir, 'assets/icons/mdi')).map(name => name.replace(/\.svg$/, '')));
const iconModifiers = new Set(['spin', 'loading', 'set', '18px', '24px', '36px', '48px']);
const iconRules = new Set([...iconCSS.matchAll(/\.mdi-([a-z0-9-]+)\b/g)].map(match => match[1]).filter(name => !iconModifiers.has(name)));
const sources = [path.join(publicDir, 'index.html'), path.join(publicDir, 'preview.html')];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) sources.push(full);
  }
})(path.join(publicDir, 'assets/js'));
const used = new Set();
for (const file of sources) {
  for (const match of read(file).matchAll(/\bmdi-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g)) {
    if (!iconModifiers.has(match[1])) used.add(match[1]);
  }
}
for (const name of used) {
  assert.ok(iconRules.has(name), `icon mdi-${name} is used but has no rule in icons.css`);
  assert.ok(iconFiles.has(name), `icon mdi-${name} has no SVG file`);
}
for (const name of iconRules) assert.ok(iconFiles.has(name), `icons.css references a missing SVG: ${name}`);
for (const name of iconFiles) assert.ok(iconRules.has(name), `SVG ${name} has no icons.css rule`);

// ---------- Spacing comes from the 4px-grid tokens ----------
for (const [name, text] of Object.entries(css)) {
  if (name === 'tokens.css') continue;
  for (const match of strip(text).matchAll(/(?<![-\w])((?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap)\s*:\s*([^;{}]+)[;}]/g)) {
    let value = match[2];
    let previous;
    do { previous = value; value = value.replace(/[\w-]*\([^()]*\)/g, ' '); } while (value !== previous);
    const literals = (value.match(/(?<![\w.-])-?\d*\.?\d+(?:rem|px)\b/g) || []).filter(literal => !/^-?(?:0|[1-3]px)$/.test(literal) && !/^-?0+(?:\.0+)?(?:rem|px)$/.test(literal));
    assert.deepEqual(literals, [], `${name}: ${match[1]} uses literal spacing "${match[2].trim()}"; use a --space-* token`);
  }
}

// ---------- Text scaling: control sizes follow the root font size ----------
for (const name of ['--control-height-sm', '--control-height-md', '--target-size', '--grid-row-height', '--browser-header-row-height']) {
  assert.match(light.get(name), /^[\d.]+rem$/, `${name} must be rem-based so controls grow with the text size`);
}
for (const [name, text] of Object.entries(css)) {
  assert.doesNotMatch(strip(text), /(?<![-\w])(?:height|width):\s*var\(--(?:control-height-(?:sm|md)|target-size)\)/, `${name} fixes a control size: use min-height/min-width so larger text is never clipped`);
}
assert.match(read(path.join(publicDir, 'assets/css/base.css')), /html\s*\{[^}]*font-size:\s*100%/, 'the root font size must follow the user setting');

// ---------- The browser page runs a precompiled template (no compiler, no eval) ----------
const indexHTML = read(path.join(publicDir, 'index.html'));
assert.doesNotMatch(indexHTML, /vue\.global\.prod\.js/, 'index.html must load the runtime-only Vue build');
assert.match(indexHTML, /vue\.runtime\.global\.prod\.js/);
assert.ok(indexHTML.indexOf('app.render.js') > 0 && indexHTML.indexOf('app.render.js') < indexHTML.indexOf('assets/js/app.js'), 'the compiled template must load before app.js');
assert.doesNotMatch(indexHTML, /<div id="app"|v-for=|@click=/, 'the template lives in src/frontend/app.template.html, not in index.html');
const generated = read(path.join(publicDir, 'assets/js/app.render.js'));
assert.match(generated, /^\/\*\n \* GENERATED FILE: do not edit\./);
assert.doesNotMatch(generated, /\bwith\s*\(|new Function|eval\(/, 'the compiled template must not need dynamic evaluation');
const appSource = read(path.join(publicDir, 'assets/js/app.js'));
assert.match(appSource, /render:\s*BB\.renderApp/);
assert.doesNotMatch(appSource, /\btemplate:\s*['"`]/, 'app.js must not compile a template at runtime');
assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/app.go'), 'utf8'), /unsafe-eval/, 'the CSP must not allow script evaluation');

// ---------- Accessibility contract ----------
const a11y = strip(css['a11y.css']);
assert.match(a11y, /@media \(pointer: coarse\)[\s\S]*min-height:\s*var\(--target-size\)/);
assert.match(a11y, /@media \(prefers-reduced-motion: reduce\)/);
assert.doesNotMatch(a11y, /animation-duration:\s*\.01ms|\*\s*,\s*\*::before[^{]*\{[^}]*duration/, 'reduced motion must not blanket-kill animation or transitions');
assert.match(a11y, /@media \(prefers-reduced-motion: reduce\)[\s\S]*--duration-fast:\s*0s/);
assert.match(a11y, /@media \(forced-colors: active\)[\s\S]*Highlight/);
assert.match(strip(css['tokens.css']), /@media \(pointer: coarse\)[\s\S]*--target-size:\s*2.75rem/);
const index = read(path.join(publicDir, 'index.html')) + read(path.join(root, 'src/frontend/app.template.html'));
assert.match(index, /<a class="skip-link" href="#main-content" @click\.prevent="focusMainContent">/);
assert.match(read(path.join(publicDir, 'assets/js/app.js')), /focusMainContent\(\)/);
assert.match(index, /<table class="table">[\s\S]*<caption class="sr-only">/);
assert.match(index, /aria-sort="navigationSortAria\('name'\)"|:aria-sort="navigationSortAria\('name'\)"/);

console.log('Design system contract passed');
