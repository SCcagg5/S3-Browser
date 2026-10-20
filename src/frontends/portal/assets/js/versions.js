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
    for (const child of children.flat()) {
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

  const versionLabel = version => `v${version.number}`;

  // ---------------------------------------------------------------------------------------------------------------
  // Version picker (file details)
  // ---------------------------------------------------------------------------------------------------------------

  function mountPicker(host, { versions, selected = '', onSelect, onCompare }) {
    const list = listVersions(versions);
    if (!list.length) { host.hidden = true; return; }
    const current = list.find(version => version.isCurrent) || list[0];
    const active = list.find(version => version.version === selected) || current;

    const label = h('span', { class: 'versionPicker__label' },
      h('strong', {}, versionLabel(active)),
      active === current ? h('span', { class: 'versionPicker__tag' }, 'Current') : h('span', { class: 'versionPicker__tag versionPicker__tag--old' }, 'Older'),
      h('span', { class: 'versionPicker__date' }, formatDate(active.lastModified)));
    const button = h('button', { type: 'button', class: 'versionPicker__button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: `${list.length} versions` },
      icon('source-commit'), label, h('span', { class: 'versionPicker__count' }, `${list.length}`), icon('chevron-down'));

    const items = list.map(version => {
      const isActive = version === active;
      return h('button', {
        type: 'button', class: ['versionPicker__item', isActive && 'is-active'], role: 'option', 'aria-selected': isActive ? 'true' : 'false', 'data-version': version.version,
        onclick: () => { close(); if (version !== active) onSelect?.(version === current ? '' : version.version); }
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
    const compare = h('button', { type: 'button', class: 'versionPicker__compare', disabled: list.length < 2, onclick: () => { close(); onCompare?.({ to: active.version, from: (active.older || list.find(version => version !== active))?.version }); } },
      icon('git-compare'), h('span', {}, active.older ? `Compare ${versionLabel(active)} with ${versionLabel(active.older)}` : 'Compare versions'));
    const menu = h('div', { class: 'versionPicker__menu', role: 'listbox', 'aria-label': 'Versions of the object', hidden: true },
      h('div', { class: 'versionPicker__list' }, items), h('div', { class: 'versionPicker__foot' }, compare));

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
      const focusable = [...menu.querySelectorAll('.versionPicker__item, .versionPicker__compare:not(:disabled)')];
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
    host.picker = { close };
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

  // The cell of a line of text, with the changed words marked.
  const textCell = row => h('td', { class: 'diff__text' }, row.parts ? words(row.parts) : row.text);

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
          body.append(h('tr', { class: 'diff__row diff__row--eq' }, h('td', { class: 'diff__n' }, row.a + 1), h('td', { class: 'diff__text' }, row.text), h('td', { class: 'diff__n' }, row.b + 1), h('td', { class: 'diff__text' }, row.text)));
        } else {
          body.append(h('tr', { class: ['diff__row', `diff__row--${kind}`] },
            h('td', { class: ['diff__n', left && 'is-del'] }, left ? left.n + 1 : ''), h('td', { class: ['diff__text', left && 'is-del'] }, left ? (left.parts ? words(left.parts) : left.text) : ''),
            h('td', { class: ['diff__n', right && 'is-add'] }, right ? right.n + 1 : ''), h('td', { class: ['diff__text', right && 'is-add'] }, right ? (right.parts ? words(right.parts) : right.text) : '')));
        }
      } else {
        const sign = row.kind === 'del' ? '−' : (row.kind === 'add' ? '+' : '');
        body.append(h('tr', { class: ['diff__row', `diff__row--${row.kind}`] },
          h('td', { class: 'diff__n' }, row.a !== undefined ? row.a + 1 : ''), h('td', { class: 'diff__n' }, row.b !== undefined ? row.b + 1 : ''),
          h('td', { class: 'diff__text' }, h('span', { class: 'diff__sign', 'aria-hidden': 'true' }, sign), row.parts ? words(row.parts) : row.text)));
      }
    }
    const more = flat.length > shown ? h('p', { class: 'diff__note' }, `The first ${MAX_ROWS.toLocaleString('en-US')} rows show. Download the versions to read the rest.`) : null;
    const head = mode === 'split'
      ? h('thead', {}, h('tr', {}, h('th', { colspan: 2 }, 'From'), h('th', { colspan: 2 }, 'To')))
      : null;
    return h('div', { class: 'diff__scroll' }, h('table', { class: ['diff__table', mode === 'split' && 'is-split'] }, head, body), more);
  }

  function renderJSONChanges(result) {
    const verbs = { added: 'Added', removed: 'Removed', changed: 'Changed' };
    const marks = { added: '+', removed: '−', changed: '~' };
    const compact = value => {
      const text = JSON.stringify(value);
      return text.length > 140 ? `${text.slice(0, 137)}…` : text;
    };
    const rows = result.changes.map(change => h('li', { class: `jsonChange jsonChange--${change.type}` },
      h('span', { class: 'jsonChange__mark', 'aria-hidden': 'true' }, marks[change.type]),
      h('span', { class: 'jsonChange__verb' }, verbs[change.type]),
      h('code', { class: 'jsonChange__path' }, change.path),
      change.type === 'changed'
        ? h('span', { class: 'jsonChange__values' }, h('code', { class: 'is-del' }, compact(change.before)), icon('arrow-right'), h('span', { class: 'visually-hidden' }, ' to '), h('code', { class: 'is-add' }, compact(change.after)))
        : h('span', { class: 'jsonChange__values' }, h('code', { class: change.type === 'added' ? 'is-add' : 'is-del' }, compact(change.type === 'added' ? change.after : change.before)))));
    return h('div', { class: 'diff__scroll' },
      rows.length ? h('ul', { class: 'jsonChanges' }, rows) : h('p', { class: 'diff__empty' }, 'The two documents have the same content. Only the format or the order of the keys changed.'),
      result.overflow ? h('p', { class: 'diff__note' }, `The list stops at ${result.changes.length} changes. Open the text view for the rest.`) : null);
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

  // ---------------------------------------------------------------------------------------------------------------
  // The comparison dialog
  // ---------------------------------------------------------------------------------------------------------------

  function openCompare({ key, instance = null, versions, from = '', to = '', onBytes = null }) {
    const list = listVersions(versions);
    const find = id => list.find(version => version.version === id) || null;
    let right = find(to) || list.find(version => version.isCurrent) || list[0];
    let left = find(from) || right?.older || list.find(version => version !== right);
    if (!left || !right) return Promise.resolve(false);
    const cache = new Map();
    const controller = new AbortController();
    const state = { mode: 'unified', whole: false, jsonView: 'changes', expanded: new Set(), run: 0 };
    const kind = kindOf(key);

    return BB.ui.alert({
      title: 'Compare versions',
      html: '<div class="versionDiff" data-version-diff></div>',
      onOpen: ({ overlay, modal }) => {
        modal?.classList.add('bb-modal--wide', 'bb-modal--diff');
        const root = overlay.querySelector('[data-version-diff]');
        const option = version => h('option', { value: version.version }, `${versionLabel(version)} · ${formatDate(version.lastModified)} · ${formatBytes(version.size)}${version.isCurrent ? ' · current' : ''}`);
        const selectFor = (label, chosen) => {
          const select = h('select', { class: 'versionDiff__select', 'aria-label': label }, list.map(option));
          select.value = chosen.version;
          return select;
        };
        const fromSelect = selectFor('From version', left);
        const toSelect = selectFor('To version', right);
        const swap = h('button', { type: 'button', class: 'iconButton versionDiff__swap', title: 'Swap the two versions', 'aria-label': 'Swap the two versions' }, icon('arrows-left-right'));
        const summary = h('div', { class: 'versionDiff__summary', role: 'status', 'aria-live': 'polite' });
        const options = h('div', { class: 'versionDiff__options' });
        const view = h('div', { class: 'versionDiff__view' });
        root.replaceChildren(
          h('p', { class: 'versionDiff__file' }, icon('source-commit'), h('code', {}, key)),
          h('div', { class: 'versionDiff__pick' },
            h('label', {}, h('span', {}, 'From'), fromSelect), swap, h('label', {}, h('span', {}, 'To'), toSelect)),
          summary, options, view);

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
          left = find(fromSelect.value);
          right = find(toSelect.value);
          view.replaceChildren(h('p', { class: 'diff__empty' }, 'Reading the two versions…'));
          summary.replaceChildren();
          options.replaceChildren();
          const metadata = h('span', { class: 'versionDiff__meta' },
            `${versionLabel(left)} → ${versionLabel(right)} · ${formatDelta(Number(right.size) - Number(left.size))} · ${formatDate(left.lastModified)} → ${formatDate(right.lastModified)}`);
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
            options.replaceChildren();
            if (kind === 'csv') {
              const result = BB.diff.diffDelimited(a.text, b.text, BB.diff.delimiterOf(key));
              fill(summary, metadata, stat(`${result.stats.added.toLocaleString('en-US')} added`, 'add'), stat(`${result.stats.removed.toLocaleString('en-US')} removed`, 'del'), stat(`${result.stats.modified.toLocaleString('en-US')} modified`, 'mod'));
              options.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.whole, 'data-diff-whole': '', onchange: event => { state.whole = event.target.checked; draw(); } }), h('span', {}, 'Show the unchanged rows')));
              view.replaceChildren(renderCSV(result, { whole: state.whole }));
              return;
            }
            let json = null;
            if (kind === 'json') {
              json = BB.diff.diffJSON(a.text, b.text);
              if (!json.valid) options.append(note('A version is not valid JSON: the text view shows the lines.'));
            }
            const lines = json?.valid ? json.lines : BB.diff.diffLines(a.text, b.text);
            const stats = lines.stats;
            fill(summary, metadata,
              json?.valid ? stat(`${json.changes.length.toLocaleString('en-US')}${json.overflow ? '+' : ''} path${json.changes.length === 1 ? '' : 's'} changed`, 'mod') : null,
              stat(`+${stats.added.toLocaleString('en-US')}`, 'add'), stat(`−${stats.removed.toLocaleString('en-US')}`, 'del'),
              lines.truncated ? note('The two texts differ too much: the lines show as a replacement.') : null);
            if (json?.valid) {
              options.append(segmented('JSON view', [['changes', 'Changes'], ['text', 'Text (sorted keys)']], state.jsonView, value => { state.jsonView = value; draw(); }));
              if (state.jsonView === 'changes') { view.replaceChildren(renderJSONChanges(json)); return; }
            }
            options.append(segmented('Layout', [['unified', 'Unified', 'layout-rows'], ['split', 'Side by side', 'layout-columns']], state.mode, value => { state.mode = value; draw(); }),
              h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.whole, 'data-diff-whole': '', onchange: event => { state.whole = event.target.checked; draw(); } }), h('span', {}, 'Show the unchanged lines')));
            view.replaceChildren(renderText(lines, { mode: state.mode, whole: state.whole, expanded: state.expanded }));
          };
          drawCurrent = draw;
          draw();
        }

        const stat = (text, type) => h('span', { class: `diffStat diffStat--${type}` }, text);
        fromSelect.addEventListener('change', render);
        toSelect.addEventListener('change', render);
        swap.addEventListener('click', () => { const keep = fromSelect.value; fromSelect.value = toSelect.value; toSelect.value = keep; render(); });
        render();
      }
    }).then(() => { controller.abort(); return true; });
  }

  BB.versions = { listVersions, mountPicker, openCompare, kindOf, formatBytes, formatDate };
})();
