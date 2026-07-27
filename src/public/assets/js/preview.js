(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const config = { instanceId: '', capabilities: {}, operations: {}, runtime: {}, versioningSupported: false };
  const MAX_TEXT_PREVIEW = 8 * 1024 * 1024;
  const TEXT_SNIFF_LIMIT = 128 * 1024;
  const PDFJS_VERSION = '4.10.38';
  // PDF previews are rendered only through the local canvas renderer. There is
  // no browser-native embed/iframe fallback because native PDF plugins may fetch
  // the complete object and cannot be controlled by the application.
  const PDFJS_MODULE_URL = `assets/vendor/pdfjs/${PDFJS_VERSION}/pdf.min.mjs`;
  const PDFJS_WORKER_URL = `assets/vendor/pdfjs/${PDFJS_VERSION}/pdf.worker.min.mjs`;
  const PDF_MIN_SCALE = .2;
  const PDF_MAX_SCALE = 6;
  const PDF_MAX_CANVAS_PIXELS = 10 * 1024 * 1024;
  const DETERMINISTIC_ZIP_PREVIEW_EXTENSIONS = new Set(['zip', 'jar', 'war', 'ear', 'apk', 'aar', 'xpi', 'crx', 'vsix', 'epub']);
  BB.cfg = config;

  let currentInstance = null;
  let viewerResizeObserver = null;
  let viewerLayoutFrame = 0;
  const activeMediaCleanups = new Set();
  let activeDocumentSearch = null;
  let activeDocumentSearchLabel = '';
  let activeSearchController = null;
  let pdfLoaderPromise = null;

  function byId(id) { return document.getElementById(id); }

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function currentVersion() {
    return new URLSearchParams(location.search).get('version') || '';
  }

  function currentArchiveEntry() {
    return String(new URLSearchParams(location.search).get('entry') || '').replace(/^\/+/, '');
  }

  function scheduleViewerLayout() {
    if (viewerLayoutFrame) cancelAnimationFrame(viewerLayoutFrame);
    viewerLayoutFrame = requestAnimationFrame(() => {
      viewerLayoutFrame = 0;
      const shell = document.querySelector('.viewer');
      const bar = document.querySelector('.bar');
      const content = byId('viewer');
      if (!shell || !bar || !content) return;

      const headerHeight = Math.ceil((BB.viewport?.rect(bar) || bar.getBoundingClientRect()).height);
      shell.style.setProperty('--preview-header-height', `${headerHeight}px`);
      const contentHeight = Math.max(content.scrollHeight, (BB.viewport?.rect(content) || content.getBoundingClientRect()).height);
      shell.classList.toggle('is-content-tall', contentHeight > shell.clientHeight + 1);
    });
  }

  function setPreviewMode(type, sourceType = type) {
    const shell = document.querySelector('.viewer');
    if (!shell) return;
    const contained = ['tabular', 'spreadsheet', 'parquet', 'json', 'archive', 'structured'].includes(type);
    const wide = ['tabular', 'spreadsheet', 'parquet', 'json', 'pdf', 'archive', 'structured'].includes(type);
    shell.classList.toggle('is-scroll-contained', contained);
    shell.classList.toggle('is-wide-preview', wide);
    shell.classList.toggle('is-adaptive-code', type === 'code');
    shell.classList.toggle('is-certificate-preview', sourceType === 'certificate');
    const viewportImage = ['image', 'raw-image', 'image-convert'].includes(type);
    const viewportPDF = type === 'pdf';
    document.body.classList.toggle('is-viewport-image', viewportImage);
    document.documentElement.classList.toggle('is-viewport-image', viewportImage);
    document.body.classList.toggle('is-viewport-pdf', viewportPDF);
    document.documentElement.classList.toggle('is-viewport-pdf', viewportPDF);
    if (!viewportPDF) shell.style.removeProperty('--pdf-page-shell-width');
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
    const route = BB.runtime?.storageRoute?.();
    if (route?.view === 'preview') return String(route.path || '').replace(/^\/+/, '');
    return String(new URLSearchParams(location.search).get('path') || '').replace(/^\/+/, '');
  }

  function previewLocation(key) {
    const url = new URL(BB.api.previewPageURL(key, {
      instance: config.instanceId,
      version: currentVersion(),
      entry: currentArchiveEntry()
    }));
    return url.pathname + url.search + url.hash;
  }

  function replacePreviewLocation(key) {
    const target = previewLocation(key);
    const current = location.pathname + location.search;
    if (target !== current) history.replaceState(null, '', target);
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

  function setDocMeta(key, size, archiveKey = '') {
    const name = key.split('/').pop() || key;
    const prefix = parentPrefix(key).replace(/\/$/, '');
    byId('docName').textContent = name || 'Object';
    byId('docName').title = name || 'Object';
    byId('docPrefix').textContent = archiveKey
      ? ` / ${archiveKey}${prefix ? ` / ${prefix}` : ''}`
      : (prefix ? ` / ${prefix}` : ' / root');
    byId('docSize').textContent = Number.isFinite(Number(size)) ? `(${formatBytes(size)})` : '';
    byId('instanceMeta').textContent = currentInstance
      ? `${currentInstance.name} · ${currentInstance.provider.toUpperCase()} · ${currentInstance.bucket}`
      : '';
    document.title = `${name || 'Preview'} - ${currentInstance?.name || 'Object Storage Browser'}`;
  }

  function setVisible(id, visible) {
    const element = byId(id);
    if (element) element.hidden = !visible;
  }

  function applyCapabilities() {
    const can = name => BB.capabilities?.actionable
      ? BB.capabilities.actionable(config, name)
      : config.capabilities?.read?.allowed !== false;
    const preview = can('preview');
    const download = can('download');
    const details = can('details');
    const copy = can('copy');
    const rename = can('rename');
    const remove = can('delete');
    setVisible('openRawBtn', download);
    setVisible('pv-download', download);
    const archiveEntry = !!currentArchiveEntry();
    setVisible('pv-details', details && !archiveEntry);
    setVisible('pv-copy', copy && !archiveEntry);
    setVisible('pv-rename', rename && !archiveEntry);
    const selectedHistoricalVersion = !!currentVersion();
    const versioning = currentInstance?.versioningSupported === true;
    setVisible('pv-versions', versioning && preview && !archiveEntry);
    setVisible('pv-copy', copy && !selectedHistoricalVersion && !archiveEntry);
    setVisible('pv-rename', rename && !selectedHistoricalVersion && !archiveEntry);
    setVisible('pv-delete', remove && !selectedHistoricalVersion && !archiveEntry);
    setVisible('previewMenu', download || (!archiveEntry && (details || versioning || (!selectedHistoricalVersion && (copy || rename || remove)))));
    return preview;
  }

  function versionOptionLabel(version) {
    const date = version?.lastModified ? new Date(version.lastModified).toLocaleString() : 'Previous version';
    const identifier = String(version?.version || '');
    const short = identifier.length > 24 ? `${identifier.slice(0, 12)}…${identifier.slice(-8)}` : identifier;
    return short ? `${date} · ${short}` : date;
  }

  async function configureVersionSelector(key) {
    const control = byId('previewVersionControl');
    const select = byId('previewVersionSelect');
    if (!control || !select) return;
    control.hidden = true;
    select.replaceChildren();
    if (currentArchiveEntry() || currentInstance?.versioningSupported !== true) return;

    try {
      const versions = await BB.api.allVersions(key, { instance: config.instanceId });
      const availableVersions = versions.filter(version => version && !version.deleteMarker && version.version);
      const label = control.querySelector('span');
      if (label) label.textContent = `Version (${availableVersions.length.toLocaleString()})`;
      control.title = `${availableVersions.length.toLocaleString()} available version${availableVersions.length === 1 ? '' : 's'}`;
      const current = document.createElement('option');
      current.value = '';
      const currentRecord = availableVersions.find(version => version.isCurrent);
      current.textContent = currentRecord ? `Current · ${versionOptionLabel(currentRecord)}` : 'Current';
      select.append(current);
      for (const version of availableVersions) {
        if (!version || version.deleteMarker || version.isCurrent || !version.version) continue;
        const option = document.createElement('option');
        option.value = version.version;
        option.textContent = versionOptionLabel(version);
        select.append(option);
      }
      const selected = currentVersion();
      if (selected && !Array.from(select.options).some(option => option.value === selected)) {
        const option = document.createElement('option');
        option.value = selected;
        option.textContent = `Selected · ${selected}`;
        select.append(option);
      }
      select.value = selected;
      control.hidden = false;
    } catch (error) {
      console.warn('Unable to load object versions for the preview selector', error);
      control.hidden = true;
    }
  }

  function selectVersion(version) {
    const url = new URL(location.href);
    if (version) url.searchParams.set('version', version);
    else url.searchParams.delete('version');
    history.replaceState(null, '', url.pathname + url.search);
    applyCapabilities();
    void render();
  }

  function updateBackLink(key, entry = '') {
    if (entry) {
      byId('backBtn').href = BB.api.previewPageURL(key, {
        instance: config.instanceId,
        version: currentVersion()
      });
      return;
    }
    byId('backBtn').href = BB.api.browserPageURL(parentPrefix(key), { instance: config.instanceId });
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
      const moduleURL = new URL(PDFJS_MODULE_URL, document.baseURI).href;
      const workerURL = new URL(PDFJS_WORKER_URL, document.baseURI).href;
      pdfLoaderPromise = import(moduleURL).then(module => {
        if (!module?.getDocument || !module?.PDFDataRangeTransport) {
          throw new Error('The local PDF renderer did not expose the expected API.');
        }
        module.GlobalWorkerOptions.workerSrc = workerURL;
        return module;
      }).catch(error => {
        pdfLoaderPromise = null;
        const message = String(error?.message || error || '');
        if (message.includes('Failed to fetch dynamically imported module') || message.includes('Importing a module script failed')) {
          throw new Error('The local PDF.js renderer is missing from this build.');
        }
        throw error;
      });
    }
    return pdfLoaderPromise;
  }

  function pdfRangeChunkSize(objectSize) {
    const size = Number(objectSize || 0);
    if (size > 16 * 1024 ** 3) return 8 * 1024 * 1024;
    if (size > 4 * 1024 ** 3) return 4 * 1024 * 1024;
    if (size > 512 * 1024 ** 2) return 2 * 1024 * 1024;
    if (size > 32 * 1024 ** 2) return 1024 * 1024;
    return 256 * 1024;
  }

  function normalizePDFIfMatch(value) {
    const etag = String(value || '').trim();
    if (!etag) return '';
    if (/^(?:W\/)?".*"$/.test(etag)) return etag;
    return `"${etag.replace(/^"|"$/g, '')}"`;
  }

  async function pdfObjectMetadata(url, listed, signal) {
    const knownLength = Number(listed?.size || 0);
    const knownETag = String(listed?.etag || listed?.headers?.etag || '').trim();
    if (Number.isSafeInteger(knownLength) && knownLength > 0) {
      return { length: knownLength, etag: knownETag };
    }
    const response = await fetch(url, { method: 'HEAD', signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to read PDF metadata: HTTP ${response.status}`);
    const length = Number(response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error('The PDF size is unavailable.');
    return { length, etag: knownETag || String(response.headers.get('ETag') || '').trim() };
  }

  function parsePDFContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) return null;
    return { start, end, total };
  }

  function renderPDF(url, listedMetadata = null) {
    const boundedURL = new URL(url, document.baseURI);
    boundedURL.searchParams.set('range_only', '1');
    const rangeURL = boundedURL.href;
    url = rangeURL;
    const wrapper = document.createElement('section');
    wrapper.className = 'pdf-preview pdf-custom-preview';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('aria-label', 'PDF preview');

    const toolbar = document.createElement('div');
    toolbar.className = 'pdf-custom-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'PDF controls');

    const navigation = document.createElement('div');
    navigation.className = 'pdf-toolbar-group pdf-toolbar-navigation';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'pdf-tool-button';
    previous.title = 'Previous page';
    previous.setAttribute('aria-label', 'Previous page');
    previous.innerHTML = '<i class="mdi mdi-chevron-left"></i>';

    const pageLabel = document.createElement('label');
    pageLabel.className = 'pdf-page-control';
    const pageCaption = document.createElement('span');
    pageCaption.className = 'pdf-page-caption';
    pageCaption.textContent = 'Page';
    const pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.step = '1';
    pageInput.value = '1';
    pageInput.inputMode = 'numeric';
    pageInput.setAttribute('aria-label', 'PDF page number');
    const pageCount = document.createElement('span');
    pageCount.className = 'pdf-page-count';
    pageCount.textContent = '/ …';
    pageLabel.append(pageCaption, pageInput, pageCount);

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'pdf-tool-button';
    next.title = 'Next page';
    next.setAttribute('aria-label', 'Next page');
    next.innerHTML = '<i class="mdi mdi-chevron-right"></i>';
    navigation.append(previous, pageLabel, next);

    const zoom = document.createElement('div');
    zoom.className = 'pdf-toolbar-group pdf-toolbar-zoom';
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'pdf-tool-button';
    zoomOut.title = 'Zoom out';
    zoomOut.setAttribute('aria-label', 'Zoom out');
    zoomOut.innerHTML = '<i class="mdi mdi-minus"></i>';
    const zoomValue = document.createElement('span');
    zoomValue.className = 'pdf-zoom-value';
    zoomValue.textContent = 'Fit width';
    zoomValue.setAttribute('aria-live', 'polite');
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'pdf-tool-button';
    zoomIn.title = 'Zoom in';
    zoomIn.setAttribute('aria-label', 'Zoom in');
    zoomIn.innerHTML = '<i class="mdi mdi-plus"></i>';
    zoom.append(zoomOut, zoomValue, zoomIn);

    const fitting = document.createElement('div');
    fitting.className = 'pdf-toolbar-group pdf-toolbar-fitting';
    const fitWidth = document.createElement('button');
    fitWidth.type = 'button';
    fitWidth.className = 'pdf-tool-button pdf-fit-button is-active';
    fitWidth.title = 'Fit page width';
    fitWidth.setAttribute('aria-label', 'Fit page width');
    fitWidth.innerHTML = '<i class="mdi mdi-fit-to-page-outline"></i><span>Width</span>';
    const fitPage = document.createElement('button');
    fitPage.type = 'button';
    fitPage.className = 'pdf-tool-button pdf-fit-button';
    fitPage.title = 'Fit complete page';
    fitPage.setAttribute('aria-label', 'Fit complete page');
    fitPage.innerHTML = '<i class="mdi mdi-file-outline"></i><span>Page</span>';
    fitting.append(fitWidth, fitPage);

    const utility = document.createElement('div');
    utility.className = 'pdf-toolbar-group pdf-toolbar-utility';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'pdf-tool-button';
    reload.title = 'Render current page again';
    reload.setAttribute('aria-label', 'Render current page again');
    reload.innerHTML = '<i class="mdi mdi-refresh"></i>';
    const fullscreen = document.createElement('button');
    fullscreen.type = 'button';
    fullscreen.className = 'pdf-tool-button';
    fullscreen.title = 'Full screen';
    fullscreen.setAttribute('aria-label', 'Full screen');
    fullscreen.innerHTML = '<i class="mdi mdi-fullscreen"></i>';
    utility.append(reload, fullscreen);

    toolbar.append(navigation, zoom, fitting, utility);

    const stage = document.createElement('div');
    stage.className = 'pdf-custom-stage pdf-page-stage';
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'pdf-canvas-wrap';
    const loader = document.createElement('div');
    loader.className = 'pdf-custom-loader';
    loader.setAttribute('role', 'status');
    loader.setAttribute('aria-live', 'polite');
    const loaderSpinner = document.createElement('span');
    loaderSpinner.className = 'pdf-page-loader-spinner';
    const loaderCopy = document.createElement('span');
    loaderCopy.className = 'pdf-custom-loader-copy';
    loaderCopy.textContent = 'Loading PDF index…';
    loader.append(loaderSpinner, loaderCopy);

    const errorPanel = document.createElement('div');
    errorPanel.className = 'pdf-custom-error';
    errorPanel.hidden = true;
    const errorIcon = document.createElement('i');
    errorIcon.className = 'mdi mdi-alert-circle-outline';
    const errorCopy = document.createElement('div');
    errorCopy.className = 'pdf-custom-error-copy';
    const errorTitle = document.createElement('strong');
    errorTitle.textContent = 'PDF preview unavailable';
    const errorMessage = document.createElement('span');
    const errorActions = document.createElement('div');
    errorActions.className = 'pdf-custom-error-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'pdf-tool-button pdf-custom-error-action';
    retry.innerHTML = '<i class="mdi mdi-refresh"></i><span>Retry</span>';
    errorActions.append(retry);
    errorCopy.append(errorTitle, errorMessage);
    errorPanel.append(errorIcon, errorCopy, errorActions);

    stage.append(canvasWrap, loader, errorPanel);
    wrapper.append(toolbar, stage);

    const controller = new AbortController();
    const pageCache = new Map();
    const inFlightRanges = new Map();
    let documentTask = null;
    let rangeTransport = null;
    let pdf = null;
    let renderTask = null;
    let currentPage = 1;
    let customScale = 1;
    let zoomMode = 'fit-width';
    let lastEffectiveScale = 1;
    let navigationToken = 0;
    let rangeFailure = null;
    let objectLength = 0;
    let objectETag = '';
    let storageRequests = 0;
    let storageBytes = 0;
    let resizeTimer = 0;
    let resizeObserver = null;
    let destroyed = false;

    const setLoading = message => {
      loaderCopy.textContent = message;
      loader.hidden = false;
      errorPanel.hidden = true;
    };

    const hideLoading = () => {
      loader.hidden = true;
    };

    const updateFitButtons = () => {
      fitWidth.classList.toggle('is-active', zoomMode === 'fit-width');
      fitPage.classList.toggle('is-active', zoomMode === 'fit-page');
    };

    const updateControls = () => {
      const total = Number(pdf?.numPages || 0);
      pageInput.value = String(currentPage);
      pageInput.max = total ? String(total) : '';
      pageCount.textContent = total ? `/ ${total.toLocaleString()}` : '/ …';
      const unavailable = !pdf || Boolean(rangeFailure);
      previous.disabled = unavailable || currentPage <= 1;
      next.disabled = unavailable || currentPage >= total;
      pageInput.disabled = unavailable;
      zoomOut.disabled = unavailable;
      zoomIn.disabled = unavailable;
      fitWidth.disabled = unavailable;
      fitPage.disabled = unavailable;
      reload.disabled = unavailable;
      const zoomText = `${Math.round(lastEffectiveScale * 100)}%`;
      zoomValue.textContent = zoomMode === 'fit-width'
        ? `Width · ${zoomText}`
        : zoomMode === 'fit-page'
          ? `Page · ${zoomText}`
          : zoomText;
      updateFitButtons();
    };

    const cleanupPage = page => {
      try { page?.cleanup?.(); } catch (_) {}
    };

    const trimPageCache = () => {
      const keep = new Set([currentPage]);
      if (pdf && currentPage < pdf.numPages) keep.add(currentPage + 1);
      for (const [number, page] of pageCache) {
        if (keep.has(number)) continue;
        pageCache.delete(number);
        cleanupPage(page);
      }
    };

    const getPage = async pageNumber => {
      const normalized = Math.max(1, Math.min(Number(pdf?.numPages || 1), Math.floor(Number(pageNumber) || 1)));
      if (pageCache.has(normalized)) return pageCache.get(normalized);
      const page = await pdf.getPage(normalized);
      if (destroyed || controller.signal.aborted) {
        cleanupPage(page);
        throw new DOMException('PDF page loading canceled', 'AbortError');
      }
      pageCache.set(normalized, page);
      trimPageCache();
      return page;
    };

    const availableStageSize = () => ({
      width: Math.max(240, stage.clientWidth - 32),
      height: Math.max(240, stage.clientHeight - 32)
    });

    const effectiveScaleFor = page => {
      const base = page.getViewport({ scale: 1 });
      const available = availableStageSize();
      if (zoomMode === 'fit-page') {
        return Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, available.width / base.width, available.height / base.height));
      }
      if (zoomMode === 'fit-width') {
        return Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, available.width / base.width));
      }
      return Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, customScale));
    };

    const renderCurrentPage = async () => {
      if (!pdf || rangeFailure || destroyed || controller.signal.aborted) return;
      const token = ++navigationToken;
      renderTask?.cancel?.();
      renderTask = null;
      setLoading(`Loading page ${currentPage.toLocaleString()}…`);
      updateControls();
      trimPageCache();
      try {
        const page = await getPage(currentPage);
        if (token !== navigationToken || destroyed) return;
        const naturalViewport = page.getViewport({ scale: 1 });
        const shell = document.querySelector('.viewer');
        if (shell) shell.style.setProperty('--pdf-page-shell-width', `${Math.ceil(naturalViewport.width + 34)}px`);
        const effectiveScale = effectiveScaleFor(page);
        const viewport = page.getViewport({ scale: effectiveScale });
        const targetPixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const cssPixels = Math.max(1, viewport.width * viewport.height);
        const pixelCapRatio = Math.sqrt(PDF_MAX_CANVAS_PIXELS / cssPixels);
        const outputScale = Math.max(.25, Math.min(targetPixelRatio, pixelCapRatio));
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${Math.max(1, Math.floor(viewport.width))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(viewport.height))}px`;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('The browser could not create a PDF canvas.');
        context.save();
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        renderTask = page.render({
          canvasContext: context,
          viewport,
          background: '#ffffff',
          transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
        });
        await renderTask.promise;
        if (token !== navigationToken || destroyed || currentPage !== page.pageNumber) return;
        canvasWrap.replaceChildren(canvas);
        stage.classList.add('has-page');
        lastEffectiveScale = effectiveScale;
        hideLoading();
        updateControls();
        scheduleViewerLayout();
        if (currentPage < pdf.numPages) {
          void getPage(currentPage + 1).then(() => {
            trimPageCache();
          }).catch(error => {
            if (!['AbortError', 'RenderingCancelledException'].includes(error?.name)) handleRangeFailure(error);
          });
        }
      } catch (error) {
        if (['AbortError', 'RenderingCancelledException'].includes(error?.name)) return;
        handleRangeFailure(error);
      } finally {
        renderTask = null;
      }
    };

    const goToPage = value => {
      if (!pdf || rangeFailure) return;
      const requested = Math.floor(Number(value) || currentPage);
      const nextPage = Math.max(1, Math.min(pdf.numPages, requested));
      if (nextPage !== currentPage) {
        currentPage = nextPage;
        trimPageCache();
      }
      void renderCurrentPage();
    };

    const setZoomMode = (mode, scale = customScale) => {
      zoomMode = mode;
      if (mode === 'custom') customScale = Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, scale));
      void renderCurrentPage();
    };

    function handleRangeFailure(error) {
      if (rangeFailure || controller.signal.aborted || destroyed) return;
      rangeFailure = error instanceof Error ? error : new Error(String(error));
      navigationToken += 1;
      renderTask?.cancel?.();
      renderTask = null;
      hideLoading();
      errorMessage.textContent = rangeFailure.message;
      errorPanel.hidden = false;
      updateControls();
      void documentTask?.destroy?.();
    }

    const createRangeTransport = (pdfjs, length, etag) => {
      const transport = new pdfjs.PDFDataRangeTransport(length, new Uint8Array(0), false);
      const ifMatch = normalizePDFIfMatch(etag);
      transport.requestDataRange = (requestedBegin, requestedEnd) => {
        const begin = Math.max(0, Math.floor(Number(requestedBegin) || 0));
        const end = Math.min(length, Math.max(begin + 1, Math.floor(Number(requestedEnd) || 0)));
        const requestKey = `${begin}-${end}`;
        if (inFlightRanges.has(requestKey) || controller.signal.aborted || rangeFailure || destroyed) return;
        const requestController = new AbortController();
        const abortRequest = () => requestController.abort();
        controller.signal.addEventListener('abort', abortRequest, { once: true });
        const headers = { Range: `bytes=${begin}-${end - 1}` };
        if (ifMatch) headers['If-Match'] = ifMatch;
        const request = (async () => {
          const response = await fetch(rangeURL, {
            method: 'GET',
            headers,
            signal: requestController.signal,
            cache: 'no-store'
          });
          const contentRange = parsePDFContentRange(response.headers.get('Content-Range'));
          if (response.status === 412 || response.status === 409) {
            await response.body?.cancel?.();
            throw new Error('The PDF changed while it was being previewed. Reopen the file to load its current version.');
          }
          if (response.status !== 206 || !contentRange || contentRange.start !== begin || contentRange.end !== end - 1 || contentRange.total !== length) {
            await response.body?.cancel?.();
            throw new Error('The storage provider did not return the exact PDF byte range. The preview stopped without downloading the complete object.');
          }
          const expectedLength = end - begin;
          const advertisedHeader = response.headers.get('Content-Length');
          const advertisedLength = advertisedHeader == null || advertisedHeader === '' ? null : Number(advertisedHeader);
          if (advertisedLength !== null && (!Number.isFinite(advertisedLength) || advertisedLength !== expectedLength)) {
            await response.body?.cancel?.();
            throw new Error('The storage provider returned an invalid PDF range length.');
          }
          const data = new Uint8Array(await response.arrayBuffer());
          if (data.byteLength !== expectedLength) throw new Error('The storage provider truncated the requested PDF byte range.');
          storageRequests += 1;
          storageBytes += data.byteLength;
          transport.onDataRange(begin, data);
          transport.onDataProgress?.(storageBytes, length);
        })().catch(error => {
          if (error?.name !== 'AbortError') handleRangeFailure(error);
        }).finally(() => {
          controller.signal.removeEventListener('abort', abortRequest);
          inFlightRanges.delete(requestKey);
        });
        inFlightRanges.set(requestKey, { request, controller: requestController });
      };
      transport.abort = () => {
        for (const entry of inFlightRanges.values()) entry.controller.abort();
        inFlightRanges.clear();
      };
      return transport;
    };

    let canvasCleanup = null;

    const startDocument = async () => {
      setLoading('Loading PDF index…');
      errorPanel.hidden = true;
      try {
        const pdfjs = await loadPDFLibrary();
        const metadata = await pdfObjectMetadata(url, listedMetadata, controller.signal);
        if (controller.signal.aborted || destroyed) return;
        objectLength = metadata.length;
        objectETag = metadata.etag;
        rangeTransport = createRangeTransport(pdfjs, objectLength, objectETag);
        documentTask = pdfjs.getDocument({
          range: rangeTransport,
          length: objectLength,
          rangeChunkSize: pdfRangeChunkSize(objectLength),
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
          stopAtErrors: false
        });
        rangeTransport.transportReady?.();
        pdf = await documentTask.promise;
        if (controller.signal.aborted || destroyed || rangeFailure) return;
        currentPage = 1;
        wrapper.dataset.renderer = 'pdfjs-canvas';
        updateControls();
        await renderCurrentPage();
      } catch (error) {
        if (error?.name !== 'AbortError') handleRangeFailure(error);
      }
    };

    previous.addEventListener('click', () => goToPage(currentPage - 1));
    next.addEventListener('click', () => goToPage(currentPage + 1));
    pageInput.addEventListener('change', () => goToPage(pageInput.value));
    pageInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      goToPage(pageInput.value);
    });
    zoomOut.addEventListener('click', () => setZoomMode('custom', lastEffectiveScale / 1.2));
    zoomIn.addEventListener('click', () => setZoomMode('custom', lastEffectiveScale * 1.2));
    fitWidth.addEventListener('click', () => setZoomMode('fit-width'));
    fitPage.addEventListener('click', () => setZoomMode('fit-page'));
    reload.addEventListener('click', () => void renderCurrentPage());
    retry.addEventListener('click', () => location.reload());

    const onFullscreenChange = () => {
      const active = document.fullscreenElement === wrapper;
      fullscreen.classList.toggle('is-active', active);
      fullscreen.title = active ? 'Exit full screen' : 'Full screen';
      fullscreen.setAttribute('aria-label', fullscreen.title);
      fullscreen.innerHTML = `<i class="mdi mdi-${active ? 'fullscreen-exit' : 'fullscreen'}"></i>`;
      if (zoomMode !== 'custom') {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => void renderCurrentPage(), 80);
      }
    };
    fullscreen.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement === wrapper) await document.exitFullscreen?.();
        else await wrapper.requestFullscreen?.();
      } catch (_) {}
    });
    document.addEventListener('fullscreenchange', onFullscreenChange);

    wrapper.addEventListener('keydown', event => {
      if (event.target === pageInput || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'PageUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        goToPage(currentPage - 1);
      } else if (event.key === 'PageDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        goToPage(currentPage + 1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoomMode('custom', lastEffectiveScale * 1.2);
      } else if (event.key === '-') {
        event.preventDefault();
        setZoomMode('custom', lastEffectiveScale / 1.2);
      } else if (event.key === '0') {
        event.preventDefault();
        setZoomMode('fit-width');
      }
    });

    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => {
        if (!pdf || zoomMode === 'custom' || rangeFailure) return;
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => void renderCurrentPage(), 120);
      });
      resizeObserver.observe(stage);
    }

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      controller.abort();
      navigationToken += 1;
      clearTimeout(resizeTimer);
      resizeObserver?.disconnect?.();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      renderTask?.cancel?.();
      rangeTransport?.abort?.();
      for (const page of pageCache.values()) cleanupPage(page);
      pageCache.clear();
      canvasWrap.replaceChildren();
      void documentTask?.destroy?.();
      void pdf?.destroy?.();
    };
    canvasCleanup = cleanup;
    activeMediaCleanups.add(cleanup);

    updateControls();
    void startDocument();
    return wrapper;
  }

  function renderWordTable(rows) {
    const scroller = document.createElement('div');
    scroller.className = 'data-table-scroll word-table-scroll';
    const table = document.createElement('table');
    table.className = 'data-table bb-data-grid word-table';
    table.setAttribute('role', 'grid');
    const body = document.createElement('tbody');
    (rows || []).forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      (row || []).forEach(value => {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
        if (rowIndex === 0) cell.scope = 'col';
        cell.textContent = value == null ? '' : String(value);
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    scroller.appendChild(table);
    return scroller;
  }

  async function renderWordDocument(key, size, etag = '', version = '') {
    const payload = await BB.api.wordPreview({ key, size, etag, version, instance: config.instanceId });
    const wrapper = document.createElement('article');
    wrapper.className = 'word-document';
    let activeList = null;
    let activeListLevel = 0;

    const closeList = () => {
      activeList = null;
      activeListLevel = 0;
    };

    (payload.blocks || []).forEach(block => {
      const type = String(block?.type || 'paragraph');
      if (type === 'list-item') {
        const level = Math.max(1, Math.min(8, Number(block.level || 1)));
        if (!activeList || activeListLevel !== level) {
          activeList = document.createElement(block.ordered ? 'ol' : 'ul');
          activeList.className = 'word-list';
          activeList.style.setProperty('--word-list-level', String(level));
          wrapper.appendChild(activeList);
          activeListLevel = level;
        }
        const item = document.createElement('li');
        item.textContent = String(block.text || '');
        activeList.appendChild(item);
        return;
      }
      closeList();
      if (type === 'heading') {
        const level = Math.max(1, Math.min(6, Number(block.level || 1)));
        const heading = document.createElement(`h${level}`);
        heading.textContent = String(block.text || '');
        wrapper.appendChild(heading);
      } else if (type === 'table') {
        wrapper.appendChild(renderWordTable(block.rows || []));
      } else {
        const paragraph = document.createElement('p');
        paragraph.textContent = String(block.text || '');
        wrapper.appendChild(paragraph);
      }
    });

    if (payload.truncated || payload.macrosIgnored) {
      const notices = document.createElement('div');
      notices.className = 'preview-notice word-preview-notice';
      if (payload.truncated) {
        const item = document.createElement('p');
        item.textContent = 'The preview reached its bounded text or table limit. The original document was not modified.';
        notices.appendChild(item);
      }
      if (payload.macrosIgnored) {
        const item = document.createElement('p');
        item.textContent = 'Document macros were not loaded or executed.';
        notices.appendChild(item);
      }
      wrapper.prepend(notices);
    }

    if (!wrapper.querySelector('p, h1, h2, h3, h4, h5, h6, table, ul, ol')) {
      wrapper.appendChild(unavailablePreview('The document is empty', 'No readable Word content was found.', 'file-word-outline'));
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
      'slide-unavailable': ['Presentation preview is not available', 'This presentation format is not rendered by the built-in viewer. Its metadata remains available in Details.', 'file-powerpoint-outline'],
      'diagram-unavailable': ['Diagram preview is not available', 'This Visio document is not rendered by the built-in viewer. Its metadata remains available in Details.', 'file-document-outline']
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
      version: currentVersion(),
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
    const archiveEntry = currentArchiveEntry();
    const displayKey = archiveEntry || key;
    const container = byId('viewer');
    if (!key) {
      renderError(new Error('No object path is present in the URL.'));
      return;
    }
    if (BB.capabilities?.actionable && !BB.capabilities.actionable(config, 'preview')) {
      setDocMeta(displayKey, NaN, archiveEntry ? key : '');
      updateBackLink(key, archiveEntry);
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
      const version = currentVersion();
      const metadata = archiveEntry
        ? await BB.api.archiveEntryHead(key, archiveEntry, { instance: config.instanceId, version })
        : await BB.api.head(key, version, config.instanceId);
      setDocMeta(displayKey, metadata.size, archiveEntry ? key : '');
      updateBackLink(key, archiveEntry);
      const rawURL = archiveEntry
        ? BB.api.archiveEntryURL(key, archiveEntry, { inline: true, instance: config.instanceId, version })
        : BB.api.urlForKey(key, config.instanceId, version);
      const browserPreviewURL = archiveEntry
        ? rawURL
        : BB.api.previewURLForKey(key, config.instanceId, version);
      byId('openRawBtn').href = archiveEntry
        ? BB.api.archiveEntryURL(key, archiveEntry, { inline: true, instance: config.instanceId, version })
        : BB.api.openURLForKey(key, config.instanceId, version);
      const type = BB.detect.resolveType(displayKey, metadata.mime);
      let node;
      let className = 'preview-content';

      if (type === 'image') node = renderImage(browserPreviewURL);
      else if ((type === 'raw-image' || type === 'image-convert') && !archiveEntry) node = renderImage(BB.api.imagePreviewURL(key, { version, instance: config.instanceId }));
      else if (type === 'video') node = BB.structuredViewers.renderVideo(browserPreviewURL, displayKey);
      else if (type === 'audio') node = renderAudio(browserPreviewURL, displayKey, metadata.mime);
      else if (type === 'pdf' && !archiveEntry) node = renderPDF(browserPreviewURL, metadata);
      else if (type === 'pdf') node = unavailablePreview('PDF archive entry preview is unavailable', 'Extract the PDF or download it before opening the strict Range-based PDF viewer.', 'file-pdf-box');
      else if (type === 'word') {
        if (archiveEntry) node = unavailablePreview('Office archive entry preview is unavailable', 'Extract the document before opening its structured preview.', 'file-word-outline');
        else {
          node = await renderWordDocument(key, metadata.size, metadata.etag || metadata.headers?.etag || '', version);
          className = 'preview-document word-preview';
        }
      } else if (type === 'json') {
        if (archiveEntry) {
          node = BB.render.renderCode(await fetchLimitedText(rawURL, metadata.size), 'json');
          className = 'preview-code';
        } else {
          node = BB.jsonViewer.render({
            key,
            size: metadata.size,
            etag: metadata.etag || metadata.headers?.etag || '',
            version,
            instance: config.instanceId
          });
          className = 'preview-data json-preview-host';
        }
      } else if (type === 'markdown') {
        node = BB.render.renderMarkdown(await fetchLimitedText(rawURL, metadata.size));
        className = 'markdown-body preview-document';
      } else if (type === 'code') {
        node = BB.render.renderCode(await fetchLimitedText(rawURL, metadata.size), BB.detect.resolveLang(displayKey, metadata.mime));
        className = 'preview-code';
      } else if (type === 'contact' || type === 'calendar' || type === 'email' || type === 'certificate') {
        if (archiveEntry) {
          node = BB.render.renderCode(await fetchLimitedText(rawURL, metadata.size), BB.detect.resolveLang(displayKey, metadata.mime));
          className = 'preview-code';
        } else {
          const payload = await BB.api.structuredPreview(key, {
            size: metadata.size,
            mime: metadata.mime,
            etag: metadata.etag || metadata.headers?.etag || '',
            lastModified: metadata.lastModified || metadata.headers?.['last-modified'] || '',
            version,
            instance: config.instanceId
          });
          node = BB.structuredViewers.renderStructured(payload);
          className = 'preview-data structured-preview-root';
        }
      } else if (type === 'tabular') {
        node = await BB.tabular.fetchTextTable(rawURL, displayKey, metadata.size, archiveEntry ? {} : {
          etag: metadata.etag || metadata.headers?.etag || '', version, instance: config.instanceId
        });
        className = 'preview-data';
      } else if (type === 'spreadsheet') {
        if (archiveEntry) node = unavailablePreview('Spreadsheet archive entry preview is unavailable', 'Extract the spreadsheet before opening its worksheet viewer.', 'file-excel-outline');
        else {
          node = await BB.tabular.renderSpreadsheet(rawURL, key, metadata.size, { version, instance: config.instanceId });
          className = 'preview-data';
        }
      } else if (type === 'parquet') {
        if (archiveEntry) node = unavailablePreview('Parquet archive entry preview is unavailable', 'Extract the file before opening its column metadata.', 'file-table-outline');
        else {
          node = await BB.tabular.renderParquet(key, metadata.size, { etag: metadata.etag || metadata.headers?.etag || '', version, instance: config.instanceId });
          className = 'preview-data';
        }
      } else if (type === 'sqlite') {
        if (archiveEntry) node = unavailablePreview('Database archive entry preview is unavailable', 'Extract the database before opening its page-based reader.', 'database-outline');
        else {
          node = await BB.sqliteViewer.render({ key, size: metadata.size, version, instance: config.instanceId });
          className = 'preview-data sqlite-preview-host';
        }
      } else if (type === 'word-unavailable' || type === 'sheet-unavailable' || type === 'slide-unavailable' || type === 'diagram-unavailable') {
        node = officeUnavailable(type);
      } else if (type === 'archive') {
        const extension = BB.detect.extOf(displayKey);
        if (archiveEntry) {
          node = unavailablePreview('Nested archive preview is unavailable', 'Extract the nested archive before inspecting its central directory.', 'folder-zip-outline');
        } else if (DETERMINISTIC_ZIP_PREVIEW_EXTENSIONS.has(extension)) {
          const payload = await BB.api.archivePreview(key, {
            size: metadata.size,
            etag: metadata.etag || metadata.headers?.etag || '',
            lastModified: metadata.lastModified || metadata.headers?.['last-modified'] || '',
            version,
            instance: config.instanceId
          });
          node = BB.structuredViewers.renderArchive(payload);
          className = 'preview-data archive-preview-root';
        } else {
          node = unavailablePreview('Archive preview is not available', 'This format requires a complete explicit scan and is not previewed automatically.', 'folder-zip-outline');
        }
      } else {
        const text = await sniffUnknownText(rawURL, displayKey, metadata.size);
        if (text != null) {
          node = BB.render.renderCode(text, BB.detect.resolveLang(displayKey, metadata.mime));
          className = 'preview-code';
        } else {
          node = unavailablePreview('No preview available', 'Download the file and open it with a compatible application.');
        }
      }

      const previewMode = (type === 'contact' || type === 'calendar' || type === 'email' || type === 'certificate')
        ? 'structured'
        : type;
      setPreviewMode(previewMode, type);
      container.className = className;
      container.replaceChildren(node);
      normalizeHorizontalPreviewScrollers(node);
      configureDocumentSearch(node, type, displayKey);
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
      config.runtime = BB.runtime?.configure(response.runtime || {}) || (response.runtime || {});
      const build = response.build || {};
      const buildBadge = byId('previewBuild');
      if (buildBadge && build.display) {
        buildBadge.hidden = false;
        buildBadge.querySelector('span').textContent = build.display;
        buildBadge.title = `Release ${build.version || 'dev'}${build.commit && build.commit !== 'unknown' ? ` · source ${build.commit}` : ''}${build.date ? ` · built ${build.date}` : ''}`;
      }
      const route = BB.runtime?.storageRoute?.();
      const requested = route?.view === 'preview'
        ? route.instance
        : new URLSearchParams(location.search).get('instance');
      currentInstance = instances.find(item => item.id === requested)
        || instances.find(item => item.id === response.default)
        || instances[0]
        || null;
      if (!currentInstance) throw new Error('No storage instance is configured.');

      config.instanceId = currentInstance.id;
      config.capabilities = currentInstance.capabilities || {};
      config.operations = currentInstance.operations || {};
      config.versioningSupported = currentInstance.versioningSupported === true;
      BB.api.setInstance(currentInstance.id);
      replacePreviewLocation(currentKey());
      applyCapabilities();
      await configureVersionSelector(currentKey());
      await render();
    } catch (error) {
      renderError(error);
    }
  }

  byId('pv-download').addEventListener('click', () => {
    const key = currentKey();
    const entry = currentArchiveEntry();
    if (entry) {
      const anchor = document.createElement('a');
      anchor.href = BB.api.archiveEntryURL(key, entry, {
        inline: false,
        instance: config.instanceId,
        version: currentVersion()
      });
      anchor.download = entry.split('/').pop() || 'archive-entry';
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    BB.actions.downloadObject(key, key.split('/').pop(), { version: currentVersion() });
  });
  byId('pv-copy').addEventListener('click', async () => { await BB.actions.copyObject(currentKey()); });
  byId('pv-rename').addEventListener('click', async () => {
    const destination = await BB.actions.renameObject(currentKey());
    if (destination) {
      replacePreviewLocation(destination);
      await configureVersionSelector(destination);
      await render();
    }
  });
  byId('pv-details').addEventListener('click', () => BB.actions.showMetadata(currentKey(), { version: currentVersion() }));
  byId('pv-versions').addEventListener('click', () => BB.actions.showVersions(currentKey()));
  byId('pv-delete').addEventListener('click', async () => {
    if (await BB.actions.deleteObject(currentKey())) location.href = byId('backBtn').href;
  });

  byId('previewVersionSelect')?.addEventListener('change', event => selectVersion(event.target.value));

  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== 'f') return;
    if (typeof activeDocumentSearch !== 'function') return;
    event.preventDefault();
    void openDocumentSearch();
  });
  installViewerLayoutObserver();
  initialize();
})();
