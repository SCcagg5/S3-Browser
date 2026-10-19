/* Read-only SQLite viewer backed by bounded remote page reads. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  if (!BB.api || !BB.tabular) throw new Error('BB.api and BB.tabular are required before BB.sqliteViewer');
  const PAGE_SIZES = [100, 250, 500, 1000];

  function icon(name) {
    const node = document.createElement('i');
    node.className = `mdi mdi-${name}`;
    return node;
  }

  function createTableTabs(tables, activeIndex, activate) {
    if (!Array.isArray(tables) || tables.length < 2) return null;
    const controls = document.createElement('div');
    controls.className = 'spreadsheet-sheet-controls sqlite-table-controls';
    const tabs = document.createElement('div');
    tabs.className = 'spreadsheet-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'SQLite tables and views');
    const buttons = [];

    tables.forEach((table, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'spreadsheet-tab';
      button.setAttribute('role', 'tab');
      button.title = `${table.name} · ${table.type}`;
      button.append(icon(table.type === 'view' ? 'table-eye' : 'table'), document.createTextNode(table.name));
      button.addEventListener('click', () => activate(index));
      buttons.push(button);
      tabs.appendChild(button);
    });

    const selectLabel = document.createElement('label');
    selectLabel.className = 'spreadsheet-sheet-select';
    const selectText = document.createElement('span');
    selectText.textContent = 'Table';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'SQLite table or view');
    tables.forEach((table, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = table.type === 'view' ? `${table.name} (view)` : table.name;
      select.appendChild(option);
    });
    select.addEventListener('change', event => activate(Number(event.target.value)));
    selectLabel.append(selectText, select);
    controls.append(tabs, selectLabel);

    const bounded = Math.max(0, Math.min(tables.length - 1, Number(activeIndex) || 0));
    buttons.forEach((button, index) => {
      const active = index === bounded;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    select.value = String(bounded);
    return controls;
  }

  function normalizeWheelDelta(event, page) {
    if (event.deltaMode === 1) return event.deltaY * 16;
    if (event.deltaMode === 2) return event.deltaY * Math.max(1, page.clientHeight);
    return event.deltaY;
  }

  function keepVerticalWheelOnPage(scroller) {
    if (!scroller || scroller.dataset.pageWheel === 'true') return;
    scroller.dataset.pageWheel = 'true';
    scroller.addEventListener('wheel', event => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const page = document.scrollingElement || document.documentElement;
      if (!page) return;
      const delta = normalizeWheelDelta(event, page);
      const canMove = delta < 0
        ? page.scrollTop > 0
        : page.scrollTop + page.clientHeight < page.scrollHeight - 1;
      if (!canMove || delta === 0) return;
      page.scrollTop += delta;
      event.preventDefault();
    }, { passive: false });
  }

  function loadingView(label) {
    const loader = document.createElement('div');
    loader.className = 'preview-loading data-loading';
    loader.append(icon('loading mdi-spin'), document.createTextNode(label));
    return loader;
  }

  function errorView(error) {
    const box = document.createElement('div');
    box.className = 'preview-error';
    box.innerHTML = '<i class="mdi mdi-alert-circle-outline"></i><strong>SQLite query failed</strong>';
    const detail = document.createElement('p');
    detail.textContent = String(error?.message || error);
    box.appendChild(detail);
    return box;
  }

  async function renderSQLite({ key, size = 0, version = '', instance = '' } = {}) {
    const root = document.createElement('section');
    root.className = 'sqlite-preview preview-data';
    root.appendChild(loadingView('Preparing the SQLite database...'));

    const abortController = new AbortController();
    let requestController = null;
    let requestSerial = 0;
    let redrawTimer = 0;
    let session = null;
    const state = {
      table: 0,
      page: 0,
      pageSize: 100,
      filters: {},
      showFilters: false,
      sortColumn: '',
      sortDirection: ''
    };

    try {
      session = await BB.api.createSQLiteSession({ key, size, version, instance, signal: abortController.signal });
    } catch (error) {
      root.replaceChildren(errorView(error));
      root.cleanup = () => abortController.abort();
      return root;
    }

    const tables = Array.from(session.tables || []);
    if (!tables.length) {
      const empty = document.createElement('div');
      empty.className = 'preview-error';
      empty.innerHTML = '<i class="mdi mdi-database-off-outline"></i><strong>No user tables or views</strong><p>The database does not expose any non-system tables.</p>';
      root.replaceChildren(empty);
      root.cleanup = () => {
        abortController.abort();
        if (session?.id) BB.api.deleteSQLiteSession(session.id, { keepalive: true }).catch(() => {});
      };
      return root;
    }

    function activeFilters() {
      return Object.fromEntries(Object.entries(state.filters).filter(([, value]) => String(value || '').trim()));
    }

    function restoreFocus(columnIndex) {
      if (!Number.isInteger(columnIndex) || columnIndex < 0) return;
      requestAnimationFrame(() => {
        const input = root.querySelector(`[data-filter-column="${columnIndex}"]`);
        if (!input) return;
        input.focus({ preventScroll: true });
        const end = input.value.length;
        input.setSelectionRange?.(end, end);
      });
    }

    function activateTable(index) {
      const bounded = Math.max(0, Math.min(tables.length - 1, Number(index) || 0));
      if (bounded === state.table) return;
      state.table = bounded;
      state.page = 0;
      state.filters = {};
      state.sortColumn = '';
      state.sortDirection = '';
      void draw(0);
    }

    function scheduleFilter(columnIndex) {
      window.clearTimeout(redrawTimer);
      redrawTimer = window.setTimeout(() => void draw(0, columnIndex, true), 220);
    }

    async function draw(nextPage = state.page, focusColumn = -1, preserveHorizontalScroll = false) {
      const previousScrollLeft = preserveHorizontalScroll
        ? Number(root.querySelector('.data-table-scroll')?.scrollLeft || 0)
        : 0;
      state.page = Math.max(0, Number(nextPage) || 0);
      requestController?.abort();
      requestController = new AbortController();
      const serial = ++requestSerial;
      const active = tables[Math.max(0, Math.min(tables.length - 1, state.table))];
      if (!root.querySelector('.bb-data-grid')) root.replaceChildren(loadingView(`Reading ${active.name}...`));
      else {
        root.classList.add('is-loading-query');
        root.setAttribute('aria-busy', 'true');
      }

      try {
        const payload = await BB.api.sqliteTable({
          id: session.id,
          table: active.name,
          page: state.page,
          pageSize: state.pageSize,
          filters: activeFilters(),
          sortColumn: state.sortColumn,
          sortDirection: state.sortDirection,
          signal: requestController.signal
        });
        if (serial !== requestSerial) return;
        state.page = Math.max(0, Number(payload.page) || 0);
        state.pageSize = Math.max(1, Number(payload.pageSize) || state.pageSize);
        const columns = Array.from(payload.columns || active.columns || []);
        const headers = columns.map(column => column.name);
        const rows = Array.from(payload.rows || []).map(row => headers.map(header => row?.[header]));
        const rowNumbers = rows.map((_, index) => state.page * state.pageSize + index + 1);
        const totalRows = payload.totalKnown ? Math.max(0, Number(payload.totalRows) || 0) : Number.NaN;
        const sourceTotalRows = payload.sourceTotalKnown ? Math.max(0, Number(payload.sourceTotalRows) || 0) : Number.NaN;
        const filterValues = headers.map(header => String(state.filters[header] || ''));
        const sortColumnIndex = headers.indexOf(state.sortColumn);

        const table = BB.tabular.renderTable({
          headers,
          rows,
          rowNumbers,
          totalRows,
          sourceTotalRows,
          page: state.page,
          pageSize: state.pageSize,
          hasNext: Boolean(payload.hasMore),
          onPage: page => void draw(page),
          beforeTable: createTableTabs(tables, state.table, activateTable),
          emptyMessage: 'This table contains no matching rows.',
          queryTools: {
            filters: filterValues,
            showFilters: state.showFilters,
            sortColumn: sortColumnIndex,
            sortDirection: state.sortDirection,
            globalQuery: '',
            onColumnFilter(columnIndex, value) {
              const header = headers[columnIndex];
              if (!header) return;
              state.filters[header] = String(value || '');
              scheduleFilter(columnIndex);
            },
            onToggleFilters() {
              window.clearTimeout(redrawTimer);
              state.showFilters = !state.showFilters;
              void draw(state.page, -1, true);
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
              void draw(0, -1, true);
            },
            onPageSize(value) {
              window.clearTimeout(redrawTimer);
              if (!PAGE_SIZES.includes(value)) return;
              state.pageSize = value;
              void draw(0, -1, true);
            },
            onClear() {
              window.clearTimeout(redrawTimer);
              state.filters = {};
              state.sortColumn = '';
              state.sortDirection = '';
              void draw(0, -1, true);
            }
          }
        });
        root.replaceChildren(table);
        root.classList.remove('is-loading-query');
        root.removeAttribute('aria-busy');
        const scroller = root.querySelector('.data-table-scroll');
        keepVerticalWheelOnPage(scroller);
        if (preserveHorizontalScroll && scroller) scroller.scrollLeft = previousScrollLeft;
        restoreFocus(focusColumn);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        root.replaceChildren(errorView(error));
        root.classList.remove('is-loading-query');
        root.removeAttribute('aria-busy');
      }
    }

    await draw(0);
    root.cleanup = () => {
      window.clearTimeout(redrawTimer);
      requestController?.abort();
      abortController.abort();
      if (session?.id) BB.api.deleteSQLiteSession(session.id, { keepalive: true }).catch(() => {});
    };
    return root;
  }

  BB.sqliteViewer = { render: renderSQLite };
})();
