/*
 * BB.encryption: the encryption section of the file details. It is read only.
 * - the object: the headers of the HEAD answer (SSE-S3, SSE-KMS and its key), or an object with a key of the client
 *   (SSE-C) that the provider refused to read. S3-Browser never shows or asks for such a key;
 * - the bucket: its default encryption (GET /api/encryption), when the server could read it at start.
 * The section stays hidden when the provider reports no encryption.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const ALGORITHMS = { AES256: 'SSE-S3 (AES256)', 'aws:kms': 'SSE-KMS (aws:kms)', 'aws:kms:dsse': 'DSSE-KMS (aws:kms:dsse)' };

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const icon = name => h('i', { class: `mdi mdi-${name}`, 'aria-hidden': 'true' });
  const algorithmText = value => ALGORITHMS[value] || String(value || '');
  const row = (label, field, value, mono = false) =>
    h('div', { class: 'kv-row' }, h('div', { class: 'kv-k' }, label), h('div', { class: mono ? 'kv-v mono' : 'kv-v', 'data-encryption-field': field }, value));

  function header(headers, name) {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
      if (key.toLowerCase() === wanted) return String(value || '').trim();
    }
    return '';
  }

  // The rows of the object: what the HEAD answer of the provider says. No row when it says nothing.
  function objectRows(headers, customerKey) {
    const customer = header(headers, 'x-amz-server-side-encryption-customer-algorithm');
    if (customerKey || customer) {
      return [row('Object', 'object', customer ? `Key of the client, SSE-C (${customer})` : 'Key of the client, SSE-C')];
    }
    const algorithm = header(headers, 'x-amz-server-side-encryption');
    if (!algorithm) return [];
    const rows = [row('Object', 'object', algorithmText(algorithm))];
    const keyID = header(headers, 'x-amz-server-side-encryption-aws-kms-key-id');
    if (keyID) rows.push(row('KMS key', 'kmsKey', keyID, true));
    if (header(headers, 'x-amz-server-side-encryption-bucket-key-enabled').toLowerCase() === 'true') rows.push(row('S3 Bucket Key', 'bucketKey', 'On'));
    return rows;
  }

  function bucketText(value) {
    const text = algorithmText(value.algorithm);
    return value.kmsKeyId ? `${text}, key ${value.kmsKeyId}` : text;
  }

  // headers are the headers of the details (GET /api/media-info); customerKey is true when the provider refused to read
  // an object with a key of the client.
  async function mountSection(host, { headers = {}, customerKey = false, instance = null }) {
    const rows = objectRows(headers, customerKey);
    if (BB.cfg?.bucketEncryptionSupported === true) {
      try {
        const answer = await BB.api.encryption(instance);
        if (answer?.bucketDefault?.algorithm) rows.push(row('Bucket default', 'default', bucketText(answer.bucketDefault)));
      } catch (error) {
        console.warn('Unable to load the default encryption of the bucket', error);
      }
    }
    if (!rows.length) {
      host.remove();
      return;
    }
    const children = [h('div', { class: 'bb-details-section-title' }, icon('lock-outline'), ' Encryption'), h('div', { class: 'bb-kv' }, rows)];
    if (customerKey || header(headers, 'x-amz-server-side-encryption-customer-algorithm')) {
      children.push(h('p', { class: 'encryptionNote', 'data-encryption-note': '' }, 'The provider reads this object only with the key of the client. S3-Browser does not ask for this key: the preview, the download and the copy are not available.'));
    }
    host.replaceChildren(...children);
    host.hidden = false;
  }

  BB.encryption = { mountSection, objectRows };
})();
