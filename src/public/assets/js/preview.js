const CONFIG = { bucketUrl: '/s3', bucketMaskUrl: '/s3', rootPrefix: '', trashPrefix: '_trash/' };
window.BB = window.BB || {};
BB.cfg = CONFIG;

function currentKey() {
  const raw = decodeURIComponent((location.hash||'#').slice(1));
  const qPos = raw.indexOf('?');
  const key = qPos === -1 ? raw : raw.slice(0, qPos);
  return key.replace(/^\/+/,'');
}
function setDocMeta(fullKey, size) {
  const name = fullKey.split('/').pop() || fullKey;
  const prefix = fullKey.slice(0, -(name.length)).replace(/\/$/, '');
  document.getElementById('docName').textContent = decodeURIComponent(name || '');
  document.getElementById('docPrefix').textContent = prefix ? `- /${decodeURIComponent(prefix)}` : '';
  document.getElementById('docSize').textContent = size ? '(' + formatBytes(size) + ')' : '';
}
function formatBytes(size) {
  const KB=1024, MB=1048576, GB=1073741824;
  if (size == null || isNaN(size)) return '';
  if (size<KB) return size+' B';
  if (size<MB) return (size/KB).toFixed(0)+' KB';
  if (size<GB) return (size/MB).toFixed(2)+' MB';
  return (size/GB).toFixed(2)+' GB';
}

const renderCode = BB.render.renderCode;
const renderMarkdown = BB.render.renderMarkdown;
function renderImage(url) { const img = document.createElement('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; return img; }
function renderVideo(url) { const v = document.createElement('video'); v.src = url; v.controls = true; v.style.maxWidth = '100%'; return v; }
function renderAudio(url) { const a = document.createElement('audio'); a.src = url; a.controls = true; a.style.width = '100%'; return a; }
function renderIframe(url) { const f = document.createElement('iframe'); f.src = url; f.allowFullscreen = true; return f; }
function renderUnknownBinary() {
  const div = document.createElement('div');
  div.innerHTML = `<p><strong>File not available for preview</strong></p><p>You can download the file to access it.</p>`;
  return div;
}

async function render() {
  const key = currentKey();
  const { mime, size } = await BB.api.head(key);
  setDocMeta(key, size);

  const container = document.getElementById('viewer');
  container.innerHTML = '';

  const rawUrl = BB.api.urlForKey(key, { mask: true });
  document.getElementById('openRawBtn').href = rawUrl;

  const type = BB.detect.resolveType(key, mime);

  if (type === 'image') { container.appendChild(renderImage(rawUrl)); return; }
  if (type === 'video') { container.appendChild(renderVideo(rawUrl)); return; }
  if (type === 'audio') { container.appendChild(renderAudio(rawUrl)); return; }
  if (type === 'pdf' || type === 'embed') { container.appendChild(renderIframe(rawUrl)); return; }

  if (type === 'markdown') {
    const text = await BB.api.getText(key);
    container.appendChild(renderMarkdown(text));
    return;
  }
  if (type === 'code') {
    const text = await BB.api.getText(key);
    const lang = BB.detect.resolveLang(key, mime);
    container.appendChild(renderCode(text, lang));
    return;
  }
  container.appendChild(renderUnknownBinary());
}

document.getElementById('pv-download').addEventListener('click', () => {
  const key = currentKey();
  BB.actions.downloadObject(key, key.split('/').pop());
});
document.getElementById('pv-copy').addEventListener('click', async () => {
  const key = currentKey();
  const dst = await BB.actions.copyObject(key);
  if (dst) await render();
});
document.getElementById('pv-rename').addEventListener('click', async () => {
  const key = currentKey();
  const dst = await BB.actions.renameObject(key);
  if (dst) {
    const hash = decodeURIComponent((location.hash||'#').slice(1));
    const qPos = hash.indexOf('?'); const qs = qPos === -1 ? '' : hash.slice(qPos);
    location.replace('#' + encodeURIComponent(dst).replace(/%2F/g,'/') + qs);
    await render();
  }
});
document.getElementById('pv-details').addEventListener('click', () => BB.actions.showMetadata(currentKey()));
document.getElementById('pv-delete').addEventListener('click', async () => {
  const result = await BB.actions.deleteObject(currentKey());
  if (result) history.back();
});

window.addEventListener('hashchange', render);
render();
