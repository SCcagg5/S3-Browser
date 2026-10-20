// Tests of the algorithms of src/frontends/portal/assets/js/diff.js. They run in Node, with no browser.
const assert = require('assert');
const diff = require('/src/diff.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok    ${name}`); } catch (error) { failed += 1; console.log(`FAIL  ${name}\n      ${error.message}`); }
}

// Applies the ops to a: the result must be b.
function apply(a, b, ops) {
  const result = [];
  for (const op of ops) {
    if (op.type === 'eq') { assert.strictEqual(a[op.a], b[op.b]); result.push(a[op.a]); }
    else if (op.type === 'add') result.push(b[op.b]);
  }
  return result;
}

test('lines: equal texts have no change', () => {
  const result = diff.diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.deepStrictEqual(result.stats, { added: 0, removed: 0, changed: 0 });
  assert.strictEqual(result.ops.length, 3);
});

test('lines: one changed line is one removal and one addition', () => {
  const result = diff.diffLines('a\nb\nc', 'a\nB\nc');
  assert.deepStrictEqual(result.stats, { added: 1, removed: 1, changed: 2 });
  assert.deepStrictEqual(result.ops.map(op => op.type), ['eq', 'del', 'add', 'eq']);
});

test('lines: empty sides', () => {
  assert.deepStrictEqual(diff.diffLines('', 'a\nb').stats, { added: 2, removed: 0, changed: 2 });
  assert.deepStrictEqual(diff.diffLines('a\nb', '').stats, { added: 0, removed: 2, changed: 2 });
  assert.deepStrictEqual(diff.diffLines('', '').ops, []);
});

test('lines: the last line break does not make a line, and CRLF is a line break', () => {
  assert.deepStrictEqual(diff.splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepStrictEqual(diff.splitLines('a\n\nb'), ['a', '', 'b']);
  assert.strictEqual(diff.diffLines('a\nb\n', 'a\r\nb\r\n').stats.changed, 0);
});

test('lines: the ops rebuild the second text, on random edits', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 200; round += 1) {
    const a = Array.from({ length: Math.floor(random() * 40) }, () => `l${Math.floor(random() * 8)}`);
    const b = a.slice();
    for (let edit = 0; edit < Math.floor(random() * 8); edit += 1) {
      const at = Math.floor(random() * (b.length + 1));
      if (random() < 0.5) b.splice(at, 1); else b.splice(at, 0, `n${Math.floor(random() * 5)}`);
    }
    const { ops } = diff.diffArrays(a, b);
    assert.deepStrictEqual(apply(a, b, ops), b, `round ${round}`);
    const dels = ops.filter(op => op.type === 'del').map(op => op.a);
    assert.strictEqual(new Set(dels).size, dels.length);
    assert.strictEqual(ops.filter(op => op.type !== 'add').length, a.length);
    assert.strictEqual(ops.filter(op => op.type !== 'del').length, b.length);
  }
});

test('lines: the diff is minimal on a known case', () => {
  // ABCABBA -> CBABAC has a shortest edit script of 5 (Myers, 1986).
  const a = 'ABCABBA'.split('');
  const b = 'CBABAC'.split('');
  const { ops } = diff.diffArrays(a, b);
  assert.strictEqual(ops.filter(op => op.type !== 'eq').length, 5);
  assert.deepStrictEqual(apply(a, b, ops), b);
});

test('lines: a very different pair gives a replacement and says so', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  const result = diff.diffArrays(a, b);
  assert.strictEqual(result.truncated, true);
  assert.deepStrictEqual(apply(a, b, result.ops), b);
});

