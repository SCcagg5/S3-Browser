/*
 * BB.tags: the object tags of the interface.
 * - the tags section of the file details (read; with the frameless "Edit" button: add, remove, save), with the lifecycle
 *   rules that apply. The metadata section (metadata.js) has the same look;
 * - the form that changes the tags of every object under a folder;
 * - the tags of the next uploads;
 * - the helpers of the tag column and of the tag filter of the listing.
 * The server checks each request again. A provider without tags answers 501: the controls disappear.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const MAX_TAGS = 10;
  const KEY_MAX = 128;
  const VALUE_MAX = 256;
  const ALLOWED = /^[\p{L}\p{N}\p{Zs}+\-=._:/@]*$/u;
  const UPLOAD_STORAGE = 'stowr.uploadTags';

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

  // ---------------------------------------------------------------------------------------------------------------
  // Rules of S3 for a tag
  // ---------------------------------------------------------------------------------------------------------------

  function checkTag(tag, others) {
    const key = String(tag.key ?? '');
    const value = String(tag.value ?? '');
    if (!key.length) return 'A tag needs a key.';
    if ([...key].length > KEY_MAX) return `A key has at most ${KEY_MAX} characters.`;
    if ([...value].length > VALUE_MAX) return `A value has at most ${VALUE_MAX} characters.`;
    if (key.toLowerCase().startsWith('aws:')) return 'The prefix aws: is reserved.';
    if (!ALLOWED.test(key) || !ALLOWED.test(value)) return 'A tag has letters, digits, spaces and + - = . _ : / @ only.';
    if (others.some(other => other.key === key)) return `The key ${key} is already in the list.`;
    return '';
  }

  // "a=b, c=d" or one tag for each line. A word without "=" is a key with an empty value.
  function parseTagText(text) {
    const tags = [];
    for (const part of String(text || '').split(/[\n,]/)) {
      const item = part.trim();
      if (!item) continue;
      const equals = item.indexOf('=');
      const tag = equals < 0 ? { key: item, value: '' } : { key: item.slice(0, equals).trim(), value: item.slice(equals + 1).trim() };
      const error = checkTag(tag, tags);
      if (error) return { tags, error };
      tags.push(tag);
    }
    if (tags.length > MAX_TAGS) return { tags, error: `An object has at most ${MAX_TAGS} tags.` };
    return { tags, error: '' };
  }

  function parseKeyList(text) {
    return String(text || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  }

  const formatTag = tag => (tag.value === '' ? tag.key : `${tag.key}=${tag.value}`);

  // The colour of a tag: one of 18 slots, from the key (FNV-1a), as ClickHouse Dash does for a service. The same key has
  // the same colour on every page and in every browser.
  function slotOf(key) {
    let hash = 0x811c9dc5;
    const text = String(key || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash % 18) + 1;
  }

  // A filter is words that must all match: "key" keeps the objects that have this key, "key=value" the objects that
  // have this tag. A value with spaces has quotes: key="a b".
  function filterTerms(filter) {
    const words = String(filter || '').match(/(?:[^\s"]|"[^"]*")+/g) || [];
    return words.map(word => {
      const equals = word.indexOf('=');
      const unquote = text => text.replace(/^"(.*)"$/s, '$1');
      return equals < 0 ? { key: unquote(word), value: null, text: word } : { key: unquote(word.slice(0, equals)), value: unquote(word.slice(equals + 1)), text: word };
    });
  }

  function matchesFilter(tags, filter) {
    return filterTerms(filter).every(term => tags.some(tag => tag.key === term.key && (term.value === null || tag.value === term.value)));
  }

  // The word of the filter for a tag: key=value, with quotes when the value has spaces. A tag with no value is the key.
  function filterWord(tag) {
    if (tag.value === '') return /[\s"]/.test(tag.key) ? `"${tag.key}"` : tag.key;
    const value = /[\s"]/.test(tag.value) ? `"${tag.value.replace(/"/g, '')}"` : tag.value;
    return `${/[\s"=]/.test(tag.key) ? `"${tag.key.replace(/"/g, '')}"` : tag.key}=${value}`;
  }

  function isActive(tag, filter) {
    return filterTerms(filter).some(term => term.key === tag.key && (term.value === null ? tag.value === '' : term.value === tag.value));
  }

  // The filter after a click on a tag. A click gives this tag only, and a second click clears it. With `add` the tag
  // joins the other words of the filter, or leaves them.
  function toggleFilterWord(filter, tag, add = false) {
    const word = filterWord(tag);
    const words = filterTerms(filter).map(term => term.text);
    const index = words.indexOf(word);
    if (add) {
      if (index >= 0) words.splice(index, 1); else words.push(word);
      return words.join(' ');
    }
    return words.length === 1 && index === 0 ? '' : word;
  }

  // The badges of some tags. onPick makes each badge a button, onRemove adds a button that removes the tag.
  function chips(tags, { onRemove = null, onPick = null, filter = '' } = {}) {
    return tags.map(tag => {
      const body = [h('i', { class: 'tagSwatch', 'aria-hidden': 'true' }), h('span', { class: 'tagChip__key' }, tag.key),
        tag.value === '' ? null : h('span', { class: 'tagChip__value' }, tag.value)];
      const label = formatTag(tag);
      return h('span', { class: ['tagChip', onPick && isActive(tag, filter) && 'is-active'], style: `--tag-color: var(--tag-color-${slotOf(tag.key)})`, 'data-tag': filterWord(tag), title: onPick ? `Filter by ${label}` : label },
        onPick
          ? h('button', { type: 'button', class: 'tagChip__pick', 'aria-label': `Filter by the tag ${label}`, onclick: event => onPick(tag, event) }, body)
          : body,
        onRemove ? h('button', { type: 'button', class: 'tagChip__remove', 'aria-label': `Remove the tag ${tag.key}`, onclick: () => onRemove(tag) }, icon('close')) : null);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lifecycle rules (the effect on an object; the editor is in lifecycle.js)
  // ---------------------------------------------------------------------------------------------------------------

  const lifecycleCache = new Map();
  // A save of the lifecycle editor (lifecycle.js) changes the rules: the next details read them again.
  document.addEventListener('bb:lifecycle-changed', () => lifecycleCache.clear());

  // The rules of the bucket, or null when the provider gives none. The answer stays for the page.
  function lifecycleRules(instance) {
    const id = String(instance || '');
    if (!lifecycleCache.has(id)) {
      lifecycleCache.set(id, BB.api.lifecycle(instance).then(response => response.rules || []).catch(() => null));
    }
    return lifecycleCache.get(id);
  }

  function dayCount(days) {
    return `${Number(days).toLocaleString('en-US')} day${Number(days) === 1 ? '' : 's'}`;
  }

  // What the enabled rules do to an object with these tags. The first rules that match the prefix, the tags and the
  // size come first. Each note is a sentence for the person.
  function lifecycleNotes(rules, { fullKey, size, tags }) {
    const notes = [];
    for (const rule of rules || []) {
      if (!rule.enabled) continue;
      if (rule.prefix && !fullKey.startsWith(rule.prefix)) continue;
      if ((rule.tags || []).some(required => !tags.some(tag => tag.key === required.key && tag.value === required.value))) continue;
      if (rule.sizeGreaterThan && !(size > rule.sizeGreaterThan)) continue;
      if (rule.sizeLessThan && !(size < rule.sizeLessThan)) continue;
      const actions = [];
      if (rule.expirationDays) actions.push(`expires ${dayCount(rule.expirationDays)} after its creation`);
      if (rule.expirationDate) actions.push(`expires on ${String(rule.expirationDate).slice(0, 10)}`);
      for (const transition of rule.transitions || []) {
        const when = transition.days ? `${dayCount(transition.days)} after its creation` : `on ${String(transition.date).slice(0, 10)}`;
        actions.push(`moves to ${transition.storageClass || 'another storage class'} ${when}`);
      }
      if (!actions.length) continue;
      const scope = [rule.prefix ? `prefix ${rule.prefix}` : '', ...(rule.tags || []).map(tag => `tag ${formatTag(tag)}`)].filter(Boolean).join(', ');
      notes.push(`Rule ${rule.id || '(no name)'}${scope ? ` (${scope})` : ''}: the object ${actions.join(' and ')}.`);
    }
    return notes;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tags section of the file details
  // ---------------------------------------------------------------------------------------------------------------

  // onState gets the saved tags after the read and after each save (the summary of the details counts them).
  async function mountEditor(host, { key, size = 0, instance = null, version = '', canWrite = false, rootPrefix = '', onState = null }) {
    const editButton = h('button', { type: 'button', class: 'iconButton detailsEditButton', 'data-tag-edit': '', title: 'Edit the tags', 'aria-label': 'Edit the tags', 'aria-pressed': 'false', hidden: true }, icon('pencil-outline'));
    const body = h('div', { class: 'tagEditor' }, h('span', { class: 'tagEditor__state' }, 'Loading the tags…'));
    host.replaceChildren(h('div', { class: 'bb-details-section-title' }, icon('tag-multiple-outline'), ' Tags', editButton), body);
    let saved;
    let limit = MAX_TAGS;
    try {
      const response = await BB.api.tags(key, { instance, version });
      saved = response.tags || [];
      limit = Number(response.maxTags) || MAX_TAGS;
      if (onState) onState(saved);
    } catch (error) {
      if (error?.status === 501 || error?.code === 'tagging_unsupported') {
        host.remove();
        return;
      }
      body.replaceChildren(h('span', { class: 'tagEditor__state' }, error?.status === 403 ? 'You cannot read the tags of this object.' : `The tags cannot be loaded: ${error?.message || error}`));
      return;
    }
    const rules = await lifecycleRules(instance);
    let draft = saved.map(tag => ({ ...tag }));
    const editable = canWrite && !version;
    let editing = false;

    const list = h('div', { class: 'tagEditor__list', 'aria-live': 'polite' });
    const notes = h('ul', { class: 'tagEditor__notes' });
    const message = h('p', { class: 'tagEditor__message', role: 'status' });
    const keyInput = h('input', { type: 'text', class: 'input', placeholder: 'Key', 'aria-label': 'Tag key', maxlength: KEY_MAX, autocomplete: 'off' });
    const valueInput = h('input', { type: 'text', class: 'input', placeholder: 'Value', 'aria-label': 'Tag value', maxlength: VALUE_MAX, autocomplete: 'off' });
    const addButton = h('button', { type: 'button', class: 'bb-btn', 'data-tag-add': '' }, icon('plus'), h('span', {}, 'Add'));
    const saveButton = h('button', { type: 'button', class: 'bb-btn', 'data-tag-save': '' }, icon('check'), h('span', {}, 'Save tags'));
    const revertButton = h('button', { type: 'button', class: 'bb-btn', 'data-tag-revert': '' }, h('span', {}, 'Revert'));
    const form = h('div', { class: 'tagEditor__form' }, keyInput, valueInput, addButton);
    const actions = h('div', { class: 'tagEditor__actions' }, saveButton, revertButton);

    const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
    const say = (text, tone = '') => { message.textContent = text; message.dataset.tone = tone; };

    function render() {
      list.replaceChildren(...(draft.length
        ? chips(draft, { onRemove: editing ? tag => { draft = draft.filter(item => item.key !== tag.key); say(''); render(); } : null })
        : [h('span', { class: 'tagEditor__state' }, 'No tag.')]));
      const evaluated = lifecycleNotes(rules, { fullKey: `${rootPrefix}${key}`, size, tags: draft });
      notes.replaceChildren(...evaluated.map(text => h('li', {}, icon('clock-outline'), text)));
      notes.hidden = !evaluated.length;
      saveButton.disabled = !dirty();
      revertButton.disabled = !dirty();
      addButton.disabled = draft.length >= limit;
      editButton.hidden = !editable;
      editButton.setAttribute('aria-pressed', String(editing));
      editButton.classList.toggle('is-open', editing);
      form.hidden = !editing;
      actions.hidden = !editing;
      if (editing) {
        const count = h('span', { class: 'tagEditor__count' }, `${draft.length} of ${limit}`);
        form.querySelector('.tagEditor__count')?.remove();
        form.append(count);
      }
    }

    function add() {
      const tag = { key: keyInput.value.trim(), value: valueInput.value.trim() };
      if (!tag.key && !tag.value) return;
      const error = checkTag(tag, draft);
      if (error) { say(error, 'error'); return; }
      if (draft.length >= limit) { say(`An object has at most ${limit} tags.`, 'error'); return; }
      draft = [...draft, tag].sort((left, right) => left.key.localeCompare(right.key));
      keyInput.value = '';
      valueInput.value = '';
      say('');
      render();
      keyInput.focus();
    }

    // The button opens the form. A second click closes it and drops the changes that are not saved.
    editButton.addEventListener('click', () => {
      editing = !editing;
      draft = saved.map(tag => ({ ...tag }));
      say('');
      render();
      if (editing) keyInput.focus();
    });
    addButton.addEventListener('click', add);
    for (const input of [keyInput, valueInput]) {
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    }
    revertButton.addEventListener('click', () => { draft = saved.map(tag => ({ ...tag })); say(''); render(); });
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      say('Saving…');
      try {
        const response = await BB.api.putTags(key, draft, { instance, version });
        saved = response.tags || [];
        draft = saved.map(tag => ({ ...tag }));
        editing = false;
        say('The tags are saved.', 'ok');
        if (onState) onState(saved);
        document.dispatchEvent(new CustomEvent('bb:tags-changed', { detail: { key } }));
      } catch (error) {
        say(error?.status === 403 ? 'You cannot change the tags of this object.' : `The tags are not saved: ${error?.message || error}`, 'error');
      }
      render();
    });

    body.replaceChildren(list, form, actions, message, notes);
    render();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Forms
  // ---------------------------------------------------------------------------------------------------------------

  // Opens a form in a dialog. onSubmit gets the parsed fields and returns an error text, or '' to close the dialog.
  function openForm({ title, intro, fields, applyLabel, onSubmit }) {
    return new Promise(resolve => {
      let result = null;
      BB.ui.alert({
        title,
        html: '<div class="tagForm" data-tag-form></div>',
        onOpen: ({ overlay }) => {
          const root = overlay.querySelector('[data-tag-form]');
          const message = h('p', { class: 'tagEditor__message', role: 'alert' });
          const inputs = {};
          const rows = fields.map(field => {
            const input = field.multiline
              ? h('textarea', { class: 'input tagForm__text', rows: 3, placeholder: field.placeholder || '', 'aria-label': field.label })
              : h('input', { type: 'text', class: 'input', placeholder: field.placeholder || '', 'aria-label': field.label });
            input.value = field.value || '';
            inputs[field.name] = input;
            return h('label', { class: 'tagForm__field' }, h('span', {}, field.label), input, field.hint ? h('small', {}, field.hint) : null);
          });
          const apply = h('button', { type: 'button', class: 'bb-btn bb-btn-primary' }, applyLabel);
          apply.addEventListener('click', async () => {
            apply.disabled = true;
            const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
            let error = '';
            try { error = (await onSubmit(values)) || ''; } catch (failure) { error = String(failure?.message || failure); }
            if (error) { message.textContent = error; apply.disabled = false; return; }
            result = true;
            overlay.querySelector('.bb-modal-x')?.click();
          });
          root.replaceChildren(intro ? h('p', { class: 'tagForm__intro' }, intro) : null, ...rows, message, h('div', { class: 'tagEditor__actions' }, apply));
          Object.values(inputs)[0]?.focus();
        }
      }).then(() => resolve(result === true));
    });
  }

  // The tags of every object under a folder.
  async function changeFolderTags({ prefix, instance, start }) {
    let started = null;
    const done = await openForm({
      title: prefix ? 'Tag this folder' : 'Tag this bucket',
      intro: `This changes the tags of every object ${prefix ? `under ${prefix}` : 'in the bucket'}. Each object keeps its other tags.`,
      applyLabel: 'Apply to all objects',
      fields: [
        { name: 'add', label: 'Tags to set', placeholder: 'team=data, retention=30d', hint: 'A key that exists gets the new value.', multiline: true },
        { name: 'remove', label: 'Tags to remove', placeholder: 'old, draft', hint: 'The keys, separated by commas.' }
      ],
      async onSubmit(values) {
        const parsed = parseTagText(values.add);
        if (parsed.error) return parsed.error;
        const remove = parseKeyList(values.remove);
        if (!parsed.tags.length && !remove.length) return 'Give a tag to set or a key to remove.';
        started = { add: parsed.tags, remove };
        return '';
      }
    });
    if (!done || !started) return false;
    return start(started);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tags of the next uploads
  // ---------------------------------------------------------------------------------------------------------------

  let uploadTags = [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(UPLOAD_STORAGE) || '[]');
    if (Array.isArray(stored)) uploadTags = stored.filter(tag => tag && typeof tag.key === 'string' && typeof tag.value === 'string').slice(0, MAX_TAGS);
  } catch (_) {}
  const uploadListeners = new Set();

  function setUploadTags(tags) {
    uploadTags = tags.slice(0, MAX_TAGS);
    try { window.localStorage.setItem(UPLOAD_STORAGE, JSON.stringify(uploadTags)); } catch (_) {}
    uploadListeners.forEach(listener => listener(uploadTags));
  }

  // An instance without tags (Garage) would drop the tags of an upload without a word: the page sends none.
  const instanceKeepsTags = () => BB.cfg?.tagsSupported !== false;

  // The header X-Amz-Tagging of a direct upload: the tags as a query string.
  function uploadTagsHeader() {
    return uploadTags.length && instanceKeepsTags() ? uploadTags.map(tag => `${encodeURIComponent(tag.key)}=${encodeURIComponent(tag.value)}`).join('&') : '';
  }

  // The text of the tags of the new uploads, from the settings. It returns an error text, or '' when the tags are saved.
  function saveUploadTagsText(text) {
    const parsed = parseTagText(text);
    if (parsed.error) return parsed.error;
    setUploadTags(parsed.tags);
    return '';
  }

  BB.tags = {
    MAX_TAGS,
    checkTag,
    parseTagText,
    formatTag,
    matchesFilter,
    toggleFilterWord,
    isActive,
    filterWord,
    slotOf,
    chips,
    lifecycleRules,
    lifecycleNotes,
    mountEditor,
    changeFolderTags,
    saveUploadTagsText,
    uploadTags: () => uploadTags.map(tag => ({ ...tag })),
    uploadTagsToSend: () => (instanceKeepsTags() ? uploadTags.map(tag => ({ ...tag })) : []),
    uploadTagsText: () => uploadTags.map(formatTag).join(', '),
    uploadTagsHeader,
    onUploadTagsChange(listener) { uploadListeners.add(listener); return () => uploadListeners.delete(listener); }
  };
})();
