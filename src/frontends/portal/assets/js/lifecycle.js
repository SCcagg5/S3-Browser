/*
 * BB.lifecycle: the window "Lifecycle rules" of the Actions menu.
 * - the rules of the bucket: a form for each rule that the editor knows, and a read-only row with the note "Kept as is"
 *   for each other rule (transitions, size filters and so on), which the server writes back byte for byte;
 * - Add a rule, Save and Revert. Before the save, a confirmation names each action that deletes data, with its prefix
 *   and its number of days;
 * - the window offers only the fields that the storage provider keeps. The server decides them and gives the reason
 *   for each other field. After the save, the server reads the rules again and tells what the provider changed.
 * The window of the incomplete uploads (multiparts.js) opens this window with a new rule that aborts them.
 * The server checks each request again. A provider without lifecycle rules answers 501: the menu hides the item.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const MAX_ID = 255;
  const MAX_PREFIX_BYTES = 1024;

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
  const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const count = value => Number(value || 0).toLocaleString('en-US');
  const dayCount = value => `${count(value)} day${Number(value) === 1 ? '' : 's'}`;
  const byteLength = text => new TextEncoder().encode(String(text)).length;
  const formatTag = tag => (BB.tags?.formatTag ? BB.tags.formatTag(tag) : (tag.value === '' ? tag.key : `${tag.key}=${tag.value}`));

  // The names of the fields that a provider can drop, as the server names them.
  const FIELD_LABELS = {
    tagFilter: 'Tag filter',
    noncurrentExpiration: 'Delete noncurrent versions',
    abortMultipart: 'Abort incomplete multipart uploads',
    expiredDeleteMarker: 'Remove expired delete markers'
  };

  // ---------------------------------------------------------------------------------------------------------------
  // The rules in plain words
  // ---------------------------------------------------------------------------------------------------------------

  // The objects of a rule of the editor: "under logs/", "under logs/ with the tag k=v". The prefix is relative to the
  // root prefix of the instance.
  function scopeText(rule, rootPrefix = '') {
    const where = rule.prefix ? `under ${rule.prefix}` : rootPrefix ? 'in all the folders of this instance' : 'in the whole bucket';
    return rule.tag ? `${where} with the tag ${formatTag(rule.tag)}` : where;
  }

  // The sentences of the confirmation: each action of the rule that deletes data, with its prefix and its days.
  function destructiveActions(rule, rootPrefix = '') {
    if (!rule.enabled) return [];
    const scope = scopeText(rule, rootPrefix);
    const sentences = [];
    if (rule.expirationDays) sentences.push(`Objects ${scope} older than ${dayCount(rule.expirationDays)} will be deleted.`);
    if (rule.noncurrentDays) sentences.push(`Noncurrent versions ${scope} will be deleted ${dayCount(rule.noncurrentDays)} after they become noncurrent.`);
    if (rule.abortMultipartDays) sentences.push(`Incomplete multipart uploads ${scope} older than ${dayCount(rule.abortMultipartDays)} will be aborted, and their parts deleted.`);
    if (rule.expiredDeleteMarker) sentences.push(`Expired delete markers ${scope} will be removed.`);
    return sentences;
  }

  // What a rule of the bucket does, from the rules of GET /api/lifecycle (the prefix starts at the bucket root).
  function describeRule(rule) {
    const scope = [rule.prefix ? `prefix ${rule.prefix}` : 'the whole bucket', ...(rule.tags || []).map(tag => `tag ${formatTag(tag)}`)];
    if (rule.sizeGreaterThan) scope.push(`larger than ${count(rule.sizeGreaterThan)} bytes`);
    if (rule.sizeLessThan) scope.push(`smaller than ${count(rule.sizeLessThan)} bytes`);
    const actions = [];
    if (rule.expirationDays) actions.push(`deletes the objects ${dayCount(rule.expirationDays)} after their creation`);
    if (rule.expirationDate) actions.push(`deletes the objects on ${String(rule.expirationDate).slice(0, 10)}`);
    for (const transition of rule.transitions || []) {
      const when = transition.days ? `${dayCount(transition.days)} after their creation` : `on ${String(transition.date).slice(0, 10)}`;
      actions.push(`moves the objects to ${transition.storageClass || 'another storage class'} ${when}`);
    }
    if (rule.noncurrentExpirationDays) actions.push(`deletes the noncurrent versions ${dayCount(rule.noncurrentExpirationDays)} after they become noncurrent`);
    if (rule.abortIncompleteMultipartDays) actions.push(`aborts the incomplete uploads ${dayCount(rule.abortIncompleteMultipartDays)} after their start`);
    if (rule.expiredObjectDeleteMarker) actions.push('removes the expired delete markers');
    return `${scope.join(', ')}: ${actions.length ? actions.join(', ') : 'no action that S3-Browser knows'}.`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Checks of the page (the server checks the rules again)
  // ---------------------------------------------------------------------------------------------------------------

  // The tag filter of the form: "key=value", or empty for no tag.
  function parseTagField(text) {
    const value = String(text || '').trim();
    if (!value) return { tag: null, error: '' };
    const parsed = BB.tags.parseTagText(value);
    if (parsed.error) return { tag: null, error: parsed.error };
    if (parsed.tags.length !== 1) return { tag: null, error: 'A rule has one tag in its filter.' };
    return { tag: parsed.tags[0], error: '' };
  }

  // The error of the first rule that S3 or the editor refuses, or ''.
  function checkRules(rules, keptIds, maxDays) {
    const seen = new Set(keptIds);
    for (const rule of rules) {
      const name = rule.id ? `The rule ${rule.id}` : 'A rule';
      if (!rule.id.trim()) return 'Each rule needs an ID.';
      if (rule.id !== rule.id.trim()) return `${name} has a space at the start or at the end of its ID.`;
      if ([...rule.id].length > MAX_ID) return `An ID has at most ${MAX_ID} characters.`;
      if (seen.has(rule.id)) return `The ID ${rule.id} is on more than one rule.`;
      seen.add(rule.id);
      if (byteLength(rule.prefix) > MAX_PREFIX_BYTES) return `${name} has a prefix of more than ${MAX_PREFIX_BYTES} bytes.`;
      if (rule.tagError) return `${name}: ${rule.tagError}`;
      for (const [value, what] of [[rule.expirationDays, 'the expiration'], [rule.noncurrentDays, 'the noncurrent versions'], [rule.abortMultipartDays, 'the incomplete uploads']]) {
        if (value !== 0 && !(Number.isInteger(value) && value >= 1 && value <= maxDays)) return `${name}: the days of ${what} are a whole number from 1 to ${count(maxDays)}.`;
      }
      if (!rule.expirationDays && !rule.noncurrentDays && !rule.abortMultipartDays && !rule.expiredDeleteMarker) return `${name} has no action: choose at least one.`;
      if (rule.expirationDays && rule.expiredDeleteMarker) return `${name} cannot delete the objects after a number of days and remove the expired delete markers: use two rules.`;
      if (rule.tag && (rule.abortMultipartDays || rule.expiredDeleteMarker)) return `${name} has a tag filter: S3 does not let such a rule abort incomplete uploads or remove delete markers.`;
    }
    return '';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The window
  // ---------------------------------------------------------------------------------------------------------------

  const ACTIONS = [
    { name: 'expiration', property: 'expirationDays', before: 'Delete the objects', after: 'days after their creation' },
    { name: 'noncurrent', property: 'noncurrentDays', field: 'noncurrentExpiration', before: 'Delete the noncurrent versions', after: 'days after they become noncurrent' },
    { name: 'abort', property: 'abortMultipartDays', field: 'abortMultipart', before: 'Abort the incomplete multipart uploads', after: 'days after their start' }
  ];
  const DEFAULT_DAYS = { expirationDays: 30, noncurrentDays: 30, abortMultipartDays: 7 };

  // prefix is the folder of the listing: a new rule starts with it. prefill adds a new rule with these values.
  function mount(host, { instance = null, canWrite = false, prefix = '', prefill = null }) {
    let editor = null;
    let rules = [];
    let entries = [];
    let busy = false;
    let serial = 0;
    let pendingPrefill = prefill;

    const intro = h('p', { class: 'lifecycle__intro' });
    const providerNote = h('p', { class: 'lifecycle__note', 'data-lifecycle-provider-note': '' });
    const readonly = h('p', { class: 'lifecycle__readonly', 'data-lifecycle-readonly': '' });
    const hidden = h('ul', { class: 'lifecycle__hidden', 'data-lifecycle-hidden': '' });
    const state = h('p', { class: 'lifecycle__state' }, 'Loading the lifecycle rules…');
    const list = h('div', { class: 'lifecycle__rules', 'data-lifecycle-rules': '' });
    const addButton = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-add': '' }, icon('plus'), h('span', {}, 'Add a rule'));
    const saveButton = h('button', { type: 'button', class: 'bb-btn bb-btn-primary', 'data-lifecycle-save': '' }, icon('check'), h('span', {}, 'Save'));
    const revertButton = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-revert': '' }, h('span', {}, 'Revert'));
    const reloadButton = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-reload': '' }, icon('refresh'), h('span', {}, 'Reload the rules'));
    const actions = h('div', { class: 'lifecycle__actions' }, addButton, saveButton, revertButton, reloadButton);
    const message = h('p', { class: 'lifecycle__message', role: 'status', 'data-lifecycle-message': '' });
    const warnings = h('ul', { class: 'lifecycle__warnings', role: 'alert', 'data-lifecycle-warnings': '' });
    const say = (text, tone = '') => { message.textContent = text; message.dataset.tone = tone; };

    const writable = () => Boolean(editor?.writable) && canWrite;
    const offered = field => Boolean(editor?.fields?.[field]);

    // The rule of the server for the form: the tag as text, and the days of each action.
    function draftOf(rule, saved) {
      serial += 1;
      return {
        key: serial,
        saved,
        id: rule.id || '',
        enabled: rule.enabled !== false,
        prefix: rule.prefix || '',
        tagText: rule.tag ? formatTag(rule.tag) : '',
        // The tag of the server goes back unchanged until the person edits the text.
        tag: rule.tag || null,
        tagEdited: false,
        expirationDays: Number(rule.expirationDays) || 0,
        noncurrentDays: Number(rule.noncurrentDays) || 0,
        abortMultipartDays: Number(rule.abortMultipartDays) || 0,
        expiredDeleteMarker: rule.expiredDeleteMarker === true,
        // The days that the input shows while the action is off.
        shown: { ...DEFAULT_DAYS, ...Object.fromEntries(ACTIONS.filter(action => rule[action.property]).map(action => [action.property, rule[action.property]])) }
      };
    }

    // The rule that the page sends for a draft.
    function ruleOf(draft) {
      const { tag, error } = draft.tagEdited ? parseTagField(draft.tagText) : { tag: draft.tag, error: '' };
      const rule = { id: draft.id, enabled: draft.enabled, prefix: draft.prefix };
      if (tag) rule.tag = tag;
      for (const action of ACTIONS) if (draft[action.property]) rule[action.property] = draft[action.property];
      if (draft.expiredDeleteMarker) rule.expiredDeleteMarker = true;
      return { rule, tagError: error };
    }

    const editableDrafts = () => entries.filter(entry => entry.draft).map(entry => entry.draft);
    const keptIds = () => entries.filter(entry => !entry.draft).map(entry => entry.rule?.id).filter(Boolean);
    const comparable = draft => JSON.stringify(ruleOf(draft).rule);
    // A draft is new, or differs from the rule that the server gave.
    const changedDraft = draft => !draft.saved || comparable(draft) !== comparable(draftOf(draft.saved, null));
    let baseline = '[]';
    const dirty = () => JSON.stringify(editableDrafts().map(draft => ruleOf(draft).rule)) !== baseline;

    // The state of the server: the editable rules become drafts, the other rules stay rows.
    function apply(response) {
      editor = response.editor || null;
      rules = response.rules || [];
      entries = (editor?.entries || rules.map(() => ({ editable: false }))).map((entry, index) => ({
        rule: rules[index],
        entry,
        draft: entry.editable && writable() ? draftOf(entry.rule, entry.rule) : null
      }));
      baseline = JSON.stringify(editableDrafts().map(draft => ruleOf(draft).rule));
    }

    function addRule(values = {}) {
      const ids = new Set([...keptIds(), ...editableDrafts().map(draft => draft.id)]);
      let id = values.id || 'rule-1';
      for (let index = 2; ids.has(id); index += 1) id = `${values.id || 'rule'}-${index}`;
      const draft = draftOf({ enabled: true, prefix, ...values, id }, null);
      entries.push({ rule: null, entry: null, draft });
      return draft;
    }

    function dayInput(draft, action) {
      const on = draft[action.property] > 0;
      const box = h('input', { type: 'checkbox', 'data-lifecycle-action': action.name, 'aria-label': action.before });
      box.checked = on;
      const days = h('input', { type: 'number', class: 'input', min: '1', max: String(editor?.maxDays || 36500), step: '1', 'aria-label': `Days: ${action.before.toLowerCase()}`, 'data-lifecycle-days': action.name });
      days.value = String(on ? draft[action.property] : draft.shown[action.property]);
      days.disabled = !on;
      // A checked action with no valid number keeps -1: the check of the save refuses it.
      const value = () => (/^\d+$/.test(days.value.trim()) && Number(days.value) > 0 ? Number(days.value) : -1);
      box.addEventListener('change', () => {
        draft[action.property] = box.checked ? value() : 0;
        days.disabled = !box.checked;
        changed();
      });
      days.addEventListener('input', () => {
        draft.shown[action.property] = Number(days.value);
        if (box.checked) draft[action.property] = value();
        changed();
      });
      return h('label', { class: 'lifecycleRule__action' }, box, h('span', {}, action.before), days, h('span', {}, action.after));
    }

    function editableRow(draft) {
      const idInput = h('input', { type: 'text', class: 'input lifecycleRule__id', 'aria-label': 'Rule ID', placeholder: 'Rule ID', maxlength: MAX_ID, autocomplete: 'off', 'data-lifecycle-id': '' });
      idInput.value = draft.id;
      idInput.addEventListener('input', () => { draft.id = idInput.value; changed(); });
      const enabled = h('input', { type: 'checkbox', 'data-lifecycle-enabled': '' });
      enabled.checked = draft.enabled;
      enabled.addEventListener('change', () => { draft.enabled = enabled.checked; changed(); });
      const remove = h('button', { type: 'button', class: 'iconButton', title: 'Remove this rule', 'aria-label': 'Remove this rule', 'data-lifecycle-remove': '' }, icon('delete-outline'));
      remove.addEventListener('click', () => {
        entries = entries.filter(entry => entry.draft !== draft);
        say('');
        render();
      });
      const prefixInput = h('input', { type: 'text', class: 'input', 'aria-label': 'Prefix', placeholder: 'logs/ (empty: every object)', autocomplete: 'off', 'data-lifecycle-prefix': '' });
      prefixInput.value = draft.prefix;
      prefixInput.addEventListener('input', () => { draft.prefix = prefixInput.value.replace(/^\/+/, ''); changed(); });
      const fields = [h('label', { class: 'lifecycleRule__field' }, h('span', {}, 'Prefix'), prefixInput)];
      if (offered('tagFilter')) {
        const tagInput = h('input', { type: 'text', class: 'input', 'aria-label': 'Tag filter', placeholder: 'key=value (optional)', autocomplete: 'off', 'data-lifecycle-tag': '' });
        tagInput.value = draft.tagText;
        tagInput.addEventListener('input', () => { draft.tagText = tagInput.value; draft.tagEdited = true; changed(); });
        fields.push(h('label', { class: 'lifecycleRule__field' }, h('span', {}, 'Tag filter'), tagInput));
      }
      const actionRows = ACTIONS.filter(action => !action.field || offered(action.field)).map(action => dayInput(draft, action));
      if (offered('expiredDeleteMarker')) {
        const marker = h('input', { type: 'checkbox', 'data-lifecycle-action': 'deleteMarker', 'aria-label': 'Remove the expired delete markers' });
        marker.checked = draft.expiredDeleteMarker;
        marker.addEventListener('change', () => { draft.expiredDeleteMarker = marker.checked; changed(); });
        actionRows.push(h('label', { class: 'lifecycleRule__action' }, marker, h('span', {}, 'Remove the expired delete markers')));
      }
      return h('div', { class: 'lifecycleRule', 'data-lifecycle-rule': '' },
        h('div', { class: 'lifecycleRule__head' }, idInput,
          h('label', { class: 'lifecycleRule__enabled' }, enabled, h('span', {}, 'Enabled')), remove),
        h('div', { class: 'lifecycleRule__fields' }, fields),
        h('div', { class: 'lifecycleRule__actions' }, actionRows));
    }

    // A rule that the window does not edit: its summary and, for a rule that the editor keeps, the reason and the XML.
    function readOnlyRow(item) {
      const rule = item.rule || {};
      const kept = item.entry && !item.entry.editable;
      return h('div', { class: ['lifecycleRule', 'is-readonly'], 'data-lifecycle-kept': kept ? (rule.id || '') : null, 'data-lifecycle-view': kept ? null : (rule.id || '') },
        h('div', { class: 'lifecycleRule__head' },
          h('span', { class: 'lifecycleRule__name mono' }, rule.id || (kept && !item.entry.xml ? 'Other rule' : '(no ID)')),
          h('span', { class: `badge${rule.enabled ? ' badge--ok' : ''}` }, rule.enabled ? 'Enabled' : 'Disabled'),
          kept ? h('span', { class: 'badge badge--accent', 'data-lifecycle-kept-note': '' }, 'Kept as is') : null),
        h('p', { class: 'lifecycleRule__summary' }, kept && !item.entry.xml ? 'A rule of another part of the bucket.' : describeRule(rule)),
        kept && item.entry.reason ? h('p', { class: 'lifecycleRule__reason' }, `${item.entry.reason} S3-Browser writes it back unchanged.`) : null,
        kept && item.entry.xml ? h('details', { class: 'lifecycleRule__xml' }, h('summary', {}, 'XML'), h('pre', { class: 'mono' }, item.entry.xml)) : null);
    }

    function renderState() {
      const canEdit = writable();
      addButton.hidden = !canEdit;
      saveButton.hidden = !canEdit;
      revertButton.hidden = !canEdit;
      const changes = canEdit && dirty();
      saveButton.disabled = busy || !changes;
      revertButton.disabled = busy || !changes;
      addButton.disabled = busy || entries.length >= (editor?.maxRules || 1000);
    }

    function changed() {
      say('');
      renderState();
    }

    function render() {
      const root = editor?.rootPrefix || '';
      intro.replaceChildren(...(root
        ? ['The rules apply to the bucket. This window edits the rules under ', h('code', {}, root), ': a prefix of a rule starts there. The other rules stay as they are.']
        : ['The rules apply to the whole bucket. The storage provider runs them, not S3-Browser.']));
      intro.hidden = !editor;
      providerNote.textContent = editor?.providerNote || '';
      providerNote.hidden = !editor?.providerNote;
      readonly.textContent = !editor ? '' : !editor.writable ? `You cannot change the rules here. ${editor.readOnlyReason || ''}`.trim() : !canWrite ? 'You cannot change the rules here: you have no write permission in this folder.' : '';
      readonly.hidden = !readonly.textContent;
      hidden.replaceChildren(...(editor?.hidden || []).map(item => h('li', { 'data-field': item.field }, h('strong', {}, `${FIELD_LABELS[item.field] || item.field}: `), 'not offered. ', item.reason)));
      hidden.hidden = !writable() || !(editor?.hidden || []).length;
      state.hidden = Boolean(editor) && entries.length > 0;
      if (editor && !entries.length) state.textContent = 'No lifecycle rule.';
      list.replaceChildren(...entries.map(item => (item.draft ? editableRow(item.draft) : readOnlyRow(item))));
      list.hidden = !entries.length;
      renderState();
    }

    async function load() {
      if (!host.isConnected) return;
      busy = true;
      renderState();
      try {
        apply(await BB.api.lifecycle(instance));
        if (!editor) {
          // A backend that only reads the rules.
          editor = { writable: false, readOnlyReason: 'This storage provider does not let S3-Browser change the rules.', entries: [], fields: {}, hidden: [] };
        }
        reloadButton.hidden = true;
        if (pendingPrefill) {
          const values = pendingPrefill;
          pendingPrefill = null;
          if (!writable()) say('You cannot add the rule here: the rules are read only.', 'error');
          else if (values.abortMultipartDays && !offered('abortMultipart')) say('This storage provider does not keep a rule that aborts the incomplete uploads.', 'error');
          else {
            addRule(values);
            say('A new rule aborts the incomplete uploads of this folder. Check it, then save.', 'ok');
          }
        }
      } catch (error) {
        editor = null;
        entries = [];
        state.textContent = error?.status === 403 ? 'You cannot read the lifecycle rules of this bucket.' : `The lifecycle rules cannot be loaded: ${error?.message || error}`;
      } finally {
        busy = false;
        render();
      }
    }

    async function save() {
      const drafts = editableDrafts();
      const prepared = drafts.map(draft => ({ draft, ...ruleOf(draft) }));
      const checked = prepared.map(({ rule, tagError }) => ({
        ...rule, tag: rule.tag || null, tagError, expirationDays: rule.expirationDays || 0, noncurrentDays: rule.noncurrentDays || 0,
        abortMultipartDays: rule.abortMultipartDays || 0, expiredDeleteMarker: rule.expiredDeleteMarker === true
      }));
      const error = checkRules(checked, keptIds(), editor?.maxDays || 36500);
      if (error) { say(error, 'error'); return; }
      // The confirmation names each action that deletes data and that is new or changed.
      const sentences = prepared
        .filter(({ draft }) => changedDraft(draft))
        .flatMap(({ rule }) => destructiveActions(rule, editor?.rootPrefix || ''));
      if (sentences.length) {
        const confirmed = await BB.ui.confirm({
          title: 'Save the lifecycle rules',
          html: `<div class="lifecycleConfirm" data-lifecycle-confirm><p>The storage provider runs these actions every day, also on the objects that exist now. They cannot be undone.</p><ul>${sentences.map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ul></div>`,
          confirmLabel: 'Save the rules'
        });
        if (!confirmed) return;
      }
      busy = true;
      renderState();
      say('Saving…');
      warnings.replaceChildren();
      try {
        const response = await BB.api.putLifecycle({ hash: editor.hash, rules: prepared.map(item => item.rule), instance });
        // Without a state, the server could not read the rules again after the write: the window reads them.
        if (response.editor) apply(response);
        else { busy = false; await load(); }
        const changes = response.warnings || [];
        warnings.replaceChildren(...changes.map(text => h('li', {}, icon('alert-circle-outline'), text)));
        say(changes.length ? 'The rules are saved, but the storage provider changed them:' : 'The lifecycle rules are saved.', changes.length ? 'error' : 'ok');
        document.dispatchEvent(new CustomEvent('bb:lifecycle-changed', { detail: { instance } }));
      } catch (failure) {
        if (failure?.code === 'lifecycle_changed') {
          say('The lifecycle rules of the bucket changed after this window read them. Reload the rules, then make your change again.', 'error');
          reloadButton.hidden = false;
        } else if (failure?.code === 'lifecycle_write_denied' || failure?.code === 'lifecycle_write_unsupported') {
          busy = false;
          await load();
          say(failure.message, 'error');
          return;
        } else {
          say(failure?.status === 403 ? `You cannot change these lifecycle rules: ${failure?.message || 'access denied'}` : `The rules are not saved: ${failure?.message || failure}`, 'error');
        }
      } finally {
        busy = false;
      }
      render();
    }

    addButton.addEventListener('click', () => {
      const draft = addRule();
      say('');
      render();
      list.querySelectorAll('[data-lifecycle-rule]')[editableDrafts().indexOf(draft)]?.querySelector('[data-lifecycle-id]')?.focus();
    });
    saveButton.addEventListener('click', () => { void save(); });
    revertButton.addEventListener('click', () => {
      apply({ editor, rules });
      say('');
      warnings.replaceChildren();
      render();
    });
    reloadButton.addEventListener('click', () => { say(''); warnings.replaceChildren(); void load(); });
    reloadButton.hidden = true;

    host.replaceChildren(intro, providerNote, readonly, hidden, state, list, actions, message, warnings);
    render();
    void load();
  }

  // Open the window. prefix is the folder of the listing, canWrite tells if the person can write there. prefill gives
  // the values of a new rule, such as { id, prefix, abortMultipartDays } from the window of the incomplete uploads.
  function open({ instance = null, canWrite = false, prefix = '', prefill = null } = {}) {
    return BB.ui.alert({
      title: 'Lifecycle rules',
      large: true,
      onOpen: ({ modal }) => {
        const body = modal.querySelector('.bb-modal-body');
        const root = h('div', { class: 'lifecycle', 'data-lifecycle': '' });
        body.replaceChildren(root);
        mount(root, { instance, canWrite, prefix, prefill });
      }
    });
  }

  // What the window of the incomplete uploads can say about a rule that aborts them: { supported, offered, writable,
  // reason }. supported is false when the provider gives no lifecycle rules.
  async function abortRuleSupport(instance = null) {
    try {
      const response = await BB.api.lifecycle(instance);
      const editor = response.editor;
      if (!editor) return { supported: true, offered: false, writable: false, reason: '' };
      const hiddenField = (editor.hidden || []).find(item => item.field === 'abortMultipart');
      return { supported: true, offered: Boolean(editor.fields?.abortMultipart), writable: editor.writable === true, reason: hiddenField?.reason || '' };
    } catch (error) {
      // A provider without rules, a refused read or a failure: the note stays plain text.
      return { supported: false, offered: false, writable: false, reason: '' };
    }
  }

  BB.lifecycle = { open, abortRuleSupport, destructiveActions, describeRule, checkRules };
})();
