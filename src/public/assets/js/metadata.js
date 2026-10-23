/*
 * BB.metadata: the metadata section of the file details.
 * - the stored values of the standard headers and of the user metadata (x-amz-meta-*), read from the provider and not
 *   from the gateway /s3, which changes some of them (Cache-Control);
 * - the edit: a frameless "Edit" button opens the form in the same window, with Save and Revert as in the tags section;
 * - the notes before the save: what the copy onto the key changes on the provider.
 * The server checks each request again. A provider without the edit answers 501: the section keeps the values only.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const MAX_BYTES = 2048;
  const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
  const PRINTABLE = /^[\x20-\x7e]*$/;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const icon = name => h('i', { class: `mdi mdi-${name}`, 'aria-hidden': 'true' });

  // The standard headers of the form, in the order of the server. Each has values to suggest and the width of its field in
  // characters. The guessed Content-Type comes first.
  const COMMON_TYPES = ['application/octet-stream', 'text/plain', 'text/csv', 'text/html', 'text/markdown', 'application/json', 'application/xml',
    'application/pdf', 'application/zip', 'image/png', 'image/jpeg', 'image/svg+xml', 'video/mp4', 'audio/mpeg'];
  const LANGUAGES = [['en', 'English'], ['en-US', 'English, United States'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish']];
  const HEADERS = [
    { field: 'contentType', label: 'Content-Type', placeholder: 'application/octet-stream', size: 28,
      suggest: name => {
        const guess = BB.detect?.contentTypeForName?.(name) || '';
        return [...(guess ? [{ value: guess, tag: 'Guess' }] : []), ...COMMON_TYPES];
      } },
    { field: 'cacheControl', label: 'Cache-Control', placeholder: 'max-age=3600', size: 36, suggest: () => ['no-cache', 'no-store', 'max-age=3600', 'public, max-age=86400', 'private, max-age=0'] },
    { field: 'contentDisposition', label: 'Content-Disposition', placeholder: 'inline', size: 40, suggest: name => ['inline', `attachment; filename="${name.replace(/["\\]/g, '')}"`] },
    { field: 'contentEncoding', label: 'Content-Encoding', placeholder: 'gzip', size: 16, suggest: () => ['gzip', 'br', 'zstd', 'deflate', 'identity'] },
    { field: 'contentLanguage', label: 'Content-Language', placeholder: 'en', size: 14, suggest: () => LANGUAGES.map(([value, hint]) => ({ value, hint })) },
    { field: 'expires', label: 'Expires', placeholder: 'Wed, 21 Oct 2026 07:28:00 GMT', size: 28,
      suggest: () => [{ value: new Date(Date.now() + 86400000).toUTCString(), hint: 'In 1 day' }, { value: new Date(Date.now() + 30 * 86400000).toUTCString(), hint: 'In 30 days' }] }
  ];

  const byteLength = text => new TextEncoder().encode(String(text)).length;
  const metadataBytes = entries => entries.reduce((total, entry) => total + byteLength(entry.key) + byteLength(entry.value), 0);

  // ---------------------------------------------------------------------------------------------------------------
  // Rules of S3 for the metadata (the server checks them again)
  // ---------------------------------------------------------------------------------------------------------------

  function checkText(label, value) {
    if (!PRINTABLE.test(value)) return `${label} has ASCII letters, digits, spaces and punctuation only.`;
    if (value !== value.trim()) return `${label} has no space at the start or at the end.`;
    return '';
  }

  function checkHeaders(headers) {
    for (const { field, label } of HEADERS) {
      const value = headers[field] || '';
      if (!value) continue;
      const error = checkText(label, value);
      if (error) return error;
    }
    if (headers.contentType && !headers.contentType.includes('/')) return 'Content-Type is a media type such as text/plain.';
    if (headers.expires && new Date(headers.expires).toUTCString() !== headers.expires) return `Expires is an HTTP date such as ${new Date(Date.UTC(2026, 9, 21, 7, 28)).toUTCString()}.`;
    return '';
  }

  function checkEntry(entry, others) {
    if (!entry.key) return 'A metadata needs a key.';
    if (!KEY_PATTERN.test(entry.key)) return 'A key has lowercase letters, digits, ".", "_" and "-" only, and starts with a letter or a digit.';
    if (!entry.value) return `The metadata ${entry.key} needs a value.`;
    const error = checkText(`The value of ${entry.key}`, entry.value);
    if (error) return error;
    if (others.some(other => other.key === entry.key)) return `The key ${entry.key} is already in the list.`;
    return '';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // What the save does, in plain words, before the save
  // ---------------------------------------------------------------------------------------------------------------

  function saveNotes(state, { version, versioning }) {
    const notes = ['The modification date changes to the date of the save.'];
    if (version) notes.push('This version becomes the current version, as a restore does. The other versions stay.');
    else if (versioning) notes.push('A new version is created. The current version stays in the list of versions.');
    if (state.multipartETag) notes.push('The ETag can change: the object was uploaded in parts.');
    else if (state.copyInParts) notes.push('The ETag changes: Stowr copies an object of this size in parts.');
    return notes;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Metadata section of the file details
  // ---------------------------------------------------------------------------------------------------------------

  // onUnsupported runs when the provider has no edit: the section goes, and the details show the values of their own
  // read. onSaved gets the new state after a save.
  async function mountEditor(host, { key, instance = null, version = '', canWrite = false, versioning = false, onUnsupported = null, onSaved = null }) {
    const editButton = h('button', { type: 'button', class: 'iconButton detailsEditButton', 'data-metadata-edit': '', title: 'Edit the metadata', 'aria-label': 'Edit the metadata', 'aria-pressed': 'false', hidden: true }, icon('pencil-outline'));
    const body = h('div', { class: 'metaEditor' }, h('span', { class: 'metaEditor__state' }, 'Loading the metadata…'));
    host.replaceChildren(h('div', { class: 'bb-details-section-title' }, icon('file-code-outline'), ' Metadata', editButton), body);
    const name = String(key).split('/').pop() || String(key);

    let saved;
    try {
      saved = await BB.api.metadata(key, { instance, version });
    } catch (error) {
      if (error?.status === 501 || error?.code === 'metadata_unsupported') {
        host.remove();
        if (onUnsupported) onUnsupported();
        return;
      }
      body.replaceChildren(h('span', { class: 'metaEditor__state' }, error?.status === 403 ? 'You cannot read the metadata of this object.' : `The metadata cannot be loaded: ${error?.message || error}`));
      return;
    }

    let editing = false;
    let draft = null;
    const copyState = state => ({ headers: { ...(state.headers || {}) }, metadata: (state.metadata || []).map(entry => ({ ...entry })) });
    // The text of a state with the headers in a fixed order and the metadata sorted: two equal states give one text.
    const canonical = state => JSON.stringify([HEADERS.map(({ field }) => state.headers?.[field] || ''),
      (state.metadata || []).map(entry => [entry.key, entry.value]).sort((left, right) => left[0].localeCompare(right[0]))]);
    const dirty = () => editing && canonical(draft) !== canonical(saved);

    const view = h('div', { class: 'bb-kv metaEditor__view' });
    const form = h('div', { class: 'metaEditor__form' });
    const notes = h('ul', { class: 'metaEditor__notes' });
    const message = h('p', { class: 'metaEditor__message', role: 'status' });
    const saveButton = h('button', { type: 'button', class: 'bb-btn', 'data-metadata-save': '' }, icon('check'), h('span', {}, 'Save metadata'));
    const revertButton = h('button', { type: 'button', class: 'bb-btn', 'data-metadata-revert': '' }, h('span', {}, 'Revert'));
    const actions = h('div', { class: 'metaEditor__actions' }, saveButton, revertButton);
    const say = (text, tone = '') => { message.textContent = text; message.dataset.tone = tone; };

    const row = (label, value, caption = false) => h('div', { class: 'kv-row' }, h('div', { class: 'kv-k' }, label), h('div', { class: ['kv-v', !caption && 'mono'] }, value));

    function renderView() {
      const rows = HEADERS.filter(({ field }) => saved.headers?.[field]).map(({ field, label }) => row(label, saved.headers[field]));
      const entries = saved.metadata || [];
      if (entries.length) rows.push(h('div', { class: 'metaEditor__caption' }, 'User metadata'), ...entries.map(entry => row(entry.key, entry.value)));
      view.replaceChildren(...(rows.length ? rows : [h('span', { class: 'metaEditor__state' }, 'No metadata.')]));
    }

    function headerRow({ field, label, placeholder, size, suggest }) {
      const input = h('input', { type: 'text', class: 'input mono', placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': label, 'data-metadata-header': field });
      input.value = draft.headers[field] || '';
      input.addEventListener('input', () => {
        if (input.value) draft.headers[field] = input.value; else delete draft.headers[field];
        say('');
        renderState();
      });
      return h('label', { class: 'metaEditor__field', style: `--field-size: ${size}ch` }, h('span', {}, label), BB.suggest.field(input, { values: () => suggest(name) }));
    }

    function entryRow(entry) {
      const value = h('input', { type: 'text', class: 'input mono', 'aria-label': `Value of ${entry.key}`, 'data-metadata-value': entry.key, autocomplete: 'off', spellcheck: 'false' });
      value.value = entry.value;
      value.addEventListener('input', () => { entry.value = value.value; say(''); renderState(); });
      const remove = h('button', { type: 'button', class: 'iconButton', title: `Remove ${entry.key}`, 'aria-label': `Remove the metadata ${entry.key}`, 'data-metadata-remove': entry.key }, icon('close'));
      remove.addEventListener('click', () => { draft.metadata = draft.metadata.filter(item => item !== entry); say(''); renderForm(); });
      return h('div', { class: 'metaEditor__entry' }, h('span', { class: 'metaEditor__key mono' }, entry.key), value, remove);
    }

    const keyInput = h('input', { type: 'text', class: 'input mono', placeholder: 'Key', 'aria-label': 'Metadata key', autocomplete: 'off', spellcheck: 'false' });
    const valueInput = h('input', { type: 'text', class: 'input mono', placeholder: 'Value', 'aria-label': 'Metadata value', autocomplete: 'off', spellcheck: 'false' });
    const addButton = h('button', { type: 'button', class: 'bb-btn', 'data-metadata-add': '' }, icon('plus'), h('span', {}, 'Add'));
    const count = h('span', { class: 'metaEditor__count' });
    const addRow = h('div', { class: 'metaEditor__add' }, keyInput, valueInput, addButton);
    // S3 keeps the keys of the user metadata in lowercase: the field does the same.
    keyInput.addEventListener('input', () => { keyInput.value = keyInput.value.toLowerCase(); });

    function add() {
      const entry = { key: keyInput.value.trim(), value: valueInput.value.trim() };
      if (!entry.key && !entry.value) return;
      const error = checkEntry(entry, draft.metadata);
      if (error) { say(error, 'error'); return; }
      if (metadataBytes([...draft.metadata, entry]) > (saved.maxMetadataBytes || MAX_BYTES)) { say(`The user metadata has at most ${saved.maxMetadataBytes || MAX_BYTES} bytes.`, 'error'); return; }
      draft.metadata = [...draft.metadata, entry].sort((left, right) => left.key.localeCompare(right.key));
      keyInput.value = '';
      valueInput.value = '';
      say('');
      renderForm();
      keyInput.focus();
    }
    addButton.addEventListener('click', add);
    for (const input of [keyInput, valueInput]) {
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    }

    // The parts of the form that follow each change: the count, the notes and the buttons.
    function renderState() {
      const limit = saved.maxMetadataBytes || MAX_BYTES;
      count.textContent = `${metadataBytes(draft.metadata).toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} bytes`;
      saveButton.disabled = !dirty();
      revertButton.disabled = !dirty();
    }

    function renderForm() {
      form.replaceChildren(
        h('div', { class: 'metaEditor__fields' }, ...HEADERS.map(headerRow)),
        h('div', { class: 'metaEditor__caption' }, 'User metadata', count),
        h('div', { class: 'metaEditor__entries' }, ...draft.metadata.map(entryRow)),
        addRow
      );
      renderState();
    }

    function render() {
      editButton.hidden = !canWrite || BB.cfg?.metadataEditSupported === false;
      editButton.setAttribute('aria-pressed', String(editing));
      editButton.classList.toggle('is-open', editing);
      view.hidden = editing;
      form.hidden = !editing;
      actions.hidden = !editing;
      notes.hidden = !editing;
      notes.replaceChildren(...saveNotes(saved, { version, versioning }).map(text => h('li', {}, icon('information-outline'), text)));
      renderView();
      if (editing) renderForm();
    }

    function startEdit() {
      editing = true;
      draft = copyState(saved);
      render();
    }

    function stopEdit() {
      editing = false;
      draft = null;
      render();
    }

    async function reload() {
      saved = await BB.api.metadata(key, { instance, version });
      draft = copyState(saved);
    }

    editButton.addEventListener('click', () => {
      say('');
      if (editing) stopEdit(); else startEdit();
    });
    revertButton.addEventListener('click', () => { draft = copyState(saved); say(''); renderForm(); });
    saveButton.addEventListener('click', async () => {
      const error = checkHeaders(draft.headers) || draft.metadata.map((entry, index) => checkEntry(entry, draft.metadata.slice(0, index))).find(Boolean) || '';
      if (error) { say(error, 'error'); return; }
      saveButton.disabled = true;
      revertButton.disabled = true;
      say('Saving…');
      try {
        const response = await BB.api.putMetadata(key, { etag: saved.etag, lastModified: saved.lastModified || '', headers: draft.headers, metadata: draft.metadata, version, instance });
        saved = response;
        stopEdit();
        say('The metadata is saved.', 'ok');
        document.dispatchEvent(new CustomEvent('bb:metadata-changed', { detail: { key } }));
        if (onSaved) onSaved(response);
      } catch (failure) {
        if (failure?.code === 'object_changed') {
          // The object changed after the form read it: the form shows the new values, and the person edits again.
          try { await reload(); } catch (_) {}
          render();
          say('The object changed after the form read it. The form now shows the new values: make your change again.', 'error');
          return;
        }
        if (failure?.status === 501) {
          canWrite = false;
          stopEdit();
          say('This storage provider does not let Stowr change the metadata.', 'error');
          return;
        }
        say(failure?.status === 403 ? 'You cannot change the metadata of this object.' : `The metadata is not saved: ${failure?.message || failure}`, 'error');
        renderState();
      }
    });

    body.replaceChildren(view, form, actions, message, notes);
    render();
  }

  BB.metadata = { mountEditor, saveNotes, checkHeaders, checkEntry };
})();
