/* Large JSON preview. Raw and Beautify are paged server-side; Tree nodes are
   expanded server-side with constant-memory streaming parsers. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const TREE_PAGE_SIZE = 50;

  function makeButton(icon, label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'json-tool-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const iconElement = document.createElement('i');
    iconElement.className = `mdi mdi-${icon}`;
    const text = document.createElement('span');
    text.textContent = label;
    button.append(iconElement, text);
    return button;
  }

  function normalizeOptions(input, fallbackSize) {
    if (input && typeof input === 'object') {
      return {
        key: String(input.key || ''),
        size: Math.max(0, Number(input.size) || 0),
        etag: String(input.etag || ''),
        instance: input.instance == null ? null : String(input.instance)
      };
    }
    const url = BB.runtime.resolveURL(String(input || ''));
    return {
      key: String(url.searchParams.get('key') || ''),
      size: Math.max(0, Number(fallbackSize) || 0),
      etag: '',
      instance: url.searchParams.get('instance')
    };
  }

  function createModeButton(name, label, active) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `spreadsheet-tab json-mode-tab${active ? ' is-active' : ''}`;
    button.dataset.mode = name;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    return button;
  }

  function createTextPager(view, mode) {
    const panel = document.createElement('section');
    panel.className = `json-panel json-${mode}-panel`;

    const pager = document.createElement('div');
    pager.className = 'json-toolbar json-inline-pager';
    const range = document.createElement('span');
    range.className = 'json-range-label';
    const previous = makeButton('chevron-left', 'Previous page');
    const next = makeButton('chevron-right', 'Next page');
    pager.append(range, previous, next);

    const host = document.createElement('div');
    host.className = 'json-text-host';
    panel.append(host);

    const cursors = [''];
    let pageIndex = 0;
    let current = null;
    let generation = 0;

    function totals() {
      const summary = view.summary;
      if (!summary) return null;
      return mode === 'raw'
        ? { lines: Number(summary.rawLines || 0), pages: Number(summary.rawPages || 0) }
        : { lines: Number(summary.beautifyLines || 0), pages: Number(summary.beautifyPages || 0) };
    }

    function updateRangeLabel() {
      if (!current) {
        range.textContent = mode === 'raw' ? 'Raw JSON' : 'Beautified JSON';
        return;
      }
      const lineStart = Math.max(1, Number(current.lineStart) || 1);
      const lineEnd = Math.max(lineStart, Number(current.lineEnd) || lineStart);
      const known = totals();
      const lineSuffix = known?.lines > 0 ? ` of ${known.lines.toLocaleString()}` : '';
      const pageSuffix = known?.pages > 0 ? ` of ${known.pages.toLocaleString()}` : '';
      const counting = view.summaryState === 'loading' ? ' · counting totals…' : '';
      range.textContent = `Lines ${lineStart.toLocaleString()}–${lineEnd.toLocaleString()}${lineSuffix} · page ${(pageIndex + 1).toLocaleString()}${pageSuffix}${counting}`;
    }

    async function loadPage(index) {
      const target = Math.max(0, Math.min(cursors.length - 1, Number(index) || 0));
      const localGeneration = ++generation;
      pageIndex = target;
      previous.disabled = true;
      next.disabled = true;
      host.className = 'json-text-host is-loading';
      host.textContent = mode === 'raw' ? 'Reading raw JSON…' : 'Formatting JSON…';
      try {
        const request = {
          key: view.key,
          cursor: cursors[target] || '',
          etag: view.etag,
          instance: view.instance,
          signal: view.signal
        };
        const payload = mode === 'raw'
          ? await BB.api.jsonRaw(request)
          : await BB.api.jsonBeautify(request);
        if (localGeneration !== generation) return;
        current = payload;
        host.className = 'json-text-host';
        host.replaceChildren(BB.render.renderWrappedCode(payload.text || '', 'json', {
          startLine: Math.max(1, Number(payload.lineStart) || 1),
          continued: payload.continued === true,
          startInString: payload.startInString === true,
          startEscaped: payload.startEscaped === true
        }));
        previous.disabled = target <= 0;
        next.disabled = payload.done === true || !payload.nextCursor;
        if (payload.nextCursor) cursors[target + 1] = payload.nextCursor;
        updateRangeLabel();
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.className = 'json-text-host is-error';
        host.textContent = String(error?.message || error);
        range.textContent = `${mode === 'raw' ? 'Raw' : 'Beautify'} preview failed`;
        previous.disabled = target <= 0;
      }
    }

    previous.addEventListener('click', () => {
      if (pageIndex > 0) void loadPage(pageIndex - 1);
    });
    next.addEventListener('click', () => {
      if (current?.nextCursor) {
        cursors[pageIndex + 1] = current.nextCursor;
        void loadPage(pageIndex + 1);
      }
    });

    panel.pager = pager;
    panel.refreshSummary = updateRangeLabel;
    panel.load = () => loadPage(pageIndex);
    panel.reset = () => {
      cursors.splice(1);
      pageIndex = 0;
      current = null;
      return loadPage(0);
    };
    return panel;
  }

  function createTreeNode(view, node, depth, options = {}) {
    const item = document.createElement('div');
    item.className = 'json-tree-node';
    item.style.setProperty('--json-depth', String(depth));

    const line = document.createElement('div');
    line.className = 'json-tree-line';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'json-tree-toggle';
    toggle.setAttribute('aria-label', node.container ? 'Expand JSON node' : 'Scalar value');
    toggle.disabled = !node.container;
    const toggleIcon = document.createElement('i');
    toggleIcon.className = node.container ? 'mdi mdi-plus-box-outline' : 'mdi mdi-circle-small';
    toggle.appendChild(toggleIcon);

    const key = document.createElement('span');
    key.className = 'json-tree-key';
    key.textContent = options.rootLabel || node.label || '(root)';
    const type = document.createElement('span');
    type.className = `json-tree-type is-${node.type}`;
    type.textContent = node.type;
    const preview = document.createElement('span');
    preview.className = 'json-tree-preview';
    function containerPreview(count, known) {
      const numeric = Math.max(0, Number(count) || 0);
      if (node.type === 'array') {
        if (known) return `[${numeric.toLocaleString()} element${numeric === 1 ? '' : 's'}]`;
        if (numeric > 0) return `[${numeric.toLocaleString()}+ elements]`;
        return '[…]';
      }
      if (node.type === 'object') {
        if (known) return `{${numeric.toLocaleString()} propert${numeric === 1 ? 'y' : 'ies'}}`;
        if (numeric > 0) return `{${numeric.toLocaleString()}+ properties}`;
        return '{…}';
      }
      return node.preview || '';
    }
    preview.textContent = node.container
      ? containerPreview(node.count, node.countKnown === true)
      : (node.preview || '');
    line.append(toggle, key, type, preview);

    const children = document.createElement('div');
    children.className = 'json-tree-children';
    children.hidden = true;
    item.append(line, children);

    let expanded = false;
    let loading = false;
    let initialized = false;
    let cursor = '';
    let nextIndex = 0;
    let done = false;

    function removeMoreButton() {
      children.querySelector(':scope > .json-tree-more')?.remove();
    }

    function appendPayload(payload) {
      removeMoreButton();
      for (const child of payload.children || []) {
        children.appendChild(createTreeNode(view, child, depth + 1));
      }
      cursor = String(payload.cursor || '');
      nextIndex = Math.max(0, Number(payload.nextIndex) || 0);
      done = payload.done === true;
      const knownCount = payload.node?.countKnown === true;
      const displayedCount = knownCount ? Number(payload.node?.count || nextIndex) : nextIndex;
      if (node.container) preview.textContent = containerPreview(displayedCount, knownCount || done);
      initialized = true;
      if (!done && cursor) {
        const more = makeButton('dots-horizontal', 'Load more', 'json-tree-more');
        more.addEventListener('click', event => {
          event.stopPropagation();
          void appendPage();
        });
        children.appendChild(more);
      }
      if (!(payload.children || []).length && done && !children.childNodes.length) {
        const empty = document.createElement('div');
        empty.className = 'json-tree-empty';
        empty.textContent = node.type === 'object' ? 'Empty object' : 'Empty array';
        children.appendChild(empty);
      }
    }

    async function appendPage() {
      if (loading || !node.container || done) return;
      loading = true;
      toggle.disabled = true;
      toggleIcon.className = 'mdi mdi-loading mdi-spin';
      try {
        const payload = await BB.api.jsonTree({
          key: view.key,
          start: node.start,
          cursor,
          index: nextIndex,
          type: node.type,
          limit: TREE_PAGE_SIZE,
          etag: view.etag,
          instance: view.instance,
          signal: view.signal
        });
        appendPayload(payload);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          const failure = document.createElement('div');
          failure.className = 'json-tree-error';
          failure.textContent = String(error?.message || error);
          children.appendChild(failure);
        }
      } finally {
        loading = false;
        toggle.disabled = false;
        toggleIcon.className = expanded ? 'mdi mdi-minus-box-outline' : 'mdi mdi-plus-box-outline';
      }
    }

    function setExpanded(value) {
      if (!node.container || loading) return;
      expanded = value;
      children.hidden = !expanded;
      toggleIcon.className = expanded ? 'mdi mdi-minus-box-outline' : 'mdi mdi-plus-box-outline';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (expanded && !initialized) void appendPage();
    }

    toggle.addEventListener('click', () => setExpanded(!expanded));

    if (options.initialPayload) {
      appendPayload(options.initialPayload);
      setExpanded(true);
    }
    return item;
  }

  function createTreePanel(view) {
    const panel = document.createElement('section');
    panel.className = 'json-panel json-tree-panel';
    let initialized = false;

    async function initialize() {
      if (initialized) return;
      initialized = true;
      panel.classList.add('is-loading');
      panel.textContent = 'Reading the JSON root…';
      try {
        const payload = await BB.api.jsonTree({
          key: view.key,
          limit: TREE_PAGE_SIZE,
          etag: view.etag,
          instance: view.instance,
          signal: view.signal
        });
        panel.classList.remove('is-loading');
        panel.replaceChildren(createTreeNode(view, payload.node, 0, {
          rootLabel: '(root)',
          initialPayload: payload.node?.container ? payload : null
        }));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        panel.className = 'json-panel json-tree-panel is-error';
        panel.textContent = String(error?.message || error);
      }
    }

    panel.load = initialize;
    return panel;
  }

  function renderJSON(input, fallbackSize) {
    const options = normalizeOptions(input, fallbackSize);
    const abortController = new AbortController();
    const view = {
      ...options,
      signal: abortController.signal,
      summary: null,
      summaryState: 'idle',
      summaryPromise: null,
      ensureSummary: null
    };
    const root = document.createElement('div');
    root.className = 'json-preview';

    const controls = document.createElement('div');
    controls.className = 'spreadsheet-sheet-controls json-mode-controls';
    const tabs = document.createElement('div');
    tabs.className = 'spreadsheet-tabs json-tabs';
    tabs.setAttribute('role', 'tablist');
    const rawTab = createModeButton('raw', 'Raw', true);
    const beautifyTab = createModeButton('beautify', 'Beautify', false);
    const treeTab = createModeButton('tree', 'Tree', false);
    tabs.append(rawTab, beautifyTab, treeTab);

    const mobile = document.createElement('label');
    mobile.className = 'spreadsheet-sheet-select json-mode-select';
    const mobileLabel = document.createElement('span');
    mobileLabel.textContent = 'View';
    const select = document.createElement('select');
    for (const [value, label] of [['raw', 'Raw'], ['beautify', 'Beautify'], ['tree', 'Tree']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    mobile.append(mobileLabel, select);
    const countButton = makeButton('counter', 'Count lines and pages', 'json-tool-button json-count-button');
    const pagerHost = document.createElement('div');
    pagerHost.className = 'json-active-pager';
    controls.append(tabs, mobile, countButton, pagerHost);

    const rawPanel = createTextPager(view, 'raw');
    const beautifyPanel = createTextPager(view, 'beautify');
    const treePanel = createTreePanel(view);
    beautifyPanel.hidden = true;
    treePanel.hidden = true;

    const buttons = { raw: rawTab, beautify: beautifyTab, tree: treeTab };
    const panels = { raw: rawPanel, beautify: beautifyPanel, tree: treePanel };
    const loaded = new Set();
    let activeMode = 'raw';

    const syncCountButton = () => {
      countButton.hidden = activeMode === 'tree' || view.summaryState === 'ready';
    };

    view.ensureSummary = () => {
      if (view.summaryPromise) return view.summaryPromise;
      view.summaryState = 'loading';
      countButton.disabled = true;
      countButton.querySelector('i').className = 'mdi mdi-loading mdi-spin';
      countButton.querySelector('span').textContent = 'Counting…';
      rawPanel.refreshSummary?.();
      beautifyPanel.refreshSummary?.();
      view.summaryPromise = BB.api.jsonSummary({
        key: view.key,
        etag: view.etag,
        instance: view.instance,
        signal: view.signal
      }).then(summary => {
        view.summary = summary || null;
        view.summaryState = 'ready';
        countButton.disabled = false;
        countButton.querySelector('i').className = 'mdi mdi-counter';
        countButton.querySelector('span').textContent = 'Count lines and pages';
        countButton.title = 'Count lines and pages';
        syncCountButton();
        rawPanel.refreshSummary?.();
        beautifyPanel.refreshSummary?.();
        return summary;
      }).catch(error => {
        if (error?.name !== 'AbortError') console.warn('Unable to count JSON lines and pages', error);
        view.summaryState = 'error';
        view.summaryPromise = null;
        countButton.disabled = false;
        countButton.querySelector('i').className = 'mdi mdi-alert-circle-outline';
        countButton.querySelector('span').textContent = 'Retry count';
        countButton.title = 'Retry line and page count';
        syncCountButton();
        rawPanel.refreshSummary?.();
        beautifyPanel.refreshSummary?.();
        return null;
      });
      return view.summaryPromise;
    };
    countButton.addEventListener('click', () => void view.ensureSummary());

    function selectMode(mode) {
      const selected = panels[mode] ? mode : 'raw';
      activeMode = selected;
      syncCountButton();
      for (const [name, button] of Object.entries(buttons)) {
        const active = name === selected;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        panels[name].hidden = !active;
      }
      select.value = selected;
      pagerHost.replaceChildren();
      if (panels[selected]?.pager) pagerHost.appendChild(panels[selected].pager);
      if (!loaded.has(selected)) {
        loaded.add(selected);
        void panels[selected].load?.();
      }
    }

    for (const [name, button] of Object.entries(buttons)) {
      button.addEventListener('click', () => selectMode(name));
    }
    select.addEventListener('change', () => selectMode(select.value));

    root.append(controls, rawPanel, beautifyPanel, treePanel);
    selectMode('raw');
    root.cleanup = () => abortController.abort();
    return root;
  }

  BB.jsonViewer = { render: renderJSON };
})();
