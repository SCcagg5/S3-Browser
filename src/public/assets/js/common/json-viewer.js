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
    const url = new URL(String(input || ''), window.location.origin);
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

    const toolbar = document.createElement('div');
    toolbar.className = 'json-toolbar data-toolbar';
    const range = document.createElement('span');
    range.className = 'json-range-label';
    const previous = makeButton('chevron-left', 'Previous page');
    const next = makeButton('chevron-right', 'Next page');
    toolbar.append(range, previous, next);

    const host = document.createElement('div');
    host.className = 'json-text-host';
    panel.append(toolbar, host);

    const cursors = [''];
    let pageIndex = 0;
    let current = null;
    let generation = 0;

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
        const lineStart = Math.max(1, Number(payload.lineStart) || 1);
        const lineEnd = Math.max(lineStart, Number(payload.lineEnd) || lineStart);
        range.textContent = `Lines ${lineStart.toLocaleString()}–${lineEnd.toLocaleString()} · page ${(target + 1).toLocaleString()}`;
        host.className = 'json-text-host';
        host.replaceChildren(BB.render.renderWrappedCode(payload.text || '', 'json', {
          startLine: lineStart,
          continued: payload.continued === true
        }));
        previous.disabled = target <= 0;
        next.disabled = payload.done === true || !payload.nextCursor;
        if (payload.nextCursor) cursors[target + 1] = payload.nextCursor;
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
    preview.textContent = node.preview || (node.type === 'object' ? '{…}' : node.type === 'array' ? '[…]' : '');
    line.append(toggle, key, type, preview);

    const children = document.createElement('div');
    children.className = 'json-tree-children';
    children.hidden = true;
    item.append(line, children);

    let expanded = false;
    let loading = false;
    let initialized = false;
    let cursor = 0;
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
      cursor = Math.max(0, Number(payload.cursor) || 0);
      nextIndex = Math.max(0, Number(payload.nextIndex) || 0);
      done = payload.done === true;
      initialized = true;
      if (!done && cursor > 0) {
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
    const view = { ...options, signal: abortController.signal };
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
    controls.append(tabs, mobile);

    const rawPanel = createTextPager(view, 'raw');
    const beautifyPanel = createTextPager(view, 'beautify');
    const treePanel = createTreePanel(view);
    beautifyPanel.hidden = true;
    treePanel.hidden = true;

    const buttons = { raw: rawTab, beautify: beautifyTab, tree: treeTab };
    const panels = { raw: rawPanel, beautify: beautifyPanel, tree: treePanel };
    const loaded = new Set();

    function selectMode(mode) {
      const selected = panels[mode] ? mode : 'raw';
      for (const [name, button] of Object.entries(buttons)) {
        const active = name === selected;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        panels[name].hidden = !active;
      }
      select.value = selected;
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
