const config = {
  primaryColor: '#167df0',
  pageSize: 50,
  allowDownloadAll: true,
  keyExcludePatterns: [/^index\.html$/],
  instanceId: '',
  capabilities: {},
  trashPrefix: '_trash/'
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

  function hashValue(value) {
    return encodeURIComponent(value || '').replace(/%2F/gi, '/');
  }

  function parentPrefix(value) {
    const key = String(value || '');
    const slash = key.lastIndexOf('/');
    return slash < 0 ? '' : key.slice(0, slash + 1);
  }

  function subtitleMatchesVideo(videoKey, candidateKey) {
    if (!/\.(?:vtt|srt)$/i.test(candidateKey) || parentPrefix(videoKey) !== parentPrefix(candidateKey)) return false;
    const descriptor = BB.detect.videoVariantDescriptor(videoKey);
    const name = String(candidateKey || '').split('/').pop() || '';
    const stem = name.replace(/\.(?:vtt|srt)$/i, '').toLowerCase();
    const base = descriptor.baseStem.toLowerCase();
    return stem === base || stem.startsWith(`${base}.`) || stem.startsWith(`${base}-`) ||
      stem.startsWith(`${base}_`) || stem.startsWith(`${base} `);
  }

  function parseHash() {
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

  function readLegacyDirectoryBatch(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  function readLegacyFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  async function walkLegacyEntry(entry, parent, output) {
    if (!entry) return;
    const relative = cleanDroppedPath(parent ? `${parent}/${entry.name}` : entry.name);
    if (entry.isFile) {
      output.push({ file: await readLegacyFile(entry), relative });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await readLegacyDirectoryBatch(reader);
      if (!batch.length) break;
      for (const child of batch) await walkLegacyEntry(child, relative, output);
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
          await walkLegacyEntry(entry, '', output);
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

  function safeArchivePath(key, basePrefix = '') {
    const rawKey = String(key || '');
    const rawPrefix = String(basePrefix || '');
    const relative = rawPrefix && rawKey.startsWith(rawPrefix) ? rawKey.slice(rawPrefix.length) : rawKey;
    return cleanDroppedPath(relative) || 'object';
  }

  function uniqueArchivePath(path, usedPaths) {
    const clean = safeArchivePath(path);
    if (!usedPaths.has(clean)) {
      usedPaths.add(clean);
      return clean;
    }
    const slash = clean.lastIndexOf('/');
    const directory = slash >= 0 ? clean.slice(0, slash + 1) : '';
    const filename = slash >= 0 ? clean.slice(slash + 1) : clean;
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : '';
    let index = 2;
    for (;;) {
      const candidate = `${directory}${stem} (${index})${extension}`;
      if (!usedPaths.has(candidate)) {
        usedPaths.add(candidate);
        return candidate;
      }
      index++;
    }
  }


  let uploadManager = null;
  let uploadSequence = 0;
  let archiveSequence = 0;

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
        if (entry.uploadId) {
          try { await BB.api.cancelUpload(entry.uploadId); }
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
            entry.uploadId = String(upload?.id || '');
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
            if (entry.uploadId) {
              try { await BB.api.cancelUpload(entry.uploadId); }
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
          uploadId: '',
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
        defaultInstanceId: '',
        instanceId: '',
        pathPrefix: '',
        searchPrefix: '',
        pathContentTableData: [],
        previousContinuationTokens: [],
        continuationToken: '',
        nextContinuationToken: '',
        isRefreshing: false,
        isInitializing: true,
        pageSize: config.pageSize,
        breadcrumbVisibleStart: 0,
        breadcrumbLayoutFrame: 0,
        breadcrumbOverflowOpen: false,
        breadcrumbPopoverStyle: {},
        isDragActive: false,
        dragDepth: 0
      };
    },

    computed: {
      cssVars() { return { '--primary-color': this.config.primaryColor }; },
      currentInstance() { return this.instances.find(instance => instance.id === this.instanceId) || null; },
      otherInstances() { return this.instances.filter(instance => instance.id !== this.instanceId); },
      capabilities() { return this.currentInstance?.capabilities || {}; },
      canRead() { return !!this.capabilities.read?.allowed; },
      canWrite() { return !!this.capabilities.write?.allowed; },
      canDelete() { return !!this.capabilities.delete?.allowed; },
      canCopy() { return this.canRead && this.canWrite; },
      canRename() { return this.canRead && this.canWrite && this.canDelete; },
      canDownloadAll() {
        return this.canRead && this.config.allowDownloadAll && this.pathContentTableData.length > 0;
      },
      currentPage() { return this.previousContinuationTokens.length + 1; },
      rangeStart() { return this.pathContentTableData.length ? (this.currentPage - 1) * this.pageSize + 1 : 0; },
      rangeEnd() { return (this.currentPage - 1) * this.pageSize + this.pathContentTableData.length; },
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
          .map(item => `${item.label}: ${item.state.allowed ? 'allowed' : 'denied'}`)
          .join(' · ');
      }
    },

    watch: {
      pageSize() {
        this.config.pageSize = Number(this.pageSize) || 50;
        this.resetPagination();
        if (!this.isInitializing) this.refresh();
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
        const triggerRect = trigger.getBoundingClientRect();
        const maxWidth = Math.max(220, Math.min(380, window.innerWidth - margin * 2));
        popover.style.width = `${maxWidth}px`;
        popover.style.maxWidth = `${window.innerWidth - margin * 2}px`;
        const popoverRect = popover.getBoundingClientRect();
        const width = Math.min(maxWidth, Math.max(220, popoverRect.width || maxWidth));
        const height = Math.min(popoverRect.height || 320, Math.max(120, window.innerHeight - margin * 2));
        const left = Math.max(margin, Math.min(triggerRect.left, window.innerWidth - width - margin));
        const below = triggerRect.bottom + 6;
        const above = triggerRect.top - height - 6;
        const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, above);
        this.breadcrumbPopoverStyle = {
          position: 'fixed',
          left: `${Math.round(left)}px`,
          top: `${Math.round(top)}px`,
          width: `${Math.round(width)}px`,
          maxHeight: `${Math.max(120, Math.round(window.innerHeight - top - margin))}px`
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
        const available = Math.floor(line.getBoundingClientRect().width || line.clientWidth || 0);
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
          this.defaultInstanceId = response.default || this.instances[0]?.id || '';
          const queryInstance = new URLSearchParams(location.search).get('instance');
          const storedInstance = localStorage.getItem('object-browser-instance');
          const candidate = [queryInstance, storedInstance, this.defaultInstanceId]
            .find(id => id && this.instances.some(instance => instance.id === id));
          this.instanceId = candidate || this.instances[0]?.id || '';
          if (!this.instanceId) throw new Error('No storage instance is configured.');
          this.applyCurrentInstance();
          this.pathPrefix = parseHash();
          this.searchPrefix = '';
          await this.refresh();
        } catch (error) {
          BB.ui.toast(String(error.message || error));
        } finally {
          this.isInitializing = false;
        }
      },

      applyCurrentInstance() {
        const instance = this.currentInstance;
        if (!instance) return;
        BB.api.setInstance(instance.id);
        this.config.capabilities = instance.capabilities || {};
        this.config.trashPrefix = instance.trashPrefix || '';
        localStorage.setItem('object-browser-instance', instance.id);
        const url = new URL(location.href);
        url.searchParams.set('instance', instance.id);
        history.replaceState(null, '', url.pathname + url.search + url.hash);
        document.title = `${instance.name} — Object Storage Browser`;
      },

      async changeInstance() {
        this.applyCurrentInstance();
        this.pathPrefix = '';
        this.searchPrefix = '';
        this.resetPagination();
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
        await this.refresh();
      },

      async selectInstance(id) {
        if (!id || id === this.instanceId) return;
        this.instanceId = id;
        await this.changeInstance();
      },

      async showPermissionDetails(permissionKey) {
        const instance = this.currentInstance;
        if (!instance) return;
        const item = this.permissionStates.find(candidate => candidate.key === permissionKey) || this.permissionStates[0];
        if (!item) return;
        const state = item.state || {};
        const allowed = state.allowed ? 'Allowed' : 'Denied';
        const verification = state.verified ? 'Verified by the provider' : 'Declared or not independently verified';
        const providerPermissions = (instance.capabilities?.permissions || [])
          .map(value => `<code>${escapeHTML(value)}</code>`)
          .join(', ') || 'None reported';
        await BB.ui.alert({
          html: `<div class="bb-details bb-permission-details">
            <div class="bb-details-head">
              <i class="mdi mdi-${escapeHTML(item.icon)}"></i>
              <div class="bb-details-titles">
                <div class="bb-details-name">${escapeHTML(item.label)} access</div>
                <div class="bb-details-prefix">${escapeHTML(instance.name)} · ${escapeHTML(instance.bucket)}</div>
              </div>
              <span class="bb-permission-result ${state.allowed ? 'is-allowed' : 'is-denied'}">${escapeHTML(allowed)}</span>
            </div>
            <div class="bb-details-body">
              <div class="bb-section bb-kv">
                <div class="kv-row"><div class="kv-k">Verification</div><div class="kv-v">${escapeHTML(verification)}</div></div>
                <div class="kv-row"><div class="kv-k">Source</div><div class="kv-v">${escapeHTML(state.source || 'configuration')}</div></div>
                ${state.reason ? `<div class="kv-row"><div class="kv-k">Reason</div><div class="kv-v">${escapeHTML(state.reason)}</div></div>` : ''}
                <div class="kv-row"><div class="kv-k">Provider permissions</div><div class="kv-v mono">${providerPermissions}</div></div>
                ${instance.capabilities?.error ? `<div class="kv-row"><div class="kv-k">Discovery error</div><div class="kv-v">${escapeHTML(instance.capabilities.error)}</div></div>` : ''}
              </div>
            </div>
          </div>`
        });
      },

      resetPagination() {
        this.previousContinuationTokens = [];
        this.continuationToken = '';
        this.nextContinuationToken = '';
      },

      updatePathFromHash() {
        const next = parseHash();
        if (next === this.pathPrefix) return;
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
        location.hash = hashValue(normalized);
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
        if (!this.nextContinuationToken) return;
        this.previousContinuationTokens.push(this.continuationToken || '');
        this.continuationToken = this.nextContinuationToken;
        await this.refresh();
      },

      async previousPage() {
        if (!this.previousContinuationTokens.length) return;
        this.continuationToken = this.previousContinuationTokens.pop() || '';
        await this.refresh();
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
            max: this.pageSize,
            continuationToken: this.continuationToken,
            exclude: this.currentInstance.trashPrefix || ''
          });
          this.nextContinuationToken = data.nextContinuationToken || '';
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
              url: BB.api.urlForKey(item.key)
            };
          }).filter(row => {
            const key = row.type === 'prefix' ? row.prefix : row.key;
            return !this.config.keyExcludePatterns.some(pattern => pattern.test(String(key || '')));
          });
          this.pathContentTableData = rows;
        } catch (error) {
          this.pathContentTableData = [];
          BB.ui.toast(String(error.message || error));
        } finally {
          this.isRefreshing = false;
        }
      },

      fileRowIcon(row) {
        return BB.detect.iconForType(BB.detect.resolveType(row.name || '', row.contentType || ''));
      },

      openPreview(row) {
        if (!this.canRead) return;
        const url = new URL('preview.html', window.location.href);
        url.searchParams.set('instance', this.instanceId);
        url.searchParams.set('listed', '1');
        url.searchParams.set('size', String(Math.max(0, Number(row.size || 0))));
        if (row.contentType) url.searchParams.set('mime', row.contentType);
        if (row.etag) url.searchParams.set('etag', row.etag);
        if (row.dateModified) url.searchParams.set('lastModified', row.dateModified.toUTCString());
        if (BB.detect.resolveType(row.name || row.key || '', row.contentType || '') === 'video') {
          const descriptor = BB.detect.videoVariantDescriptor(row.key);
          const related = this.pathContentTableData
            .filter(candidate => candidate.type === 'content' && candidate.key && candidate.key !== row.key)
            .filter(candidate => {
              if (subtitleMatchesVideo(row.key, candidate.key)) return true;
              if (parentPrefix(candidate.key) !== parentPrefix(row.key)) return false;
              if (BB.detect.resolveType(candidate.name || candidate.key, candidate.contentType || '') !== 'video') return false;
              return BB.detect.videoVariantDescriptor(candidate.key).group === descriptor.group;
            })
            .slice(0, 32);
          for (const candidate of related) url.searchParams.append('related', candidate.key);
        }
        url.hash = hashValue(row.key);
        window.location.href = url.pathname + url.search + url.hash;
      },

      onRowMetadata(row) { BB.actions.showMetadata(row.key, { size: row.size, mime: row.contentType, etag: row.etag, lastModified: row.dateModified?.toUTCString?.() || '' }); },
      onRowDownload(row) { BB.actions.downloadObject(row.key, row.name); },
      async onRowCopy(row) { if (await BB.actions.copyObject(row.key)) await this.refresh(); },
      async onRowRename(row) { if (await BB.actions.renameObject(row.key)) await this.refresh(); },
      async onRowDelete(row) { if (await BB.actions.deleteObject(row.key)) await this.refresh(); },
      onPrefixDetails(row) { BB.actions.showPrefixDetails(row.prefix); },
      async onPrefixCopy(row) { if (await BB.actions.copyPrefix(row.prefix)) await this.refresh(); },
      async onPrefixRename(row) { if (await BB.actions.renamePrefix(row.prefix)) await this.refresh(); },
      async onPrefixDelete(row) { if (await BB.actions.deletePrefix(row.prefix)) await this.refresh(); },
      onCurrentFolderDetails() { BB.actions.showPrefixDetails(this.pathPrefix); },
      showJobs() { BB.actions.showJobs(); },

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
        if (!this.canDownloadAll) return;
        const instanceId = this.instanceId;
        const basePrefix = this.pathPrefix;
        const archiveName = `${basePrefix.split('/').filter(Boolean).pop() || this.currentInstance.name || 'archive'}.zip`;
        return this.downloadArchive({
          archiveName,
          basePrefix,
          instanceId,
          resolveFiles: async ({ signal, onScan }) => BB.api.listAllItems(basePrefix, {
            instance: instanceId,
            signal,
            onPage(state) { onScan(state); }
          })
        });
      },

      async onPrefixDownload(row) {
        if (!this.canRead || !row?.prefix) return false;
        const prefix = normalizePrefix(row.prefix);
        const instanceId = this.instanceId;
        const folderName = prefix.split('/').filter(Boolean).pop() || 'folder';
        return this.downloadArchive({
          archiveName: `${folderName}.zip`,
          basePrefix: prefix,
          instanceId,
          resolveFiles: async ({ signal, onScan }) => BB.api.listAllItems(prefix, {
            instance: instanceId,
            signal,
            onPage(state) { onScan(state); }
          })
        });
      },

      async downloadArchive({ archiveName, basePrefix = '', instanceId = '', resolveFiles }) {
        if (!this.canRead || !window.fflate?.zip || typeof resolveFiles !== 'function') return false;
        const target = await BB.actions.pickSaveTarget(archiveName);
        if (target.canceled) return false;

        const group = BB.ui.transferGroup('download');
        const id = `archive-${Date.now().toString(36)}-${++archiveSequence}`;
        let controller = null;
        let running = false;
        let pauseRequested = false;
        let cancelRequested = false;
        let settled = false;
        let files = null;
        let currentIndex = 0;
        let currentResumeState = null;
        let totalBytes = 0;
        const receivedByFile = new Map();
        const archiveInput = {};
        let resolveCompletion;
        const completion = new Promise(resolve => { resolveCompletion = resolve; });

        const item = group.add({
          id,
          name: archiveName,
          status: 'preparing',
          progress: null,
          indeterminate: true,
          detail: 'Scanning objects...',
          onPause: pause,
          onResume: resume,
          onCancel: cancel
        });

        function finish(value) {
          if (settled) return;
          settled = true;
          resolveCompletion(value);
        }

        function receivedBytes() {
          return Array.from(receivedByFile.values()).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
        }

        function sourceProgress() {
          if (!files) return null;
          const received = receivedBytes();
          if (totalBytes > 0) return Math.min(1, received / totalBytes);
          return files.length ? Math.min(1, currentIndex / files.length) : 1;
        }

        function transferDetail(progress = {}, suffix = '') {
          return BB.actions.formatTransferDetail({
            ...progress,
            transferredBytes: receivedBytes(),
            totalBytes
          }, suffix);
        }

        function pause() {
          if (settled || !running || pauseRequested) return;
          pauseRequested = true;
          cancelRequested = false;
          item.update({
            status: 'preparing',
            progress: sourceProgress() == null ? null : sourceProgress() * 0.9,
            indeterminate: sourceProgress() == null,
            detail: 'Pausing archive download...',
            onPause: pause,
            onResume: resume,
            onCancel: cancel
          });
          controller?.abort();
        }

        function resume() {
          if (settled || running) return;
          pauseRequested = false;
          cancelRequested = false;
          void run();
        }

        function cancel() {
          if (settled || cancelRequested) return;
          cancelRequested = true;
          pauseRequested = false;
          if (running) {
            item.update({
              status: 'preparing',
              progress: sourceProgress() == null ? null : sourceProgress() * 0.9,
              indeterminate: sourceProgress() == null,
              detail: 'Canceling archive download...',
              onPause: null,
              onResume: null,
              onCancel: cancel
            });
            controller?.abort();
          } else {
            item.canceled({ detail: archiveName });
            finish(false);
          }
        }

        async function run() {
          if (running || settled) return;
          running = true;
          controller = new AbortController();
          const activeController = controller;
          item.update({
            status: 'running',
            progress: sourceProgress() == null ? null : sourceProgress() * 0.9,
            indeterminate: sourceProgress() == null,
            detail: files ? 'Resuming archive download...' : 'Scanning objects...',
            onPause: pause,
            onResume: resume,
            onCancel: cancel
          });

          try {
            if (!files) {
              const sourceItems = await resolveFiles({
                signal: activeController.signal,
                onScan: state => {
                  const count = Number(state?.count || state?.itemsCount || 0);
                  item.update({
                    status: 'running',
                    progress: null,
                    indeterminate: true,
                    detail: `${count.toLocaleString()} object(s) discovered`,
                    onPause: pause,
                    onResume: resume,
                    onCancel: cancel
                  });
                }
              });
              if (activeController.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

              const usedPaths = new Set();
              files = Array.from(sourceItems || [])
                .filter(source => source?.key && source.key !== basePrefix)
                .map(source => ({
                  key: source.key,
                  size: Math.max(0, Number(source.size || 0)),
                  url: BB.api.urlForKey(source.key, instanceId),
                  archivePath: uniqueArchivePath(source.archivePath || safeArchivePath(source.key, basePrefix), usedPaths)
                }));
              totalBytes = files.reduce((sum, source) => sum + source.size, 0);
              files.forEach(source => receivedByFile.set(source.key, 0));
            }

            for (; currentIndex < files.length; currentIndex++) {
              if (activeController.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
              const source = files[currentIndex];
              const result = await BB.actions.streamURL(source.url, {
                signal: activeController.signal,
                totalBytes: source.size,
                resumeState: currentResumeState,
                onCheckpoint(state) {
                  currentResumeState = state;
                  receivedByFile.set(source.key, Number(state.receivedBytes || 0));
                },
                onProgress(progress) {
                  receivedByFile.set(source.key, Number(progress.receivedBytes || 0));
                  const progressValue = sourceProgress();
                  item.update({
                    status: 'running',
                    progress: progressValue == null ? null : Math.min(0.9, progressValue * 0.9),
                    indeterminate: progressValue == null,
                    detail: transferDetail(progress, `${currentIndex}/${files.length} file(s) complete · ${source.archivePath}`),
                    onPause: pause,
                    onResume: resume,
                    onCancel: cancel
                  });
                }
              });
              const bytes = new Uint8Array(await result.blob.arrayBuffer());
              archiveInput[source.archivePath] = bytes;
              receivedByFile.set(source.key, source.size || bytes.byteLength);
              currentResumeState = null;
            }

            item.update({
              status: 'running',
              progress: 0.94,
              indeterminate: false,
              detail: `${files.length}/${files.length} file(s) downloaded · creating ZIP`,
              onPause: null,
              onResume: null,
              onCancel: cancel
            });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const zip = await new Promise((resolve, reject) => {
              let completed = false;
              const abort = () => {
                if (completed) return;
                completed = true;
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              };
              activeController.signal.addEventListener('abort', abort, { once: true });
              window.fflate.zip(archiveInput, { level: 0 }, (error, data) => {
                activeController.signal.removeEventListener('abort', abort);
                if (completed) return;
                completed = true;
                if (error) reject(error);
                else resolve(data);
              });
            });
            if (activeController.signal.aborted || cancelRequested) throw new DOMException('The operation was aborted.', 'AbortError');
            const blob = new Blob([zip], { type: 'application/zip' });
            await BB.actions.saveBlob(blob, archiveName, target.handle);
            item.complete({
              detail: `${files.length} file(s) · ${BB.actions.formatBytes(blob.size)}`,
              duration: 6000
            });
            finish(true);
          } catch (error) {
            if (error?.transferState) currentResumeState = error.transferState;
            if (BB.actions.isAbortError(error) || activeController.signal.aborted) {
              if (cancelRequested) {
                item.canceled({ detail: archiveName });
                finish(false);
              } else {
                item.update({
                  status: 'paused',
                  progress: sourceProgress() == null ? null : sourceProgress() * 0.9,
                  indeterminate: false,
                  detail: files
                    ? `${transferDetail(currentResumeState || {}, `${currentIndex}/${files.length} file(s) complete`)} · Resume continues from the last received byte.`
                    : 'Archive scan paused. Resume will restart the scan.',
                  onPause: pause,
                  onResume: resume,
                  onCancel: cancel
                });
              }
            } else {
              item.fail({
                progress: sourceProgress() == null ? null : sourceProgress() * 0.9,
                detail: String(error?.message || error || 'Archive download failed'),
                onResume: resume,
                onCancel: cancel
              });
            }
          } finally {
            if (controller === activeController) controller = null;
            running = false;
          }
        }

        void run();
        return completion;
      },

      formatBytes(size) {
        const value = Number(size || 0);
        if (value < 1024) return `${value} B`;
        if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
        if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
        return `${(value / 1024 ** 3).toFixed(2)} GB`;
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
        if (!date) return '';
        const value = new Date(date);
        return Number.isFinite(value.getTime())
          ? value.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
          : '';
      }
    },

    mounted() {
      this.onHashChange = () => this.updatePathFromHash();
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
      window.addEventListener('hashchange', this.onHashChange);
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
      window.removeEventListener('hashchange', this.onHashChange);
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
