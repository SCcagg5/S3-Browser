/*!
 * The object browser page of the portal interface.
 *
 * The page renders its DOM directly (no framework). The shell is the shell of the portal: header, theme control,
 * a tab for each bucket, parts. The listing is a dense table in the manner of ClickHouse Dash. The page uses the same
 * API and the same shared modules (api.js, runtime.js, actions.js, ...) as the default interface.
 */
const config = {
  pageSize: 50,
  allowDownloadAll: true,
  keyExcludePatterns: [/^index\.html$/],
  instanceId: '',
  capabilities: {},
  operations: {},
  runtime: {},
  versioningSupported: false
};
window.BB = window.BB || {};
BB.cfg = config;

(function main() {
  'use strict';

  // ---------------------------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------------------------

  function normalizePrefix(value) {
    const clean = String(value || '').replace(/^\/+/, '').replace(/\/+$/, '');
    return clean ? `${clean}/` : '';
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

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // ic(name): an icon of the shell (Tabler name). mdi(name): an icon name of the shared scripts.
  const ic = (name, extra = '') => h('i', { class: ['ic', `ic-${name}`, extra], 'aria-hidden': 'true' });
  const mdi = (name, extra = '') => h('i', { class: ['mdi', `mdi-${name}`, extra], 'aria-hidden': 'true' });
  const byId = id => document.getElementById(id);

  function plural(count, singular, pluralForm = `${singular}s`) {
    const value = Math.max(0, Number(count) || 0);
    return `${value.toLocaleString('en-US')} ${value === 1 ? singular : pluralForm}`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Drag and drop: the files of a dropped selection
  // ---------------------------------------------------------------------------------------------------------------

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
      .map(segment => (segment === '..' ? '_' : segment))
      .join('/');
  }

  const readDirectoryBatch = reader => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const readEntryFile = entry => new Promise((resolve, reject) => entry.file(resolve, reject));

  async function walkEntry(entry, parent, output) {
    if (!entry) return;
    const relative = cleanDroppedPath(parent ? `${parent}/${entry.name}` : entry.name);
    if (entry.isFile) {
      output.push({ file: await readEntryFile(entry), relative });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await readDirectoryBatch(reader);
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, relative, output);
    }
  }

  async function droppedEntries(dataTransfer) {
    const output = [];
    const items = Array.from(dataTransfer?.items || []).filter(item => item.kind === 'file');
    const roots = items.map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null)).filter(Boolean);
    if (roots.length) {
      for (const entry of roots) await walkEntry(entry, '', output);
    } else {
      for (const file of Array.from(dataTransfer?.files || [])) {
        output.push({ file, relative: cleanDroppedPath(file.webkitRelativePath || file.name) });
      }
    }
    const unique = new Map();
    for (const entry of output) if (entry.file && entry.relative) unique.set(entry.relative, entry);
    return Array.from(unique.values());
  }

  // ---------------------------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------------------------

  const state = {
    instances: [],
    build: {},
    defaultInstanceId: '',
    instanceId: '',
    pathPrefix: '',
    rows: [],
    // The decisions of the access policy for the listed folder (authzen mode only): read, write, delete.
    folderAccess: null,
    // '' | 'forbidden' | 'signin' | 'offline' | 'error': why the listing has no rows.
    listError: '',
    listErrorText: '',
    previousContinuationTokens: [],
    continuationToken: '',
    nextContinuationToken: '',
    scanOffset: 0,
    localPage: 0,
    navigationSortAvailable: false,
    navigationSortField: '',
    navigationSortDirection: '',
    modifiedTimeMode: 'relative',
    isRefreshing: false,
    isInitializing: true,
    loadError: '',
    pageSize: config.pageSize,
    // The hosts that the bucket selector shows open.
    expandedHosts: {},
    dragDepth: 0,
    isDragActive: false,
    versionCountRequest: 0,
    refreshRequest: 0
  };

  const ui = {};

  function currentInstance() {
    return state.instances.find(instance => instance.id === state.instanceId) || null;
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
        comparison = Number(left?.dateModified instanceof Date ? left.dateModified.getTime() : 0)
          - Number(right?.dateModified instanceof Date ? right.dateModified.getTime() : 0);
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
  const hasPreviousPage = () => state.localPage > 0 || state.previousContinuationTokens.length > 0;
  const hasNextPage = () => state.localPage + 1 < localPageCount() || Boolean(state.nextContinuationToken);

  function crumbs() {
    const parts = String(state.pathPrefix || '').replace(/\/+$/, '').split('/').filter(Boolean);
    let prefix = '';
    return parts.map(name => {
      prefix += `${name}/`;
      return { name, prefix };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Formatting: sizes in base 1024 with one decimal, times relative or exact (UTC)
  // ---------------------------------------------------------------------------------------------------------------

  function byteParts(size) {
    const value = Math.max(0, Number(size) || 0);
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let scaled = value;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024;
      unit += 1;
    }
    const text = unit === 0 ? String(Math.round(scaled)) : scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, '');
    return { value: text, unit: units[unit] };
  }

  function formatBytes(size) {
    const parts = byteParts(size);
    return `${parts.value} ${parts.unit}`;
  }

  function formatRelative(date) {
    const timestamp = new Date(date).getTime();
    if (!Number.isFinite(timestamp)) return '';
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const ranges = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
    const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    for (const [unit, divisor] of ranges) {
      if (Math.abs(seconds) >= divisor || unit === 'second') return formatter.format(Math.round(seconds / divisor), unit);
    }
    return 'now';
  }

  const formatExact = date => BB.runtime.formatDateTimeUTC(date);
  const formatModified = date => (state.modifiedTimeMode === 'absolute' ? formatExact(date) : formatRelative(date));

  // ---------------------------------------------------------------------------------------------------------------
  // Header: the way back to the portal and the build
  // ---------------------------------------------------------------------------------------------------------------

  // Behind the portal, a reverse proxy serves this page under a path prefix (for example /s3-browser/). The link then
  // goes back to the root of the site, which is the panel of the portal. Without a prefix, the page is the root of the
  // site and the link does not show.
  function renderHeaderLinks() {
    ui.backLink.hidden = new URL(BB.runtime.rootURL).pathname === '/';
  }

  // The version of the server under the name of the product, as ClickHouse Dash shows its backend version. The page
  // keeps the last text in this browser, so a reload does not show "--" until /api/instances answers.
  const VERSION_KEY = 's3-browser.portal.version';

  function versionText(build) {
    const version = String(build.version || build.display || 'dev');
    const commit = String(build.shortCommit || '');
    return commit && commit !== 'unknown' && !version.includes(commit) ? `${version} (${commit})` : version;
  }

  function renderBuild() {
    const build = state.build || {};
    if (!build.version && !build.display) return;
    const text = versionText(build);
    const title = `Server version\n${text}${build.date ? `\nBuild: ${build.date}` : ''}`;
    if (ui.versionBadge.textContent !== text) ui.versionBadge.textContent = text;
    ui.versionBadge.title = title;
    try { localStorage.setItem(VERSION_KEY, JSON.stringify({ text, title })); } catch (_) {}
  }

  function restoreVersion() {
    try {
      const last = JSON.parse(localStorage.getItem(VERSION_KEY) || 'null');
      if (last && last.text) {
        ui.versionBadge.textContent = String(last.text);
        ui.versionBadge.title = String(last.title || '');
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Bucket selector: the control, the labels and the behaviour of the selector of the default interface
  // ---------------------------------------------------------------------------------------------------------------

  // A bucket is read only when its capabilities refuse the write and the delete. The decisions of a folder do not count.
  function readOnly(instance) {
    const allowed = name => (BB.capabilities?.actionable ? BB.capabilities.actionable(instance, name) : true);
    return !allowed('upload') && !allowed('delete');
  }

  function storageHosts() {
    const hosts = [];
    const byId = new Map();
    for (const instance of state.instances) {
      const id = String(instance.host || instance.id || '');
      let host = byId.get(id);
      if (!host) {
        host = { id, provider: String(instance.provider || ''), instances: [] };
        byId.set(id, host);
        hosts.push(host);
      }
      host.instances.push(instance);
    }
    return hosts;
  }

  function permissionStates(instance) {
    const capabilities = instance?.capabilities || {};
    return [
      { key: 'read', label: 'Read', icon: 'eye', state: capabilities.read || {} },
      { key: 'write', label: 'Write', icon: 'pencil', state: capabilities.write || {} },
      { key: 'delete', label: 'Delete', icon: 'trash', state: capabilities.delete || {} }
    ];
  }

  function permissionSummary(instance) {
    return permissionStates(instance).map(item => `${item.label}: ${BB.capabilities.stateLabel(item.state)}`).join(', ');
  }

  function permissionDots(instance) {
    return h('span', { class: 'permDots', title: permissionSummary(instance) },
      permissionStates(instance).map(item => {
        const name = BB.capabilities.normalizeState(item.state);
        return h('span', { class: ['permDot', `is-${name}`], 'data-permission': item.key, 'data-state': name },
          ic(item.icon), h('span', { class: 'visually-hidden' }, `${item.label} ${BB.capabilities.stateLabel(item.state).toLowerCase()}`));
      }));
  }

  // The subtitle of the default interface: bucket, display name, root prefix, provider.
  function storageSubtitle(instance, { rootPrefix = false, provider = false } = {}) {
    return [
      instance.bucket,
      instance.name !== instance.bucket ? instance.name : '',
      rootPrefix && instance.rootPrefix ? `/${instance.rootPrefix}` : '',
      provider ? String(instance.provider || '').toUpperCase() : ''
    ].filter(Boolean).join(' · ');
  }

  function switcherCopy(instance) {
    return h('span', { class: 'storageSwitcher__copy' },
      h('span', { class: 'storageSwitcher__titleRow' }, h('strong', {}, `${instance.host} / ${instance.id}`), permissionDots(instance)),
      h('small', {}, storageSubtitle(instance, { provider: true })));
  }

  function renderSwitcher() {
    const instance = currentInstance();
    const multiple = state.instances.length > 1;
    const signature = JSON.stringify([state.isInitializing, state.loadError, instance?.id,
      state.instances.map(item => [item.id, item.host, item.name, item.bucket, item.rootPrefix, item.provider,
        permissionStates(item).map(entry => BB.capabilities.normalizeState(entry.state))])]);
    if (ui.switcherSignature !== signature) {
      ui.switcherSignature = signature;
      ui.switcherMenu = null;
      ui.switcherTrigger = null;
      const root = ui.switcher;
      root.classList.toggle('is-loading', state.isInitializing);
      root.classList.remove('is-open');
      if (state.isInitializing) {
        root.replaceChildren(h('div', { class: 'storageSwitcher__trigger is-static', 'aria-hidden': 'true' }, h('span', { class: 'storageSwitcher__skeleton' })));
      } else if (!instance) {
        root.replaceChildren(h('div', { class: 'storageSwitcher__trigger is-static', 'data-empty': 'true' },
          ic('database', 'storageSwitcher__icon'),
          h('span', { class: 'storageSwitcher__copy' }, h('strong', {}, 'No bucket'),
            h('small', {}, state.loadError ? 'The list of buckets cannot be loaded' : 'No bucket is visible to you'))));
      } else if (!multiple) {
        root.replaceChildren(h('div', { class: 'storageSwitcher__trigger is-static', title: permissionSummary(instance) },
          ic('database', 'storageSwitcher__icon'), switcherCopy(instance)));
      } else {
        const trigger = h('button', {
          type: 'button',
          class: 'storageSwitcher__trigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': 'false',
          'aria-controls': 'storageSwitcherMenu',
          title: `${instance.host} / ${instance.id}. ${permissionSummary(instance)}`,
          onclick: event => { event.stopPropagation(); toggleSwitcher(); },
          onkeydown: event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); openSwitcher(true); }
          }
        }, ic('database', 'storageSwitcher__icon'), switcherCopy(instance), ic('chevron-down', 'storageSwitcher__chevron'));
        const menu = h('div', {
          id: 'storageSwitcherMenu', class: 'storageSwitcher__menu', role: 'listbox', 'aria-label': 'Storage hosts and buckets', hidden: true,
          onclick: event => event.stopPropagation(),
          onkeydown: onSwitcherKey
        }, storageHosts().map(host => {
          const expanded = state.expandedHosts[host.id] === true;
          const list = h('div', { class: 'storageHost__buckets', role: 'group', 'aria-label': `${host.id} buckets`, hidden: !expanded },
            host.instances.map(entry => h('button', {
              type: 'button',
              class: 'storageBucket',
              role: 'option',
              'aria-selected': entry.id === state.instanceId ? 'true' : 'false',
              'data-instance': entry.id,
              title: permissionSummary(entry),
              onclick: () => { closeSwitcher(true); selectInstance(entry.id); }
            },
            ic('folder'),
            h('span', { class: 'storageBucket__copy' },
              h('span', { class: 'storageBucket__titleRow' }, h('strong', {}, entry.id), permissionDots(entry)),
              h('small', {}, storageSubtitle(entry, { rootPrefix: true }))),
            entry.id === state.instanceId ? ic('check', 'storageBucket__check') : null)));
          const row = h('button', {
            type: 'button', class: 'storageHost__row', 'aria-expanded': expanded ? 'true' : 'false', 'data-host': host.id,
            onclick: () => {
              const open = row.getAttribute('aria-expanded') !== 'true';
              state.expandedHosts = { ...state.expandedHosts, [host.id]: open };
              row.setAttribute('aria-expanded', String(open));
              list.hidden = !open;
            }
          }, ic('chevron-right', 'storageHost__chevron'), ic('database'),
          h('span', { class: 'storageHost__copy' }, h('strong', {}, host.id),
            h('small', {}, `${host.provider.toUpperCase()} · ${plural(host.instances.length, 'bucket')}`)));
          return h('section', { class: 'storageHost', 'data-host': host.id }, row, list);
        }),
        h('div', { class: 'storageSwitcher__foot' },
          h('button', { type: 'button', class: 'button button--ghost button--small', onclick: () => { closeSwitcher(false); showPermissions(); } }, ic('lock'), 'Permissions of this bucket')));
        root.replaceChildren(trigger, menu);
        ui.switcherTrigger = trigger;
        ui.switcherMenu = menu;
      }
    }
  }

  function switcherItems() {
    return Array.from(ui.switcherMenu?.querySelectorAll('.storageHost__row, .storageBucket:not([hidden]), .storageSwitcher__foot .button') || [])
      .filter(node => node.offsetParent !== null);
  }

  function openSwitcher(focus = false) {
    if (!ui.switcherMenu || !ui.switcherMenu.hidden) return;
    closeMenu();
    // The host of the current bucket opens with the menu.
    const host = String(currentInstance()?.host || '');
    if (host && state.expandedHosts[host] !== true) {
      state.expandedHosts = { ...state.expandedHosts, [host]: true };
      const row = ui.switcherMenu.querySelector(`.storageHost__row[data-host="${CSS.escape(host)}"]`);
      row?.setAttribute('aria-expanded', 'true');
      if (row) row.nextElementSibling.hidden = false;
    }
    ui.switcherMenu.hidden = false;
    ui.switcher.classList.add('is-open');
    ui.switcherTrigger.setAttribute('aria-expanded', 'true');
    if (focus) (ui.switcherMenu.querySelector('.storageBucket[aria-selected="true"]') || switcherItems()[0])?.focus();
  }

  function closeSwitcher(focus = false) {
    if (!ui.switcherMenu || ui.switcherMenu.hidden) return;
    ui.switcherMenu.hidden = true;
    ui.switcher.classList.remove('is-open');
    ui.switcherTrigger.setAttribute('aria-expanded', 'false');
    if (focus) ui.switcherTrigger.focus();
  }

  function toggleSwitcher() {
    if (ui.switcherMenu?.hidden) openSwitcher(false);
    else closeSwitcher(false);
  }

  function onSwitcherKey(event) {
    const items = switcherItems();
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[Math.min(items.length - 1, index + 1)]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[Math.max(0, index - 1)]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSwitcher(true); }
    else if (event.key === 'Tab') closeSwitcher(false);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Crumbs: the display name of the bucket is the root, with a "root" tag
  // ---------------------------------------------------------------------------------------------------------------

  const CRUMB_EDGE = 2;

  function renderCrumbs() {
    const instance = currentInstance();
    const list = crumbs();
    const signature = JSON.stringify([instance?.id, instance?.name, state.pathPrefix]);
    if (ui.crumbsSignature === signature) return;
    ui.crumbsSignature = signature;
    if (!instance) {
      ui.crumbs.replaceChildren();
      return;
    }
    const atRoot = !list.length;
    const where = instance.rootPrefix ? `${instance.bucket}/${instance.rootPrefix}` : instance.bucket;
    const nodes = [h('button', {
      type: 'button',
      class: 'crumb crumb--root',
      'aria-current': atRoot ? 'page' : null,
      'aria-label': `${instance.name}, bucket root`,
      title: `Root of ${instance.name} (${where})`,
      'data-crumb': 'root',
      onclick: () => { if (!atRoot) goToPrefix(''); }
    }, ic('database'), h('span', {}, instance.name), h('span', { class: 'crumb__tag', 'aria-hidden': 'true' }, 'root'))];
    const separator = () => h('span', { class: 'crumbs__sep', 'aria-hidden': 'true' }, ic('chevron-right'));

    // A deep path keeps the root, a menu for the hidden parents, and the last CRUMB_EDGE folders.
    const hidden = list.length > CRUMB_EDGE + 1 ? list.slice(0, list.length - CRUMB_EDGE) : [];
    const shown = hidden.length ? list.slice(list.length - CRUMB_EDGE) : list;
    if (hidden.length) {
      nodes.push(separator());
      const menu = h('div', { class: 'menu', role: 'menu', hidden: true },
        hidden.map(crumb => h('button', { type: 'button', class: 'menu__item', role: 'menuitem', title: crumb.prefix, onclick: () => goToPrefix(crumb.prefix) },
          ic('folder'), crumb.name)));
      const trigger = h('button', {
        type: 'button', class: 'crumb crumb--more', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        'aria-label': `Show ${plural(hidden.length, 'parent folder')}`, title: hidden.map(crumb => crumb.name).join(' / ')
      }, h('span', {}, '…'));
      nodes.push(h('span', { class: 'menuWrap' }, trigger, menu));
      bindMenu(trigger, menu);
    }
    shown.forEach((crumb, index) => {
      nodes.push(separator());
      const last = index === shown.length - 1;
      nodes.push(h('button', {
        type: 'button',
        class: 'crumb',
        'aria-current': last ? 'page' : null,
        title: crumb.prefix,
        onclick: () => { if (!last) goToPrefix(crumb.prefix); }
      }, h('span', {}, crumb.name)));
    });
    ui.crumbs.replaceChildren(...nodes);
  }

  function renderTitle() {
    const instance = currentInstance();
    const list = crumbs();
    let title = 'Loading the buckets';
    if (!state.isInitializing && !instance) title = state.loadError ? 'The buckets cannot be loaded' : 'No bucket';
    else if (instance) title = list.length ? list[list.length - 1].name : instance.name;
    // The heading is for screen readers: the crumbs show the place on the screen.
    const heading = instance ? `${title}${list.length ? `, in ${instance.name}` : ', bucket root'}` : title;
    if (ui.title.textContent !== heading) ui.title.textContent = heading;

    let countText = '';
    if (instance && !state.listError && canRead()) {
      if (state.isRefreshing && !state.rows.length) countText = 'Loading';
      else {
        const folders = state.rows.filter(row => row.type === 'prefix').length;
        const files = state.rows.length - folders;
        const bytes = state.rows.reduce((sum, row) => sum + (row.type === 'content' ? row.size : 0), 0);
        const parts = [];
        if (folders) parts.push(plural(folders, 'folder'));
        if (files || !folders) parts.push(plural(files, 'file'));
        if (files) parts.push(formatBytes(bytes));
        countText = parts.join(', ') + (state.nextContinuationToken || state.previousContinuationTokens.length ? ' in this page of the listing' : '');
      }
    }
    ui.countText = countText;
    if (ui.table?.count && ui.table.count.textContent !== countText) ui.table.count.textContent = countText;
    document.title = instance ? `${title} - ${instance.name} - Object storage` : 'Object storage';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Toolbar and menus
  // ---------------------------------------------------------------------------------------------------------------

  let openMenu = null;

  function closeMenu({ focus = false } = {}) {
    if (!openMenu) return;
    const { trigger, menu } = openMenu;
    openMenu = null;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  }

  // A menu opens under its button, aligned to the side that keeps it inside the window.
  function placeMenu(menu) {
    menu.classList.remove('menu--start', 'menu--end');
    const wrap = menu.parentElement.getBoundingClientRect();
    const width = menu.offsetWidth;
    const fitsEnd = wrap.right - width >= 8;
    const fitsStart = wrap.left + width <= window.innerWidth - 8;
    menu.classList.add(fitsEnd && (!fitsStart || wrap.left + wrap.width / 2 > window.innerWidth / 2) ? 'menu--end' : 'menu--start');
  }

  function bindMenu(trigger, menu) {
    const items = () => Array.from(menu.querySelectorAll('.menu__item:not(:disabled)'));
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      if (openMenu?.menu === menu) {
        closeMenu();
        return;
      }
      closeMenu();
      closeSwitcher(false);
      openMenu = { trigger, menu };
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      placeMenu(menu);
    });
    trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (openMenu?.menu !== menu) trigger.click();
      items()[0]?.focus();
    });
    menu.addEventListener('click', event => {
      if (event.target.closest('.menu__item')) closeMenu();
    });
    menu.addEventListener('keydown', event => {
      const list = items();
      const index = list.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); list[Math.min(list.length - 1, index + 1)]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); list[Math.max(0, index - 1)]?.focus(); }
      else if (event.key === 'Escape') { event.stopPropagation(); closeMenu({ focus: true }); }
      else if (event.key === 'Tab') closeMenu();
    });
  }

  function accessBadge() {
    const instance = currentInstance();
    if (!instance || !canRead() || state.listError) return null;
    const write = canWrite();
    const remove = canDelete();
    if (write && remove) return null;
    const folder = state.folderAccess && (state.folderAccess.write === false || state.folderAccess.delete === false);
    if (!write && !remove) return { text: 'Read only', title: folder ? 'The access policy lets you read this folder only.' : 'You can read this bucket but not change it.' };
    if (!write) return { text: 'No upload', title: 'You cannot write in this folder.' };
    return { text: 'No delete', title: 'You cannot delete in this folder.' };
  }

  function renderToolbar() {
    const instance = currentInstance();
    const read = Boolean(instance) && canRead();
    ui.searchInput.disabled = !read;
    ui.refreshButton.disabled = !instance || state.isRefreshing;
    ui.actionsButton.disabled = !instance;
    ui.zipItem.disabled = !canDownloadAll();
    ui.insightsItem.disabled = !read || Boolean(state.listError);
    ui.insightsItem.querySelector('span').textContent = state.pathPrefix ? 'Folder insights' : 'Bucket insights';
    ui.uploadWrap.hidden = !instance || !canWrite() || Boolean(state.listError);
    const badge = accessBadge();
    ui.accessBadge.hidden = !badge;
    if (badge) {
      ui.accessBadge.replaceChildren(ic('lock'), badge.text);
      ui.accessBadge.title = badge.title;
    }
    const folderName = crumbs().slice(-1)[0]?.name;
    const label = folderName ? `Open a prefix in ${folderName}` : 'Open a prefix in this bucket';
    if (ui.searchInput.placeholder !== label) {
      ui.searchInput.placeholder = label;
      ui.searchLabel.textContent = label;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Listing: states, table and pagination
  // ---------------------------------------------------------------------------------------------------------------

  function emptyBox(iconName, title, text, ...actions) {
    return h('div', { class: 'empty', 'data-empty': iconName }, ic(iconName), h('strong', {}, title), text && h('span', {}, text), actions);
  }

  function skeleton() {
    const widths = [62, 48, 70, 40, 56, 66];
    const bar = width => {
      const node = h('span', { class: 'skeletonBar' });
      node.style.width = `${width}%`;
      return node;
    };
    return h('div', { class: 'tableBox', 'aria-busy': 'true', 'aria-label': 'Loading the folder' },
      h('table', { class: 'dataTable' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'num col-size' }, 'Size'), h('th', { class: 'col-modified' }, 'Modified'), h('th', { class: 'col-menu' }))),
        h('tbody', {}, widths.map(width => h('tr', { class: 'skeletonRow' },
          h('td', {}, bar(width)),
          h('td', { class: 'col-size' }, bar(80)),
          h('td', { class: 'col-modified' }, bar(70)),
          h('td', { class: 'col-menu' }))))));
  }

  function listingMode() {
    if (state.isInitializing) return 'loading';
    if (state.loadError) return 'load-error';
    if (!currentInstance()) return 'none';
    if (!canRead()) return 'unreadable';
    if (state.listError) return `error-${state.listError}`;
    if (!state.rows.length) return state.isRefreshing ? 'loading' : (canWrite() ? 'empty-writable' : 'empty');
    return 'table';
  }

  function renderListing() {
    const mode = listingMode();
    const signature = `${mode}:${state.listErrorText}:${state.loadError}:${state.pathPrefix}`;
    if (signature !== ui.listingSignature) {
      ui.listingSignature = signature;
      ui.table = null;
      let content;
      switch (mode) {
        case 'loading':
          content = skeleton();
          break;
        case 'load-error':
          content = emptyBox('cloud-off', 'The list of buckets cannot be loaded', state.loadError,
            h('button', { type: 'button', class: 'button', onclick: () => initialize() }, ic('refresh'), 'Try again'));
          break;
        case 'none':
          content = emptyBox('lock', 'No bucket is available to you',
            'The server shows only the buckets on which you hold a permission. Ask an administrator for a grant.');
          break;
        case 'unreadable':
          content = emptyBox('lock', 'You cannot list this bucket', 'Read access is not available. Other actions stay hidden.');
          break;
        case 'error-forbidden':
          content = emptyBox('lock', 'You cannot open this folder', 'The access policy does not let you read it.',
            state.pathPrefix && h('button', { type: 'button', class: 'button', onclick: () => goToPrefix('') }, ic('database'), 'Go to the bucket root'));
          break;
        case 'error-signin':
          // The notice at the top of the page gives the message and the "Reload" button.
          content = emptyBox('lock', 'This folder shows after a new sign-in', '');
          break;
        case 'error-offline':
          content = emptyBox('cloud-off', 'The server does not answer', 'The folder cannot be listed now.',
            h('button', { type: 'button', class: 'button', onclick: () => manualRefresh() }, ic('refresh'), 'Try again'));
          break;
        case 'error-error':
          content = emptyBox('alert-triangle', 'The folder cannot be listed', state.listErrorText,
            h('button', { type: 'button', class: 'button', onclick: () => manualRefresh() }, ic('refresh'), 'Try again'));
          break;
        case 'empty-writable':
          content = emptyBox('folder-open', 'This folder is empty', 'Drop files on the page, or upload files or a folder.',
            h('button', { type: 'button', class: 'button button--primary', onclick: triggerUploadFiles }, ic('upload'), 'Upload files'));
          break;
        case 'empty':
          content = emptyBox('folder-open', 'This folder is empty', '');
          break;
        default:
          content = buildTable();
      }
      ui.listing.replaceChildren(content);
    }
    if (mode === 'table') renderTable();
  }

  function sortHead(field, label) {
    const iconBox = h('span', { class: 'sortHead__icon' });
    const node = h('button', { type: 'button', class: 'sortHead', onclick: () => toggleSort(field) }, label, iconBox);
    return { field, label, node, iconBox };
  }

  function buildTable() {
    const sorts = { name: sortHead('name', 'Name'), size: sortHead('size', 'Size'), dateModified: sortHead('dateModified', 'Modified') };
    const timeToggle = h('button', { type: 'button', class: 'timeToggle', onclick: event => { event.stopPropagation(); toggleTimeMode(); } }, ic('clock'));
    const tbody = h('tbody');
    const box = h('div', { class: 'tableBox' },
      h('table', { class: 'dataTable', 'aria-label': 'Folder content' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, sorts.name.node),
          h('th', { scope: 'col', class: 'num col-size' }, sorts.size.node),
          h('th', { scope: 'col', class: 'col-modified' }, h('span', { class: 'headTools' }, sorts.dateModified.node, timeToggle)),
          h('th', { scope: 'col', class: 'col-menu' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
        tbody));
    const range = h('span', { class: 'tableFoot__range' });
    const pageSize = h('select', {
      'aria-label': 'Rows on each page',
      onchange: event => {
        state.pageSize = Number(event.target.value) || 50;
        config.pageSize = state.pageSize;
        state.localPage = 0;
        update();
        refreshVisibleVersionCounts();
      }
    }, [50, 100, 500].map(size => h('option', { value: size }, size)));
    const previous = h('button', { type: 'button', class: 'button button--small button--icon', 'aria-label': 'Previous page', title: 'Previous page', onclick: () => previousPage() }, ic('chevron-left'));
    const next = h('button', { type: 'button', class: 'button button--small button--icon', 'aria-label': 'Next page', title: 'Next page', onclick: () => nextPage() }, ic('chevron-right'));
    const pager = h('div', { class: 'tableFoot__pager' }, previous, next);
    const count = h('span', { id: 'folderCount', class: 'tableFoot__count' }, ui.countText || '');
    const foot = h('div', { class: 'tableFoot' },
      count,
      range,
      h('label', {}, 'Rows', h('span', { class: 'select' }, pageSize)),
      pager);
    ui.table = { sorts, timeToggle, tbody, box, range, count, pageSize, previous, next, pager, foot };
    return h('div', { class: 'listing' }, box, foot);
  }

  function sortIcon(field) {
    if (!state.navigationSortAvailable) return '';
    if (state.navigationSortField !== field) return 'selector';
    return state.navigationSortDirection === 'desc' ? 'arrow-down' : 'arrow-up';
  }

  function renderTable() {
    const t = ui.table;
    for (const entry of Object.values(t.sorts)) {
      const available = state.navigationSortAvailable;
      entry.node.disabled = !available;
      const active = state.navigationSortField === entry.field;
      entry.node.setAttribute('aria-sort', active ? (state.navigationSortDirection === 'desc' ? 'descending' : 'ascending') : 'none');
      entry.node.title = available ? `Sort by ${entry.label.toLowerCase()}` : 'The order of the provider. Sorting needs the whole folder in one listing.';
      const name = sortIcon(entry.field);
      entry.iconBox.replaceChildren(...(name ? [ic(name)] : []));
    }
    const absolute = state.modifiedTimeMode === 'absolute';
    t.timeToggle.setAttribute('aria-pressed', absolute ? 'true' : 'false');
    t.timeToggle.title = absolute ? 'Show relative times' : 'Show exact times (UTC)';
    t.timeToggle.setAttribute('aria-label', t.timeToggle.title);
    t.box.classList.toggle('is-busy', state.isRefreshing);

    t.tbody.replaceChildren(...visibleRows().map(buildRow));
    const total = state.nextContinuationToken ? `${rangeEnd().toLocaleString('en-US')}+` : (state.scanOffset + state.rows.length).toLocaleString('en-US');
    t.range.textContent = `${rangeStart().toLocaleString('en-US')} to ${rangeEnd().toLocaleString('en-US')} of ${total}`;
    t.pageSize.value = String(state.pageSize);
    t.pageSize.disabled = state.isRefreshing;
    t.previous.disabled = !hasPreviousPage() || state.isRefreshing;
    t.next.disabled = !hasNextPage() || state.isRefreshing;
    t.pager.hidden = !hasPreviousPage() && !hasNextPage();
  }

  function menuItem(label, iconName, onclick, { danger = false } = {}) {
    return h('button', { type: 'button', class: ['bb-menu-item', danger && 'danger'], role: 'menuitem', onclick }, mdi(iconName), label);
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
    return h('div', { class: 'bb-menu', ...(row.type === 'content' ? { 'data-key': row.key } : { 'data-prefix': row.prefix }) },
      h('button', { type: 'button', class: 'bb-kebab', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Actions for ${row.name}`, title: 'Actions' }, mdi('dots-vertical')),
      h('div', { class: 'bb-menu-popover', role: 'menu' }, h('div', { class: 'bb-menu-list' }, items)));
  }

  function versionBadge(row) {
    if (!versioningSupported() || !Number.isInteger(row.versionCount)) return null;
    return h('span', { class: 'badge versionCount', title: plural(row.versionCount, 'version') }, ic('git-commit'), row.versionCount);
  }

  function buildRow(row) {
    const isContent = row.type === 'content';
    const name = h('div', { class: ['nameCell', !isContent && 'is-folder'] },
      isContent ? mdi(fileIcon(row)) : ic('folder'),
      h('button', { type: 'button', class: 'nameLink', title: isContent ? row.key : row.prefix, onclick: () => (isContent ? openPreview(row) : goToPrefix(row.prefix)) }, row.name),
      isContent && versionBadge(row));
    let size;
    if (isContent) {
      const parts = byteParts(row.size);
      size = h('span', { class: 'sizeCell', title: `${row.size.toLocaleString('en-US')} bytes` }, parts.value, h('span', { class: 'sizeCell__unit' }, parts.unit));
    } else {
      size = h('span', { class: 'visually-hidden' }, 'Folder');
    }
    const modified = row.dateModified
      ? h('time', { class: 'modifiedCell', datetime: row.dateModified.toISOString(), title: formatExact(row.dateModified) }, formatModified(row.dateModified))
      : null;
    const tr = h('tr', { 'data-name': row.name, 'data-type': row.type },
      h('td', {}, name),
      h('td', { class: 'num col-size' }, size),
      h('td', { class: 'col-modified' }, modified),
      h('td', { class: 'col-menu' }, rowMenu(row)));
    row.element = tr;
    return tr;
  }

  function updateVersionBadges() {
    for (const row of visibleRows()) {
      const cell = row.element?.querySelector('.nameCell');
      if (!cell) continue;
      cell.querySelector('.versionCount')?.remove();
      const badge = row.type === 'content' ? versionBadge(row) : null;
      if (badge) cell.append(badge);
    }
  }

  function renderDropOverlay() {
    ui.dropOverlay.hidden = !state.isDragActive;
    ui.dropTarget.textContent = `${currentInstance()?.name || ''} / ${state.pathPrefix}`;
  }

  function update() {
    renderBuild();
    renderSwitcher();
    renderCrumbs();
    renderTitle();
    renderToolbar();
    renderListing();
    renderDropOverlay();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Navigation and loading
  // ---------------------------------------------------------------------------------------------------------------

  function classify(error) {
    const status = Number(error?.status || 0);
    if (status === 401) return 'signin';
    if (status === 403) return 'forbidden';
    if ([502, 503, 504].includes(status) || (!status && (error instanceof TypeError || /network|fetch/i.test(String(error?.message || ''))))) return 'offline';
    return 'error';
  }

  async function initialize() {
    state.isInitializing = true;
    state.loadError = '';
    update();
    try {
      const response = await BB.api.instances();
      state.instances = (response.instances || []).map(instance => ({ ...instance, host: String(instance.host || instance.id || '') }));
      state.build = response.build || {};
      config.runtime = BB.runtime?.configure(response.runtime || {}) || (response.runtime || {});
      state.defaultInstanceId = response.default || state.instances[0]?.id || '';
      const route = BB.runtime?.storageRoute?.();
      const routeInstance = route?.view === 'browser'
        ? state.instances.find(instance => instance.host === route.host && instance.id === route.bucket)?.id || ''
        : '';
      const queryInstance = new URLSearchParams(location.search).get('instance');
      const candidate = [routeInstance, queryInstance, state.defaultInstanceId]
        .find(id => id && state.instances.some(instance => instance.id === id));
      state.instanceId = candidate || state.instances[0]?.id || '';
      state.isInitializing = false;
      if (!state.instanceId) {
        update();
        return;
      }
      applyCurrentInstance();
      state.pathPrefix = routeInstance === state.instanceId ? normalizePrefix(route.path) : parseLegacyHash();
      ui.searchInput.value = '';
      replaceLocation(state.pathPrefix);
      update();
      await refresh();
    } catch (error) {
      state.isInitializing = false;
      const kind = classify(error);
      state.loadError = kind === 'signin' ? 'Your sign-in has ended. Reload the page to sign in again.'
        : kind === 'offline' ? 'The server does not answer.' : String(error?.message || error);
      update();
    }
  }

  function browserLocation(prefix = '') {
    const url = new URL(BB.api.browserPageURL(prefix, { instance: state.instanceId }));
    return url.pathname + url.search + url.hash;
  }

  function replaceLocation(prefix = '', { push = false } = {}) {
    const target = browserLocation(prefix);
    if (target === location.pathname + location.search + location.hash) return;
    history[push ? 'pushState' : 'replaceState'](null, '', target);
  }

  function applyCurrentInstance() {
    const instance = currentInstance();
    if (!instance) return;
    BB.api.setInstance(instance);
    config.capabilities = instance.capabilities || {};
    config.operations = instance.operations || {};
    config.versioningSupported = instance.versioningSupported === true;
  }

  function resetPagination() {
    state.previousContinuationTokens = [];
    state.continuationToken = '';
    state.nextContinuationToken = '';
    state.scanOffset = 0;
    state.localPage = 0;
    state.navigationSortAvailable = false;
    state.navigationSortField = '';
    state.navigationSortDirection = '';
  }

  function clearListing() {
    state.rows = [];
    state.folderAccess = null;
    state.listError = '';
    state.listErrorText = '';
  }

  async function selectInstance(id) {
    if (!id || id === state.instanceId) return;
    closeMenu();
    state.instanceId = id;
    applyCurrentInstance();
    state.pathPrefix = '';
    ui.searchInput.value = '';
    resetPagination();
    clearListing();
    replaceLocation('', { push: true });
    update();
    await refresh();
  }

  function goToPrefix(prefix) {
    closeMenu();
    const normalized = normalizePrefix(prefix);
    resetPagination();
    if (normalized !== state.pathPrefix) {
      state.pathPrefix = normalized;
      ui.searchInput.value = '';
      clearListing();
      replaceLocation(normalized, { push: true });
    }
    update();
    refresh();
  }

  function updateFromLocation() {
    const route = BB.runtime?.storageRoute?.();
    if (!route || route.view !== 'browser') return;
    const instance = state.instances.find(item => item.host === route.host && item.id === route.bucket);
    if (!instance) return;
    const next = normalizePrefix(route.path);
    if (instance.id === state.instanceId && next === state.pathPrefix) return;
    if (instance.id !== state.instanceId) {
      state.instanceId = instance.id;
      applyCurrentInstance();
    }
    state.pathPrefix = next;
    ui.searchInput.value = '';
    resetPagination();
    clearListing();
    update();
    if (!state.isInitializing) refresh();
  }

  function searchByPrefix() {
    const value = String(ui.searchInput.value || '').trim();
    if (!value) {
      manualRefresh();
      return;
    }
    goToPrefix(normalizePrefix(state.pathPrefix + value));
  }

  function manualRefresh() {
    resetPagination();
    refresh();
  }

  function toggleSort(field) {
    if (!state.navigationSortAvailable) return;
    const first = field === 'name' ? 'asc' : 'desc';
    const second = first === 'desc' ? 'asc' : 'desc';
    if (state.navigationSortField !== field) {
      state.navigationSortField = field;
      state.navigationSortDirection = first;
    } else if (state.navigationSortDirection === first) {
      state.navigationSortDirection = second;
    } else {
      state.navigationSortField = '';
      state.navigationSortDirection = '';
    }
    state.localPage = 0;
    update();
    refreshVisibleVersionCounts();
  }

  function toggleTimeMode() {
    state.modifiedTimeMode = state.modifiedTimeMode === 'relative' ? 'absolute' : 'relative';
    update();
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
    if (!currentInstance()) return;
    const request = ++state.refreshRequest;
    const prefix = state.pathPrefix;
    state.isRefreshing = true;
    update();
    try {
      if (!canRead()) {
        clearListing();
        state.nextContinuationToken = '';
        return;
      }
      const data = await BB.api.list({ prefix, delimiter: '/', continuationToken: state.continuationToken });
      if (request !== state.refreshRequest) return;
      state.listError = '';
      state.listErrorText = '';
      state.nextContinuationToken = data.nextContinuationToken || '';
      state.folderAccess = data.access && typeof data.access === 'object' ? data.access : null;
      state.navigationSortAvailable = data.sortAvailable === true;
      if (!state.navigationSortAvailable) {
        state.navigationSortField = '';
        state.navigationSortDirection = '';
      }
      state.rows = (data.items || []).map(item => {
        if (item.type === 'prefix') {
          const name = String(item.name || item.prefix || '').replace(/\/+$/, '').split('/').pop();
          return { type: 'prefix', name, prefix: item.prefix, size: 0, dateModified: null };
        }
        return {
          type: 'content',
          name: item.name || String(item.key || '').split('/').pop(),
          key: item.key,
          size: Number(item.size || 0),
          dateModified: item.lastModified ? new Date(item.lastModified) : null,
          contentType: item.contentType || '',
          etag: item.etag || '',
          versionCount: null
        };
      }).filter(row => !config.keyExcludePatterns.some(pattern => pattern.test(String((row.type === 'prefix' ? row.prefix : row.key) || ''))));
      state.localPage = Math.max(0, Math.min(state.localPage, localPageCount() - 1));
    } catch (error) {
      if (request !== state.refreshRequest) return;
      clearListing();
      state.listError = classify(error);
      state.listErrorText = String(error?.message || error);
    } finally {
      if (request === state.refreshRequest) {
        state.isRefreshing = false;
        update();
      }
    }
    if (request === state.refreshRequest) refreshVisibleVersionCounts();
  }

  async function refreshVisibleVersionCounts() {
    const request = ++state.versionCountRequest;
    if (!versioningSupported() || !canRead()) {
      for (const row of state.rows) if (row.type === 'content') row.versionCount = null;
      updateVersionBadges();
      return;
    }
    const instanceId = state.instanceId;
    const keys = visibleRows().filter(row => row.type === 'content' && row.key).map(row => row.key);
    if (!keys.length) return;
    try {
      const response = await BB.api.versionCounts(keys, instanceId);
      if (request !== state.versionCountRequest || instanceId !== state.instanceId) return;
      const counts = response?.counts || {};
      for (const row of state.rows) {
        if (row.type !== 'content' || !Object.prototype.hasOwnProperty.call(counts, row.key)) continue;
        row.versionCount = Number(counts[row.key]?.count || 0);
      }
      updateVersionBadges();
    } catch (error) {
      if (Number(error?.status || 0) !== 501) console.warn('Unable to load object version counts', error);
    }
  }

  function fileIcon(row) {
    return BB.detect.iconForType(BB.detect.resolveType(row.name || '', row.contentType || ''));
  }

  function openPreview(row) {
    if (!canRead()) return;
    window.location.href = BB.api.previewPageURL(row.key, { instance: state.instanceId });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Row and folder actions (BB.actions, shared with the default interface)
  // ---------------------------------------------------------------------------------------------------------------

  function onRowMetadata(row) {
    BB.actions.showMetadata(row.key, { size: row.size, mime: row.contentType, etag: row.etag, lastModified: row.dateModified?.toUTCString?.() || '' });
  }
  function onRowDownload(row) { BB.actions.downloadObject(row.key, row.name); }
  function onRowVersions(row) { BB.actions.showVersions(row.key); }
  async function onRowCopy(row) { if (await BB.actions.copyObject(row.key)) await refresh(); }
  async function onRowRename(row) { if (await BB.actions.renameObject(row.key)) await refresh(); }
  async function onRowDelete(row) { if (await BB.actions.deleteObject(row.key)) await refresh(); }
  function onPrefixInsights(row) { BB.actions.showPrefixInsights(row.prefix); }
  async function onPrefixCopy(row) { if (await BB.actions.copyPrefix(row.prefix)) await refresh(); }
  async function onPrefixRename(row) { if (await BB.actions.renamePrefix(row.prefix)) await refresh(); }
  async function onPrefixDelete(row) { if (await BB.actions.deletePrefix(row.prefix)) await refresh(); }

  function onRowContextMenu(event) {
    const row = event.target?.closest?.('.dataTable tbody tr');
    const menu = row?.querySelector('.bb-menu');
    if (!menu || !BB.menu?.openAt) return;
    event.preventDefault();
    event.stopPropagation();
    BB.menu.openAt(menu, event.clientX, event.clientY);
  }

  function downloadArchive({ archiveName, basePrefix = '' }) {
    if (!canRead()) return;
    const url = BB.api.archiveURL({ prefix: basePrefix, name: archiveName, instance: state.instanceId });
    BB.actions.triggerBrowserDownload(url, archiveName);
    BB.ui.toast('The ZIP download started in the browser.', { duration: 5000 });
  }

  function downloadAll() {
    if (!canDownloadAll()) return;
    const name = `${state.pathPrefix.split('/').filter(Boolean).pop() || currentInstance()?.name || 'archive'}.zip`;
    downloadArchive({ archiveName: name, basePrefix: state.pathPrefix });
  }

  function onPrefixDownload(row) {
    const prefix = normalizePrefix(row.prefix);
    downloadArchive({ archiveName: `${prefix.split('/').filter(Boolean).pop() || 'folder'}.zip`, basePrefix: prefix });
  }

  async function showPermissions() {
    const instance = currentInstance();
    if (!instance) return;
    const caps = instance.capabilities || {};
    const rows = [['Read', 'read', 'eye-outline'], ['Write', 'write', 'pencil-outline'], ['Delete', 'delete', 'delete-outline']].map(([label, key, iconName]) => {
      const capability = caps[key] || {};
      const name = BB.capabilities.normalizeState(capability);
      const folder = state.folderAccess && state.folderAccess[key] === false;
      const result = folder ? 'Denied in this folder' : BB.capabilities.stateLabel(capability);
      const tone = folder || name === 'denied' ? 'danger' : name === 'allowed' ? 'ok' : '';
      const reason = String(capability.reason || '');
      return `<li class="permRow"><span class="permName"><i class="mdi mdi-${iconName}" aria-hidden="true"></i>${label}</span>
        <span class="badge${tone ? ` badge--${tone}` : ''}">${escapeHTML(result)}</span>
        ${reason ? `<span class="permReason">${escapeHTML(reason)}</span>` : ''}</li>`;
    }).join('');
    const provider = Array.from(caps.permissions || []).map(String).join(', ') || 'not reported';
    await BB.ui.alert({
      title: 'Bucket permissions',
      html: `<div class="permissions">
        <p class="part__lede">${escapeHTML(instance.name)}: bucket <code>${escapeHTML(instance.bucket)}</code> on <code>${escapeHTML(instance.host)}</code>.
        The page hides what you cannot do. The server checks each request again.</p>
        <ul class="permList">${rows}</ul>
        <p class="part__lede">Permissions of the configuration: <code>${escapeHTML(provider)}</code>.</p>
      </div>`
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------------------------------------------

  let refreshTimer = 0;
  let lastUploadRefresh = 0;

  // A file that arrives in the listed folder shows after a short delay: one refresh every 2.5 s at most.
  function scheduleUploadRefresh(destination, immediate = false) {
    if (destination.instanceId !== state.instanceId || destination.prefix !== state.pathPrefix) return;
    clearTimeout(refreshTimer);
    const wait = immediate ? 300 : Math.max(800, 2500 - (Date.now() - lastUploadRefresh));
    refreshTimer = setTimeout(() => {
      lastUploadRefresh = Date.now();
      if (!state.isRefreshing) refresh();
      else scheduleUploadRefresh(destination);
    }, wait);
  }

  function uploader() {
    if (!ui.uploads) {
      ui.uploads = BB.uploads.create({
        host: ui.uploadDock,
        onFileDone: (_, destination) => scheduleUploadRefresh(destination),
        onBatchEnd: destination => scheduleUploadRefresh(destination, true),
        onSignInEnded: () => BB.session?.signInEnded(),
        onBlockedChange: () => BB.session?.refresh()
      });
      if (BB.session) BB.session.ownsOffline = () => ui.uploads?.batch?.blocked === 'offline';
    }
    return ui.uploads;
  }

  function triggerUploadFiles() {
    if (!canWrite()) return;
    ui.fileInput.value = '';
    ui.fileInput.click();
  }

  function triggerUploadFolder() {
    if (!canWrite()) return;
    ui.dirInput.value = '';
    ui.dirInput.click();
  }

  async function confirmFolder(entries) {
    const totalSize = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.file.size || 0)), 0);
    const roots = Array.from(new Set(entries.map(entry => String(entry.relative).split('/')[0]).filter(Boolean)));
    const name = roots.length === 1 ? roots[0] : plural(roots.length, 'folder');
    const samples = entries.slice(0, 4).map(entry => `<li class="mono" title="${escapeHTML(entry.relative)}">${escapeHTML(entry.relative)}</li>`).join('');
    const more = entries.length > 4 ? `<li class="muted">and ${escapeHTML(plural(entries.length - 4, 'other file'))}</li>` : '';
    return BB.ui.confirm({
      title: 'Upload a folder',
      confirmLabel: `Upload ${plural(entries.length, 'file')}`,
      cancelLabel: 'Cancel',
      html: `<div class="uploadConfirm">
        <div class="uploadConfirm__what"><i class="ic ic-folder" aria-hidden="true"></i>
          <div><strong>${escapeHTML(name)}</strong><span class="muted">${escapeHTML(plural(entries.length, 'file'))}, ${escapeHTML(formatBytes(totalSize))}</span></div></div>
        <dl><dt>Into</dt><dd><strong>${escapeHTML(currentInstance()?.name || '')}</strong>${state.pathPrefix ? ` / <code>${escapeHTML(state.pathPrefix)}</code>` : ', root'}</dd></dl>
        <ul>${samples}${more}</ul>
        <p class="muted">A file with the same name is replaced.</p>
      </div>`
    });
  }

  function startUpload(entries) {
    if (!canWrite() || !entries.length) return;
    const instance = currentInstance();
    const prefix = state.pathPrefix;
    uploader().add(entries.map(entry => {
      const relative = cleanDroppedPath(entry.relative || entry.file.name);
      return { file: entry.file, relative, key: `${prefix}${relative}`.replace(/^\/+/, '') };
    }).filter(entry => entry.relative), { instanceId: instance.id, prefix, label: instance.name });
  }

  function onFileInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length) startUpload(files.map(file => ({ file, relative: file.name })));
  }

  async function onDirInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const entries = files.map(file => ({ file, relative: cleanDroppedPath(file.webkitRelativePath || file.name) }));
    if (await confirmFolder(entries)) startUpload(entries);
  }

  function onDragEnter(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!canWrite() || state.listError) return;
    state.dragDepth += 1;
    state.isDragActive = true;
    renderDropOverlay();
  }

  function onDragOver(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    const allowed = canWrite() && !state.listError;
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
    if (!allowed || state.isDragActive) return;
    state.isDragActive = true;
    renderDropOverlay();
  }

  function onDragLeave(event) {
    if (!state.isDragActive) return;
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    const outside = !event.relatedTarget || event.clientX <= 0 || event.clientY <= 0
      || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
    if (state.dragDepth === 0 || outside) {
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
    if (!canWrite() || state.listError) {
      BB.ui.toast('You cannot upload in this folder.', { status: 'error', duration: 4500 });
      return;
    }
    try {
      const entries = await droppedEntries(event.dataTransfer);
      if (!entries.length) {
        BB.ui.toast('The dropped selection has no file.', { status: 'error', duration: 4500 });
        return;
      }
      if (entries.some(entry => entry.relative.includes('/')) && !await confirmFolder(entries)) return;
      startUpload(entries);
    } catch (error) {
      BB.ui.toast(`The dropped files cannot be read: ${String(error?.message || error)}`, { status: 'error', duration: 6500 });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------------------------

  function bindElements() {
    for (const [name, id] of Object.entries({
      backLink: 'backLink', versionBadge: 'versionBadge', switcher: 'storageSwitcher', crumbs: 'crumbs',
      title: 'folderTitle', searchForm: 'searchForm', searchInput: 'searchInput',
      refreshButton: 'refreshButton', actionsButton: 'actionsButton', actionsMenu: 'actionsMenu', zipItem: 'zipItem',
      insightsItem: 'insightsItem', accessItem: 'accessItem', accessBadge: 'accessBadge', uploadWrap: 'uploadWrap',
      uploadButton: 'uploadButton', uploadMenu: 'uploadMenu', uploadFilesItem: 'uploadFilesItem',
      uploadFolderItem: 'uploadFolderItem', listing: 'listing', dropOverlay: 'dropOverlay', dropTarget: 'dropTarget',
      uploadDock: 'uploadDock', fileInput: 'fileInput', dirInput: 'dirInput'
    })) ui[name] = byId(id);
    ui.searchLabel = document.querySelector('label[for="searchInput"]');
  }

  function bindEvents() {
    ui.searchForm.addEventListener('submit', event => {
      event.preventDefault();
      searchByPrefix();
    });
    ui.refreshButton.addEventListener('click', manualRefresh);
    bindMenu(ui.actionsButton, ui.actionsMenu);
    bindMenu(ui.uploadButton, ui.uploadMenu);
    ui.zipItem.addEventListener('click', downloadAll);
    ui.insightsItem.addEventListener('click', () => { if (canRead()) BB.actions.showPrefixInsights(state.pathPrefix); });
    ui.accessItem.addEventListener('click', showPermissions);
    ui.uploadFilesItem.addEventListener('click', triggerUploadFiles);
    ui.uploadFolderItem.addEventListener('click', triggerUploadFolder);
    ui.fileInput.addEventListener('change', onFileInput);
    ui.dirInput.addEventListener('change', onDirInput);
    window.addEventListener('popstate', updateFromLocation);
    document.addEventListener('click', event => {
      if (openMenu && !openMenu.menu.contains(event.target) && !openMenu.trigger.contains(event.target)) closeMenu();
      if (ui.switcher && !ui.switcher.contains(event.target)) closeSwitcher(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeMenu({ focus: true });
        closeSwitcher(false);
      }
      // "/" puts the focus in the prefix field, as in ClickHouse Dash.
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey
        && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && !document.querySelector('.bb-overlay')) {
        event.preventDefault();
        ui.searchInput.focus();
      }
    });
    document.addEventListener('bb:retry', () => (state.instances.length ? manualRefresh() : initialize()));
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    document.addEventListener('contextmenu', onRowContextMenu);
  }

  bindElements();
  bindEvents();
  renderHeaderLinks();
  restoreVersion();
  update();
  initialize();

  // The page state, for the browser tests.
  BB.page = {
    get state() { return state; },
    refresh: () => refresh(),
    uploads: () => uploader()
  };
})();
