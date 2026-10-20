/*
 * BB.diff: the algorithms of the comparison of two versions of an object.
 * - lines: Myers diff of two lists of lines, grouped in hunks with context;
 * - words: the changed words inside a changed line;
 * - JSON: the paths that an edit added, removed or changed, and a normalized text (sorted keys);
 * - CSV: the rows that an edit added, removed or changed, with the changed cells.
 * Everything here is pure: no DOM. The file runs in the browser and in Node (the tests of the algorithms).
 */
(function (root) {
  'use strict';

  // Above this number of edits the diff gives up on the minimal script and shows the two texts as a replacement.
  const MAX_EDITS = 2500;

  // ---------------------------------------------------------------------------------------------------------------
  // Lines
  // ---------------------------------------------------------------------------------------------------------------

  // The ops of the diff of two arrays: { type: 'eq' | 'del' | 'add', a, b } where a and b are the index in each side
  // (-1 for the side that the op does not have). The ops come in the order of the texts.
  function diffArrays(a, b, { equal = (x, y) => x === y, maxEdits = MAX_EDITS } = {}) {
    let start = 0;
    while (start < a.length && start < b.length && equal(a[start], b[start])) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && equal(a[endA - 1], b[endB - 1])) { endA -= 1; endB -= 1; }

    const ops = [];
    for (let index = 0; index < start; index += 1) ops.push({ type: 'eq', a: index, b: index });
    const middle = myers(a, b, start, endA, endB, equal, maxEdits);
    for (const op of middle.ops) ops.push(op);
    for (let offset = 0; endA + offset < a.length; offset += 1) ops.push({ type: 'eq', a: endA + offset, b: endB + offset });
    return { ops, truncated: middle.truncated };
  }

  function myers(a, b, start, endA, endB, equal, maxEdits) {
    const n = endA - start;
    const m = endB - start;
    if (n === 0 && m === 0) return { ops: [], truncated: false };
    if (n === 0) return { ops: Array.from({ length: m }, (_, i) => ({ type: 'add', a: -1, b: start + i })), truncated: false };
    if (m === 0) return { ops: Array.from({ length: n }, (_, i) => ({ type: 'del', a: start + i, b: -1 })), truncated: false };

    const max = Math.min(n + m, maxEdits);
    const offset = max + 1;
    const frontier = new Int32Array(2 * max + 3);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d += 1) {
      // Only the diagonals -d-1 .. d+1 matter at the step d: the trace has O(D*D) values.
      trace.push(frontier.slice(offset - d - 1, offset + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])) x = frontier[offset + k + 1];
        else x = frontier[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && equal(a[start + x], b[start + y])) { x += 1; y += 1; }
        frontier[offset + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
    }
    if (found < 0) {
      // Too many edits: the middle part is a replacement.
      const ops = [];
      for (let i = 0; i < n; i += 1) ops.push({ type: 'del', a: start + i, b: -1 });
      for (let j = 0; j < m; j += 1) ops.push({ type: 'add', a: -1, b: start + j });
      return { ops, truncated: true };
    }

    // Walk back from the end to the start.
    const reversed = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d -= 1) {
      const previous = trace[d];
      const at = diagonal => previous[diagonal + d + 1];
      const k = x - y;
      let previousK;
      if (k === -d || (k !== d && at(k - 1) < at(k + 1))) previousK = k + 1;
      else previousK = k - 1;
      const previousX = at(previousK);
      const previousY = previousX - previousK;
      while (x > previousX && y > previousY) { x -= 1; y -= 1; reversed.push({ type: 'eq', a: start + x, b: start + y }); }
      if (x === previousX) { y -= 1; reversed.push({ type: 'add', a: -1, b: start + y }); }
      else { x -= 1; reversed.push({ type: 'del', a: start + x, b: -1 }); }
    }
    while (x > 0 && y > 0) { x -= 1; y -= 1; reversed.push({ type: 'eq', a: start + x, b: start + y }); }
    return { ops: reversed.reverse(), truncated: false };
  }

  // The text split in lines. The last line break does not start a line. A text with no content has no line.
  function splitLines(text) {
    if (text === '') return [];
    const lines = String(text).split(/\r\n|\n|\r/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function diffLines(aText, bText, options) {
    const a = splitLines(aText);
    const b = splitLines(bText);
    const { ops, truncated } = diffArrays(a, b, options);
    return { a, b, ops, truncated, stats: statsOf(ops) };
  }

  function statsOf(ops) {
    let added = 0;
    let removed = 0;
    for (const op of ops) {
      if (op.type === 'add') added += 1;
      else if (op.type === 'del') removed += 1;
    }
    return { added, removed, changed: added + removed };
  }

  // The ops cut in hunks: the changed ops with `context` unchanged ops around them. The hunks that touch merge.
  function hunks(ops, context = 3) {
    const result = [];
    let current = null;
    let lastChange = -Infinity;
    for (let index = 0; index < ops.length; index += 1) {
      if (ops[index].type === 'eq') continue;
      const from = Math.max(0, index - context);
      if (current && from <= lastChange + context + 1) {
        current.end = index;
      } else {
        current = { start: from, end: index };
        result.push(current);
      }
      lastChange = index;
    }
    return result.map(hunk => {
      const end = Math.min(ops.length - 1, hunk.end + context);
      return { start: hunk.start, end };
    }).reduce((merged, hunk) => {
      const last = merged[merged.length - 1];
      if (last && hunk.start <= last.end + 1) last.end = Math.max(last.end, hunk.end);
      else merged.push({ ...hunk });
      return merged;
    }, []);
  }

  // The words of a line: the words, the spaces and each other character.
  function tokens(text) {
    return String(text).match(/\w+|\s+|[^\w\s]/gu) || [];
  }

  // The changed parts of two lines: two arrays of { text, changed }. A pair of long lines is not cut in words.
  function wordDiff(aLine, bLine) {
    const a = tokens(aLine);
    const b = tokens(bLine);
    if (a.length > 600 || b.length > 600) return { a: [{ text: aLine, changed: true }], b: [{ text: bLine, changed: true }] };
    const { ops } = diffArrays(a, b, { maxEdits: 1000 });
    const left = [];
    const right = [];
    const push = (list, text, changed) => {
      const last = list[list.length - 1];
      if (last && last.changed === changed) last.text += text;
      else list.push({ text, changed });
    };
    for (const op of ops) {
      if (op.type === 'eq') { push(left, a[op.a], false); push(right, b[op.b], false); }
      else if (op.type === 'del') push(left, a[op.a], true);
      else push(right, b[op.b], true);
    }
    return { a: left, b: right };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // JSON
  // ---------------------------------------------------------------------------------------------------------------

  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = sortKeys(value[key]);
      return result;
    }
    return value;
  }

  // The text of a JSON document with sorted keys and a 2-space indent, or null when the text is not JSON.
  function normalizeJSON(text) {
    try {
      return JSON.stringify(sortKeys(JSON.parse(text)), null, 2);
    } catch (_) {
      return null;
    }
  }

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function pathKey(parent, key) {
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
  }

  // The changes between two JSON values: { path, type: 'added' | 'removed' | 'changed', before, after }. At most `limit`.
  function jsonChanges(before, after, limit = 400) {
    const changes = [];
    let overflow = false;
    const add = change => { if (changes.length >= limit) overflow = true; else changes.push(change); };
    const walk = (a, b, path) => {
      if (overflow) return;
      if (isObject(a) && isObject(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of [...keys].sort()) {
          const child = pathKey(path, key);
          if (!(key in a)) add({ path: child, type: 'added', after: b[key] });
          else if (!(key in b)) add({ path: child, type: 'removed', before: a[key] });
          else walk(a[key], b[key], child);
        }
      } else if (Array.isArray(a) && Array.isArray(b)) {
        const common = Math.min(a.length, b.length);
        for (let index = 0; index < common; index += 1) walk(a[index], b[index], `${path}[${index}]`);
        for (let index = common; index < b.length; index += 1) add({ path: `${path}[${index}]`, type: 'added', after: b[index] });
        for (let index = common; index < a.length; index += 1) add({ path: `${path}[${index}]`, type: 'removed', before: a[index] });
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        add({ path, type: 'changed', before: a, after: b });
      }
    };
    walk(before, after, '$');
    return { changes, overflow };
  }

  function diffJSON(aText, bText) {
    let before;
    let after;
    try {
      before = JSON.parse(aText);
      after = JSON.parse(bText);
    } catch (error) {
      return { valid: false, error: String(error.message || error) };
    }
    const { changes, overflow } = jsonChanges(before, after);
    const lines = diffLines(JSON.stringify(sortKeys(before), null, 2), JSON.stringify(sortKeys(after), null, 2));
    return { valid: true, changes, overflow, lines };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------------------------------------------

  // The rows of a delimited text (RFC 4180: quotes, doubled quotes, line breaks inside a quoted cell).
  function parseDelimited(text, delimiter = ',') {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const source = String(text);
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (char === '"') {
          if (source[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false;
        } else cell += char;
      } else if (char === '"' && cell === '') quoted = true;
      else if (char === delimiter) { row.push(cell); cell = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[index + 1] === '\n') index += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += char;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function delimiterOf(key) {
    const ext = String(key || '').toLowerCase().split('.').pop();
    if (ext === 'tsv' || ext === 'tab') return '\t';
    if (ext === 'psv') return '|';
    return ',';
  }

  // The rows of the two versions: each row is { type: 'eq' | 'add' | 'del' | 'mod', before, after, cells } where cells
  // tells which cell of a modified row changed. A block of removed rows followed by a block of added rows gives modified
  // rows, in the order of the rows, then the rows that stay.
  function diffDelimited(aText, bText, delimiter = ',') {
    const a = parseDelimited(aText, delimiter);
    const b = parseDelimited(bText, delimiter);
    const sign = row => JSON.stringify(row);
    const { ops, truncated } = diffArrays(a, b, { equal: (x, y) => sign(x) === sign(y) });
    const rows = [];
    for (let index = 0; index < ops.length;) {
      if (ops[index].type === 'eq') {
        rows.push({ type: 'eq', before: a[ops[index].a], after: b[ops[index].b], aIndex: ops[index].a, bIndex: ops[index].b });
        index += 1;
        continue;
      }
      const removed = [];
      const added = [];
      while (index < ops.length && ops[index].type !== 'eq') {
        if (ops[index].type === 'del') removed.push(ops[index]); else added.push(ops[index]);
        index += 1;
      }
      // A removed row and an added row are one modified row when they have the same first cell (the key), or when
      // most of their cells are equal. The other rows are removed and added.
      const pairOf = new Map();
      const usedRemoved = new Set();
      for (let position = 0; position < added.length; position += 1) {
        const key = b[added[position].b][0];
        if (key === undefined || key === '') continue;
        const match = removed.findIndex((op, index) => !usedRemoved.has(index) && a[op.a][0] === key);
        if (match >= 0) { pairOf.set(position, match); usedRemoved.add(match); }
      }
      for (let position = 0; position < added.length; position += 1) {
        if (pairOf.has(position)) continue;
        const after = b[added[position].b];
        const match = removed.findIndex((op, index) => {
          if (usedRemoved.has(index)) return false;
          const before = a[op.a];
          const width = Math.max(before.length, after.length);
          let same = 0;
          for (let column = 0; column < width; column += 1) if (before[column] === after[column]) same += 1;
          return width > 0 && same * 2 >= width;
        });
        if (match >= 0) { pairOf.set(position, match); usedRemoved.add(match); }
      }
      removed.forEach((op, index) => {
        if (!usedRemoved.has(index)) rows.push({ type: 'del', before: a[op.a], after: null, aIndex: op.a, bIndex: -1 });
      });
      added.forEach((op, position) => {
        if (!pairOf.has(position)) { rows.push({ type: 'add', before: null, after: b[op.b], aIndex: -1, bIndex: op.b }); return; }
        const source = removed[pairOf.get(position)];
        const before = a[source.a];
        const after = b[op.b];
        const width = Math.max(before.length, after.length);
        const cells = Array.from({ length: width }, (_, column) => before[column] !== after[column]);
        rows.push({ type: 'mod', before, after, cells, aIndex: source.a, bIndex: op.b });
      });
    }
    const count = type => rows.filter(row => row.type === type).length;
    const columns = Math.max(0, ...a.map(row => row.length), ...b.map(row => row.length));
    return { rows, columns, truncated, stats: { added: count('add'), removed: count('del'), modified: count('mod') } };
  }

  const api = { diffArrays, splitLines, diffLines, hunks, statsOf, wordDiff, tokens, normalizeJSON, jsonChanges, diffJSON, parseDelimited, delimiterOf, diffDelimited };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    const BB = (root.BB = root.BB || {});
    BB.diff = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