test('lines: a long file with a few edits is fast', () => {
  const a = Array.from({ length: 50000 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b[100] = 'changed';
  b.splice(20000, 0, 'inserted');
  b.splice(40000, 1);
  const started = Date.now();
  const { ops, truncated } = diff.diffArrays(a, b);
  assert.strictEqual(truncated, false);
  assert.strictEqual(ops.filter(op => op.type !== 'eq').length, 4);
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

test('hunks: context of 3, and hunks that touch merge', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const changed = lines.slice();
  changed[5] = 'x';
  changed[9] = 'y';
  changed[25] = 'z';
  const { ops } = diff.diffArrays(lines, changed);
  const result = diff.hunks(ops, 3);
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].end < result[1].start);
  assert.deepStrictEqual(diff.hunks(diff.diffArrays(['a'], ['a']).ops, 3), []);
});

test('words: the changed words of a line', () => {
  const result = diff.wordDiff('version 2 of the report', 'version 3 of the report');
  assert.deepStrictEqual(result.a.filter(part => part.changed).map(part => part.text), ['2']);
  assert.deepStrictEqual(result.b.filter(part => part.changed).map(part => part.text), ['3']);
  assert.strictEqual(result.a.map(part => part.text).join(''), 'version 2 of the report');
  assert.strictEqual(result.b.map(part => part.text).join(''), 'version 3 of the report');
});

test('json: the normalized text has sorted keys and no format noise', () => {
  assert.strictEqual(diff.normalizeJSON('{"b":1,"a":{"d":1,"c":2}}'), '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}');
  assert.strictEqual(diff.normalizeJSON('not json'), null);
  assert.strictEqual(diff.normalizeJSON('{"a":1}'), diff.normalizeJSON('{\n "a" : 1\n}'));
});

test('json: the changes are the paths that an edit touched', () => {
  const before = { service: 'ingest', replicas: 2, limits: { cpu: '500m' }, regions: ['eu'], gone: true };
  const after = { service: 'ingest', replicas: 3, limits: { cpu: '500m', memory: '1Gi' }, regions: ['eu', 'us'], 'new key': 1 };
  const { changes } = diff.jsonChanges(before, after);
  assert.deepStrictEqual(changes.map(change => `${change.type} ${change.path}`), [
    'removed $.gone', 'added $.limits.memory', 'added $["new key"]', 'added $.regions[1]', 'changed $.replicas',
  ]);
  assert.deepStrictEqual(changes.find(change => change.path === '$.replicas'), { path: '$.replicas', type: 'changed', before: 2, after: 3 });
});

test('json: a change of type, an array that shrinks, null and the order of keys', () => {
  const { changes } = diff.jsonChanges({ a: [1, 2, 3], b: null, c: 1 }, { c: '1', a: [1], b: null });
  assert.deepStrictEqual(changes.map(change => `${change.type} ${change.path}`), ['removed $.a[1]', 'removed $.a[2]', 'changed $.c']);
  assert.strictEqual(diff.jsonChanges({ a: 1, b: 2 }, { b: 2, a: 1 }).changes.length, 0);
});

test('json: the limit of changes is reported', () => {
  const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  const other = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i + 1]));
  const result = diff.jsonChanges(big, other, 10);
  assert.strictEqual(result.changes.length, 10);
  assert.strictEqual(result.overflow, true);
});

test('json: diffJSON says when a side is not JSON', () => {
  assert.strictEqual(diff.diffJSON('{"a":1}', '{oops').valid, false);
  const result = diff.diffJSON('{"b":1,"a":1}', '{"a":1,"b":2}');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.changes.length, 1);
  assert.strictEqual(result.lines.stats.changed, 2);
});

test('csv: quotes, doubled quotes, line breaks in a cell and CRLF', () => {
  assert.deepStrictEqual(diff.parseDelimited('a,b\r\n"x,1","he said ""hi"""\n"two\nlines",3\n'), [['a', 'b'], ['x,1', 'he said "hi"'], ['two\nlines', '3']]);
  assert.deepStrictEqual(diff.parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(diff.parseDelimited(''), []);
  assert.deepStrictEqual(diff.parseDelimited('a,,c\n'), [['a', '', 'c']]);
  assert.strictEqual(diff.delimiterOf('x.tsv'), '\t');
  assert.strictEqual(diff.delimiterOf('x.PSV'), '|');
  assert.strictEqual(diff.delimiterOf('x.csv'), ',');
});

test('csv: the row with the same key is one modified row, with the cells that changed', () => {
  const before = 'id,name,qty\n1,ada,5\n2,grace,7\n3,linus,9\n';
  const after = 'id,name,qty\n2,grace,8\n3,linus,9\n4,ken,1\n';
  const result = diff.diffDelimited(before, after);
  assert.deepStrictEqual(result.stats, { added: 1, removed: 1, modified: 1 });
  const row = result.rows.find(item => item.type === 'mod');
  assert.deepStrictEqual(row.before, ['2', 'grace', '7']);
  assert.deepStrictEqual(row.after, ['2', 'grace', '8']);
  assert.deepStrictEqual(row.cells, [false, false, true]);
  assert.deepStrictEqual(result.rows.find(item => item.type === 'del').before, ['1', 'ada', '5']);
  assert.deepStrictEqual(result.rows.find(item => item.type === 'add').after, ['4', 'ken', '1']);
  assert.strictEqual(result.columns, 3);
});

test('csv: rows with no key and no common cell stay removed and added', () => {
  const result = diff.diffDelimited('h\na\nb\nc\n', 'h\nx\n');
  assert.deepStrictEqual(result.stats, { added: 1, removed: 3, modified: 0 });
});

test('csv: rows that share most cells are one modified row, without a key', () => {
  const result = diff.diffDelimited('a,b,c,d\n', 'x,b,c,d\n');
  assert.deepStrictEqual(result.stats, { added: 0, removed: 0, modified: 1 });
  assert.deepStrictEqual(result.rows[0].cells, [true, false, false, false]);
});


// ---- The patch of git ----

// Applies a unified patch to a text, as `patch` does, and gives the new text.
function applyPatch(aText, patch) {
  const original = diff.splitLines(aText);
  const lines = patch.split('\n');
  let index = lines.findIndex(line => line.startsWith('@@'));
  const out = [];
  let position = 0;
  let lastOutputMarker = false;
  while (index >= 0 && index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      const target = count === 0 ? start : start - 1;
      while (position < target) { out.push(original[position]); position += 1; }
      continue;
    }
    if (line.startsWith('\\')) { if (out.length) lastOutputMarker = lastOutputMarker || lastWasOutput; continue; }
    if (line === '') continue;
    const sign = line[0];
    const text = line.slice(1);
    lastWasOutput = sign !== '-';
    if (sign === ' ') { assert.strictEqual(original[position], text); out.push(text); position += 1; lastOutputMarker = false; }
    else if (sign === '-') { assert.strictEqual(original[position], text); position += 1; }
    else if (sign === '+') { out.push(text); lastOutputMarker = false; }
  }
  const reachedEnd = position >= original.length;
  while (position < original.length) { out.push(original[position]); position += 1; }
  const noEol = reachedEnd ? lastOutputMarker : (aText !== '' && !/\n$/.test(aText));
  return out.join('\n') + (out.length && !noEol ? '\n' : '');
}
let lastWasOutput = false;

