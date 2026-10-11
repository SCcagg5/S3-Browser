/* Shared runtime, capability and browser-state helpers. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const memoryState = new Map();

  const applicationRoot = new URL('.', document.baseURI);

  function encodeRouteSegment(value) {
    const text = String(value == null ? '' : value);
    const encoded = encodeURIComponent(text).replace(/[!'()*]/g, character =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return text === '' || text === '.' || text === '..' || text.startsWith('~')
      ? `~${encoded}`
      : encoded;
  }

  function decodeRouteSegment(value) {
    const raw = String(value == null ? '' : value);
    const encoded = raw.startsWith('~') ? raw.slice(1) : raw;
    return decodeURIComponent(encoded);
  }

  function encodeStoragePath(value, { prefix = false } = {}) {
    let text = String(value == null ? '' : value).replace(/^\/+/, '');
    if (prefix) text = text.replace(/\/+$/, '');
    if (!text) return '';
    return text.split('/').map(encodeRouteSegment).join('/');
  }

  function currentApplicationPath() {
    const current = new URL(window.location?.href || document.baseURI);
    const rootPath = applicationRoot.pathname.endsWith('/')
      ? applicationRoot.pathname
      : `${applicationRoot.pathname}/`;
    if (!current.pathname.startsWith(rootPath)) return '';
    return current.pathname.slice(rootPath.length);
  }

  function currentStorageRoute() {
    const relative = currentApplicationPath();
    if (!relative.startsWith('-/')) return null;
    const trailingSlash = relative.endsWith('/');
    const segments = relative.split('/');
    if (segments[0] !== '-' || !segments[1] || !segments[2]) return null;
    try {
      const host = decodeRouteSegment(segments[1]);
      const bucket = decodeRouteSegment(segments[2]);
      const pathSegments = segments.slice(3);
      if (trailingSlash) pathSegments.pop();
      const decoded = pathSegments.map(decodeRouteSegment).join('/');
      return {
        host,
        bucket,
        path: trailingSlash && decoded ? `${decoded}/` : decoded,
        view: trailingSlash ? 'browser' : 'preview'
      };
    } catch (_) {
      return null;
    }
  }

  function browserPageURL(host, bucket, prefix = '') {
    const hostID = encodeRouteSegment(host);
    const bucketID = encodeRouteSegment(bucket);
    const encoded = encodeStoragePath(prefix, { prefix: true });
    return resolveURL(`-/${hostID}/${bucketID}/${encoded ? `${encoded}/` : ''}`);
  }

  function previewPageURL(host, bucket, key = '') {
    const hostID = encodeRouteSegment(host);
    const bucketID = encodeRouteSegment(bucket);
    const encoded = encodeStoragePath(key);
    return resolveURL(`-/${hostID}/${bucketID}/${encoded}`);
  }

  function resolveURL(value = '') {
    if (value instanceof URL) return new URL(value.href);
    const text = String(value || '').trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return new URL(text);
    return new URL(text.replace(/^\/+/, ''), applicationRoot);
  }

  function resolvePath(value = '') {
    const url = resolveURL(value);
    return url.pathname + url.search + url.hash;
  }

  function runtimeConfig() {
    return (BB.cfg && BB.cfg.runtime) || {};
  }

  // English digit grouping and relative phrases, written out instead of using Intl: the first Intl formatter
  // built on a page loads the locale data (about 20ms of main-thread time), which would land inside the first
  // render of the listing. Output is identical to Intl.NumberFormat('en-US') and
  // Intl.RelativeTimeFormat('en', { numeric: 'auto' }) for the values the listing produces.
  function groupDigits(number) {
    return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  const RELATIVE_WORDS = {
    second: { 0: 'now' },
    minute: { 0: 'this minute' },
    hour: { 0: 'this hour' },
    day: { '-1': 'yesterday', 0: 'today', 1: 'tomorrow' },
    week: { '-1': 'last week', 0: 'this week', 1: 'next week' },
    month: { '-1': 'last month', 0: 'this month', 1: 'next month' },
    year: { '-1': 'last year', 0: 'this year', 1: 'next year' }
  };

  function formatRelativeTime(value, unit) {
    const word = RELATIVE_WORDS[unit] && RELATIVE_WORDS[unit][value];
    if (word) return word;
    const amount = Math.abs(value);
    const label = `${groupDigits(amount)} ${unit}${amount === 1 ? '' : 's'}`;
    return value < 0 ? `${label} ago` : `in ${label}`;
  }

  function formatDateTimeUTC(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }

  function readBrowserState(key) {
    const normalized = String(key || '');
    return normalized ? (memoryState.get(normalized) || '') : '';
  }

  function writeBrowserState(key, value) {
    const normalized = String(key || '');
    if (!normalized) return;
    const text = value == null ? '' : String(value);
    if (text) memoryState.set(normalized, text);
    else memoryState.delete(normalized);
  }

  function clearBrowserState() {
    memoryState.clear();
  }

  function normalizeState(value) {
    const state = value && typeof value === 'object' ? value : {};
    const explicit = String(state.state || '').toLowerCase();
    if (explicit === 'allowed' || explicit === 'denied' || explicit === 'unknown') return explicit;
    if (state.verified === true) return state.allowed === false ? 'denied' : 'allowed';
    if (state.allowed === false) return 'denied';
    return 'unknown';
  }

  function stateFor(source, name) {
    const object = source && typeof source === 'object' ? source : {};
    const operations = object.operations && typeof object.operations === 'object'
      ? object.operations
      : ((BB.cfg && BB.cfg.operations) || {});
    const capabilities = object.capabilities && typeof object.capabilities === 'object'
      ? object.capabilities
      : ((BB.cfg && BB.cfg.capabilities) || {});

    const operation = operations[name];
    if (operation) return operation;

    const aliases = {
      list: 'read', preview: 'read', download: 'read', details: 'read', insights: 'read',
      upload: 'write', overwrite: 'write', createFolder: 'write',
      delete: 'delete'
    };
    if (aliases[name] && capabilities[aliases[name]]) return capabilities[aliases[name]];

    const compose = keys => {
      const states = keys.map(key => capabilities[key]).filter(Boolean);
      if (states.some(item => normalizeState(item) === 'denied')) {
        return states.find(item => normalizeState(item) === 'denied');
      }
      if (states.length !== keys.length || states.some(item => normalizeState(item) === 'unknown')) {
        return { state: 'unknown', allowed: true, verified: false, source: 'derived' };
      }
      return { state: 'allowed', allowed: true, verified: true, source: 'derived' };
    };
    if (name === 'copy') return compose(['read', 'write']);
    if (name === 'move' || name === 'rename') return compose(['read', 'write', 'delete']);
    return { state: 'unknown', allowed: true, verified: false, source: 'application' };
  }

  function actionable(source, name) {
    return normalizeState(stateFor(source, name)) !== 'denied';
  }

  function stateLabel(value) {
    switch (normalizeState(value)) {
      case 'allowed': return 'Allowed';
      case 'denied': return 'Denied';
      default: return 'Checked on use';
    }
  }

  function stateClass(value) {
    return `is-${normalizeState(value)}`;
  }

  BB.runtime = {
    configure(runtime) {
      BB.cfg = BB.cfg || {};
      BB.cfg.runtime = { ...(BB.cfg.runtime || {}), ...(runtime || {}) };
      return BB.cfg.runtime;
    },
    config: runtimeConfig,
    readState: readBrowserState,
    writeState: writeBrowserState,
    clearBrowserState,
    rootURL: applicationRoot.href,
    resolveURL,
    resolvePath,
    encodeRouteSegment,
    encodeStoragePath,
    storageRoute: currentStorageRoute,
    browserPageURL,
    previewPageURL,
    formatDateTimeUTC,
    groupDigits,
    formatRelativeTime
  };

  BB.capabilities = {
    normalizeState,
    stateFor,
    actionable,
    stateLabel,
    stateClass
  };
})();
