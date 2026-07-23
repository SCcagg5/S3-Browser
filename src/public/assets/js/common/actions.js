/* User-facing object and prefix actions. */
(function () {
  const BB = (window.BB = window.BB || {});
  if (!BB.api || !BB.detect) throw new Error('BB.api and BB.detect are required before BB.actions');
  let downloadSequence = 0;

  function ui() {
    if (!BB.ui) throw new Error('BB.ui is required before BB.actions');
    return BB.ui;
  }

  function transferGroup(kind) {
    const interface = ui();
    if (typeof interface.transferGroup === 'function') return interface.transferGroup(kind);
    return {
      add(options = {}) {
        const notification = interface.toast(options.name || 'Transfer', {
          persistent: true,
          status: options.status === 'paused' ? 'paused' : 'loading',
          progress: options.progress,
          indeterminate: options.indeterminate,
          detail: options.detail || ''
        });
        const controller = {
          update(next = {}) {
            notification.update(next.name, {
              persistent: !['completed', 'canceled'].includes(next.status),
              status: next.status === 'error' ? 'error' : (next.status === 'paused' ? 'paused' : (next.status === 'completed' ? 'success' : 'loading')),
              progress: next.progress,
              indeterminate: next.indeterminate,
              detail: next.detail || ''
            });
            return controller;
          },
          complete(next = {}) { controller.update({ ...next, status: 'completed', progress: 1 }); return controller; },
          fail(next = {}) { controller.update({ ...next, status: 'error' }); return controller; },
          canceled(next = {}) { controller.update({ ...next, status: 'canceled' }); return controller; },
          remove() { notification.close(); }
        };
        return controller;
      }
    };
  }
  function caps() { return (BB.cfg && BB.cfg.capabilities) || {}; }
  function allowed(name) { return !!caps()?.[name]?.allowed; }
  function escapeHTML(value = '') { const span = document.createElement('span'); span.textContent = String(value); return span.innerHTML; }
  function ensurePrefix(value) { const clean = String(value || '').replace(/^\/+/, '').replace(/\/+$/, ''); return clean ? clean + '/' : ''; }
  function dirOf(key) { const slash = String(key || '').lastIndexOf('/'); return slash < 0 ? '' : key.slice(0, slash + 1); }

  async function requirePermissions(names) {
    const missing = names.filter(name => !allowed(name));
    if (!missing.length) return true;
    await ui().alert({ title: 'Action unavailable', message: `Required permission(s): ${missing.join(', ')}.` });
    return false;
  }

  function formatBytes(size) {
    const value = Number(size || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '';
    if (value < 1) return '<1s left';
    if (value < 60) return `${Math.ceil(value)}s left`;
    const minutes = Math.ceil(value / 60);
    if (minutes < 60) return `${minutes}m left`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ''} left`;
  }

  function formatRate(bytesPerSecond) {
    const value = Number(bytesPerSecond);
    return Number.isFinite(value) && value > 0 ? `${formatBytes(value)}/s` : '';
  }

  function formatTransferDetail(progress = {}, suffix = '') {
    const transferred = Number(progress.transferredBytes ?? progress.uploadedBytes ?? progress.receivedBytes ?? 0);
    const total = Number(progress.totalBytes ?? progress.totalSize ?? 0);
    const parts = [];
    if (total > 0) parts.push(`${formatBytes(transferred)} / ${formatBytes(total)}`);
    else if (transferred > 0) parts.push(formatBytes(transferred));
    const rate = formatRate(progress.speedBps);
    if (rate) parts.push(rate);
    const eta = formatDuration(progress.etaSeconds);
    if (eta && total > transferred) parts.push(eta);
    if (progress.resumed) parts.push('resumed');
    if (progress.resumable && progress.selectedChunkSize) parts.push(`${formatBytes(progress.selectedChunkSize)} parts`);
    if (progress.phase === 'retrying') {
      const delay = Number(progress.retryInSeconds || 0);
      parts.push(delay > 0 ? `retrying in ${delay.toFixed(1)}s` : 'retrying');
    }
    if (suffix) parts.push(String(suffix));
    return parts.join(' · ');
  }

  function abortError() {
    try { return new DOMException('The operation was aborted.', 'AbortError'); }
    catch (_) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      return error;
    }
  }

  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  function markTaskNotification(error) {
    if (!error || typeof error !== 'object') return;
    try { Object.defineProperty(error, 'taskNotificationShown', { value: true, configurable: true }); }
    catch (_) { error.taskNotificationShown = true; }
  }

  function showTaskFailure(label, error) {
    if (error?.taskNotificationShown) return;
    ui().toast(`${label} failed: ${String(error?.message || error)}`, {
      persistent: false,
      status: 'error',
      progress: null,
      indeterminate: false,
      duration: 6500
    });
    markTaskNotification(error);
  }

  function sleepWithSignal(milliseconds, signal) {
    if (!signal) return new Promise(resolve => window.setTimeout(resolve, milliseconds));
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

  async function pickSaveTarget(filename, { useFilePicker = false } = {}) {
    // Native browser downloads are the default so completed transfers are
    // registered by Chrome and other browsers in their download history.
    // The File System Access API remains available for future explicit UI,
    // but is never selected implicitly because direct file writes bypass the
    // browser download manager.
    if (!useFilePicker || !window.isSecureContext || typeof window.showSaveFilePicker !== 'function') {
      return { handle: null, canceled: false };
    }
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename || 'download' });
      return { handle, canceled: false };
    } catch (error) {
      if (isAbortError(error)) return { handle: null, canceled: true };
      throw error;
    }
  }

  async function saveBlob(blob, filename, handle = null) {
    if (handle) {
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        try { await writable.abort(); } catch (_) {}
        throw error;
      }
      return;
    }
    const href = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || 'download';
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      // Keep the object URL alive long enough for slower browser download
      // initialization paths to take ownership of it.
      window.setTimeout(() => URL.revokeObjectURL(href), 60000);
    }
  }

  function contentRangeTotal(value) {
    const match = String(value || '').match(/\/\s*(\d+)\s*$/);
    return match ? Number(match[1]) : 0;
  }

  function retriableDownloadError(error) {
    const status = Number(error?.status || 0);
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function streamURL(url, options = {}) {
    const signal = options.signal || null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onCheckpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : () => {};
    const writable = options.writable || null;
    const resumeState = options.resumeState && typeof options.resumeState === 'object' ? options.resumeState : {};
    const chunks = writable ? [] : (Array.isArray(resumeState.chunks) ? resumeState.chunks : []);
    let receivedBytes = Math.max(0, Number(resumeState.receivedBytes || 0));
    let totalBytes = Math.max(0, Number(resumeState.totalBytes || options.totalBytes || 0));
    let etag = String(resumeState.etag || '');
    let speedBps = Math.max(0, Number(resumeState.speedBps || 0));
    let lastMeterBytes = receivedBytes;
    let lastMeterAt = Date.now();
    let retryAttempt = 0;
    let activeReader = null;

    const checkpoint = () => ({ chunks, receivedBytes, totalBytes, etag, speedBps });
    const abortedWithCheckpoint = () => {
      const error = abortError();
      try { error.transferState = checkpoint(); } catch (_) {}
      return error;
    };

    const cancelReader = () => {
      if (!activeReader) return;
      try {
        const canceled = activeReader.cancel(abortError());
        if (canceled && typeof canceled.catch === 'function') canceled.catch(() => {});
      } catch (_) {}
    };
    signal?.addEventListener('abort', cancelReader);

    const emit = extra => {
      const now = Date.now();
      const elapsed = Math.max(1, now - lastMeterAt);
      if (receivedBytes > lastMeterBytes && elapsed >= 120) {
        const instantaneous = (receivedBytes - lastMeterBytes) * 1000 / elapsed;
        speedBps = speedBps ? speedBps * 0.75 + instantaneous * 0.25 : instantaneous;
        lastMeterBytes = receivedBytes;
        lastMeterAt = now;
      }
      const state = {
        phase: 'downloading',
        receivedBytes,
        transferredBytes: receivedBytes,
        totalBytes,
        progress: totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : null,
        speedBps,
        etaSeconds: speedBps > 0 && totalBytes > receivedBytes ? (totalBytes - receivedBytes) / speedBps : null,
        retryAttempt,
        ...(extra || {})
      };
      onProgress(state);
      onCheckpoint(checkpoint());
    };

    try {
      for (;;) {
        if (signal?.aborted) throw abortedWithCheckpoint();
        const headers = {};
        if (receivedBytes > 0) {
          headers.Range = `bytes=${receivedBytes}-`;
          if (etag) headers['If-Range'] = etag;
        }
        try {
          const response = await fetch(url, { headers, signal, cache: 'no-store' });
          if (!response.ok && response.status !== 206) {
            const error = new Error(`Download failed: HTTP ${response.status}`);
            error.status = response.status;
            throw error;
          }

          if (receivedBytes > 0 && response.status !== 206) {
            receivedBytes = 0;
            chunks.length = 0;
            speedBps = 0;
            lastMeterBytes = 0;
            lastMeterAt = Date.now();
            if (writable) {
              if (typeof writable.seek === 'function') await writable.seek(0);
              if (typeof writable.truncate === 'function') await writable.truncate(0);
            }
          }
          etag = response.headers.get('ETag') || etag;
          const rangeTotal = contentRangeTotal(response.headers.get('Content-Range'));
          const contentLength = Number(response.headers.get('Content-Length') || 0);
          if (rangeTotal > 0) totalBytes = rangeTotal;
          else if (contentLength > 0) totalBytes = receivedBytes + contentLength;

          if (!response.body || typeof response.body.getReader !== 'function') {
            const bytes = new Uint8Array(await response.arrayBuffer());
            receivedBytes += bytes.byteLength;
            if (writable) await writable.write(bytes);
            else chunks.push(bytes);
            emit();
          } else {
            const reader = response.body.getReader();
            activeReader = reader;
            try {
              for (;;) {
                if (signal?.aborted) throw abortedWithCheckpoint();
                const result = await reader.read();
                if (result.done) break;
                const bytes = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
                if (writable) await writable.write(bytes);
                else chunks.push(bytes);
                receivedBytes += bytes.byteLength;
                emit();
              }
            } finally {
              activeReader = null;
              try { reader.releaseLock(); } catch (_) {}
            }
          }
          if (totalBytes > 0 && receivedBytes < totalBytes) {
            const error = new Error('The download stream ended before the advertised size was reached.');
            error.status = 0;
            throw error;
          }
          emit({ phase: 'completed', progress: 1, etaSeconds: 0 });
          const blob = writable ? null : new Blob(chunks, { type: options.contentType || 'application/octet-stream' });
          return { blob, receivedBytes, totalBytes, speedBps, state: checkpoint() };
        } catch (error) {
          if (isAbortError(error) || signal?.aborted) {
            if (error?.transferState) throw error;
            throw abortedWithCheckpoint();
          }
          if (!retriableDownloadError(error) || retryAttempt >= 4) throw error;
          retryAttempt++;
          const delay = Math.min(8000, 500 * (2 ** (retryAttempt - 1))) + Math.round(Math.random() * 250);
          emit({ phase: 'retrying', retryInSeconds: delay / 1000 });
          await sleepWithSignal(delay, signal);
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      cancelReader();
      activeReader = null;
    }
  }

  async function fetchBytes(url, options = {}) {
    const result = await streamURL(url, options);
    return new Uint8Array(await result.blob.arrayBuffer());
  }

  function jobProgressMessage(job, label) {
    const processed = Number(job.processed || 0).toLocaleString();
    if (job.status === 'queued') return `${label}: queued...`;
    if (job.status === 'paused') return `${label}: paused after ${processed} object(s).`;
    if (job.status === 'completed') return jobCompletionMessage(job, label);
    return Number(job.processed || 0) > 0
      ? `${label}: ${processed} object(s) processed...`
      : `${label}...`;
  }

  function jobCompletionMessage(job, label) {
    const processed = Number(job.processed || 0);
    if (job.stats) {
      const count = Number(job.stats.count || processed).toLocaleString();
      return `Folder details ready: ${count} object(s), ${formatBytes(job.stats.totalBytes || 0)}.`;
    }
    return `${label} completed: ${processed.toLocaleString()} object(s) processed.`;
  }

  async function waitForJob(job, label) {
    const notification = ui().toast(`${label}...`, {
      persistent: true,
      status: 'loading',
      indeterminate: true,
      detail: 'The operation is running in the background.'
    });
    let lastMessage = '';
    try {
      const completed = await BB.api.waitForJob(job, {
        onUpdate(current) {
          const message = jobProgressMessage(current, label);
          if (message === lastMessage) return;
          lastMessage = message;
          const processed = Number(current.processed || 0).toLocaleString();
          notification.update(message, {
            persistent: current.status !== 'paused',
            status: current.status === 'paused' ? 'paused' : 'loading',
            indeterminate: current.status !== 'paused',
            progress: current.status === 'paused' ? null : undefined,
            detail: `${processed} object(s) checkpointed`,
            duration: 5000
          });
        }
      });
      if (completed.status === 'paused') {
        notification.update(jobProgressMessage(completed, label), {
          persistent: false,
          status: 'paused',
          progress: null,
          indeterminate: false,
          detail: `${Number(completed.processed || 0).toLocaleString()} object(s) checkpointed`,
          duration: 5000
        });
        return completed;
      }
      notification.update(jobCompletionMessage(completed, label), {
        persistent: false,
        status: 'success',
        progress: 1,
        indeterminate: false,
        detail: `${Number(completed.processed || completed.stats?.count || 0).toLocaleString()} object(s) processed`,
        duration: 4500
      });
      return completed;
    } catch (error) {
      notification.update(`${label} failed: ${String(error.message || error)}`, {
        persistent: false,
        status: 'error',
        progress: null,
        indeterminate: false,
        duration: 6500
      });
      markTaskNotification(error);
      throw error;
    }
  }

  function jobLabel(job) {
    return String(job.type || 'job').replace(/_/g, ' ');
  }

  async function showJobs() {
    try {
      const response = await BB.api.jobs();
      const jobs = response.jobs || [];
      const rows = jobs.length ? jobs.map(job => `<div class="kv-row"><div class="kv-k mono">${escapeHTML(jobLabel(job))}</div><div class="kv-v"><strong>${escapeHTML(job.status)}</strong> · ${Number(job.processed || 0)} object(s)<br><small class="mono">${escapeHTML(job.source || job.prefix || job.target || '')}</small></div></div>`).join('') : '<p>No background jobs have been created for this storage instance.</p>';
      await ui().alert({ html: `<div class="bb-details"><div class="bb-details-head"><i class="mdi mdi-progress-wrench"></i><div class="bb-details-titles"><div class="bb-details-name">Background jobs</div><div class="bb-details-prefix">Jobs are persisted and automatically resumed after a server restart.</div></div></div><div class="bb-details-body"><div class="bb-section bb-kv">${rows}</div></div></div>` });
      return true;
    } catch (error) {
      await ui().alert({ title: 'Background jobs', message: String(error.message || error) });
      return false;
    }
  }

  function formatMediaDuration(seconds) {
    const value = Number(seconds || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    const whole = Math.round(value);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const remaining = whole % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  function formatBitRate(bitsPerSecond) {
    const value = Number(bitsPerSecond || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 10e9 ? 1 : 2)} Gb/s`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 10e6 ? 1 : 2)} Mb/s`;
    if (value >= 1e3) return `${Math.round(value / 1e3).toLocaleString()} kb/s`;
    return `${Math.round(value).toLocaleString()} b/s`;
  }

  function metadataRow(label, value, mono = false) {
    if (value === undefined || value === null || String(value).trim() === '') return '';
    return `<div class="kv-row"><div class="kv-k">${escapeHTML(label)}</div><div class="kv-v${mono ? ' mono' : ''}">${escapeHTML(value)}</div></div>`;
  }

  function headerValue(headers, ...names) {
    const values = headers || {};
    for (const name of names) {
      const value = values[String(name).toLowerCase()];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
    }
    return '';
  }

  async function showMetadata(key, options = {}) {
    if (!(await requirePermissions(['read']))) return false;
    try {
      const result = await BB.api.mediaInfo(key, options);
      const headers = result.headers || {};
      const name = key.split('/').pop() || key;
      const type = BB.detect.resolveType(key, result.mime || '');
      const storageRows = [
        metadataRow('Size', formatBytes(result.size)),
        metadataRow('MIME type', result.mime || '—'),
        metadataRow('Modified', headerValue(headers, 'last-modified')),
        metadataRow('ETag', headerValue(headers, 'etag'), true),
        metadataRow('Version', headerValue(headers, 'x-amz-version-id', 'x-goog-generation'), true)
      ].filter(Boolean).join('');

      const customMetadata = Object.entries(headers)
        .filter(([header]) => /^(?:x-amz-meta-|x-goog-meta-)/i.test(header))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([header, value]) => metadataRow(header.replace(/^(?:x-amz-meta-|x-goog-meta-)/i, ''), value, true))
        .join('');

      const rows = [];
      if (Number(result.width || 0) > 0 && Number(result.height || 0) > 0) {
        rows.push(['Resolution', `${Number(result.width).toLocaleString()} × ${Number(result.height).toLocaleString()} px`]);
      }
      const duration = formatMediaDuration(result.durationSeconds);
      if (duration) rows.push(['Duration', duration]);
      if (Array.isArray(result.codecs) && result.codecs.length) rows.push(['Codecs', result.codecs.join(', ')]);
      if (result.container) rows.push(['Container', result.container]);
      Object.entries(result.properties || {}).forEach(([label, value]) => {
        if (value !== undefined && value !== null && String(value).trim() !== '') rows.push([label, String(value)]);
      });
      (result.tracks || []).forEach((track, index) => {
        const parts = [];
        if (track.label && track.label !== track.title) parts.push(track.label);
        if (track.codec) parts.push(track.profile ? `${track.codec} (${track.profile})` : track.codec);
        if (track.language) parts.push(String(track.language).toUpperCase());
        if (track.width && track.height) parts.push(`${Number(track.width).toLocaleString()} × ${Number(track.height).toLocaleString()}`);
        if (track.frameRate) parts.push(`${track.frameRate} fps`);
        if (track.pixelFormat) parts.push(track.pixelFormat);
        if (track.channelLayout) parts.push(track.channelLayout);
        else if (track.channels) parts.push(`${track.channels} channel${Number(track.channels) === 1 ? '' : 's'}`);
        if (track.sampleRate) parts.push(`${Number(track.sampleRate).toLocaleString()} Hz`);
        if (track.bitRate) parts.push(formatBitRate(track.bitRate));
        if (track.title) parts.push(track.title);
        if (track.default) parts.push('default');
        if (track.forced) parts.push('forced');
        if (track.subtitleMode === 'webvtt') parts.push('selectable in preview');
        if (track.subtitleMode === 'burn') parts.push('rendered when selected');
        const kind = String(track.type || 'track');
        const streamNumber = Number.isFinite(Number(track.index)) ? Number(track.index) + 1 : index + 1;
        rows.push([`${kind.charAt(0).toUpperCase()}${kind.slice(1)} track ${streamNumber}`, parts.join(' · ') || 'Detected']);
      });
      const fileRows = rows.map(([label, value]) => metadataRow(label, value)).join('');

      const storageSection = `<section class="bb-details-section"><div class="bb-details-section-title"><i class="mdi mdi-database-outline"></i> Storage object</div><div class="bb-kv">${storageRows}</div></section>`;
      const customSection = customMetadata
        ? `<section class="bb-details-section"><div class="bb-details-section-title"><i class="mdi mdi-tag-multiple-outline"></i> Custom metadata</div><div class="bb-kv">${customMetadata}</div></section>`
        : '';
      const fileSection = fileRows
        ? `<section class="bb-details-section"><div class="bb-details-section-title"><i class="mdi mdi-file-search-outline"></i> File metadata</div><div class="bb-kv">${fileRows}</div></section>`
        : '';
      const icon = BB.detect.iconForType(type);

      await ui().alert({
        html: `<div class="bb-details">
          <div class="bb-details-head"><i class="mdi mdi-${escapeHTML(icon)}"></i><div class="bb-details-titles"><div class="bb-details-name">${escapeHTML(name)}</div><div class="bb-details-prefix">${escapeHTML(key)}</div></div></div>
          <div class="bb-details-body">${storageSection}${customSection}${fileSection}</div>
        </div>`
      });
      return true;
    } catch (error) {
      await ui().alert({ title: 'File details', message: String(error.message || error) });
      return false;
    }
  }

  async function showPrefixDetails(prefix) {
    if (!(await requirePermissions(['read']))) return false;
    try {
      const created = await BB.api.stats(ensurePrefix(prefix));
      const completed = await waitForJob(created, 'Computing folder details');
      if (completed.status !== 'completed') return false;
      const stats = completed.stats || {};
      const typeRows = Object.entries(stats.byType || {})
        .sort(([, a], [, b]) => (b.bytes || 0) - (a.bytes || 0))
        .map(([name, value]) => `<div class="kv-row"><div class="kv-k">${escapeHTML(name)}</div><div class="kv-v">${value.count} object(s), ${formatBytes(value.bytes)}</div></div>`)
        .join('');
      await ui().alert({
        html: `<div class="bb-details bb-details--prefix">
          <div class="bb-details-head"><i class="mdi mdi-folder-outline"></i><div class="bb-details-titles"><div class="bb-details-name">/${escapeHTML(prefix || '')}</div></div></div>
          <div class="bb-details-body"><div class="bb-section bb-kv">
            <div class="kv-row"><div class="kv-k">Objects</div><div class="kv-v">${stats.count}</div></div>
            <div class="kv-row"><div class="kv-k">Total size</div><div class="kv-v">${formatBytes(stats.totalBytes)}</div></div>
            <div class="kv-row"><div class="kv-k">Computed in</div><div class="kv-v">${stats.tookMs} ms</div></div>
            ${typeRows}
          </div></div>
        </div>`
      });
      return true;
    } catch (error) {
      showTaskFailure('Folder details', error);
      return false;
    }
  }

  async function copyObject(key) {
    if (!(await requirePermissions(['read', 'write']))) return false;
    const current = key.split('/').pop() || key;
    const targetName = await ui().prompt({ title: 'Copy file', message: 'New name', defaultValue: `${current}-copy` });
    if (!targetName || targetName === current) return false;
    const target = dirOf(key) + targetName;
    const notification = ui().toast(`Copying ${current}...`, {
      persistent: true,
      status: 'loading',
      indeterminate: true,
      detail: target
    });
    try {
      await BB.api.copy({ src: key, dst: target });
      notification.update('Copy completed.', {
        persistent: false,
        status: 'success',
        progress: 1,
        indeterminate: false,
        detail: target,
        duration: 4500
      });
      return target;
    } catch (error) {
      notification.update(`Copy failed: ${String(error.message || error)}`, {
        persistent: false,
        status: 'error',
        progress: null,
        indeterminate: false,
        detail: target,
        duration: 6500
      });
      return false;
    }
  }

  async function renameObject(key) {
    if (!(await requirePermissions(['read', 'write', 'delete']))) return false;
    const current = key.split('/').pop() || key;
    const targetName = await ui().prompt({ title: 'Rename file', message: 'New name', defaultValue: current });
    if (!targetName || targetName === current) return false;
    const target = dirOf(key) + targetName;
    const notification = ui().toast(`Renaming ${current}...`, {
      persistent: true,
      status: 'loading',
      indeterminate: true,
      detail: target
    });
    try {
      await BB.api.rename({ src: key, dst: target });
      notification.update('File renamed.', {
        persistent: false,
        status: 'success',
        progress: 1,
        indeterminate: false,
        detail: target,
        duration: 4500
      });
      return target;
    } catch (error) {
      notification.update(`Rename failed: ${String(error.message || error)}`, {
        persistent: false,
        status: 'error',
        progress: null,
        indeterminate: false,
        detail: target,
        duration: 6500
      });
      return false;
    }
  }

  async function deleteObject(key) {
    if (!(await requirePermissions(['delete']))) return false;
    const confirmed = await ui().confirm({ title: 'Delete file', message: `Permanently delete "${key}"?` });
    if (!confirmed) return false;
    const notification = ui().toast(`Deleting ${key.split('/').pop() || key}...`, {
      persistent: true,
      status: 'loading',
      indeterminate: true,
      detail: key
    });
    try {
      await BB.api.del(key);
      notification.update('File deleted.', {
        persistent: false,
        status: 'success',
        progress: 1,
        indeterminate: false,
        detail: key,
        duration: 4500
      });
      return true;
    } catch (error) {
      notification.update(`Delete failed: ${String(error.message || error)}`, {
        persistent: false,
        status: 'error',
        progress: null,
        indeterminate: false,
        detail: key,
        duration: 6500
      });
      return false;
    }
  }

  async function copyPrefix(prefix) {
    if (!(await requirePermissions(['read', 'write']))) return false;
    const source = ensurePrefix(prefix);
    const current = source.split('/').filter(Boolean).pop() || 'folder';
    const parent = source.slice(0, Math.max(0, source.length - current.length - 1));
    const targetName = await ui().prompt({ title: 'Copy folder', message: 'New name', defaultValue: `${current}-copy` });
    if (!targetName) return false;
    const target = ensurePrefix(parent + targetName);
    try {
      const created = await BB.api.copy({ src: source, dst: target, isPrefix: true });
      const result = await waitForJob(created, 'Copying folder');
      return result.status === 'completed' ? target : false;
    } catch (error) {
      showTaskFailure('Copying folder', error);
      return false;
    }
  }

  async function renamePrefix(prefix) {
    if (!(await requirePermissions(['read', 'write', 'delete']))) return false;
    const source = ensurePrefix(prefix);
    const current = source.split('/').filter(Boolean).pop() || 'folder';
    const parent = source.slice(0, Math.max(0, source.length - current.length - 1));
    const targetName = await ui().prompt({ title: 'Rename folder', message: 'New name', defaultValue: current });
    if (!targetName || targetName === current) return false;
    const target = ensurePrefix(parent + targetName);
    try {
      const created = await BB.api.rename({ src: source, dst: target, isPrefix: true });
      const result = await waitForJob(created, 'Moving folder');
      return result.status === 'completed' ? target : false;
    } catch (error) {
      showTaskFailure('Moving folder', error);
      return false;
    }
  }

  async function deletePrefix(prefix) {
    if (!(await requirePermissions(['read', 'delete']))) return false;
    const source = ensurePrefix(prefix);
    const confirmed = await ui().confirm({ title: 'Delete folder', message: `Permanently delete "${source}" and all of its contents?` });
    if (!confirmed) return false;
    try {
      const created = await BB.api.deletePrefix(source);
      const result = await waitForJob(created, 'Deleting folder');
      return result.status === 'completed';
    } catch (error) {
      showTaskFailure('Deleting folder', error);
      return false;
    }
  }

  async function downloadObject(key, filename) {
    if (!allowed('read')) return false;
    const safeFilename = filename || key.split('/').pop() || 'download';
    const downloadURL = BB.api.urlForKey(key, BB.api.getInstance());
    const target = await pickSaveTarget(safeFilename);
    if (target.canceled) return false;

    const group = transferGroup('download');
    const id = `download-${Date.now().toString(36)}-${++downloadSequence}`;
    let controller = null;
    let resumeState = null;
    let running = false;
    let pauseRequested = false;
    let cancelRequested = false;
    let settled = false;
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });

    const item = group.add({
      id,
      name: safeFilename,
      status: 'queued',
      progress: null,
      indeterminate: true,
      detail: 'Queued...',
      onPause: pause,
      onResume: resume,
      onCancel: cancel
    });

    function finish(value) {
      if (settled) return;
      settled = true;
      resolveCompletion(value);
    }

    function currentProgress() {
      const receivedBytes = Number(resumeState?.receivedBytes || 0);
      const totalBytes = Number(resumeState?.totalBytes || 0);
      return totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : null;
    }

    function pause() {
      if (settled || pauseRequested || !running) return;
      pauseRequested = true;
      cancelRequested = false;
      item.update({
        status: 'preparing',
        progress: currentProgress(),
        indeterminate: currentProgress() == null,
        detail: 'Pausing at the last received byte...'
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
          progress: currentProgress(),
          indeterminate: currentProgress() == null,
          detail: 'Canceling download...'
        });
        controller?.abort();
      } else {
        item.canceled({ detail: safeFilename });
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
        progress: currentProgress(),
        indeterminate: currentProgress() == null,
        detail: resumeState?.receivedBytes ? 'Resuming download...' : 'Starting download...',
        onPause: pause,
        onResume: resume,
        onCancel: cancel
      });

      try {
        const result = await streamURL(downloadURL, {
          signal: activeController.signal,
          resumeState,
          onCheckpoint(state) { resumeState = state; },
          onProgress(progress) {
            item.update({
              status: 'running',
              progress: progress.progress,
              indeterminate: progress.progress == null,
              detail: formatTransferDetail(progress),
              onPause: pause,
              onResume: resume,
              onCancel: cancel
            });
          }
        });
        resumeState = result.state;
        if (cancelRequested || activeController.signal.aborted) throw abortError();
        await saveBlob(result.blob, safeFilename, target.handle);
        item.complete({
          detail: formatTransferDetail({
            transferredBytes: result.receivedBytes,
            totalBytes: result.totalBytes || result.receivedBytes,
            speedBps: result.speedBps,
            etaSeconds: 0
          }),
          duration: 6000
        });
        finish(true);
      } catch (error) {
        if (error?.transferState) resumeState = error.transferState;
        if (isAbortError(error) || activeController.signal.aborted) {
          if (cancelRequested) {
            item.canceled({ detail: safeFilename });
            finish(false);
          } else {
            item.update({
              status: 'paused',
              progress: currentProgress(),
              indeterminate: false,
              detail: `${formatTransferDetail({
                receivedBytes: resumeState?.receivedBytes,
                totalBytes: resumeState?.totalBytes,
                speedBps: resumeState?.speedBps
              })} · Resume continues with an HTTP range request.`,
              onPause: pause,
              onResume: resume,
              onCancel: cancel
            });
          }
        } else {
          item.fail({
            progress: currentProgress(),
            detail: String(error?.message || error || 'Download failed'),
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
  }

  BB.actions = {
    showMetadata,
    showFileDetails: showMetadata,
    showPrefixDetails,
    copyObject,
    renameObject,
    deleteObject,
    copyPrefix,
    renamePrefix,
    deletePrefix,
    showJobs,
    waitForJob,
    downloadObject,
    pickSaveTarget,
    saveBlob,
    streamURL,
    fetchBytes,
    formatTransferDetail,
    formatBytes,
    isAbortError,
    moveToTrash: async () => false
  };
})();