test('patch: the header and the hunks have the format of git', () => {
  const filler = Array.from({ length: 12 }, (_, i) => `f${i}`).join('\n');
  const result = diff.diffLines(`a\nb\nc\n${filler}\nz\n`, `a\nb\nC\n${filler}\nz\nnew\n`);
  const patch = diff.unifiedPatch(result, { aPath: 'dir/file.txt', aId: 'abc1234', bId: 'def5678' });
  assert.strictEqual(patch, [
    'diff --git a/dir/file.txt b/dir/file.txt',
    'index abc1234..def5678 100644',
    '--- a/dir/file.txt',
    '+++ b/dir/file.txt',
    '@@ -1,6 +1,6 @@', ' a', ' b', '-c', '+C', ' f0', ' f1', ' f2',
    '@@ -14,3 +14,4 @@', ' f10', ' f11', ' z', '+new',
    '',
  ].join('\n'));
  assert.strictEqual(diff.unifiedPatch(diff.diffLines('same\n', 'same\n')), '');
  // Two edits that are 6 lines apart or less make one hunk, as in git.
  assert.strictEqual(diff.unifiedPatch(diff.diffLines('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nC\nd\ne\nf\ng\nh\nnew\n')).split('\n').filter(line => line.startsWith('@@')).length, 1);
});

test('patch: a new file, an emptied file and a file with no line break at the end', () => {
  assert.strictEqual(diff.unifiedPatch(diff.diffLines('', 'one\ntwo\n')).split('\n')[3], '@@ -0,0 +1,2 @@');
  assert.strictEqual(diff.unifiedPatch(diff.diffLines('one\ntwo\n', '')).split('\n')[3], '@@ -1,2 +0,0 @@');
  const noEol = diff.unifiedPatch(diff.diffLines('a\nb', 'a\nb\n'));
  assert.ok(noEol.includes('-b\n\\ No newline at end of file\n+b\n'), noEol);
  const both = diff.unifiedPatch(diff.diffLines('a\nb', 'a\nc'));
  assert.ok(both.endsWith('-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n'), both);
  const context = diff.unifiedPatch(diff.diffLines('x\na\nb', 'y\na\nb'));
  assert.ok(context.endsWith(' b\n\\ No newline at end of file\n'), context);
});

test('patch: applying the patch to the first text gives the second text, on random edits and line breaks', () => {
  let seed = 11;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 400; round += 1) {
    const a = Array.from({ length: Math.floor(random() * 30) }, () => `l${Math.floor(random() * 6)}`);
    const b = a.slice();
    for (let edit = 0; edit < Math.floor(random() * 6); edit += 1) {
      const at = Math.floor(random() * (b.length + 1));
      if (random() < 0.5) b.splice(at, 1); else b.splice(at, 0, `n${Math.floor(random() * 4)}`);
    }
    const finish = lines => (lines.length ? lines.join('\n') + (random() < 0.7 ? '\n' : '') : '');
    const aText = finish(a);
    const bText = finish(b);
    const patch = diff.unifiedPatch(diff.diffLines(aText, bText));
    if (aText === bText) { assert.strictEqual(patch, ''); continue; }
    assert.strictEqual(applyPatch(aText, patch), bText, `round ${round}\n${aText}\n---\n${bText}\n---\n${patch}`);
  }
});

test('lines: a missing line break at the end is a change, as in git', () => {
  const result = diff.diffLines('a\nb', 'a\nb\n');
  assert.deepStrictEqual(result.stats, { added: 1, removed: 1, changed: 2 });
  assert.strictEqual(result.aNoEol, true);
  assert.strictEqual(result.bNoEol, false);
});

if (failed) { console.log(`${failed} test(s) failed`); process.exit(1); }
console.log('all diff tests passed');
