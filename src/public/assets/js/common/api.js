/*!
 * BB.api — S3-like API over fetch, using BB.cfg (bucketUrl, bucketMaskUrl, rootPrefix, trashPrefix)
 */
(function () {
  const BB = (window.BB = window.BB || {});

  if (!BB.detect) throw new Error("BB.detect is required before BB.api");

  const api = {
    urlForKey(key, { mask = false } = {}) {
      const base = (mask ? (BB.cfg.bucketMaskUrl || BB.cfg.bucketUrl) : BB.cfg.bucketUrl || '/s3').replace(/\/*$/, '');
      key = (key || '').replace(/^\//, '');
      return `${base}/${BB.detect.encodePath(key)}`;
    },
    async head(key) {
      const res = await fetch(this.urlForKey(key), { method: 'HEAD' });
      if (!res.ok) throw new Error(`HEAD ${res.status}`);
      const headers = {}; res.headers.forEach((v, k) => headers[k] = v);
      return {
        mime: res.headers.get('Content-Type') || '',
        size: Number(res.headers.get('Content-Length') || 0),
        headers
      };
    },
    async getText(key) {
      const res = await fetch(this.urlForKey(key));
      if (!res.ok) throw new Error(`GET ${res.status}`);
      return await res.text();
    },
    async getBlob(key) {
      const res = await fetch(this.urlForKey(key));
      if (!res.ok) throw new Error(`GET ${res.status}`);
      return await res.blob();
    },
    async putBlob(key, blob, mime) {
      const res = await fetch(this.urlForKey(key), { method: 'PUT', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: blob });
      if (!res.ok) throw new Error(`PUT ${res.status}`);
    },
    async copy(srcKey, dstKey) {
      const blob = await this.getBlob(srcKey);
      await this.putBlob(dstKey, blob, blob.type || 'application/octet-stream');
    },
    async del(key) {
      try {
        const res = await fetch(this.urlForKey(key), { method: 'DELETE' });
        if (res.ok) return true;
        if (res.status === 405) return false;
        return false;
      } catch { return false; }
    },
    async listAll(prefixAbs) {
      const out = [];
      let token;
      do {
        let url = `${BB.cfg.bucketUrl}?list-type=2&prefix=${BB.detect.encodePath(prefixAbs)}`;
        if (token) url += `&continuation-token=${BB.detect.encodePath(token)}`;
        const resp = await fetch(url);
        const xml = await resp.text();
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const contents = [...doc.querySelectorAll('ListBucketResult > Contents > Key')].map(n => n.textContent);
        out.push(...contents);
        const nt = doc.querySelector('ListBucketResult > NextContinuationToken'); token = nt && nt.textContent;
      } while (token);
      return out;
    },
    async rename({ src, dst, isPrefix }) {
      const res = await fetch('/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src, dst, isPrefix: !!isPrefix })
      });
      if (!res.ok) throw new Error(`RENAME ${res.status}`);
      return await res.json();
    },
    async deletePrefix(prefixAbs) {
      const res = await fetch('/api/delete-prefix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: prefixAbs })
      });
      if (!res.ok) throw new Error(`DELETE-PREFIX ${res.status}`);
      return await res.json();
    },
    async stats(prefixAbs = '') {
      const p = String(prefixAbs || '').replace(/^\/+/, '');
      const res = await fetch(`/api/stats?prefix=${encodeURIComponent(p)}`);
      if (!res.ok) throw new Error(`STATS ${res.status}`);
      return await res.json();
    }
  };

  BB.api = api;
})();
