/* User-facing object and prefix actions. */
(function () {
  const BB = (window.BB = window.BB || {});
  if (!BB.api || !BB.detect) throw new Error('BB.api and BB.detect are required before BB.actions');

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
  function allowed(name) {
    if (BB.capabilities?.actionable) return BB.capabilities.actionable(BB.cfg || {}, name);
    const capabilities = (BB.cfg && BB.cfg.capabilities) || {};
    return capabilities?.[name]?.allowed !== false;
  }
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

  function detailsToolState(card, statusHost, resultHost, state, message, title = '') {
    if (!card || !statusHost) return;
    const normalized = ['idle', 'loading', 'success', 'warning', 'error'].includes(state) ? state : 'idle';
    card.classList.remove('is-idle', 'is-loading', 'is-success', 'is-warning', 'is-error');
    card.classList.add(`is-${normalized}`);
    card.setAttribute('aria-busy', normalized === 'loading' ? 'true' : 'false');
    statusHost.hidden = false;
    statusHost.classList.remove('is-idle', 'is-loading', 'is-success', 'is-warning', 'is-error');
    statusHost.classList.add(`is-${normalized}`);
    const icon = normalized === 'loading'
      ? 'loading mdi-spin'
      : (normalized === 'success'
        ? 'check-circle-outline'
        : (normalized === 'warning'
          ? 'alert-circle-outline'
          : (normalized === 'error' ? 'close-circle-outline' : 'information-outline')));
    statusHost.innerHTML = `<i class="mdi mdi-${icon}"></i><div><strong>${escapeHTML(title || message)}</strong>${title && message ? `<span>${escapeHTML(message)}</span>` : ''}</div>`;
    if (resultHost) {
      resultHost.classList.toggle('is-previous', normalized === 'loading' && !resultHost.hidden && resultHost.innerHTML.trim() !== '');
    }
  }

  function detailsToolComplete(card, statusHost, resultHost, state, title, message, html) {
    if (!card?.isConnected || !statusHost?.isConnected || !resultHost?.isConnected) return false;
    detailsToolState(card, statusHost, resultHost, state, message, title);
    resultHost.hidden = false;
    resultHost.classList.remove('is-previous');
    resultHost.innerHTML = html;
    return true;
  }

  function detailsToolButton(button, state, label) {
    if (!button?.isConnected) return;
    button.disabled = state === 'loading';
    const icon = state === 'loading' ? 'loading mdi-spin' : (state === 'idle' ? 'play' : 'refresh');
    button.innerHTML = `<i class="mdi mdi-${icon}"></i><span>${escapeHTML(label)}</span>`;
  }

  async function copyDetailsResult(value, button) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!window.navigator?.clipboard?.writeText) {
      ui().toast('Clipboard access is unavailable in this browser.', { status: 'error', duration: 2200 });
      return;
    }
    try {
      await window.navigator.clipboard.writeText(text);
      if (button?.isConnected) {
        const original = button.innerHTML;
        button.innerHTML = '<i class="mdi mdi-check"></i><span>Copied</span>';
        window.setTimeout(() => { if (button.isConnected) button.innerHTML = original; }, 1200);
      }
    } catch (error) {
      ui().toast(String(error?.message || error || 'Unable to copy the result.'), { status: 'error', duration: 2500 });
    }
  }

  function integrityStatus(entry) {
    const comparisons = Object.entries(entry?.matches || {});
    const mismatches = comparisons.filter(([, matched]) => matched !== true);
    if (mismatches.length) {
      return {
        state: 'error',
        title: 'Integrity mismatch',
        message: `${mismatches.length.toLocaleString()} provider comparison${mismatches.length === 1 ? '' : 's'} did not match.`,
        comparison: 'Mismatch'
      };
    }
    if (comparisons.length) {
      return {
        state: 'success',
        title: 'Integrity verified',
        message: `${comparisons.length.toLocaleString()} provider comparison${comparisons.length === 1 ? '' : 's'} matched.`,
        comparison: 'Verified'
      };
    }
    return {
      state: 'success',
      title: 'Checksums calculated',
      message: 'No comparable provider checksum was exposed for this object.',
      comparison: 'Not available'
    };
  }

  async function renderDetailsIntegrity(key, version, instance, card, button, statusHost, resultHost) {
    if (!card || !button || !statusHost || !resultHost || button.disabled) return;
    detailsToolButton(button, 'loading', 'Verifying…');
    detailsToolState(card, statusHost, resultHost, 'loading', 'Reading the complete object and calculating checksums…', 'Verifying integrity');
    try {
      const created = await BB.api.integrity({ key, version, instance });
      const completed = await resolveAnalysis(created, 'Verifying integrity');
      const entry = completed.integrity?.entries?.[0];
      if (!entry) throw new Error('Integrity result is missing.');
      const providerRows = Object.entries(entry.providerChecksums || {}).map(([name, value]) => metadataRow(`Provider ${name.toUpperCase()}`, value, true)).join('');
      const matchRows = Object.entries(entry.matches || {}).map(([name, value]) => metadataRow(`${name} comparison`, value ? 'Matched' : 'Mismatch')).join('');
      const status = integrityStatus(entry);
      const result = {
        object: { instance, key, version: version || entry.version || '' },
        checkedAt: new Date().toISOString(),
        status: status.title,
        integrity: entry
      };
      const html = `<section class="bb-details-section bb-details-tool-result-section"><div class="bb-details-section-title"><i class="mdi mdi-shield-key-outline"></i> Result</div><div class="bb-kv">${metadataRow('Provider comparison', status.comparison)}${metadataRow('SHA-256', entry.sha256, true)}${metadataRow('MD5', entry.md5, true)}${metadataRow('CRC32', entry.crc32, true)}${metadataRow('CRC32C', entry.crc32c, true)}${providerRows}${matchRows}${metadataRow('Checked', new Date(result.checkedAt).toLocaleString())}</div></section><div class="bb-details-tool-footer"><button type="button" class="bb-btn" data-details-integrity-copy><i class="mdi mdi-content-copy"></i><span>Copy results</span></button><button type="button" class="bb-btn" data-details-integrity-json><i class="mdi mdi-download"></i><span>Download JSON</span></button><button type="button" class="bb-btn" data-details-integrity-rerun><i class="mdi mdi-refresh"></i><span>Run again</span></button></div>`;
      if (!detailsToolComplete(card, statusHost, resultHost, status.state, status.title, status.message, html)) return;
      resultHost.querySelector('[data-details-integrity-copy]')?.addEventListener('click', event => { void copyDetailsResult(result, event.currentTarget); });
      resultHost.querySelector('[data-details-integrity-json]')?.addEventListener('click', () => downloadJSON(result, 'integrity-verification.json'));
      resultHost.querySelector('[data-details-integrity-rerun]')?.addEventListener('click', () => button.click());
      detailsToolButton(button, 'complete', 'Run again');
    } catch (error) {
      if (card.isConnected) {
        detailsToolState(card, statusHost, resultHost, 'error', String(error?.message || error), 'Integrity check failed');
        detailsToolButton(button, 'complete', 'Try again');
      }
    }
  }

  function normalizedMime(value) {
    return String(value || '').split(';', 1)[0].trim().toLowerCase();
  }

  async function renderDetailsInspection(key, version, instance, card, button, statusHost, resultHost) {
    if (!card || !button || !statusHost || !resultHost || button.disabled) return;
    detailsToolButton(button, 'loading', 'Inspecting…');
    detailsToolState(card, statusHost, resultHost, 'loading', 'Reading bounded header and footer probes…', 'Inspecting file');
    try {
      const result = await BB.api.inspect(key, { version, instance });
      const headers = Object.entries(result.headers || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => metadataRow(name, value)).join('');
      const structure = Object.entries(result.structure || {}).map(([name, value]) => metadataRow(name, value)).join('');
      const probes = (result.probes || []).map(probe => `<section class="bb-details-technical-section"><div class="bb-details-section-title">${escapeHTML(probe.name)} · ${escapeHTML(probe.range)}</div><pre class="technical-probe">${escapeHTML(probe.hex)}\n${escapeHTML(probe.ascii)}</pre></section>`).join('');
      const declaredMime = normalizedMime(result.declaredMime);
      const detectedMime = normalizedMime(result.detectedMime);
      const mismatch = Boolean(declaredMime && detectedMime && declaredMime !== detectedMime);
      const state = mismatch ? 'warning' : 'success';
      const title = mismatch ? 'Inspection complete with warnings' : 'Inspection complete';
      const message = mismatch ? 'The declared and detected MIME types differ.' : 'The bounded technical inspection completed successfully.';
      const summary = `<section class="bb-details-section bb-details-tool-result-section"><div class="bb-details-section-title"><i class="mdi mdi-file-search-outline"></i> Summary</div><div class="bb-kv">${metadataRow('Detected type', result.detectedKind)}${metadataRow('Detected MIME', result.detectedMime)}${metadataRow('Declared MIME', result.declaredMime)}${metadataRow('Consistency', mismatch ? 'MIME mismatch' : 'Consistent')}${metadataRow('Size', formatBytes(result.size))}${metadataRow('Storage requests', result.resources?.storageRequests)}${metadataRow('Bytes read', formatBytes(result.resources?.storageBytes || 0))}</div></section>`;
      const structureSection = structure ? `<section class="bb-details-section"><div class="bb-details-section-title"><i class="mdi mdi-file-outline"></i> Structure</div><div class="bb-kv">${structure}</div></section>` : '';
      const technical = headers || probes
        ? `<details class="bb-details-technical"><summary class="has-bb-chevron"><i class="mdi mdi-file-code-outline"></i><span>Technical details</span></summary><div class="bb-details-technical-body">${headers ? `<section class="bb-details-technical-section"><div class="bb-details-section-title">Provider headers</div><div class="bb-kv">${headers}</div></section>` : ''}${probes}</div></details>`
        : '';
      const html = `${summary}${structureSection}${technical}<div class="bb-details-tool-footer"><button type="button" class="bb-btn" data-details-inspection-copy><i class="mdi mdi-content-copy"></i><span>Copy results</span></button><button type="button" class="bb-btn" data-details-inspection-json><i class="mdi mdi-download"></i><span>Download JSON</span></button><button type="button" class="bb-btn" data-details-inspection-rerun><i class="mdi mdi-refresh"></i><span>Inspect again</span></button></div>`;
      if (!detailsToolComplete(card, statusHost, resultHost, state, title, message, html)) return;
      resultHost.querySelector('[data-details-inspection-copy]')?.addEventListener('click', event => { void copyDetailsResult(result, event.currentTarget); });
      resultHost.querySelector('[data-details-inspection-json]')?.addEventListener('click', () => downloadJSON(result, 'technical-inspection.json'));
      resultHost.querySelector('[data-details-inspection-rerun]')?.addEventListener('click', () => button.click());
      detailsToolButton(button, 'complete', 'Inspect again');
    } catch (error) {
      if (card.isConnected) {
        detailsToolState(card, statusHost, resultHost, 'error', String(error?.message || error), 'Inspection failed');
        detailsToolButton(button, 'complete', 'Try again');
      }
    }
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
    if (!(await requirePermissions(['details']))) return false;
    const name = key.split('/').pop() || key;
    const selectedVersion = String(options.version || '');
    const selectedInstance = options.instance ?? null;
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
      // Always read the selected immutable object version directly. Listing
      // hints describe only the current object and must never leak into a
      // historical version's metadata.
      const result = await BB.api.mediaInfo(key, {
        instance: selectedInstance,
        version: selectedVersion
      });
      let objectVersions = [];
      if (BB.cfg?.versioningSupported === true) {
        try {
          objectVersions = await BB.api.allVersions(key, { instance: selectedInstance });
        } catch (versionError) {
          console.warn('Unable to load versions for file details', versionError);
        }
      }

      const headers = result.headers || {};
      const type = BB.detect.resolveType(key, result.mime || '');
      const storageRows = [
        metadataRow('Size', formatBytes(result.size)),
        metadataRow('MIME type', result.mime || '-'),
        metadataRow('Modified', headerValue(headers, 'last-modified')),
        metadataRow('ETag', headerValue(headers, 'etag'), true),
        metadataRow('Version', headerValue(headers, 'x-amz-version-id', 'x-goog-generation') || selectedVersion, true)
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
          : (['xlsx', 'xlsm', 'xltx', 'xltm', 'xlam'].includes(extension)
            ? { label: 'Scan active worksheet', icon: 'table-search', kind: 'spreadsheet' }
            : null));

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
      const overviewSections = `${storageSection}${customSection}${fileSection}${countSection}`;
      const advancedPanel = `<section class="bb-details-advanced">
        <article class="bb-details-tool-card is-idle" data-details-tool-card="integrity" aria-busy="false">
          <div class="bb-details-tool-card-head"><div class="bb-details-tool-heading"><span class="bb-details-tool-icon"><i class="mdi mdi-shield-key-outline"></i></span><div><strong>Verify integrity</strong><span>Calculate checksums for the complete object and compare them with values exposed by the provider.</span></div></div><button type="button" class="bb-btn bb-details-tool-run" data-details-integrity><i class="mdi mdi-play"></i><span>Run check</span></button></div>
          <div class="bb-details-tool-status is-idle" data-details-integrity-status hidden></div>
          <div class="bb-details-tool-result" data-details-integrity-result hidden></div>
        </article>
        <article class="bb-details-tool-card is-idle" data-details-tool-card="inspection" aria-busy="false">
          <div class="bb-details-tool-card-head"><div class="bb-details-tool-heading"><span class="bb-details-tool-icon"><i class="mdi mdi-file-search-outline"></i></span><div><strong>Inspect file</strong><span>Read bounded byte ranges to identify the format, structure, provider headers and technical probes.</span></div></div><button type="button" class="bb-btn bb-details-tool-run" data-details-inspect><i class="mdi mdi-play"></i><span>Inspect</span></button></div>
          <div class="bb-details-tool-status is-idle" data-details-inspection-status hidden></div>
          <div class="bb-details-tool-result" data-details-inspection-result hidden></div>
        </article>
      </section>`;
      const icon = BB.detect.iconForType(type);

      const availableVersions = objectVersions
        .filter(version => version && !version.deleteMarker && version.version);
      const historicalVersions = availableVersions.filter(version => !version.isCurrent);
      const currentVersionRecord = availableVersions.find(version => version.isCurrent);
      const selectedVersionKnown = !selectedVersion || historicalVersions.some(version => version.version === selectedVersion);
      const versionCount = availableVersions.length;
      const currentVersionLabel = currentVersionRecord
        ? `Current · ${versionDateLabel(currentVersionRecord)} · ${versionDisplayLabel(currentVersionRecord)}`
        : 'Current';
      const versionSelector = BB.cfg?.versioningSupported === true
        ? `<label class="bb-details-version-control" title="${versionCount.toLocaleString()} available version${versionCount === 1 ? '' : 's'}"><span>Version (${versionCount.toLocaleString()})</span><select data-details-version><option value="">${escapeHTML(currentVersionLabel)}</option>${historicalVersions.map(version => `<option value="${escapeHTML(version.version)}"${version.version === selectedVersion ? ' selected' : ''}>${escapeHTML(`${versionDateLabel(version)} · ${versionDisplayLabel(version)}`)}</option>`).join('')}${selectedVersion && !selectedVersionKnown ? `<option value="${escapeHTML(selectedVersion)}" selected>Selected · ${escapeHTML(selectedVersion)}</option>` : ''}</select></label>`
        : '';

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
        html: `<div class="bb-details bb-details--file">
          <div class="bb-details-head"><i class="mdi mdi-${escapeHTML(icon)}"></i><div class="bb-details-titles"><div class="bb-details-name">${escapeHTML(name)}</div><div class="bb-details-prefix">${escapeHTML(key)}</div></div>${versionSelector}</div>
          <div class="bb-details-body">
            <div class="spreadsheet-tabs bb-details-tabs" role="tablist" aria-label="File details">
              <button type="button" class="spreadsheet-tab is-active" role="tab" aria-selected="true" data-details-tab="overview"><i class="mdi mdi-information-outline"></i><span>Overview</span></button>
              <button type="button" class="spreadsheet-tab" role="tab" aria-selected="false" data-details-tab="advanced"><i class="mdi mdi-cogs"></i><span>Advanced</span></button>
            </div>
            <section class="bb-details-panel" data-details-panel="overview">${overviewSections}</section>
            <section class="bb-details-panel" data-details-panel="advanced" hidden>${advancedPanel}</section>
          </div>
        </div>`,
        onOpen: ({ overlay, modal }) => {
          overlay?.classList.add('bb-overlay--top-anchored');
          modal?.classList.add('bb-modal--details');
          const tabs = Array.from(overlay.querySelectorAll('[data-details-tab]'));
          const panels = Array.from(overlay.querySelectorAll('[data-details-panel]'));
          const activateDetailsTab = name => {
            const next = name === 'advanced' ? 'advanced' : 'overview';
            tabs.forEach(tab => {
              const active = tab.dataset.detailsTab === next;
              tab.classList.toggle('is-active', active);
              tab.setAttribute('aria-selected', active ? 'true' : 'false');
              tab.tabIndex = active ? 0 : -1;
            });
            panels.forEach(panel => { panel.hidden = panel.dataset.detailsPanel !== next; });
          };
          tabs.forEach(tab => tab.addEventListener('click', () => activateDetailsTab(tab.dataset.detailsTab)));

          const integrityCard = overlay.querySelector('[data-details-tool-card="integrity"]');
          const integrityButton = overlay.querySelector('[data-details-integrity]');
          const integrityStatusHost = overlay.querySelector('[data-details-integrity-status]');
          const integrityResultHost = overlay.querySelector('[data-details-integrity-result]');
          const inspectionCard = overlay.querySelector('[data-details-tool-card="inspection"]');
          const inspectButton = overlay.querySelector('[data-details-inspect]');
          const inspectionStatusHost = overlay.querySelector('[data-details-inspection-status]');
          const inspectionResultHost = overlay.querySelector('[data-details-inspection-result]');
          integrityButton?.addEventListener('click', () => {
            void renderDetailsIntegrity(key, selectedVersion, selectedInstance, integrityCard, integrityButton, integrityStatusHost, integrityResultHost);
          });
          inspectButton?.addEventListener('click', () => {
            void renderDetailsInspection(key, selectedVersion, selectedInstance, inspectionCard, inspectButton, inspectionStatusHost, inspectionResultHost);
          });

          const versionSelect = overlay.querySelector('[data-details-version]');
          versionSelect?.addEventListener('change', () => {
            const nextVersion = String(versionSelect.value || '');
            if (nextVersion === selectedVersion) return;
            overlay.querySelector('.bb-modal-x')?.click();
            window.setTimeout(() => {
              void showMetadata(key, { instance: selectedInstance, version: nextVersion });
            }, 140);
          });

          if (!countAction) return;
          const button = overlay.querySelector('[data-document-count]');
          const resultHost = overlay.querySelector('[data-document-count-result]');
          if (!button || !resultHost) return;
          button.addEventListener('click', async () => {
            if (button.disabled) return;
            button.disabled = true;
            button.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i><span>Calculating…</span>';
            resultHost.textContent = 'Reading the complete document…';
            try {
              const count = await BB.api.documentCount({
                key,
                size: Number(result.size || 0),
                version: selectedVersion,
                instance: selectedInstance
              });
              resultHost.replaceChildren();
              if (countAction.kind === 'lines') {
                resultHost.insertAdjacentHTML('beforeend', `<div class="bb-kv">${metadataRow('Lines', Number(count.lines || 0).toLocaleString())}</div>`);
              } else {
                const sheet = countAction.kind === 'spreadsheet' && count.sheet
                  ? metadataRow('Worksheet', count.sheet)
                  : '';
                resultHost.insertAdjacentHTML('beforeend', `<div class="bb-kv">${sheet}${metadataRow('Rows', Number(count.rows || 0).toLocaleString())}${metadataRow('Columns', Number(count.columns || 0).toLocaleString())}</div>`);
              }
              button.hidden = true;
              button.remove();
            } catch (countError) {
              resultHost.textContent = String(countError?.message || countError);
              button.disabled = false;
              button.innerHTML = `<i class="mdi mdi-alert-circle-outline"></i><span>${escapeHTML(countAction.label)}</span>`;
            }
          });
        }
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

  const statsTypePalette = Object.freeze({
    archive: '#9333ea',
    audio: '#7c3aed',
    calendar: '#0284c7',
    certificate: '#d97706',
    code: '#2563eb',
    contact: '#0d9488',
    database: '#0f766e',
    document: '#4f46e5',
    email: '#ea580c',
    image: '#db2777',
    markdown: '#0891b2',
    pdf: '#dc2626',
    spreadsheet: '#16a34a',
    text: '#64748b',
    video: '#be123c',
    other: '#3ecf8e'
  });

  function statsTypeColor(type) {
    const normalized = String(type || 'other').trim().toLowerCase();
    if (statsTypePalette[normalized]) return statsTypePalette[normalized];
    let hash = 0;
    for (let index = 0; index < normalized.length; index++) hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
    const hue = (210 + Math.abs(hash) * 47) % 360;
    return `hsl(${hue} 62% 52%)`;
  }

  function distributionEntries(entries, field, maximum = 7) {
    const source = Array.from(entries || []);
    const ordered = source
      .map(entry => ({ ...entry }))
      .filter(entry => Number(entry?.[field] || 0) > 0)
      .sort((left, right) => Number(right[field] || 0) - Number(left[field] || 0) || left.name.localeCompare(right.name));
    if (ordered.length <= maximum) return ordered;
    const visible = ordered.slice(0, Math.max(1, maximum - 1));
    const hidden = ordered.slice(visible.length);
    visible.push({
      name: visible.some(entry => entry.name === 'other') ? 'other types' : 'other',
      count: hidden.reduce((sum, entry) => sum + Number(entry.count || 0), 0),
      bytes: hidden.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0)
    });
    return visible;
  }

  function distributionHTML(entries, field, title) {
    const displayed = distributionEntries(entries, field);
    const total = displayed.reduce((sum, entry) => sum + Number(entry[field] || 0), 0);
    if (!(total > 0)) return '';
    const segments = displayed.map(entry => {
      const percent = Number(entry[field] || 0) * 100 / total;
      const detail = field === 'bytes' ? formatBytes(entry.bytes) : `${entry.count.toLocaleString()} object(s)`;
      return `<span class="folder-distribution-segment" style="--segment-width:${percent}%;--segment-color:${statsTypeColor(entry.name)}" title="${escapeHTML(`${entry.name}: ${percent.toFixed(1)}% · ${detail}`)}"></span>`;
    }).join('');
    const legend = displayed.map(entry => {
      const percent = Number(entry[field] || 0) * 100 / total;
      const detail = field === 'bytes' ? formatBytes(entry.bytes) : `${entry.count.toLocaleString()} object(s)`;
      return `<div class="folder-distribution-legend-item"><span class="folder-distribution-swatch" style="--segment-color:${statsTypeColor(entry.name)}"></span><span class="folder-distribution-label">${escapeHTML(entry.name)}</span><span class="folder-distribution-value">${percent.toFixed(1)}% · ${escapeHTML(detail)}</span></div>`;
    }).join('');
    return `<section class="folder-distribution"><div class="folder-distribution-title">${escapeHTML(title)}</div><div class="folder-distribution-bar" role="img" aria-label="${escapeHTML(title)}">${segments}</div><div class="folder-distribution-legend">${legend}</div></section>`;
  }

  function statsFileListHTML(title, entries, mode, maximum = 6) {
    const items = Array.from(entries || []).slice(0, maximum);
    if (!items.length) {
      return `<section class="folder-file-list"><div class="folder-file-list-title">${escapeHTML(title)}</div><div class="folder-file-list-empty">No file data available.</div></section>`;
    }
    const rows = items.map(entry => {
      const path = String(entry?.path || '');
      const name = path.split('/').filter(Boolean).pop() || path || 'Unnamed file';
      const kind = String(entry?.type || 'other');
      const iconName = BB.detect?.iconForType?.(kind) || 'file-outline';
      const dateLabel = BB.runtime.formatDateTimeUTC(entry?.lastModified) || 'Unknown date';
      const primaryMeta = mode === 'recent' ? dateLabel : formatBytes(entry?.bytes || 0);
      const secondaryMeta = mode === 'recent' ? formatBytes(entry?.bytes || 0) : dateLabel;
      return `<button type="button" class="folder-file-list-row" data-insight-file="true" data-path="${escapeHTML(path)}" data-kind="file" data-size="${Math.max(0, Number(entry?.bytes || 0))}" data-mime="${escapeHTML(entry?.mime || '')}" data-etag="${escapeHTML(entry?.etag || '')}" data-modified="${escapeHTML(entry?.lastModified || '')}" title="${escapeHTML(path)}">
        <i class="mdi mdi-${escapeHTML(iconName)}"></i>
        <span class="folder-file-list-copy"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(kind)} · ${escapeHTML(secondaryMeta)}</small></span>
        <span class="folder-file-list-value">${escapeHTML(primaryMeta)}</span>
      </button>`;
    }).join('');
    return `<section class="folder-file-list"><div class="folder-file-list-title">${escapeHTML(title)}</div><div class="folder-file-list-rows">${rows}</div></section>`;
  }

  const treemapMaximumRectangles = 1000;
  const treemapMaximumDepth = 5;
  const treemapGapPixels = 2;
  const treemapOtherInlineMinimumHeightPixels = 26;
  const treemapOtherStackedMinimumHeightPixels = 34;
  const treemapOtherInlineMinimumWidthPixels = 180;
  const treemapMinimumRegularPixels = 30;
  const treemapFolderHeaderPixels = 26;
  const treemapBranchInsetPixels = 2;

  function treemapObjectCount(value) {
    const count = Math.max(0, Number(value || 0));
    return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
  }

  function treemapChildren(node) {
    return Array.isArray(node?.children)
      ? node.children.filter(child => Number(child?.bytes || 0) > 0)
      : [];
  }

  function treemapOtherReadableHeight(width) {
    return width >= treemapOtherInlineMinimumWidthPixels
      ? treemapOtherInlineMinimumHeightPixels
      : treemapOtherStackedMinimumHeightPixels;
  }



  function treemapWorstAspectRatio(row, side) {
    if (!row.length || !(side > 0)) return Number.POSITIVE_INFINITY;
    const areas = row.map(item => Math.max(0, Number(item.area || 0))).filter(area => area > 0);
    if (!areas.length) return Number.POSITIVE_INFINITY;
    const sum = areas.reduce((total, area) => total + area, 0);
    const maximum = Math.max(...areas);
    const minimum = Math.min(...areas);
    const sideSquared = side * side;
    const sumSquared = sum * sum;
    return Math.max(
      sideSquared * maximum / Math.max(Number.EPSILON, sumSquared),
      sumSquared / Math.max(Number.EPSILON, sideSquared * minimum)
    );
  }

  function layoutTreemapRow(row, bounds) {
    const rectangles = [];
    const totalArea = row.reduce((sum, item) => sum + Math.max(0, Number(item.area || 0)), 0);
    if (!(totalArea > 0) || !(bounds.width > 0) || !(bounds.height > 0)) return { rectangles, remaining: bounds };

    if (bounds.width >= bounds.height) {
      const rowWidth = Math.min(bounds.width, totalArea / bounds.height);
      let cursorY = bounds.y;
      row.forEach((item, index) => {
        const itemHeight = index === row.length - 1
          ? Math.max(0, bounds.y + bounds.height - cursorY)
          : Math.max(0, item.area / Math.max(Number.EPSILON, rowWidth));
        rectangles.push({ node: item.node, x: bounds.x, y: cursorY, width: rowWidth, height: itemHeight });
        cursorY += itemHeight;
      });
      return {
        rectangles,
        remaining: {
          x: bounds.x + rowWidth,
          y: bounds.y,
          width: Math.max(0, bounds.width - rowWidth),
          height: bounds.height
        }
      };
    }

    const rowHeight = Math.min(bounds.height, totalArea / bounds.width);
    let cursorX = bounds.x;
    row.forEach((item, index) => {
      const itemWidth = index === row.length - 1
        ? Math.max(0, bounds.x + bounds.width - cursorX)
        : Math.max(0, item.area / Math.max(Number.EPSILON, rowHeight));
      rectangles.push({ node: item.node, x: cursorX, y: bounds.y, width: itemWidth, height: rowHeight });
      cursorX += itemWidth;
    });
    return {
      rectangles,
      remaining: {
        x: bounds.x,
        y: bounds.y + rowHeight,
        width: bounds.width,
        height: Math.max(0, bounds.height - rowHeight)
      }
    };
  }

  function squarifyTreemapNodes(nodes, x, y, width, height) {
    const visible = Array.from(nodes || [])
      .filter(node => Number(node?.bytes || 0) > 0)
      .sort((left, right) => Number(right.bytes || 0) - Number(left.bytes || 0) || String(left.name || '').localeCompare(String(right.name || '')));
    const totalBytes = visible.reduce((sum, node) => sum + Math.max(0, Number(node.bytes || 0)), 0);
    const totalArea = Math.max(0, width) * Math.max(0, height);
    if (!visible.length || !(totalBytes > 0) || !(totalArea > 0)) return [];

    const remainingItems = visible.map(node => ({
      node,
      area: Math.max(0, Number(node.bytes || 0)) / totalBytes * totalArea
    }));
    let bounds = { x, y, width, height };
    let row = [];
    const rectangles = [];

    while (remainingItems.length && bounds.width > 0 && bounds.height > 0) {
      const candidate = remainingItems[0];
      const side = Math.min(bounds.width, bounds.height);
      if (!row.length || treemapWorstAspectRatio([...row, candidate], side) <= treemapWorstAspectRatio(row, side)) {
        row.push(remainingItems.shift());
        continue;
      }
      const result = layoutTreemapRow(row, bounds);
      rectangles.push(...result.rectangles);
      bounds = result.remaining;
      row = [];
    }
    if (row.length && bounds.width > 0 && bounds.height > 0) {
      rectangles.push(...layoutTreemapRow(row, bounds).rectangles);
    }
    return rectangles;
  }

  function layoutTreemapNodes(nodes, x, y, width, height) {
    const visible = Array.from(nodes || []).filter(node => Number(node?.bytes || 0) > 0);
    if (!visible.length || !(width > 0) || !(height > 0)) return [];

    const otherNodes = visible.filter(node => String(node?.kind || '') === 'other');
    const regularNodes = visible.filter(node => String(node?.kind || '') !== 'other');
    if (!otherNodes.length || !regularNodes.length) return squarifyTreemapNodes(visible, x, y, width, height);

    const totalBytes = visible.reduce((sum, node) => sum + Math.max(0, Number(node.bytes || 0)), 0);
    const otherBytes = otherNodes.reduce((sum, node) => sum + Math.max(0, Number(node.bytes || 0)), 0);
    const share = otherBytes / Math.max(Number.EPSILON, totalBytes);
    const rectangles = [];

    // Others stays proportional to its exact byte share. It only receives the
    // smallest horizontal strip required to keep its two-line label readable.
    // The minimum is always clamped below the room reserved for regular nodes,
    // so a tiny aggregate can never consume most of its parent rectangle.
    const naturalHeight = height * share;
    const maximumHeight = Math.max(0, height - Math.min(treemapMinimumRegularPixels, height));
    if (!(maximumHeight > 0)) return squarifyTreemapNodes(visible, x, y, width, height);
    const readableMinimum = Math.min(treemapOtherReadableHeight(width), maximumHeight);
    const stripHeight = Math.min(maximumHeight, Math.max(naturalHeight, readableMinimum));
    const regularHeight = Math.max(0, height - stripHeight);
    rectangles.push(...squarifyTreemapNodes(regularNodes, x, y, width, regularHeight));
    rectangles.push(...squarifyTreemapNodes(otherNodes, x, y + regularHeight, width, stripHeight));
    return rectangles;
  }

  function layoutTreemapGroup(nodes, x, y, width, height, depth, output) {
    if (output.length >= treemapMaximumRectangles || width < 1 || height < 1) return;
    const rectangles = layoutTreemapNodes(nodes, x, y, width, height);
    for (const rectangle of rectangles) {
      if (output.length >= treemapMaximumRectangles) break;
      collectTreemapRectangles(
        rectangle.node,
        rectangle.x,
        rectangle.y,
        rectangle.width,
        rectangle.height,
        depth,
        output
      );
    }
  }

  function collectTreemapRectangles(node, x, y, width, height, depth, output) {
    if (output.length >= treemapMaximumRectangles || width < 1 || height < 1 || Number(node?.bytes || 0) <= 0) return;
    const gap = Math.min(treemapGapPixels, width * 0.04, height * 0.04);
    const drawX = x + gap / 2;
    const drawY = y + gap / 2;
    const drawWidth = Math.max(0, width - gap);
    const drawHeight = Math.max(0, height - gap);
    if (drawWidth < 1 || drawHeight < 1) return;

    const children = treemapChildren(node);
    const declaredKind = String(node.kind || '');
    const isFolder = declaredKind === 'folder';
    const canExpandFolder = isFolder
      && children.length > 0
      && depth < treemapMaximumDepth
      && drawWidth >= 80
      && drawHeight >= 84;
    const isBranch = canExpandFolder;
    const isLeaf = !isBranch;
    const kind = declaredKind === 'other' ? 'other' : (declaredKind === 'file' ? 'file' : 'folder');
    const color = statsTypeColor(node.type || 'other');
    const countLabel = treemapObjectCount(node.count);
    const titlePath = kind === 'other' ? `${node.path || '/'} - Others` : (node.path || node.name);
    const title = `${titlePath}\n${formatBytes(node.bytes)} · ${countLabel}`;
    const sizeLabel = formatBytes(node.bytes);

    // Every expanded folder owns a header. If the rectangle cannot reserve a
    // readable header and child area, it is rendered as a terminal folder tile
    // instead of drawing an unnamed container around its descendants.
    const header = isBranch ? Math.min(treemapFolderHeaderPixels, Math.max(0, drawHeight - 30)) : 0;
    const labelName = node.name || (kind === 'folder' ? 'Folder' : 'Unnamed');
    const label = `<span class="folder-treemap-label"><span class="folder-treemap-name">${escapeHTML(labelName)}</span><span class="folder-treemap-details"><span class="folder-treemap-size">${escapeHTML(sizeLabel)}</span><span class="folder-treemap-meta">${escapeHTML(countLabel)}</span></span></span>`;
    const branchClass = isBranch ? ' is-branch has-header' : ' is-terminal';
    const role = kind === 'other' ? 'img' : 'button';
    const headerValue = header > 0 ? `${header.toFixed(2)}px` : '100%';
    output.push(`<div class="folder-treemap-node is-${kind}${branchClass}" tabindex="0" role="${role}" aria-label="${escapeHTML(title.replace(/\n/g, ', '))}" data-kind="${kind}" data-name="${escapeHTML(node.name || '')}" data-depth="${depth}" data-header-height="${header}" data-path="${escapeHTML(node.path || '')}" data-size="${Math.max(0, Number(node.bytes || 0))}" data-count="${Math.max(0, Number(node.count || 0))}" data-mime="${escapeHTML(node.mime || '')}" data-etag="${escapeHTML(node.etag || '')}" data-modified="${escapeHTML(node.lastModified || '')}" style="left:${drawX.toFixed(2)}px;top:${drawY.toFixed(2)}px;width:${drawWidth.toFixed(2)}px;height:${drawHeight.toFixed(2)}px;z-index:${depth};--treemap-color:${color};--treemap-header:${headerValue}">${label}</div>`);
    if (isLeaf || output.length >= treemapMaximumRectangles) return;

    const inset = Math.min(treemapBranchInsetPixels, drawWidth / 4, drawHeight / 4);
    const innerX = drawX + inset;
    const innerY = drawY + header + inset;
    const innerWidth = Math.max(0, drawWidth - inset * 2);
    const innerHeight = Math.max(0, drawHeight - header - inset * 2);
    layoutTreemapGroup(children, innerX, innerY, innerWidth, innerHeight, depth + 1, output);
  }

  function fitTreemapLabels(map) {
    if (!map) return;
    map.querySelectorAll('.folder-treemap-node').forEach(node => {
      const label = node.querySelector('.folder-treemap-label');
      if (!label) return;
      const meta = label.querySelector('.folder-treemap-meta');
      const rect = BB.viewport?.rect(node) || node.getBoundingClientRect();
      const headerHeight = Math.max(0, Number(node.dataset.headerHeight || 0));
      const labelHeight = node.classList.contains('is-branch') && headerHeight > 0 ? headerHeight : rect.height;
      const isOther = node.dataset.kind === 'other';
      const isFolder = node.dataset.kind === 'folder';
      const isBranch = node.classList.contains('is-branch');

      label.style.maxHeight = `${Math.max(0, labelHeight)}px`;
      label.classList.remove('is-hidden', 'is-compact', 'is-tiny', 'is-other-compact', 'is-other-inline');
      if (meta) meta.hidden = false;

      // Others always keeps its name, exact size, and exact object count. The
      // layout reserves enough space; compact mode only reduces typography.
      if (isOther) {
        if (rect.width >= treemapOtherInlineMinimumWidthPixels && labelHeight < 38) {
          label.classList.add('is-other-inline');
        } else if (rect.width < 150 || labelHeight < 58) {
          label.classList.add('is-other-compact');
        }
        return;
      }

      // A folder rectangle is never rendered without its name. Small folders
      // use compact typography rather than hiding the complete label.
      if (isFolder) {
        if (rect.width < 82 || labelHeight < 38) label.classList.add('is-tiny');
        else if (rect.width < 140 || labelHeight < 52) label.classList.add('is-compact');
        if (meta && (rect.width < 220 || labelHeight < 70 || isBranch)) meta.hidden = true;
        return;
      }

      if (rect.width < 40 || labelHeight < 24) {
        label.classList.add('is-hidden');
        return;
      }
      if (rect.width < 82 || labelHeight < 38) {
        label.classList.add('is-tiny');
        if (meta) meta.hidden = true;
        return;
      }
      if (rect.width < 140 || labelHeight < 52) {
        label.classList.add('is-compact');
        if (meta) meta.hidden = true;
        return;
      }
      if (rect.width < 220 || labelHeight < 70) {
        if (meta) meta.hidden = true;
      }
    });
  }

  function renderTreemap(map, nodes) {
    if (!map) return;
    const bounds = BB.viewport?.rect(map) || map.getBoundingClientRect();
    const width = Math.max(0, Math.floor(bounds.width));
    const height = Math.max(0, Math.floor(bounds.height));
    if (!(width > 0) || !(height > 0)) return;
    if (map.dataset.layoutWidth === String(width) && map.dataset.layoutHeight === String(height) && map.dataset.layoutReady === '1') {
      fitTreemapLabels(map);
      return;
    }

    const output = [];
    layoutTreemapGroup(nodes, 0, 0, width, height, 1, output);
    map.innerHTML = output.join('') || '<div class="folder-treemap-empty">No objects found.</div>';
    map.dataset.layoutWidth = String(width);
    map.dataset.layoutHeight = String(height);
    map.dataset.layoutReady = '1';
    map.classList.remove('is-layout-pending');
    map.setAttribute('aria-busy', 'false');
    fitTreemapLabels(map);
  }

  function navigateFromStats(metadata) {
    const clean = String(metadata?.path || '').replace(/^\/+/, '');
    const kind = String(metadata?.kind || '');
    if (!clean) return;
    if (kind === 'folder') {
      location.href = BB.api.browserPageURL(ensurePrefix(clean), { instance: BB.api.getInstance() });
      return;
    }
    location.href = BB.api.previewPageURL(clean, { instance: BB.api.getInstance() });
  }

  async function collectPrefixStats(prefix, label) {
    const created = await BB.api.stats(ensurePrefix(prefix));
    if (created.status === 'completed') return created.stats || {};
    if (created.status === 'failed') throw new Error(created.error || 'Insights calculation failed.');
    if (created.status === 'canceled') throw new Error('Insights calculation was canceled.');
    const completed = await waitForJob(created, label);
    if (completed.status !== 'completed') return null;
    return completed.stats || {};
  }

  async function showPrefixInsights(prefix, initialTab = 'overview') {
    if (!(await requirePermissions(['insights']))) return false;
    const cleanPrefix = ensurePrefix(prefix);
    const isRoot = !cleanPrefix;
    const scopeTitle = isRoot ? 'Storage insights' : 'Folder insights';
    const scopePath = isRoot ? 'Storage root' : `/${cleanPrefix}`;
    try {
      const stats = await collectPrefixStats(cleanPrefix, isRoot ? 'Computing storage insights' : 'Computing folder insights');
      if (!stats) return false;
      const entries = statsTypeEntries(stats);
      const tree = stats?.treemap || null;
      const rootChildren = treemapChildren(tree);
      const nodes = rootChildren.length ? rootChildren : (tree && Number(tree.bytes || 0) > 0 ? [tree] : []);
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
              <div class="folder-file-lists">${statsFileListHTML('Most recent files', stats.recent, 'recent')}${statsFileListHTML('Largest files', stats.largest, 'largest')}</div>
              <div class="folder-details-footer">Computed in ${Number(stats.tookMs || 0).toLocaleString()} ms</div>
            </section>
            <section class="folder-insights-panel" data-insights-panel="treemap" hidden>
              <div class="folder-treemap is-layout-pending" role="img" aria-label="${scopeTitle} size treemap" aria-busy="true"></div>
              <div class="folder-treemap-tooltip" data-treemap-tooltip role="status" hidden><strong></strong><span></span></div>
            </section>
          </div>
        </div>`,
        onOpen: ({ overlay, modal }) => {
          overlay?.classList.add('bb-overlay--top-anchored');
          modal?.classList.add('bb-modal--wide', 'bb-modal--insights');
        }
      });

      let resizeObserver = null;
      let resizeHandler = null;
      requestAnimationFrame(() => {
        const root = document.getElementById(insightID);
        if (!root) return;
        const modal = root.closest('.bb-modal');
        modal?.classList.add('bb-modal--wide', 'bb-modal--insights');
        const map = root.querySelector('.folder-treemap');
        const treemapPanel = root.querySelector('[data-insights-panel="treemap"]');
        const treemapTooltip = root.querySelector('[data-treemap-tooltip]');
        let hoveredTreemapNode = null;
        const hideTreemapTooltip = () => {
          if (!treemapTooltip) return;
          treemapTooltip.hidden = true;
        };
        const clearTreemapHover = () => {
          hoveredTreemapNode?.classList.remove('is-hovered');
          hoveredTreemapNode = null;
          hideTreemapTooltip();
        };
        const placeTreemapTooltip = (node, clientX, clientY) => {
          if (!treemapTooltip || !treemapPanel || !node || node.dataset.kind !== 'folder') {
            hideTreemapTooltip();
            return;
          }
          const nameHost = treemapTooltip.querySelector('strong');
          const metaHost = treemapTooltip.querySelector('span');
          const folderName = node.dataset.name || node.dataset.path || 'Folder';
          if (nameHost) nameHost.textContent = folderName;
          if (metaHost) metaHost.textContent = `${formatBytes(Number(node.dataset.size || 0))} · ${treemapObjectCount(node.dataset.count || 0)}`;
          treemapTooltip.hidden = false;

          const panelRect = BB.viewport?.rect(treemapPanel) || treemapPanel.getBoundingClientRect();
          const nodeRect = BB.viewport?.rect(node) || node.getBoundingClientRect();
          const tooltipRect = BB.viewport?.rect(treemapTooltip) || treemapTooltip.getBoundingClientRect();
          const pointerX = Number.isFinite(clientX)
            ? (BB.viewport?.toLayoutPixels(clientX) ?? clientX)
            : null;
          const pointerY = Number.isFinite(clientY)
            ? (BB.viewport?.toLayoutPixels(clientY) ?? clientY)
            : null;
          const anchorX = pointerX ?? nodeRect.left + Math.min(nodeRect.width, 24);
          const anchorY = pointerY ?? nodeRect.top + Math.min(nodeRect.height, 24);
          const maximumLeft = Math.max(8, panelRect.width - tooltipRect.width - 8);
          const maximumTop = Math.max(8, panelRect.height - tooltipRect.height - 8);
          const left = Math.min(maximumLeft, Math.max(8, anchorX - panelRect.left + 12));
          const top = Math.min(maximumTop, Math.max(8, anchorY - panelRect.top + 12));
          treemapTooltip.style.left = `${left}px`;
          treemapTooltip.style.top = `${top}px`;
        };
        const updateTreemapHover = (node, clientX, clientY) => {
          if (hoveredTreemapNode !== node) {
            hoveredTreemapNode?.classList.remove('is-hovered');
            hoveredTreemapNode = node || null;
            hoveredTreemapNode?.classList.add('is-hovered');
          }
          placeTreemapTooltip(node, clientX, clientY);
        };
        const tabs = Array.from(root.querySelectorAll('[data-insights-tab]'));
        const panels = Array.from(root.querySelectorAll('[data-insights-panel]'));
        let treemapRenderPending = false;
        const scheduleTreemapRender = () => {
          if (!map || treemapRenderPending) return;
          treemapRenderPending = true;
          requestAnimationFrame(() => {
            treemapRenderPending = false;
            renderTreemap(map, nodes);
          });
        };
        const activate = tabName => {
          const next = tabName === 'treemap' ? 'treemap' : 'overview';
          tabs.forEach(tab => {
            const active = tab.dataset.insightsTab === next;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
          });
          panels.forEach(panel => { panel.hidden = panel.dataset.insightsPanel !== next; });
          if (next === 'treemap') scheduleTreemapRender();
        };
        tabs.forEach(tab => tab.addEventListener('click', () => activate(tab.dataset.insightsTab)));
        activate(requestedTab);
        map?.addEventListener('pointermove', event => {
          const node = event.target.closest('.folder-treemap-node');
          updateTreemapHover(node, event.clientX, event.clientY);
        });
        map?.addEventListener('pointerleave', clearTreemapHover);
        map?.addEventListener('focusin', event => {
          const node = event.target.closest('.folder-treemap-node');
          updateTreemapHover(node);
        });
        map?.addEventListener('focusout', event => {
          if (!map.contains(event.relatedTarget)) clearTreemapHover();
        });
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
        root.addEventListener('click', event => {
          const item = event.target.closest('[data-insight-file="true"]');
          if (!item || !item.dataset.path) return;
          event.preventDefault();
          modal?.querySelector('.bb-modal-x')?.click();
          navigateFromStats({
            path: item.dataset.path,
            kind: 'file',
            size: item.dataset.size,
            mime: item.dataset.mime,
            etag: item.dataset.etag,
            modified: item.dataset.modified
          });
        });
        if (map && typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(scheduleTreemapRender);
          resizeObserver.observe(map);
        } else if (map) {
          resizeHandler = scheduleTreemapRender;
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
    if (!(await requirePermissions(['copy']))) return false;
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
    if (!(await requirePermissions(['rename']))) return false;
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
    if (!(await requirePermissions(['copy']))) return false;
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
    if (!(await requirePermissions(['rename']))) return false;
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
    if (!(await requirePermissions(['delete']))) return false;
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

  function triggerBrowserDownload(url, filename = '') {
    const anchor = document.createElement('a');
    anchor.href = String(url || '');
    if (filename) anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function downloadObject(key, filename, options = {}) {
    if (!allowed('download')) return false;
    const safeFilename = filename || key.split('/').pop() || 'download';
    if (BB.downloads?.download) {
      try {
        await BB.downloads.download({
          key,
          filename: safeFilename,
          version: options.version || '',
          instance: options.instance || BB.api.getInstance()
        });
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        BB.downloads.fallbackDownload(key, safeFilename, options.version || '', options.instance || BB.api.getInstance());
        ui().toast(`Resumable download was unavailable: ${String(error?.message || error)}. Browser download started instead.`, { type: 'warning', duration: 6500 });
      }
    } else {
      const downloadURL = BB.api.openURLForKey(key, options.instance || BB.api.getInstance(), options.version || '');
      triggerBrowserDownload(downloadURL, safeFilename);
      ui().toast('Download started in the browser.', { type: 'info', duration: 4000 });
    }
    return true;
  }


  async function resolveAnalysis(created, label) {
    if (created?.status === 'completed') return created;
    return waitForJob(created, label);
  }

  function analysisTable(headers, rows, className = '') {
    return `<div class="data-table-scroll ${escapeHTML(className)}"><table class="data-table"><thead><tr>${headers.map(value => `<th>${escapeHTML(value)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function downloadJSON(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerBrowserDownload(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function versionDisplayLabel(version) {
    const identifier = String(version?.version || '');
    if (!identifier) return 'Unknown version';
    return identifier.length > 32 ? `${identifier.slice(0, 16)}…${identifier.slice(-12)}` : identifier;
  }

  function versionDateLabel(version) {
    return version?.lastModified ? new Date(version.lastModified).toLocaleString() : '';
  }

  async function fetchExactVersionRange(key, version, start, end, size, etag, instance, signal) {
    const headers = { Range: `bytes=${start}-${end}` };
    if (etag) headers['If-Match'] = etag;
    const response = await fetch(BB.api.urlForKey(key, instance, version), {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal
    });
    if (response.status !== 206) {
      try { await response.body?.cancel?.(); } catch (_) {}
      throw new Error(`The storage provider returned HTTP ${response.status} instead of an exact byte range.`);
    }
    const contentRange = String(response.headers.get('Content-Range') || '');
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== size) {
      try { await response.body?.cancel?.(); } catch (_) {}
      throw new Error('The storage provider returned an unexpected Content-Range while comparing versions.');
    }
    const expectedLength = end - start + 1;
    const declaredLength = Number(response.headers.get('Content-Length') || expectedLength);
    if (!Number.isFinite(declaredLength) || declaredLength !== expectedLength) {
      try { await response.body?.cancel?.(); } catch (_) {}
      throw new Error('The storage provider returned an unexpected range length while comparing versions.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expectedLength) {
      throw new Error('The storage provider returned an incomplete byte range while comparing versions.');
    }
    return bytes;
  }

  async function compareVersions(key, leftVersion, rightVersion, options = {}) {
    if (!(await requirePermissions(['read']))) return false;
    const leftID = String(leftVersion || '').trim();
    const rightID = String(rightVersion || '').trim();
    const instance = options.instance || BB.api.getInstance();
    if (!leftID || !rightID || leftID === rightID) {
      await ui().alert({ title: 'Compare versions', message: 'Select two different object versions.' });
      return false;
    }

    const controller = new AbortController();
    const task = transferGroup('comparison').add({
      id: `compare-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      name: key.split('/').pop() || key,
      status: 'preparing',
      progress: 0,
      detail: 'Reading version metadata...',
      onCancel: () => controller.abort()
    });

    try {
      const [left, right] = await Promise.all([
        BB.api.head(key, leftID, instance),
        BB.api.head(key, rightID, instance)
      ]);
      if (!left.sizeKnown || !right.sizeKnown) throw new Error('Both version sizes must be known before comparison.');
      const leftSize = Number(left.size || 0);
      const rightSize = Number(right.size || 0);
      const leftETag = String(left.headers?.etag || '');
      const rightETag = String(right.headers?.etag || '');
      let equal = leftSize === rightSize;
      let firstDifference = equal ? null : Math.min(leftSize, rightSize);
      let comparedBytes = 0;
      const chunkSize = 2 * 1024 * 1024;

      task.update({
        status: 'running',
        progress: equal && leftSize > 0 ? 0 : 1,
        detail: equal ? `Comparing ${formatBytes(leftSize)} in bounded ranges...` : 'The version sizes differ.',
        onCancel: () => controller.abort()
      });

      if (equal && leftSize > 0) {
        for (let start = 0; start < leftSize; start += chunkSize) {
          if (controller.signal.aborted) throw abortError();
          const end = Math.min(leftSize - 1, start + chunkSize - 1);
          const [leftBytes, rightBytes] = await Promise.all([
            fetchExactVersionRange(key, leftID, start, end, leftSize, leftETag, instance, controller.signal),
            fetchExactVersionRange(key, rightID, start, end, rightSize, rightETag, instance, controller.signal)
          ]);
          for (let index = 0; index < leftBytes.length; index++) {
            if (leftBytes[index] !== rightBytes[index]) {
              equal = false;
              firstDifference = start + index;
              break;
            }
          }
          comparedBytes = end + 1;
          task.update({
            status: 'running',
            progress: leftSize ? comparedBytes / leftSize : 1,
            detail: `${formatBytes(comparedBytes)} / ${formatBytes(leftSize)} compared`,
            onCancel: () => controller.abort()
          });
          if (!equal) break;
        }
      }

      const detail = equal
        ? `${formatBytes(leftSize)} compared exactly in the browser.`
        : (firstDifference === null ? 'The versions differ.' : `First difference at byte ${Number(firstDifference).toLocaleString()}.`);
      task.complete({ name: key.split('/').pop() || key, detail, progress: 1 });
      await ui().alert({
        html: `<div class="bb-details bb-comparison">
          <div class="bb-details-head"><i class="mdi mdi-swap-vertical"></i><div class="bb-details-titles"><div class="bb-details-name">${equal ? 'Versions are identical' : 'Versions differ'}</div><div class="bb-details-prefix">${escapeHTML(key)}</div></div></div>
          <div class="bb-details-body"><section class="bb-details-section"><div class="bb-kv">
            ${metadataRow('Left version', leftID, true)}
            ${metadataRow('Right version', rightID, true)}
            ${metadataRow('Left size', formatBytes(leftSize))}
            ${metadataRow('Right size', formatBytes(rightSize))}
            ${metadataRow('Bytes compared', formatBytes(comparedBytes))}
            ${firstDifference === null ? '' : metadataRow('First different byte', Number(firstDifference).toLocaleString())}
            ${metadataRow('Result', equal ? 'Identical' : 'Different')}
          </div></section></div>
        </div>`
      });
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        task.canceled({ detail: 'Comparison canceled.' });
        return false;
      }
      task.fail({ detail: String(error?.message || error) });
      showTaskFailure('Comparing versions', error);
      return false;
    }
  }

  async function showVersions(key, options = {}) {
    if (!(await requirePermissions(['read']))) return false;
    if (BB.cfg?.versioningSupported !== true) return false;
    const instance = options.instance || BB.api.getInstance();
    const canWriteVersion = allowed('write');
    const canDeleteVersion = allowed('delete');
    try {
      const firstPage = await BB.api.versions(key, { maximum: 250, instance });
      const versions = [...(firstPage.versions || [])];
      let pageToken = firstPage.nextPageToken || '';
      if (!versions.length && !pageToken) {
        await ui().alert({ title: 'Versions', message: 'No object versions were returned by the provider.' });
        return true;
      }

      const renderRow = (version, index) => {
        const state = version.isCurrent ? '<strong>Current</strong>' : (version.deleteMarker ? 'Delete marker' : 'Previous');
        const deleteLabel = version.deleteMarker ? (version.isCurrent ? 'Remove marker' : 'Delete marker') : 'Delete';
        const selectable = !version.deleteMarker && !!version.version;
        return `<tr data-version-row="${index}">
          <td class="bb-version-select-cell">${selectable ? `<input type="checkbox" data-version-select="${index}" aria-label="Select version ${escapeHTML(versionDisplayLabel(version))}">` : ''}</td>
          <td>${state}</td>
          <td class="is-monospace" title="${escapeHTML(version.version || '')}">${escapeHTML(versionDisplayLabel(version))}</td>
          <td class="is-numeric">${version.deleteMarker ? '-' : escapeHTML(formatBytes(version.size || 0))}</td>
          <td>${escapeHTML(versionDateLabel(version))}</td>
          <td class="bb-version-actions">
            ${version.deleteMarker ? '' : `<button class="bb-btn" data-version-download="${index}">Download</button>`}
            ${canWriteVersion && !version.isCurrent && !version.deleteMarker ? `<button class="bb-btn bb-btn-primary" data-version-restore="${index}">Restore</button>` : ''}
            ${canDeleteVersion ? `<button class="bb-btn danger" data-version-delete="${index}">${deleteLabel}</button>` : ''}
          </td>
        </tr>`;
      };
      const initialRows = versions.map(renderRow).join('');
      await ui().alert({
        html: `<div class="bb-details bb-version-browser"><div class="bb-details-head"><i class="mdi mdi-source-commit"></i><div class="bb-details-titles"><div class="bb-details-name">Object versions</div><div class="bb-details-prefix">${escapeHTML(key)}</div></div></div><div class="bb-details-body"><div class="bb-version-toolbar"><button type="button" class="bb-btn bb-btn-primary" data-version-compare-selected disabled><i class="mdi mdi-swap-vertical"></i><span>Compare selected</span></button><span data-version-selection>Choose two versions</span></div><div class="data-table-scroll bb-version-table"><table class="data-table"><thead><tr><th aria-label="Selection"></th><th>State</th><th>Version</th><th>Size</th><th>Modified</th><th>Actions</th></tr></thead><tbody data-version-body>${initialRows}</tbody></table></div><div class="bb-version-pagination"><button type="button" class="bb-btn" data-version-more${pageToken ? '' : ' hidden'}>Load more</button><span data-version-count>${versions.length.toLocaleString()} version record(s)</span></div></div></div>`,
        onOpen: ({ overlay }) => {
          const body = overlay.querySelector('[data-version-body]');
          const moreButton = overlay.querySelector('[data-version-more]');
          const count = overlay.querySelector('[data-version-count]');
          const compareButton = overlay.querySelector('[data-version-compare-selected]');
          const selectionLabel = overlay.querySelector('[data-version-selection]');
          const selected = [];

          const refreshSelection = () => {
            const selectedSet = new Set(selected);
            overlay.querySelectorAll('[data-version-select]').forEach(input => {
              const index = Number(input.dataset.versionSelect);
              input.checked = selectedSet.has(index);
              input.disabled = selected.length >= 2 && !selectedSet.has(index);
            });
            compareButton.disabled = selected.length !== 2;
            selectionLabel.textContent = selected.length === 2 ? 'Two versions selected' : `${selected.length} of 2 selected`;
          };
          const updateFooter = () => {
            moreButton.hidden = !pageToken;
            count.textContent = `${versions.length.toLocaleString()} version record(s)`;
            refreshSelection();
          };
          const appendPage = async () => {
            if (!pageToken || moreButton.disabled) return;
            moreButton.disabled = true;
            moreButton.textContent = 'Loading...';
            try {
              const page = await BB.api.versions(key, { pageToken, maximum: 250, instance });
              const offset = versions.length;
              const incoming = page.versions || [];
              versions.push(...incoming);
              body.insertAdjacentHTML('beforeend', incoming.map((version, index) => renderRow(version, offset + index)).join(''));
              pageToken = page.nextPageToken || '';
              updateFooter();
            } catch (error) {
              ui().toast(`Loading versions failed: ${String(error?.message || error)}`, { status: 'error', duration: 6000 });
            } finally {
              moreButton.disabled = false;
              moreButton.textContent = 'Load more';
            }
          };
          const reload = async () => {
            const page = await BB.api.versions(key, { maximum: 250, instance });
            versions.splice(0, versions.length, ...(page.versions || []));
            selected.splice(0, selected.length);
            pageToken = page.nextPageToken || '';
            body.innerHTML = versions.map(renderRow).join('');
            updateFooter();
          };

          moreButton.addEventListener('click', appendPage);
          compareButton.addEventListener('click', async () => {
            if (selected.length !== 2) return;
            const left = versions[selected[0]];
            const right = versions[selected[1]];
            if (!left || !right || left.deleteMarker || right.deleteMarker) return;
            await compareVersions(key, left.version, right.version, { instance });
          });
          overlay.addEventListener('change', event => {
            const input = event.target.closest('[data-version-select]');
            if (!input) return;
            const index = Number(input.dataset.versionSelect);
            const existing = selected.indexOf(index);
            if (input.checked && existing < 0 && selected.length < 2) selected.push(index);
            if (!input.checked && existing >= 0) selected.splice(existing, 1);
            refreshSelection();
          });
          overlay.addEventListener('click', async event => {
            const target = event.target.closest('[data-version-download],[data-version-restore],[data-version-delete]');
            if (!target) return;
            const rawIndex = target.dataset.versionDownload ?? target.dataset.versionRestore ?? target.dataset.versionDelete;
            const version = versions[Number(rawIndex)];
            if (!version) return;
            try {
              if (target.hasAttribute('data-version-download')) {
                await downloadObject(key, key.split('/').pop(), { version: version.version, instance });
                return;
              }
              if (target.hasAttribute('data-version-restore')) {
                if (!(await requirePermissions(['write']))) return;
                if (!(await ui().confirm({ title: 'Restore version', message: `Create a new current version of "${key}" from ${version.version}?` }))) return;
                await BB.api.restoreVersion(key, version.version, instance);
                ui().toast('Version restored.', { type: 'success', duration: 4000 });
                await reload();
                return;
              }
              if (target.hasAttribute('data-version-delete')) {
                if (!(await requirePermissions(['delete']))) return;
                const message = version.deleteMarker
                  ? `Permanently remove delete marker ${version.version} from "${key}"?${version.isCurrent ? ' The previous object version may become current again.' : ''}`
                  : `Permanently delete exact version ${version.version} of "${key}"?${version.isCurrent ? ' A previous version or delete marker may become current.' : ''}`;
                if (!(await ui().confirm({ title: version.deleteMarker ? 'Remove delete marker' : 'Delete version', message }))) return;
                await BB.api.deleteVersion(key, version.version, instance);
                ui().toast(version.deleteMarker ? 'Delete marker removed.' : 'Version deleted.', { type: 'success', duration: 4000 });
                await reload();
              }
            } catch (error) {
              ui().toast(`Version action failed: ${String(error?.message || error)}`, { status: 'error', duration: 6000 });
            }
          });
          updateFooter();
        }
      });
      return true;
    } catch (error) {
      if (Number(error?.status || 0) === 501) return false;
      await ui().alert({ title: 'Versions', message: String(error?.message || error) });
      return false;
    }
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
    waitForJob,
    downloadObject,
    showVersions,
    triggerBrowserDownload,
    formatTransferDetail,
    formatBytes,
    isAbortError
  };
})();
