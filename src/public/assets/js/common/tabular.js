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
  const HYPARQUET_URL = 'https://cdn.jsdelivr.net/npm/hyparquet@1.26.2/src/hyparquet.min.js';
  const HYPARQUET_COMPRESSORS_URL = 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm';
  const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  let sheetJSPromise = null;
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
    wrapper.className = queryTools ? 'data-preview has-query-tools' : 'data-preview';

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

    if (onPage) {
      const pagination = document.createElement('div');
      pagination.className = 'data-preview-pagination';
      const totalPages = totalKnown ? Math.max(1, Math.ceil(knownTotal / pageSize)) : null;
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'bb-btn';
      previous.title = 'Previous page';
      previous.setAttribute('aria-label', 'Previous page');
      previous.appendChild(createIcon('chevron-left'));
      previous.disabled = page <= 0;
      previous.addEventListener('click', () => onPage(page - 1));
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
      next.disabled = totalKnown ? end >= knownTotal : !hasNext;
      next.addEventListener('click', () => onPage(page + 1));
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
    table.className = 'data-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const rowNumberHead = document.createElement('th');
    rowNumberHead.className = 'data-row-number';
    rowNumberHead.textContent = '#';
    headRow.appendChild(rowNumberHead);
    headers.forEach((header, columnIndex) => {
      const cell = document.createElement('th');
      cell.title = header;
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
        const value = displayValue(row[columnIndex]);
        cell.textContent = value;
        cell.title = value;
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

  function createRemoteDelimitedTable({ key, size, etag = '', instance = null } = {}) {
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
        const result = await BB.api.documentCount({ key, instance, signal: state.controller?.signal || null });
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
      const result = await BB.api.searchDocument({ key, query: normalized, instance, signal: state.controller.signal });
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

  function loadSheetJS() {
    if (window.XLSX?.read && window.XLSX?.utils) return Promise.resolve(window.XLSX);
    if (sheetJSPromise) return sheetJSPromise;
    sheetJSPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-sheetjs-version="0.20.3"]');
      const complete = () => {
        if (window.XLSX?.read && window.XLSX?.utils) resolve(window.XLSX);
        else reject(new Error('The spreadsheet reader loaded without exposing its browser API.'));
      };
      if (existing) {
        existing.addEventListener('load', complete, { once: true });
        existing.addEventListener('error', () => reject(new Error('Unable to load the spreadsheet reader.')), { once: true });
        if (existing.dataset.loaded === 'true') complete();
        return;
      }
      const script = document.createElement('script');
      script.src = SHEETJS_URL;
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      script.dataset.sheetjsVersion = '0.20.3';
      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        complete();
      }, { once: true });
      script.addEventListener('error', () => reject(new Error('Unable to load the spreadsheet reader.')), { once: true });
      document.head.appendChild(script);
    }).catch(error => {
      sheetJSPromise = null;
      throw error;
    });
    return sheetJSPromise;
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

  async function renderLegacySpreadsheet(url, key, size) {
    const byteLength = Number(size || 0);
    if (byteLength > MAX_SPREADSHEET_BYTES) {
      throw new Error(`Legacy XLS previews are limited to ${Math.round(MAX_SPREADSHEET_BYTES / 1024 / 1024)} MiB. Download this workbook for full processing.`);
    }
    const XLSX = await loadSheetJS();
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to read spreadsheet: HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    const workbook = XLSX.read(data, {
      type: 'array',
      cellDates: true,
      dense: true,
      sheetRows: MAX_ROWS + 1,
      bookVBA: false
    });
    const names = Array.from(workbook.SheetNames || []);
    if (!names.length) throw new Error('The workbook does not contain any worksheets.');

    const root = document.createElement('section');
    root.className = 'spreadsheet-preview';
    const host = document.createElement('div');
    host.className = 'spreadsheet-sheet-host';
    const panels = new Map();
    let activePanel = null;
    const descriptors = names.map((name, index) => {
      const visibility = spreadsheetVisibility(workbook, index);
      return { index, name, hidden: visibility.hidden === 2 ? 'veryHidden' : (visibility.hidden ? 'hidden' : '') };
    });

    const activate = index => {
      const bounded = Math.max(0, Math.min(names.length - 1, Number(index) || 0));
      let panel = panels.get(bounded);
      if (!panel) {
        const sheet = spreadsheetSheetData(XLSX, workbook.Sheets[names[bounded]]);
        panel = createQueryableTable(sheet, {
          beforeTableFactory: () => createSpreadsheetSheetControls(descriptors, bounded, activate)
        });
        panel.dataset.sheetIndex = String(bounded);
        panels.set(bounded, panel);
      }
      activePanel = panel;
      host.replaceChildren(panel);
    };

    root.documentSearch = async query => {
      if (typeof activePanel?.documentSearch === 'function') await activePanel.documentSearch(query);
    };
    root.appendChild(host);
    activate(0);
    return root;
  }

  async function renderRemoteSpreadsheet(key, objectSize = 0) {
    const root = document.createElement('section');
    root.className = 'spreadsheet-preview remote-spreadsheet-preview';
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

  async function renderSpreadsheet(url, key, size) {
    const extension = BB.detect.extOf(key);
    if (extension === 'xlsx' || extension === 'xlsm') return renderRemoteSpreadsheet(key, size);
    return renderLegacySpreadsheet(url, key, size);
  }

  function remoteAsyncBuffer(url, byteLength, signalProvider = null) {
    return {
      byteLength,
      async slice(start, end) {
        const finalEnd = end == null ? byteLength : Math.min(end, byteLength);
        if (start < 0 || finalEnd < start) throw new RangeError('Invalid Parquet byte range.');
        if (finalEnd === start) return new ArrayBuffer(0);
        const signal = typeof signalProvider === 'function' ? signalProvider() : null;
        const response = await fetch(url, {
          headers: { Range: `bytes=${start}-${finalEnd - 1}` },
          signal: signal || undefined,
          cache: 'no-store'
        });
        if (!response.ok && response.status !== 206) throw new Error(`Parquet range request failed: HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (response.status === 200 && buffer.byteLength === byteLength) return buffer.slice(start, finalEnd);
        return buffer;
      }
    };
  }

  async function renderParquet(url, size) {
    if (!Number.isFinite(Number(size)) || Number(size) <= 0) throw new Error('Parquet preview requires a known non-zero object size.');
    let parquet;
    try {
      parquet = await import(HYPARQUET_URL);
    } catch (error) {
      throw new Error(`The Parquet reader could not be loaded. ${error.message || error}`);
    }
    let compressors;
    try {
      const module = await import(HYPARQUET_COMPRESSORS_URL);
      compressors = module.compressors;
    } catch (_) {
      compressors = undefined;
    }

    let activeController = null;
    const file = remoteAsyncBuffer(url, Number(size), () => activeController?.signal || null);
    const metadata = await parquet.parquetMetadataAsync(file);
    const schema = parquet.parquetSchema(metadata);
    const headers = (schema.children || []).map(child => child.element?.name || child.name).filter(Boolean).slice(0, MAX_COLUMNS);
    const totalRows = Number(metadata.num_rows || 0);
    const root = document.createElement('div');
    const state = {
      page: 0,
      pageSize: DEFAULT_PAGE_SIZE,
      query: '',
      matches: null,
      totalMatches: 0,
      retainedLimit: 10000
    };
    let requestSerial = 0;

    function loading(label, detail = '') {
      const node = document.createElement('div');
      node.className = 'preview-loading data-loading';
      const icon = document.createElement('i');
      icon.className = 'mdi mdi-loading mdi-spin';
      const copy = document.createElement('span');
      copy.textContent = detail ? `${label} ${detail}` : label;
      node.append(icon, copy);
      root.replaceChildren(node);
      return copy;
    }

    async function readRows(rowStart, rowEnd) {
      const options = { file, rowStart, rowEnd, columns: headers };
      if (compressors) options.compressors = compressors;
      return parquet.parquetReadObjects(options);
    }

    async function scan(query, serial) {
      const normalized = String(query || '').trim().toLocaleLowerCase();
      if (!normalized) {
        state.matches = null;
        state.totalMatches = 0;
        return;
      }
      const progress = loading('Searching the complete Parquet document…');
      const retained = [];
      let totalMatches = 0;
      const batchSize = 2048;
      for (let rowStart = 0; rowStart < totalRows; rowStart += batchSize) {
        if (serial !== requestSerial) return;
        const rowEnd = Math.min(totalRows, rowStart + batchSize);
        const objects = await readRows(rowStart, rowEnd);
        if (serial !== requestSerial) return;
        objects.forEach((object, localIndex) => {
          const row = headers.map(header => displayValue(object[header]));
          if (!row.some(value => value.toLocaleLowerCase().includes(normalized))) return;
          totalMatches++;
          if (retained.length < state.retainedLimit) retained.push({ row, rowNumber: rowStart + localIndex + 1 });
        });
        progress.textContent = `Searching the complete Parquet document… ${rowEnd.toLocaleString()} / ${totalRows.toLocaleString()} rows`;
      }
      state.matches = retained;
      state.totalMatches = totalMatches;
    }

    async function draw(nextPage = state.page, options = {}) {
      const serial = ++requestSerial;
      activeController?.abort();
      activeController = new AbortController();
      state.page = Math.max(0, Number(nextPage) || 0);
      try {
        if (Object.prototype.hasOwnProperty.call(options, 'query')) {
          state.query = String(options.query || '').trim();
          state.page = 0;
          await scan(state.query, serial);
          if (serial !== requestSerial) return;
        }

        let rows;
        let rowNumbers;
        let total;
        if (state.matches) {
          const maximumPage = Math.max(0, Math.ceil(state.matches.length / state.pageSize) - 1);
          state.page = Math.min(state.page, maximumPage);
          const start = state.page * state.pageSize;
          const pageEntries = state.matches.slice(start, start + state.pageSize);
          rows = pageEntries.map(entry => entry.row);
          rowNumbers = pageEntries.map(entry => entry.rowNumber);
          total = state.matches.length;
        } else {
          const rowStart = state.page * state.pageSize;
          const rowEnd = Math.min(rowStart + state.pageSize, totalRows);
          loading('Reading Parquet rows…');
          const objects = await readRows(rowStart, rowEnd);
          if (serial !== requestSerial) return;
          rows = objects.map(object => headers.map(header => displayValue(object[header])));
          rowNumbers = rows.map((_, index) => rowStart + index + 1);
          total = totalRows;
        }

        const notes = [];
        if (headers.length >= MAX_COLUMNS) notes.push(`Preview limited to the first ${MAX_COLUMNS} top-level columns.`);
        if (state.query) {
          notes.push(`Search scanned all ${totalRows.toLocaleString()} rows.`);
          if (state.totalMatches > state.matches.length) notes.push(`Showing the first ${state.matches.length.toLocaleString()} of ${state.totalMatches.toLocaleString()} matches to keep browser memory bounded.`);
        }
        root.replaceChildren(renderTable({
          headers,
          rows,
          rowNumbers,
          totalRows: total,
          sourceTotalRows: state.query ? state.totalMatches : totalRows,
          page: state.page,
          pageSize: state.pageSize,
          onPage: page => void draw(page).catch(error => showTableError(root, error)),
          note: notes.join(' '),
          queryTools: {
            allowFilters: false,
            allowSort: false,
            filters: headers.map(() => ''),
            showFilters: false,
            sortColumn: -1,
            sortDirection: '',
            globalQuery: state.query,
            onToggleFilters() {},
            onColumnFilter() {},
            onSort() {},
            onPageSize(value) {
              if (!PAGE_SIZE_OPTIONS.includes(value)) return;
              state.pageSize = value;
              void draw(0).catch(error => showTableError(root, error));
            },
            onClear() {
              state.query = '';
              state.matches = null;
              state.totalMatches = 0;
              void draw(0).catch(error => showTableError(root, error));
            }
          }
        }));
      } catch (error) {
        if (error?.name === 'AbortError' || serial !== requestSerial) return;
        throw error;
      }
    }

    root.documentSearch = async query => {
      await draw(0, { query });
    };
    root.cleanup = () => activeController?.abort();
    await draw(0);
    return root;
  }

  function showTableError(root, error) {
    const box = document.createElement('div');
    box.className = 'preview-error';
    const icon = document.createElement('i');
    icon.className = 'mdi mdi-alert-circle-outline';
    const title = document.createElement('strong');
    title.textContent = 'Data preview unavailable';
    const message = document.createElement('p');
    message.textContent = String(error?.message || error);
    box.append(icon, title, message);
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
    remoteAsyncBuffer,
    MAX_ROWS,
    MAX_COLUMNS
  };
})();
