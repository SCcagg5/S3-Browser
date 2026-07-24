/* Read-only SQLite viewer backed by a short-lived server-side working copy. */
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

    controls.setActive = index => {
      const bounded = Math.max(0, Math.min(tables.length - 1, Number(index) || 0));
      buttons.forEach((button, buttonIndex) => {
        const active = buttonIndex === bounded;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      select.value = String(bounded);
    };
    controls.setActive(activeIndex);
    return controls;
  }

  function createSearchControls(state, redraw) {
    const toolbar = document.createElement('div');
    toolbar.className = 'sqlite-query-toolbar';
    const search = document.createElement('label');
    search.className = 'sqlite-search';
    search.appendChild(icon('magnify'));
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search the complete table...';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Search the complete SQLite table');
    let timer = 0;
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      state.query = input.value;
      timer = window.setTimeout(() => redraw(0, { focusSearch: true }), 280);
    });
    search.appendChild(input);

    const rows = document.createElement('label');
    rows.className = 'data-page-size';
    const rowsText = document.createElement('span');
    rowsText.textContent = 'Rows';
    const select = document.createElement('select');
    PAGE_SIZES.forEach(size => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = String(size);
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      state.pageSize = Number(select.value) || 100;
      redraw(0);
    });
    rows.append(rowsText, select);
    toolbar.append(search, rows);
    toolbar.searchInput = input;
    toolbar.sync = () => {
      if (input.value !== state.query) input.value = state.query;
      select.value = String(state.pageSize);
    };
    toolbar.sync();
    return toolbar;
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

  function createTableLoader(label) {
    const loader = document.createElement('div');
    loader.className = 'sqlite-table-loader';
    loader.append(icon('loading mdi-spin'), document.createTextNode(label));
    return loader;
  }

  async function renderSQLite({ key, size = 0, instance = '' } = {}) {
    const root = document.createElement('section');
    root.className = 'sqlite-preview preview-data';
    const loading = document.createElement('div');
    loading.className = 'preview-loading';
    loading.append(icon('loading mdi-spin'), document.createTextNode('Preparing the SQLite database...'));
    root.appendChild(loading);

    const abortController = new AbortController();
    let session = null;
    let requestController = null;
    let requestSerial = 0;
    const state = { table: 0, page: 0, pageSize: 100, query: '' };

    try {
      session = await BB.api.createSQLiteSession({ key, size, instance, signal: abortController.signal });
    } catch (error) {
      const message = document.createElement('div');
      message.className = 'preview-error';
      message.innerHTML = '<i class="mdi mdi-alert-circle-outline"></i><strong>SQLite preview unavailable</strong>';
      const detail = document.createElement('p');
      detail.textContent = String(error?.message || error);
      message.appendChild(detail);
      root.replaceChildren(message);
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

    root.replaceChildren();
    const tableHost = document.createElement('div');
    tableHost.className = 'sqlite-table-host';
    let tabs = null;
    let searchControls = null;

    const activateTable = index => {
      const bounded = Math.max(0, Math.min(tables.length - 1, Number(index) || 0));
      if (bounded === state.table && tableHost.childElementCount) return;
      state.table = bounded;
      state.query = '';
      state.page = 0;
      tabs?.setActive?.(bounded);
      searchControls?.sync?.();
      void draw(0);
    };

    tabs = createTableTabs(tables, state.table, activateTable);
    searchControls = createSearchControls(state, draw);
    if (tabs) root.appendChild(tabs);
    root.append(searchControls, tableHost);

    function showLoading(label) {
      tableHost.classList.add('is-loading');
      tableHost.querySelector(':scope > .sqlite-table-loader')?.remove();
      tableHost.appendChild(createTableLoader(label));
    }

    function hideLoading() {
      tableHost.classList.remove('is-loading');
      tableHost.querySelector(':scope > .sqlite-table-loader')?.remove();
    }

    async function draw(nextPage = state.page, options = {}) {
      state.page = Math.max(0, Number(nextPage) || 0);
      requestController?.abort();
      requestController = new AbortController();
      const serial = ++requestSerial;
      const active = tables[Math.max(0, Math.min(tables.length - 1, state.table))];
      tabs?.setActive?.(state.table);
      searchControls?.sync?.();
      showLoading(`Reading ${active.name}...`);
      try {
        const payload = await BB.api.sqliteTable({
          id: session.id,
          table: active.name,
          page: state.page,
          pageSize: state.pageSize,
          query: state.query,
          signal: requestController.signal
        });
        if (serial !== requestSerial) return;
        const columns = Array.from(payload.columns || active.columns || []);
        const headers = columns.map(column => column.name);
        const rows = Array.from(payload.rows || []).map(row => headers.map(header => row?.[header]));
        const rowNumbers = rows.map((_, index) => state.page * state.pageSize + index + 1);
        const totalRows = Math.max(0, Number(payload.totalRows) || 0);
        const sourceTotalRows = Math.max(totalRows, Number(payload.sourceTotalRows) || 0);
        const table = BB.tabular.renderTable({
          headers,
          rows,
          rowNumbers,
          totalRows,
          sourceTotalRows,
          page: state.page,
          pageSize: state.pageSize,
          onPage: page => draw(page),
          note: payload.query ? `Search scans the complete ${active.type}.` : ''
        });
        tableHost.replaceChildren(table);
        tableHost.classList.remove('is-loading');
        keepVerticalWheelOnPage(table.querySelector('.data-table-scroll'));
        if (options.focusSearch) requestAnimationFrame(() => searchControls.searchInput?.focus({ preventScroll: true }));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        const box = document.createElement('div');
        box.className = 'preview-error';
        box.innerHTML = '<i class="mdi mdi-alert-circle-outline"></i><strong>SQLite query failed</strong>';
        const detail = document.createElement('p');
        detail.textContent = String(error?.message || error);
        box.appendChild(detail);
        tableHost.replaceChildren(box);
        tableHost.classList.remove('is-loading');
      } finally {
        if (serial === requestSerial) hideLoading();
      }
    }

    await draw(0);

    root.documentSearch = async query => {
      state.query = String(query || '').trim();
      searchControls.sync();
      await draw(0, { focusSearch: true });
    };
    root.cleanup = () => {
      requestController?.abort();
      abortController.abort();
      if (session?.id) BB.api.deleteSQLiteSession(session.id, { keepalive: true }).catch(() => {});
    };
    return root;
  }

  BB.sqliteViewer = { render: renderSQLite };
})();
