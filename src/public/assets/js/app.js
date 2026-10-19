const config = {
  primaryColor: '#167df0',
  pageSize: 50,
  allowDownloadAll: true,
  keyExcludePatterns: [/^index\.html$/],
  instanceId: '',
  capabilities: {},
  operations: {},
  runtime: {},
  versioningSupported: false,
};
window.BB = window.BB || {};
BB.cfg = config;

document.title = 'Object Storage Browser';
document.documentElement.style.setProperty('--primary-color', config.primaryColor);

(function main() {
  function normalizePrefix(value) {
    const clean = String(value || '').replace(/^\/+/, '').replace(/\/+$/, '');
    return clean ? clean + '/' : '';
  }

  function parseLegacyHash() {
    try {
      return normalizePrefix(decodeURIComponent((location.hash || '#').slice(1)));
    } catch (_) {
      return '';
    }
  }

  function escapeHTML(value) {
    const span = document.createElement('span');
    span.textContent = String(value == null ? '' : value);
    return span.innerHTML;
  }

  function dataTransferHasFiles(dataTransfer) {
    if (!dataTransfer) return false;
    if (Array.from(dataTransfer.types || []).includes('Files')) return true;
    return Array.from(dataTransfer.items || []).some(item => item.kind === 'file');
  }

  function cleanDroppedPath(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter(segment => segment && segment !== '.')
      .map(segment => segment === '..' ? '_' : segment)
      .join('/');
  }

  function readWebkitDirectoryBatch(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  function readWebkitFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  async function walkWebkitEntry(entry, parent, output) {
    if (!entry) return;
    const relative = cleanDroppedPath(parent ? `${parent}/${entry.name}` : entry.name);
    if (entry.isFile) {
      output.push({ file: await readWebkitFile(entry), relative });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await readWebkitDirectoryBatch(reader);
      if (!batch.length) break;
      for (const child of batch) await walkWebkitEntry(child, relative, output);
    }
  }

  async function droppedUploadEntries(dataTransfer) {
    const output = [];
    const items = Array.from(dataTransfer?.items || []).filter(item => item.kind === 'file');
    let usedStructuredEntries = false;

    for (const item of items) {
      if (typeof item.webkitGetAsEntry !== 'function') continue;
      try {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          usedStructuredEntries = true;
          await walkWebkitEntry(entry, '', output);
        }
      } catch (error) {
        console.warn('Unable to read a dropped directory entry', error);
      }
    }

    if (!usedStructuredEntries) {
      for (const file of Array.from(dataTransfer?.files || [])) {
        output.push({ file, relative: cleanDroppedPath(file.webkitRelativePath || file.name) });
      }
    }

    const unique = new Map();
    for (const entry of output) {
      if (!entry.file || !entry.relative) continue;
      unique.set(entry.relative, entry);
    }
    return Array.from(unique.values());
  }

  let uploadManager = null;
  let uploadSequence = 0;

  function createUploadManager(browser) {
    const entries = new Map();
    const pending = [];
    const concurrency = 4;
    let activeCount = 0;
    let refreshTimer = 0;

    function scheduleRefresh(entry) {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (browser.instanceId !== entry.instanceId || browser.pathPrefix !== entry.basePrefix) return;
        Promise.resolve(browser.refresh()).catch(error => console.error('Unable to refresh after upload', error));
      }, 250);
    }

    function progressDetail(entry, progress = {}) {
      return BB.actions.formatTransferDetail({
        ...progress,
        uploadedBytes: Number(progress.uploadedBytes ?? entry.uploadedBytes ?? 0),
        totalSize: entry.file.size
      }, entry.status === 'queued' ? 'queued' : '');
    }

    function updateEntry(entry, next = {}) {
      Object.assign(entry, next);
      entry.item.update({
        name: entry.relative,
        status: entry.status,
        progress: entry.file.size > 0 ? Math.min(1, Math.max(0, entry.uploadedBytes / entry.file.size)) : null,
        indeterminate: entry.file.size <= 0 && ['queued', 'preparing', 'running'].includes(entry.status),
        detail: entry.detail || progressDetail(entry),
        onPause: () => pause(entry),
        onResume: () => resume(entry),
        onCancel: () => cancel(entry)
      });
    }

    function enqueue(entry) {
      if (entry.status === 'queued' && !pending.includes(entry)) pending.push(entry);
      schedule();
    }

    function pause(entry) {
      if (!entry || ['completed', 'canceled', 'paused'].includes(entry.status)) return;
      entry.pauseRequested = true;
      entry.cancelRequested = false;
      if (entry.status === 'queued') {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        updateEntry(entry, { status: 'paused', detail: progressDetail(entry, { phase: 'paused' }) || 'Paused' });
        return;
      }
      updateEntry(entry, { status: 'preparing', detail: 'Pausing at the last confirmed checkpoint...' });
      entry.controller?.abort();
    }

    function resume(entry) {
      if (!entry || !['paused', 'error'].includes(entry.status)) return;
      entry.pauseRequested = false;
      entry.cancelRequested = false;
      updateEntry(entry, { status: 'queued', detail: entry.uploadedBytes > 0 ? 'Queued to resume...' : 'Queued...' });
      enqueue(entry);
    }

    async function cancel(entry) {
      if (!entry || ['completed', 'canceled'].includes(entry.status)) return;
      if (entry.cancelPromise) return entry.cancelPromise;
      entry.cancelRequested = true;
      entry.pauseRequested = false;
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      updateEntry(entry, { status: 'preparing', detail: 'Canceling upload...' });

      if (entry.controller && !entry.controller.signal.aborted) {
        entry.controller.abort();
        return;
      }

      entry.cancelPromise = (async () => {
        if (entry.resumeToken) {
          try { await BB.api.cancelUpload(entry.resumeToken); }
          catch (error) {
            if (Number(error?.status || 0) !== 404) throw error;
          }
        }
        entry.status = 'canceled';
        entry.item.canceled({ detail: progressDetail(entry) || 'Canceled' });
        entries.delete(entry.id);
      })().catch(error => {
        entry.cancelRequested = false;
        entry.status = 'error';
        entry.item.fail({
          name: entry.relative,
          progress: entry.file.size > 0 ? entry.uploadedBytes / entry.file.size : null,
          detail: `Unable to cancel upload: ${String(error?.message || error)}`,
          onResume: () => resume(entry),
          onCancel: () => cancel(entry)
        });
      }).finally(() => { entry.cancelPromise = null; });
      return entry.cancelPromise;
    }

    async function run(entry) {
      activeCount++;
      entry.status = 'running';
      entry.pauseRequested = false;
      entry.cancelRequested = false;
      entry.controller = new AbortController();
      const controller = entry.controller;
      updateEntry(entry, {
        status: 'running',
        detail: entry.uploadedBytes > 0 ? 'Resuming upload...' : 'Starting upload...'
      });

      try {
        await BB.api.uploadBlob(entry.key, entry.file, entry.file.type || 'application/octet-stream', {
          instance: entry.instanceId,
          lastModified: entry.file.lastModified,
          signal: controller.signal,
          onSession(upload) {
            entry.resumeToken = String(upload?.resumeToken || '');
          },
          onProgress(progress) {
            if (entry.pauseRequested || entry.cancelRequested) return;
            entry.uploadedBytes = Math.min(entry.file.size, Math.max(0, Number(progress.uploadedBytes || 0)));
            entry.detail = progressDetail(entry, progress);
            updateEntry(entry, { status: 'running' });
          }
        });
        entry.uploadedBytes = entry.file.size;
        entry.status = 'completed';
        entry.item.complete({
          detail: BB.actions.formatTransferDetail({ uploadedBytes: entry.file.size, totalSize: entry.file.size }),
          duration: 6000
        });
        entries.delete(entry.id);
        scheduleRefresh(entry);
      } catch (error) {
        if (BB.actions.isAbortError(error) || controller.signal.aborted) {
          if (entry.cancelRequested) {
            if (entry.resumeToken) {
              try { await BB.api.cancelUpload(entry.resumeToken); }
              catch (cancelError) { console.warn('Unable to cancel remote upload session', cancelError); }
            }
            entry.status = 'canceled';
            entry.item.canceled({ detail: progressDetail(entry) || 'Canceled' });
            entries.delete(entry.id);
          } else {
            entry.status = 'paused';
            updateEntry(entry, {
              status: 'paused',
              detail: `${progressDetail(entry)}${entry.uploadedBytes || entry.file.size ? ' · ' : ''}Resume continues from the last confirmed multipart or resumable checkpoint.`
            });
          }
        } else {
          entry.status = 'error';
          entry.detail = String(error?.message || error || 'Upload failed');
          entry.item.fail({
            name: entry.relative,
            progress: entry.file.size > 0 ? entry.uploadedBytes / entry.file.size : null,
            detail: entry.detail,
            onResume: () => resume(entry),
            onCancel: () => cancel(entry)
          });
        }
      } finally {
        if (entry.controller === controller) entry.controller = null;
        activeCount = Math.max(0, activeCount - 1);
        schedule();
      }
    }

    function schedule() {
      while (activeCount < concurrency && pending.length) {
        const entry = pending.shift();
        if (!entry || entry.status !== 'queued') continue;
        void run(entry);
      }
    }

    function add(uploadEntries) {
      const group = BB.ui.transferGroup('upload');
      for (const source of uploadEntries) {
        if (!source?.file || !source.relative || !source.key) continue;
        const id = `upload-${Date.now().toString(36)}-${++uploadSequence}`;
        const entry = {
          id,
          file: source.file,
          key: source.key,
          relative: source.relative,
          instanceId: source.instanceId,
          basePrefix: source.basePrefix,
          resumeToken: '',
          uploadedBytes: 0,
          status: 'queued',
          detail: 'Queued...',
          pauseRequested: false,
          cancelRequested: false,
          controller: null,
          cancelPromise: null,
          item: null
        };
        entry.item = group.add({
          id,
          name: entry.relative,
          status: 'queued',
          progress: entry.file.size > 0 ? 0 : null,
          indeterminate: entry.file.size <= 0,
          detail: 'Queued...',
          onPause: () => pause(entry),
          onResume: () => resume(entry),
          onCancel: () => cancel(entry)
        });
        entries.set(id, entry);
        pending.push(entry);
      }
      schedule();
    }

    return { add };
  }

  function getUploadManager(browser) {
    if (!uploadManager) uploadManager = createUploadManager(browser);
    return uploadManager;
  }


  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function append(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    return append(node, children);
  }

  function icon(name, extra = '') {
    return h('i', { class: ['mdi', `mdi-${name}`, extra] });
  }

  function button({ tone = '', icon: left = '', iconRight = '', label = '', classes = [], ...attrs }) {
    const iconBox = name => h('span', { class: 'icon is-small' }, icon(name));
    return h('button', { class: ['button', ...classes, tone], type: 'button', ...attrs },
      left && iconBox(left),
      label && h('span', {}, ` ${label} `),
      iconRight && iconBox(iconRight));
  }

  function setClass(node, name, on) {
    node.classList.toggle(name, Boolean(on));
  }

  // Dropdown behaviour: the trigger toggles the menu, an item, a click outside or Escape closes it.
  function initDropdown(root) {
    const trigger = root.querySelector('.dropdown-trigger');
    const menu = root.querySelector('.dropdown-menu');
    const items = () => Array.from(menu.querySelectorAll('.dropdown-item:not(.is-disabled)'));
    function isOpen() { return root.classList.contains('is-active'); }
    function close({ restoreFocus = false } = {}) {
      if (!isOpen()) return;
      root.classList.remove('is-active');
      menu.style.display = 'none';
      menu.setAttribute('aria-hidden', 'true');
      if (restoreFocus) (trigger.querySelector('button') || trigger).focus();
    }
    function open() {
      document.dispatchEvent(new CustomEvent('bb:dropdown-open', { detail: root }));
      root.classList.add('is-active');
      menu.style.display = '';
      menu.setAttribute('aria-hidden', 'false');
    }
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      if (isOpen()) close(); else open();
    });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && !isOpen()) {
        event.preventDefault();
        open();
        items()[0]?.focus();
      }
    });
    menu.addEventListener('click', () => close());
    menu.addEventListener('keydown', event => {
      const list = items();
      const index = list.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); list[Math.min(list.length - 1, index + 1)]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); list[Math.max(0, index - 1)]?.focus(); }
      else if (event.key === 'Enter' || event.key === ' ') {
        if (document.activeElement?.classList.contains('dropdown-item')) {
          event.preventDefault();
          document.activeElement.click();
        }
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        close({ restoreFocus: true });
      }
    });
    document.addEventListener('click', event => { if (!root.contains(event.target)) close(); });
    document.addEventListener('bb:dropdown-open', event => { if (event.detail !== root) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  }

  function byId(id) {
    return document.getElementById(id);
  }

  // ---------------------------------------------------------------------------
  // Browser state and controller
  // ---------------------------------------------------------------------------

  const state = {
    // The decisions of the access policy for the listed folder (authzen mode only).
    folderAccess: null,
    instances: [],
    build: {},
    defaultInstanceId: '',
    instanceId: '',
    pathPrefix: '',
    searchPrefix: '',
    rows: [],
    previousContinuationTokens: [],
    continuationToken: '',
    nextContinuationToken: '',
    scanOffset: 0,
    localPage: 0,
    scanComplete: false,
    navigationSortAvailable: false,
    navigationSortField: '',
    navigationSortDirection: '',
    modifiedTimeMode: 'relative',
    isRefreshing: false,
    isInitializing: true,
    pageSize: config.pageSize,
    breadcrumbVisibleStart: 0,
    breadcrumbLayoutFrame: 0,
    breadcrumbOverflowOpen: false,
    storageSwitcherOpen: false,
    expandedHosts: {},
    isDragActive: false,
    dragDepth: 0,
    versionCountRequest: 0
  };

  const browser = {
    get instanceId() { return state.instanceId; },
    get pathPrefix() { return state.pathPrefix; },
    refresh: () => refresh()
  };

  const ui = {};

  function currentInstance() {
    return state.instances.find(instance => instance.id === state.instanceId) || null;
  }

  function storageHosts() {
    const hosts = [];
    const byID = new Map();
    for (const instance of state.instances) {
      const id = String(instance.host || instance.id || '');
      let host = byID.get(id);
      if (!host) {
        host = { id, provider: String(instance.provider || ''), instances: [] };
        byID.set(id, host);
        hosts.push(host);
      }
      host.instances.push(instance);
    }
    return hosts;
  }

  // The access policy can refuse a write or a delete in the listed folder only.
  const folderAccessNeeds = {
    upload: ['write'], overwrite: ['write'], createFolder: ['write'], copy: ['write'],
    delete: ['delete'], rename: ['write', 'delete'], move: ['write', 'delete']
  };

  function can(operation, instance = currentInstance()) {
    const needs = folderAccessNeeds[operation];
    if (needs && state.folderAccess && instance === currentInstance()
      && needs.some(name => state.folderAccess[name] === false)) return false;
    if (BB.capabilities?.actionable) return BB.capabilities.actionable(instance, operation);
    const operationState = instance?.operations?.[operation];
    return operationState ? operationState.allowed !== false : true;
  }

  const canRead = () => can('list');
  const canWrite = () => can('upload');
  const canDelete = () => can('delete');
  const canCopy = () => can('copy');
  const canRename = () => can('rename');
  const versioningSupported = () => currentInstance()?.versioningSupported === true;
  const canDownloadAll = () => canRead() && config.allowDownloadAll && state.rows.length > 0;

  function orderedRows() {
    const rows = Array.from(state.rows || []);
    if (!state.navigationSortAvailable || !state.navigationSortField || !state.navigationSortDirection) return rows;
    const field = state.navigationSortField;
    const direction = state.navigationSortDirection === 'desc' ? -1 : 1;
    const nameOf = row => String(row?.name || '').toLocaleLowerCase();
    rows.sort((left, right) => {
      let comparison = 0;
      if (field === 'size') {
        comparison = Number(left?.type === 'content' ? left.size : 0) - Number(right?.type === 'content' ? right.size : 0);
      } else if (field === 'dateModified') {
        comparison = Number(left?.dateModified instanceof Date ? left.dateModified.getTime() : 0) - Number(right?.dateModified instanceof Date ? right.dateModified.getTime() : 0);
      } else {
        comparison = nameOf(left).localeCompare(nameOf(right));
      }
      if (comparison === 0) comparison = nameOf(left).localeCompare(nameOf(right));
      return comparison * direction;
    });
    return rows;
  }

  const localPageCount = () => Math.max(1, Math.ceil(orderedRows().length / state.pageSize));

  function visibleRows() {
    const start = state.localPage * state.pageSize;
    return orderedRows().slice(start, start + state.pageSize);
  }

  const rangeStart = () => (visibleRows().length ? state.scanOffset + state.localPage * state.pageSize + 1 : 0);
  const rangeEnd = () => state.scanOffset + state.localPage * state.pageSize + visibleRows().length;
  const hasRows = () => state.rows.length > 0;
  const hasPreviousPage = () => state.localPage > 0 || state.previousContinuationTokens.length > 0;
  const hasNextPage = () => state.localPage + 1 < localPageCount() || !!state.nextContinuationToken;
  const hasPagination = () => hasPreviousPage() || hasNextPage();

  function breadcrumbs() {
    const parts = String(state.pathPrefix || '').replace(/\/+$/, '').split('/').filter(Boolean);
    let prefix = '';
    return parts.map(name => {
      prefix += name + '/';
      return { name, prefix };
    });
  }

  function breadcrumbStart() {
    const crumbs = breadcrumbs();
    return crumbs.length ? Math.max(0, Math.min(state.breadcrumbVisibleStart, crumbs.length - 1)) : 0;
  }

  const visibleBreadcrumbs = () => breadcrumbs().slice(breadcrumbStart());
  const hiddenBreadcrumbs = () => breadcrumbs().slice(0, breadcrumbStart());

  function capabilityName(capability) {
    return BB.capabilities?.normalizeState ? BB.capabilities.normalizeState(capability) : (capability?.allowed === false ? 'denied' : 'unknown');
  }

  function capabilityLabel(capability) {
    return BB.capabilities?.stateLabel ? BB.capabilities.stateLabel(capability) : (capability?.allowed === false ? 'Denied' : 'On use');
  }

  function capabilityClass(capability) {
    return BB.capabilities?.stateClass ? BB.capabilities.stateClass(capability) : (capability?.allowed === false ? 'is-denied' : 'is-unknown');
  }

  function permissionStatesFor(instance) {
    const capabilities = instance?.capabilities || {};
    return [
      { key: 'read', label: 'Read', icon: 'eye-outline', state: capabilities.read || {} },
      { key: 'write', label: 'Write', icon: 'pencil-outline', state: capabilities.write || {} },
      { key: 'delete', label: 'Delete', icon: 'delete-outline', state: capabilities.delete || {} }
    ];
  }

  function permissionSummaryTitle() {
    return permissionStatesFor(currentInstance())
      .map(item => `${item.label}: ${capabilityLabel(item.state)}`)
      .join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function formatByteParts(size) {
    const value = Math.max(0, Number(size) || 0);
    if (value < 1024) return { value: Math.round(value).toLocaleString('en-US'), unit: 'B' };
    if (value < 1024 ** 2) return { value: Math.round(value / 1024).toLocaleString('en-US'), unit: 'KB' };
    if (value < 1024 ** 3) return { value: (value / 1024 ** 2).toFixed(2), unit: 'MB' };
    if (value < 1024 ** 4) return { value: (value / 1024 ** 3).toFixed(2), unit: 'GB' };
    return { value: (value / 1024 ** 4).toFixed(2), unit: 'TB' };
  }

  function formatBytes(size) {
    const parts = formatByteParts(size);
    return `${parts.value} ${parts.unit}`;
  }

  function formatDateTimeRelative(date) {
    if (!date) return '—';
    const timestamp = new Date(date).getTime();
    if (!Number.isFinite(timestamp)) return '—';
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const ranges = [
      ['year', 365 * 24 * 60 * 60],
      ['month', 30 * 24 * 60 * 60],
      ['week', 7 * 24 * 60 * 60],
      ['day', 24 * 60 * 60],
      ['hour', 60 * 60],
      ['minute', 60],
      ['second', 1]
    ];
    const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    for (const [unit, divisor] of ranges) {
      if (Math.abs(seconds) >= divisor || unit === 'second') {
        return formatter.format(Math.round(seconds / divisor), unit);
      }
    }
    return 'now';
  }

  const formatDateTimeAbsolute = date => BB.runtime.formatDateTimeUTC(date);

  function formatDateTimeDisplay(date) {
    return state.modifiedTimeMode === 'absolute' ? formatDateTimeAbsolute(date) : formatDateTimeRelative(date);
  }

  // ---------------------------------------------------------------------------
  // Header: build info, breadcrumbs, storage switcher
  // ---------------------------------------------------------------------------

  function renderBuild() {
    const build = state.build || {};
    const node = ui.buildVersion;
    node.hidden = !(build && build.display);
    if (node.hidden) return;
    const commit = build.commit && build.commit !== 'unknown' ? ` · source ${build.commit}` : '';
    node.title = `Release ${build.version || 'dev'}${commit}${build.date ? ` · built ${build.date}` : ''}`;
    node.querySelector('span').textContent = build.display;
  }

  function renderBreadcrumbs() {
    const crumbs = breadcrumbs();
    const hidden = hiddenBreadcrumbs();
    const visible = visibleBreadcrumbs();
    const signature = JSON.stringify([crumbs.map(crumb => crumb.prefix), hidden.length, state.breadcrumbOverflowOpen]);

    const root = ui.rootLink;
    setClass(root, 'breadcrumb-current', !crumbs.length);
    if (crumbs.length) root.removeAttribute('aria-current'); else root.setAttribute('aria-current', 'page');
    root.setAttribute('aria-disabled', crumbs.length ? 'false' : 'true');
    root.tabIndex = crumbs.length ? 0 : -1;

    if (ui.breadcrumbSignature === signature) return;
    ui.breadcrumbSignature = signature;

    const line = ui.breadcrumbLine;
    line.replaceChildren();
    line.append(h('span', { class: 'breadcrumb-separator' }, '/'));

    ui.breadcrumbOverflowTrigger = null;
    if (hidden.length) {
      const trigger = h('button', {
        type: 'button',
        class: 'breadcrumb-overflow-trigger',
        title: `Show ${hidden.length} hidden parent folder${hidden.length === 1 ? '' : 's'}`,
        'aria-label': 'Show hidden parent folders',
        'aria-haspopup': 'menu',
        'aria-expanded': state.breadcrumbOverflowOpen ? 'true' : 'false',
        onclick: event => { event.stopPropagation(); toggleBreadcrumbOverflow(); }
      },
      h('span', { class: 'breadcrumb-overflow-ellipsis', 'aria-hidden': 'true' }, '…'),
      h('span', { class: 'breadcrumb-overflow-count' }, hidden.length));
      ui.breadcrumbOverflowTrigger = trigger;
      line.append(h('span', { class: 'breadcrumb-overflow' }, trigger));
    }

    if (hidden.length && visible.length) line.append(h('span', { class: 'breadcrumb-separator' }, '/'));

    visible.forEach((crumb, index) => {
      if (hidden.length + index < crumbs.length - 1) {
        line.append(h('button', {
          type: 'button',
          class: 'breadcrumb-link',
          title: crumb.prefix,
          onclick: () => goToPrefix(crumb.prefix)
        }, crumb.name));
      } else {
        line.append(h('span', { class: 'breadcrumb-current', 'aria-current': 'page', title: crumb.prefix }, crumb.name));
      }
      if (index < visible.length - 1) line.append(h('span', { class: 'breadcrumb-separator' }, '/'));
    });

    renderBreadcrumbOverflowPopover();
  }

  function renderBreadcrumbOverflowPopover() {
    ui.breadcrumbOverflowPopover?.remove();
    ui.breadcrumbOverflowPopover = null;
    const hidden = hiddenBreadcrumbs();
    if (!state.breadcrumbOverflowOpen || !hidden.length) return;
    const popover = h('div', {
      class: 'breadcrumb-overflow-popover',
      role: 'menu',
      'aria-label': 'Hidden parent folders',
      onclick: event => event.stopPropagation()
    }, hidden.map((crumb, index) => h('button', {
      type: 'button',
      class: 'breadcrumb-overflow-item',
      title: crumb.prefix,
      role: 'menuitem',
      onclick: () => openHiddenBreadcrumb(crumb.prefix)
    },
    h('span', { class: 'breadcrumb-overflow-copy', style: { paddingLeft: `${Math.min(index, 6) * 0.65}rem` } },
      h('span', { class: 'breadcrumb-overflow-branch', 'aria-hidden': 'true' }, icon('subdirectory-arrow-right')),
      h('span', { class: 'breadcrumb-overflow-node' },
        h('small', {}, index === 0 ? 'Inside storage root' : `Inside ${hidden[index - 1].name}`),
        h('strong', {}, crumb.name))))));
    document.body.append(popover);
    ui.breadcrumbOverflowPopover = popover;
    positionBreadcrumbOverflow();
  }

  function toggleBreadcrumbOverflow() {
    if (state.breadcrumbOverflowOpen) closeBreadcrumbOverflow();
    else {
      state.breadcrumbOverflowOpen = true;
      renderBreadcrumbs();
    }
  }

  function closeBreadcrumbOverflow() {
    if (!state.breadcrumbOverflowOpen) return;
    state.breadcrumbOverflowOpen = false;
    renderBreadcrumbs();
  }

  function openHiddenBreadcrumb(prefix) {
    closeBreadcrumbOverflow();
    goToPrefix(prefix);
  }

  function positionBreadcrumbOverflow() {
    const trigger = ui.breadcrumbOverflowTrigger;
    const popover = ui.breadcrumbOverflowPopover;
    if (!state.breadcrumbOverflowOpen || !trigger || !popover) return;
    const margin = 8;
    const viewport = BB.viewport?.size() || { width: window.innerWidth, height: window.innerHeight };
    const triggerRect = BB.viewport?.rect(trigger) || trigger.getBoundingClientRect();
    const maxWidth = Math.max(220, Math.min(380, viewport.width - margin * 2));
    popover.style.width = `${maxWidth}px`;
    popover.style.maxWidth = `${viewport.width - margin * 2}px`;
    const popoverRect = BB.viewport?.rect(popover) || popover.getBoundingClientRect();
    const width = Math.min(maxWidth, Math.max(220, popoverRect.width || maxWidth));
    const height = Math.min(popoverRect.height || 320, Math.max(120, viewport.height - margin * 2));
    const left = Math.max(margin, Math.min(triggerRect.left, viewport.width - width - margin));
    const below = triggerRect.bottom + 6;
    const above = triggerRect.top - height - 6;
    const top = below + height <= viewport.height - margin ? below : Math.max(margin, above);
    Object.assign(popover.style, {
      position: 'fixed',
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.max(120, Math.round(viewport.height - top - margin))}px`
    });
  }

  function scheduleBreadcrumbLayout() {
    window.cancelAnimationFrame(state.breadcrumbLayoutFrame || 0);
    state.breadcrumbLayoutFrame = window.requestAnimationFrame(() => {
      state.breadcrumbLayoutFrame = 0;
      measureBreadcrumbs();
    });
  }

  function measureBreadcrumbs() {
    const crumbs = breadcrumbs();
    if (!crumbs.length) {
      state.breadcrumbVisibleStart = 0;
      return;
    }

    const line = ui.breadcrumbLine;
    if (!line) return;
    const available = Math.floor((BB.viewport?.rect(line).width || line.clientWidth || 0));
    if (available <= 0) return;

    const style = window.getComputedStyle(line);
    const canvas = ui.measureCanvas || (ui.measureCanvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

    const gap = Number.parseFloat(style.columnGap || style.gap || '3') || 3;
    const separatorWidth = Math.ceil(context.measureText('/').width);
    const widths = crumbs.map(crumb => Math.ceil(context.measureText(crumb.name).width + 2));
    const currentIndex = crumbs.length - 1;

    const requiredWidth = start => {
      const visibleCount = currentIndex - start + 1;
      const separatorCount = start > 0 ? visibleCount + 1 : visibleCount;
      const overflowCount = start > 0 ? 1 : 0;
      const elementCount = visibleCount + separatorCount + overflowCount;
      const overflowWidth = start > 0
        ? Math.max(36, Math.ceil(context.measureText(`…${start}`).width + 10))
        : 0;
      const crumbWidth = widths.slice(start).reduce((total, width) => total + width, 0);
      return crumbWidth
        + separatorCount * separatorWidth
        + overflowWidth
        + Math.max(0, elementCount - 1) * gap;
    };

    // The current folder has absolute priority. Parents are added from the
    // nearest parent outwards only when the current name still fits in full.
    let start = currentIndex;
    while (start > 0 && requiredWidth(start - 1) <= available) start--;
    if (state.breadcrumbVisibleStart !== start) {
      state.breadcrumbVisibleStart = start;
      renderBreadcrumbs();
    }
  }

  function permissionDot(item) {
    return h('span', {
      class: ['storage-permission-dot', capabilityClass(item.state)],
      title: `${item.label}: ${capabilityLabel(item.state)}`
    }, icon(item.icon));
  }

  function storageSubtitle(instance, { rootPrefix = false, provider = false } = {}) {
    return [
      instance.bucket,
      instance.name !== instance.bucket ? h('span', {}, ` · ${instance.name}`) : null,
      rootPrefix && instance.rootPrefix ? h('span', {}, ` · /${instance.rootPrefix}`) : null,
      provider ? ` · ${String(instance.provider || '').toUpperCase()}` : null
    ];
  }

  function permissionChips(instance) {
    return h('span', {
      class: 'storage-switcher-permissions is-interactive',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Open storage permission details',
      title: `${permissionSummaryTitle()}. Open details.`,
      onclick: event => { event.stopPropagation(); showPermissionDetails(); },
      onkeydown: event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.stopPropagation();
        event.preventDefault();
        showPermissionDetails();
      }
    }, permissionStatesFor(instance).map(permissionDot));
  }

  function switcherCopy(instance) {
    return h('span', { class: 'storage-switcher-copy' },
      h('span', { class: 'storage-switcher-title-row' },
        h('strong', {}, `${instance.host} / ${instance.id}`),
        permissionChips(instance)),
      h('small', {}, storageSubtitle(instance, { provider: true })));
  }

  function renderSwitcher() {
    const instance = currentInstance();
    const multiple = state.instances.length > 1;
    const signature = JSON.stringify([
      instance ? [instance.id, instance.host, instance.name, instance.bucket, instance.provider] : null,
      multiple ? state.instances.map(item => [item.id, item.host, item.name, item.bucket, item.rootPrefix, permissionStatesFor(item).map(entry => capabilityName(entry.state))]) : null,
      permissionStatesFor(instance).map(entry => capabilityName(entry.state))
    ]);

    if (ui.switcherSignature !== signature) {
      ui.switcherSignature = signature;
      ui.switcher = null;
      ui.switcherTrigger = null;
      ui.switcherPopover = null;
      const tools = ui.headerTools;
      tools.replaceChildren();

      if (instance && multiple) {
        const trigger = h('button', {
          type: 'button',
          class: 'storage-switcher-trigger has-bb-chevron',
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          title: `${instance.host} / ${instance.id}. ${permissionSummaryTitle()}`,
          onclick: event => { event.stopPropagation(); toggleStorageSwitcher(); }
        }, icon('database-outline', 'storage-switcher-icon'), switcherCopy(instance));

        const popover = h('div', {
          class: 'storage-tree-popover',
          role: 'menu',
          'aria-label': 'Storage hosts and buckets',
          style: { display: 'none' },
          onclick: event => event.stopPropagation()
        }, storageHosts().map(host => h('section', {
          class: ['storage-host-group', host.id === instance.host && 'is-current-host'],
          'data-host': host.id
        },
        h('button', {
          type: 'button',
          class: 'storage-host-row',
          'aria-expanded': 'false',
          onclick: event => { event.stopPropagation(); toggleHost(host.id); }
        },
        h('span', { class: 'storage-host-chevron', 'aria-hidden': 'true' }, icon('chevron-right')),
        h('span', { class: 'storage-host-icon' }, icon('database-outline')),
        h('span', { class: 'storage-host-copy' },
          h('strong', {}, host.id),
          h('small', {}, `${host.provider.toUpperCase()} · ${host.instances.length} bucket${host.instances.length === 1 ? '' : 's'}`))),
        h('div', { class: 'storage-bucket-list', role: 'group', 'aria-label': `${host.id} buckets`, style: { display: 'none' } },
          host.instances.map(entry => h('button', {
            type: 'button',
            class: ['storage-bucket-row', entry.id === state.instanceId && 'is-current-storage'],
            role: 'menuitemradio',
            'aria-checked': entry.id === state.instanceId ? 'true' : 'false',
            onclick: () => selectInstance(entry.id)
          },
          h('span', { class: 'storage-option-icon' }, icon('folder')),
          h('span', { class: 'storage-option-copy' },
            h('span', { class: 'storage-option-title-row' },
              h('strong', {}, entry.id),
              h('span', { class: 'storage-option-permissions', 'aria-label': `${entry.name} permissions` },
                permissionStatesFor(entry).map(permissionDot))),
            h('small', {}, storageSubtitle(entry, { rootPrefix: true }))),
          h('span', { class: 'storage-option-check', 'aria-hidden': 'true' },
            entry.id === state.instanceId ? icon('check') : null)))))));

        const switcher = h('div', { class: 'storage-switcher storage-tree-switcher' }, trigger, popover);
        tools.append(switcher);
        ui.switcher = switcher;
        ui.switcherTrigger = trigger;
        ui.switcherPopover = popover;
      } else if (instance) {
        tools.append(h('div', { class: 'storage-switcher is-static-switcher' },
          h('div', { class: 'storage-switcher-trigger is-static', title: permissionSummaryTitle() },
            icon('database-outline', 'storage-switcher-icon'), switcherCopy(instance))));
      } else {
        tools.append(h('div', { class: 'storage-switcher is-static-switcher is-loading-switcher', 'aria-hidden': 'true' },
          h('div', { class: 'storage-switcher-trigger is-static is-loading' },
            h('span', { class: 'storage-switcher-loading-icon' }),
            h('span', { class: 'storage-switcher-copy' },
              h('span', { class: 'storage-switcher-loading-line is-title' }),
              h('span', { class: 'storage-switcher-loading-line is-subtitle' })))));
      }
    }
    syncSwitcher();
  }

  function syncSwitcher() {
    if (!ui.switcher) return;
    setClass(ui.switcher, 'is-open', state.storageSwitcherOpen);
    ui.switcherTrigger.setAttribute('aria-expanded', state.storageSwitcherOpen ? 'true' : 'false');
    ui.switcherPopover.style.display = state.storageSwitcherOpen ? '' : 'none';
    for (const group of ui.switcherPopover.querySelectorAll('.storage-host-group')) {
      const expanded = isHostExpanded(group.dataset.host);
      group.querySelector('.storage-host-row').setAttribute('aria-expanded', expanded ? 'true' : 'false');
      setClass(group.querySelector('.storage-host-chevron'), 'is-expanded', expanded);
      group.querySelector('.storage-bucket-list').style.display = expanded ? '' : 'none';
    }
  }

  function toggleStorageSwitcher() {
    if (state.storageSwitcherOpen) {
      closeStorageSwitcher();
      return;
    }
    expandCurrentHost();
    state.storageSwitcherOpen = true;
    syncSwitcher();
  }

  function closeStorageSwitcher() {
    if (!state.storageSwitcherOpen) return;
    state.storageSwitcherOpen = false;
    syncSwitcher();
  }

  function expandCurrentHost() {
    const host = String(currentInstance()?.host || '');
    if (!host || state.expandedHosts[host] === true) return;
    state.expandedHosts = { ...state.expandedHosts, [host]: true };
    syncSwitcher();
  }

  function isHostExpanded(host) {
    return state.expandedHosts[String(host || '')] === true;
  }

  function toggleHost(host) {
    const id = String(host || '');
    if (!id) return;
    state.expandedHosts = { ...state.expandedHosts, [id]: !isHostExpanded(id) };
    syncSwitcher();
  }

  function onDocumentPointer(event) {
    if (state.storageSwitcherOpen && !ui.switcher?.contains(event.target)) closeStorageSwitcher();
    if (state.breadcrumbOverflowOpen) {
      const inside = ui.breadcrumbOverflowTrigger?.contains(event.target) || ui.breadcrumbOverflowPopover?.contains(event.target);
      if (!inside) closeBreadcrumbOverflow();
    }
  }

  function onDocumentKeydown(event) {
    if (event.key !== 'Escape') return;
    closeBreadcrumbOverflow();
    closeStorageSwitcher();
  }

  async function showPermissionDetails() {
    const instance = currentInstance();
    if (!instance) return;
    const reportedPermissions = Array.from(instance.capabilities?.permissions || []).map(String);
    const providerPermissions = reportedPermissions.length ? reportedPermissions.join(', ') : 'Not reported';
    const permissionRows = permissionStatesFor(instance).map(item => {
      const itemState = item.state || {};
      const stateName = capabilityName(itemState);
      const result = stateName === 'allowed' ? 'Allowed' : (stateName === 'denied' ? 'Denied' : 'On use');
      const verification = stateName === 'unknown'
        ? 'The provider will verify this permission when the operation is used.'
        : (itemState.verified ? (stateName === 'allowed' ? 'Verified by a real provider operation.' : 'Denied by the provider.') : 'Defined by the connection configuration.');
      const explanation = String(itemState.reason || verification);
      return `<div class="bb-permission-summary-row" title="${escapeHTML(explanation)}">
        <span class="bb-permission-summary-icon is-${escapeHTML(stateName)}"><i class="mdi mdi-${escapeHTML(item.icon)}"></i></span>
        <span class="bb-permission-summary-copy"><strong>${escapeHTML(item.label)}</strong></span>
        <span class="bb-permission-result is-${escapeHTML(stateName)}">${escapeHTML(result)}</span>
      </div>`;
    }).join('');
    const discoveryError = instance.capabilities?.error
      ? `<div class="bb-permission-provider is-error"><strong>Discovery</strong><span title="${escapeHTML(instance.capabilities.error)}">Unavailable</span></div>`
      : '';
    await BB.ui.alert({
      html: `<div class="bb-details bb-permission-details">
        <div class="bb-details-head">
          <i class="mdi mdi-shield-key-outline"></i>
          <div class="bb-details-titles">
            <div class="bb-details-name">Storage permissions</div>
            <div class="bb-details-prefix">${escapeHTML(instance.name)} · ${escapeHTML(instance.bucket)}</div>
          </div>
        </div>
        <div class="bb-details-body">
          <div class="bb-permission-summary">${permissionRows}</div>
          <div class="bb-permission-provider"><strong>Provider permissions</strong><span class="mono" title="${escapeHTML(providerPermissions)}">${escapeHTML(providerPermissions)}</span></div>
          ${discoveryError}
        </div>
      </div>`
    });
  }

  // ---------------------------------------------------------------------------
  // Toolbar and upload overlay
  // ---------------------------------------------------------------------------

  function renderToolbar() {
    const read = canRead();
    ui.searchInput.disabled = !read;
    ui.openButton.disabled = !read;
    ui.refreshButton.disabled = !read || state.isRefreshing;
    setClass(ui.downloadAllItem, 'is-disabled', !canDownloadAll());
    setClass(ui.insightsItem, 'is-disabled', !read);
    ui.insightsItem.querySelector('span').textContent = state.pathPrefix ? 'Folder insights' : 'Storage insights';
    if (canWrite()) {
      if (!ui.newMenu.isConnected) ui.toolbarRight.append(ui.newMenu);
    } else {
      ui.newMenu.remove();
    }
  }

  function renderDropOverlay() {
    ui.dropOverlay.style.display = state.isDragActive ? '' : 'none';
    ui.dropTarget.textContent = `/${state.pathPrefix}`;
  }

  // ---------------------------------------------------------------------------
  // Main card: states, pagination and the object table
  // ---------------------------------------------------------------------------

  function emptyState(kind, iconName, title, text) {
    return h('div', { class: ['empty-state', 'card', kind] },
      icon(iconName),
      title && h('h2', {}, title),
      h('p', {}, text));
  }

  function renderMain() {
    let mode = 'browser';
    if (state.isInitializing) mode = 'initializing';
    else if (!currentInstance()) mode = 'none';
    else if (!canRead()) mode = 'unreadable';

    if (mode !== ui.mainMode) {
      ui.mainMode = mode;
      ui.table = null;
      ui.card = null;
      if (mode === 'initializing') {
        ui.main.replaceChildren(emptyState('', 'loading mdi-spin', '', 'Loading storage instances...'));
      } else if (mode === 'none') {
        ui.main.replaceChildren(emptyState('is-error', 'cloud-alert-outline', 'No storage instance is available', 'Check the server HCL configuration.'));
      } else if (mode === 'unreadable') {
        ui.main.replaceChildren(emptyState('is-warning', 'shield-lock-outline', 'Read access is not available', 'This storage instance cannot list or read objects. Other actions remain hidden or disabled.'));
      } else {
        buildBrowserCard();
      }
    }
    if (mode === 'browser') renderBrowserCard();
  }

  function sortButton(field, label, { numeric = false } = {}) {
    const iconBox = h('span', { class: 'navigation-sort-icon', 'aria-hidden': 'true' });
    const node = h('button', {
      type: 'button',
      class: ['navigation-sort-button', numeric && 'is-numeric'],
      onclick: () => toggleNavigationSort(field)
    }, h('span', {}, label), iconBox);
    return { field, label, node, iconBox };
  }

  function updateSortButton(entry) {
    const available = state.navigationSortAvailable;
    setClass(entry.node, 'is-sortable', available);
    setClass(entry.node, 'is-active', state.navigationSortField === entry.field);
    entry.node.disabled = !available;
    entry.node.setAttribute('aria-label', available ? `Sort by ${entry.label.toLowerCase()}` : entry.label);
    setClass(entry.iconBox, 'is-placeholder', !available);
    const name = navigationSortIcon(entry.field);
    entry.iconBox.replaceChildren(...(name ? [icon(name)] : []));
  }

  function buildBrowserCard() {
    const head = {
      select: h('select', { onchange: event => {
        state.pageSize = Number(event.target.value) || 50;
        config.pageSize = state.pageSize;
        state.localPage = 0;
        update();
        refreshVisibleVersionCounts();
      } }, [50, 100, 500].map(size => h('option', { value: size }, size))),
      range: h('span', {}),
      previous: button({
        tone: 'is-light', icon: 'chevron-left', classes: ['icon-btn-disc'], title: 'Previous page', onclick: () => previousPage()
      }),
      next: button({
        tone: 'is-light', iconRight: 'chevron-right', classes: ['icon-btn-disc'], title: 'Next page', onclick: () => nextPage()
      })
    };
    head.node = h('div', { class: 'card-content browser-card-head' },
      h('div', { class: 'page-size-control' },
        h('div', { class: 'control' }, h('span', { class: 'select is-small' }, head.select)),
        h('span', {}, 'per page')),
      h('div', { class: 'pagination-control' }, head.previous, head.range, head.next));

    const sorts = {
      name: sortButton('name', 'Name'),
      size: sortButton('size', 'Size', { numeric: true }),
      dateModified: sortButton('dateModified', 'Last modified', { numeric: true })
    };
    const timeToggle = h('button', { type: 'button', class: 'modified-time-toggle', onclick: event => { event.stopPropagation(); toggleModifiedTimeMode(); } },
      h('i', { class: 'mdi mdi-clock-outline', 'aria-hidden': 'true' }));
    const headerCell = (cls, content, style) => h('th', { class: cls, draggable: 'false', style },
      h('div', { class: 'th-wrap is-relative', style }, h('span', {}, content)));
    const tbody = h('tbody');
    const overlay = h('div', { class: 'loading-overlay is-active' },
      h('div', { class: 'loading-background' }),
      h('div', { class: 'loading-icon' }));
    const tableElement = h('table', { class: 'table is-hoverable' },
      h('thead', {}, h('tr', {},
        headerCell('name-column-header', sorts.name.node),
        headerCell('size-column-header', sorts.size.node),
        headerCell('modified-column-header', h('div', { class: 'modified-header-controls' }, timeToggle, sorts.dateModified.node)),
        h('th', { class: 'is-right', draggable: 'false', style: { width: '46px' } },
          h('div', { class: 'th-wrap is-relative', style: { width: '46px' } },
            h('span', { class: 'icon is-small sort-icon is-invisible' }, icon('arrow-up')))))),
      tbody);
    const wrapper = h('div', { class: 'table-wrapper has-mobile-cards' }, tableElement);
    // Buefy's mobile-card helper. It is hidden, but `.table-wrapper:not(:last-child)` in the stylesheet relies on it.
    const touchCell = h('div', { class: 'touch-dragged-cell has-mobile-cards', style: { display: 'none' } });
    const tableWrap = h('div', { class: 'table-wrap' }, h('div', { class: 'b-table' }, wrapper, touchCell));
    const emptyFolder = h('div', { class: 'table-empty browser-empty-folder' },
      icon('folder-open-outline'),
      h('span', {}, 'This folder is empty.'));
    const content = h('div', { class: 'card-content table-card-content' });
    const card = h('div', { class: 'card browser-card' }, content);

    ui.table = { head, sorts, timeToggle, tbody, wrapper, overlay, tableWrap, emptyFolder, content, card };
    ui.main.replaceChildren(card);
  }

  function renderBrowserCard() {
    const t = ui.table;
    const rows = hasRows();

    // Page-size and pagination controls are only present when there is something to page.
    if (rows && !t.head.node.isConnected) t.card.insertBefore(t.head.node, t.content);
    if (!rows) t.head.node.remove();
    if (rows) {
      t.head.select.value = String(state.pageSize);
      t.head.select.disabled = state.isRefreshing;
      t.head.range.textContent = `Items ${rangeStart()}–${rangeEnd()}`;
      const paged = hasPagination();
      for (const [control, enabled] of [[t.head.previous, hasPreviousPage()], [t.head.next, hasNextPage()]]) {
        setClass(control, 'is-pagination-placeholder', !paged);
        control.setAttribute('aria-hidden', paged ? 'false' : 'true');
        control.tabIndex = paged ? 0 : -1;
        control.disabled = !enabled || state.isRefreshing;
      }
    }

    const showTable = rows || state.isRefreshing;
    const desired = showTable ? t.tableWrap : t.emptyFolder;
    if (t.content.firstChild !== desired) t.content.replaceChildren(desired);
    if (!showTable) return;

    for (const entry of Object.values(t.sorts)) updateSortButton(entry);
    const absolute = state.modifiedTimeMode === 'absolute';
    setClass(t.timeToggle, 'is-absolute', absolute);
    const toggleLabel = absolute ? 'Show relative times' : 'Show exact UTC dates';
    t.timeToggle.title = toggleLabel;
    t.timeToggle.setAttribute('aria-label', toggleLabel);

    renderRows();
    if (state.isRefreshing) t.wrapper.append(t.overlay); else t.overlay.remove();
  }

  function navigationSortIcon(field) {
    if (!state.navigationSortAvailable) return '';
    if (state.navigationSortField !== field) return 'unfold-more-horizontal';
    return state.navigationSortDirection === 'desc' ? 'arrow-down' : 'arrow-up';
  }

  function menuItem(label, iconName, onclick, { danger = false } = {}) {
    return h('div', { class: ['bb-menu-item', danger && 'danger'], onclick }, icon(iconName), ` ${label}`);
  }

  function rowMenu(row) {
    const items = row.type === 'content'
      ? [
        canRead() && menuItem('Details', 'information-outline', () => onRowMetadata(row)),
        canRead() && menuItem('Download', 'download', () => onRowDownload(row)),
        canRead() && versioningSupported() && menuItem('Versions', 'source-commit', () => onRowVersions(row)),
        canCopy() && menuItem('Copy', 'content-copy', () => onRowCopy(row)),
        canRename() && menuItem('Rename', 'rename-outline', () => onRowRename(row)),
        canDelete() && menuItem('Delete', 'delete-outline', () => onRowDelete(row), { danger: true })
      ]
      : [
        canRead() && menuItem('Insights', 'chart-box-outline', () => onPrefixInsights(row)),
        canRead() && menuItem('Download as ZIP', 'folder-download-outline', () => onPrefixDownload(row)),
        canCopy() && menuItem('Copy', 'content-copy', () => onPrefixCopy(row)),
        canRename() && menuItem('Rename', 'rename-outline', () => onPrefixRename(row)),
        canDelete() && menuItem('Delete', 'delete-outline', () => onPrefixDelete(row), { danger: true })
      ];
    return h('div', { class: 'row-menu-wrap' },
      h('div', { class: 'bb-menu', ...(row.type === 'content' ? { 'data-key': row.key } : { 'data-prefix': row.prefix }) },
        h('button', { type: 'button', class: 'bb-kebab', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Options' }, icon('dots-vertical')),
        h('div', { class: 'bb-menu-popover' }, h('div', { class: 'bb-menu-list' }, items))));
  }

  function versionCountBadge(row) {
    if (!versioningSupported() || !Number.isInteger(row.versionCount)) return null;
    return h('span', {
      class: 'object-version-count',
      title: `${row.versionCount} version${row.versionCount === 1 ? '' : 's'}`
    }, row.versionCount);
  }

  function buildRow(row) {
    const isContent = row.type === 'content';
    const nameCell = h('div', { class: 'object-name-cell' },
      h('span', { class: 'icon name-column-icon is-smmd' }, icon(isContent ? fileRowIcon(row) : 'folder', 'mdi-24px')),
      h('button', {
        type: 'button',
        class: 'object-link',
        title: row.name,
        onclick: () => (isContent ? openPreview(row) : goToPrefix(row.prefix))
      }, row.name),
      isContent && versionCountBadge(row));

    let sizeCell;
    if (isContent) {
      const parts = formatByteParts(row.size);
      sizeCell = h('span', { class: 'object-size', title: formatBytes(row.size) },
        h('span', { class: 'object-size-value' }, parts.value),
        h('span', { class: 'object-size-unit' }, parts.unit));
    } else {
      sizeCell = h('span', { class: 'object-size object-size-empty', 'aria-hidden': 'true' },
        h('span', { class: 'object-size-value' }, '-'),
        h('span', { class: 'object-size-unit' }));
    }

    const modifiedCell = row.dateModified
      ? h('span', { class: 'object-modified', title: BB.runtime.formatDateTimeUTC(row.dateModified) }, ` ${formatDateTimeDisplay(row.dateModified)} `)
      : h('span', { class: 'object-modified object-modified-empty' }, '-');

    const tr = h('tr', { draggable: 'false' },
      h('td', { class: 'name-column', 'data-label': 'Name' }, nameCell),
      h('td', { class: 'size-column', 'data-label': 'Size' }, sizeCell),
      h('td', { class: 'modified-column', 'data-label': 'Last modified' }, modifiedCell),
      h('td', { class: 'is-right', 'data-label': '' }, rowMenu(row)));
    row.element = tr;
    return tr;
  }

  function renderRows() {
    const tbody = ui.table.tbody;
    const rows = visibleRows();
    if (!rows.length) {
      tbody.replaceChildren(h('tr', { class: 'is-empty' },
        h('td', { colspan: '4' }, h('div', { class: 'table-empty' }, icon('folder-open-outline'), h('span', {}, 'This folder is empty.')))));
      return;
    }
    tbody.replaceChildren(...rows.map(buildRow));
  }

  function updateVersionCountBadges() {
    for (const row of visibleRows()) {
      const cell = row.element?.querySelector('.object-name-cell');
      if (!cell) continue;
      cell.querySelector('.object-version-count')?.remove();
      const badge = row.type === 'content' ? versionCountBadge(row) : null;
      if (badge) cell.append(badge);
    }
  }

  function update() {
    renderBuild();
    renderBreadcrumbs();
    renderSwitcher();
    renderToolbar();
    renderDropOverlay();
    renderMain();
  }

  // ---------------------------------------------------------------------------
  // Navigation and data loading
  // ---------------------------------------------------------------------------

  function setPathPrefix(prefix) {
    state.pathPrefix = prefix;
    state.breadcrumbOverflowOpen = false;
    state.breadcrumbVisibleStart = Math.max(0, breadcrumbs().length - 1);
    update();
    scheduleBreadcrumbLayout();
  }

  function setInstanceId(id) {
    state.instanceId = id;
    state.breadcrumbOverflowOpen = false;
    expandCurrentHost();
    update();
    scheduleBreadcrumbLayout();
  }

  function setSearchPrefix(value) {
    state.searchPrefix = value;
    ui.searchInput.value = value;
  }

  async function initialize() {
    state.isInitializing = true;
    try {
      const response = await BB.api.instances();
      state.instances = (response.instances || []).map(instance => ({
        ...instance,
        host: String(instance.host || instance.id || '')
      }));
      state.build = response.build || {};
      config.runtime = BB.runtime?.configure(response.runtime || {}) || (response.runtime || {});
      state.defaultInstanceId = response.default || state.instances[0]?.id || '';
      const route = BB.runtime?.storageRoute?.();
      const routeInstance = route?.view === 'browser'
        ? state.instances.find(instance => instance.host === route.host && instance.id === route.bucket)?.id || ''
        : '';
      const queryInstance = new URLSearchParams(location.search).get('instance');
      const storedInstance = BB.runtime?.readState('object-browser-instance') || '';
      const candidate = [routeInstance, queryInstance, storedInstance, state.defaultInstanceId]
        .find(id => id && state.instances.some(instance => instance.id === id));
      state.instanceId = candidate || state.instances[0]?.id || '';
      if (!state.instanceId) throw new Error('No storage instance is configured.');
      applyCurrentInstance();
      state.pathPrefix = routeInstance === state.instanceId
        ? normalizePrefix(route.path)
        : parseLegacyHash();
      setSearchPrefix('');
      replaceBrowserLocation(state.pathPrefix);
      setInstanceId(state.instanceId);
      setPathPrefix(state.pathPrefix);
      await refresh();
    } catch (error) {
      BB.ui.toast(String(error.message || error));
    } finally {
      state.isInitializing = false;
      update();
    }
  }

  function browserLocation(prefix = '') {
    const url = new URL(BB.api.browserPageURL(prefix, { instance: state.instanceId }));
    return url.pathname + url.search + url.hash;
  }

  function replaceBrowserLocation(prefix = '', { push = false } = {}) {
    const target = browserLocation(prefix);
    const current = location.pathname + location.search + location.hash;
    if (target === current) return;
    history[push ? 'pushState' : 'replaceState'](null, '', target);
  }

  function applyCurrentInstance() {
    const instance = currentInstance();
    if (!instance) return;
    BB.api.setInstance(instance);
    config.capabilities = instance.capabilities || {};
    config.operations = instance.operations || {};
    config.versioningSupported = instance.versioningSupported === true;
    BB.runtime?.writeState('object-browser-instance', instance.id);
    document.title = `${instance.name} - Object Storage Browser`;
  }

  async function changeInstance() {
    applyCurrentInstance();
    setPathPrefix('');
    setSearchPrefix('');
    resetPagination();
    replaceBrowserLocation('', { push: true });
    await refresh();
  }

  async function selectInstance(id) {
    if (!id) return;
    closeStorageSwitcher();
    if (id === state.instanceId) return;
    setInstanceId(id);
    await changeInstance();
  }

  function resetPagination() {
    state.previousContinuationTokens = [];
    state.continuationToken = '';
    state.nextContinuationToken = '';
    state.scanOffset = 0;
    state.localPage = 0;
    state.scanComplete = false;
    state.navigationSortAvailable = false;
    state.navigationSortField = '';
    state.navigationSortDirection = '';
  }

  function toggleNavigationSort(field) {
    if (!state.navigationSortAvailable) return;
    const initialDirection = field === 'name' ? 'asc' : 'desc';
    const reverseDirection = initialDirection === 'desc' ? 'asc' : 'desc';
    if (state.navigationSortField !== field) {
      state.navigationSortField = field;
      state.navigationSortDirection = initialDirection;
    } else if (state.navigationSortDirection === initialDirection) {
      state.navigationSortDirection = reverseDirection;
    } else {
      state.navigationSortField = '';
      state.navigationSortDirection = '';
    }
    state.localPage = 0;
    update();
    refreshVisibleVersionCounts();
  }

  function updatePathFromLocation() {
    const route = BB.runtime?.storageRoute?.();
    if (!route || route.view !== 'browser') return;
    const instance = state.instances.find(item => item.host === route.host && item.id === route.bucket);
    if (!instance) return;
    const next = normalizePrefix(route.path);
    const instanceChanged = instance.id !== state.instanceId;
    if (!instanceChanged && next === state.pathPrefix) return;
    if (instanceChanged) {
      setInstanceId(instance.id);
      applyCurrentInstance();
    }
    setPathPrefix(next);
    setSearchPrefix('');
    resetPagination();
    if (!state.isInitializing) refresh();
  }

  function goToPrefix(prefix) {
    closeBreadcrumbOverflow();
    const normalized = normalizePrefix(prefix);
    if (normalized === state.pathPrefix) {
      resetPagination();
      refresh();
      return;
    }
    setPathPrefix(normalized);
    setSearchPrefix('');
    resetPagination();
    replaceBrowserLocation(normalized, { push: true });
    refresh();
  }

  function searchByPrefix() {
    const value = String(state.searchPrefix || '').trim();
    if (!value) {
      refresh();
      return;
    }
    goToPrefix(normalizePrefix(state.pathPrefix + value));
  }

  function manualRefresh() {
    resetPagination();
    refresh();
  }

  async function nextPage() {
    if (state.localPage + 1 < localPageCount()) {
      state.localPage += 1;
      update();
      refreshVisibleVersionCounts();
      return;
    }
    if (!state.nextContinuationToken) return;
    state.previousContinuationTokens.push({ token: state.continuationToken || '', offset: state.scanOffset });
    state.scanOffset += state.rows.length;
    state.continuationToken = state.nextContinuationToken;
    state.localPage = 0;
    await refresh();
  }

  async function previousPage() {
    if (state.localPage > 0) {
      state.localPage -= 1;
      update();
      refreshVisibleVersionCounts();
      return;
    }
    if (!state.previousContinuationTokens.length) return;
    const previous = state.previousContinuationTokens.pop();
    state.continuationToken = previous?.token || '';
    state.scanOffset = Number(previous?.offset || 0);
    await refresh();
    state.localPage = Math.max(0, localPageCount() - 1);
    update();
  }

  async function refresh() {
    if (state.isRefreshing || !currentInstance()) return;
    state.isRefreshing = true;
    update();
    try {
      if (!canRead()) {
        state.rows = [];
        state.nextContinuationToken = '';
        state.folderAccess = null;
        return;
      }
      const data = await BB.api.list({
        prefix: state.pathPrefix,
        delimiter: '/',
        continuationToken: state.continuationToken
      });
      state.nextContinuationToken = data.nextContinuationToken || '';
      state.folderAccess = data.access && typeof data.access === 'object' ? data.access : null;
      state.scanComplete = data.scanComplete === true;
      state.navigationSortAvailable = data.sortAvailable === true;
      if (!state.navigationSortAvailable) {
        state.navigationSortField = '';
        state.navigationSortDirection = '';
      }
      const rows = (data.items || []).map(item => {
        if (item.type === 'prefix') {
          return { type: 'prefix', name: item.name, prefix: item.prefix, size: 0, dateModified: null };
        }
        return {
          type: 'content',
          name: item.name || String(item.key || '').split('/').pop(),
          key: item.key,
          size: Number(item.size || 0),
          dateModified: item.lastModified ? new Date(item.lastModified) : null,
          contentType: item.contentType || '',
          etag: item.etag || '',
          url: BB.api.urlForKey(item.key),
          versionCount: null
        };
      }).filter(row => {
        const key = row.type === 'prefix' ? row.prefix : row.key;
        return !config.keyExcludePatterns.some(pattern => pattern.test(String(key || '')));
      });
      state.rows = rows;
      state.localPage = Math.max(0, Math.min(state.localPage, Math.max(0, Math.ceil(rows.length / state.pageSize) - 1)));
    } catch (error) {
      state.rows = [];
      state.folderAccess = null;
      BB.ui.toast(String(error.message || error));
    } finally {
      state.isRefreshing = false;
      update();
    }
    refreshVisibleVersionCounts();
  }

  async function refreshVisibleVersionCounts() {
    const requestID = ++state.versionCountRequest;
    if (!versioningSupported() || !canRead()) {
      for (const row of state.rows) if (row.type === 'content') row.versionCount = null;
      updateVersionCountBadges();
      return;
    }
    const instanceID = state.instanceId;
    const keys = visibleRows().filter(row => row.type === 'content' && row.key).map(row => row.key);
    if (!keys.length) return;
    try {
      const response = await BB.api.versionCounts(keys, instanceID);
      if (requestID !== state.versionCountRequest || instanceID !== state.instanceId) return;
      const counts = response?.counts || {};
      for (const row of state.rows) {
        if (row.type !== 'content' || !Object.prototype.hasOwnProperty.call(counts, row.key)) continue;
        row.versionCount = Number(counts[row.key]?.count || 0);
      }
      updateVersionCountBadges();
    } catch (error) {
      if (Number(error?.status || 0) === 501) return;
      console.warn('Unable to load object version counts', error);
    }
  }

  function fileRowIcon(row) {
    return BB.detect.iconForType(BB.detect.resolveType(row.name || '', row.contentType || ''));
  }

  function openPreview(row) {
    if (!canRead()) return;
    window.location.href = BB.api.previewPageURL(row.key, { instance: state.instanceId });
  }

  function toggleModifiedTimeMode() {
    state.modifiedTimeMode = state.modifiedTimeMode === 'relative' ? 'absolute' : 'relative';
    update();
  }

  // ---------------------------------------------------------------------------
  // Row and folder actions
  // ---------------------------------------------------------------------------

  function onRowMetadata(row) { BB.actions.showMetadata(row.key, { size: row.size, mime: row.contentType, etag: row.etag, lastModified: row.dateModified?.toUTCString?.() || '' }); }
  function onRowDownload(row) { BB.actions.downloadObject(row.key, row.name); }
  function onRowVersions(row) { BB.actions.showVersions(row.key); }
  async function onRowCopy(row) { if (await BB.actions.copyObject(row.key)) await refresh(); }
  async function onRowRename(row) { if (await BB.actions.renameObject(row.key)) await refresh(); }
  async function onRowDelete(row) { if (await BB.actions.deleteObject(row.key)) await refresh(); }
  function onPrefixInsights(row) { BB.actions.showPrefixInsights(row.prefix); }
  async function onPrefixCopy(row) { if (await BB.actions.copyPrefix(row.prefix)) await refresh(); }
  async function onPrefixRename(row) { if (await BB.actions.renamePrefix(row.prefix)) await refresh(); }
  async function onPrefixDelete(row) { if (await BB.actions.deletePrefix(row.prefix)) await refresh(); }
  function onCurrentInsights() { BB.actions.showPrefixInsights(state.pathPrefix); }

  function onRowContextMenu(event) {
    const row = event.target?.closest?.('.browser-card tbody tr');
    if (!row) return;
    const menu = row.querySelector('.bb-menu');
    if (!menu || !BB.menu?.openAt) return;
    event.preventDefault();
    event.stopPropagation();
    BB.menu.openAt(menu, event.clientX, event.clientY);
  }

  // ---------------------------------------------------------------------------
  // Upload and drag-and-drop
  // ---------------------------------------------------------------------------

  function onDragEnter(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!canWrite()) return;
    state.dragDepth++;
    state.isDragActive = true;
    renderDropOverlay();
  }

  function onDragOver(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = canWrite() ? 'copy' : 'none';
    if (!canWrite()) return;
    state.isDragActive = true;
    renderDropOverlay();
  }

  function onDragLeave(event) {
    if (!state.isDragActive) return;
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    const leftWindow = !event.relatedTarget || event.clientX <= 0 || event.clientY <= 0 ||
      event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
    if (state.dragDepth === 0 || leftWindow) {
      state.dragDepth = 0;
      state.isDragActive = false;
      renderDropOverlay();
    }
  }

  async function onDrop(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    state.dragDepth = 0;
    state.isDragActive = false;
    renderDropOverlay();
    if (!canWrite()) {
      BB.ui.toast('Upload is not available for this storage instance.', { status: 'error', duration: 4500 });
      return;
    }
    try {
      const entries = await droppedUploadEntries(event.dataTransfer);
      if (!entries.length) {
        BB.ui.toast('No files were found in the dropped selection.', { status: 'error', duration: 4500 });
        return;
      }
      const containsFolder = entries.some(entry => String(entry.relative || '').includes('/'));
      if (containsFolder && !await confirmFolderUpload(entries)) return;
      await uploadResolvedFiles(entries);
    } catch (error) {
      BB.ui.toast(`Unable to read dropped files: ${String(error.message || error)}`, { status: 'error', duration: 6500 });
    }
  }

  function triggerUpload() {
    if (!canWrite()) return;
    ui.fileInput.value = '';
    ui.fileInput.click();
  }

  function triggerUploadDir() {
    if (!canWrite()) return;
    ui.dirInput.value = '';
    ui.dirInput.click();
  }

  async function showUploadSelectionError(title, message) {
    await BB.ui.alert({
      title,
      html: `<div class="bb-upload-selection-error">
        <i class="mdi mdi-alert-circle-outline"></i>
        <div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(message)}</p></div>
      </div>`
    });
  }

  async function onFileInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    if (files.some(file => cleanDroppedPath(file.webkitRelativePath || '').includes('/'))) {
      await showUploadSelectionError('Files expected', 'Use “Upload folder” when the selected items include a directory hierarchy.');
      return;
    }
    await uploadFiles(files, file => file.name);
  }

  async function onDirInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const hasDirectoryPath = files.some(file => cleanDroppedPath(file.webkitRelativePath || '').includes('/'));
    if (!hasDirectoryPath) {
      await showUploadSelectionError('Folder expected', 'Use “Upload files” for individual files, or select a folder containing the files to upload.');
      return;
    }
    const entries = files.map(file => ({
      file,
      relative: cleanDroppedPath(file.webkitRelativePath || file.name)
    }));
    if (await confirmFolderUpload(entries)) await uploadResolvedFiles(entries);
  }

  async function confirmFolderUpload(entries, selectedName = '') {
    const files = Array.from(entries || []).filter(entry => entry?.file && entry.relative);
    if (!files.length) return false;
    const totalSize = files.reduce((sum, entry) => sum + Math.max(0, Number(entry.file.size || 0)), 0);
    const roots = Array.from(new Set(files.map(entry => String(entry.relative).split('/')[0]).filter(Boolean)));
    const folderName = selectedName || (roots.length === 1 ? roots[0] : `${roots.length} top-level folders`);
    const destination = `/${state.pathPrefix || ''}`;
    const samples = files.slice(0, 4).map(entry => `<li class="mono">${escapeHTML(entry.relative)}</li>`).join('');
    const remaining = Math.max(0, files.length - 4);
    return BB.ui.confirm({
      title: 'Upload folder',
      confirmLabel: `Upload ${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'}`,
      cancelLabel: 'Cancel',
      html: `<div class="bb-upload-confirmation">
        <div class="bb-upload-confirmation-icon"><i class="mdi mdi-folder-upload-outline"></i></div>
        <div class="bb-upload-confirmation-copy">
          <strong>${escapeHTML(folderName)}</strong>
          <span>${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'} · ${escapeHTML(formatBytes(totalSize))}</span>
        </div>
        <div class="bb-upload-confirmation-destination">
          <small>Destination</small>
          <code>${escapeHTML(destination)}</code>
        </div>
        <ul class="bb-upload-confirmation-files">${samples}${remaining ? `<li>+ ${remaining.toLocaleString()} more file${remaining === 1 ? '' : 's'}</li>` : ''}</ul>
      </div>`
    });
  }

  async function uploadFiles(files, keyResolver) {
    const resolved = Array.from(files || []).map(file => ({
      file,
      relative: cleanDroppedPath(keyResolver(file))
    }));
    return uploadResolvedFiles(resolved);
  }

  async function uploadResolvedFiles(uploadEntries) {
    if (!canWrite() || !uploadEntries.length) return;
    const instanceId = state.instanceId;
    const basePrefix = state.pathPrefix;
    const entries = uploadEntries
      .filter(entry => entry?.file && cleanDroppedPath(entry.relative || entry.file.name))
      .map(entry => {
        const relative = cleanDroppedPath(entry.relative || entry.file.name);
        return {
          file: entry.file,
          relative,
          key: `${basePrefix}${relative}`.replace(/^\/+/, ''),
          instanceId,
          basePrefix
        };
      });
    if (!entries.length) return;
    getUploadManager(browser).add(entries);
  }

  async function downloadAllFiles() {
    if (!canDownloadAll()) return false;
    const basePrefix = state.pathPrefix;
    const archiveName = `${basePrefix.split('/').filter(Boolean).pop() || currentInstance().name || 'archive'}.zip`;
    return downloadArchive({ archiveName, basePrefix, instanceId: state.instanceId });
  }

  async function onPrefixDownload(row) {
    if (!canRead() || !row?.prefix) return false;
    const prefix = normalizePrefix(row.prefix);
    const folderName = prefix.split('/').filter(Boolean).pop() || 'folder';
    return downloadArchive({ archiveName: `${folderName}.zip`, basePrefix: prefix, instanceId: state.instanceId });
  }

  async function downloadArchive({ archiveName, basePrefix = '', instanceId = '' }) {
    if (!canRead()) return false;
    const url = BB.api.archiveURL({
      prefix: basePrefix,
      name: archiveName,
      instance: instanceId
    });
    BB.actions.triggerBrowserDownload(url, archiveName);
    BB.ui.toast('Archive download started in the browser.', {
      type: 'info',
      duration: 5000
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------

  function preloadInitialShellIcons() {
    if (typeof window.Image !== 'function') return Promise.resolve();
    const iconURLs = Array.from(
      document.querySelectorAll('link[data-bb-initial-icon]'),
      link => link.href
    ).filter(Boolean);
    return Promise.all(iconURLs.map(url => new Promise(resolve => {
      const image = new window.Image();
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        image.removeEventListener('load', finish);
        image.removeEventListener('error', finish);
        resolve();
      };
      image.addEventListener('load', finish, { once: true });
      image.addEventListener('error', finish, { once: true });
      image.decoding = 'async';
      image.src = url;
      if (image.complete) finish();
    })));
  }

  function bindElements() {
    for (const [name, id] of Object.entries({
      root: 'root', app: 'app', main: 'main', buildVersion: 'buildVersion', rootLink: 'rootLink',
      breadcrumbRegion: 'breadcrumbRegion', breadcrumbLine: 'breadcrumbLine', headerTools: 'headerTools',
      searchInput: 'searchInput', openButton: 'openButton', refreshButton: 'refreshButton',
      downloadAllItem: 'downloadAllItem', insightsItem: 'insightsItem', newMenu: 'newMenu',
      uploadFilesItem: 'uploadFilesItem', uploadFolderItem: 'uploadFolderItem',
      fileInput: 'fileInput', dirInput: 'dirInput', dropOverlay: 'dropOverlay', dropTarget: 'dropTarget'
    })) ui[name] = byId(id);
    ui.toolbarRight = ui.newMenu.parentElement;
  }

  function bindEvents() {
    ui.app.style.setProperty('--primary-color', config.primaryColor);
    ui.rootLink.addEventListener('click', () => { if (breadcrumbs().length) goToPrefix(''); });
    ui.searchInput.addEventListener('input', () => { state.searchPrefix = ui.searchInput.value; });
    ui.searchInput.addEventListener('keyup', event => { if (event.key === 'Enter') searchByPrefix(); });
    ui.openButton.addEventListener('click', searchByPrefix);
    ui.refreshButton.addEventListener('click', manualRefresh);
    document.querySelectorAll('.toolbar .dropdown').forEach(initDropdown);
    ui.downloadAllItem.addEventListener('click', () => { if (canDownloadAll()) downloadAllFiles(); });
    ui.insightsItem.addEventListener('click', () => { if (canRead()) onCurrentInsights(); });
    ui.uploadFilesItem.addEventListener('click', triggerUpload);
    ui.uploadFolderItem.addEventListener('click', triggerUploadDir);
    ui.fileInput.addEventListener('change', onFileInput);
    ui.dirInput.addEventListener('change', onDirInput);

    window.addEventListener('popstate', updatePathFromLocation);
    window.addEventListener('resize', () => {
      scheduleBreadcrumbLayout();
      if (state.breadcrumbOverflowOpen) window.requestAnimationFrame(positionBreadcrumbOverflow);
    });
    window.addEventListener('scroll', () => { if (state.breadcrumbOverflowOpen) positionBreadcrumbOverflow(); }, true);
    document.addEventListener('pointerdown', onDocumentPointer);
    document.addEventListener('keydown', onDocumentKeydown);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    document.addEventListener('contextmenu', onRowContextMenu);
    if ('ResizeObserver' in window) {
      new ResizeObserver(scheduleBreadcrumbLayout).observe(ui.breadcrumbRegion);
    }
  }

  function start() {
    bindElements();
    bindEvents();
    ui.root.hidden = false;
    update();
    scheduleBreadcrumbLayout();
    initialize();
  }

  const iconWaitLimit = new Promise(resolve => window.setTimeout(resolve, 600));
  Promise.race([preloadInitialShellIcons(), iconWaitLimit]).then(start, start);
})();
