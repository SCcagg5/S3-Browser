/* Object Browser API client. All requests are scoped to the selected instance. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  if (!BB.detect) throw new Error('BB.detect is required before BB.api');

  const RESUMABLE_UPLOAD_THRESHOLD = 32 * 1024 * 1024;
  let instanceId = '';

  function selectedInstance() {
    return instanceId || (BB.cfg && BB.cfg.instanceId) || '';
  }

  function withInstance(path, extraParams, explicitInstance = null) {
    const url = new URL(path, window.location.origin);
    const id = explicitInstance === null || explicitInstance === undefined
      ? selectedInstance()
      : String(explicitInstance || '');
    if (id) url.searchParams.set('instance', id);
    Object.entries(extraParams || {}).forEach(([key, value]) => {
      // Empty strings are meaningful for parameters such as delimiter=. Only
      // undefined and null mean that the caller did not supply a value.
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
    return url.pathname + url.search;
  }

  async function request(path, options) {
    const response = await fetch(path, { cache: 'no-store', ...(options || {}) });
    if (response.ok) return response;
    let message = `HTTP ${response.status}`;
    let code = '';
    try {
      const type = response.headers.get('Content-Type') || '';
      if (type.includes('application/json')) {
        const payload = await response.json();
        message = payload?.error?.message || payload?.message || message;
        code = payload?.error?.code || payload?.code || '';
      } else {
        const text = (await response.text()).trim();
        if (text) message = text;
      }
    } catch (_) {}
    const error = new Error(message);
    error.status = response.status;
    error.code = code;
    throw error;
  }

  function sleep(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }


  function abortError() {
    try { return new DOMException('The operation was aborted.', 'AbortError'); }
    catch (_) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      return error;
    }
  }

  function sleepWithSignal(milliseconds, signal) {
    if (!signal) return sleep(milliseconds);
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(done, milliseconds);
      function done() {
        signal.removeEventListener('abort', canceled);
        resolve();
      }
      function canceled() {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', canceled);
        reject(abortError());
      }
      signal.addEventListener('abort', canceled, { once: true });
    });
  }

  function xhrFailure(xhr) {
    let message = xhr.status ? `HTTP ${xhr.status}` : 'Network request failed';
    let code = '';
    try {
      const payload = JSON.parse(xhr.responseText || '{}');
      message = payload?.error?.message || payload?.message || message;
      code = payload?.error?.code || payload?.code || '';
    } catch (_) {
      const text = String(xhr.responseText || '').trim();
      if (text) message = text;
    }
    const error = new Error(message);
    error.status = Number(xhr.status || 0);
    error.code = code;
    return error;
  }

  function xhrRequest(path, {
    method = 'GET',
    headers = {},
    body = null,
    signal = null,
    onUploadProgress = null
  } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open(method, path, true);
      Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      xhr.responseType = 'text';

      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const succeed = finish(resolve);
      const fail = finish(reject);
      const cancel = () => xhr.abort();

      if (typeof onUploadProgress === 'function') {
        xhr.upload.addEventListener('progress', event => {
          onUploadProgress({
            loaded: Number(event.loaded || 0),
            total: event.lengthComputable ? Number(event.total || 0) : Number(body?.size || 0),
            lengthComputable: !!event.lengthComputable
          });
        });
      }
      xhr.addEventListener('load', () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(xhrFailure(xhr));
          return;
        }
        const text = String(xhr.responseText || '').trim();
        if (!text) {
          succeed(null);
          return;
        }
        try { succeed(JSON.parse(text)); }
        catch (error) { fail(new Error(`Invalid JSON response: ${error.message}`)); }
      });
      xhr.addEventListener('error', () => fail(xhrFailure(xhr)));
      xhr.addEventListener('timeout', () => fail(xhrFailure(xhr)));
      xhr.addEventListener('abort', () => fail(abortError()));
      signal?.addEventListener('abort', cancel, { once: true });
      xhr.send(body);
    });
  }

  function isRetriableUploadError(error) {
    const status = Number(error?.status || 0);
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function alignChunkSize(value, alignment) {
    return Math.max(alignment, Math.ceil(Number(value || 0) / alignment) * alignment);
  }

  function adaptiveUploadChunkSize(upload, currentSize, throughput) {
    const mebibyte = 1024 * 1024;
    const provider = String(upload.provider || '').toLowerCase();
    const remaining = Math.max(0, Number(upload.totalSize || 0) - Number(upload.nextOffset || upload.uploadedBytes || 0));
    const partCount = Math.max(0, Number(upload.partCount || 0));
    let minimum;
    let maximum;
    let alignment;

    if (provider === 's3') {
      const remainingPartSlots = Math.max(1, 10000 - partCount);
      minimum = Math.max(5 * mebibyte, Math.ceil(remaining / remainingPartSlots));
      maximum = 128 * mebibyte;
      alignment = mebibyte;
    } else {
      minimum = 4 * mebibyte;
      maximum = 64 * mebibyte;
      alignment = 256 * 1024;
    }

    minimum = alignChunkSize(minimum, alignment);
    const current = Math.max(minimum, Number(currentSize || upload.chunkSize || minimum));
    if (!Number.isFinite(throughput) || throughput <= 0) return Math.min(maximum, alignChunkSize(current, alignment));

    const targetDurationSeconds = 6;
    const measuredTarget = throughput * targetDurationSeconds;
    const boundedTarget = Math.max(current / 2, Math.min(current * 2, measuredTarget));
    const smoothed = current * 0.6 + boundedTarget * 0.4;
    return Math.min(maximum, Math.max(minimum, alignChunkSize(smoothed, alignment)));
  }

  function uploadStorageKey(instance, key, blob, lastModified) {
    return `object-browser-upload:${instance}:${key}:${blob.size}:${Number(lastModified || 0)}`;
  }

  function readStoredUpload(storageKey) {
    try { return localStorage.getItem(storageKey) || ''; }
    catch (_) { return ''; }
  }

  function storeUpload(storageKey, id) {
    try {
      if (id) localStorage.setItem(storageKey, id);
      else localStorage.removeItem(storageKey);
    } catch (_) {}
  }

  const api = {
    setInstance(id) {
      instanceId = String(id || '');
      BB.cfg = BB.cfg || {};
      BB.cfg.instanceId = instanceId;
    },

    getInstance() { return selectedInstance(); },

    async instances() {
      const response = await request('/api/instances');
      return response.json();
    },

    urlForKey(key, explicitInstance = null) {
      const clean = String(key || '').replace(/^\/+/, '');
      return withInstance('/s3', { key: clean }, explicitInstance);
    },

    previewURLForKey(key, explicitInstance = null) {
      const clean = String(key || '').replace(/^\/+/, '');
      return withInstance('/s3', { key: clean, preview: 1 }, explicitInstance);
    },

    async head(key) {
      const response = await request(this.urlForKey(key), { method: 'HEAD' });
      const headers = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      return {
        mime: response.headers.get('Content-Type') || '',
        size: Number(response.headers.get('Content-Length') || 0),
        headers
      };
    },

    async getText(key) {
      const response = await request(this.urlForKey(key));
      return response.text();
    },

    async getBlob(key) {
      const response = await request(this.urlForKey(key));
      return response.blob();
    },

    async spreadsheet({
      key,
      sheet = 0,
      page = 0,
      pageSize = 100,
      filters = {},
      sortColumn = '',
      sortDirection = '',
      search = '',
      size = 0,
      instance = null,
      signal = null
    } = {}) {
      const parameters = {
        key,
        sheet,
        page,
        pageSize,
        filters: JSON.stringify(filters || {}),
        search
      };
      if (Number(size) > 0) parameters.size = Math.floor(Number(size));
      if (sortColumn && sortDirection) {
        parameters.sortColumn = sortColumn;
        parameters.sortDirection = sortDirection;
      }
      const response = await request(withInstance('/api/spreadsheet', parameters, instance), { signal });
      return response.json();
    },

    async delimitedPage({ key, cursor = '', etag = '', pageSize = 100, instance = null, signal = null } = {}) {
      const parameters = { key, pageSize };
      if (cursor) parameters.cursor = cursor;
      if (etag) parameters.etag = etag;
      const response = await request(withInstance('/api/delimited', parameters, instance), { signal });
      return response.json();
    },

    async documentCount({ key, instance = null, signal = null } = {}) {
      const response = await request(withInstance('/api/document-count', { key }, instance), { signal });
      return response.json();
    },

    async jsonRaw({ key, cursor = '', etag = '', instance = null, signal = null } = {}) {
      const parameters = { key };
      if (cursor) parameters.cursor = cursor;
      if (etag) parameters.etag = etag;
      const response = await request(withInstance('/api/json/raw', parameters, instance), { signal });
      return response.json();
    },

    async jsonBeautify({ key, cursor = '', etag = '', instance = null, signal = null } = {}) {
      const parameters = { key };
      if (cursor) parameters.cursor = cursor;
      if (etag) parameters.etag = etag;
      const response = await request(withInstance('/api/json/beautify', parameters, instance), { signal });
      return response.json();
    },

    async jsonSummary({ key, etag = '', instance = null, signal = null } = {}) {
      const parameters = { key };
      if (etag) parameters.etag = etag;
      const response = await request(withInstance('/api/json/summary', parameters, instance), { signal });
      return response.json();
    },

    async searchDocument({ key, query, instance = null, signal = null } = {}) {
      const response = await request(withInstance('/api/search', { key, q: query }, instance), { signal });
      return response.json();
    },

    async jsonTree({
      key,
      start = 0,
      cursor = 0,
      index = 0,
      type = '',
      limit = 50,
      etag = '',
      instance = null,
      signal = null
    } = {}) {
      const parameters = { key, limit };
      if (Number(start) > 0) parameters.start = Math.floor(Number(start));
      if (Number(cursor) > 0) parameters.cursor = Math.floor(Number(cursor));
      if (Number(index) > 0) parameters.index = Math.floor(Number(index));
      if (type) parameters.type = type;
      if (etag) parameters.etag = etag;
      const response = await request(withInstance('/api/json/tree', parameters, instance), { signal });
      return response.json();
    },

    async createSQLiteSession({ key, size = 0, instance = null, signal = null } = {}) {
      const response = await request('/api/sqlite/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          instance: String(instance || selectedInstance()),
          key,
          size: Math.max(0, Math.floor(Number(size) || 0))
        })
      });
      return response.json();
    },

    async sqliteTable({ id, table, page = 0, pageSize = 100, query = '', signal = null } = {}) {
      const path = `/api/sqlite/sessions/${encodeURIComponent(id)}/table`;
      const response = await request(withInstance(path, { table, page, pageSize, q: query }, ''), { signal });
      return response.json();
    },

    async deleteSQLiteSession(id, options = {}) {
      if (!id) return;
      await request(`/api/sqlite/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        keepalive: !!options.keepalive,
        signal: options.signal || null
      });
    },

    async mediaInfo(key, options = {}) {
      const parameters = { key };
      const size = Number(options.size);
      if (Number.isFinite(size) && size >= 0) parameters.size = String(size);
      if (options.mime) parameters.mime = String(options.mime);
      if (options.etag) parameters.etag = String(options.etag);
      if (options.lastModified) parameters.lastModified = String(options.lastModified);
      const response = await request(withInstance('/api/media-info', parameters, options.instance ?? null), {
        signal: options.signal || null
      });
      return response.json();
    },

    imagePreviewURL(key, options = {}) {
      return withInstance('/api/image-preview', { key }, options.instance ?? null);
    },

    async putBlob(key, blob, mime, options = {}) {
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
      const signal = options.signal || null;
      const startedAt = Date.now();
      let speedBps = 0;
      let previousBytes = 0;
      let previousAt = startedAt;
      await xhrRequest(this.urlForKey(key, options.instance), {
        method: 'PUT',
        headers: { 'Content-Type': mime || 'application/octet-stream' },
        body: blob,
        signal,
        onUploadProgress(event) {
          const now = Date.now();
          const uploadedBytes = Math.min(blob.size, Number(event.loaded || 0));
          const elapsed = Math.max(1, now - previousAt);
          if (uploadedBytes > previousBytes && elapsed >= 120) {
            const instantaneous = (uploadedBytes - previousBytes) * 1000 / elapsed;
            speedBps = speedBps ? speedBps * 0.72 + instantaneous * 0.28 : instantaneous;
            previousBytes = uploadedBytes;
            previousAt = now;
          }
          onProgress({
            status: 'uploading',
            phase: 'uploading',
            provider: 'direct',
            resumable: false,
            uploadedBytes,
            totalSize: blob.size,
            progress: blob.size ? uploadedBytes / blob.size : 1,
            speedBps,
            etaSeconds: speedBps > 0 ? Math.max(0, (blob.size - uploadedBytes) / speedBps) : null
          });
        }
      });
      const result = { status: 'completed', uploadedBytes: blob.size, totalSize: blob.size };
      onProgress({
        ...result,
        phase: 'completed',
        provider: 'direct',
        resumable: false,
        progress: 1,
        speedBps: blob.size * 1000 / Math.max(1, Date.now() - startedAt),
        etaSeconds: 0
      });
      return result;
    },

    async createUpload({ key, size, contentType, instance = '' }, options = {}) {
      const targetInstance = String(instance || options.instance || selectedInstance());
      const response = await request('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instance: targetInstance,
          key,
          size,
          contentType: contentType || 'application/octet-stream'
        }),
        signal: options.signal || null
      });
      return response.json();
    },

    async uploadStatus(id, options = {}) {
      const response = await request(`/api/uploads/${encodeURIComponent(id)}`, {
        signal: options.signal || null
      });
      return response.json();
    },

    async uploadChunk(id, blob, start, total, options = {}) {
      const end = start + blob.size - 1;
      return xhrRequest(`/api/uploads/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${total}`
        },
        body: blob,
        signal: options.signal || null,
        onUploadProgress: options.onProgress || null
      });
    },

    async cancelUpload(id) {
      const response = await request(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return response.json();
    },

    async uploads() {
      const response = await request(withInstance('/api/uploads'));
      return response.json();
    },

    async uploadBlob(key, blob, mime, options = {}) {
      if (!(blob instanceof Blob)) throw new TypeError('uploadBlob requires a Blob or File');
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
      const onSession = typeof options.onSession === 'function' ? options.onSession : () => {};
      const signal = options.signal || null;
      const instance = String(options.instance || selectedInstance());
      if (signal?.aborted) throw abortError();
      if (blob.size < RESUMABLE_UPLOAD_THRESHOLD) {
        return this.putBlob(key, blob, mime, { onProgress, signal, instance });
      }

      const storageKey = uploadStorageKey(instance, key, blob, options.lastModified);
      let upload = null;
      let resumed = false;
      const storedID = readStoredUpload(storageKey);
      if (storedID) {
        try {
          const candidate = await this.uploadStatus(storedID, { signal });
          if (candidate.instance === instance && candidate.key === key && candidate.totalSize === blob.size && candidate.status === 'uploading') {
            upload = candidate;
            resumed = Number(candidate.uploadedBytes || 0) > 0;
            onSession(candidate);
          } else if (candidate.status === 'completed' && candidate.key === key && candidate.totalSize === blob.size) {
            storeUpload(storageKey, '');
            onProgress({ ...candidate, phase: 'completed', resumable: true, resumed: true, progress: 1, etaSeconds: 0 });
            return candidate;
          } else {
            storeUpload(storageKey, '');
          }
        } catch (error) {
          if (error.status === 404) storeUpload(storageKey, '');
          else throw error;
        }
      }
      if (!upload) {
        upload = await this.createUpload({ instance, key, size: blob.size, contentType: mime }, { signal });
        storeUpload(storageKey, upload.id);
        onSession(upload);
      }

      let selectedChunkSize = Math.max(1, Number(upload.chunkSize || 8 * 1024 * 1024));
      let speedBps = 0;
      let lastMeterBytes = Number(upload.uploadedBytes || 0);
      let lastMeterAt = Date.now();

      const emit = (uploadedBytes, extra = {}) => {
        const now = Date.now();
        const boundedBytes = Math.max(Number(upload.uploadedBytes || 0), Math.min(blob.size, Number(uploadedBytes || 0)));
        const elapsed = Math.max(1, now - lastMeterAt);
        if (boundedBytes > lastMeterBytes && elapsed >= 120) {
          const instantaneous = (boundedBytes - lastMeterBytes) * 1000 / elapsed;
          speedBps = speedBps ? speedBps * 0.75 + instantaneous * 0.25 : instantaneous;
          lastMeterBytes = boundedBytes;
          lastMeterAt = now;
        }
        onProgress({
          ...upload,
          status: extra.status || upload.status || 'uploading',
          phase: extra.phase || 'uploading',
          resumable: true,
          resumed,
          uploadedBytes: boundedBytes,
          totalSize: blob.size,
          progress: blob.size ? boundedBytes / blob.size : 1,
          speedBps,
          etaSeconds: speedBps > 0 ? Math.max(0, (blob.size - boundedBytes) / speedBps) : null,
          selectedChunkSize,
          retryAttempt: Number(extra.retryAttempt || 0),
          retryInSeconds: Number(extra.retryInSeconds || 0)
        });
      };

      emit(Number(upload.uploadedBytes || 0), { phase: resumed ? 'resuming' : 'starting' });

      while (upload.status === 'uploading' && upload.nextOffset < blob.size) {
        if (signal?.aborted) throw abortError();
        const start = Number(upload.nextOffset || upload.uploadedBytes || 0);
        selectedChunkSize = adaptiveUploadChunkSize(upload, selectedChunkSize, speedBps);
        const end = Math.min(blob.size, start + selectedChunkSize);
        const chunk = blob.slice(start, end);
        const chunkStartedAt = Date.now();
        let attempt = 0;

        for (;;) {
          try {
            upload = await this.uploadChunk(upload.id, chunk, start, blob.size, {
              signal,
              onProgress: event => emit(start + Math.min(chunk.size, Number(event.loaded || 0)), { phase: 'uploading' })
            });
            const chunkThroughput = chunk.size * 1000 / Math.max(1, Date.now() - chunkStartedAt);
            speedBps = speedBps ? speedBps * 0.65 + chunkThroughput * 0.35 : chunkThroughput;
            selectedChunkSize = adaptiveUploadChunkSize(upload, selectedChunkSize, speedBps);
            emit(Number(upload.uploadedBytes || upload.nextOffset || end), { phase: upload.status === 'completed' ? 'completed' : 'uploading' });
            break;
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            if (error.code === 'offset_mismatch' || error.status === 409) {
              upload = await this.uploadStatus(upload.id, { signal });
              emit(Number(upload.uploadedBytes || 0), { phase: 'resuming' });
              break;
            }
            if (!isRetriableUploadError(error) || attempt >= 4) throw error;
            attempt++;
            const delay = Math.min(8000, 500 * (2 ** (attempt - 1))) + Math.round(Math.random() * 250);
            emit(start, { phase: 'retrying', retryAttempt: attempt, retryInSeconds: delay / 1000 });
            await sleepWithSignal(delay, signal);
            try {
              const status = await this.uploadStatus(upload.id, { signal });
              upload = status;
              if (Number(status.nextOffset || status.uploadedBytes || 0) > start || status.status !== 'uploading') {
                emit(Number(status.uploadedBytes || 0), { phase: status.status === 'completed' ? 'completed' : 'resuming' });
                break;
              }
            } catch (statusError) {
              if (statusError?.name === 'AbortError') throw statusError;
            }
          }
        }
      }
      if (upload.status !== 'completed') upload = await this.uploadStatus(upload.id, { signal });
      if (upload.status !== 'completed') throw new Error(upload.error || `Upload stopped with status ${upload.status}.`);
      storeUpload(storageKey, '');
      emit(blob.size, { phase: 'completed', status: 'completed' });
      return upload;
    },

    async del(key) {
      await request(this.urlForKey(key), { method: 'DELETE' });
      return true;
    },

    async list({ prefix = '', delimiter = '/', max = 50, continuationToken = '', exclude = '', signal = null, instance = null } = {}) {
      const response = await request(
        withInstance('/api/list', { prefix, delimiter, max, continuationToken, exclude }, instance),
        { signal }
      );
      return response.json();
    },

    async listAllItems(prefix = '', options = {}) {
      const items = [];
      const signal = options.signal || null;
      const exclude = options.exclude || '';
      const instance = options.instance ?? null;
      const onPage = typeof options.onPage === 'function' ? options.onPage : () => {};
      let continuationToken = '';
      do {
        const page = await this.list({
          prefix,
          delimiter: '',
          max: 1000,
          continuationToken,
          exclude,
          signal,
          instance
        });
        for (const item of page.items || []) {
          if (item.type === 'content') items.push(item);
        }
        onPage({ count: items.length, itemsCount: items.length, page });
        continuationToken = page.nextContinuationToken || '';
      } while (continuationToken);
      return items;
    },

    async listAll(prefix = '', options = {}) {
      const items = await this.listAllItems(prefix, options);
      return items.map(item => item.key);
    },

    async copy({ src, dst, isPrefix = false }) {
      const response = await request('/api/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: selectedInstance(), src, dst, isPrefix: !!isPrefix })
      });
      return response.json();
    },

    async rename({ src, dst, isPrefix = false }) {
      const response = await request('/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: selectedInstance(), src, dst, isPrefix: !!isPrefix })
      });
      return response.json();
    },

    async deletePrefix(prefix) {
      const response = await request('/api/delete-prefix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: selectedInstance(), prefix })
      });
      return response.json();
    },

    async stats(prefix = '') {
      const response = await request(withInstance('/api/stats', { prefix }));
      return response.json();
    },

    async jobs() {
      const response = await request(withInstance('/api/jobs'));
      return response.json();
    },

    async job(id) {
      const response = await request(`/api/jobs/${encodeURIComponent(id)}`);
      return response.json();
    },

    async jobAction(id, action) {
      const response = await request(`/api/jobs/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST' });
      return response.json();
    },

    async waitForJob(initialJob, options = {}) {
      let job = typeof initialJob === 'string' ? await this.job(initialJob) : initialJob;
      const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
      const pollInterval = Math.max(250, Number(options.pollInterval || 750));
      for (;;) {
        onUpdate(job);
        if (job.status === 'completed') return job;
        if (job.status === 'failed') throw new Error(job.error || 'Background job failed.');
        if (job.status === 'canceled') throw new Error('Background job was canceled.');
        if (job.status === 'paused') return job;
        await sleep(pollInterval);
        job = await this.job(job.id);
      }
    }
  };

  BB.api = api;
})();
