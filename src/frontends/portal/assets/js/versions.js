/*
 * BB.versions: the versions of an object in the portal interface.
 * - the version picker of the file details: one row for each version, with its number, its date, its size and what
 *   changed in size since the version before;
 * - the comparison of two versions: the text, JSON and CSV of the two versions side by side or in one list.
 * The algorithms are in diff.js. The content of a version is read in the browser, up to 2 MiB for each side.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_ROWS = 3000;
  const CONTEXT = 3;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const icon = name => h('i', { class: `mdi mdi-${name}`, 'aria-hidden': 'true' });

  // replaceChildren, without the empty values: the DOM would write them as the text "null".
  const fill = (node, ...children) => node.replaceChildren(...children.flat().filter(Boolean));

  // ---------------------------------------------------------------------------------------------------------------
  // The versions of an object as a list
  // ---------------------------------------------------------------------------------------------------------------

  function formatBytes(size) {
    const value = Math.abs(Number(size || 0));
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDelta(delta) {
    if (!delta) return 'same size';
    return `${delta > 0 ? '+' : '−'}${formatBytes(delta)}`;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  function formatAgo(value) {
    const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    const units = [[86400 * 365, 'year'], [86400 * 30, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [length, name] of units) {
      if (seconds >= length) { const count = Math.floor(seconds / length); return `${count} ${name}${count === 1 ? '' : 's'} ago`; }
    }
    return seconds < 5 ? 'now' : `${Math.floor(seconds)} seconds ago`;
  }

  const shortId = version => {
    const id = String(version || '');
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  };

  // The versions that hold data, the newest first, with the number of each (v1 is the oldest) and the size change.
  function listVersions(versions) {
    const real = (versions || []).filter(version => version && !version.deleteMarker && version.version);
    real.sort((left, right) => new Date(right.lastModified || 0) - new Date(left.lastModified || 0));
    const models = real.map((version, index) => ({ ...version, number: real.length - index }));
    models.forEach((model, index) => {
      model.older = models[index + 1] || null;
      model.delta = model.older ? Number(model.size || 0) - Number(model.older.size || 0) : null;
    });
    return models;
  }

  // The short id of a version in the line "index" of a patch: the start of its ETag, else the end of its version id.
  const blobId = version => {
    const etag = String(version.etag || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    return (etag || String(version.version || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(-7)).slice(0, 7);
  };

  const versionLabel = version => `v${version.number}`;

  // ---------------------------------------------------------------------------------------------------------------
  // Version picker (file details)
  // ---------------------------------------------------------------------------------------------------------------

  // explicit: a choice gives the identifier of the version (the version of the preview gives '' for the current one).
  // caption: a word before the version, such as From or To. Without onCompare and onAll the menu has no foot.
  function mountPicker(host, { versions, selected = '', onSelect, onCompare = null, onAll = null, explicit = false, caption = '', compact = false }) {
    // A new picker replaces the one of the host (the label changes with the choice): the old menu goes.
    host.picker?.close();
    host.picker?.menu.remove();
    const list = listVersions(versions);
    if (!list.length) { host.hidden = true; return; }
    const current = list.find(version => version.isCurrent) || list[0];
    const active = list.find(version => version.version === selected) || current;

    const label = h('span', { class: 'versionPicker__label' },
      h('strong', {}, versionLabel(active)),
      active === current ? h('span', { class: 'versionPicker__tag' }, 'Current') : h('span', { class: 'versionPicker__tag versionPicker__tag--old' }, 'Older'),
      h('span', { class: 'versionPicker__date' }, formatDate(active.lastModified)));
    const button = h('button', { type: 'button', class: ['versionPicker__button', compact && 'versionPicker__button--compact'], 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: `${list.length} versions` },
      caption ? h('span', { class: 'versionPicker__caption' }, caption) : null, icon('source-commit'), label, h('span', { class: 'versionPicker__count' }, `${list.length}`), icon('chevron-down'));

    const items = list.map(version => {
      const isActive = version === active;
      return h('button', {
        type: 'button', class: ['versionPicker__item', isActive && 'is-active'], role: 'option', 'aria-selected': isActive ? 'true' : 'false', 'data-version': version.version,
        onclick: () => { close(); if (version !== active) onSelect?.(version === current && !explicit ? '' : version.version); }
      },
        h('span', { class: 'versionPicker__number' }, versionLabel(version)),
        h('span', { class: 'versionPicker__when' },
          h('span', {}, formatDate(version.lastModified)),
          h('small', {}, formatAgo(version.lastModified))),
        h('span', { class: 'versionPicker__size' },
          h('span', {}, formatBytes(version.size)),
          h('small', { class: version.delta ? (version.delta > 0 ? 'is-grow' : 'is-shrink') : '' }, version.delta === null ? 'first version' : formatDelta(version.delta))),
        h('span', { class: 'versionPicker__meta' },
          version.isCurrent ? h('span', { class: 'versionPicker__tag' }, 'Current') : null,
          h('code', { title: version.version }, shortId(version.version))),
        isActive ? icon('check') : h('span', { class: 'versionPicker__spacer' }));
    });
    const compare = !onCompare ? null : h('button', { type: 'button', class: 'versionPicker__compare', disabled: list.length < 2, onclick: () => { close(); onCompare?.({ to: active.version, from: (active.older || list.find(version => version !== active))?.version }); } },
      icon('git-compare'), h('span', {}, active.older ? `Compare ${versionLabel(active)} with ${versionLabel(active.older)}` : 'Compare versions'));
    const all = onAll
      ? h('button', { type: 'button', class: 'versionPicker__all', onclick: () => { close(); onAll(); } }, icon('source-commit'), h('span', {}, 'All versions and actions…'))
      : null;
    const menu = h('div', { class: 'versionPicker__menu', role: 'listbox', 'aria-label': 'Versions of the object', hidden: true },
      h('div', { class: 'versionPicker__list' }, items), compare || all ? h('div', { class: 'versionPicker__foot' }, compare, all) : null);

    function place() {
      const box = button.getBoundingClientRect();
      menu.style.minWidth = `${Math.max(box.width, 420)}px`;
      const width = menu.offsetWidth;
      menu.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
      const below = window.innerHeight - box.bottom - 12;
      menu.style.top = `${box.bottom + 6}px`;
      menu.style.maxHeight = `${Math.max(220, below)}px`;
    }
    function open() {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
      (menu.querySelector('.versionPicker__item.is-active') || items[0]).focus();
      document.addEventListener('click', outside, true);
      document.addEventListener('keydown', keys, true);
      window.addEventListener('resize', place);
    }
    function close(focus = false) {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', outside, true);
      document.removeEventListener('keydown', keys, true);
      window.removeEventListener('resize', place);
      if (focus) button.focus();
    }
    const outside = event => { if (!menu.contains(event.target) && !button.contains(event.target)) close(); };
    const keys = event => {
      const focusable = [...menu.querySelectorAll('.versionPicker__item, .versionPicker__compare:not(:disabled), .versionPicker__all')];
      const index = focusable.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); focusable[Math.min(focusable.length - 1, index + 1)]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); focusable[Math.max(0, index - 1)]?.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close();
    };
    button.addEventListener('click', () => (menu.hidden ? open() : close()));
    host.replaceChildren(button);
    // The menu is in the overlay, outside the clipping of the header of the details.
    (host.closest('.bb-overlay') || document.body).append(menu);
    host.picker = { close, menu };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Content of a version
  // ---------------------------------------------------------------------------------------------------------------

  async function readVersion(key, version, instance, signal) {
    if (Number(version.size) > MAX_BYTES) return { tooLarge: true, size: Number(version.size) };
    const response = await fetch(BB.api.urlForKey(key, instance, version.version), { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`The version ${versionLabel(version)} cannot be read (HTTP ${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { tooLarge: true, size: bytes.length };
    const sample = bytes.subarray(0, 8192);
    if (sample.includes(0)) return { binary: true, size: bytes.length };
    try {
      let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      return { text, size: bytes.length };
    } catch (_) {
      return { binary: true, size: bytes.length };
    }
  }

  function kindOf(key) {
    const ext = String(key || '').toLowerCase().split('.').pop();
    if (['json', 'geojson', 'webmanifest', 'jsonc'].includes(ext)) return 'json';
    if (['csv', 'tsv', 'tab', 'psv'].includes(ext)) return 'csv';
    return 'text';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Views of a diff
  // ---------------------------------------------------------------------------------------------------------------

  function words(parts) {
    return parts.map(part => (part.changed ? h('mark', {}, part.text) : part.text));
  }

  // Rows of a unified or split diff: groups the changes in hunks and the unchanged lines between them in folds.
  function lineRows(result, { whole, mode }) {
    const { a, b, ops } = result;
    const ranges = whole ? [{ start: 0, end: ops.length - 1 }] : BB.diff.hunks(ops, CONTEXT);
    const rows = [];
    let position = 0;
    const fold = (from, to) => {
      if (to < from) return;
      rows.push({ kind: 'fold', from, to, count: to - from + 1 });
    };
    for (const range of ranges) {
      fold(position, range.start - 1);
      let index = range.start;
      while (index <= range.end) {
        const op = ops[index];
        if (op.type === 'eq') { rows.push({ kind: 'eq', a: op.a, b: op.b, text: a[op.a] }); index += 1; continue; }
        const removed = [];
        const added = [];
        while (index <= range.end && ops[index].type !== 'eq') {
          if (ops[index].type === 'del') removed.push(ops[index]); else added.push(ops[index]);
          index += 1;
        }
        const paired = Math.min(removed.length, added.length);
        const inline = paired > 0 && paired <= 200;
        const marks = Array.from({ length: paired }, (_, pair) => (inline ? BB.diff.wordDiff(a[removed[pair].a], b[added[pair].b]) : null));
        if (mode === 'split') {
          const size = Math.max(removed.length, added.length);
          for (let line = 0; line < size; line += 1) {
            rows.push({ kind: 'pair', left: removed[line] ? { n: removed[line].a, text: a[removed[line].a], parts: marks[line]?.a } : null,
              right: added[line] ? { n: added[line].b, text: b[added[line].b], parts: marks[line]?.b } : null });
          }
        } else {
          removed.forEach((op, line) => rows.push({ kind: 'del', a: op.a, text: a[op.a], parts: marks[line]?.a }));
          added.forEach((op, line) => rows.push({ kind: 'add', b: op.b, text: b[op.b], parts: marks[line]?.b }));
        }
      }
      position = range.end + 1;
    }
    fold(position, ops.length - 1);
    return rows;
  }

  const eolNote = () => h('span', { class: 'diff__eol' }, 'No newline at end of file');

  function renderText(result, { mode, whole, expanded }) {
    const rows = lineRows(result, { whole, mode });
    const body = h('tbody');
    let shown = 0;
    const expandFold = row => {
      const lines = [];
      for (let index = row.from; index <= row.to; index += 1) {
        const op = result.ops[index];
        lines.push({ kind: 'eq', a: op.a, b: op.b, text: result.a[op.a] });
      }
      return lines;
    };
    const flat = [];
    for (const row of rows) {
      if (row.kind === 'fold' && expanded.has(row.from)) flat.push(...expandFold(row));
      else flat.push(row);
    }
    for (const row of flat) {
      if (shown >= MAX_ROWS) break;
      shown += 1;
      if (row.kind === 'fold') {
        const colspan = mode === 'split' ? 4 : 3;
        body.append(h('tr', { class: 'diff__fold' }, h('td', { colspan },
          h('button', { type: 'button', 'data-fold': row.from, class: 'diff__expand' }, icon('chevron-down'), `${row.count.toLocaleString('en-US')} unchanged line${row.count === 1 ? '' : 's'}`))));
      } else if (mode === 'split') {
        const left = row.left;
        const right = row.right;
        const kind = row.kind === 'eq' ? 'eq' : (left && right ? 'mod' : (left ? 'del' : 'add'));
        if (row.kind === 'eq') {
          const missing = result.aNoEol && row.a === result.a.length - 1;
          body.append(h('tr', { class: 'diff__row diff__row--eq' }, h('td', { class: 'diff__n' }, row.a + 1), h('td', { class: 'diff__text' }, row.text, missing ? eolNote() : null), h('td', { class: 'diff__n' }, row.b + 1), h('td', { class: 'diff__text' }, row.text, missing ? eolNote() : null)));
        } else {
          const leftMissing = left && result.aNoEol && left.n === result.a.length - 1;
          const rightMissing = right && result.bNoEol && right.n === result.b.length - 1;
          body.append(h('tr', { class: ['diff__row', `diff__row--${kind}`] },
            h('td', { class: ['diff__n', left ? 'is-del' : 'is-empty'] }, left ? left.n + 1 : ''), h('td', { class: ['diff__text', left ? 'is-del' : 'is-empty'] }, left ? [left.parts ? words(left.parts) : left.text, leftMissing ? eolNote() : null] : ''),
            h('td', { class: ['diff__n', right ? 'is-add' : 'is-empty'] }, right ? right.n + 1 : ''), h('td', { class: ['diff__text', right ? 'is-add' : 'is-empty'] }, right ? [right.parts ? words(right.parts) : right.text, rightMissing ? eolNote() : null] : '')));
        }
      } else {
        const sign = row.kind === 'del' ? '−' : (row.kind === 'add' ? '+' : '');
        const missing = (row.a !== undefined && result.aNoEol && row.a === result.a.length - 1 && row.kind !== 'add')
          || (row.kind === 'add' && result.bNoEol && row.b === result.b.length - 1);
        body.append(h('tr', { class: ['diff__row', `diff__row--${row.kind}`] },
          h('td', { class: 'diff__n' }, row.a !== undefined ? row.a + 1 : ''), h('td', { class: 'diff__n' }, row.b !== undefined ? row.b + 1 : ''),
          h('td', { class: 'diff__text' }, h('span', { class: 'diff__sign', 'aria-hidden': 'true' }, sign), row.parts ? words(row.parts) : row.text, missing ? eolNote() : null)));
      }
    }
    const more = flat.length > shown ? h('p', { class: 'diff__note' }, `The first ${MAX_ROWS.toLocaleString('en-US')} rows show. Download the versions to read the rest.`) : null;
    const head = mode === 'split'
      ? h('thead', {}, h('tr', {}, h('th', { colspan: 2 }, 'From'), h('th', { colspan: 2 }, 'To')))
      : null;
    // The columns of the numbers are narrow and the texts share the rest, so the text starts at the left of each side.
    const columns = mode === 'split'
      ? h('colgroup', {}, h('col', { class: 'diff__col-n' }), h('col'), h('col', { class: 'diff__col-n' }), h('col'))
      : null;
    return h('div', { class: 'diff__scroll' }, h('table', { class: ['diff__table', mode === 'split' && 'is-split'] }, columns, head, body), more);
  }

  // The tree of two JSON documents: every path with its state (added, removed, changed, the same). A branch with a change
  // is open. The branches without change are closed, and a click opens them.
  const TREE_LIMIT = 500;

  function jsonTree(before, after) {
    const container = value => value !== null && typeof value === 'object';
    const entries = value => (Array.isArray(value) ? value.map((item, index) => [`[${index}]`, item]) : Object.entries(value));
    const node = (label, a, b, hasA, hasB) => {
      if (!hasB) return { label, status: 'removed', a };
      if (!hasA) return { label, status: 'added', b };
      if (container(a) && container(b) && Array.isArray(a) === Array.isArray(b)) {
        const children = [];
        if (Array.isArray(a)) {
          for (let index = 0; index < Math.max(a.length, b.length); index += 1) children.push(node(`[${index}]`, a[index], b[index], index < a.length, index < b.length));
        } else {
          for (const key of Object.keys(a)) children.push(node(key, a[key], b[key], true, key in b));
          for (const key of Object.keys(b)) if (!(key in a)) children.push(node(key, undefined, b[key], false, true));
        }
        return { label, status: children.some(child => child.status !== 'same') ? 'changed' : 'same', a, b, children };
      }
      return { label, status: BB.diff.canonicalJSON(a) === BB.diff.canonicalJSON(b) ? 'same' : 'changed', a, b };
    };
    return { node: node('$', before, after, true, true), container, entries };
  }

  function renderJSONTree(aText, bText, { whole }) {
    let tree;
    try { tree = jsonTree(JSON.parse(aText), JSON.parse(bText)); } catch (error) { return h('p', { class: 'diff__empty is-error' }, String(error?.message || error)); }
    const { container, entries } = tree;
    const marks = { added: '+', removed: '−', changed: '~', same: '' };
    const summary = value => {
      if (Array.isArray(value)) return `[…] ${value.length} item${value.length === 1 ? '' : 's'}`;
      if (container(value)) { const count = Object.keys(value).length; return `{…} ${count} key${count === 1 ? '' : 's'}`; }
      const text = JSON.stringify(value);
      return text.length > 120 ? `${text.slice(0, 117)}…` : text;
    };
    const childrenOf = item => {
      if (item.children) return item.children;
      if (item.status === 'added' && container(item.b)) return entries(item.b).map(([label, value]) => ({ label, status: 'added', b: value }));
      if (item.status === 'removed' && container(item.a)) return entries(item.a).map(([label, value]) => ({ label, status: 'removed', a: value }));
      return [];
    };
    const valueOf = item => {
      if (item.status === 'added') return h('code', { class: 'jsonTree__value is-add' }, summary(item.b));
      if (item.status === 'removed') return h('code', { class: 'jsonTree__value is-del' }, summary(item.a));
      if (item.status === 'same') return h('code', { class: 'jsonTree__value' }, summary(item.a));
      if (container(item.a) && container(item.b) && Array.isArray(item.a) === Array.isArray(item.b)) return h('code', { class: 'jsonTree__value' }, summary(item.b));
      return h('span', { class: 'jsonTree__change' }, h('code', { class: 'jsonTree__value is-del' }, summary(item.a)), icon('arrow-right'), h('span', { class: 'visually-hidden' }, ' to '), h('code', { class: 'jsonTree__value is-add' }, summary(item.b)));
    };
    const list = (items, showSame) => {
      const ul = h('ul', { class: 'jsonTree__list', role: 'group' });
      const shown = showSame ? items : items.filter(child => child.status !== 'same');
      shown.slice(0, TREE_LIMIT).forEach(child => ul.append(row(child)));
      if (shown.length > TREE_LIMIT) ul.append(h('li', { class: 'jsonTree__more' }, `${(shown.length - TREE_LIMIT).toLocaleString('en-US')} more`));
      const hidden = items.length - shown.length;
      if (hidden > 0) {
        const button = h('button', { type: 'button', class: 'jsonTree__same', onclick: () => ul.replaceWith(list(items, true)) }, `${hidden.toLocaleString('en-US')} unchanged`);
        ul.append(h('li', {}, button));
      }
      return ul;
    };
    const row = (item, open = false) => {
      const kids = childrenOf(item);
      const expandable = kids.length > 0;
      const li = h('li', { class: `jsonTree__node jsonTree__node--${item.status}`, role: 'treeitem' });
      const toggle = expandable
        ? h('button', { type: 'button', class: 'jsonTree__toggle', 'aria-expanded': 'false', 'aria-label': `Open ${item.label}` }, icon('chevron-down'))
        : h('span', { class: 'jsonTree__toggle jsonTree__toggle--leaf' });
      li.append(h('div', { class: 'jsonTree__row' }, toggle,
        h('span', { class: 'jsonTree__mark', 'aria-hidden': 'true' }, marks[item.status]),
        h('code', { class: 'jsonTree__label' }, item.label), valueOf(item)));
      if (expandable) {
        let body = null;
        const set = expanded => {
          toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          toggle.classList.toggle('is-open', expanded);
          if (expanded && !body) { body = list(kids, whole || item.status !== 'changed'); li.append(body); }
          if (body) body.hidden = !expanded;
        };
        toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
        set(open || item.status === 'changed');
      }
      return li;
    };
    const root = tree.node;
    if (root.status === 'same') return h('p', { class: 'diff__empty' }, 'The two documents have the same content. Only the format or the order of the keys changed.');
    return h('div', { class: 'diff__scroll' }, h('ul', { class: 'jsonTree', role: 'tree' }, row(root, true)));
  }

  function renderCSV(result, { whole }) {
    const rows = result.rows;
    const keep = new Set();
    rows.forEach((row, index) => {
      if (index === 0 || row.type !== 'eq') for (let near = Math.max(0, index - 2); near <= Math.min(rows.length - 1, index + 2); near += 1) keep.add(near);
    });
    const body = h('tbody');
    let skipped = 0;
    let shown = 0;
    const flushSkipped = () => {
      if (!skipped) return;
      body.append(h('tr', { class: 'diff__fold' }, h('td', { colspan: result.columns + 1 }, h('span', { class: 'diff__expand is-static' }, `${skipped.toLocaleString('en-US')} unchanged row${skipped === 1 ? '' : 's'}`))));
      skipped = 0;
    };
    rows.forEach((row, index) => {
      if (!whole && !keep.has(index)) { skipped += 1; return; }
      flushSkipped();
      if (shown >= MAX_ROWS) return;
      shown += 1;
      const marks = { eq: '', add: '+', del: '−', mod: '~' };
      const cells = [];
      for (let column = 0; column < result.columns; column += 1) {
        if (row.type === 'mod' && row.cells[column]) {
          cells.push(h('td', { class: 'csvCell csvCell--changed' }, h('del', {}, row.before[column] ?? ''), icon('arrow-right'), h('span', { class: 'visually-hidden' }, ' to '), h('ins', {}, row.after[column] ?? '')));
        } else {
          const value = (row.after || row.before)[column] ?? '';
          cells.push(h('td', { class: 'csvCell' }, value));
        }
      }
      body.append(h('tr', { class: ['diff__row', `diff__row--${row.type}`, index === 0 && 'is-head'] }, h('td', { class: 'diff__sign' }, marks[row.type]), cells));
    });
    flushSkipped();
    const note = shown >= MAX_ROWS ? h('p', { class: 'diff__note' }, `The first ${MAX_ROWS.toLocaleString('en-US')} rows show.`) : null;
    return h('div', { class: 'diff__scroll' }, h('table', { class: 'diff__table diff__table--csv' }, body), note);
  }

  // The patch of git, with its lines coloured.
  function renderPatch(patch) {
    const lines = patch.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const kindOf = line => {
      if (line.startsWith('@@')) return 'hunk';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
      if (line.startsWith('+')) return 'add';
      if (line.startsWith('-')) return 'del';
      if (line.startsWith('\\')) return 'note';
      return 'ctx';
    };
    const pre = h('pre', { class: 'gitPatch', tabindex: '0', 'aria-label': 'Patch in the format of git' });
    for (const line of lines.slice(0, MAX_ROWS * 2)) pre.append(h('span', { class: `gitPatch__line gitPatch__line--${kindOf(line)}` }, `${line}\n`));
    return h('div', { class: 'diff__scroll' }, pre, lines.length > MAX_ROWS * 2 ? h('p', { class: 'diff__note' }, 'The patch is longer than the page shows. Download it.') : null);
  }

  // Two tables of rows, side by side: the rows before at the left, the rows after at the right.
  function renderCSVSplit(result, { whole }) {
    const rows = result.rows;
    const keep = new Set();
    rows.forEach((row, index) => {
      if (index === 0 || row.type !== 'eq') for (let near = Math.max(0, index - 2); near <= Math.min(rows.length - 1, index + 2); near += 1) keep.add(near);
    });
    const body = h('tbody');
    let skipped = 0;
    let shown = 0;
    const flush = () => {
      if (!skipped) return;
      body.append(h('tr', { class: 'diff__fold' }, h('td', { colspan: result.columns * 2 + 2 }, h('span', { class: 'diff__expand is-static' }, `${skipped.toLocaleString('en-US')} unchanged row${skipped === 1 ? '' : 's'}`))));
      skipped = 0;
    };
    const side = (row, values, tone, changed) => {
      const cells = [h('td', { class: ['diff__n', values ? tone : 'is-empty'] }, values ? (tone === 'is-del' ? row.aIndex + 1 : row.bIndex + 1) : '')];
      for (let column = 0; column < result.columns; column += 1) {
        cells.push(h('td', { class: ['csvCell', values ? tone : 'is-empty', values && changed && changed[column] && 'csvCell--cut'] }, values ? (values[column] ?? '') : ''));
      }
      return cells;
    };
    rows.forEach((row, index) => {
      if (!whole && !keep.has(index)) { skipped += 1; return; }
      flush();
      if (shown >= MAX_ROWS) return;
      shown += 1;
      const tones = { eq: ['', ''], add: ['is-empty', 'is-add'], del: ['is-del', 'is-empty'], mod: ['is-del', 'is-add'] }[row.type];
      const leftValues = row.type === 'add' ? null : row.before;
      const rightValues = row.type === 'del' ? null : row.after;
      const leftCells = row.type === 'eq' ? side(row, leftValues, '', null) : side(row, leftValues, tones[0] || 'is-del', row.cells);
      const rightCells = row.type === 'eq' ? side(row, rightValues, '', null) : side(row, rightValues, tones[1] || 'is-add', row.cells);
      if (row.type === 'eq') { leftCells[0] = h('td', { class: 'diff__n' }, row.aIndex + 1); rightCells[0] = h('td', { class: 'diff__n' }, row.bIndex + 1); }
      body.append(h('tr', { class: ['diff__row', `diff__row--${row.type}`, index === 0 && 'is-head'] }, leftCells, rightCells));
    });
    flush();
    const head = h('thead', {}, h('tr', {}, h('th', { colspan: result.columns + 1 }, 'From'), h('th', { colspan: result.columns + 1 }, 'To')));
    return h('div', { class: 'diff__scroll' }, h('table', { class: 'diff__table diff__table--csv diff__table--csvsplit' }, head, body));
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/x-diff;charset=utf-8' }));
    const anchor = h('a', { href: url, download: name, hidden: true });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const area = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' });
      area.value = text;
      document.body.append(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (__) { copied = false; }
      area.remove();
      return copied;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The comparison, drawn in a host of the page
  // ---------------------------------------------------------------------------------------------------------------

  // The address of the comparison: the preview page of the version "to", with the version "from" in the parameter compare.
  function compareURL({ key, instance = null, from, to }) {
    return BB.api.previewPageURL(key, { instance, version: to, compare: from });
  }

  // Draws the comparison of two versions in the element host. The result has destroy(), which stops the reads.
  // onChange({ from, to }) runs when the person chooses other versions. With slots ({ from, summary, to }, three elements of the page) the pickers and the summary go there.
  function mountCompare(host, { key, instance = null, versions, from = '', to = '', onBytes = null, onChange = null, slots = null }) {
    const list = listVersions(versions);
    const find = id => list.find(version => version.version === id) || null;
    let right = find(to) || list.find(version => version.isCurrent) || list[0];
    let left = find(from) || right?.older || list.find(version => version !== right);
    if (!left || !right) return null;
    const cache = new Map();
    const controller = new AbortController();
    const state = { view: 'split', mode: 'beautify', whole: false, sortKeys: true, expanded: new Set(), run: 0 };
    const kind = kindOf(key);

    host.classList.add('versionDiff');
    const root = host;
    let leftId = left.version;
    let rightId = right.version;
    const fromHost = slots?.from || h('div');
    const toHost = slots?.to || h('div');
    fromHost.classList.add('versionDiff__from');
    toHost.classList.add('versionDiff__to');
    const mountPickers = () => {
      mountPicker(fromHost, { versions, selected: leftId, caption: 'From', explicit: true, compact: true, onSelect: id => { leftId = id; mountPickers(); render(); } });
      mountPicker(toHost, { versions, selected: rightId, caption: 'To', explicit: true, compact: true, onSelect: id => { rightId = id; mountPickers(); render(); } });
    };
    const swap = h('button', { type: 'button', class: 'iconButton versionDiff__swap', title: 'Swap the two versions', 'aria-label': 'Swap the two versions' }, icon('arrows-left-right'));
    const summary = h('div', { class: 'versionDiff__summary', role: 'status', 'aria-live': 'polite' });
    const options = h('div', { class: 'versionDiff__options' });
    const view = h('div', { class: 'versionDiff__view' });
    if (slots) {
      // The statistics are between the version From and the version To.
      slots.summary.replaceChildren(swap, summary);
      root.replaceChildren(options, view);
    } else {
      root.replaceChildren(h('div', { class: 'versionDiff__bar' }, h('div', { class: 'versionDiff__pick' }, fromHost, swap, toHost), summary), options, view);
    }
    mountPickers();

    const segmented = (name, choices, current, onPick) => h('div', { class: 'segmented', role: 'group', 'aria-label': name },
      choices.map(([value, text, iconName]) => h('button', { type: 'button', class: ['segmented__item', value === current && 'is-active'], 'aria-pressed': value === current ? 'true' : 'false', 'data-value': value, onclick: () => onPick(value) }, iconName ? icon(iconName) : null, text)));

    async function load(version) {
      if (!cache.has(version.version)) cache.set(version.version, readVersion(key, version, instance, controller.signal));
      return cache.get(version.version);
    }

    let drawCurrent = null;
    view.addEventListener('click', event => {
      const fold = event.target.closest('[data-fold]');
      if (!fold || !drawCurrent) return;
      state.expanded.add(Number(fold.dataset.fold));
      drawCurrent();
    });

    async function render() {
      const run = ++state.run;
      state.expanded.clear();
      drawCurrent = null;
      left = find(leftId);
      right = find(rightId);
      if (onChange) onChange({ from: left.version, to: right.version });
      view.replaceChildren(h('p', { class: 'diff__empty' }, 'Reading the two versions…'));
      summary.replaceChildren();
      options.replaceChildren();
      const metadata = h('span', { class: 'versionDiff__meta' },
        formatDelta(Number(right.size) - Number(left.size)));
      if (left === right) { view.replaceChildren(h('p', { class: 'diff__empty' }, 'Choose two different versions.')); return; }
      let a;
      let b;
      try {
        [a, b] = await Promise.all([load(left), load(right)]);
      } catch (error) {
        if (run === state.run) view.replaceChildren(h('p', { class: 'diff__empty is-error' }, String(error?.message || error)));
        return;
      }
      if (run !== state.run) return;
      const unsupported = (message) => {
        fill(summary, metadata);
        const actions = onBytes ? h('button', { type: 'button', class: 'bb-btn', onclick: () => onBytes(left, right) }, icon('git-compare'), h('span', {}, 'Compare the bytes')) : null;
        view.replaceChildren(h('div', { class: 'diff__empty' }, h('p', {}, message), ...(actions ? [actions] : [])));
      };
      if (a.tooLarge || b.tooLarge) return unsupported(`A version is larger than ${formatBytes(MAX_BYTES)} (${formatBytes(Math.max(a.size || 0, b.size || 0))}): the page does not read it for a comparison.`);
      if (a.binary || b.binary) return unsupported('A version is not text. The page compares text, JSON and CSV.');

      if (a.text === b.text) {
        fill(summary, metadata, h('span', { class: 'versionDiff__same' }, icon('check'), 'The content is the same.'));
        view.replaceChildren(h('p', { class: 'diff__empty' }, 'The two versions have the same content.'));
        return;
      }
      const draw = () => {
        const note = text => h('span', { class: 'versionDiff__note' }, text);
        let aText = a.text;
        let bText = b.text;
        let json = null;
        // A JSON document has the modes of the preview: Raw (the text as stored), Beautify (indented) and Tree (the paths).
        if (kind === 'json') {
          json = BB.diff.diffJSON(a.text, b.text);
          if (json.valid && state.mode !== 'raw') {
            const sort = state.sortKeys || state.mode === 'tree';
            aText = BB.diff.prettyJSON(a.text, { sort });
            bText = BB.diff.prettyJSON(b.text, { sort });
          }
        }
        const tree = Boolean(json?.valid) && state.mode === 'tree';
        const views = kind === 'csv'
          ? [['split', 'Side by side', 'layout-columns'], ['table', 'Table', 'layout-rows'], ['git', 'Patch', 'git-compare']]
          : [['split', 'Side by side', 'layout-columns'], ['unified', 'Unified', 'layout-rows'], ['git', 'Patch', 'git-compare']];
        if (!views.some(([value]) => value === state.view)) state.view = 'split';
        const lines = BB.diff.diffLines(aText, bText);
        const patch = () => BB.diff.unifiedPatch(lines, { aPath: key, aId: blobId(left), bId: blobId(right) });
        const csv = kind === 'csv' ? BB.diff.diffDelimited(a.text, b.text, BB.diff.delimiterOf(key)) : null;

        if (csv) {
          fill(summary, metadata, stat(`${csv.stats.added.toLocaleString('en-US')} added`, 'add'), stat(`${csv.stats.removed.toLocaleString('en-US')} removed`, 'del'), stat(`${csv.stats.modified.toLocaleString('en-US')} modified`, 'mod'));
        } else {
          fill(summary, metadata,
            json?.valid ? stat(`${json.changes.length.toLocaleString('en-US')}${json.overflow ? '+' : ''} path${json.changes.length === 1 ? '' : 's'} changed`, 'mod') : null,
            stat(`+${lines.stats.added.toLocaleString('en-US')}`, 'add'), stat(`−${lines.stats.removed.toLocaleString('en-US')}`, 'del'),
            lines.truncated ? note('The two texts differ too much: the lines show as a replacement.') : null);
        }

        const actions = h('span', { class: 'versionDiff__actions' },
          h('button', { type: 'button', class: 'bb-btn', 'data-diff-copy': '', onclick: async () => { const done = await copyText(patch()); BB.ui.toast(done ? 'The patch is in the clipboard.' : 'The browser refused to copy the patch.', { status: done ? 'success' : 'error', duration: 2500 }); } }, icon('git-compare'), h('span', {}, 'Copy patch')),
          h('button', { type: 'button', class: 'bb-btn', 'data-diff-download': '', onclick: () => download(`${key.split('/').pop() || 'file'}.patch`, patch()) }, icon('arrow-down'), h('span', {}, 'Download .patch')));
        fill(options,
          json?.valid ? segmented('Format', [['raw', 'Raw'], ['beautify', 'Beautify'], ['tree', 'Tree']], state.mode, value => { state.mode = value; draw(); }) : null,
          tree ? null : segmented('View', views, state.view, value => { state.view = value; draw(); }),
          json && !json.valid ? note('A version is not valid JSON: the text shows as it is.') : null,
          json?.valid && state.mode === 'beautify' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.sortKeys, 'data-diff-sort': '', onchange: event => { state.sortKeys = event.target.checked; draw(); } }), h('span', {}, 'Sort the keys')) : null,
          tree || state.view === 'split' || state.view === 'unified' || state.view === 'table'
            ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.whole, 'data-diff-whole': '', onchange: event => { state.whole = event.target.checked; draw(); } }), h('span', {}, tree ? 'Show the unchanged values' : csv ? 'Show the unchanged rows' : 'Show the unchanged lines'))
            : null,
          tree ? null : actions);

        if (tree) view.replaceChildren(renderJSONTree(aText, bText, { whole: state.whole }));
        else if (state.view === 'git') view.replaceChildren(renderPatch(patch()));
        else if (csv && state.view === 'table') view.replaceChildren(renderCSV(csv, { whole: state.whole }));
        else if (csv) view.replaceChildren(renderCSVSplit(csv, { whole: state.whole }));
        else view.replaceChildren(renderText(lines, { mode: state.view === 'unified' ? 'unified' : 'split', whole: state.whole, expanded: state.expanded }));
      };
      drawCurrent = draw;
      draw();
    }

    const stat = (text, type) => h('span', { class: `diffStat diffStat--${type}` }, text);
    swap.addEventListener('click', () => { [leftId, rightId] = [rightId, leftId]; mountPickers(); render(); });
    render();
    return { destroy() { controller.abort(); state.run += 1; for (const picker of [fromHost, toHost]) { picker.picker?.close(); picker.picker?.menu.remove(); } host.replaceChildren(); if (slots) { slots.from.replaceChildren(); slots.summary.replaceChildren(); slots.from.classList.remove('versionDiff__from'); slots.to.classList.remove('versionDiff__to'); } } };
  }

  BB.versions = { listVersions, mountPicker, mountCompare, compareURL, kindOf, formatBytes, formatDate };
})();
