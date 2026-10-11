// Browser behaviour tests for the frontend: keyboard, focus, touch, text scaling, themes and axe.
//
// The unit tests in ../*.js pin source text. These drive a real Chrome against a running stack, so they catch what
// source checks cannot: focus lost after a re-render, a ring clipped by a scroller, a swipe that never scrolls.
//
//   BB_E2E_URL       base URL of the application          (default http://127.0.0.1:8080)
//   BB_E2E_INSTANCE  storage instance that may be written  (default garage-main)
//   CHROME_PATH      Chrome or Chromium executable          (default google-chrome)
//   BB_E2E_FILTER    only run checks whose name contains this text
//
// Fixtures are uploaded under e2e-fixtures/ and removed afterwards.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = `${(process.env.BB_E2E_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')}/`;
const INSTANCE = process.env.BB_E2E_INSTANCE || 'garage-main';
const ROOT = 'e2e-fixtures/';
const DEEP = `${ROOT}deep/alpha-folder/beta-folder/gamma-folder/delta-folder/epsilon-folder/zeta-folder/`;

// ---------------------------------------------------------------- fixtures
function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function pdfDocument(lines) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const stream = `BT /F1 18 Tf 20 150 Td ${lines.map(line => `(${line}) Tj 0 -24 Td`).join(' ')} ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PEM = `-----BEGIN CERTIFICATE-----
MIIBrzCCAVWgAwIBAgIUIHvSrTZZa725gKPS54+pOkOzGvswCgYIKoZIzj0EAwIw
LTEZMBcGA1UEAwwQZTJlLmV4YW1wbGUudGVzdDEQMA4GA1UECgwHRml4dHVyZTAe
Fw0yNjEwMTExNjMyMTVaFw0zNjEwMDgxNjMyMTVaMC0xGTAXBgNVBAMMEGUyZS5l
eGFtcGxlLnRlc3QxEDAOBgNVBAoMB0ZpeHR1cmUwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT9F6YULv24auGqnZFM1zF2iCN66CrTBi/HLe9ycrGjGjhzktv1R0uV
GZAkVQYqo8P8wvNRjDpGu/Q9X44Qd6kOo1MwUTAdBgNVHQ4EFgQUMAPQMarxClfW
qCOktsdXChcaggEwHwYDVR0jBBgwFoAUMAPQMarxClfWqCOktsdXChcaggEwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA3v1/egmMV0qfyFVjmK7u
FiLlnkp76wi3ekbE5NAyg5sCIHZpR9Mwq3mefdKqQbjYu5sN3izoUgv0mOWn0YMd
4msl
-----END CERTIFICATE-----
`;

function fixtures() {
  const files = new Map();
  files.set(`${ROOT}notes.txt`, ['text/plain', 'Plain notes.\nSecond line.\n']);
  const rows = ['id,name,country,plan,mrr'];
  for (let i = 1; i <= 250; i += 1) rows.push(`${i},User ${i},${['FI', 'FR', 'DE', 'IT', 'ES'][i % 5]},${['free', 'team', 'pro'][i % 3]},${(i * 37.31) % 900}`);
  files.set(`${ROOT}users.csv`, ['text/csv', rows.join('\n')]);
  files.set(`${ROOT}events.json`, ['application/json', JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, type: 'delete', meta: { ip: `10.0.0.${i}`, ok: i % 2 === 0 } })), null, 2)]);
  files.set(`${ROOT}readme.md`, ['text/markdown', [
    '# Fixture document', '', 'A [link to the docs](https://example.invalid/docs) inside a paragraph.', '',
    '- [x] done item', '- [ ] open item', '', '![A missing diagram](diagram.png)', '',
    '```sh', 'echo "a very long shell command line that is wider than a phone screen so the code block has to scroll sideways"', '```', ''
  ].join('\n')]);
  files.set(`${ROOT}example.zip`, ['application/zip', zipStored([['example/readme.txt', 'hello'], ['example/data/a.csv', 'a,b\n1,2\n'], ['example/data/b.json', '{"b":1}'], ...Array.from({ length: 40 }, (_, i) => [`example/files/entry-${String(i + 1).padStart(2, '0')}.txt`, `entry ${i + 1}`])])]);
  files.set(`${ROOT}long.md`, ['text/markdown', Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of a long document, long enough that the page has to scroll on a phone.\n`).join('\n')]);
  for (let i = 1; i <= 60; i += 1) files.set(`${ROOT}many/file-${String(i).padStart(2, '0')}.txt`, ['text/plain', `file ${i}\n`.repeat(i)]);
  files.set(`${DEEP}leaf.txt`, ['text/plain', 'leaf']);
  files.set(`${ROOT}calendar.ics`, ['text/calendar', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//EN', ...Array.from({ length: 30 }, (_, i) => ['BEGIN:VEVENT', `UID:${i}@e2e`, `DTSTART:202410${String((i % 28) + 1).padStart(2, '0')}T090000Z`, `DTEND:202410${String((i % 28) + 1).padStart(2, '0')}T100000Z`, `SUMMARY:Fixture meeting ${i + 1}`, 'LOCATION:Room 1', 'END:VEVENT']).flat(), 'END:VCALENDAR', ''].join('\r\n')]);
  files.set(`${ROOT}contact.vcf`, ['text/vcard', ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada Fixture', 'ORG:Fixture Ltd', 'TEL;TYPE=WORK:+358 40 000 0000', 'EMAIL:ada@example.test', 'END:VCARD', ''].join('\r\n')]);
  files.set(`${ROOT}message.eml`, ['message/rfc822', ['From: Ada <ada@example.test>', 'To: Bob <bob@example.test>', 'Subject: Fixture message', 'Date: Thu, 03 Oct 2024 09:00:00 +0000', 'Content-Type: text/plain; charset=utf-8', '', ...Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long message body.`), ''].join('\r\n')]);
  files.set(`${ROOT}cert.pem`, ['application/x-pem-file', PEM]);
  files.set(`${ROOT}report.pdf`, ['application/pdf', pdfDocument(['Quarterly report', 'Fixture page'])]);
  files.set(`${ROOT}memo.docx`, ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', zipStored([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + Array.from({ length: 80 }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i + 1} of the fixture memo.</w:t></w:r></w:p>`).join('') + '</w:body></w:document>']
  ])]);
  files.set(`${ROOT}budget.xlsx`, ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zipStored([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Quarter</t></is></c><c r="B1" t="inlineStr"><is><t>Revenue</t></is></c></row>' + Array.from({ length: 80 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>Q${i + 1}</t></is></c><c r="B${i + 2}"><v>${1000 + i}</v></c></row>`).join('') + '</sheetData></worksheet>'],
    ['xl/worksheets/sheet2.xml', '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Remark</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Second sheet</t></is></c></row></sheetData></worksheet>']
  ])]);
  // Hostile Markdown: each line has been used against renderers that only block a list of tag names.
  files.set(`${ROOT}xss.md`, ['text/markdown', [
    '# Hostile', '',
    '<svg><script>window.__pwned=1</script><a><animate attributeName="href" values="javascript:window.__pwned=2"/><text>x</text></a></svg>', '',
    '<math><mi xlink:href="javascript:window.__pwned=3">m</mi></math>', '',
    '<div class="bb-overlay is-open"><div class="bb-modal" id="fake-dialog">Session expired. Re-enter your secret key</div></div>', '',
    '<img src="x" onerror="window.__pwned=4" id="clobber" name="viewer">', '',
    '[click](javascript:window.__pwned=5) <a href="JaVaScRiPt:window.__pwned=6">mixed</a>', '',
    '<form action="https://example.invalid"><input name="password"><button>Send</button></form>', '',
    '<iframe src="https://example.invalid"></iframe><style>body{display:none}</style>', ''
  ].join('\n')]);

  return files;
}

