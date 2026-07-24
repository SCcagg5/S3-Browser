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
      const subject = String(label || 'Insights').replace(/^Computing\s+/i, '').trim() || 'insights';
      return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ready: ${count} object(s), ${formatBytes(job.stats.totalBytes || 0)}.`;
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
    const name = key.split('/').pop() || key;
    let detailsNotification = null;
    const notificationTimer = window.setTimeout(() => {
      detailsNotification = ui().toast(`Loading details for ${name}...`, {
        persistent: true,
        status: 'loading',
        indeterminate: true,
        detail: key
      });
    }, 300);
    try {
      const result = await BB.api.mediaInfo(key, options);
      const headers = result.headers || {};
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
      const extension = BB.detect.extOf(key);
      const countAction = ['json', 'geojson'].includes(extension)
        ? { label: 'Count lines', icon: 'format-list-numbered', kind: 'lines' }
        : (['csv', 'tsv', 'tab', 'psv'].includes(extension)
          ? { label: 'Count rows and columns', icon: 'table-row', kind: 'delimited' }
          : null);

      const storageSection = `<section class="bb-details-section"><div class="bb-details-section-title"><i class="mdi mdi-database-outline"></i> Storage object</div><div class="bb-kv">${storageRows}</div></section>`;
      const customSection = customMetadata
        ? `<section class="bb-details-section"><div class="bb-details-section-title"><i class="mdi mdi-tag-multiple-outline"></i> Custom metadata</div><div class="bb-kv">${customMetadata}</div></section>`
        : '';
      const fileSection = fileRows
        ? `<section class="bb-details-section"><div class="bb-details-section-title"><i class="mdi mdi-file-search-outline"></i> File metadata</div><div class="bb-kv">${fileRows}</div></section>`
        : '';
      const countSection = countAction
        ? `<section class="bb-details-section bb-details-count-section"><div class="bb-details-section-title"><i class="mdi mdi-${escapeHTML(countAction.icon)}"></i> Document dimensions</div><div class="bb-details-count-result" data-document-count-result><span>Not calculated. This operation reads the complete document.</span></div><button type="button" class="bb-btn bb-details-count-button" data-document-count>${escapeHTML(countAction.label)}</button></section>`
        : '';
      const icon = BB.detect.iconForType(type);

      window.clearTimeout(notificationTimer);
      if (detailsNotification) {
        detailsNotification.update('File details ready.', {
          persistent: false,
          status: 'success',
          progress: 1,
          indeterminate: false,
          detail: name,
          duration: 1400
        });
      }
      await ui().alert({
        html: `<div class="bb-details">
          <div class="bb-details-head"><i class="mdi mdi-${escapeHTML(icon)}"></i><div class="bb-details-titles"><div class="bb-details-name">${escapeHTML(name)}</div><div class="bb-details-prefix">${escapeHTML(key)}</div></div></div>
          <div class="bb-details-body">${storageSection}${customSection}${fileSection}${countSection}</div>
        </div>`,
        onOpen: countAction ? ({ overlay }) => {
          const button = overlay.querySelector('[data-document-count]');
          const resultHost = overlay.querySelector('[data-document-count-result]');
          if (!button || !resultHost) return;
          button.addEventListener('click', async () => {
            if (button.disabled) return;
            button.disabled = true;
            button.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i><span>Calculating…</span>';
            resultHost.textContent = 'Reading the complete document…';
            try {
              const count = await BB.api.documentCount({ key, instance: options.instance ?? null });
              resultHost.replaceChildren();
              if (countAction.kind === 'lines') {
                resultHost.insertAdjacentHTML('beforeend', `<div class="bb-kv">${metadataRow('Lines', Number(count.lines || 0).toLocaleString())}</div>`);
              } else {
                resultHost.insertAdjacentHTML('beforeend', `<div class="bb-kv">${metadataRow('Rows', Number(count.rows || 0).toLocaleString())}${metadataRow('Columns', Number(count.columns || 0).toLocaleString())}</div>`);
              }
              button.innerHTML = '<i class="mdi mdi-check"></i><span>Calculated</span>';
            } catch (countError) {
              resultHost.textContent = String(countError?.message || countError);
              button.disabled = false;
              button.innerHTML = `<i class="mdi mdi-alert-circle-outline"></i><span>${escapeHTML(countAction.label)}</span>`;
            }
          });
        } : null
      });
      return true;
    } catch (error) {
      window.clearTimeout(notificationTimer);
      if (detailsNotification) {
        detailsNotification.update('Could not load file details.', {
          persistent: false,
          status: 'error',
          progress: null,
          indeterminate: false,
          detail: String(error.message || error),
          duration: 6500
        });
      }
      await ui().alert({ title: 'File details', message: String(error.message || error) });
      return false;
    } finally {
      window.clearTimeout(notificationTimer);
    }
  }

  function statsTypeEntries(stats) {
    return Object.entries(stats?.byType || {})
      .map(([name, value]) => ({
        name: String(name || 'other'),
        count: Math.max(0, Number(value?.count || 0)),
        bytes: Math.max(0, Number(value?.bytes || 0))
      }))
      .filter(entry => entry.count > 0 || entry.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes || right.count - left.count || left.name.localeCompare(right.name));
  }

  function statsColor(index) {
    const hue = (210 + index * 47) % 360;
    return `hsl(${hue} 66% 55%)`;
  }

  function distributionEntries(entries, field, maximum = 7) {
    const source = Array.from(entries || []);
    const ordered = source
      .map((entry, colorIndex) => ({ ...entry, colorIndex }))
      .filter(entry => Number(entry?.[field] || 0) > 0)
      .sort((left, right) => Number(right[field] || 0) - Number(left[field] || 0) || left.name.localeCompare(right.name));
    if (ordered.length <= maximum) return ordered;
    const visible = ordered.slice(0, Math.max(1, maximum - 1));
    const hidden = ordered.slice(visible.length);
    visible.push({
      name: visible.some(entry => entry.name === 'other') ? 'other types' : 'other',
      count: hidden.reduce((sum, entry) => sum + Number(entry.count || 0), 0),
      bytes: hidden.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0),
      colorIndex: source.length
    });
    return visible;
  }

  function distributionHTML(entries, field, title) {
    const displayed = distributionEntries(entries, field);
    const total = displayed.reduce((sum, entry) => sum + Number(entry[field] || 0), 0);
    if (!(total > 0)) return '';
    const segments = displayed.map((entry, index) => {
      const percent = Number(entry[field] || 0) * 100 / total;
      const detail = field === 'bytes' ? formatBytes(entry.bytes) : `${entry.count.toLocaleString()} object(s)`;
      return `<span class="folder-distribution-segment" style="--segment-width:${percent}%;--segment-color:${statsColor(entry.colorIndex ?? index)}" title="${escapeHTML(`${entry.name}: ${percent.toFixed(1)}% · ${detail}`)}"></span>`;
    }).join('');
    const legend = displayed.map((entry, index) => {
      const percent = Number(entry[field] || 0) * 100 / total;
      const detail = field === 'bytes' ? formatBytes(entry.bytes) : `${entry.count.toLocaleString()} object(s)`;
      return `<div class="folder-distribution-legend-item"><span class="folder-distribution-swatch" style="--segment-color:${statsColor(entry.colorIndex ?? index)}"></span><span class="folder-distribution-label">${escapeHTML(entry.name)}</span><span class="folder-distribution-value">${percent.toFixed(1)}% · ${escapeHTML(detail)}</span></div>`;
    }).join('');
    return `<section class="folder-distribution"><div class="folder-distribution-title">${escapeHTML(title)}</div><div class="folder-distribution-bar" role="img" aria-label="${escapeHTML(title)}">${segments}</div><div class="folder-distribution-legend">${legend}</div></section>`;
  }

  const treemapMinimumShare = 0.01;
  const treemapMaximumRectangles = 1000;
  const treemapMaximumDepth = 5;

  function treemapObjectCount(value) {
    const count = Math.max(0, Number(value || 0));
    return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
  }

  function treemapFolderNode(name, path) {
    return {
      name,
      path,
      bytes: 0,
      count: 0,
      children: new Map(),
      folder: true,
      type: 'folder',
      aggregateKnown: false
    };
  }

  function normalizedStatsFolderPath(value, cleanPrefix) {
    let relative = String(value || '').replace(/^\/+/, '');
    if (!relative || relative === '(root)') return '';
    if (cleanPrefix && relative.startsWith(cleanPrefix)) relative = relative.slice(cleanPrefix.length);
    return ensurePrefix(relative);
  }

  function ensureTreemapFolder(root, parts, cleanPrefix) {
    let parent = root;
    let pathValue = cleanPrefix;
    for (const part of parts) {
      pathValue += `${part}/`;
      const key = `folder:${part}`;
      let child = parent.children.get(key);
      if (!child) {
        child = treemapFolderNode(part, pathValue);
        parent.children.set(key, child);
      }
      parent = child;
    }
    return parent;
  }

  function finalizeTreemapNode(node) {
    let childBytes = 0;
    let childCount = 0;
    for (const child of node.children?.values?.() || []) {
      finalizeTreemapNode(child);
      childBytes += Math.max(0, Number(child.bytes || 0));
      childCount += Math.max(0, Number(child.count || 0));
    }
    if (node.folder) {
      if (!node.aggregateKnown) {
        node.bytes = childBytes;
        node.count = childCount;
      } else {
        // A malformed or legacy response must never make a child larger than
        // its parent. Keeping the larger value also prevents negative local
        // "Others" totals without issuing another storage request.
        node.bytes = Math.max(Number(node.bytes || 0), childBytes);
        node.count = Math.max(Number(node.count || 0), childCount);
      }
    }
  }

  function buildTreemapTree(stats, prefix) {
    const cleanPrefix = ensurePrefix(prefix);
    const root = treemapFolderNode(cleanPrefix || '/', cleanPrefix);
    root.bytes = Math.max(0, Number(stats?.totalBytes || 0));
    root.count = Math.max(0, Number(stats?.count || 0));
    root.aggregateKnown = true;

    const folders = Object.entries(stats?.byFolder || {})
      .map(([path, value]) => ({
        path: normalizedStatsFolderPath(path, cleanPrefix),
        bytes: Math.max(0, Number(value?.bytes || 0)),
        count: Math.max(0, Number(value?.count || 0))
      }))
      .filter(entry => entry.path)
      .sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));

    for (const entry of folders) {
      const parts = entry.path.split('/').filter(Boolean);
      if (!parts.length) continue;
      const folder = ensureTreemapFolder(root, parts, cleanPrefix);
      folder.bytes = entry.bytes;
      folder.count = entry.count;
      folder.aggregateKnown = true;
    }

    for (const entry of Array.from(stats?.largest || []).slice(0, treemapMaximumRectangles)) {
      const fullPath = String(entry?.path || '').replace(/^\/+/, '');
      if (!fullPath || (cleanPrefix && !fullPath.startsWith(cleanPrefix))) continue;
      const relative = cleanPrefix ? fullPath.slice(cleanPrefix.length) : fullPath;
      const parts = relative.split('/').filter(Boolean);
      if (!parts.length) continue;
      const fileName = parts.pop();
      const parent = ensureTreemapFolder(root, parts, cleanPrefix);
      const bytes = Math.max(0, Number(entry?.bytes || 0));
      parent.children.set(`file:${fileName}`, {
        name: fileName,
        path: fullPath,
        bytes,
        count: 1,
        children: new Map(),
        folder: false,
        type: String(entry?.type || 'other'),
        mime: String(entry?.mime || ''),
        etag: String(entry?.etag || ''),
        lastModified: String(entry?.lastModified || '')
      });
    }

    finalizeTreemapNode(root);
    return root;
  }

  function groupedTreemapChildren(node) {
    if (!node?.folder) return [];
    const children = Array.from(node.children?.values?.() || [])
      .filter(child => Number(child.bytes || 0) > 0)
      .sort((left, right) => Number(right.bytes || 0) - Number(left.bytes || 0) || left.name.localeCompare(right.name));
    if (!children.length && !(Number(node.bytes || 0) > 0)) return [];

    const totalBytes = Math.max(0, Number(node.bytes || 0));
    const totalCount = Math.max(0, Number(node.count || 0));
    const listedBytes = children.reduce((sum, child) => sum + Math.max(0, Number(child.bytes || 0)), 0);
    const listedCount = children.reduce((sum, child) => sum + Math.max(0, Number(child.count || 0)), 0);
    let otherBytes = Math.max(0, totalBytes - listedBytes);
    let otherCount = Math.max(0, totalCount - listedCount);
    const visible = [];
    const threshold = totalBytes * treemapMinimumShare;

    for (const child of children) {
      // The requirement is deliberately strict: an item representing exactly
      // one percent belongs to the local "Others" rectangle.
      if (Number(child.bytes || 0) > threshold) {
        visible.push(child);
      } else {
        otherBytes += Math.max(0, Number(child.bytes || 0));
        otherCount += Math.max(0, Number(child.count || 0));
      }
    }

    if (otherBytes > 0 || otherCount > 0) {
      visible.push({
        name: 'Others',
        path: node.path,
        bytes: otherBytes,
        count: otherCount,
        children: new Map(),
        folder: false,
        type: 'other',
        other: true
      });
    }
    return visible.sort((left, right) => Number(right.bytes || 0) - Number(left.bytes || 0) || left.name.localeCompare(right.name));
  }

  function treemapColorIndex(node) {
    const value = String(node?.type || node?.path || node?.name || 'other');
    let hash = 0;
    for (let index = 0; index < value.length; index++) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    return Math.abs(hash) % 29;
  }

  function splitTreemapNodes(nodes) {
    if (nodes.length < 2) return [nodes, []];
    const total = nodes.reduce((sum, node) => sum + Math.max(0, Number(node.bytes || 0)), 0) || 1;
    const target = total / 2;
    let sum = 0;
    let split = 1;
    for (let index = 0; index < nodes.length - 1; index++) {
      const next = sum + Math.max(0, Number(nodes[index].bytes || 0));
      if (index > 0 && Math.abs(target - sum) <= Math.abs(target - next)) {
        split = index;
        break;
      }
      sum = next;
      split = index + 1;
    }
    split = Math.max(1, Math.min(nodes.length - 1, split));
    return [nodes.slice(0, split), nodes.slice(split)];
  }

  function layoutTreemapGroup(nodes, x, y, width, height, depth, output) {
    if (output.length >= treemapMaximumRectangles) return;
    const visible = Array.from(nodes || []).filter(node => node.bytes > 0);
    if (!visible.length || width < 0.15 || height < 0.15) return;
    if (visible.length === 1) {
      collectTreemapRectangles(visible[0], x, y, width, height, depth, output);
      return;
    }
    const [first, second] = splitTreemapNodes(visible);
    const firstBytes = first.reduce((sum, node) => sum + node.bytes, 0);
    const total = firstBytes + second.reduce((sum, node) => sum + node.bytes, 0) || 1;
    const ratio = Math.max(0.02, Math.min(0.98, firstBytes / total));
    if (width >= height) {
      const firstWidth = width * ratio;
      layoutTreemapGroup(first, x, y, firstWidth, height, depth, output);
      layoutTreemapGroup(second, x + firstWidth, y, width - firstWidth, height, depth, output);
    } else {
      const firstHeight = height * ratio;
      layoutTreemapGroup(first, x, y, width, firstHeight, depth, output);
      layoutTreemapGroup(second, x, y + firstHeight, width, height - firstHeight, depth, output);
    }
  }

  function collectTreemapRectangles(node, x, y, width, height, depth, output) {
    if (output.length >= treemapMaximumRectangles || width < 0.15 || height < 0.15 || node.bytes <= 0) return;
    const children = groupedTreemapChildren(node);
    const isLeaf = !children.length || depth >= treemapMaximumDepth;
    const kind = node.other ? 'other' : (isLeaf && !node.folder ? 'file' : 'folder');
    const color = node.folder && !isLeaf
      ? `hsl(${(215 + depth * 19) % 360} 28% ${92 - depth * 3}%)`
      : statsColor(treemapColorIndex(node));
    const countLabel = treemapObjectCount(node.count);
    const titlePath = node.other ? `${node.path || '/'} — Others` : (node.path || node.name);
    const title = `${titlePath}\n${formatBytes(node.bytes)} · ${countLabel}`;
    const sizeLabel = formatBytes(node.bytes);
    const detail = countLabel;

    // Reserve a real title strip for parent folders. The strip is expressed as
    // a percentage of the node itself so its label can never cover descendants.
    const header = !isLeaf && height > 2.2 ? Math.min(3.3, Math.max(1.25, height * 0.2)) : 0;
    const headerRatio = height > 0 ? Math.max(0, Math.min(100, header / height * 100)) : 0;
    const label = `<span class="folder-treemap-label"><strong><span class="folder-treemap-name">${escapeHTML(node.name)}</span><span class="folder-treemap-size">${escapeHTML(sizeLabel)}</span></strong><small>${escapeHTML(detail)}</small></span>`;
    output.push(`<div class="folder-treemap-node is-${kind}" data-kind="${kind}" data-depth="${depth}" data-header-ratio="${headerRatio}" data-path="${escapeHTML(node.path || '')}" data-size="${Math.max(0, Number(node.bytes || 0))}" data-count="${Math.max(0, Number(node.count || 0))}" data-mime="${escapeHTML(node.mime || '')}" data-etag="${escapeHTML(node.etag || '')}" data-modified="${escapeHTML(node.lastModified || '')}" title="${escapeHTML(title)}" style="left:${x}%;top:${y}%;width:${width}%;height:${height}%;z-index:${depth};--treemap-color:${color};--treemap-header:${headerRatio}%">${label}</div>`);
    if (isLeaf || output.length >= treemapMaximumRectangles) return;

    // Children are flat siblings in the root coordinate system. Deeper nodes
    // stay above their parent, while the parent's title remains confined to the
    // reserved strip calculated above.
    const insetX = Math.min(.22, width * .02);
    const insetBottom = Math.min(.25, height * .02);
    const innerX = x + insetX;
    const innerY = y + header;
    const innerWidth = Math.max(0, width - insetX * 2);
    const innerHeight = Math.max(0, height - header - insetBottom);
    layoutTreemapGroup(children, innerX, innerY, innerWidth, innerHeight, depth + 1, output);
  }

  function fitTreemapLabels(map) {
    if (!map) return;
    map.querySelectorAll('.folder-treemap-node').forEach(node => {
      const label = node.querySelector('.folder-treemap-label');
      if (!label) return;
      const detail = label.querySelector('small');
      const rect = node.getBoundingClientRect();
      const headerRatio = Math.max(0, Math.min(100, Number(node.dataset.headerRatio || 0)));
      const labelHeight = node.dataset.kind === 'folder' && headerRatio > 0
        ? rect.height * headerRatio / 100
        : rect.height;
      label.style.maxHeight = `${Math.max(0, labelHeight)}px`;
      label.classList.remove('is-hidden', 'is-compact', 'is-tiny', 'is-micro', 'is-vertical');
      if (detail) detail.hidden = false;

      // Keep a readable name on every rectangle that has a physically usable
      // strip. Thin horizontal cells use a micro one-line label; tall narrow
      // cells rotate the name. Only genuinely sub-pixel cells are hidden.
      if (rect.width < 9 || labelHeight < 6) {
        label.classList.add('is-hidden');
        return;
      }
      if (rect.width < 24 && labelHeight >= 34) {
        label.classList.add('is-vertical');
        if (detail) detail.hidden = true;
        return;
      }
      if (rect.width < 48 || labelHeight < 15) {
        label.classList.add('is-micro');
        if (detail) detail.hidden = true;
      } else if (rect.width < 78 || labelHeight < 31) {
        label.classList.add('is-compact');
        if (detail) detail.hidden = true;
      }
      // A long filename must never flow into a neighbouring rectangle. Reduce
      // the type once before relying on ellipsis inside the measured node.
      if (label.scrollWidth > Math.max(1, rect.width - 4) && !label.classList.contains('is-micro')) {
        label.classList.add('is-tiny');
        if (detail) detail.hidden = true;
      }
    });
  }

  function navigateFromStats(metadata) {
    const clean = String(metadata?.path || '').replace(/^\/+/, '');
    const kind = String(metadata?.kind || '');
    if (!clean) return;
    if (kind === 'folder') {
      location.hash = encodeURIComponent(ensurePrefix(clean)).replace(/%2F/gi, '/');
      return;
    }
    const url = new URL('preview.html', location.href);
    const instance = BB.api.getInstance();
    if (instance) url.searchParams.set('instance', instance);
    url.searchParams.set('listed', '1');
    url.searchParams.set('size', String(Math.max(0, Number(metadata?.size || 0))));
    if (metadata?.mime) url.searchParams.set('mime', String(metadata.mime));
    if (metadata?.etag) url.searchParams.set('etag', String(metadata.etag));
    if (metadata?.modified) url.searchParams.set('lastModified', String(metadata.modified));
    url.hash = encodeURIComponent(clean).replace(/%2F/gi, '/');
    location.href = url.pathname + url.search + url.hash;
  }

  async function collectPrefixStats(prefix, label) {
    const created = await BB.api.stats(ensurePrefix(prefix));
    const completed = await waitForJob(created, label);
    if (completed.status !== 'completed') return null;
    return completed.stats || {};
  }

  async function showPrefixInsights(prefix, initialTab = 'overview') {
    if (!(await requirePermissions(['read']))) return false;
    const cleanPrefix = ensurePrefix(prefix);
    const isRoot = !cleanPrefix;
    const scopeTitle = isRoot ? 'Storage insights' : 'Folder insights';
    const scopePath = isRoot ? 'Storage root' : `/${cleanPrefix}`;
    try {
      const stats = await collectPrefixStats(cleanPrefix, isRoot ? 'Computing storage insights' : 'Computing folder insights');
      if (!stats) return false;
      const entries = statsTypeEntries(stats);
      const tree = buildTreemapTree(stats, cleanPrefix);
      // Apply the same local <=1% aggregation at the selected scope root as
      // at every nested folder. Previously root children bypassed
      // groupedTreemapChildren(), so a tiny top-level folder could still be
      // rendered individually while equally small nested entries became
      // local Others rectangles.
      const nodes = groupedTreemapChildren(tree);
      const rectangleList = [];
      layoutTreemapGroup(nodes, 0, 0, 100, 100, 1, rectangleList);
      const rectangles = rectangleList.join('');
      const insightID = `folder-insights-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const requestedTab = initialTab === 'treemap' ? 'treemap' : 'overview';
      const dialog = ui().alert({
        html: `<div id="${insightID}" class="bb-details bb-details--treemap bb-details--insights" data-initial-tab="${requestedTab}">
          <div class="bb-details-head"><i class="mdi mdi-${isRoot ? 'database-outline' : 'chart-box-outline'}"></i><div class="bb-details-titles"><div class="bb-details-name">${scopeTitle}</div><div class="bb-details-prefix">${escapeHTML(scopePath)} · ${Number(stats.count || 0).toLocaleString()} objects · ${escapeHTML(formatBytes(stats.totalBytes || 0))}</div></div></div>
          <div class="bb-details-body">
            <div class="spreadsheet-tabs folder-insights-tabs" role="tablist" aria-label="${scopeTitle}">
              <button type="button" class="spreadsheet-tab" role="tab" data-insights-tab="overview"><i class="mdi mdi-chart-donut"></i><span>Overview</span></button>
              <button type="button" class="spreadsheet-tab" role="tab" data-insights-tab="treemap"><i class="mdi mdi-chart-tree"></i><span>Treemap</span></button>
            </div>
            <section class="folder-insights-panel" data-insights-panel="overview">
              <div class="folder-details-summary" role="group" aria-label="Scope totals">
                <div class="folder-details-metric"><span>Objects</span><strong>${Number(stats.count || 0).toLocaleString()}</strong></div>
                <div class="folder-details-metric"><span>Total size</span><strong>${escapeHTML(formatBytes(stats.totalBytes))}</strong></div>
              </div>
              <div class="folder-distribution-grid">${distributionHTML(entries, 'bytes', 'Distribution by size')}${distributionHTML(entries, 'count', 'Distribution by object count')}</div>
              <div class="folder-details-footer">Computed in ${Number(stats.tookMs || 0).toLocaleString()} ms</div>
            </section>
            <section class="folder-insights-panel" data-insights-panel="treemap" hidden>
              <div class="folder-treemap" role="img" aria-label="${scopeTitle} size treemap">${rectangles || '<div class="folder-treemap-empty">No objects found.</div>'}</div>
            </section>
          </div>
        </div>`
      });

      let resizeObserver = null;
      let resizeHandler = null;
      requestAnimationFrame(() => {
        const root = document.getElementById(insightID);
        if (!root) return;
        const modal = root.closest('.bb-modal');
        modal?.classList.add('bb-modal--wide');
        const map = root.querySelector('.folder-treemap');
        const tabs = Array.from(root.querySelectorAll('[data-insights-tab]'));
        const panels = Array.from(root.querySelectorAll('[data-insights-panel]'));
        const activate = tabName => {
          const next = tabName === 'treemap' ? 'treemap' : 'overview';
          tabs.forEach(tab => {
            const active = tab.dataset.insightsTab === next;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
          });
          panels.forEach(panel => { panel.hidden = panel.dataset.insightsPanel !== next; });
          if (next === 'treemap') requestAnimationFrame(() => fitTreemapLabels(map));
        };
        tabs.forEach(tab => tab.addEventListener('click', () => activate(tab.dataset.insightsTab)));
        activate(requestedTab);
        map?.addEventListener('click', event => {
          const node = event.target.closest('.folder-treemap-node[data-path]');
          if (!node || !node.dataset.path || node.dataset.kind === 'other') return;
          event.stopPropagation();
          modal?.querySelector('.bb-modal-x')?.click();
          navigateFromStats({
            path: node.dataset.path,
            kind: node.dataset.kind,
            size: node.dataset.size,
            mime: node.dataset.mime,
            etag: node.dataset.etag,
            modified: node.dataset.modified
          });
        });
        if (map && typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(() => fitTreemapLabels(map));
          resizeObserver.observe(map);
        } else if (map) {
          resizeHandler = () => fitTreemapLabels(map);
          window.addEventListener('resize', resizeHandler, { passive: true });
        }
      });
      await dialog;
      resizeObserver?.disconnect();
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      return true;
    } catch (error) {
      showTaskFailure(scopeTitle, error);
      return false;
    }
  }

  function showPrefixDetails(prefix) {
    return showPrefixInsights(prefix, 'overview');
  }

  function showPrefixStats(prefix) {
    return showPrefixInsights(prefix, 'treemap');
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
    showPrefixInsights,
    showPrefixDetails,
    showPrefixStats,
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
