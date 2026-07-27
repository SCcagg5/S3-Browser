/* Shared runtime, capability and browser-state helpers. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const memoryState = new Map();

  const applicationRoot = new URL('.', document.baseURI);

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
      default: return 'On use';
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
    formatDateTimeUTC
  };

  BB.capabilities = {
    normalizeState,
    stateFor,
    actionable,
    stateLabel,
    stateClass
  };
})();