async function seed() {
  for (const [key, [type, body]] of fixtures()) {
    const response = await fetch(`${BASE}s3?instance=${INSTANCE}&key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
    if (response.status !== 204 && response.status !== 200) throw new Error(`seeding ${key} failed: HTTP ${response.status}`);
  }
}

async function cleanup() {
  const created = await fetch(`${BASE}api/delete-prefix`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instance: INSTANCE, prefix: ROOT }) });
  const job = await created.json().catch(() => ({}));
  for (let attempt = 0; job.id && attempt < 120; attempt += 1) {
    const status = await (await fetch(`${BASE}api/jobs/${job.id}`)).json();
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'canceled') return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

// ---------------------------------------------------------------- harness
const results = [];
let currentGroup = '';
async function check(name, run) {
  if (process.env.BB_E2E_FILTER && !`${currentGroup}: ${name}`.includes(process.env.BB_E2E_FILTER)) return;
  try {
    await run();
    results.push({ ok: true, name: `${currentGroup}: ${name}` });
  } catch (error) {
    results.push({ ok: false, name: `${currentGroup}: ${name}`, error: String(error && error.message ? error.message : error).split('\n')[0] });
  }
}
function expect(condition, detail = '') {
  if (!condition) throw new Error(detail || 'expectation failed');
}

const ACTIVE = () => {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  return {
    tag: element.tagName.toLowerCase(),
    cls: typeof element.className === 'string' ? element.className : '',
    label: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 60),
    role: element.getAttribute('role')
  };
};

async function listing(page, prefix = '') {
  const url = await (async () => {
    await page.goto(BASE);
    await page.waitForSelector('.object-link, .table-empty', { timeout: 20000 });
    return page.evaluate(([p, instance]) => BB.api.browserPageURL(p, { instance }), [prefix, INSTANCE]);
  })();
  await page.goto(new URL(url, BASE).href);
  await page.waitForSelector('.object-link, .table-empty, .browser-load-error', { timeout: 20000 });
  await page.waitForTimeout(400);
}

async function preview(page, key) {
  await page.goto(BASE);
  await page.waitForSelector('.object-link, .table-empty', { timeout: 20000 });
  const url = await page.evaluate(([k, instance]) => BB.api.previewPageURL(k, { instance }), [key, INSTANCE]);
  await page.goto(new URL(url, BASE).href);
  await page.waitForTimeout(1800);
}

async function swipe(client, x0, y0, x1, y1, steps = 15) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i += 1) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function axeViolations(page) {
  // The application's CSP forbids inline scripts, so axe is evaluated through the DevTools protocol.
  const client = await page.context().newCDPSession(page);
  await client.send('Runtime.evaluate', { expression: axeSource });
  const { result } = await client.send('Runtime.evaluate', {
    expression: 'axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 2).map(n => n.target.join(" ")) }))))',
    awaitPromise: true,
    returnByValue: true
  });
  return JSON.parse(result.value);
}

// In-page probes -----------------------------------------------------------
const RING_PROBE = () => {
  const parse = value => {
    const rgb = value.match(/rgba?\(([^)]+)\)/);
    if (rgb) { const [r, g, b, a = 1] = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [r, g, b, a]; }
    const srgb = value.match(/color\(srgb ([^)]+)\)/);
    if (srgb) { const [r, g, b, a = 1] = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number); return [r * 255, g * 255, b * 255, a]; }
    return null;
  };
  const luminance = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const backdrop = (element, includeSelf) => {
    for (let node = includeSelf ? element : element.parentElement; node; node = node.parentElement) {
      const colour = parse(getComputedStyle(node).backgroundColor);
      if (colour && colour[3] >= 0.99) return colour;
    }
    return [255, 255, 255, 1];
  };
  const selector = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const problems = [];
  const label = element => element.tagName.toLowerCase() + (typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/)[0]}` : '');
  const candidates = Array.from(document.querySelectorAll(selector)).filter(element => !element.disabled && element.offsetParent !== null).slice(0, 90);
  for (const element of candidates) {
    element.focus({ focusVisible: true, preventScroll: true });
    if (document.activeElement !== element) continue;
    const style = getComputedStyle(element);
    const width = parseFloat(style.outlineWidth) || 0;
    if (style.outlineStyle === 'none' || width < 2) { problems.push(`no ring: ${label(element)}`); continue; }
    // The ring must be visible against what it is drawn over: the control itself when drawn inside, else its parent.
    const ringColour = parse(style.outlineColor);
    if (ringColour) {
      const ratio = contrast(ringColour, backdrop(element, (parseFloat(style.outlineOffset) || 0) < 0));
      if (ratio < 3) problems.push(`ring contrast ${ratio.toFixed(2)}:1: ${label(element)}`);
    }
    const rect = element.getBoundingClientRect();
    const pad = (parseFloat(style.outlineOffset) || 0) + width;
    const ring = { l: rect.left - pad, t: rect.top - pad, r: rect.right + pad, b: rect.bottom + pad };
    for (let parent = element.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.overflowX === 'visible' && parentStyle.overflowY === 'visible') continue;
      const box = parent.getBoundingClientRect();
      // A control scrolled out of view is not a clipped ring: only judge controls that are inside the scroller.
      const inside = rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
      if (!inside) break;
      const clipped = (parentStyle.overflowX !== 'visible' && (ring.l < box.left - 0.5 || ring.r > box.right + 0.5)) || (parentStyle.overflowY !== 'visible' && (ring.t < box.top - 0.5 || ring.b > box.bottom + 0.5));
      if (clipped) { problems.push(`ring clipped: ${label(element)} by ${label(parent)}`); break; }
    }
  }
  return Array.from(new Set(problems));
};

