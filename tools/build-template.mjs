// Compiles the object browser's Vue template ahead of time.
//
//   node build-template.mjs           writes ../src/public/assets/js/app.render.js
//   node build-template.mjs --check   fails when that file is not what the template compiles to
//
// The browser then needs only Vue's runtime-only build: no template compiler is downloaded or run, and the
// Content-Security-Policy can leave out 'unsafe-eval'. The template source is ../src/frontend/app.template.html;
// edit that file, never the generated one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@vue/compiler-dom';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, '../src/frontend/app.template.html');
const outputPath = path.join(here, '../src/public/assets/js/app.render.js');

const source = fs.readFileSync(templatePath, 'utf8');
const problems = [];
const { code } = compile(source, {
  mode: 'function',
  // Identifiers resolve through _ctx, so the output needs no `with` block and is valid in strict mode.
  prefixIdentifiers: true,
  hoistStatic: true,
  cacheHandlers: true,
  onError: error => problems.push(error.message),
  onWarn: warning => problems.push(warning.message)
});
if (problems.length) {
  console.error(`The template does not compile:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const output = `/*
 * GENERATED FILE: do not edit.
 * Compiled from src/frontend/app.template.html by tools/build-template.mjs (Vue 3.5.18 compiler).
 * Run \`npm run build\` in tools/ after changing the template; CI runs \`npm run check\`.
 */
(function () {
  'use strict';
  const BB = (window.BB = window.BB || {});
  BB.renderApp = (function () {
${code.split('\n').map(line => (line ? `    ${line}` : line)).join('\n')}
  })();
})();
`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('src/public/assets/js/app.render.js is out of date. Run `npm run build` in tools/ and commit the result.');
    process.exit(1);
  }
  console.log('app.render.js is up to date');
} else {
  fs.writeFileSync(outputPath, output);
  console.log(`wrote ${path.relative(process.cwd(), outputPath)} (${output.length} bytes)`);
}
