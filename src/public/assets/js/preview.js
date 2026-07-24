(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const config = { instanceId: '', capabilities: {}, trashPrefix: '' };
  const MAX_TEXT_PREVIEW = 8 * 1024 * 1024;
  const MAX_WORD_PREVIEW = 128 * 1024 * 1024;
  const TEXT_SNIFF_LIMIT = 128 * 1024;
  const MAMMOTH_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.12.0/mammoth.browser.min.js';
  BB.cfg = config;

  let currentInstance = null;
  let viewerResizeObserver = null;
  let viewerLayoutFrame = 0;
  const activeMediaCleanups = new Set();
  let pdfLoaderPromise = null;
  let mammothLoaderPromise = null;
  let activeDocumentSearch = null;
  let activeDocumentSearchLabel = '';
  let activeSearchController = null;

  function byId(id) { return document.getElementById(id); }

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function listedObjectMetadata() {
    const params = new URLSearchParams(location.search);
    if (params.get('listed') !== '1' || !params.has('size')) return null;
    const size = Number(params.get('size'));
    return {
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      mime: String(params.get('mime') || ''),
      etag: String(params.get('etag') || ''),
      lastModified: String(params.get('lastModified') || '')
    };
  }

  function scheduleViewerLayout() {
    if (viewerLayoutFrame) cancelAnimationFrame(viewerLayoutFrame);
    viewerLayoutFrame = requestAnimationFrame(() => {
      viewerLayoutFrame = 0;
      const shell = document.querySelector('.viewer');
      const bar = document.querySelector('.bar');
      const content = byId('viewer');
      if (!shell || !bar || !content) return;

      const headerHeight = Math.ceil(bar.getBoundingClientRect().height);
      shell.style.setProperty('--preview-header-height', `${headerHeight}px`);
      const contentHeight = Math.max(content.scrollHeight, content.getBoundingClientRect().height);
      shell.classList.toggle('is-content-tall', contentHeight > shell.clientHeight + 1);
    });
  }

  function setPreviewMode(type) {
    const shell = document.querySelector('.viewer');
    if (!shell) return;
    const contained = ['tabular', 'spreadsheet', 'parquet', 'json'].includes(type);
    const wide = ['tabular', 'spreadsheet', 'parquet', 'json'].includes(type);
    shell.classList.toggle('is-scroll-contained', contained);
    shell.classList.toggle('is-wide-preview', wide);
    shell.classList.toggle('is-adaptive-code', type === 'code');
    const viewportImage = ['image', 'raw-image', 'image-convert'].includes(type);
    document.body.classList.toggle('is-viewport-image', viewportImage);
    document.documentElement.classList.toggle('is-viewport-image', viewportImage);
    shell.dataset.previewType = String(type || 'unknown');
  }

  function cleanupPreviewResources() {
    activeDocumentSearch = null;
    activeDocumentSearchLabel = '';
    activeSearchController?.abort();
    activeSearchController = null;
    for (const cleanup of activeMediaCleanups) {
      try { cleanup(); } catch (_) {}
    }
    activeMediaCleanups.clear();
  }

  function installViewerLayoutObserver() {
    const content = byId('viewer');
    if ('ResizeObserver' in window && content) {
      viewerResizeObserver = new ResizeObserver(scheduleViewerLayout);
      viewerResizeObserver.observe(content);
      const bar = document.querySelector('.bar');
      if (bar) viewerResizeObserver.observe(bar);
    }
    window.addEventListener('resize', scheduleViewerLayout, { passive: true });
    scheduleViewerLayout();
  }

  function currentKey() {
    const raw = (location.hash || '#').slice(1);
    try { return decodeURIComponent(raw).replace(/^\/+/, ''); }
    catch (_) { return raw.replace(/^\/+/, ''); }
  }

  function encodeHash(value) {
    return encodeURIComponent(value || '').replace(/%2F/gi, '/');
  }

  function parentPrefix(key) {
    const slash = String(key || '').lastIndexOf('/');
    return slash < 0 ? '' : key.slice(0, slash + 1);
  }

  function formatBytes(size) {
    const value = Number(size);
    if (!Number.isFinite(value)) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function setDocMeta(key, size) {
    const name = key.split('/').pop() || key;
    const prefix = parentPrefix(key).replace(/\/$/, '');
    byId('docName').textContent = name || 'Object';
    byId('docName').title = name || 'Object';
    byId('docPrefix').textContent = prefix ? ` / ${prefix}` : ' / root';
    byId('docSize').textContent = Number.isFinite(Number(size)) ? `(${formatBytes(size)})` : '';
    byId('instanceMeta').textContent = currentInstance
      ? `${currentInstance.name} · ${currentInstance.provider.toUpperCase()} · ${currentInstance.bucket}`
      : '';
    document.title = `${name || 'Preview'} — ${currentInstance?.name || 'Object Storage Browser'}`;
  }

  function setVisible(id, visible) {
    const element = byId(id);
    if (element) element.hidden = !visible;
  }

  function applyCapabilities() {
    const caps = config.capabilities || {};
    const read = !!caps.read?.allowed;
    const write = !!caps.write?.allowed;
    const del = !!caps.delete?.allowed;
    setVisible('openRawBtn', read);
    setVisible('pv-download', read);
    setVisible('pv-details', read);
    setVisible('pv-copy', read && write);
    setVisible('pv-rename', read && write && del);
    setVisible('pv-delete', del);
    setVisible('previewMenu', read || del);
  }

  function updateBackLink(key) {
    const url = new URL('index.html', location.href);
    if (config.instanceId) url.searchParams.set('instance', config.instanceId);
    url.hash = encodeHash(parentPrefix(key));
    byId('backBtn').href = url.pathname + url.search + url.hash;
  }

  function renderImage(url) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    image.loading = 'eager';
    image.decoding = 'async';
    return image;
  }

  function languageLabel(code) {
    const value = String(code || '').trim();
    if (!value) return '';
    try {
      if (typeof Intl.DisplayNames === 'function') {
        const displayNames = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
        return displayNames.of(value) || value;
      }
    } catch (_) {}
    return value;
  }

  function createTrackControl(iconName, labelText) {
    const label = document.createElement('label');
    label.className = 'media-track-control';
    const icon = document.createElement('i');
    icon.className = `mdi mdi-${iconName}`;
    const text = document.createElement('span');
    text.textContent = labelText;
    const select = document.createElement('select');
    label.append(icon, text, select);
    return { label, select };
  }

  function listTracks(trackList) {
    const tracks = [];
    const length = Number(trackList?.length || 0);
    for (let index = 0; index < length; index++) {
      const track = trackList[index];
      if (track) tracks.push(track);
    }
    return tracks;
  }

  function refreshMediaControlsVisibility(controls) {
    controls.hidden = !controls.querySelector('.media-track-control:not([hidden])');
  }

  function installNativeAudioSelector(media, controls) {
    const trackList = media.audioTracks;
    if (!trackList) return { refresh() {}, destroy() {} };
    const control = createTrackControl('volume-high', 'Audio');
    const refresh = () => {
      const tracks = listTracks(trackList);
      control.select.replaceChildren();
      let enabledIndex = 0;
      tracks.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = track.label || languageLabel(track.language) || `Track ${index + 1}`;
        if (track.enabled) enabledIndex = index;
        control.select.appendChild(option);
      });
      control.select.value = String(enabledIndex);
      control.label.hidden = tracks.length < 2;
      refreshMediaControlsVisibility(controls);
    };
    control.select.addEventListener('change', () => {
      const selected = Number(control.select.value);
      listTracks(trackList).forEach((track, index) => { track.enabled = index === selected; });
      refresh();
    });
    controls.appendChild(control.label);
    if (trackList.addEventListener) {
      trackList.addEventListener('addtrack', refresh);
      trackList.addEventListener('removetrack', refresh);
      trackList.addEventListener('change', refresh);
    }
    refresh();
    return { control, refresh, destroy() { control.label.remove(); } };
  }

  function renderAudio(url, key) {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-audio-stage';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    const status = document.createElement('div');
    status.className = 'media-preview-status';
    status.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'media-track-controls';
    controls.hidden = true;
    wrapper.append(audio, status, controls);
    installNativeAudioSelector(audio, controls);

    audio.addEventListener('error', () => {
      const name = String(key || '').split('/').pop() || 'this audio file';
      status.hidden = false;
      status.textContent = `Native audio playback is unavailable for ${name}.`;
      scheduleViewerLayout();
    });
    audio.addEventListener('loadedmetadata', () => {
      status.hidden = true;
      scheduleViewerLayout();
    });

    const cleanup = () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
    activeMediaCleanups.add(cleanup);
    return wrapper;
  }

  function loadPDFLibrary() {
    if (!pdfLoaderPromise) {
      pdfLoaderPromise = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(module => {
        module.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
        return module;
      });
    }
    return pdfLoaderPromise;
  }

  function pdfRangeChunkSize() {
    const size = Number(listedObjectMetadata()?.size || 0);
    if (size > 4 * 1024 ** 3) return 4 * 1024 * 1024;
    if (size > 512 * 1024 ** 2) return 2 * 1024 * 1024;
    if (size > 32 * 1024 ** 2) return 1024 * 1024;
    return 256 * 1024;
  }

  function renderPDF(url) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-preview';
    const toolbarRail = document.createElement('div');
    toolbarRail.className = 'pdf-toolbar-rail';
    const toolbar = document.createElement('div');
    toolbar.className = 'pdf-toolbar';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.title = 'Previous page';
    previous.innerHTML = '<i class="mdi mdi-chevron-left"></i>';
    const pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.value = '1';
    pageInput.setAttribute('aria-label', 'PDF page number');
    const pageCount = document.createElement('span');
    pageCount.textContent = '/ …';
    const next = document.createElement('button');
    next.type = 'button';
    next.title = 'Next page';
    next.innerHTML = '<i class="mdi mdi-chevron-right"></i>';
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.title = 'Zoom out';
    zoomOut.innerHTML = '<i class="mdi mdi-minus"></i>';
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.title = 'Zoom in';
    zoomIn.innerHTML = '<i class="mdi mdi-plus"></i>';
    const fit = document.createElement('button');
    fit.type = 'button';
    fit.title = 'Fit page width';
    fit.innerHTML = '<i class="mdi mdi-fit-to-page-outline"></i>';
    toolbar.append(previous, pageInput, pageCount, next, zoomOut, zoomIn, fit);
    toolbarRail.appendChild(toolbar);
    const toolbarSpacer = document.createElement('div');
    toolbarSpacer.className = 'pdf-toolbar-spacer';
    const status = document.createElement('div');
    status.className = 'pdf-status';
    status.textContent = 'Loading the PDF index with byte-range requests…';
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'pdf-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvasWrap.appendChild(canvas);
    wrapper.append(toolbarRail, toolbarSpacer, status, canvasWrap);

    const controller = new AbortController();
    let documentTask = null;
    let pdf = null;
    let renderTask = null;
    let currentPage = 1;
    let scale = 1;
    let fitWidth = true;

    const renderPage = async pageNumber => {
      if (!pdf || controller.signal.aborted) return;
      currentPage = Math.max(1, Math.min(pdf.numPages, Number(pageNumber) || 1));
      pageInput.value = String(currentPage);
      pageCount.textContent = `/ ${Number(pdf.numPages).toLocaleString()}`;
      previous.disabled = currentPage <= 1;
      next.disabled = currentPage >= pdf.numPages;
      renderTask?.cancel?.();
      status.textContent = `Loading page ${currentPage.toLocaleString()}…`;
      const page = await pdf.getPage(currentPage);
      const baseViewport = page.getViewport({ scale: 1 });
      const available = Math.max(320, Math.min(window.innerWidth - 32, canvasWrap.clientWidth || window.innerWidth - 32));
      const effectiveScale = fitWidth ? Math.min(3, available / baseViewport.width) : scale;
      const viewport = page.getViewport({ scale: effectiveScale });
      const outputScale = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext('2d', { alpha: false });
      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
      });
      try {
        await renderTask.promise;
        status.textContent = `Page ${currentPage.toLocaleString()} of ${Number(pdf.numPages).toLocaleString()}`;
        scheduleViewerLayout();
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') throw error;
      }
    };

    previous.addEventListener('click', () => void renderPage(currentPage - 1));
    next.addEventListener('click', () => void renderPage(currentPage + 1));
    pageInput.addEventListener('change', () => void renderPage(pageInput.value));
    pageInput.addEventListener('keydown', event => { if (event.key === 'Enter') void renderPage(pageInput.value); });
    zoomOut.addEventListener('click', () => { fitWidth = false; scale = Math.max(.25, scale / 1.2); void renderPage(currentPage); });
    zoomIn.addEventListener('click', () => { fitWidth = false; scale = Math.min(6, scale * 1.2); void renderPage(currentPage); });
    fit.addEventListener('click', () => { fitWidth = true; void renderPage(currentPage); });

    loadPDFLibrary().then(pdfjs => {
      if (controller.signal.aborted) return;
      documentTask = pdfjs.getDocument({
        url,
        // Large PDFs otherwise require thousands of separately billed S3/GCS
        // range requests before PDF.js can resolve the cross-reference tree.
        rangeChunkSize: pdfRangeChunkSize(),
        disableAutoFetch: true,
        disableStream: true,
        isEvalSupported: false
      });
      return documentTask.promise;
    }).then(document => {
      if (!document || controller.signal.aborted) return;
      pdf = document;
      void renderPage(1);
    }).catch(error => {
      if (controller.signal.aborted) return;
      toolbarRail.remove();
      toolbarSpacer.remove();
      canvasWrap.remove();
      status.textContent = `PDF preview unavailable: ${error.message || error}. Use “Open original” to let the browser handle the file.`;
    });

    const cleanup = () => {
      controller.abort();
      renderTask?.cancel?.();
      documentTask?.destroy?.();
      pdf?.destroy?.();
    };
    activeMediaCleanups.add(cleanup);
    return wrapper;
  }

  function loadMammothLibrary() {
    if (window.mammoth?.convertToHtml) return Promise.resolve(window.mammoth);
    if (!mammothLoaderPromise) {
      mammothLoaderPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-mammoth-version="1.12.0"]');
        const complete = () => window.mammoth?.convertToHtml
          ? resolve(window.mammoth)
          : reject(new Error('The Word document reader loaded without exposing its browser API.'));
        if (existing) {
          existing.addEventListener('load', complete, { once: true });
          existing.addEventListener('error', () => reject(new Error('Unable to load the Word document reader.')), { once: true });
          if (existing.dataset.loaded === 'true') complete();
          return;
        }
        const script = document.createElement('script');
        script.src = MAMMOTH_SCRIPT_URL;
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        script.dataset.mammothVersion = '1.12.0';
        script.addEventListener('load', () => {
          script.dataset.loaded = 'true';
          complete();
        }, { once: true });
        script.addEventListener('error', () => reject(new Error('Unable to load the Word document reader.')), { once: true });
        document.head.appendChild(script);
      }).catch(error => {
        mammothLoaderPromise = null;
        throw error;
      });
    }
    return mammothLoaderPromise;
  }

  async function renderWordDocument(url, size) {
    if (Number(size) > MAX_WORD_PREVIEW) {
      throw new Error(`Word previews are limited to ${MAX_WORD_PREVIEW / 1024 / 1024} MiB to protect browser memory.`);
    }
    const [mammoth, response] = await Promise.all([
      loadMammothLibrary(),
      fetch(url, { cache: 'no-store' })
    ]);
    if (!response.ok) throw new Error(`Unable to read Word document: HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer }, {
      convertImage: mammoth.images.imgElement(image => image.read('base64').then(value => ({
        src: `data:${image.contentType || 'image/png'};base64,${value}`
      })))
    });
    const wrapper = document.createElement('article');
    wrapper.className = 'word-document';
    wrapper.innerHTML = BB.render.sanitizeHTML(result.value || '', { allowDataImages: true });
    if (!wrapper.childNodes.length) {
      wrapper.appendChild(unavailablePreview('The document is empty', 'No readable Word content was found.', 'file-word-outline'));
    }
    if (Array.isArray(result.messages) && result.messages.length) {
      const details = document.createElement('details');
      details.className = 'word-preview-warnings';
      const summary = document.createElement('summary');
      summary.textContent = `${result.messages.length} conversion notice${result.messages.length === 1 ? '' : 's'}`;
      const list = document.createElement('ul');
      result.messages.slice(0, 25).forEach(message => {
        const item = document.createElement('li');
        item.textContent = String(message?.message || message || 'Word conversion notice');
        list.appendChild(item);
      });
      details.append(summary, list);
      wrapper.prepend(details);
    }
    return wrapper;
  }

  function unavailablePreview(title, message, icon = 'file-question-outline') {
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-empty';
    const iconElement = document.createElement('i');
    iconElement.className = `mdi mdi-${icon}`;
    const heading = document.createElement('strong');
    heading.textContent = title;
    const copy = document.createElement('p');
    copy.textContent = message;
    wrapper.append(iconElement, heading, copy);
    return wrapper;
  }

  function officeUnavailable(type) {
    const labels = {
      'word-unavailable': ['Word preview is not available', 'This binary Word document is not rendered as text. Download it and open it with a compatible word processor.', 'file-word-outline'],
      'sheet-unavailable': ['Spreadsheet preview is not available', 'This spreadsheet format is not supported by the built-in viewer. XLS, XLSX, XLSM, CSV, TSV, JSON Lines, and Parquet files have dedicated previews.', 'file-excel-outline'],
      'slide-unavailable': ['Presentation preview is not available', 'This binary presentation format is not rendered in the browser. Download it and open it with a compatible presentation application.', 'file-powerpoint-outline']
    };
    return unavailablePreview(...labels[type]);
  }

  function renderError(error) {
    setPreviewMode('message');
    const container = byId('viewer');
    container.className = 'preview-error';
    container.replaceChildren();
    const icon = document.createElement('i');
    icon.className = 'mdi mdi-alert-circle-outline';
    const title = document.createElement('strong');
    title.textContent = 'Preview unavailable';
    const message = document.createElement('p');
    message.textContent = String(error?.message || error || 'Unknown error');
    container.append(icon, title, message);
    scheduleViewerLayout();
  }

  async function fetchLimitedText(url, size) {
    if (Number(size) > MAX_TEXT_PREVIEW) {
      throw new Error(`Code and Markdown previews are limited to ${MAX_TEXT_PREVIEW / 1024 / 1024} MiB.`);
    }
    const response = await fetch(url, { headers: { Range: `bytes=0-${MAX_TEXT_PREVIEW - 1}` } });
    if (!response.ok && response.status !== 206) throw new Error(`Unable to read object: HTTP ${response.status}`);
    return response.text();
  }

  function looksLikeText(bytes) {
    if (!bytes.length) return true;
    let controls = 0;
    let replacements = 0;
    for (const byte of bytes) {
      if (byte === 0) return false;
      if (byte < 9 || (byte > 13 && byte < 32)) controls++;
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    for (const character of decoded) if (character === '\uFFFD') replacements++;
    return controls / bytes.length < 0.01 && replacements / Math.max(decoded.length, 1) < 0.01;
  }

  async function sniffUnknownText(url, key, size) {
    if (Number(size) > MAX_TEXT_PREVIEW) return null;
    const end = Math.max(0, Math.min(Number(size) || TEXT_SNIFF_LIMIT, TEXT_SNIFF_LIMIT) - 1);
    const response = await fetch(url, { headers: { Range: `bytes=0-${end}` } });
    if (!response.ok && response.status !== 206) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!looksLikeText(bytes)) return null;
    if (Number(size) > bytes.length) return fetchLimitedText(url, size);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  async function showDocumentSearchResults(payload) {
    const matches = Array.from(payload?.matches || []);
    const rows = matches.map(match => {
      const location = Number(match.line) > 0
        ? `Line ${Number(match.line).toLocaleString()}`
        : `Byte ${Number(match.offset || 0).toLocaleString()}`;
      return `<li><span class="document-search-location">${escapeHTML(location)}</span><code>${escapeHTML(match.snippet || '')}</code></li>`;
    }).join('');
    const total = Math.max(0, Number(payload?.total || 0));
    const scanned = Math.max(0, Number(payload?.bytesScanned || 0));
    const note = payload?.truncated
      ? `Showing the first ${matches.length.toLocaleString()} of ${total.toLocaleString()} matches.`
      : `${total.toLocaleString()} match${total === 1 ? '' : 'es'}.`;
    await BB.ui.alert({
      html: `<div class="document-search-results">
        <div class="document-search-head"><i class="mdi mdi-file-search-outline"></i><div><strong>Search results</strong><span>${escapeHTML(note)} ${scanned ? `${escapeHTML(formatBytes(scanned))} scanned.` : ''}</span></div></div>
        <ol>${rows || '<li class="document-search-empty">No match was found.</li>'}</ol>
      </div>`
    });
  }

  async function searchRawDocument(key, query) {
    activeSearchController?.abort();
    activeSearchController = new AbortController();
    const payload = await BB.api.searchDocument({
      key,
      query,
      instance: config.instanceId,
      signal: activeSearchController.signal
    });
    await showDocumentSearchResults(payload);
  }

  function configureDocumentSearch(node, type, key) {
    activeDocumentSearch = null;
    activeDocumentSearchLabel = '';
    // Delimited text previews intentionally load only a bounded initial
    // portion of the object. Their Ctrl/Cmd+F action must therefore use the
    // streaming backend search instead of filtering only the visible rows.
    if (type === 'tabular') {
      activeDocumentSearch = query => searchRawDocument(key, query);
      activeDocumentSearchLabel = 'Search the complete object';
      return;
    }
    if (node && typeof node.documentSearch === 'function') {
      activeDocumentSearch = query => node.documentSearch(query);
      activeDocumentSearchLabel = type === 'spreadsheet'
        ? 'Search the complete active worksheet'
        : type === 'parquet'
          ? 'Search the complete Parquet document'
          : type === 'sqlite'
            ? 'Search the complete active SQLite table'
            : 'Search this document';
      return;
    }
    if (['json', 'code', 'markdown'].includes(type)) {
      activeDocumentSearch = query => searchRawDocument(key, query);
      activeDocumentSearchLabel = 'Search the complete object';
    }
  }

  async function openDocumentSearch() {
    if (typeof activeDocumentSearch !== 'function') return;
    const query = await BB.ui.prompt({
      title: 'Search document',
      message: activeDocumentSearchLabel || 'Search the complete document',
      defaultValue: ''
    });
    if (query == null || !String(query).trim()) return;
    const notification = BB.ui.toast('Searching document…', {
      persistent: true,
      status: 'loading',
      indeterminate: true,
      detail: String(query).trim()
    });
    try {
      await activeDocumentSearch(String(query).trim());
      notification.update('Search completed.', {
        persistent: false,
        status: 'success',
        progress: 1,
        indeterminate: false,
        detail: String(query).trim(),
        duration: 3500
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        notification.hide?.();
        return;
      }
      notification.update('Search failed.', {
        persistent: false,
        status: 'error',
        indeterminate: false,
        detail: String(error?.message || error),
        duration: 6500
      });
    }
  }

  function normalizeHorizontalPreviewScrollers(root) {
    if (!root || typeof root.querySelectorAll !== 'function' || typeof BB.render?.forwardVerticalWheel !== 'function') return;
    const selectors = [
      '.code-horizontal-scroll',
      '.data-table-scroll',
      '.word-document table',
      '.markdown-body table',
      '.spreadsheet-tabs',
      '.data-preview-toolbar'
    ];
    root.querySelectorAll(selectors.join(',')).forEach(scroller => BB.render.forwardVerticalWheel(scroller));
  }

  async function render() {
    cleanupPreviewResources();
    const key = currentKey();
    const container = byId('viewer');
    if (!key) {
      renderError(new Error('No object key is present in the URL.'));
      return;
    }
    if (!config.capabilities.read?.allowed) {
      setDocMeta(key, NaN);
      updateBackLink(key);
      renderError(new Error('Read access is not available for this storage instance.'));
      return;
    }

    setPreviewMode('loading');
    container.className = 'preview-loading';
    container.replaceChildren();
    const spinner = document.createElement('i');
    spinner.className = 'mdi mdi-loading mdi-spin';
    const loading = document.createElement('span');
    loading.textContent = 'Loading preview...';
    container.append(spinner, loading);
    scheduleViewerLayout();

    try {
      const metadata = listedObjectMetadata() || await BB.api.head(key);
      setDocMeta(key, metadata.size);
      updateBackLink(key);
      const rawURL = BB.api.urlForKey(key);
      const browserPreviewURL = BB.api.previewURLForKey(key);
      byId('openRawBtn').href = rawURL;
      const type = BB.detect.resolveType(key, metadata.mime);
      let node;
      let className = 'preview-content';

      if (type === 'image') node = renderImage(browserPreviewURL);
      else if (type === 'raw-image' || type === 'image-convert') node = renderImage(BB.api.imagePreviewURL(key));
      else if (type === 'video') node = unavailablePreview('Video preview is disabled', 'Download the original video to play it with a local media player.', 'file-video-outline');
      else if (type === 'audio') node = renderAudio(browserPreviewURL, key, metadata.mime);
      else if (type === 'pdf') node = renderPDF(browserPreviewURL);
      else if (type === 'word') {
        node = await renderWordDocument(rawURL, metadata.size);
        className = 'preview-document word-preview';
      } else if (type === 'json') {
        node = BB.jsonViewer.render({
          key,
          size: metadata.size,
          etag: metadata.etag || metadata.headers?.etag || '',
          instance: config.instanceId
        });
        className = 'preview-data json-preview-host';
      } else if (type === 'markdown') {
        node = BB.render.renderMarkdown(await fetchLimitedText(rawURL, metadata.size));
        className = 'markdown-body preview-document';
      } else if (type === 'code') {
        node = BB.render.renderCode(await fetchLimitedText(rawURL, metadata.size), BB.detect.resolveLang(key, metadata.mime));
        className = 'preview-code';
      } else if (type === 'tabular') {
        node = await BB.tabular.fetchTextTable(rawURL, key, metadata.size, {
          etag: metadata.etag || metadata.headers?.etag || '',
          instance: config.instanceId
        });
        className = 'preview-data';
      } else if (type === 'spreadsheet') {
        node = await BB.tabular.renderSpreadsheet(rawURL, key, metadata.size);
        className = 'preview-data';
      } else if (type === 'parquet') {
        node = await BB.tabular.renderParquet(rawURL, metadata.size);
        className = 'preview-data';
      } else if (type === 'sqlite') {
        node = await BB.sqliteViewer.render({ key, size: metadata.size, instance: config.instanceId });
        className = 'preview-data sqlite-preview-host';
      } else if (type === 'word-unavailable' || type === 'sheet-unavailable' || type === 'slide-unavailable') {
        node = officeUnavailable(type);
      } else if (type === 'archive') {
        node = unavailablePreview('Archive preview is not available', 'Download the archive to inspect its contents.', 'folder-zip-outline');
      } else {
        const text = await sniffUnknownText(rawURL, key, metadata.size);
        if (text != null) {
          node = BB.render.renderCode(text, BB.detect.resolveLang(key, metadata.mime));
          className = 'preview-code';
        } else {
          node = unavailablePreview('No preview available', 'Download the file and open it with a compatible application.');
        }
      }

      setPreviewMode(type);
      container.className = className;
      container.replaceChildren(node);
      normalizeHorizontalPreviewScrollers(node);
      configureDocumentSearch(node, type, key);
      if (typeof node?.cleanup === 'function') activeMediaCleanups.add(() => node.cleanup());
      if (type === 'markdown' && typeof BB.render.renderMermaid === 'function') {
        await BB.render.renderMermaid(node);
      }
      scheduleViewerLayout();
    } catch (error) {
      renderError(error);
    }
  }

  async function initialize() {
    try {
      const response = await BB.api.instances();
      const instances = response.instances || [];
      const build = response.build || {};
      const buildBadge = byId('previewBuild');
      if (buildBadge && build.display) {
        buildBadge.hidden = false;
        buildBadge.querySelector('span').textContent = build.display;
        buildBadge.title = `Release ${build.version || 'dev'}${build.commit && build.commit !== 'unknown' ? ` · source ${build.commit}` : ''}${build.date ? ` · built ${build.date}` : ''}`;
      }
      const requested = new URLSearchParams(location.search).get('instance');
      currentInstance = instances.find(item => item.id === requested)
        || instances.find(item => item.id === response.default)
        || instances[0]
        || null;
      if (!currentInstance) throw new Error('No storage instance is configured.');

      config.instanceId = currentInstance.id;
      config.capabilities = currentInstance.capabilities || {};
      config.trashPrefix = currentInstance.trashPrefix || '';
      BB.api.setInstance(currentInstance.id);
      applyCapabilities();
      await render();
    } catch (error) {
      renderError(error);
    }
  }

  byId('pv-download').addEventListener('click', () => {
    const key = currentKey();
    BB.actions.downloadObject(key, key.split('/').pop());
  });
  byId('pv-copy').addEventListener('click', async () => { await BB.actions.copyObject(currentKey()); });
  byId('pv-rename').addEventListener('click', async () => {
    const destination = await BB.actions.renameObject(currentKey());
    if (destination) location.hash = encodeHash(destination);
  });
  byId('pv-details').addEventListener('click', () => BB.actions.showMetadata(currentKey(), listedObjectMetadata() || {}));
  byId('pv-delete').addEventListener('click', async () => {
    if (await BB.actions.deleteObject(currentKey())) location.href = byId('backBtn').href;
  });

  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== 'f') return;
    if (typeof activeDocumentSearch !== 'function') return;
    event.preventDefault();
    void openDocumentSearch();
  });
  window.addEventListener('hashchange', render);
  installViewerLayoutObserver();
  initialize();
})();
