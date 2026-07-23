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
  const previewObjectURLs = new Set();
  const activeMediaCleanups = new Set();
  let pdfLoaderPromise = null;
  let hlsLoaderPromise = null;
  let mammothLoaderPromise = null;

  function byId(id) { return document.getElementById(id); }

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

  function listedRelatedKeys() {
    return Array.from(new Set(new URLSearchParams(location.search).getAll('related')
      .map(value => String(value || '').replace(/^\/+/, ''))
      .filter(Boolean)));
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
    shell.dataset.previewType = String(type || 'unknown');
  }

  function cleanupPreviewResources() {
    for (const cleanup of activeMediaCleanups) {
      try { cleanup(); } catch (_) {}
    }
    activeMediaCleanups.clear();
    for (const url of previewObjectURLs) URL.revokeObjectURL(url);
    previewObjectURLs.clear();
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

  function srtToVTT(text) {
    const normalized = String(text || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
      .replace(/^\s*\d+\s*\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s+-->)/gm, '');
    return `WEBVTT\n\n${normalized}`;
  }

  function subtitleDescriptor(videoKey, subtitleKey, baseStem = '') {
    const videoName = videoKey.split('/').pop() || videoKey;
    const subtitleName = subtitleKey.split('/').pop() || subtitleKey;
    const fallbackStem = BB.detect.videoVariantDescriptor(videoName).baseStem;
    const groupStem = baseStem || fallbackStem;
    let suffix = subtitleName.replace(/\.(?:vtt|srt)$/i, '');
    if (suffix.toLowerCase().startsWith(groupStem.toLowerCase())) suffix = suffix.slice(groupStem.length);
    suffix = suffix
      .replace(/(^|[._\s-])(?:(?:[1-9]\d{2,3})p|(?:[1-9]\d{2,3})x(?:[1-9]\d{2,3})|4k|uhd|qhd|fhd|hd|sd)(?=$|[._\s-])/ig, ' ')
      .replace(/[._-]+/g, ' ')
      .trim();
    const languageCode = suffix.split(/\s+/)[0] || '';
    const readableLanguage = languageLabel(languageCode);
    return {
      label: suffix ? (readableLanguage && readableLanguage !== languageCode ? `${readableLanguage}${suffix.length > languageCode.length ? suffix.slice(languageCode.length) : ''}` : suffix) : 'Subtitles',
      language: /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/i.test(languageCode) ? languageCode : ''
    };
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

  function installSubtitleSelector(media, controls) {
    const control = createTrackControl('subtitles-outline', 'Subtitles');
    let selectedIndex = -1;

    const refresh = () => {
      const tracks = listTracks(media.textTracks);
      control.select.replaceChildren();
      const off = document.createElement('option');
      off.value = '-1';
      off.textContent = 'Off';
      control.select.appendChild(off);
      tracks.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = track.label || languageLabel(track.language) || `Track ${index + 1}`;
        if (track.mode === 'showing') selectedIndex = index;
        control.select.appendChild(option);
      });
      control.select.value = String(selectedIndex);
      control.label.hidden = tracks.length === 0;
      refreshMediaControlsVisibility(controls);
    };

    control.select.addEventListener('change', () => {
      selectedIndex = Number(control.select.value);
      listTracks(media.textTracks).forEach((track, index) => {
        track.mode = index === selectedIndex ? 'showing' : 'disabled';
      });
      refresh();
    });
    controls.appendChild(control.label);
    if (media.textTracks?.addEventListener) {
      media.textTracks.addEventListener('addtrack', refresh);
      media.textTracks.addEventListener('removetrack', refresh);
      media.textTracks.addEventListener('change', refresh);
    }
    refresh();
    return { control, refresh, destroy() { control.label.remove(); } };
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

  function loadHLSLibrary() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!hlsLoaderPromise) {
      hlsLoaderPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        // The full build is required: the light build excludes alternate audio
        // and embedded WebVTT subtitle support.
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js';
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        script.addEventListener('load', () => window.Hls
          ? resolve(window.Hls)
          : reject(new Error('HLS.js did not initialize.')));
        script.addEventListener('error', () => reject(new Error('Unable to load the HLS playback module.')));
        document.head.appendChild(script);
      });
    }
    return hlsLoaderPromise;
  }

  function nativeVideoCandidate(key, mime = '') {
    const extension = BB.detect.extOf(key);
    return ['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(extension) && !/matroska|mxf/i.test(mime);
  }

  function nativeMediaMIME(key, mime = '', kind = 'video') {
    const declared = String(mime || '').trim().toLowerCase();
    if (declared && !/^(?:application|binary)\/octet-stream(?:\s*;|$)/.test(declared)) return declared;
    const extension = BB.detect.extOf(key);
    const video = {
      mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg'
    };
    const audio = {
      mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac',
      m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg'
    };
    return (kind === 'audio' ? audio : video)[extension] || '';
  }

  function nativeCodecToken(track) {
    const codec = String(track?.codec || '').trim().toLowerCase();
    const tokens = {
      h264: 'avc1.42E01E', avc: 'avc1.42E01E',
      hevc: 'hvc1', h265: 'hvc1',
      av1: 'av01.0.05M.08', vp9: 'vp09.00.10.08', vp8: 'vp8',
      mpeg4: 'mp4v.20.9', prores: 'apch',
      aac: 'mp4a.40.2', mp3: 'mp3', opus: 'opus', vorbis: 'vorbis',
      flac: 'flac', alac: 'alac', ac3: 'ac-3', eac3: 'ec-3'
    };
    return tokens[codec] || '';
  }

  function browserSupportsSessionNatively(media, session, key, mime, kind) {
    const base = nativeMediaMIME(key, mime, kind);
    if (!base) return false;
    const relevant = (session?.tracks || []).filter(track => track.type === 'video' || track.type === 'audio');
    const tokens = relevant.map(nativeCodecToken);
    if (relevant.length && tokens.some(token => !token)) return false;
    const candidate = tokens.length ? `${base}; codecs="${tokens.join(', ')}"` : base;
    return media.canPlayType(candidate) !== '';
  }

  function nativeAudioCandidate(key, mime = '') {
    const extension = BB.detect.extOf(key);
    return ['mp3', 'wav', 'wave', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus'].includes(extension) || /^audio\//i.test(mime);
  }

  function mediaSessionOptions(overrides = {}) {
    return { ...(listedObjectMetadata() || {}), instance: config.instanceId, ...overrides };
  }

  function sessionTrackCount(session, type) {
    return (session?.tracks || []).filter(track => track.type === type).length;
  }

  function shouldUseAdvancedVideo(session, key, mime, video) {
    if (!nativeVideoCandidate(key, mime)) return true;
    if (sessionTrackCount(session, 'audio') > 1 || sessionTrackCount(session, 'subtitle') > 0) return true;
    return !browserSupportsSessionNatively(video, session, key, mime, 'video');
  }

  function shouldUseAdvancedAudio(session, key, mime, audio) {
    if (!nativeAudioCandidate(key, mime)) return true;
    if (sessionTrackCount(session, 'audio') > 1) return true;
    return !browserSupportsSessionNatively(audio, session, key, mime, 'audio');
  }

  function startMediaHeartbeat(sessionId) {
    let stopped = false;
    let eventSource = null;
    let timer = 0;
    if (typeof EventSource === 'function') {
      eventSource = new EventSource(`/api/media-sessions/${encodeURIComponent(sessionId)}/watch`);
      eventSource.onerror = () => {
        // EventSource reconnects automatically. The backend keeps a short
        // disconnect grace period so a transient reconnect does not kill FFmpeg.
      };
    } else {
      const beat = () => {
        if (stopped) return;
        void BB.api.heartbeatMediaSession(sessionId).catch(() => {});
      };
      timer = window.setInterval(beat, 8000);
      beat();
    }
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
      eventSource?.close();
    };
  }

  function deleteMediaSessionSoon(sessionId, keepalive = false) {
    if (!sessionId) return;
    void BB.api.deleteMediaSession(sessionId, { keepalive }).catch(() => {});
  }

  function installHLSAudioSelector(hls, controls) {
    const control = createTrackControl('volume-high', 'Audio');
    const refresh = () => {
      const tracks = Array.from(hls.audioTracks || []);
      control.select.replaceChildren();
      tracks.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        const language = languageLabel(track.lang || track.language || '');
        option.textContent = track.name || language || `Track ${index + 1}`;
        control.select.appendChild(option);
      });
      control.select.value = String(Math.max(0, Number(hls.audioTrack || 0)));
      control.label.hidden = tracks.length < 2;
      refreshMediaControlsVisibility(controls);
    };
    control.select.addEventListener('change', () => {
      hls.audioTrack = Number(control.select.value);
      refresh();
    });
    controls.appendChild(control.label);
    const events = window.Hls?.Events || {};
    if (events.MANIFEST_PARSED) hls.on(events.MANIFEST_PARSED, refresh);
    if (events.AUDIO_TRACKS_UPDATED) hls.on(events.AUDIO_TRACKS_UPDATED, refresh);
    if (events.AUDIO_TRACK_SWITCHED) hls.on(events.AUDIO_TRACK_SWITCHED, refresh);
    refresh();
    return { control, refresh, destroy() { control.label.remove(); } };
  }

  function installHLSEmbeddedSubtitleSelector(hls, session, media, controls, reloadForBurn) {
    const control = createTrackControl('subtitles-outline', 'Subtitles');
    const burnTracks = (session.tracks || []).filter(track => track.type === 'subtitle' && track.subtitleMode === 'burn');
    let burnIndex = -1;
    let changing = false;

    const refresh = () => {
      const textTracks = Array.from(hls.subtitleTracks || []);
      control.select.replaceChildren();
      const off = document.createElement('option');
      off.value = 'off';
      off.textContent = 'Off';
      control.select.appendChild(off);
      textTracks.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = `text:${index}`;
        option.textContent = track.name || languageLabel(track.lang || '') || `Subtitle ${index + 1}`;
        control.select.appendChild(option);
      });
      burnTracks.forEach(track => {
        const option = document.createElement('option');
        option.value = `burn:${track.index}`;
        const label = track.label || languageLabel(track.language) || `Subtitle ${track.index + 1}`;
        option.textContent = `${label} · rendered`;
        control.select.appendChild(option);
      });
      if (burnIndex >= 0) control.select.value = `burn:${burnIndex}`;
      else if (Number(hls.subtitleTrack) >= 0) control.select.value = `text:${hls.subtitleTrack}`;
      else control.select.value = 'off';
      control.label.hidden = textTracks.length === 0 && burnTracks.length === 0;
      control.select.disabled = changing;
      refreshMediaControlsVisibility(controls);
    };

    control.select.addEventListener('change', async () => {
      const value = control.select.value;
      changing = true;
      refresh();
      try {
        if (value === 'off') {
          hls.subtitleTrack = -1;
          if (burnIndex >= 0) {
            burnIndex = -1;
            await reloadForBurn(-1, -1);
          }
        } else if (value.startsWith('text:')) {
          const textIndex = Number(value.slice(5));
          if (burnIndex >= 0) {
            burnIndex = -1;
            await reloadForBurn(-1, textIndex);
          } else {
            hls.subtitleTrack = textIndex;
          }
        } else if (value.startsWith('burn:')) {
          const nextBurn = Number(value.slice(5));
          hls.subtitleTrack = -1;
          burnIndex = nextBurn;
          await reloadForBurn(nextBurn, -1);
        }
      } finally {
        changing = false;
        refresh();
      }
    });
    controls.appendChild(control.label);
    const events = window.Hls?.Events || {};
    if (events.MANIFEST_PARSED) hls.on(events.MANIFEST_PARSED, refresh);
    if (events.SUBTITLE_TRACKS_UPDATED) hls.on(events.SUBTITLE_TRACKS_UPDATED, refresh);
    if (events.SUBTITLE_TRACK_SWITCH) hls.on(events.SUBTITLE_TRACK_SWITCH, refresh);
    refresh();
    return { control, refresh, destroy() { control.label.remove(); } };
  }

  function subtitleMatchesVideoGroup(subtitleKey, descriptor) {
    if (parentPrefix(subtitleKey) !== descriptor.parent) return false;
    const name = subtitleKey.split('/').pop() || subtitleKey;
    const stem = name.replace(/\.(?:vtt|srt)$/i, '');
    const base = descriptor.baseStem.toLowerCase();
    const lower = stem.toLowerCase();
    return lower === base || lower.startsWith(`${base}.`) || lower.startsWith(`${base}-`) || lower.startsWith(`${base}_`) || lower.startsWith(`${base} `);
  }

  async function discoverVideoAssets(videoKey) {
    const parsed = BB.detect.videoVariantDescriptor(videoKey);
    const descriptor = { ...parsed, key: videoKey, parent: parentPrefix(videoKey) };
    const keys = Array.from(new Set([...listedRelatedKeys(), videoKey]));

    const variants = keys
      .filter(key => parentPrefix(key) === descriptor.parent && BB.detect.resolveType(key, '') === 'video')
      .map(key => ({ ...BB.detect.videoVariantDescriptor(key), key }))
      .filter(item => item.group === descriptor.group)
      .sort((left, right) => {
        if (left.original !== right.original) return left.original ? -1 : 1;
        if (left.height !== right.height) return right.height - left.height;
        return left.name.localeCompare(right.name);
      });
    if (!variants.some(item => item.key === videoKey)) variants.unshift({ ...parsed, key: videoKey });

    const subtitles = keys.filter(key => /\.(?:vtt|srt)$/i.test(key) && subtitleMatchesVideoGroup(key, descriptor));
    return { descriptor, variants, subtitles };
  }

  function captureMediaState(media) {
    return {
      currentTime: Number(media.currentTime || 0),
      paused: media.paused,
      playbackRate: Number(media.playbackRate || 1),
      volume: Number(media.volume ?? 1),
      muted: !!media.muted
    };
  }

  function restoreMediaState(media, state, generation, stateRef) {
    const restore = () => {
      if (stateRef.generation !== generation) return;
      media.playbackRate = state.playbackRate;
      media.volume = state.volume;
      media.muted = state.muted;
      if (Number.isFinite(media.duration) && state.currentTime > 0) {
        try { media.currentTime = Math.min(state.currentTime, Math.max(0, media.duration - .05)); } catch (_) {}
      }
      if (!state.paused) void media.play().catch(() => {});
      scheduleViewerLayout();
    };
    media.addEventListener('loadedmetadata', restore, { once: true });
  }

  async function addSubtitleSidecars(media, videoKey, assetsPromise, refreshSubtitles) {
    const assets = await assetsPromise;
    for (const subtitleKey of assets.subtitles) {
      if (currentKey() !== videoKey) return;
      if (media.querySelector(`track[data-object-key="${CSS.escape(subtitleKey)}"]`)) continue;
      const response = await fetch(BB.api.urlForKey(subtitleKey));
      if (!response.ok) continue;
      let text = await response.text();
      if (/\.srt$/i.test(subtitleKey)) text = srtToVTT(text);
      const blobURL = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      previewObjectURLs.add(blobURL);
      const descriptor = subtitleDescriptor(videoKey, subtitleKey, assets.descriptor.baseStem);
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = descriptor.label;
      track.dataset.objectKey = subtitleKey;
      if (descriptor.language) track.srclang = descriptor.language;
      track.src = blobURL;
      media.appendChild(track);
    }
    refreshSubtitles();
  }

  function installResolutionSelector(overlay, videoKey, assetsPromise, onSelect) {
    const control = createTrackControl('quality-high', 'Resolution');
    control.label.classList.add('media-resolution-control');
    control.label.hidden = true;
    overlay.hidden = true;
    overlay.appendChild(control.label);
    let variants = [{ ...BB.detect.videoVariantDescriptor(videoKey), key: videoKey }];
    let selectedKey = videoKey;

    const optionLabel = item => {
      const quality = item.height > 0 ? `${item.height}p` : item.label;
      const origin = item.original ? ' (Original)' : '';
      const extension = item.extension ? ` · ${item.extension.toUpperCase()}` : '';
      return `${quality}${origin}${extension}`;
    };
    const refresh = () => {
      const selectable = variants.length > 1;
      control.label.hidden = !selectable;
      overlay.hidden = !selectable;
      if (!selectable) return;
      control.select.replaceChildren();
      variants.forEach(item => {
        const option = document.createElement('option');
        option.value = item.key;
        option.textContent = optionLabel(item);
        control.select.appendChild(option);
      });
      control.select.value = selectedKey;
    };
    control.select.addEventListener('change', () => {
      const nextKey = control.select.value;
      if (!nextKey || nextKey === selectedKey) return;
      selectedKey = nextKey;
      void onSelect(nextKey);
      refresh();
    });
    assetsPromise.then(assets => {
      variants = assets.variants.length ? assets.variants : variants;
      refresh();
      scheduleViewerLayout();
    }).catch(error => console.warn('Unable to discover video resolutions', error));
    return { refresh };
  }

  function hlsMasterURL(session, burnIndex = -1) {
    const url = new URL(session.masterUrl, location.origin);
    if (burnIndex >= 0) url.searchParams.set('burn', String(burnIndex));
    return url.pathname + url.search;
  }

  async function attachAdvancedMedia({ media, session, controls, status, stateRef, generation, initialState }) {
    const Hls = await loadHLSLibrary();
    const masterURL = hlsMasterURL(session);
    let heartbeatStop = stateRef.heartbeatStop || startMediaHeartbeat(session.id);
    stateRef.sessionId = session.id;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: false,
        backBufferLength: 12,
        maxBufferLength: 12,
        maxMaxBufferLength: 18,
        maxBufferSize: 24 * 1024 * 1024,
        fragLoadingTimeOut: 120000,
        manifestLoadingTimeOut: 30000,
        levelLoadingTimeOut: 30000
      });
      stateRef.hls = hls;
      const reloadForBurn = (burnIndex, textIndex) => new Promise((resolve, reject) => {
        const state = captureMediaState(media);
        const source = hlsMasterURL(session, burnIndex);
        let settled = false;
        const finish = callback => value => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        const complete = finish(resolve);
        const fail = finish(reject);
        const onManifest = () => {
          if (stateRef.generation !== generation) return complete();
          media.playbackRate = state.playbackRate;
          media.volume = state.volume;
          media.muted = state.muted;
          try { media.currentTime = state.currentTime; } catch (_) {}
          if (textIndex >= 0) hls.subtitleTrack = textIndex;
          if (!state.paused) void media.play().catch(() => {});
          complete();
        };
        hls.once(Hls.Events.MANIFEST_PARSED, onManifest);
        hls.once(Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal) fail(new Error(data.details || 'Unable to switch embedded subtitle track.'));
        });
        hls.loadSource(source);
      });
      installHLSAudioSelector(hls, controls);
      installHLSEmbeddedSubtitleSelector(hls, session, media, controls, reloadForBurn);
      hls.attachMedia(media);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(masterURL));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        status.hidden = true;
        status.textContent = '';
        restoreMediaState(media, initialState, generation, stateRef);
        scheduleViewerLayout();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !stateRef.mediaRecovered) {
          stateRef.mediaRecovered = true;
          hls.recoverMediaError();
          return;
        }
        status.hidden = false;
        status.textContent = `Advanced media preview failed: ${data.details || 'unknown playback error'}`;
      });
    } else if (media.canPlayType('application/vnd.apple.mpegurl')) {
      media.src = masterURL;
      installNativeAudioSelector(media, controls);
      installSubtitleSelector(media, controls);
      restoreMediaState(media, initialState, generation, stateRef);
    } else {
      heartbeatStop();
      heartbeatStop = null;
      throw new Error('This browser cannot play HLS media previews.');
    }
    stateRef.heartbeatStop = heartbeatStop;
  }

  function renderVideo(url, key, mime = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-preview video-preview';
    const stage = document.createElement('div');
    stage.className = 'media-video-stage';
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    const status = document.createElement('div');
    status.className = 'media-preview-status';
    status.hidden = true;
    const resolutionOverlay = document.createElement('div');
    resolutionOverlay.className = 'media-resolution-overlay';
    resolutionOverlay.hidden = true;
    stage.append(video, status, resolutionOverlay);
    const controls = document.createElement('div');
    controls.className = 'media-track-controls';
    controls.hidden = true;
    wrapper.append(stage, controls);

    const assetsPromise = discoverVideoAssets(key);
    const stateRef = {
      generation: 0,
      destroyed: false,
      hls: null,
      sessionId: '',
      heartbeatStop: null,
      controller: null,
      mediaRecovered: false,
      nativeTrial: false,
      nativeErrorHandler: null
    };

    function setStatus(message) {
      status.hidden = !message;
      status.textContent = message || '';
    }

    async function disposeCurrent(keepalive = false) {
      stateRef.controller?.abort();
      stateRef.controller = null;
      if (stateRef.nativeErrorHandler) {
        video.removeEventListener('error', stateRef.nativeErrorHandler);
        stateRef.nativeErrorHandler = null;
      }
      stateRef.nativeTrial = false;
      stateRef.heartbeatStop?.();
      stateRef.heartbeatStop = null;
      if (stateRef.hls) {
        try { stateRef.hls.destroy(); } catch (_) {}
        stateRef.hls = null;
      }
      const sessionId = stateRef.sessionId;
      stateRef.sessionId = '';
      if (sessionId) deleteMediaSessionSoon(sessionId, keepalive);
      controls.replaceChildren();
      controls.hidden = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
    }

    function startNativePlayback(session, nextKey, previousState, generation) {
      stateRef.sessionId = session.id;
      stateRef.heartbeatStop = stateRef.heartbeatStop || startMediaHeartbeat(session.id);
      stateRef.nativeTrial = true;
      const fallback = async () => {
        if (stateRef.destroyed || generation !== stateRef.generation || !stateRef.nativeTrial) return;
        stateRef.nativeTrial = false;
        if (stateRef.nativeErrorHandler) {
          video.removeEventListener('error', stateRef.nativeErrorHandler);
          stateRef.nativeErrorHandler = null;
        }
        video.pause();
        video.removeAttribute('src');
        video.load();
        setStatus('Native decoding failed. Preparing a compatible playback window…');
        try {
          await attachAdvancedMedia({ media: video, session, controls, status, stateRef, generation, initialState: previousState });
        } catch (error) {
          if (error?.name === 'AbortError') return;
          setStatus(`Advanced preview unavailable: ${error.message || error}`);
        }
      };
      stateRef.nativeErrorHandler = fallback;
      video.addEventListener('error', fallback, { once: true });
      video.src = BB.api.previewURLForKey(nextKey);
      installNativeAudioSelector(video, controls);
      const subtitleSelector = installSubtitleSelector(video, controls);
      void addSubtitleSidecars(video, nextKey, discoverVideoAssets(nextKey), subtitleSelector.refresh).catch(() => {});
      restoreMediaState(video, previousState, generation, stateRef);
    }

    async function loadKey(nextKey, nextMime = '') {
      const generation = ++stateRef.generation;
      const previousState = captureMediaState(video);
      await disposeCurrent();
      if (stateRef.destroyed || generation !== stateRef.generation) return;
      const controller = new AbortController();
      stateRef.controller = controller;
      stateRef.mediaRecovered = false;
      video.dataset.objectKey = nextKey;
      setStatus('Inspecting embedded media tracks…');
      let session;
      try {
        session = await BB.api.createMediaSession(nextKey, mediaSessionOptions({
          signal: controller.signal,
          mime: nextMime || (nextKey === key ? mime : '')
        }));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        setStatus('Advanced inspection is unavailable. Trying native browser playback…');
        video.src = BB.api.previewURLForKey(nextKey);
        installNativeAudioSelector(video, controls);
        const subtitleSelector = installSubtitleSelector(video, controls);
        void addSubtitleSidecars(video, nextKey, discoverVideoAssets(nextKey), subtitleSelector.refresh).catch(() => {});
        restoreMediaState(video, previousState, generation, stateRef);
        return;
      }
      if (stateRef.destroyed || generation !== stateRef.generation) {
        deleteMediaSessionSoon(session.id);
        return;
      }
      if (!shouldUseAdvancedVideo(session, nextKey, nextMime || mime, video)) {
        // Keep the lightweight, process-free session while native playback is
        // active. If the container parses but its codec later fails to decode,
        // the same probe result can immediately fall back to the bounded HLS
        // path without paying for a second inspection request.
        setStatus('Loading the original media…');
        startNativePlayback(session, nextKey, previousState, generation);
        return;
      }
      stateRef.sessionId = session.id;
      setStatus('Preparing the requested playback segment…');
      try {
        await attachAdvancedMedia({ media: video, session, controls, status, stateRef, generation, initialState: previousState });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        await disposeCurrent();
        if (stateRef.destroyed || generation !== stateRef.generation) return;
        setStatus(`Advanced track controls are unavailable (${error.message || error}). Trying the original media…`);
        video.dataset.objectKey = nextKey;
        video.src = BB.api.previewURLForKey(nextKey);
        installNativeAudioSelector(video, controls);
        const subtitleSelector = installSubtitleSelector(video, controls);
        void addSubtitleSidecars(video, nextKey, discoverVideoAssets(nextKey), subtitleSelector.refresh).catch(() => {});
        restoreMediaState(video, previousState, generation, stateRef);
      }
    }

    installResolutionSelector(resolutionOverlay, key, assetsPromise, nextKey => loadKey(nextKey, ''));
    video.addEventListener('loadedmetadata', () => {
      setStatus('');
      scheduleViewerLayout();
    });
    video.addEventListener('error', () => {
      if (stateRef.hls || stateRef.nativeTrial) return;
      const nextKey = video.dataset.objectKey || key;
      setStatus(`Native playback is unavailable for ${nextKey.split('/').pop() || nextKey}.`);
      scheduleViewerLayout();
    });
    void loadKey(key, mime);

    const pagehide = () => { void disposeCurrent(true); };
    window.addEventListener('pagehide', pagehide, { once: true });
    const cleanup = () => {
      stateRef.destroyed = true;
      stateRef.generation += 1;
      window.removeEventListener('pagehide', pagehide);
      void disposeCurrent(true);
    };
    activeMediaCleanups.add(cleanup);
    return wrapper;
  }

  function renderAudio(url, key, mime = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-audio-stage';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    const status = document.createElement('div');
    status.className = 'media-preview-status';
    status.textContent = 'Inspecting embedded audio tracks…';
    const controls = document.createElement('div');
    controls.className = 'media-track-controls';
    controls.hidden = true;
    wrapper.append(audio, status, controls);
    const stateRef = {
      generation: 1,
      hls: null,
      sessionId: '',
      heartbeatStop: null,
      controller: new AbortController(),
      mediaRecovered: false,
      nativeTrial: false,
      nativeErrorHandler: null
    };

    const startNativePlayback = session => {
      stateRef.sessionId = session.id;
      stateRef.heartbeatStop = stateRef.heartbeatStop || startMediaHeartbeat(session.id);
      stateRef.nativeTrial = true;
      const fallback = async () => {
        if (!stateRef.nativeTrial) return;
        stateRef.nativeTrial = false;
        if (stateRef.nativeErrorHandler) {
          audio.removeEventListener('error', stateRef.nativeErrorHandler);
          stateRef.nativeErrorHandler = null;
        }
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        status.hidden = false;
        status.textContent = 'Native decoding failed. Preparing a compatible playback window…';
        try {
          await attachAdvancedMedia({
            media: audio,
            session,
            controls,
            status,
            stateRef,
            generation: stateRef.generation,
            initialState: captureMediaState(audio)
          });
        } catch (error) {
          if (error?.name === 'AbortError') return;
          status.textContent = `Advanced audio preview unavailable: ${error.message || error}`;
        }
      };
      stateRef.nativeErrorHandler = fallback;
      audio.addEventListener('error', fallback, { once: true });
      audio.src = url;
      installNativeAudioSelector(audio, controls);
      audio.addEventListener('loadedmetadata', () => {
        status.hidden = true;
        status.textContent = '';
      }, { once: true });
    };

    const initialize = async () => {
      let session;
      try {
        session = await BB.api.createMediaSession(key, mediaSessionOptions({ signal: stateRef.controller.signal, mime }));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        status.textContent = 'Advanced inspection is unavailable. Using native browser playback.';
        audio.src = url;
        installNativeAudioSelector(audio, controls);
        return;
      }
      if (!shouldUseAdvancedAudio(session, key, mime, audio)) {
        status.hidden = true;
        status.textContent = '';
        startNativePlayback(session);
        return;
      }
      stateRef.sessionId = session.id;
      status.textContent = 'Preparing the requested audio segment…';
      try {
        await attachAdvancedMedia({
          media: audio,
          session,
          controls,
          status,
          stateRef,
          generation: stateRef.generation,
          initialState: captureMediaState(audio)
        });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        stateRef.heartbeatStop?.();
        stateRef.heartbeatStop = null;
        try { stateRef.hls?.destroy(); } catch (_) {}
        stateRef.hls = null;
        deleteMediaSessionSoon(stateRef.sessionId);
        stateRef.sessionId = '';
        controls.replaceChildren();
        controls.hidden = true;
        status.hidden = false;
        status.textContent = `Advanced track controls are unavailable (${error.message || error}). Using native browser playback.`;
        audio.src = url;
        installNativeAudioSelector(audio, controls);
      }
    };
    initialize().catch(error => {
      if (error?.name === 'AbortError') return;
      status.textContent = `Advanced audio preview unavailable: ${error.message || error}`;
      audio.src = url;
    });
    const pagehide = () => {
      stateRef.controller.abort();
      if (stateRef.nativeErrorHandler) {
        audio.removeEventListener('error', stateRef.nativeErrorHandler);
        stateRef.nativeErrorHandler = null;
      }
      stateRef.nativeTrial = false;
      stateRef.heartbeatStop?.();
      try { stateRef.hls?.destroy(); } catch (_) {}
      deleteMediaSessionSoon(stateRef.sessionId, true);
    };
    window.addEventListener('pagehide', pagehide, { once: true });
    const cleanup = () => {
      window.removeEventListener('pagehide', pagehide);
      pagehide();
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
    const status = document.createElement('div');
    status.className = 'pdf-status';
    status.textContent = 'Loading the PDF index with byte-range requests…';
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'pdf-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvasWrap.appendChild(canvas);
    wrapper.append(toolbar, status, canvasWrap);

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
      toolbar.remove();
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
        node = await BB.tabular.fetchTextTable(rawURL, key, metadata.size);
        className = 'preview-data';
      } else if (type === 'spreadsheet') {
        node = await BB.tabular.renderSpreadsheet(rawURL, key, metadata.size);
        className = 'preview-data';
      } else if (type === 'parquet') {
        node = await BB.tabular.renderParquet(rawURL, metadata.size);
        className = 'preview-data';
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

  window.addEventListener('hashchange', render);
  installViewerLayoutObserver();
  initialize();
})();