const SCALE_PROBE = scale => {
  document.documentElement.style.fontSize = scale;
  const problems = [];
  const label = element => element.tagName.toLowerCase() + (typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/)[0]}` : '');
  const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (sideways > 1) problems.push(`page scrolls sideways by ${sideways}px`);
  for (const element of document.querySelectorAll('button, a.btn, select, [role="tab"], .btn')) {
    if (element.offsetParent === null) continue;
    if (element.scrollHeight > element.clientHeight + 2) problems.push(`clipped: ${label(element)} (${element.scrollHeight}>${element.clientHeight})`);
  }
  return Array.from(new Set(problems));
};

const TARGET_PROBE = () => {
  const small = [];
  const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  for (const element of document.querySelectorAll(selector)) {
    if (element.disabled || element.offsetParent === null || element.closest('.skip-link')) continue;
    let box = element.getBoundingClientRect();
    // A checkbox wrapped in a label is operated through the label.
    if (/^(checkbox|radio)$/.test(element.type || '') && element.closest('label')) box = element.closest('label').getBoundingClientRect();
    if (box.width && box.height && (box.width < 43.5 || box.height < 43.5)) small.push(`${element.tagName.toLowerCase()}.${typeof element.className === 'string' ? element.className.split(' ')[0] : ''} ${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  return Array.from(new Set(small));
};

