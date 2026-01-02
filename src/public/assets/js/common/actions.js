/*!
 * BB.actions — Unified actions using BB.ui + BB.api + BB.detect
 * Tolerant load order: UI is resolved at call time with a native fallback.
 */
(function () {
  const BB = (window.BB = window.BB || {});
  if (!BB.detect) throw new Error("BB.detect required before BB.actions");
  if (!BB.api) throw new Error("BB.api required before BB.actions");

  function nativeUI() {
    return {
      alert({ title, message }) { window.alert((title ? title + '\n' : '') + (message || '')); return Promise.resolve(); },
      confirm({ title, message }) { const ok = window.confirm((title ? title + '\n' : '') + (message || '')); return Promise.resolve(ok); },
      prompt({ title, message, defaultValue }) { const val = window.prompt((title ? title + '\n' : '') + (message || ''), defaultValue || ''); return Promise.resolve(val); },
      toast(msg) { try { console.log('[toast]', msg); } catch {} }
    };
  }
  function getUI() { return (BB.ui ? BB.ui : nativeUI()); }

  const labels = {
    renameTitle: 'Rename',
    deleteTitle: 'Delete',
    deletePrompt: 'Delete this fichier ?',
    folderDeletePrompt: 'Delete this folder and all it\'s content?',
    deleteOk: 'Deleted.',
    renameOk: 'Renamed.',
    moveTrashOk: 'Moved to the trash',
    unauthorized: 'Unauthorized',
    copyDenied: 'Copy refused'
  };

  function escapeHTML(s=''){ const t=document.createElement('span'); t.textContent=String(s); return t.innerHTML; }
  function formatBytes(size){
    if (!Number.isFinite(size)) return '-';
    const pow2_10 = 1024
    const KB=1 * pow2_10, MB=KB* pow2_10, GB=MB * pow2_10, TB=GB * pow2_10;
    if (size < KB) return size + ' B';
    if (size < MB) return (size/KB).toFixed(size<10*KB?1:0) + ' KB';
    if (size < GB) return (size/MB).toFixed(2) + ' MB';
    if (size < TB) return (size/GB).toFixed(2) + ' GB';
    return (size/TB).toFixed(2) + ' TB';
  }
  function iconFor(key, mime){
    const e = (key.split('.').pop() || '').toLowerCase();
    if (BB.detect.isImageExt(e)) return 'file-image-outline';
    if (BB.detect.isVideoExt(e)) return 'file-video-outline';
    if (BB.detect.isAudioExt(e)) return 'file-music-outline';
    if (BB.detect.isPdfExt(e)) return 'file-pdf-box';
    if (BB.detect.isCodeExt(e)) return 'file-code-outline';
    return 'file-outline';
  }
  function typefor(key, mime){
    type = BB.detect.resolveType(key, mime);
    if (type == 'code') {
      return BB.detect.resolveLang(key, mime);
    }
    return type;
  }
  function formatDateTime_utc(d){ return d ? moment(d).utc().format('YYYY-MM-DD HH:mm:ss [UTC]') : ''; }

  async function showFileDetails(absKey) {
    const ui = getUI();
    try {
      const { headers, size, mime } = await BB.api.head(absKey);
      const group3 = n => (n < 0 ? '-' : '') + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
      const name = absKey.split('/').pop() || absKey;
      const prefix = absKey.slice(0, -(name.length)).replace(/\/$/, '');
      const lastMod = headers['last-modified'] || headers['Last-Modified'] || '';
      const lastStr = lastMod ? (window.moment ? moment(new Date(lastMod)).fromNow() : new Date(lastMod).toLocaleString()) : '—';
      const eTag = headers['etag'] || headers['ETag'] || '';
      const ct = headers['content-type'] || headers['Content-Type'] || mime || '';
      const rawUrl = BB.api.urlForKey(absKey, { mask: true });
      const icon = iconFor(name, ct);
      const type = typefor(name, ct);
      const headersStr = JSON.stringify(headers, null, 2).replaceAll('\\"', '');
      let metaHTML = '';
      try {
        if (BB.render && BB.render.renderCode) {
          const preNode = BB.render.renderCode(headersStr, 'json', in_pre = false);
          metaHTML = preNode.outerHTML; 
        }
      } catch {}
      if (!metaHTML) {
        const esc = escapeHTML(headersStr);
        metaHTML = `<pre class="bb-pre"><code class="language-json">${esc}</code></pre>`;
      }

      const html = `
        <div class="bb-details">
          <div class="bb-details-head">
            <i class="mdi mdi-${icon}"></i>
            <div class="bb-details-titles">
              <div class="bb-details-name" title="${escapeHTML(name)}">
                <div class="bb-details-prefix" title="${escapeHTML(prefix)}">${prefix ? escapeHTML(prefix) + '/' : ''}</div>
                <span>${escapeHTML(name)}</span>
              </div>
            </div>
            <a class="icon-btn-disc" title="Open file" rel="noopener" href="${escapeHTML(rawUrl)}">
              <i class="mdi mdi-open-in-new small-icon"></i>
            </a>
            <a class="icon-btn-disc" title="Download" rel="noopener" href="${escapeHTML(rawUrl)}" download="${escapeHTML(name)}">
              <i class="mdi mdi-download small-icon"></i>
            </a>
          </div>
          <div class="bb-details-grid">
            <div class="kv-row"><div class="kv-k">Type</div><div class="kv-v">${escapeHTML(type || '—')}</div></div>
            <div class="kv-row"><div class="kv-k">Size</div><div class="kv-v">${formatBytes(size)} <span class="kv-muted">(${group3(size)} bytes)</span></div></div>
            <div class="kv-row"><div class="kv-k">Last modification</div><div class="kv-v">${escapeHTML(lastStr)}<span class="kv-muted">(${formatDateTime_utc(lastMod)})</span></div></div>
            
          </div>
          <div style='font-size: 0.8rem;'>
            ${metaHTML}
          </div>
        </div>
      `;
      await ui.alert({html: html });
    } catch (e) {
      await ui.alert({ title: labels.metaTitle, message: String(e) });
    }
  }

  async function showMetadata(key) { return showFileDetails(key); }

  function fmtBytes(n) {
    const KB=1024, MB=1048576, GB=1073741824, TB=1099511627776;
    if (!Number.isFinite(n)) return '-';
    if (n<KB) return `${n} B`;
    if (n<MB) return `${(n/KB).toFixed(0)} KB`;
    if (n<GB) return `${(n/MB).toFixed(2)} MB`;
    if (n<TB) return `${(n/GB).toFixed(2)} GB`;
    return `${(n/TB).toFixed(2)} TB`;
  }

  function fmtDate(d) {
    try { return new Date(d).toISOString().replace('T',' ').replace('Z',' UTC'); } catch { return String(d||''); }
  }

  function joinPath(base, name) {
    base = String(base||'').replace(/\/{2,}/g,'/'); name = String(name||'');
    if (!base.endsWith('/')) base += '/';
    return (base + name).replace(/\/{2,}/g,'/');
  }
  function dirOf(absKey) {
    const i = absKey.lastIndexOf('/'); return i === -1 ? '' : absKey.slice(0, i+1);
  }
  function ensurePrefix(p) {
    p = (p||'').replace(/\/{2,}/g,'/').replace(/^\//,'');
    return p.endsWith('/') ? p : (p + '/');
  }
  function escapeRx(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

  async function showPrefixDetails(prefixAbs) {
  const ui = getUI();
  try {
    const stat = await BB.api.stats(prefixAbs);

    const group3 = n => (n < 0 ? '-' : '') + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '&nbsp;');
    const prefix = ensurePrefix(prefixAbs || '');
    const icon = 'folder-outline';
    const folders_name = prefix.split('/');
    const name = folders_name[folders_name.length - 2];
    const name_prefix = folders_name.slice(0, folders_name.length - 2).join('/') + '/';

    const oldestAbs = stat.oldest ? fmtDate(stat.oldest) : '—';
    const newestAbs = stat.newest ? fmtDate(stat.newest) : '—';
    const oldestRel = stat.oldest
      ? (window.moment ? moment(new Date(stat.oldest)).fromNow() : new Date(stat.oldest).toLocaleString())
      : '—';
    const newestRel = stat.newest
      ? (window.moment ? moment(new Date(stat.newest)).fromNow() : new Date(stat.newest).toLocaleString())
      : '—';

    const norm = a => ({ count: (a && a.count) || 0, bytes: (a && a.bytes) || 0 });
    const totalBytes = stat.totalBytes || 0;

    const bt = stat.byType || {};
    const labelMap = {
      image: 'Image',
      video: 'Video',
      audio: 'Audio',
      pdf: 'PDF',
      markdown: 'Markdown',
      doc: 'Document',
      spreadsheet: 'Spreadsheet',
      presentation: 'Presentation',
      archive: 'Archive',
      code: 'Code',
      other: 'Other',
    };
    const pl = (s, n) => s + (n > 1 ? 's' : '');

    const typeLine = (labelSing, obj) => {
      if (!obj.count) return '';
      let pct = totalBytes ? (obj.bytes * 100 / totalBytes) : 0;
      let pctStr = pct > 0.01 ? pct.toFixed(2) : (pct > 0 ? '&lt; 0.01' : '0');
      return `
        <div class="kv-row">
          <div class="kv-k">&nbsp;${pl(labelSing, obj.count)}</div>
          <div class="kv-v">
            ${fmtBytes(obj.bytes)}
            <span class="kv-muted">(${group3(obj.count)} object${obj.count>1?'s':''}, ${pctStr}% of total size)</span>
          </div>
        </div>`;
    };

    const typesOrdered = Object.entries(bt)
      .map(([k, v]) => [labelMap[k] || k, norm(v)])
      .filter(([, o]) => o.count > 0)
      .sort((a, b) =>
        (b[1].bytes - a[1].bytes) ||
        (b[1].count - a[1].count) ||
        a[0].localeCompare(b[0])
      );

    const typesHTML = typesOrdered.map(([label, o]) => typeLine(label, o)).join('');

    const folders = Object.entries(stat.byFolder || {}).map(([name, a]) => [name, norm(a)]);
    folders.sort((a, b) => (b[1].bytes - a[1].bytes) || a[0].localeCompare(b[0]));
    const topN = folders.slice(0, 10);
    const topRows = topN.map(([name, a]) => {
      let pct = totalBytes ? (a.bytes * 100 / totalBytes) : 0;
      let pctStr = pct > 0.01 ? pct.toFixed(2) : (pct > 0 ? '&lt; 0.01' : '0');
      const href = `#${ensurePrefix(prefix + (name || ''))}`;
      return `
        <div class="kv-row">
          <div class="kv-k">
            <a class="bb-top kv-k mono" href="${href}" title="Ouvrir ${escapeHTML(name)}">
              &nbsp;${escapeHTML(name || '(racine)')}
            </a>
          </div>
          <div class="kv-v">
            ${fmtBytes(a.bytes)}
            <span class="kv-muted">(${group3(a.count)} object${a.count>1?'s':''}, ${pctStr}% of total size</span>
          </div>
        </div>`;
    }).join('');

    const browseHref = `#${encodeURIComponent(prefix)}`;
    const copyValue = prefix.replace(/'/g, "\\'");

    const html = `
      <div class="bb-details bb-details--prefix">
        <div class="bb-details-head">
          <i class="mdi mdi-${icon}"></i> 
          <div class="bb-details-titles"> 
            <div class="bb-details-name" title="${escapeHTML(name)}">
                <div class="bb-details-prefix" title="${escapeHTML(name_prefix)}">${name_prefix ? escapeHTML(name_prefix) : ''}
                </div><span>${escapeHTML(name) + '/'}</span>
              </div>
          </div> 
          <a class="icon-btn-disc" title="Download" rel="noopener" href="${escapeHTML(browseHref)}" download="${escapeHTML(name)}"> 
            <i class="mdi mdi-download small-icon"></i> 
          </a> 
        </div>
         
        <div class="bb-details-body">
          <div class="bb-section bb-kv">
            <div class="kv-row"><div class="kv-k">Objects</div><div class="kv-v">${group3(stat.count)}</div></div>
            <div class="kv-row"><div class="kv-k">Size</div><div class="kv-v">${fmtBytes(stat.totalBytes)} <span class="kv-muted">(${group3(stat.totalBytes)} bytes)</span></div></div>
            <div class="kv-row"><div class="kv-k">First interaction</div><div class="kv-v">${escapeHTML(oldestRel)} <span class="kv-muted">(${escapeHTML(oldestAbs)})</span></div></div>
            <div class="kv-row"><div class="kv-k">Last interaction</div><div class="kv-v">${escapeHTML(newestRel)} <span class="kv-muted">(${escapeHTML(newestAbs)})</span></div></div>
            
            <h4 class="bb-details-subtitle" style="margin-top:10px">Files:</h4>
            <div class="bb-type-wrap">
              ${typesHTML || `<div class="kv-muted">&nbsp;&nbsp;&nbsp;(aucun type détecté)</div>`}
            </div>
            
            <h4 class="bb-details-subtitle" style="margin-top:10px">Folders</h4>
            <div class="bb-toplist">
              ${topRows || `<div class="kv-muted">&nbsp;&nbsp;&nbsp;(no sub-folder)</div>`}
            </div>
          </div>
        </div>
      </div>
    `;

    await ui.alert({ html: html });
  } catch (e) {
    await ui.alert({ title: labels.detailsTitle, message: String(e) });
  }
}

  async function renamePrefix(prefixAbs) {
    const ui = getUI();
    const p = ensurePrefix(prefixAbs);
    const last = p.split('/').filter(Boolean).pop() || '';
    const parent = p.slice(0, p.length - last.length - 1); 
    const newName = await ui.prompt({ title: labels.renameTitle, message: labels.renamePrompt, defaultValue: last || 'new-folder' });
    if (!newName || newName === last) return false;
    const dst = ensurePrefix(parent + newName);
    try {
      await BB.api.rename({ src: p, dst, isPrefix: true });
      ui.toast(labels.renameOk);
      return dst;
    } catch (e) {
      await ui.alert({ title: labels.renameTitle, message: String(e) });
      return false;
    }
  }

  async function copyPrefix(prefixAbs) {
    const ui = getUI();
    const src = ensurePrefix(prefixAbs);
    const last = src.split('/').filter(Boolean).pop() || '';
    const parent = src.slice(0, src.length - last.length - 1);
    const newName = await ui.prompt({ title: `${labels.deleteTitle} ${last}`, message: '', defaultValue: last + '-copy' });
    if (!newName) return false;
    const dst = ensurePrefix(parent + '/' + newName);

    try {
      const keys = await BB.api.listAll(src);
      const rx = new RegExp('^' + escapeRx(src));
      const toCopy = keys.filter(k => !k.endsWith('/'));
      const concurrency = 8;
      let done = 0;
      const queue = toCopy.slice();
      const runOne = async () => {
        const k = queue.shift(); if (!k) return;
        const rel = k.replace(rx, '');
        const out = dst + rel;
        try { await BB.api.copy(k, out); } catch (e) { console.error('Copy fail', k, '->', out, e); }
        done++;
        if (queue.length) await runOne();
      };
      await Promise.all(Array.from({length: Math.min(concurrency, queue.length)}, runOne));
      ui.toast(`Folder copy done (${done} objects)`);
      return dst;
    } catch (e) {
      await ui.alert({ title: 'Copy the folder', message: String(e) });
      return false;
    }
  }

  async function deletePrefix(prefixAbs) {
    const ui = getUI();
    const okc = await ui.confirm({ title: labels.deleteTitle, message: labels.folderDeletePrompt });
    if (!okc) return false;
    try {
      const { deleted } = await BB.api.deletePrefix(ensurePrefix(prefixAbs));
      ui.toast(`Deleted (${deleted} objects)`);
      return true;
    } catch (e) {
      await ui.alert({ title: labels.deleteTitle, message: String(e) });
      return false;
    }
  }

  async function renameObject(absKey) {
    const ui = getUI();
    const cur = absKey.split('/').pop() || absKey;
    const base = absKey.replace(/[^/]*$/, '');
    const newName = await ui.prompt({ title: labels.renameTitle, message: labels.renamePrompt, defaultValue: cur });
    if (!newName || newName === cur) return false;
    const dst = base + newName;
    try {
      await BB.api.rename({ src: absKey, dst, isPrefix: false });
    } catch (e) {
      try {
        await BB.api.copy(absKey, dst);
        const ok = await BB.api.del(absKey);
        if (!ok) await moveToTrash(absKey);
      } catch (ee) {
        await ui.alert({ title: labels.renameTitle, message: String(ee||e||labels.unauthorized) });
        return false;
      }
    }
    ui.toast(labels.renameOk);
    return dst;
  }

  async function copyObject(absKey) {
    const ui = getUI();
    const cur = absKey.split('/').pop() || absKey;
    const base = dirOf(absKey);
    const newName = await ui.prompt({ title: `Duplicate ${cur}`, message: ``, defaultValue: cur });
    if (!newName || newName === cur) return false;
    const dst = base + newName;
    try {
      await BB.api.copy(absKey, dst);
      ui.toast('Copy done.');
      return dst;
    } catch (e) {
      await ui.alert({ title: `Duplicate ${cur}`, message: String(e || labels.unauthorized) });
      return false;
    }
  }

  async function deleteObject(absKey) {
    const ui = getUI();
    const okc = await ui.confirm({ title: labels.deleteTitle, message: labels.deletePrompt, confirmText: 'Supprimer' });
    if (!okc) return false;
    const ok = await BB.api.del(absKey);
    if (!ok) {
      await moveToTrash(absKey);
      ui.toast(labels.moveTrashOk);
      return 'trash';
    }
    ui.toast(labels.deleteOk);
    return true;
  }

  async function moveToTrash(absKey) {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const dst = (BB.cfg.trashPrefix || '_trash/') + ts + '/' + absKey;
    await BB.api.copy(absKey, dst);
  }

  function downloadObject(absKey, filename) {
    const url = BB.api.urlForKey(absKey, { mask: true });
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || (absKey.split('/').pop() || 'download');
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  BB.actions = {
    labels,
    showMetadata, 
    showFileDetails,
    showPrefixDetails, 
    renameObject, copyObject, deleteObject, downloadObject, moveToTrash,
    renamePrefix, copyPrefix, deletePrefix
  };
})();
