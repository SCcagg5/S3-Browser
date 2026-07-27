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

  const app = Vue.createApp({
    data() {
      return {
        config,
        instances: [],
        build: {},
        defaultInstanceId: '',
        instanceId: '',
        pathPrefix: '',
        searchPrefix: '',
        pathContentTableData: [],
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
        breadcrumbPopoverStyle: {},
        isDragActive: false,
        dragDepth: 0,
        versionCountRequest: 0
      };
    },

    computed: {
      cssVars() { return { '--primary-color': this.config.primaryColor }; },
      currentInstance() { return this.instances.find(instance => instance.id === this.instanceId) || null; },
      otherInstances() { return this.instances.filter(instance => instance.id !== this.instanceId); },
      capabilities() { return this.currentInstance?.capabilities || {}; },
      versioningSupported() { return this.currentInstance?.versioningSupported === true; },
      operations() { return this.currentInstance?.operations || {}; },
      canRead() { return this.can('list'); },
      canWrite() { return this.can('upload'); },
      canDelete() { return this.can('delete'); },
      canCopy() { return this.can('copy'); },
      canRename() { return this.can('rename'); },
      canDownloadAll() {
        return this.canRead && this.config.allowDownloadAll && this.pathContentTableData.length > 0;
      },
      orderedPathContentTableData() {
        const rows = Array.from(this.pathContentTableData || []);
        if (!this.navigationSortAvailable || !this.navigationSortField || !this.navigationSortDirection) return rows;
        const field = this.navigationSortField;
        const direction = this.navigationSortDirection === 'desc' ? -1 : 1;
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
      },
      localPageCount() { return Math.max(1, Math.ceil(this.orderedPathContentTableData.length / this.pageSize)); },
      visiblePathContentTableData() {
        const start = this.localPage * this.pageSize;
        return this.orderedPathContentTableData.slice(start, start + this.pageSize);
      },
      rangeStart() { return this.visiblePathContentTableData.length ? this.scanOffset + this.localPage * this.pageSize + 1 : 0; },
      rangeEnd() { return this.scanOffset + this.localPage * this.pageSize + this.visiblePathContentTableData.length; },
      hasRows() { return this.pathContentTableData.length > 0; },
      hasPreviousPage() { return this.localPage > 0 || this.previousContinuationTokens.length > 0; },
      hasNextPage() { return this.localPage + 1 < this.localPageCount || !!this.nextContinuationToken; },
      hasPagination() { return this.hasPreviousPage || this.hasNextPage; },
      breadcrumbs() {
        const parts = String(this.pathPrefix || '').replace(/\/+$/, '').split('/').filter(Boolean);
        let prefix = '';
        return parts.map(name => {
          prefix += name + '/';
          return { name, prefix };
        });
      },
      visibleBreadcrumbs() {
        if (!this.breadcrumbs.length) return [];
        const start = Math.max(0, Math.min(this.breadcrumbVisibleStart, this.breadcrumbs.length - 1));
        return this.breadcrumbs.slice(start);
      },
      hiddenBreadcrumbs() {
        if (!this.breadcrumbs.length) return [];
        const start = Math.max(0, Math.min(this.breadcrumbVisibleStart, this.breadcrumbs.length - 1));
        return this.breadcrumbs.slice(0, start);
      },
      permissionStates() {
        return this.permissionStatesFor(this.currentInstance);
      },
      permissionSummaryTitle() {
        return this.permissionStates
          .map(item => `${item.label}: ${this.capabilityLabel(item.state)}`)
          .join(' · ');
      },
      currentInsightsLabel() {
        return this.pathPrefix ? 'Folder insights' : 'Storage insights';
      }
    },

    watch: {
      pageSize() {
        this.config.pageSize = Number(this.pageSize) || 50;
        this.localPage = 0;
        this.$nextTick(() => this.refreshVisibleVersionCounts());
      },
      pathPrefix() {
        this.closeBreadcrumbOverflow();
        this.breadcrumbVisibleStart = Math.max(0, this.breadcrumbs.length - 1);
        this.$nextTick(() => this.scheduleBreadcrumbLayout());
      },
      instanceId() {
        this.closeBreadcrumbOverflow();
        this.$nextTick(() => this.scheduleBreadcrumbLayout());
      }
    },

    methods: {
      can(operation, instance = this.currentInstance) {
        if (BB.capabilities?.actionable) return BB.capabilities.actionable(instance, operation);
        const state = instance?.operations?.[operation];
        return state ? state.allowed !== false : true;
      },

      capabilityName(state) {
        return BB.capabilities?.normalizeState ? BB.capabilities.normalizeState(state) : (state?.allowed === false ? 'denied' : 'unknown');
      },

      capabilityLabel(state) {
        return BB.capabilities?.stateLabel ? BB.capabilities.stateLabel(state) : (state?.allowed === false ? 'Denied' : 'On use');
      },

      capabilityClass(state) {
        return BB.capabilities?.stateClass ? BB.capabilities.stateClass(state) : (state?.allowed === false ? 'is-denied' : 'is-unknown');
      },

      permissionStatesFor(instance) {
        const capabilities = instance?.capabilities || {};
        return [
          { key: 'read', label: 'Read', icon: 'eye-outline', state: capabilities.read || {} },
          { key: 'write', label: 'Write', icon: 'pencil-outline', state: capabilities.write || {} },
          { key: 'delete', label: 'Delete', icon: 'delete-outline', state: capabilities.delete || {} }
        ];
      },

      toggleBreadcrumbOverflow() {
        if (this.breadcrumbOverflowOpen) {
          this.closeBreadcrumbOverflow();
          return;
        }
        this.breadcrumbOverflowOpen = true;
        this.$nextTick(() => this.positionBreadcrumbOverflow());
      },

      closeBreadcrumbOverflow() {
        this.breadcrumbOverflowOpen = false;
        this.breadcrumbPopoverStyle = {};
      },

      openHiddenBreadcrumb(prefix) {
        this.closeBreadcrumbOverflow();
        this.goToPrefix(prefix);
      },

      positionBreadcrumbOverflow() {
        if (!this.breadcrumbOverflowOpen) return;
        const trigger = this.$refs.breadcrumbOverflowTrigger;
        const popover = this.$refs.breadcrumbOverflowPopover;
        if (!trigger || !popover) return;
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
        this.breadcrumbPopoverStyle = {
          position: 'fixed',
          left: `${Math.round(left)}px`,
          top: `${Math.round(top)}px`,
          width: `${Math.round(width)}px`,
          maxHeight: `${Math.max(120, Math.round(viewport.height - top - margin))}px`
        };
      },

      onBreadcrumbDocumentPointer(event) {
        if (!this.breadcrumbOverflowOpen) return;
        const trigger = this.$refs.breadcrumbOverflowTrigger;
        const popover = this.$refs.breadcrumbOverflowPopover;
        if (trigger?.contains(event.target) || popover?.contains(event.target)) return;
        this.closeBreadcrumbOverflow();
      },

      onBreadcrumbDocumentKeydown(event) {
        if (event.key === 'Escape') this.closeBreadcrumbOverflow();
      },

      scheduleBreadcrumbLayout() {
        window.cancelAnimationFrame(this.breadcrumbLayoutFrame || 0);
        this.breadcrumbLayoutFrame = window.requestAnimationFrame(() => {
          this.breadcrumbLayoutFrame = 0;
          this.measureBreadcrumbs();
        });
      },

      measureBreadcrumbs() {
        const crumbs = this.breadcrumbs;
        if (!crumbs.length) {
          this.breadcrumbVisibleStart = 0;
          return;
        }

        const line = this.$refs.breadcrumbLine;
        if (!line) return;
        const available = Math.floor((BB.viewport?.rect(line).width || line.clientWidth || 0));
        if (available <= 0) return;

        const style = window.getComputedStyle(line);
        const canvas = this._breadcrumbMeasureCanvas || (this._breadcrumbMeasureCanvas = document.createElement('canvas'));
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
        if (this.breadcrumbVisibleStart !== start) this.breadcrumbVisibleStart = start;
      },

      async initialize() {
        this.isInitializing = true;
        try {
          const response = await BB.api.instances();
          this.instances = response.instances || [];
          this.build = response.build || {};
          this.config.runtime = BB.runtime?.configure(response.runtime || {}) || (response.runtime || {});
          this.defaultInstanceId = response.default || this.instances[0]?.id || '';
          const route = BB.runtime?.storageRoute?.();
          const routeInstance = route?.view === 'browser' ? route.instance : '';
          const queryInstance = new URLSearchParams(location.search).get('instance');
          const storedInstance = BB.runtime?.readState('object-browser-instance') || '';
          const candidate = [routeInstance, queryInstance, storedInstance, this.defaultInstanceId]
            .find(id => id && this.instances.some(instance => instance.id === id));
          this.instanceId = candidate || this.instances[0]?.id || '';
          if (!this.instanceId) throw new Error('No storage instance is configured.');
          this.applyCurrentInstance();
          this.pathPrefix = routeInstance === this.instanceId
            ? normalizePrefix(route.path)
            : parseLegacyHash();
          this.searchPrefix = '';
          this.replaceBrowserLocation(this.pathPrefix);
          await this.refresh();
        } catch (error) {
          BB.ui.toast(String(error.message || error));
        } finally {
          this.isInitializing = false;
        }
      },

      browserLocation(prefix = '') {
        const url = new URL(BB.api.browserPageURL(prefix, { instance: this.instanceId }));
        return url.pathname + url.search + url.hash;
      },

      replaceBrowserLocation(prefix = '', { push = false } = {}) {
        const target = this.browserLocation(prefix);
        const current = location.pathname + location.search + location.hash;
        if (target === current) return;
        history[push ? 'pushState' : 'replaceState'](null, '', target);
      },

      applyCurrentInstance() {
        const instance = this.currentInstance;
        if (!instance) return;
        BB.api.setInstance(instance.id);
        this.config.capabilities = instance.capabilities || {};
        this.config.operations = instance.operations || {};
        this.config.versioningSupported = instance.versioningSupported === true;
        BB.runtime?.writeState('object-browser-instance', instance.id);
        document.title = `${instance.name} - Object Storage Browser`;
      },

      async changeInstance() {
        this.applyCurrentInstance();
        this.pathPrefix = '';
        this.searchPrefix = '';
        this.resetPagination();
        this.replaceBrowserLocation('', { push: true });
        await this.refresh();
      },

      async selectInstance(id) {
        if (!id || id === this.instanceId) return;
        this.instanceId = id;
        await this.changeInstance();
      },

      async showPermissionDetails() {
        const instance = this.currentInstance;
        if (!instance) return;
        const reportedPermissions = Array.from(instance.capabilities?.permissions || []).map(String);
        const providerPermissions = reportedPermissions.length ? reportedPermissions.join(', ') : 'Not reported';
        const permissionRows = this.permissionStates.map(item => {
          const state = item.state || {};
          const stateName = this.capabilityName(state);
          const result = stateName === 'allowed' ? 'Allowed' : (stateName === 'denied' ? 'Denied' : 'On use');
          const verification = stateName === 'unknown'
            ? 'The provider will verify this permission when the operation is used.'
            : (state.verified ? (stateName === 'allowed' ? 'Verified by a real provider operation.' : 'Denied by the provider.') : 'Defined by the connection configuration.');
          const explanation = String(state.reason || verification);
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
      },

      resetPagination() {
        this.previousContinuationTokens = [];
        this.continuationToken = '';
        this.nextContinuationToken = '';
        this.scanOffset = 0;
        this.localPage = 0;
        this.scanComplete = false;
        this.navigationSortAvailable = false;
        this.navigationSortField = '';
        this.navigationSortDirection = '';
      },

      navigationSortIcon(field) {
        if (!this.navigationSortAvailable) return '';
        if (this.navigationSortField !== field) return 'unfold-more-horizontal';
        return this.navigationSortDirection === 'desc' ? 'arrow-down' : 'arrow-up';
      },

      navigationSortAria(field) {
        if (!this.navigationSortAvailable || this.navigationSortField !== field) return 'none';
        return this.navigationSortDirection === 'desc' ? 'descending' : 'ascending';
      },

      toggleNavigationSort(field) {
        if (!this.navigationSortAvailable) return;
        const initialDirection = field === 'name' ? 'asc' : 'desc';
        const reverseDirection = initialDirection === 'desc' ? 'asc' : 'desc';
        if (this.navigationSortField !== field) {
          this.navigationSortField = field;
          this.navigationSortDirection = initialDirection;
        } else if (this.navigationSortDirection === initialDirection) {
          this.navigationSortDirection = reverseDirection;
        } else {
          this.navigationSortField = '';
          this.navigationSortDirection = '';
        }
        this.localPage = 0;
        this.$nextTick(() => this.refreshVisibleVersionCounts());
      },

      updatePathFromLocation() {
        const route = BB.runtime?.storageRoute?.();
        if (!route || route.view !== 'browser') return;
        const instance = this.instances.find(item => item.id === route.instance);
        if (!instance) return;
        const next = normalizePrefix(route.path);
        const instanceChanged = instance.id !== this.instanceId;
        if (!instanceChanged && next === this.pathPrefix) return;
        if (instanceChanged) {
          this.instanceId = instance.id;
          this.applyCurrentInstance();
        }
        this.pathPrefix = next;
        this.searchPrefix = '';
        this.resetPagination();
        if (!this.isInitializing) this.refresh();
      },

      goToPrefix(prefix) {
        this.closeBreadcrumbOverflow();
        const normalized = normalizePrefix(prefix);
        if (normalized === this.pathPrefix) {
          this.resetPagination();
          this.refresh();
          return;
        }
        this.pathPrefix = normalized;
        this.searchPrefix = '';
        this.resetPagination();
        this.replaceBrowserLocation(normalized, { push: true });
        this.refresh();
      },

      searchByPrefix() {
        const value = String(this.searchPrefix || '').trim();
        if (!value) {
          this.refresh();
          return;
        }
        this.goToPrefix(normalizePrefix(this.pathPrefix + value));
      },

      manualRefresh() {
        this.resetPagination();
        this.refresh();
      },

      async nextPage() {
        if (this.localPage + 1 < this.localPageCount) {
          this.localPage += 1;
          this.$nextTick(() => this.refreshVisibleVersionCounts());
          return;
        }
        if (!this.nextContinuationToken) return;
        this.previousContinuationTokens.push({ token: this.continuationToken || '', offset: this.scanOffset });
        this.scanOffset += this.pathContentTableData.length;
        this.continuationToken = this.nextContinuationToken;
        this.localPage = 0;
        await this.refresh();
      },

      async previousPage() {
        if (this.localPage > 0) {
          this.localPage -= 1;
          this.$nextTick(() => this.refreshVisibleVersionCounts());
          return;
        }
        if (!this.previousContinuationTokens.length) return;
        const previous = this.previousContinuationTokens.pop();
        this.continuationToken = previous?.token || '';
        this.scanOffset = Number(previous?.offset || 0);
        await this.refresh();
        this.localPage = Math.max(0, this.localPageCount - 1);
      },

      async refresh() {
        if (this.isRefreshing || !this.currentInstance) return;
        this.isRefreshing = true;
        try {
          if (!this.canRead) {
            this.pathContentTableData = [];
            this.nextContinuationToken = '';
            return;
          }
          const data = await BB.api.list({
            prefix: this.pathPrefix,
            delimiter: '/',
            continuationToken: this.continuationToken
          });
          this.nextContinuationToken = data.nextContinuationToken || '';
          this.scanComplete = data.scanComplete === true;
          this.navigationSortAvailable = data.sortAvailable === true;
          if (!this.navigationSortAvailable) {
            this.navigationSortField = '';
            this.navigationSortDirection = '';
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
            return !this.config.keyExcludePatterns.some(pattern => pattern.test(String(key || '')));
          });
          this.pathContentTableData = rows;
          this.localPage = Math.max(0, Math.min(this.localPage, Math.max(0, Math.ceil(rows.length / this.pageSize) - 1)));
          this.$nextTick(() => this.refreshVisibleVersionCounts());
        } catch (error) {
          this.pathContentTableData = [];
          BB.ui.toast(String(error.message || error));
        } finally {
          this.isRefreshing = false;
        }
      },

      async refreshVisibleVersionCounts() {
        const requestID = ++this.versionCountRequest;
        if (!this.versioningSupported || !this.canRead) {
          for (const row of this.pathContentTableData) if (row.type === 'content') row.versionCount = null;
          return;
        }
        const instanceID = this.instanceId;
        const keys = this.visiblePathContentTableData.filter(row => row.type === 'content' && row.key).map(row => row.key);
        if (!keys.length) return;
        try {
          const response = await BB.api.versionCounts(keys, instanceID);
          if (requestID !== this.versionCountRequest || instanceID !== this.instanceId) return;
          const counts = response?.counts || {};
          for (const row of this.pathContentTableData) {
            if (row.type !== 'content' || !Object.prototype.hasOwnProperty.call(counts, row.key)) continue;
            row.versionCount = Number(counts[row.key]?.count || 0);
          }
        } catch (error) {
          if (Number(error?.status || 0) === 501) return;
          console.warn('Unable to load object version counts', error);
        }
      },

      fileRowIcon(row) {
        return BB.detect.iconForType(BB.detect.resolveType(row.name || '', row.contentType || ''));
      },

      openPreview(row) {
        if (!this.canRead) return;
        window.location.href = BB.api.previewPageURL(row.key, { instance: this.instanceId });
      },

      onRowMetadata(row) { BB.actions.showMetadata(row.key, { size: row.size, mime: row.contentType, etag: row.etag, lastModified: row.dateModified?.toUTCString?.() || '' }); },
      onRowDownload(row) { BB.actions.downloadObject(row.key, row.name); },
      onRowVersions(row) { BB.actions.showVersions(row.key); },
      async onRowCopy(row) { if (await BB.actions.copyObject(row.key)) await this.refresh(); },
      async onRowRename(row) { if (await BB.actions.renameObject(row.key)) await this.refresh(); },
      async onRowDelete(row) { if (await BB.actions.deleteObject(row.key)) await this.refresh(); },
      onPrefixInsights(row) { BB.actions.showPrefixInsights(row.prefix); },
      async onPrefixCopy(row) { if (await BB.actions.copyPrefix(row.prefix)) await this.refresh(); },
      async onPrefixRename(row) { if (await BB.actions.renamePrefix(row.prefix)) await this.refresh(); },
      async onPrefixDelete(row) { if (await BB.actions.deletePrefix(row.prefix)) await this.refresh(); },
      onCurrentInsights() { BB.actions.showPrefixInsights(this.pathPrefix); },

      onRowContextMenu(event) {
        const row = event.target?.closest?.('.browser-card tbody tr');
        if (!row) return;
        const menu = row.querySelector('.bb-menu');
        if (!menu || !BB.menu?.openAt) return;
        event.preventDefault();
        event.stopPropagation();
        BB.menu.openAt(menu, event.clientX, event.clientY);
      },

      onDragEnter(event) {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (!this.canWrite) return;
        this.dragDepth++;
        this.isDragActive = true;
      },

      onDragOver(event) {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = this.canWrite ? 'copy' : 'none';
        if (!this.canWrite) return;
        this.isDragActive = true;
      },

      onDragLeave(event) {
        if (!this.isDragActive) return;
        event.preventDefault();
        this.dragDepth = Math.max(0, this.dragDepth - 1);
        const leftWindow = !event.relatedTarget || event.clientX <= 0 || event.clientY <= 0 ||
          event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
        if (this.dragDepth === 0 || leftWindow) {
          this.dragDepth = 0;
          this.isDragActive = false;
        }
      },

      async onDrop(event) {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        this.dragDepth = 0;
        this.isDragActive = false;
        if (!this.canWrite) {
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
          if (containsFolder && !await this.confirmFolderUpload(entries)) return;
          await this.uploadResolvedFiles(entries);
        } catch (error) {
          BB.ui.toast(`Unable to read dropped files: ${String(error.message || error)}`, { status: 'error', duration: 6500 });
        }
      },

      triggerUpload() {
        if (!this.canWrite) return;
        const input = this.$refs.fileInput;
        input.value = '';
        input.click();
      },

      triggerUploadDir() {
        if (!this.canWrite) return;
        const input = this.$refs.dirInput;
        input.value = '';
        input.click();
      },

      async showUploadSelectionError(title, message) {
        await BB.ui.alert({
          title,
          html: `<div class="bb-upload-selection-error">
            <i class="mdi mdi-alert-circle-outline"></i>
            <div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(message)}</p></div>
          </div>`
        });
      },

      async onFileInput(event) {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!files.length) return;
        if (files.some(file => cleanDroppedPath(file.webkitRelativePath || '').includes('/'))) {
          await this.showUploadSelectionError('Files expected', 'Use “Upload folder” when the selected items include a directory hierarchy.');
          return;
        }
        await this.uploadFiles(files, file => file.name);
      },

      async onDirInput(event) {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!files.length) return;
        const hasDirectoryPath = files.some(file => cleanDroppedPath(file.webkitRelativePath || '').includes('/'));
        if (!hasDirectoryPath) {
          await this.showUploadSelectionError('Folder expected', 'Use “Upload files” for individual files, or select a folder containing the files to upload.');
          return;
        }
        const entries = files.map(file => ({
          file,
          relative: cleanDroppedPath(file.webkitRelativePath || file.name)
        }));
        if (await this.confirmFolderUpload(entries)) await this.uploadResolvedFiles(entries);
      },

      async confirmFolderUpload(entries, selectedName = '') {
        const files = Array.from(entries || []).filter(entry => entry?.file && entry.relative);
        if (!files.length) return false;
        const totalSize = files.reduce((sum, entry) => sum + Math.max(0, Number(entry.file.size || 0)), 0);
        const roots = Array.from(new Set(files.map(entry => String(entry.relative).split('/')[0]).filter(Boolean)));
        const folderName = selectedName || (roots.length === 1 ? roots[0] : `${roots.length} top-level folders`);
        const destination = `/${this.pathPrefix || ''}`;
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
              <span>${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'} · ${escapeHTML(this.formatBytes(totalSize))}</span>
            </div>
            <div class="bb-upload-confirmation-destination">
              <small>Destination</small>
              <code>${escapeHTML(destination)}</code>
            </div>
            <ul class="bb-upload-confirmation-files">${samples}${remaining ? `<li>+ ${remaining.toLocaleString()} more file${remaining === 1 ? '' : 's'}</li>` : ''}</ul>
          </div>`
        });
      },

      async uploadFiles(files, keyResolver) {
        const resolved = Array.from(files || []).map(file => ({
          file,
          relative: cleanDroppedPath(keyResolver(file))
        }));
        return this.uploadResolvedFiles(resolved);
      },

      async uploadResolvedFiles(uploadEntries) {
        if (!this.canWrite || !uploadEntries.length) return;
        const instanceId = this.instanceId;
        const basePrefix = this.pathPrefix;
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
        getUploadManager(this).add(entries);
      },

      async downloadAllFiles() {
        if (!this.canDownloadAll) return false;
        const basePrefix = this.pathPrefix;
        const archiveName = `${basePrefix.split('/').filter(Boolean).pop() || this.currentInstance.name || 'archive'}.zip`;
        return this.downloadArchive({
          archiveName,
          basePrefix,
          instanceId: this.instanceId
        });
      },

      async onPrefixDownload(row) {
        if (!this.canRead || !row?.prefix) return false;
        const prefix = normalizePrefix(row.prefix);
        const folderName = prefix.split('/').filter(Boolean).pop() || 'folder';
        return this.downloadArchive({
          archiveName: `${folderName}.zip`,
          basePrefix: prefix,
          instanceId: this.instanceId
        });
      },

      async downloadArchive({ archiveName, basePrefix = '', instanceId = '' }) {
        if (!this.canRead) return false;
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
      },

      formatByteParts(size) {
        const value = Math.max(0, Number(size) || 0);
        if (value < 1024) return { value: Math.round(value).toLocaleString('en-US'), unit: 'B' };
        if (value < 1024 ** 2) return { value: Math.round(value / 1024).toLocaleString('en-US'), unit: 'KB' };
        if (value < 1024 ** 3) return { value: (value / 1024 ** 2).toFixed(2), unit: 'MB' };
        if (value < 1024 ** 4) return { value: (value / 1024 ** 3).toFixed(2), unit: 'GB' };
        return { value: (value / 1024 ** 4).toFixed(2), unit: 'TB' };
      },
      formatBytes(size) {
        const parts = this.formatByteParts(size);
        return `${parts.value} ${parts.unit}`;
      },
      formatDateTime_relative(date) {
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
      },
      formatDateTime_utc(date) {
        return BB.runtime.formatDateTimeUTC(date);
      },
      formatDateTime_absolute(date) {
        return BB.runtime.formatDateTimeUTC(date);
      },
      formatDateTime_display(date) {
        return this.modifiedTimeMode === 'absolute'
          ? this.formatDateTime_absolute(date)
          : this.formatDateTime_relative(date);
      },
      toggleModifiedTimeMode() {
        this.modifiedTimeMode = this.modifiedTimeMode === 'relative' ? 'absolute' : 'relative';
      }
    },

    mounted() {
      this.onPopState = () => this.updatePathFromLocation();
      this.onResize = () => {
        this.scheduleBreadcrumbLayout();
        if (this.breadcrumbOverflowOpen) this.$nextTick(() => this.positionBreadcrumbOverflow());
      };
      this.onDocumentPointer = event => this.onBreadcrumbDocumentPointer(event);
      this.onDocumentKeydown = event => this.onBreadcrumbDocumentKeydown(event);
      this.onWindowScroll = () => {
        if (this.breadcrumbOverflowOpen) this.positionBreadcrumbOverflow();
      };
      this.onWindowDragEnter = event => this.onDragEnter(event);
      this.onWindowDragOver = event => this.onDragOver(event);
      this.onWindowDragLeave = event => this.onDragLeave(event);
      this.onWindowDrop = event => this.onDrop(event);
      this.onContextMenu = event => this.onRowContextMenu(event);
      window.addEventListener('popstate', this.onPopState);
      window.addEventListener('resize', this.onResize);
      window.addEventListener('scroll', this.onWindowScroll, true);
      document.addEventListener('pointerdown', this.onDocumentPointer);
      document.addEventListener('keydown', this.onDocumentKeydown);
      window.addEventListener('dragenter', this.onWindowDragEnter);
      window.addEventListener('dragover', this.onWindowDragOver);
      window.addEventListener('dragleave', this.onWindowDragLeave);
      window.addEventListener('drop', this.onWindowDrop);
      document.addEventListener('contextmenu', this.onContextMenu);
      this.$nextTick(() => {
        if ('ResizeObserver' in window && this.$refs.breadcrumbRegion) {
          this.breadcrumbResizeObserver = new ResizeObserver(() => this.scheduleBreadcrumbLayout());
          this.breadcrumbResizeObserver.observe(this.$refs.breadcrumbRegion);
        }
        this.scheduleBreadcrumbLayout();
      });
      this.initialize();
    },

    beforeUnmount() {
      window.removeEventListener('popstate', this.onPopState);
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('scroll', this.onWindowScroll, true);
      document.removeEventListener('pointerdown', this.onDocumentPointer);
      document.removeEventListener('keydown', this.onDocumentKeydown);
      window.removeEventListener('dragenter', this.onWindowDragEnter);
      window.removeEventListener('dragover', this.onWindowDragOver);
      window.removeEventListener('dragleave', this.onWindowDragLeave);
      window.removeEventListener('drop', this.onWindowDrop);
      document.removeEventListener('contextmenu', this.onContextMenu);
      this.breadcrumbResizeObserver?.disconnect();
      window.cancelAnimationFrame(this.breadcrumbLayoutFrame || 0);
    }
  });

  app.use(Buefy.default, { defaultIconPack: 'mdi' });
  app.mount('#root');
})();
