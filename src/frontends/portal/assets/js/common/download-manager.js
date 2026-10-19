/* Resumable same-origin downloads using bounded HTTP byte ranges. */
(function () {
  'use strict';
  const BB = (window.BB = window.BB || {});
  if (!BB.api || !BB.runtime) throw new Error('BB.api and BB.runtime are required before BB.downloads');

  const CHUNK_SIZE = 16 * 1024 * 1024;
  const MAX_RETRIES = 5;
  const active = new Map();
  const records = new Map();
  const cancelRequests = new Map();

  function supportsResumableFiles() {
    return typeof window.showSaveFilePicker === 'function';
  }

  async function saveRecord(record) {
    records.set(record.id, record);
  }

  async function removeRecord(id) {
    records.delete(id);
  }

  async function listRecords() {
    return Array.from(records.values());
  }

  function fallbackDownload(key, filename, version = '', instance = null) {
    const anchor = document.createElement('a');
    anchor.href = BB.api.openURLForKey(key, instance, version);
    anchor.download = filename || String(key || '').split('/').pop() || 'download';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  }

  function nonRetriable(message) {
    const error = new Error(message);
    error.nonRetriable = true;
    return error;
  }

  async function requestRange(record, start, end, signal) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(BB.api.urlForKey(record.key, record.instance, record.version || ''), {
          cache: 'no-store', signal,
          headers: {
            Range: `bytes=${start}-${end}`,
            'Accept-Encoding': 'identity',
            ...(record.etag ? { 'If-Match': record.etag } : {}),
            ...(!record.etag && record.lastModified ? { 'If-Unmodified-Since': record.lastModified } : {})
          }
        });
        if (response.status !== 206) {
          if (response.body) await response.body.cancel().catch(() => {});
          const message = `The storage gateway returned HTTP ${response.status} instead of a bounded byte range.`;
          if (![408, 425, 429].includes(response.status) && response.status < 500) throw nonRetriable(message);
          throw new Error(message);
        }
        const contentRange = response.headers.get('Content-Range') || '';
        const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(contentRange);
        const returnedStart = Number(match?.[1]);
        const returnedEnd = Number(match?.[2]);
        const returnedTotal = Number(match?.[3]);
        if (!match || returnedStart !== start || returnedEnd !== end || returnedTotal !== record.size) {
          if (response.body) await response.body.cancel().catch(() => {});
          throw nonRetriable('The storage gateway returned an unexpected Content-Range.');
        }
        const expectedLength = end - start + 1;
        const rawLength = response.headers.get('Content-Length');
        if (rawLength !== null && Number(rawLength) !== expectedLength) {
          if (response.body) await response.body.cancel().catch(() => {});
          throw nonRetriable('The storage gateway returned an invalid ranged Content-Length.');
        }
        return response;
      } catch (error) {
        if (error?.name === 'AbortError' || error?.nonRetriable) throw error;
        lastError = error;
        if (attempt >= MAX_RETRIES) break;
        await sleep(Math.min(8000, 400 * (2 ** attempt)), signal);
      }
    }
    throw lastError || new Error('Download failed.');
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  }

  function normalizedChunks(record, maximumOffset) {
    return (Array.isArray(record.chunks) ? record.chunks : [])
      .filter(chunk => Number(chunk.start) >= 0 && Number(chunk.end) > Number(chunk.start) && Number(chunk.end) <= maximumOffset && String(chunk.sha256 || ''))
      .sort((left, right) => Number(left.start) - Number(right.start));
  }

  async function validateLocalChunks(record, file, offset) {
    const chunks = normalizedChunks(record, offset);
    if (!chunks.length) return offset === 0;
    let expectedStart = 0;
    for (const chunk of chunks) {
      const start = Number(chunk.start);
      const end = Number(chunk.end);
      if (start !== expectedStart || end > offset) return false;
      const local = await file.slice(start, end).arrayBuffer();
      if ((await sha256Hex(local)) !== chunk.sha256) return false;
      expectedStart = end;
    }
    return expectedStart === offset;
  }

  async function erasePartial(record) {
    if (!record?.handle) return;
    try {
      const writable = await record.handle.createWritable({ keepExistingData: true });
      await writable.truncate(0);
      await writable.close();
    } catch (_) {}
  }

  async function finalizeCancellation(record, task, erase) {
    if (erase) await erasePartial(record);
    await removeRecord(record.id);
    task?.canceled?.({ name: record.filename, detail: 'Download canceled.' });
  }

  async function run(record, task) {
    if (active.has(record.id)) return;
    const controller = new AbortController();
    active.set(record.id, { controller, record, task });
    let writable;
    try {
      const permission = await record.handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const granted = await record.handle.requestPermission({ mode: 'readwrite' });
        if (granted !== 'granted') throw new Error('Write access to the selected file was not granted.');
      }

      let existing = await record.handle.getFile();
      writable = await record.handle.createWritable({ keepExistingData: true });
      if (!record.initialized) {
        await writable.truncate(0);
        record.initialized = true;
        record.offset = 0;
        record.chunks = [];
        existing = await record.handle.getFile();
        await saveRecord(record);
      } else {
        const persistedOffset = Math.max(0, Math.min(Number(record.offset || 0), Number(record.size || 0)));
        const offset = Math.min(persistedOffset, Number(existing.size || 0));
        record.offset = offset;
        record.chunks = normalizedChunks(record, offset);
        if (Number(existing.size || 0) !== offset) await writable.truncate(offset);
        if (!(await validateLocalChunks(record, existing, offset))) {
          throw nonRetriable('The partial local file no longer matches its saved download checkpoints. Restart the download.');
        }
      }

      const initialOffset = record.offset;
      const started = performance.now();
      task.update({
        status: 'running',
        progress: record.size ? record.offset / record.size : 1,
        detail: `${record.offset.toLocaleString()} / ${record.size.toLocaleString()} bytes`,
        onPause: () => controller.abort(),
        onCancel: () => cancel(record.id, true, task)
      });

      while (record.offset < record.size) {
        const start = record.offset;
        const end = Math.min(record.size - 1, start + CHUNK_SIZE - 1);
        const response = await requestRange(record, start, end, controller.signal);
        const buffer = await response.arrayBuffer();
        const expectedLength = end - start + 1;
        if (buffer.byteLength !== expectedLength) throw nonRetriable('The received download range has an invalid size.');
        const digest = await sha256Hex(buffer);
        await writable.seek(start);
        await writable.write(buffer);
        record.offset = start + buffer.byteLength;
        record.chunks = normalizedChunks(record, start);
        record.chunks.push({ start, end: record.offset, sha256: digest });
        record.updatedAt = new Date().toISOString();
        await saveRecord(record);
        const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
        const rate = Math.max(0, (record.offset - initialOffset) / elapsed);
        task.update({
          status: 'running',
          progress: record.size ? record.offset / record.size : 1,
          detail: `${record.offset.toLocaleString()} / ${record.size.toLocaleString()} bytes · ${Math.round(rate).toLocaleString()} B/s`
        });
      }

      await writable.truncate(record.size);
      await writable.close();
      writable = null;
      await removeRecord(record.id);
      task.complete({ name: record.filename, detail: 'Download completed and verified by ranged byte count and local chunk checksums.' });
    } catch (error) {
      if (writable) await writable.close().catch(() => {});
      writable = null;
      const cancellation = cancelRequests.get(record.id);
      if (cancellation) {
        await finalizeCancellation(record, cancellation.task || task, cancellation.erase);
      } else if (error?.name === 'AbortError') {
        record.updatedAt = new Date().toISOString();
        await saveRecord(record);
        task.update({
          status: 'paused',
          detail: `${record.offset.toLocaleString()} / ${record.size.toLocaleString()} bytes`,
          onResume: () => run(record, task),
          onCancel: () => cancel(record.id, true, task)
        });
      } else {
        task.fail({
          name: record.filename,
          detail: String(error?.message || error),
          onResume: error?.nonRetriable ? null : () => run(record, task),
          onCancel: () => cancel(record.id, true, task)
        });
      }
    } finally {
      active.delete(record.id);
      cancelRequests.delete(record.id);
    }
  }

  async function cancel(id, erase = false, task = null) {
    const current = active.get(id);
    const records = await listRecords();
    const record = current?.record || records.find(item => item.id === id);
    if (!record) {
      task?.canceled?.({ detail: 'Download canceled.' });
      return;
    }
    if (current) {
      cancelRequests.set(id, { erase, task: task || current.task });
      current.controller.abort();
      return;
    }
    await finalizeCancellation(record, task, erase);
  }

  async function download({ key, filename, version = '', instance = null } = {}) {
    const cleanKey = String(key || '').replace(/^\/+/, '');
    const cleanName = filename || cleanKey.split('/').pop() || 'download';
    if (!supportsResumableFiles()) {
      fallbackDownload(cleanKey, cleanName, version, instance);
      return null;
    }
    const metadata = await BB.api.head(cleanKey, version, instance);
    if (!metadata.sizeKnown || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw new Error('The provider did not return a valid Content-Length, so a resumable download cannot be started.');
    }
    const handle = await window.showSaveFilePicker({ suggestedName: cleanName });
    const unique = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const providerVersion = String(metadata.headers?.['x-amz-version-id'] || metadata.headers?.['x-goog-generation'] || '');
    const stableVersion = String(version || (providerVersion && providerVersion !== 'null' ? providerVersion : ''));
    const record = {
      id: `download:${unique}`,
      instance: instance || BB.api.getInstance(),
      key: cleanKey,
      version: stableVersion,
      filename: cleanName,
      size: metadata.size,
      etag: String(metadata.headers?.etag || ''),
      lastModified: String(metadata.headers?.['last-modified'] || ''),
      offset: 0,
      initialized: false,
      chunks: [],
      handle,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveRecord(record);
    const task = BB.ui.transferGroup('download').add({
      id: record.id,
      name: cleanName,
      status: 'queued',
      progress: 0,
      detail: 'Preparing resumable download',
      onCancel: () => cancel(record.id, true, task)
    });
    run(record, task);
    return task;
  }

  async function restore() {
    // Transfer state is deliberately page-local and disappears when the page closes.
  }

  BB.downloads = { download, restore, cancel, fallbackDownload, supportsResumableFiles };
  window.addEventListener('DOMContentLoaded', () => restore().catch(() => {}), { once: true });
})();
