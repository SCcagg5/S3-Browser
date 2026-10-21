/*
 * BB.encryption: the encryption section of the file details. It is read only.
 * - the object: the headers of the HEAD answer (SSE-S3, SSE-KMS and its key), or an object with a key of the client
 *   (SSE-C) that the provider refused to read. S3-Browser never shows or asks for such a key;
 * - the bucket: its default encryption (GET /api/encryption), when the server could read it at start.
 * The section stays hidden when the provider reports no encryption.
 * The module also gives the key next to the name of a bucket (from /api/instances), the key next to the name of a
 * file in the listing and in the preview (from a HEAD request), and the message for an object with a key of the client.
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
    const children = [h('div', { class: 'bb-details-section-title' }, icon('key'), ' Encryption'), h('div', { class: 'bb-kv' }, rows)];
    if (customerKey || header(headers, 'x-amz-server-side-encryption-customer-algorithm')) {
      children.push(h('p', { class: 'encryptionNote', 'data-encryption-note': '' }, 'The provider reads this object only with the key of the client. S3-Browser does not ask for this key: the preview, the download and the copy are not available.'));
    }
    host.replaceChildren(...children);
    host.hidden = false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Objects with a key of the client (SSE-C)
  // ---------------------------------------------------------------------------------------------------------------

  const CUSTOMER_KEY_TEXT = 'This object is encrypted with a key of the client (SSE-C). The browser cannot read it without that key.';

  // A read that the provider refused with 400 is an object with a key of the client only when GET /api/media-info says
  // so (customerKey). The page does not guess from an other 400.
  async function customerKeyRefusal(error, key, { version = '', instance = null } = {}) {
    if (Number(error?.status || 0) !== 400 || !key) return false;
    try {
      return (await BB.api.mediaInfo(key, { version, instance })).customerKey === true;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The lock of a bucket and the lock of a file
  // ---------------------------------------------------------------------------------------------------------------

  // The key of a bucket tells the truth of the provider. A default encryption of the bucket encrypts each new object.
  // The key encryption = "sse-s3" encrypts only on a provider that applies it (encryptionApplied of /api/instances):
  // Garage accepts the header and does not encrypt, so its bucket gets a key in the colour of a warning. Null: no key.
  // The key is the mark of the encryption. The padlock is the mark of Object Lock (objectlock.js).
  function bucketLock(instance) {
    const algorithm = String(instance?.defaultEncryption || '');
    const applied = String(instance?.encryptionApplied || '');
    if (instance?.encryption === 'sse-s3' && applied === 'yes') return { icon: 'key', tone: 'on', title: 'Encrypted: SSE-S3 for each new object' };
    if (algorithm) return { icon: 'key', tone: 'on', title: `Default encryption of the bucket: ${algorithm}` };
    if (instance?.encryption === 'sse-s3' && applied === 'no') return { icon: 'key', tone: 'warn', title: 'SSE-S3 requested; the provider does not encrypt the objects (Garage)' };
    if (instance?.encryption === 'sse-s3') return { icon: 'key', tone: 'warn', title: 'SSE-S3 requested; the provider may not encrypt' };
    return null;
  }

  // An instance is "encryption aware" when its bucket can encrypt: a default encryption, or the key on a provider that
  // applies it or that S3-Browser does not know. The listing then reads the encryption of each file by default.
  const encryptionAware = instance => Boolean(instance?.defaultEncryption)
    || (instance?.encryption === 'sse-s3' && instance?.encryptionApplied !== 'no');

  // The encryption of a file from the headers of its HEAD answer, as a text for the tooltip. Empty: no encryption.
  function objectEncryptionTitle(headers) {
    if (header(headers, 'x-amz-server-side-encryption-customer-algorithm')) return 'Encrypted with a key of the client (SSE-C)';
    const algorithm = header(headers, 'x-amz-server-side-encryption');
    if (!algorithm) return '';
    const keyID = header(headers, 'x-amz-server-side-encryption-aws-kms-key-id');
    if (algorithm === 'AES256') return 'Encrypted: SSE-S3';
    if (algorithm.startsWith('aws:kms')) return `Encrypted: ${algorithm === 'aws:kms:dsse' ? 'DSSE-KMS' : 'SSE-KMS'}${keyID ? `, key ${keyID}` : ''}`;
    return `Encrypted: ${algorithm}`;
  }

  // The encryption of a file in the listing: a HEAD request, and for a refusal with 400 the confirmation of
  // /api/media-info. The answer has the text of the tooltip (encryption, '' when the provider reports nothing) and the
  // headers of the HEAD answer, which also give the lock of the file. A refused HEAD gives no headers.
  async function objectEncryption(key, instance) {
    try {
      const { headers } = await BB.api.head(key, '', instance);
      return { encryption: objectEncryptionTitle(headers), headers };
    } catch (error) {
      if (await customerKeyRefusal(error, key, { instance })) return { encryption: 'Encrypted with a key of the client (SSE-C)', headers: {} };
      throw error;
    }
  }

  BB.encryption = { mountSection, objectRows, CUSTOMER_KEY_TEXT, customerKeyRefusal, bucketLock, encryptionAware, objectEncryptionTitle, objectEncryption };
})();