// ---------------------------------------------------------------- suites
async function desktop(browser) {
  currentGroup = 'keyboard';
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error).slice(0, 160)));

  await listing(page, ROOT);
  await check('the skip link is the first tab stop and moves focus to the content', async () => {
    await page.keyboard.press('Tab');
    expect((await page.evaluate(ACTIVE))?.cls.startsWith('skip-link'), 'first tab stop is not the skip link');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'main-content', 'focus did not reach #main-content');
  });

  await check('a row menu opens from the keyboard, moves with the arrows and Escape returns to its trigger', async () => {
    const kebab = page.locator('tbody tr', { hasText: 'notes.txt' }).locator('.bb-kebab');
    await kebab.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    expect((await page.evaluate(ACTIVE))?.role === 'menuitem', 'focus did not enter the menu');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect((await page.evaluate(ACTIVE))?.label.startsWith('Options for notes.txt'), 'Escape did not restore focus to the trigger');
  });

  await check('activating a menu item keeps focus on the trigger, and Tab leaves the menu from the trigger', async () => {
    const kebab = page.locator('tbody tr', { hasText: 'notes.txt' }).locator('.bb-kebab');
    await kebab.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    expect((await page.evaluate(ACTIVE))?.label.startsWith('Options for notes.txt'), 'focus was lost after Download');
    const other = page.locator('tbody tr').first().locator('.bb-kebab');
    await other.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    const active = await page.evaluate(ACTIVE);
    expect(active && !active.cls.startsWith('skip-link'), 'Tab sent focus back to the top of the page');
    expect(await page.evaluate(() => !document.querySelector('.bb-menu.is-open')), 'the menu stayed open');
  });

  await check('a dialog opened from the keyboard returns focus to the kebab that opened it', async () => {
    const kebab = page.locator('tbody tr', { hasText: 'notes.txt' }).locator('.bb-kebab');
    await kebab.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await page.getByRole('menuitem', { name: 'Details' }).press('Enter');
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect((await page.evaluate(ACTIVE))?.label.startsWith('Options for notes.txt'), 'focus did not return to the kebab');
  });

  await check('the delete confirmation is an alertdialog that traps Tab and focuses Cancel', async () => {
    const kebab = page.locator('tbody tr', { hasText: 'notes.txt' }).locator('.bb-kebab');
    await kebab.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await page.getByRole('menuitem', { name: 'Delete' }).press('Enter');
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => { const modal = document.querySelector('.bb-modal'); return { role: modal?.getAttribute('role'), modal: modal?.getAttribute('aria-modal'), focus: document.activeElement.textContent.trim() }; });
    expect(info.role === 'alertdialog' && info.modal === 'true', `dialog semantics: ${JSON.stringify(info)}`);
    expect(info.focus === 'Cancel', `initial focus is ${info.focus}`);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.querySelector('.bb-modal').contains(document.activeElement)), 'Tab left the dialog');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => !document.querySelector('.bb-modal')), 'Escape did not close the dialog');
  });

  await check('the hidden-parents breadcrumb menu works from the keyboard', async () => {
    await page.setViewportSize({ width: 380, height: 800 });
    await listing(page, DEEP);
    const trigger = page.locator('.breadcrumb-overflow-trigger');
    expect(await trigger.count() === 1, 'the breadcrumb did not collapse');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const first = await page.evaluate(ACTIVE);
    expect(first?.role === 'menuitem', 'Enter did not move focus into the menu');
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(ACTIVE);
    expect(second?.role === 'menuitem' && second.label !== first.label, 'ArrowDown did not move between items');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => !document.querySelector('.breadcrumb-overflow-popover')), 'Tab did not close the menu');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('paging to the last page keeps focus on a live control', async () => {
    await listing(page, `${ROOT}many/`);
    const next = page.getByRole('button', { name: 'Next page' });
    await next.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const active = await page.evaluate(ACTIVE);
    expect(active && active.tag !== 'body', 'focus fell to <body>');
  });

  await check('file and folder names are real links (open in a new tab)', async () => {
    await listing(page, '');
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a.object-link')).map(link => link.getAttribute('href')));
    expect(hrefs.length > 0 && hrefs.every(href => href && href.length > 0), 'object names are not anchors with an href');
  });

  currentGroup = 'viewers';
  await check('CSV: sorting, paging and the filter toggle keep keyboard focus', async () => {
    await preview(page, `${ROOT}users.csv`);
    const sort = page.locator('.data-sort-button').nth(1);
    await sort.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    expect((await page.evaluate(ACTIVE))?.cls.includes('data-sort-button'), 'sorting dropped focus');
    const next = page.locator('.data-preview-pagination button').last();
    await next.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    expect(await page.evaluate(ACTIVE), 'paging dropped focus');
    const filters = page.getByRole('button', { name: /Filters/ });
    await filters.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect((await page.evaluate(ACTIVE))?.label.includes('Filters'), 'the filter toggle dropped focus');
  });

  await check('CSV: a column can be resized with the arrow keys', async () => {
    const separator = page.locator('.data-column-resizer').nth(1);
    await separator.focus();
    const widthOf = () => page.evaluate(() => document.querySelectorAll('.data-column-resizer')[1].parentElement.getBoundingClientRect().width);
    const before = await widthOf();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    expect(await widthOf() > before + 20, 'the column did not grow');
    expect(await separator.getAttribute('aria-valuenow'), 'the separator has no aria-valuenow');
  });

  await check('JSON: the view tabs follow the tab pattern', async () => {
    await preview(page, `${ROOT}events.json`);
    const tabs = page.getByRole('tab');
    expect(await tabs.count() === 3, 'expected three view tabs');
    expect(await tabs.first().getAttribute('aria-controls'), 'tabs are not linked to their panels');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    expect((await page.evaluate(ACTIVE))?.role === 'tab' && await page.evaluate(() => document.activeElement.getAttribute('aria-selected')) === 'true', 'ArrowRight did not select and focus the next tab');
  });

  await check('Markdown: links are underlined, task items are named, headings sit below the page heading, missing images are explained', async () => {
    await preview(page, `${ROOT}readme.md`);
    const info = await page.evaluate(() => ({
      underline: getComputedStyle(document.querySelector('.markdown-body a')).textDecorationLine,
      tasks: Array.from(document.querySelectorAll('.markdown-body input[type="checkbox"]')).map(box => [box.disabled, box.getAttribute('aria-label'), box.checked]),
      level: document.querySelector('.markdown-body h1')?.getAttribute('aria-level'),
      missing: document.querySelector('.md-image-missing')?.textContent
    }));
    expect(info.underline.includes('underline'), 'links are not underlined');
    expect(info.tasks.length === 2 && info.tasks.every(task => task[0] && task[1]), `task list: ${JSON.stringify(info.tasks)}`);
    expect(info.tasks[0][2] === true && info.tasks[1][2] === false, 'task state was lost');
    expect(info.level === '2', `h1 aria-level = ${info.level}`);
    expect(info.missing && info.missing.includes('A missing diagram'), 'a broken image glyph is shown');
  });

  await check('the Markdown code block that scrolls sideways is focusable', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => Array.from(document.querySelectorAll('.markdown-body pre')).map(pre => ({ scrolls: pre.scrollWidth > pre.clientWidth, focusable: pre.tabIndex >= 0 })));
    expect(result.length > 0 && result.every(pre => !pre.scrolls || pre.focusable), `pre: ${JSON.stringify(result)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('the folder treemap is one tab stop of real buttons, navigable with the arrows', async () => {
    await listing(page, ROOT);
    await page.locator('tbody tr', { hasText: 'many/' }).locator('.bb-kebab').click();
    await page.getByRole('menuitem', { name: 'Insights' }).click();
    await page.waitForTimeout(1800);
    await page.getByRole('tab', { name: 'Treemap' }).click();
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => ({
      stops: Array.from(document.querySelectorAll('.folder-treemap-node')).filter(tile => tile.tabIndex === 0).length,
      buttons: Array.from(document.querySelectorAll('.folder-treemap-node')).every(tile => tile.tagName === 'BUTTON'),
      role: document.querySelector('.folder-treemap').getAttribute('role')
    }));
    expect(info.stops === 1, `${info.stops} tab stops`);
    expect(info.buttons && info.role !== 'img', `tiles are buttons: ${info.buttons}, container role: ${info.role}`);
    await page.evaluate(() => document.querySelector('.folder-treemap-node[tabindex="0"]').focus());
    await page.keyboard.press('ArrowRight');
    expect((await page.evaluate(ACTIVE))?.cls.includes('folder-treemap-node'), 'ArrowRight left the treemap');
    await page.keyboard.press('Escape');
  });

  currentGroup = 'regressions';
  await check('the Details dialog keeps Tab inside after the tabs were used with the arrow keys', async () => {
    await listing(page, ROOT);
    await page.locator('tbody tr', { hasText: 'notes.txt' }).locator('.bb-kebab').click();
    await page.getByRole('menuitem', { name: 'Details' }).click();
    await page.waitForTimeout(1500);
    expect((await page.evaluate(ACTIVE))?.role === 'tab', 'the dialog does not open on its selected tab');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Home');
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('.bb-modal')?.contains(document.activeElement)), `Tab ${i + 1} left the dialog`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  });

  await check('Refresh keeps keyboard focus while the listing reloads', async () => {
    await listing(page, ROOT);
    const refresh = page.getByRole('button', { name: /refresh/i }).first();
    await refresh.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    const active = await page.evaluate(ACTIVE);
    expect(active && /refresh/i.test(active.label), `focus is ${JSON.stringify(active)}`);
  });

  await check('JSON: counting, paging and the tree keep focus; tree nodes have names, state and one tab stop', async () => {
    await preview(page, `${ROOT}events.json`);
    const count = page.getByRole('button', { name: /Count lines/ });
    await count.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    expect(await page.evaluate(ACTIVE), 'focus was lost after counting');
    const next = page.getByRole('button', { name: 'Next page' }).first();
    if (await next.isEnabled()) {
      await next.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1200);
      expect(await page.evaluate(ACTIVE), 'focus was lost after paging');
    }
    await page.getByRole('tab', { name: 'Tree' }).click();
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => {
      const toggles = Array.from(document.querySelectorAll('.json-tree-toggle:not(:disabled)'));
      return { names: toggles.slice(0, 3).map(button => button.getAttribute('aria-label')), expanded: toggles.slice(0, 3).map(button => button.getAttribute('aria-expanded')), stops: toggles.filter(button => button.tabIndex === 0).length };
    });
    expect(info.names.every(name => /^(Expand|Collapse) /.test(name || '')) && new Set(info.names).size === info.names.length, `names: ${info.names}`);
    expect(info.expanded.every(value => value === 'true' || value === 'false'), `aria-expanded: ${info.expanded}`);
    expect(info.stops === 1, `${info.stops} tab stops in the tree`);
    await page.evaluate(() => document.querySelector('.json-tree-toggle[tabindex="0"]').focus());
    await page.keyboard.press('ArrowDown');
    expect((await page.evaluate(ACTIVE))?.cls.includes('json-tree-toggle'), 'ArrowDown did not move to the next node');
  });

  await check('the data grid can be entered from the keyboard and announces its result count', async () => {
    await preview(page, `${ROOT}users.csv`);
    const info = await page.evaluate(() => ({ stop: !!document.querySelector('.data-table tbody td[tabindex="0"]'), live: document.querySelector('.data-preview-summary')?.getAttribute('role') }));
    expect(info.stop, 'no body cell is in the tab order');
    expect(info.live === 'status', 'the row count is not a live region');
  });

  await check('hostile Markdown cannot run script, restyle the page or imitate an application dialog', async () => {
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await preview(page, `${ROOT}xss.md`);
    await page.evaluate(() => { for (const link of document.querySelectorAll('.markdown-body a')) link.click(); });
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const root = document.querySelector('.markdown-body');
      return {
        pwned: window.__pwned,
        foreign: root.querySelectorAll('svg, math, script, style, iframe, form, input, button, object, embed').length,
        classes: Array.from(root.querySelectorAll('[class]')).map(element => element.className).filter(name => !/^(language-[\w+#.-]+|md-[\w-]+|markdown-body)$/.test(name)),
        ids: root.querySelectorAll('[id], [name]').length,
        overlay: !!document.querySelector('.bb-overlay'),
        scripted: Array.from(root.querySelectorAll('[href], [src]')).filter(element => /^\s*(javascript|vbscript|data):/i.test(element.getAttribute('href') || element.getAttribute('src') || '')).length,
        handlers: Array.from(root.querySelectorAll('*')).filter(element => Array.from(element.attributes).some(attribute => /^on/i.test(attribute.name))).length,
        bodyVisible: getComputedStyle(document.body).display !== 'none'
      };
    });
    expect(info.pwned === undefined, `script ran (${info.pwned})`);
    expect(info.foreign === 0, `${info.foreign} dangerous elements survived`);
    expect(info.classes.length === 0, `classes survived: ${info.classes.join(', ')}`);
    expect(info.ids === 0, 'id/name attributes survived (DOM clobbering)');
    expect(!info.overlay && info.scripted === 0 && info.handlers === 0 && info.bodyVisible, JSON.stringify(info));
    expect(dialogs.length === 0, `dialogs: ${dialogs}`);
  });

  await check('real notifications honour reduced motion and forced colours', async () => {
    const reduced = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', forcedColors: 'none' });
    const reducedPage = await reduced.newPage();
    await reducedPage.goto(BASE);
    await reducedPage.waitForSelector('.object-link, .table-empty');
    const info = await reducedPage.evaluate(() => {
      BB.ui.toast('Working', { indeterminate: true, duration: 0, persistent: true });
      const bar = document.querySelector('.bb-toast-progress-bar');
      const spinner = document.querySelector('.mdi-loading, .mdi-spin');
      return { barAnimation: getComputedStyle(bar).animationName, spinner: spinner ? getComputedStyle(spinner).animationDuration : null };
    });
    await reduced.close();
    expect(info.barAnimation === 'none', `the indeterminate bar still animates (${info.barAnimation})`);
    const forced = await browser.newContext({ viewport: { width: 1280, height: 800 }, forcedColors: 'active' });
    const forcedPage = await forced.newPage();
    await forcedPage.goto(BASE);
    await forcedPage.waitForSelector('.object-link, .table-empty');
    const colours = await forcedPage.evaluate(async () => {
      BB.ui.toast('Uploading', { progress: 0.5, duration: 0, persistent: true });
      const bar = document.querySelector('.bb-toast-progress-bar');
      const track = document.querySelector('.bb-toast-progress');
      BB.ui.alert({ title: 'Edge', message: 'Visible border' });
      await new Promise(resolve => setTimeout(resolve, 400));
      return { bar: getComputedStyle(bar).backgroundColor, track: getComputedStyle(track).backgroundColor, edge: getComputedStyle(document.querySelector('.bb-modal')).borderTopWidth };
    });
    await forced.close();
    expect(colours.bar !== colours.track, 'the progress fill and its track share one colour');
    expect(parseFloat(colours.edge) >= 1, `dialog border ${colours.edge}`);
  });

  await check('tabbing out of the storage switcher closes it', async () => {
    await listing(page, ROOT);
    await page.locator('.storage-switcher-trigger').first().click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.locator('.storage-switcher-trigger').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => !document.querySelector('.storage-tree-switcher')?.contains(document.activeElement))) break;
    }
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => !document.querySelector('.storage-tree-switcher.is-open')), 'the switcher stayed open after focus left it');
  });

  for (const [width, scale, label] of [[320, '200%', '320px at 200% text'], [390, '200%', '390px at 200% text'], [320, '150%', '320px at 150% text']]) {
    await check(`nothing overlaps or collapses at ${label}`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await listing(page, ROOT);
      const list = await page.evaluate(zoom => {
        document.documentElement.style.fontSize = zoom;
        const box = selector => { const element = document.querySelector(selector); return element && element.offsetParent !== null ? element.getBoundingClientRect() : null; };
        const overlap = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        return {
          searchWidth: box('.search-field .input')?.width,
          chipsOverName: overlap(box('.storage-switcher-permissions'), box('.storage-switcher-copy strong')) || overlap(box('.storage-switcher-permissions'), box('.storage-switcher-copy small'))
        };
      }, scale);
      expect(list.searchWidth >= 100, `the search field is ${list.searchWidth}px wide`);
      expect(!list.chipsOverName, 'the permission chips overlap the storage name');
      await preview(page, `${ROOT}users.csv`);
      const header = await page.evaluate(zoom => {
        document.documentElement.style.fontSize = zoom;
        const box = selector => { const element = document.querySelector(selector); return element && element.offsetParent !== null ? element.getBoundingClientRect() : null; };
        const overlap = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        return { nameOverOpen: overlap(box('#docName'), box('#openRawBtn')), nameOverMenu: overlap(box('#docName'), box('#previewKebabBtn')) };
      }, scale);
      expect(!header.nameOverOpen && !header.nameOverMenu, 'the file name overlaps the header buttons');
      await page.setViewportSize({ width: 1440, height: 900 });
    });
  }

  currentGroup = 'focus ring';
  for (const [name, open] of [
    ['file list', () => listing(page, ROOT)],
    ['CSV viewer', () => preview(page, `${ROOT}users.csv`)],
    ['ZIP viewer', () => preview(page, `${ROOT}example.zip`)],
    ['JSON viewer', () => preview(page, `${ROOT}events.json`)],
    ['PDF viewer', () => preview(page, `${ROOT}report.pdf`)],
    ['DOCX viewer', () => preview(page, `${ROOT}memo.docx`)],
    ['XLSX viewer', () => preview(page, `${ROOT}budget.xlsx`)],
    ['calendar viewer', () => preview(page, `${ROOT}calendar.ics`)],
    ['contact viewer', () => preview(page, `${ROOT}contact.vcf`)],
    ['email viewer', () => preview(page, `${ROOT}message.eml`)],
    ['certificate viewer', () => preview(page, `${ROOT}cert.pem`)]
  ]) {
    await check(`${name}: every focusable control shows a ring that is visible and not clipped`, async () => {
      await open();
      await page.keyboard.press('Tab');
      const problems = await page.evaluate(RING_PROBE);
      expect(problems.length === 0, problems.slice(0, 4).join('; '));
    });
  }

  currentGroup = 'text size';
  for (const [name, open] of [
    ['file list', () => listing(page, ROOT)],
    ['CSV viewer', () => preview(page, `${ROOT}users.csv`)],
    ['JSON viewer', () => preview(page, `${ROOT}events.json`)],
    ['ZIP viewer', () => preview(page, `${ROOT}example.zip`)]
  ]) {
    await check(`${name}: 200% text neither clips controls nor scrolls the page sideways`, async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await open();
      const problems = await page.evaluate(SCALE_PROBE, '200%');
      expect(problems.length === 0, problems.slice(0, 4).join('; '));
    });
  }
  await check('the file list still fits a 320px screen at 200% text', async () => {
    await page.setViewportSize({ width: 320, height: 800 });
    await listing(page, ROOT);
    const sideways = await page.evaluate(scale => { document.documentElement.style.fontSize = scale; return document.documentElement.scrollWidth - document.documentElement.clientWidth; }, '200%');
    expect(sideways <= 1, `scrolls sideways by ${sideways}px`);
  });

  currentGroup = 'themes and modes';
  await check('reduced motion keeps spinners turning slowly and makes transitions instant', async () => {
    const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const reducedPage = await reduced.newPage();
    await reducedPage.goto(BASE);
    await reducedPage.waitForSelector('.object-link, .table-empty');
    const info = await reducedPage.evaluate(() => {
      const probe = document.createElement('i');
      probe.className = 'mdi mdi-loading mdi-spin';
      document.body.appendChild(probe);
      return { duration: getComputedStyle(probe).animationDuration, token: getComputedStyle(document.documentElement).getPropertyValue('--duration-fast').trim() };
    });
    await reduced.close();
    expect(info.token === '0s', `--duration-fast = ${info.token}`);
    expect(parseFloat(info.duration) >= 2, `spinner duration ${info.duration}`);
  });
  await check('forced colours keep dialog edges and progress bars visible', async () => {
    const forced = await browser.newContext({ viewport: { width: 1440, height: 900 }, forcedColors: 'active' });
    const forcedPage = await forced.newPage();
    await forcedPage.goto(BASE);
    await forcedPage.waitForSelector('.object-link, .table-empty');
    const info = await forcedPage.evaluate(() => {
      const modal = document.createElement('div');
      modal.className = 'bb-modal';
      document.body.appendChild(modal);
      const bar = document.createElement('div');
      bar.className = 'bb-toast-progress-bar';
      const track = document.createElement('div');
      track.className = 'bb-toast-progress';
      track.appendChild(bar);
      document.body.appendChild(track);
      return { edge: getComputedStyle(modal).borderTopWidth, bar: getComputedStyle(bar).backgroundColor, trackBg: getComputedStyle(track).backgroundColor };
    });
    await forced.close();
    expect(parseFloat(info.edge) >= 1, `modal border ${info.edge}`);
    expect(info.bar !== info.trackBg, 'the progress bar and its track share one colour');
  });

  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  await context.close();
}

async function phone(browser) {
  currentGroup = 'phone';
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  await check('every control on the file list and the CSV viewer is at least 44px', async () => {
    await listing(page, ROOT);
    const list = await page.evaluate(TARGET_PROBE);
    await preview(page, `${ROOT}users.csv`);
    const csv = await page.evaluate(TARGET_PROBE);
    expect(list.length + csv.length === 0, [...list, ...csv].slice(0, 5).join('; '));
  });

  for (const [name, key] of [['CSV', `${ROOT}users.csv`], ['JSON', `${ROOT}events.json`], ['XLSX', `${ROOT}budget.xlsx`], ['DOCX', `${ROOT}memo.docx`], ['Markdown', `${ROOT}long.md`], ['ZIP', `${ROOT}example.zip`], ['calendar', `${ROOT}calendar.ics`]]) {
    await check(`a vertical swipe scrolls the page on the ${name} viewer`, async () => {
      await preview(page, key);
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 200), 'the fixture is too short to scroll');
      await swipe(client, 200, 700, 200, 300);
      await page.waitForTimeout(800);
      const scrolled = await page.evaluate(() => window.scrollY);
      expect(scrolled > 50, `scrollY = ${scrolled}`);
    });
  }

  await check('the Details dialog keeps its tabs on a phone', async () => {
    await listing(page, ROOT);
    await page.locator('tbody tr', { hasText: 'notes.txt' }).locator('.bb-kebab').click();
    await page.getByRole('menuitem', { name: 'Details' }).click();
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => { const tab = document.querySelector('[data-details-tab="advanced"]'); return !!tab && tab.offsetParent !== null; }), 'the Advanced tab is hidden');
  });

  for (const [name, open] of [
    ['file list', () => listing(page, ROOT)],
    ['CSV viewer', () => preview(page, `${ROOT}users.csv`)],
    ['JSON viewer', () => preview(page, `${ROOT}events.json`)],
    ['ZIP viewer', () => preview(page, `${ROOT}example.zip`)],
    ['Markdown viewer', () => preview(page, `${ROOT}readme.md`)]
  ]) {
    await check(`${name} does not scroll sideways at 320px`, async () => {
      await page.setViewportSize({ width: 320, height: 800 });
      await open();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(sideways <= 1, `scrolls sideways by ${sideways}px`);
    });
  }
  await context.close();
}

async function accessibility(browser) {
  currentGroup = 'axe';
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
    const page = await context.newPage();
    for (const [name, open] of [
      ['file list', () => listing(page, ROOT)],
      ['file list with the insights treemap', async () => {
        await listing(page, ROOT);
        await page.locator('tbody tr', { hasText: 'many/' }).locator('.bb-kebab').click();
        await page.getByRole('menuitem', { name: 'Insights' }).click();
        await page.waitForTimeout(1500);
        await page.getByRole('tab', { name: 'Treemap' }).click();
        await page.waitForTimeout(1200);
      }],
      ['details dialog', async () => {
        await listing(page, ROOT);
        await page.locator('tbody tr', { hasText: 'notes.txt' }).locator('.bb-kebab').click();
        await page.getByRole('menuitem', { name: 'Details' }).click();
        await page.waitForTimeout(1500);
      }],
      ['text viewer', () => preview(page, `${ROOT}notes.txt`)],
      ['CSV viewer', () => preview(page, `${ROOT}users.csv`)],
      ['JSON viewer', () => preview(page, `${ROOT}events.json`)],
      ['Markdown viewer', () => preview(page, `${ROOT}readme.md`)],
      ['ZIP viewer', () => preview(page, `${ROOT}example.zip`)],
      ['PDF viewer', () => preview(page, `${ROOT}report.pdf`)],
      ['DOCX viewer', () => preview(page, `${ROOT}memo.docx`)],
      ['XLSX viewer', () => preview(page, `${ROOT}budget.xlsx`)],
      ['calendar viewer', () => preview(page, `${ROOT}calendar.ics`)],
      ['contact viewer', () => preview(page, `${ROOT}contact.vcf`)],
      ['email viewer', () => preview(page, `${ROOT}message.eml`)],
      ['certificate viewer', () => preview(page, `${ROOT}cert.pem`)],
      ['hostile Markdown', () => preview(page, `${ROOT}xss.md`)],
      ['load error state', async () => {
        await page.route('**/api/list*', route => route.fulfill({ status: 403, body: 'access denied for prefix' }));
        await page.goto(BASE);
        await page.waitForSelector('.browser-load-error', { timeout: 20000 });
        await page.unroute('**/api/list*');
      }],
      ['empty folder state', async () => {
        await page.route('**/api/list*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], scanComplete: true, sortAvailable: false }) }));
        await page.goto(BASE);
        await page.waitForSelector('.table-empty', { timeout: 20000 });
        await page.unroute('**/api/list*');
      }]
    ]) {
      await check(`${name} (${scheme}) has no axe violations`, async () => {
        await open();
        const violations = await axeViolations(page);
        expect(violations.length === 0, violations.map(v => `${v.id} [${v.impact}] ${v.nodes.join(', ')}`).slice(0, 3).join('; '));
      });
    }
    await context.close();
  }
}

// ---------------------------------------------------------------- main
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome', args: ['--no-sandbox'] });
try {
  await seed();
  await desktop(browser);
  await phone(browser);
  await accessibility(browser);
} finally {
  await browser.close();
  await cleanup().catch(() => {});
}

let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n     ${result.error}`}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
