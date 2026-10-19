/* Local CSV/JSON Lines viewer plus a lazy, range-based Apache Parquet reader. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const MAX_TEXT_BYTES = 32 * 1024 * 1024;
  const MAX_SPREADSHEET_BYTES = 64 * 1024 * 1024;
  const MAX_ROWS = 100000;
  const MAX_COLUMNS = 200;
  const DEFAULT_PAGE_SIZE = 100;
  const PAGE_SIZE_OPTIONS = [100, 250, 500, 1000];
  const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/;

  function displayValue(value) {
    if (value == null) return '';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      try { return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item); }
      catch (_) { return String(value); }
    }
    return String(value);
  }

  function isEmptyCell(value) {
    return displayValue(value).trim() === '';
  }

  function uniqueHeaders(values) {
    const seen = new Map();
    return values.map((raw, index) => {
      const base = String(raw == null || raw === '' ? `column_${index + 1}` : raw);
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      return count === 1 ? base : `${base}_${count}`;
    });
  }

  function classifyValue(value) {
    const text = displayValue(value).trim();
    if (!text) return { kind: 'empty', text, value: '' };
    if (NUMBER_PATTERN.test(text)) {
      const number = Number(text);
      if (Number.isFinite(number)) return { kind: 'number', text, value: number };
    }
    const lower = text.toLowerCase();
    if (lower === 'true' || lower === 'false') return { kind: 'boolean', text, value: lower === 'true' ? 1 : 0 };
    if (DATE_PATTERN.test(text)) {
      const timestamp = Date.parse(text);
      if (Number.isFinite(timestamp)) return { kind: 'date', text, value: timestamp };
    }
    return { kind: 'text', text, value: text };
  }

  function compareTableValues(left, right) {
    const a = classifyValue(left);
    const b = classifyValue(right);
    if (a.kind === 'empty' && b.kind === 'empty') return 0;
    if (a.kind === 'empty') return 1;
    if (b.kind === 'empty') return -1;
    if (a.kind === b.kind && a.kind !== 'text') return a.value - b.value;
    return COLLATOR.compare(a.text, b.text);
  }

  function parseColumnFilter(rawFilter) {
    const text = String(rawFilter || '').trim();
    if (!text) return null;
    const match = text.match(/^(>=|<=|!=|=|>|<)\s*(.*)$/);
    if (match) return { operator: match[1], value: match[2] };
    return { operator: 'contains', value: text };
  }

  function comparableFilterResult(leftText, rightText) {
    const left = classifyValue(leftText);
    const right = classifyValue(rightText);
    if (left.kind === 'empty' || right.kind === 'empty') return null;
    if (right.kind === 'number' || right.kind === 'boolean' || right.kind === 'date') {
      if (left.kind !== right.kind) return null;
      return left.value - right.value;
    }
    return COLLATOR.compare(left.text, right.text);
  }

  function matchesColumnFilter(value, rawFilter) {
    const filter = parseColumnFilter(rawFilter);
    if (!filter) return true;

    const leftText = displayValue(value).trim();
    const rightText = displayValue(filter.value).trim();
    if (filter.operator === 'contains') return leftText.toLowerCase().includes(rightText.toLowerCase());
    if (filter.operator === '=') return COLLATOR.compare(leftText, rightText) === 0;
    if (filter.operator === '!=') return COLLATOR.compare(leftText, rightText) !== 0;

    const comparison = comparableFilterResult(leftText, rightText);
    if (comparison == null) return false;
    if (filter.operator === '>') return comparison > 0;
    if (filter.operator === '>=') return comparison >= 0;
    if (filter.operator === '<') return comparison < 0;
    if (filter.operator === '<=') return comparison <= 0;
    return true;
  }

  function queryTableEntries(rows, state = {}) {
    const filters = Array.isArray(state.filters) ? state.filters : [];
    const globalQuery = String(state.globalQuery || '').trim().toLowerCase();
    const activeFilters = filters
      .map((value, index) => ({ index, value: String(value || '').trim() }))
      .filter(item => item.value !== '');

    const entries = rows.map((row, sourceIndex) => ({ row, sourceIndex })).filter(entry => {
      if (globalQuery && !entry.row.some(value => displayValue(value).toLowerCase().includes(globalQuery))) return false;
      return activeFilters.every(filter => matchesColumnFilter(entry.row[filter.index], filter.value));
    });

    const sortColumn = Number(state.sortColumn);
    const sortDirection = state.sortDirection === 'desc' ? 'desc' : (state.sortDirection === 'asc' ? 'asc' : '');
    if (Number.isInteger(sortColumn) && sortColumn >= 0 && sortDirection) {
      entries.sort((left, right) => {
        const leftValue = left.row[sortColumn];
        const rightValue = right.row[sortColumn];
        const leftEmpty = classifyValue(leftValue).kind === 'empty';
        const rightEmpty = classifyValue(rightValue).kind === 'empty';
        if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
        const comparison = compareTableValues(leftValue, rightValue);
        if (comparison !== 0) return sortDirection === 'desc' ? -comparison : comparison;
        return left.sourceIndex - right.sourceIndex;
      });
    }
    return entries;
  }

  function applyTableQuery(rows, state = {}) {
    return queryTableEntries(rows, state).map(entry => entry.row);
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (character === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index++;
          } else {
            quoted = false;
          }
        } else {
          field += character;
        }
        continue;
      }
      if (character === '"' && field === '') {
        quoted = true;
      } else if (character === delimiter) {
        row.push(field);
        field = '';
      } else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index++;
        row.push(field);
        rows.push(row);
        if (rows.length > MAX_ROWS + 1) break;
        row = [];
        field = '';
      } else {
        field += character;
      }
    }
    if (field !== '' || row.length || !rows.length) {
      row.push(field);
      rows.push(row);
    }
    if (quoted) throw new Error('The delimited file ends inside a quoted field.');
    return rows;
  }

  function delimiterScore(text, delimiter) {
    try {
      const rows = parseDelimited(text.slice(0, 128 * 1024), delimiter).slice(0, 25).filter(row => row.length > 1);
      if (!rows.length) return -1;
      const frequencies = new Map();
      rows.forEach(row => frequencies.set(row.length, (frequencies.get(row.length) || 0) + 1));
      const best = Math.max(...frequencies.values());
      return best * 100 + Math.max(...rows.map(row => row.length));
    } catch (_) {
      return -1;
    }
  }

  function detectDelimiter(text, extension) {
    if (extension === 'tsv' || extension === 'tab') return '\t';
    if (extension === 'psv') return '|';
    const candidates = [',', ';', '\t', '|'];
    return candidates.sort((a, b) => delimiterScore(text, b) - delimiterScore(text, a))[0];
  }

  function parseJSONLines(text) {
    const objects = [];
    const columns = [];
    const seen = new Set();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); }
      catch (error) { throw new Error(`Invalid JSON on line ${index + 1}: ${error.message}`); }
      const object = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
      for (const key of Object.keys(object)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
      objects.push({ value: object, sourceLine: index + 1 });
      if (objects.length >= MAX_ROWS) break;
    }
    const previewColumns = columns.slice(0, MAX_COLUMNS);
    const headers = previewColumns.filter(header =>
      objects.some(entry => !isEmptyCell(entry.value[header]))
    );
    const rows = [];
    const rowNumbers = [];
    for (const entry of objects) {
      const row = headers.map(header => displayValue(entry.value[header]));
      if (row.every(isEmptyCell)) continue;
      rows.push(row);
      rowNumbers.push(entry.sourceLine);
    }
    const truncatedColumns = columns.slice(MAX_COLUMNS).some(header =>
      objects.some(entry => !isEmptyCell(entry.value[header]))
    );
    return {
      headers,
      rows,
      rowNumbers,
      truncatedRows: objects.length >= MAX_ROWS,
      truncatedColumns
    };
  }

  function parseTextTable(text, extension) {
    if (extension === 'jsonl' || extension === 'ndjson') return parseJSONLines(text);
    const delimiter = detectDelimiter(text, extension);
    const parsed = parseDelimited(text, delimiter);
    if (!parsed.length) return { headers: [], rows: [], rowNumbers: [], delimiter };

    const rawHeaders = Array.from(parsed.shift() || []);
    const sourceRows = parsed.map((row, index) => ({ row: Array.from(row || []), sourceLine: index + 2 }));
    const sourceColumnCount = Math.max(rawHeaders.length, ...sourceRows.map(entry => entry.row.length), 0);
    const previewColumnCount = Math.min(MAX_COLUMNS, sourceColumnCount);
    while (rawHeaders.length < previewColumnCount) rawHeaders.push('');

    const activeColumns = [];
    for (let column = 0; column < previewColumnCount; column++) {
      const headerHasValue = !isEmptyCell(rawHeaders[column]);
      const dataHasValue = sourceRows.some(entry => !isEmptyCell(entry.row[column]));
      if (headerHasValue || dataHasValue) activeColumns.push(column);
    }

    const headers = uniqueHeaders(activeColumns.map((column, index) => {
      const value = displayValue(rawHeaders[column]).trim();
      return value || `column_${column + 1 || index + 1}`;
    }));
    const rows = [];
    const rowNumbers = [];
    for (const entry of sourceRows.slice(0, MAX_ROWS)) {
      const values = activeColumns.map(column => displayValue(entry.row[column]));
      if (values.every(isEmptyCell)) continue;
      rows.push(values);
      rowNumbers.push(entry.sourceLine);
    }

    const truncatedColumns = sourceRows.some(entry =>
      entry.row.slice(MAX_COLUMNS).some(value => !isEmptyCell(value))
    ) || rawHeaders.slice(MAX_COLUMNS).some(value => !isEmptyCell(value));

    return {
      headers,
      rows,
      rowNumbers,
      delimiter,
      truncatedRows: sourceRows.length > MAX_ROWS,
      truncatedColumns
    };
  }

  function createIcon(name) {
    const icon = document.createElement('i');
    icon.className = `mdi mdi-${name}`;
    return icon;
  }

  function gridValue(value) {
    if (value === null) return { text: 'null', kind: 'null' };
    if (value === undefined) return { text: '', kind: 'empty' };
    const classified = classifyValue(value);
    return { text: displayValue(value), kind: classified.kind };
  }

  function inferColumnKinds(rows, count) {
    const kinds = Array.from({ length: count }, () => new Map());
    for (const row of rows.slice(0, 250)) {
      for (let column = 0; column < count; column++) {
        const kind = gridValue(row?.[column]).kind;
        if (kind === 'empty' || kind === 'null') continue;
        kinds[column].set(kind, (kinds[column].get(kind) || 0) + 1);
      }
    }
    return kinds.map(scores => {
      let selected = 'text';
      let best = 0;
      for (const [kind, score] of scores) {
        if (score > best) { selected = kind; best = score; }
      }
      return selected;
    });
  }

  function installGridNavigation(table) {
    let active = null;
    const cells = () => Array.from(table.querySelectorAll('tbody td, tbody th.data-row-number'));
    const activate = cell => {
      if (!cell) return;
      active?.classList?.remove('is-active-cell');
      active = cell;
      active.classList.add('is-active-cell');
      active.tabIndex = 0;
      active.focus({ preventScroll: true });
    };
    table.addEventListener('click', event => {
      const cell = event.target.closest?.('tbody td, tbody th.data-row-number');
      if (cell) activate(cell);
    });
    table.addEventListener('keydown', event => {
      const cell = event.target.closest?.('tbody td, tbody th.data-row-number') || active;
      if (!cell) return;
      const row = cell.parentElement;
      const index = Array.from(row.children).indexOf(cell);
      let next = null;
      if (event.key === 'ArrowLeft') next = row.children[index - 1];
      else if (event.key === 'ArrowRight') next = row.children[index + 1];
      else if (event.key === 'ArrowUp') next = row.previousElementSibling?.children[index];
      else if (event.key === 'ArrowDown') next = row.nextElementSibling?.children[index];
      else if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'c') {
        const text = cell.textContent || '';
        if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text);
        return;
      }
      if (!next) return;
      event.preventDefault();
      activate(next);
    });
  }

  function installColumnResizer(handle, table, columnIndex) {
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      const header = handle.parentElement;
      const startX = BB.viewport?.toLayoutPixels(event.clientX) ?? event.clientX;
      const startWidth = Math.max(64, (BB.viewport?.rect(header) || header.getBoundingClientRect()).width);
      handle.setPointerCapture?.(event.pointerId);
      document.body.classList.add('is-resizing-data-column');
      const move = moveEvent => {
        const currentX = BB.viewport?.toLayoutPixels(moveEvent.clientX) ?? moveEvent.clientX;
        const width = Math.max(64, Math.min(720, startWidth + currentX - startX));
        for (const row of table.rows) {
          const cell = row.cells[columnIndex];
          if (cell) {
            cell.style.width = `${Math.round(width)}px`;
            cell.style.minWidth = `${Math.round(width)}px`;
            cell.style.maxWidth = `${Math.round(width)}px`;
          }
        }
      };
      const finish = () => {
        document.body.classList.remove('is-resizing-data-column');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
    });
  }

  function renderTable({
    headers,
    rows,
    totalRows,
    sourceTotalRows,
    rowNumbers,
    page = 0,
    pageSize = DEFAULT_PAGE_SIZE,
    onPage,
    note = '',
    queryTools = null,
    beforeTable = null,
    hasNext = false,
    rangeStart = null,
    rangeEnd = null,
    emptyMessage = ''
  }) {
    const wrapper = document.createElement('section');
    wrapper.className = queryTools ? 'data-preview bb-data-grid has-query-tools' : 'data-preview bb-data-grid';

    const toolbar = document.createElement('div');
    toolbar.className = 'data-preview-toolbar';
    const summary = document.createElement('span');
    summary.className = 'data-preview-summary';
    const totalKnown = Number.isFinite(totalRows);
    const knownTotal = totalKnown ? Math.max(0, Number(totalRows)) : null;
    const sourceTotalKnown = Number.isFinite(sourceTotalRows);
    const sourceTotal = sourceTotalKnown ? Math.max(0, Number(sourceTotalRows)) : knownTotal;
    const calculatedStart = rows.length ? page * pageSize + 1 : 0;
    const calculatedEnd = rows.length ? page * pageSize + rows.length : 0;
    const start = Number.isFinite(rangeStart) ? Math.max(0, Number(rangeStart)) : calculatedStart;
    const end = Number.isFinite(rangeEnd) ? Math.max(0, Number(rangeEnd)) : (totalKnown ? Math.min(calculatedEnd, knownTotal) : calculatedEnd);
    const rowWord = value => Number(value) === 1 ? 'row' : 'rows';
    const columnWord = value => Number(value) === 1 ? 'column' : 'columns';
    if (totalKnown) {
      const rowCount = sourceTotalKnown && sourceTotal !== knownTotal
        ? `${knownTotal.toLocaleString()} of ${sourceTotal.toLocaleString()} ${rowWord(sourceTotal)}`
        : `${knownTotal.toLocaleString()} ${rowWord(knownTotal)}`;
      summary.textContent = `${rowCount} · ${headers.length.toLocaleString()} ${columnWord(headers.length)} · showing ${start.toLocaleString()}–${end.toLocaleString()}`;
    } else {
      summary.textContent = `${headers.length.toLocaleString()} ${columnWord(headers.length)} · showing ${start.toLocaleString()}–${end.toLocaleString()}`;
    }
    toolbar.appendChild(summary);

    const controls = document.createElement('div');
    controls.className = 'data-preview-controls';

    if (queryTools) {
      const activeColumnFilters = (queryTools.filters || []).filter(value => String(value || '').trim()).length;
      const allowFilters = queryTools.allowFilters !== false;
      if (allowFilters) {
        const filterToggle = document.createElement('button');
        filterToggle.type = 'button';
        filterToggle.className = `data-tool-button${queryTools.showFilters || activeColumnFilters ? ' is-active' : ''}`;
        filterToggle.append(createIcon('filter-variant'), document.createTextNode(activeColumnFilters ? `Filters (${activeColumnFilters})` : 'Filters'));
        filterToggle.setAttribute('aria-pressed', queryTools.showFilters ? 'true' : 'false');
        filterToggle.addEventListener('click', queryTools.onToggleFilters);
        controls.appendChild(filterToggle);
      }

      const hasQuery = activeColumnFilters > 0 || !!queryTools.sortDirection || !!String(queryTools.globalQuery || '').trim();
      let clear = null;
      if (queryTools.showClear !== false) {
        clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'data-tool-button';
        clear.disabled = !hasQuery;
        clear.title = 'Clear column filters and sorting';
        clear.append(createIcon('filter-remove-outline'), document.createTextNode('Clear'));
        clear.addEventListener('click', queryTools.onClear);
      }

      const pageSizeLabel = document.createElement('label');
      pageSizeLabel.className = 'data-page-size';
      const pageSizeText = document.createElement('span');
      pageSizeText.textContent = 'Rows';
      const pageSizeSelect = document.createElement('select');
      pageSizeSelect.setAttribute('aria-label', 'Rows per page');
      PAGE_SIZE_OPTIONS.forEach(size => {
        const option = document.createElement('option');
        option.value = String(size);
        option.textContent = String(size);
        option.selected = size === pageSize;
        pageSizeSelect.appendChild(option);
      });
      pageSizeSelect.addEventListener('change', event => queryTools.onPageSize(Number(event.target.value)));
      pageSizeLabel.append(pageSizeText, pageSizeSelect);
      if (clear) controls.appendChild(clear);
      controls.appendChild(pageSizeLabel);
      if (typeof queryTools.onCount === 'function') {
        const count = document.createElement('button');
        count.type = 'button';
        count.className = 'data-tool-button';
        count.disabled = !!queryTools.counting;
        count.append(createIcon(queryTools.counting ? 'loading mdi-spin' : 'counter'), document.createTextNode(queryTools.countLabel || 'Count rows'));
        count.addEventListener('click', queryTools.onCount);
        controls.appendChild(count);
      }
    }

    const paginationNeeded = Boolean(onPage) && (page > 0 || hasNext || (totalKnown && knownTotal > pageSize));
    if (typeof onPage === 'function') {
      const pagination = document.createElement('div');
      pagination.className = `data-preview-pagination${paginationNeeded ? '' : ' is-pagination-placeholder'}`;
      if (!paginationNeeded) pagination.setAttribute('aria-hidden', 'true');
      const totalPages = totalKnown ? Math.max(1, Math.ceil(knownTotal / pageSize)) : null;
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'bb-btn';
      previous.title = 'Previous page';
      previous.setAttribute('aria-label', 'Previous page');
      previous.appendChild(createIcon('chevron-left'));
      previous.disabled = !paginationNeeded || page <= 0;
      previous.tabIndex = paginationNeeded ? 0 : -1;
      previous.addEventListener('click', () => { if (paginationNeeded) onPage(page - 1); });
      const pageLabel = document.createElement('span');
      pageLabel.className = 'data-preview-page-label';
      pageLabel.textContent = totalKnown
        ? `Page ${Math.min(page + 1, totalPages).toLocaleString()} of ${totalPages.toLocaleString()}`
        : `Page ${(page + 1).toLocaleString()}`;
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'bb-btn';
      next.title = 'Next page';
      next.setAttribute('aria-label', 'Next page');
      next.appendChild(createIcon('chevron-right'));
      next.disabled = !paginationNeeded || (totalKnown ? end >= knownTotal : !hasNext);
      next.tabIndex = paginationNeeded ? 0 : -1;
      next.addEventListener('click', () => { if (paginationNeeded) onPage(page + 1); });
      pagination.append(previous, pageLabel, next);
      controls.appendChild(pagination);
    }

    if (controls.childElementCount) toolbar.appendChild(controls);
    wrapper.appendChild(toolbar);

    if (note) {
      const notice = document.createElement('div');
      notice.className = 'data-preview-note';
      notice.textContent = note;
      wrapper.appendChild(notice);
    }

    if (beforeTable) wrapper.appendChild(beforeTable);

    const scroller = document.createElement('div');
    scroller.className = 'data-table-scroll';
    const table = document.createElement('table');
    table.className = 'data-table bb-data-grid-table';
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-colcount', String(headers.length + 1));
    if (totalKnown) table.setAttribute('aria-rowcount', String(knownTotal + 1));
    const columnKinds = inferColumnKinds(rows, headers.length);
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const rowNumberHead = document.createElement('th');
    rowNumberHead.className = 'data-row-number';
    rowNumberHead.textContent = '#';
    headRow.appendChild(rowNumberHead);
    headers.forEach((header, columnIndex) => {
      const cell = document.createElement('th');
      cell.title = header;
      cell.scope = 'col';
      cell.classList.add(`is-${columnKinds[columnIndex] || 'text'}`);
      if (queryTools && queryTools.allowSort !== false) {
        const heading = document.createElement('div');
        heading.className = 'data-column-heading';
        const sortButton = document.createElement('button');
        sortButton.type = 'button';
        sortButton.className = 'data-sort-button';
        sortButton.dataset.sortColumn = String(columnIndex);
        const label = document.createElement('span');
        label.textContent = header;
        const isSorted = queryTools.sortColumn === columnIndex && queryTools.sortDirection;
        const icon = createIcon(isSorted ? (queryTools.sortDirection === 'desc' ? 'arrow-down' : 'arrow-up') : 'unfold-more-horizontal');
        sortButton.append(label, icon);
        sortButton.title = `Sort by ${header}`;
        sortButton.addEventListener('click', () => queryTools.onSort(columnIndex));
        cell.setAttribute('aria-sort', isSorted ? (queryTools.sortDirection === 'desc' ? 'descending' : 'ascending') : 'none');
        heading.appendChild(sortButton);

        if (queryTools.showFilters) {
          const filter = document.createElement('input');
          filter.type = 'text';
          filter.className = 'data-column-filter';
          filter.dataset.filterColumn = String(columnIndex);
          filter.placeholder = 'Filter...';
          filter.title = `Filter ${header}`;
          filter.value = queryTools.filters?.[columnIndex] || '';
          filter.autocomplete = 'off';
          filter.spellcheck = false;
          filter.setAttribute('aria-label', `Filter ${header}`);
          filter.addEventListener('input', event => queryTools.onColumnFilter(columnIndex, event.target.value));
          filter.addEventListener('keydown', event => {
            if (event.key === 'Escape' && event.target.value) queryTools.onColumnFilter(columnIndex, '');
          });
          heading.appendChild(filter);
        }
        cell.appendChild(heading);
      } else {
        cell.textContent = header;
      }
      const resizeHandle = document.createElement('span');
      resizeHandle.className = 'data-column-resizer';
      resizeHandle.setAttribute('role', 'separator');
      resizeHandle.setAttribute('aria-orientation', 'vertical');
      resizeHandle.title = `Resize ${header}`;
      cell.appendChild(resizeHandle);
      installColumnResizer(resizeHandle, table, columnIndex + 1);
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    rows.forEach((row, rowIndex) => {
      const tableRow = document.createElement('tr');
      const rowNumber = document.createElement('th');
      rowNumber.className = 'data-row-number';
      rowNumber.scope = 'row';
      rowNumber.textContent = String(rowNumbers?.[rowIndex] ?? (page * pageSize + rowIndex + 1));
      tableRow.appendChild(rowNumber);
      headers.forEach((_, columnIndex) => {
        const cell = document.createElement('td');
        const value = gridValue(row[columnIndex]);
        cell.textContent = value.text;
        cell.title = value.text;
        cell.className = `is-${value.kind}`;
        cell.tabIndex = -1;
        tableRow.appendChild(cell);
      });
      body.appendChild(tableRow);
    });
    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      emptyRow.className = 'data-empty-row';
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = headers.length + 1;
      emptyCell.textContent = emptyMessage || (queryTools ? 'No rows match the current filters.' : 'No rows are available.');
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
    }
    table.appendChild(body);
    installGridNavigation(table);
    scroller.appendChild(table);
    wrapper.appendChild(scroller);
    BB.render?.forwardVerticalWheel?.(scroller);
    return wrapper;
  }

  function createQueryableTable(parsed, { extraNotes = [], beforeTableFactory = null } = {}) {
    const root = document.createElement('div');
    const state = {
      page: 0,
      pageSize: DEFAULT_PAGE_SIZE,
      filters: parsed.headers.map(() => ''),
      showFilters: false,
      sortColumn: -1,
      sortDirection: '',
      globalQuery: ''
    };
    let redrawTimer = 0;

    const restoreFocus = focus => {
      if (!focus) return;
      requestAnimationFrame(() => {
        const selector = `[data-filter-column="${focus.column}"]`;
        const input = root.querySelector(selector);
        if (!input) return;
        input.focus({ preventScroll: true });
        const end = input.value.length;
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(end, end);
      });
    };

    const scheduleDraw = focus => {
      clearTimeout(redrawTimer);
      redrawTimer = setTimeout(() => draw(0, focus, true), 160);
    };

    const draw = (nextPage = state.page, focus = null, preserveHorizontalScroll = false) => {
      const previousScrollLeft = preserveHorizontalScroll
        ? Number(root.querySelector('.data-table-scroll')?.scrollLeft || 0)
        : 0;
      const entries = queryTableEntries(parsed.rows, state);
      const maxPage = Math.max(0, Math.ceil(entries.length / state.pageSize) - 1);
      state.page = Math.max(0, Math.min(Number(nextPage) || 0, maxPage));
      const start = state.page * state.pageSize;
      const pageEntries = entries.slice(start, start + state.pageSize);
      const noteParts = Array.isArray(extraNotes) ? extraNotes.filter(Boolean) : [];
      if (parsed.truncatedRows) noteParts.push(`Preview limited to the first ${MAX_ROWS.toLocaleString()} rows.`);
      if (parsed.truncatedColumns) noteParts.push(`Preview limited to the first ${MAX_COLUMNS} columns.`);
      root.replaceChildren(renderTable({
        headers: parsed.headers,
        rows: pageEntries.map(entry => entry.row),
        rowNumbers: pageEntries.map(entry => parsed.rowNumbers?.[entry.sourceIndex] ?? (Number(parsed.rowNumberOffset || 0) + entry.sourceIndex + 1)),
        totalRows: entries.length,
        sourceTotalRows: parsed.rows.length,
        page: state.page,
        pageSize: state.pageSize,
        onPage: draw,
        note: noteParts.join(' '),
        queryTools: {
          filters: state.filters,
          showFilters: state.showFilters,
          sortColumn: state.sortColumn,
          sortDirection: state.sortDirection,
          globalQuery: state.globalQuery,
          onColumnFilter(columnIndex, value) {
            state.filters[columnIndex] = String(value || '');
            scheduleDraw({ type: 'column', column: columnIndex });
          },
          onToggleFilters() {
            clearTimeout(redrawTimer);
            state.showFilters = !state.showFilters;
            draw(state.page, null, true);
          },
          onSort(columnIndex) {
            clearTimeout(redrawTimer);
            if (state.sortColumn !== columnIndex) {
              state.sortColumn = columnIndex;
              state.sortDirection = 'asc';
            } else if (state.sortDirection === 'asc') {
              state.sortDirection = 'desc';
            } else if (state.sortDirection === 'desc') {
              state.sortColumn = -1;
              state.sortDirection = '';
            } else {
              state.sortDirection = 'asc';
            }
            draw(0, null, true);
          },
          onPageSize(value) {
            clearTimeout(redrawTimer);
            if (!PAGE_SIZE_OPTIONS.includes(value)) return;
            state.pageSize = value;
            draw(0, null, true);
          },
          onClear() {
            clearTimeout(redrawTimer);
            state.filters = parsed.headers.map(() => '');
            state.sortColumn = -1;
            state.sortDirection = '';
            state.globalQuery = '';
            draw(0, null, true);
          }
        },
        beforeTable: typeof beforeTableFactory === 'function' ? beforeTableFactory() : null
      }));
      if (previousScrollLeft > 0) {
        requestAnimationFrame(() => {
          const scroller = root.querySelector('.data-table-scroll');
          if (scroller) scroller.scrollLeft = previousScrollLeft;
        });
      }
      restoreFocus(focus);
    };
    root.documentSearch = async query => {
      state.globalQuery = String(query || '').trim();
      draw(0, null, true);
    };
    draw(0);
    return root;
  }

  function remoteDelimitedNote(payload, state) {
    const notes = ['Rows are read on demand; the complete object is not loaded into browser memory.'];
    if (payload?.truncatedColumns) notes.push(`Preview limited to the first ${MAX_COLUMNS} columns.`);
    if (payload?.truncatedCells) notes.push('Very large cell values are shortened in the preview; the object is unchanged.');
    if (state.totalRows == null) notes.push('Use Count rows to scan the complete document only when an exact total is needed.');
    return notes.join(' ');
  }

  function createRemoteDelimitedTable({ key, size, etag = '', version = '', instance = null } = {}) {
    const root = document.createElement('div');
    const state = {
      page: 0,
      pageSize: DEFAULT_PAGE_SIZE,
      pages: [],
      headers: [],
      totalRows: null,
      totalColumns: null,
      counting: false,
      searchQuery: '',
      searchResult: null,
      controller: null,
      serial: 0
    };

    function loading(label) {
      const node = document.createElement('div');
      node.className = 'preview-loading data-loading';
      node.append(createIcon('loading mdi-spin'), document.createTextNode(label));
      root.replaceChildren(node);
    }

    function resetPages() {
      state.page = 0;
      state.pages = [];
      state.searchQuery = '';
      state.searchResult = null;
    }

    async function countRows() {
      if (state.counting) return;
      state.counting = true;
      drawLoadedPage();
      try {
        const result = await BB.api.documentCount({ key, version, instance, signal: state.controller?.signal || null });
        state.totalRows = Number(result.rows || 0);
        state.totalColumns = Number(result.columns || state.headers.length || 0);
      } finally {
        state.counting = false;
        drawLoadedPage();
      }
    }

    function normalQueryTools() {
      return {
        allowFilters: false,
        allowSort: false,
        showClear: false,
        filters: state.headers.map(() => ''),
        showFilters: false,
        sortColumn: -1,
        sortDirection: '',
        globalQuery: '',
        onToggleFilters() {},
        onColumnFilter() {},
        onSort() {},
        onClear() {},
        onPageSize(value) {
          if (!PAGE_SIZE_OPTIONS.includes(value) || value === state.pageSize) return;
          state.pageSize = value;
          resetPages();
          void loadPage(0).catch(error => showTableError(root, error));
        },
        onCount: countRows,
        counting: state.counting,
        countLabel: state.totalRows == null ? 'Count rows' : `${state.totalRows.toLocaleString()} rows`
      };
    }

    function drawSearchResult() {
      const result = state.searchResult;
      if (!result) return false;
      const matches = Array.from(result.matches || []);
      const note = `Search scanned ${Number(result.bytesScanned || 0).toLocaleString()} bytes across the complete document. ${Number(result.total || 0).toLocaleString()} match${Number(result.total || 0) === 1 ? '' : 'es'} found${result.truncated ? '; only the first results are retained' : ''}.`;
      root.replaceChildren(renderTable({
        headers: ['Match'],
        rows: matches.map(match => [String(match.snippet || '')]),
        rowNumbers: matches.map(match => Number(match.line || 0) || '—'),
        totalRows: matches.length,
        sourceTotalRows: Number(result.total || matches.length),
        page: 0,
        pageSize: Math.max(1, matches.length || DEFAULT_PAGE_SIZE),
        note,
        queryTools: {
          allowFilters: false,
          allowSort: false,
          showClear: true,
          filters: [''],
          showFilters: false,
          sortColumn: -1,
          sortDirection: '',
          globalQuery: state.searchQuery,
          onToggleFilters() {},
          onColumnFilter() {},
          onSort() {},
          onPageSize() {},
          onClear() {
            state.searchQuery = '';
            state.searchResult = null;
            drawLoadedPage();
          }
        }
      }));
      return true;
    }

    function drawLoadedPage() {
      if (drawSearchResult()) return;
      const payload = state.pages[state.page];
      if (!payload) return;
      if (Array.isArray(payload.headers) && payload.headers.length) state.headers = payload.headers;
      const logicalStart = payload.rows?.length ? state.page * state.pageSize + 1 : 0;
      const logicalEnd = logicalStart ? logicalStart + payload.rows.length - 1 : 0;
      root.replaceChildren(renderTable({
        headers: state.headers,
        rows: payload.rows || [],
        rowNumbers: payload.rowNumbers || [],
        totalRows: state.totalRows == null ? undefined : state.totalRows,
        sourceTotalRows: state.totalRows == null ? undefined : state.totalRows,
        page: state.page,
        pageSize: state.pageSize,
        rangeStart: logicalStart,
        rangeEnd: logicalEnd,
        hasNext: !payload.done,
        onPage: page => void loadPage(page).catch(error => showTableError(root, error)),
        note: remoteDelimitedNote(payload, state),
        queryTools: normalQueryTools(),
        emptyMessage: 'No data rows are available.'
      }));
    }

    async function loadPage(page) {
      const nextPage = Math.max(0, Number(page) || 0);
      if (state.pages[nextPage]) {
        state.page = nextPage;
        drawLoadedPage();
        return;
      }
      if (nextPage > 0 && !state.pages[nextPage - 1]?.nextCursor) return;
      const serial = ++state.serial;
      state.controller?.abort();
      state.controller = new AbortController();
      loading('Reading table rows…');
      const payload = await BB.api.delimitedPage({
        key,
        cursor: nextPage > 0 ? state.pages[nextPage - 1].nextCursor : '',
        etag,
        version,
        pageSize: state.pageSize,
        instance,
        signal: state.controller.signal
      });
      if (serial !== state.serial) return;
      state.pages[nextPage] = payload;
      if (Array.isArray(payload.headers) && payload.headers.length) state.headers = payload.headers;
      state.page = nextPage;
      drawLoadedPage();
    }

    root.documentSearch = async query => {
      const normalized = String(query || '').trim();
      if (!normalized) {
        state.searchQuery = '';
        state.searchResult = null;
        drawLoadedPage();
        return;
      }
      const serial = ++state.serial;
      state.controller?.abort();
      state.controller = new AbortController();
      loading('Searching the complete document…');
      const result = await BB.api.searchDocument({ key, query: normalized, version, instance, signal: state.controller.signal });
      if (serial !== state.serial) return;
      state.searchQuery = normalized;
      state.searchResult = result;
      drawSearchResult();
    };
    root.cleanup = () => state.controller?.abort();
    void loadPage(0).catch(error => showTableError(root, error));
    return root;
  }

  async function fetchTextTable(url, key, size, options = {}) {
    const extension = BB.detect.extOf(key);
    const streamable = ['csv', 'tsv', 'tab', 'psv'].includes(extension);
    if (Number(size) > MAX_TEXT_BYTES && streamable) {
      return createRemoteDelimitedTable({
        key,
        size,
        etag: options.etag || '',
        version: options.version || '',
        instance: options.instance ?? null
      });
    }
    if (Number(size) > MAX_TEXT_BYTES) {
      throw new Error(`Text table previews are limited to ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)} MiB for this format.`);
    }
    const response = await fetch(url, { headers: { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` }, cache: 'no-store' });
    if (!response.ok && response.status !== 206) throw new Error(`Unable to read table: HTTP ${response.status}`);
    const text = await response.text();
    return createQueryableTable(parseTextTable(text, extension));
  }

  function spreadsheetVisibility(workbook, index) {
    const hidden = Number(workbook?.Workbook?.Sheets?.[index]?.Hidden || 0);
    if (hidden === 2) return { hidden, label: 'Very hidden' };
    if (hidden === 1) return { hidden, label: 'Hidden' };
    return { hidden: 0, label: 'Visible' };
  }

  function spreadsheetSheetData(XLSX, worksheet) {
    const reference = worksheet?.['!ref'];
    if (!reference) return { headers: [], rows: [], rowNumbers: [], rowNumberOffset: 0, truncatedRows: false, truncatedColumns: false };

    const range = XLSX.utils.decode_range(reference);
    const fullReference = worksheet?.['!fullref'] || reference;
    let fullRange = range;
    try { fullRange = XLSX.utils.decode_range(fullReference); } catch (_) {}
    const firstRow = Math.max(0, Number(range.s.r || 0));
    const firstColumn = Math.max(0, Number(range.s.c || 0));
    const lastRow = Math.min(Number(range.e.r || firstRow), firstRow + MAX_ROWS - 1);
    const lastColumn = Math.min(Number(range.e.c || firstColumn), firstColumn + MAX_COLUMNS - 1);
    const selectedRange = {
      s: { r: firstRow, c: firstColumn },
      e: { r: lastRow, c: lastColumn }
    };
    const matrix = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
      range: selectedRange
    });
    const sourceColumnCount = Math.max(0, lastColumn - firstColumn + 1);
    const nonEmptyRows = [];
    Array.from(matrix || []).slice(0, MAX_ROWS).forEach((sourceRow, matrixIndex) => {
      const values = Array.from(sourceRow || []).slice(0, sourceColumnCount).map(displayValue);
      while (values.length < sourceColumnCount) values.push('');
      if (values.every(isEmptyCell)) return;
      nonEmptyRows.push({ values, rowNumber: firstRow + matrixIndex + 1 });
    });

    const activeColumns = [];
    for (let column = 0; column < sourceColumnCount; column++) {
      if (nonEmptyRows.some(entry => !isEmptyCell(entry.values[column]))) activeColumns.push(column);
    }
    const headers = activeColumns.map(column => XLSX.utils.encode_col(firstColumn + column));
    const rows = nonEmptyRows.map(entry => activeColumns.map(column => entry.values[column]));
    const rowNumbers = nonEmptyRows.map(entry => entry.rowNumber);
    return {
      headers,
      rows,
      rowNumbers,
      rowNumberOffset: firstRow,
      truncatedRows: Number(fullRange.e.r || 0) > lastRow || matrix.length > MAX_ROWS,
      truncatedColumns: Number(fullRange.e.c || 0) > lastColumn
    };
  }

  function normalizeSheetDescriptor(sheet, index) {
    const hidden = String(sheet?.hidden || '').toLowerCase();
    return {
      index: Number.isInteger(Number(sheet?.index)) ? Number(sheet.index) : index,
      name: String(sheet?.name || `Sheet ${index + 1}`),
      hidden,
      label: hidden === 'veryhidden' || hidden === 'very hidden'
        ? 'Very hidden'
        : (hidden ? 'Hidden' : 'Visible')
    };
  }

  function createSpreadsheetSheetControls(sheets, activeIndex, activate) {
    const descriptors = Array.from(sheets || []).map(normalizeSheetDescriptor);
    if (descriptors.length < 2) return null;

    const controls = document.createElement('div');
    controls.className = 'spreadsheet-sheet-controls';

    const tabBar = document.createElement('div');
    tabBar.className = 'spreadsheet-tabs';
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'Workbook sheets');

    descriptors.forEach((sheet, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `spreadsheet-tab${index === activeIndex ? ' is-active' : ''}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
      button.tabIndex = index === activeIndex ? 0 : -1;
      button.title = `${sheet.name} · ${sheet.label}`;
      const icon = createIcon(sheet.hidden ? 'eye-off-outline' : 'table');
      const text = document.createElement('span');
      text.textContent = sheet.name;
      button.append(icon, text);
      button.addEventListener('click', () => activate(index));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let next = index;
        if (event.key === 'ArrowLeft') next = (index - 1 + descriptors.length) % descriptors.length;
        if (event.key === 'ArrowRight') next = (index + 1) % descriptors.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = descriptors.length - 1;
        activate(next);
      });
      tabBar.appendChild(button);
    });

    const selectLabel = document.createElement('label');
    selectLabel.className = 'spreadsheet-sheet-select';
    const selectText = document.createElement('span');
    selectText.textContent = 'Sheet';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Workbook sheet');
    descriptors.forEach((sheet, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = sheet.hidden ? `${sheet.name} (${sheet.label.toLowerCase()})` : sheet.name;
      option.selected = index === activeIndex;
      select.appendChild(option);
    });
    select.addEventListener('change', event => activate(Number(event.target.value)));
    selectLabel.append(selectText, select);
    controls.append(tabBar, selectLabel);
    return controls;
  }

  async function renderUnsupportedBinarySpreadsheet(_url, key, size) {
    const extension = BB.detect.extOf(key).toUpperCase() || 'XLS';
    return createQueryableTable({
      headers: ['Format', 'Preview mode', 'Object size'],
      rows: [[extension, 'Conversion required', Number(size) > 0 ? `${Math.round(Number(size) / 1024)} KiB` : 'Unknown']],
      rowNumbers: [1],
      totalRows: 1,
      sourceTotalRows: 1,
      truncatedRows: false,
      truncatedColumns: false
    }, {
      extraNotes: [
        'This binary XLS workbook is not decoded by the constrained offline build. Download it or convert it to XLSX/CSV. No external service was contacted and the object was not downloaded for preview.'
      ]
    });
  }

  async function renderRemoteSpreadsheet(key, objectSize = 0, options = {}) {
    const root = document.createElement('section');
    root.className = 'spreadsheet-preview remote-spreadsheet-preview';
    root.dataset.previewKind = 'spreadsheet';
    root.dataset.sourceUrl = BB.api.urlForKey(key, options.instance ?? null, options.version || '');
    const state = {
      sheet: 0,
      page: 0,
      pageSize: DEFAULT_PAGE_SIZE,
      filters: {},
      showFilters: false,
      sortColumn: '',
      sortDirection: '',
      search: ''
    };
    let requestSerial = 0;
    let requestController = null;
    let redrawTimer = 0;
    let lastPayload = null;

    const restoreFocus = focus => {
      if (!focus) return;
      requestAnimationFrame(() => {
        const input = root.querySelector(`[data-filter-column="${focus.column}"]`);
        if (!input) return;
        input.focus({ preventScroll: true });
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length);
      });
    };

    const activeFilters = () => Object.fromEntries(
      Object.entries(state.filters).filter(([, value]) => String(value || '').trim() !== '')
    );

    const draw = async (nextPage = state.page, focus = null, preserveHorizontalScroll = false) => {
      const previousScrollLeft = preserveHorizontalScroll
        ? Number(root.querySelector('.data-table-scroll')?.scrollLeft || 0)
        : 0;
      state.page = Math.max(0, Number(nextPage) || 0);
      const serial = ++requestSerial;
      requestController?.abort();
      requestController = new AbortController();

      if (!lastPayload) {
        const loading = document.createElement('div');
        loading.className = 'preview-loading data-loading';
        loading.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i><span>Reading workbook rows...</span>';
        root.replaceChildren(loading);
      } else {
        root.classList.add('is-loading-query');
        root.setAttribute('aria-busy', 'true');
      }

      try {
        const payload = await BB.api.spreadsheet({
          key,
          sheet: state.sheet,
          page: state.page,
          pageSize: state.pageSize,
          filters: activeFilters(),
          sortColumn: state.sortColumn,
          sortDirection: state.sortDirection,
          search: state.search,
          size: objectSize,
          version: options.version || '',
          instance: options.instance ?? null,
          signal: requestController.signal
        });
        if (serial !== requestSerial) return;
        lastPayload = payload;
        state.sheet = Number(payload.sheet?.index || 0);
        state.page = Number(payload.page || 0);
        state.pageSize = Number(payload.pageSize || state.pageSize);
        const headers = Array.from(payload.headers || []);
        const rows = Array.from(payload.rows || []).map(row => Array.from(row.cells || []));
        const rowNumbers = Array.from(payload.rows || []).map(row => Number(row.number || 0));
        const filterValues = headers.map(header => String(state.filters[header] || ''));
        const sortColumnIndex = headers.indexOf(state.sortColumn);
        const notes = [];
        if (payload.truncatedRows) notes.push('The worksheet row scan reached the server preview limit.');
        if (payload.truncatedColumns) notes.push(`Preview limited to the first ${MAX_COLUMNS} non-empty columns.`);
        if (payload.macrosIgnored) notes.push('Workbook macros are not executed.');
        if (state.search) notes.push(`Search: \"${state.search}\" across the complete worksheet.`);

        const activateSheet = index => {
          if (index === state.sheet) return;
          state.sheet = index;
          state.page = 0;
          state.filters = {};
          state.sortColumn = '';
          state.sortDirection = '';
          state.search = '';
          void draw(0).catch(error => showTableError(root, error));
        };

        root.replaceChildren(renderTable({
          headers,
          rows,
          rowNumbers,
          totalRows: Number(payload.totalRows || 0),
          sourceTotalRows: Number(payload.sourceRows || 0),
          page: state.page,
          pageSize: state.pageSize,
          onPage: page => void draw(page).catch(error => showTableError(root, error)),
          note: notes.join(' '),
          beforeTable: createSpreadsheetSheetControls(payload.sheets || [], state.sheet, activateSheet),
          queryTools: {
            filters: filterValues,
            showFilters: state.showFilters,
            sortColumn: sortColumnIndex,
            sortDirection: state.sortDirection,
            globalQuery: state.search,
            onColumnFilter(columnIndex, value) {
              const header = headers[columnIndex];
              if (!header) return;
              state.filters[header] = String(value || '');
              window.clearTimeout(redrawTimer);
              redrawTimer = window.setTimeout(() => {
                void draw(0, { column: columnIndex }, true).catch(error => showTableError(root, error));
              }, 220);
            },
            onToggleFilters() {
              window.clearTimeout(redrawTimer);
              state.showFilters = !state.showFilters;
              void draw(state.page, null, true).catch(error => showTableError(root, error));
            },
            onSort(columnIndex) {
              window.clearTimeout(redrawTimer);
              const header = headers[columnIndex];
              if (!header) return;
              if (state.sortColumn !== header) {
                state.sortColumn = header;
                state.sortDirection = 'asc';
              } else if (state.sortDirection === 'asc') {
                state.sortDirection = 'desc';
              } else if (state.sortDirection === 'desc') {
                state.sortColumn = '';
                state.sortDirection = '';
              } else {
                state.sortDirection = 'asc';
              }
              void draw(0, null, true).catch(error => showTableError(root, error));
            },
            onPageSize(value) {
              window.clearTimeout(redrawTimer);
              if (!PAGE_SIZE_OPTIONS.includes(value)) return;
              state.pageSize = value;
              void draw(0, null, true).catch(error => showTableError(root, error));
            },
            onClear() {
              window.clearTimeout(redrawTimer);
              state.filters = {};
              state.sortColumn = '';
              state.sortDirection = '';
              state.search = '';
              void draw(0, null, true).catch(error => showTableError(root, error));
            }
          }
        }));
        if (previousScrollLeft > 0) {
          requestAnimationFrame(() => {
            const scroller = root.querySelector('.data-table-scroll');
            if (scroller) scroller.scrollLeft = previousScrollLeft;
          });
        }
        restoreFocus(focus);
      } catch (error) {
        if (error?.name === 'AbortError' || serial !== requestSerial) return;
        throw error;
      } finally {
        if (serial === requestSerial) {
          root.classList.remove('is-loading-query');
          root.removeAttribute('aria-busy');
        }
      }
    };

    root.documentSearch = async query => {
      state.search = String(query || '').trim();
      await draw(0, null, true);
    };
    await draw(0);
    return root;
  }

  async function renderSpreadsheet(url, key, size, options = {}) {
    const extension = BB.detect.extOf(key);
    if (extension === 'xlsx' || extension === 'xlsm') return renderRemoteSpreadsheet(key, size, options);
    return renderUnsupportedBinarySpreadsheet(url, key, size);
  }

  function parquetSummaryPanel(payload) {
    const panel = document.createElement('div');
    panel.className = 'data-summary parquet-summary';
    const values = [
      ['Rows', Number(payload.rows || 0).toLocaleString()],
      ['Top-level columns', Number(payload.columns || 0).toLocaleString()],
      ['Row groups', Number(payload.rowGroupCount || 0).toLocaleString()],
      ['Metadata', `${Math.round(Number(payload.metadataBytes || 0) / 1024).toLocaleString()} KiB`],
      ['Storage requests', Number(payload.storageRequests || 0).toLocaleString()]
    ];
    values.forEach(([label, value]) => {
      const item = document.createElement('span');
      item.className = 'data-summary-item';
      const strong = document.createElement('strong');
      strong.textContent = value;
      const copy = document.createElement('small');
      copy.textContent = label;
      item.append(strong, copy);
      panel.appendChild(item);
    });
    if (payload.createdBy) {
      const creator = document.createElement('span');
      creator.className = 'data-summary-created-by';
      creator.textContent = `Created by ${payload.createdBy}`;
      panel.appendChild(creator);
    }
    return panel;
  }

  async function renderParquet(key, size, options = {}) {
    const payload = await BB.api.parquetPreview({
      key,
      size,
      etag: options.etag || '',
      version: options.version || '',
      instance: options.instance ?? null
    });
    const rows = Array.from(payload.schema || []).map(field => [
      field.path || field.name || '',
      field.physicalType || '',
      field.logicalType || '',
      field.repetition || '',
      Number(field.children || 0) || ''
    ]);
    const notes = [
      'The constrained offline viewer reads only the Parquet footer and schema by exact byte ranges. Row data is not decoded in this build, so no hidden full-object transfer occurs.'
    ];
    if (payload.schemaTruncated) notes.push('The schema reached the configured field limit.');
    if (payload.rowGroupsTruncated) notes.push('The row-group summary reached the configured limit.');
    if (Number(payload.storageBytes || 0) > 0) {
      notes.push(`${Number(payload.storageBytes).toLocaleString()} storage bytes were transferred.`);
    }
    return createQueryableTable({
      headers: ['Field path', 'Physical type', 'Logical type', 'Repetition', 'Children'],
      rows,
      rowNumbers: rows.map((_, index) => index + 1),
      totalRows: rows.length,
      sourceTotalRows: rows.length,
      truncatedRows: !!payload.schemaTruncated,
      truncatedColumns: false
    }, {
      extraNotes: notes,
      beforeTableFactory: () => parquetSummaryPanel(payload)
    });
  }

  function tableErrorTitle(root, error) {
    const code = String(error?.code || '');
    const spreadsheet = root?.dataset?.previewKind === 'spreadsheet' || root?.classList?.contains('remote-spreadsheet-preview');
    if (code === 'unsupported_xls_container') return 'Binary XLS file detected';
    if (code === 'invalid_workbook_container') return 'The file is not an XLSX/XLSM workbook';
    if (code === 'invalid_workbook_package') return 'The workbook package is incomplete';
    if (code === 'unknown_workbook_size') return 'Workbook size is unavailable';
    return spreadsheet ? 'Spreadsheet preview unavailable' : 'Data preview unavailable';
  }

  function showTableError(root, error) {
    const box = document.createElement('div');
    box.className = 'preview-error data-preview-error';
    const icon = document.createElement('i');
    icon.className = 'mdi mdi-alert-circle-outline';
    const copy = document.createElement('div');
    copy.className = 'data-preview-error-copy';
    const title = document.createElement('strong');
    title.textContent = tableErrorTitle(root, error);
    const message = document.createElement('p');
    message.textContent = String(error?.message || error);
    copy.append(title, message);
    box.append(icon, copy);
    if (root?.dataset?.sourceUrl) {
      const link = document.createElement('a');
      link.className = 'button is-light data-preview-error-action';
      link.href = root.dataset.sourceUrl;
      link.textContent = 'Download original';
      box.appendChild(link);
    }
    root.replaceChildren(box);
  }

  BB.tabular = {
    parseDelimited,
    parseTextTable,
    parseJSONLines,
    parseColumnFilter,
    matchesColumnFilter,
    compareTableValues,
    applyTableQuery,
    fetchTextTable,
    createRemoteDelimitedTable,
    renderSpreadsheet,
    renderParquet,
    renderTable,
    createQueryableTable,
    spreadsheetSheetData,
    MAX_ROWS,
    MAX_COLUMNS
  };
})();
