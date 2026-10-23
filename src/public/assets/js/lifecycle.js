/*
 * BB.lifecycle: the editor of the lifecycle rules, in the part "Lifecycle rules" of the information page (info.js).
 * It is a part of the page, not a window: mount(host, options) puts it in an element of the page. It has two columns:
 * - at the left, one form: a new rule, or the rule that the person edits ("Edit <id>"). Add puts a new rule in the
 *   list; Update changes the rule; Cancel goes back to a new rule;
 * - at the right, the rules of the bucket, one compact row each: Enabled, the ID, a short summary, Edit and Delete.
 *   Delete asks in the row. A rule that the editor does not know (transitions, size filters and so on) is a read-only
 *   row with the badge "Kept as is": the server writes it back byte for byte;
 * - Save and Revert act on the whole list. Before the save, a confirmation in the page names each action that deletes
 *   data, with its prefix and its number of days: "Save the rules" or "Cancel". There is no dialog;
 * - the editor offers only the fields that the storage provider keeps. The server decides them and gives the reason
 *   for each other field. After the save, the server reads the rules again and tells what the provider changed, and
 *   the page gets the event bb:lifecycle-changed.
 * The window of the incomplete uploads (multiparts.js) links to the information page with a new rule that aborts them.
 * The server checks each request again. A provider without lifecycle rules answers 501: the page shows no editor.
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
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const icon = name => h('i', { class: `mdi mdi-${name}`, 'aria-hidden': 'true' });
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
    return `${scope.join(', ')}: ${actions.length ? actions.join(', ') : 'no action that Stowr knows'}.`;
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
  // The editor
  // ---------------------------------------------------------------------------------------------------------------

  // The actions with a number of days: the short label of the form and its title.
  const ACTIONS = [
    { name: 'expiration', property: 'expirationDays', label: 'Delete objects after', title: 'Delete the objects this number of days after their creation' },
    { name: 'noncurrent', property: 'noncurrentDays', field: 'noncurrentExpiration', label: 'Delete noncurrent versions after', title: 'Delete the noncurrent versions this number of days after they become noncurrent' },
    { name: 'abort', property: 'abortMultipartDays', field: 'abortMultipart', label: 'Abort incomplete uploads after', title: 'Abort the incomplete multipart uploads this number of days after their start' }
  ];

  // The short summary of a rule: "logs/ · delete 30 d · tag k=v". A rule of the form and a rule of the server
  // (describeRule) have other names for the same fields.
  function shortRule(rule) {
    const days = value => `${count(value)} d`;
    const parts = [rule.prefix || 'all objects'];
    if (rule.expirationDays) parts.push(`delete ${days(rule.expirationDays)}`);
    if (rule.expirationDate) parts.push(`delete on ${String(rule.expirationDate).slice(0, 10)}`);
    if (rule.noncurrentDays || rule.noncurrentExpirationDays) parts.push(`noncurrent ${days(rule.noncurrentDays || rule.noncurrentExpirationDays)}`);
    if (rule.abortMultipartDays || rule.abortIncompleteMultipartDays) parts.push(`abort ${days(rule.abortMultipartDays || rule.abortIncompleteMultipartDays)}`);
    if (rule.expiredDeleteMarker || rule.expiredObjectDeleteMarker) parts.push('delete markers');
    if ((rule.transitions || []).length) parts.push('transition');
    const tags = rule.tag ? [rule.tag] : (rule.tags || []);
    if (tags.length) parts.push(`tag ${tags.map(formatTag).join(', ')}`);
    return parts.join(' · ');
  }
  const DEFAULT_DAYS = { expirationDays: 30, noncurrentDays: 30, abortMultipartDays: 7 };

  // prefix is the prefix of a new rule. prefill adds a new rule with these values. canWrite tells if the person can
  // write in the bucket: without it, the editor shows the rules and no control.
  function mount(host, { instance = null, canWrite = false, prefix = '', prefill = null }) {
    let editor = null;
    let rules = [];
    let entries = [];
    let busy = false;
    let serial = 0;
    let pendingPrefill = prefill;

    // The form of a rule: { draft, target }. target is the draft of the list that the form edits, or null for a new rule.
    let form = null;

    const intro = h('p', { class: 'lifecycle__intro' });
    const providerNote = h('p', { class: 'lifecycle__note', 'data-lifecycle-provider-note': '' });
    const readonly = h('p', { class: 'lifecycle__readonly', 'data-lifecycle-readonly': '' });
    const hidden = h('ul', { class: 'lifecycle__hidden', 'data-lifecycle-hidden': '' });
    const state = h('p', { class: 'lifecycle__state' }, 'Loading…');
    const formBox = h('div', { class: 'lifecycle__formBox' });
    const list = h('div', { class: 'lifecycle__rules', 'data-lifecycle-rules': '' });
    const saveButton = h('button', { type: 'button', class: 'bb-btn bb-btn-primary', 'data-lifecycle-save': '' }, icon('check'), h('span', {}, 'Save'));
    const revertButton = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-revert': '' }, h('span', {}, 'Revert'));
    const reloadButton = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-reload': '' }, icon('refresh'), h('span', {}, 'Reload'));
    const actions = h('div', { class: 'lifecycle__actions' }, saveButton, revertButton, reloadButton);
    const ruleCount = h('span', { class: 'lifecycle__count' });
    const message = h('p', { class: 'lifecycle__message', role: 'status', 'data-lifecycle-message': '' });
    // The confirmation of a save that deletes data: in the page, under the rules, in place of the buttons.
    const confirmBox = h('div', { class: 'lifecycle__confirm', role: 'alert', 'data-lifecycle-confirm': '', hidden: true });
    const warnings = h('ul', { class: 'lifecycle__warnings', role: 'alert', 'data-lifecycle-warnings': '' });
    const formNote = h('p', { class: 'lifecycleForm__note', role: 'status', 'data-lifecycle-form-message': '' });
    const say = (text, tone = '') => { message.textContent = text; message.dataset.tone = tone; };
    const sayForm = (text, tone = '') => { formNote.textContent = text; formNote.dataset.tone = tone; syncFormButtons(); };

    // The buttons Add and Update stay grey until the rule of the form has its minimum: an ID and one valid action.
    function formReady() {
      return Boolean(form) && !busy && !formError();
    }

    function syncFormButtons() {
      const add = formBox?.querySelector('[data-lifecycle-add]');
      const reason = form ? formError() : '';
      if (add) {
        add.disabled = !formReady() || entries.length >= (editor?.maxRules || 1000);
        add.title = add.disabled ? reason : '';
      }
      const update = formBox?.querySelector('[data-lifecycle-update]');
      if (update) {
        update.disabled = !formReady();
        update.title = update.disabled ? reason : '';
      }
    }

    // The person confirms the actions that delete data: true for "Save the rules", false for "Cancel".
    function confirmInline(sentences) {
      return new Promise(resolve => {
        const done = value => {
          confirmBox.hidden = true;
          confirmBox.replaceChildren();
          actions.hidden = false;
          resolve(value);
          (value ? saveButton : revertButton).focus?.();
        };
        const accept = h('button', { type: 'button', class: 'bb-btn bb-btn-primary', 'data-lifecycle-confirm-save': '' }, icon('check'), h('span', {}, 'Save the rules'));
        const cancel = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-confirm-cancel': '' }, h('span', {}, 'Cancel'));
        accept.addEventListener('click', () => done(true));
        cancel.addEventListener('click', () => done(false));
        confirmBox.replaceChildren(
          h('strong', {}, 'Save the lifecycle rules?'),
          h('p', {}, 'The storage provider runs these actions every day, also on the objects that exist now. They cannot be undone.'),
          h('ul', {}, sentences.map(text => h('li', {}, text))),
          h('div', { class: 'lifecycle__confirmActions' }, accept, cancel));
        confirmBox.hidden = false;
        actions.hidden = true;
        accept.focus();
      });
    }

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

    // A free ID: the ID of the values, else rule-1, rule-2 and so on.
    function freeId(base = '') {
      const ids = new Set([...keptIds(), ...editableDrafts().map(draft => draft.id)]);
      let id = base || 'rule-1';
      for (let index = 2; ids.has(id); index += 1) id = `${base || 'rule'}-${index}`;
      return id;
    }

    function newForm(values = {}) {
      form = { draft: draftOf({ enabled: true, prefix, ...values, id: freeId(values.id) }, null), target: null };
    }

    function editForm(draft) {
      form = { draft: { ...draft, shown: { ...draft.shown } }, target: draft };
    }

    const checkedOf = (rule, tagError) => ({
      ...rule, tag: rule.tag || null, tagError, expirationDays: rule.expirationDays || 0, noncurrentDays: rule.noncurrentDays || 0,
      abortMultipartDays: rule.abortMultipartDays || 0, expiredDeleteMarker: rule.expiredDeleteMarker === true
    });

    // The error of the rule of the form, or '': the checks of the save, with the IDs of the other rules.
    function formError() {
      const others = [...keptIds(), ...editableDrafts().filter(draft => draft !== form.target).map(draft => draft.id)];
      const { rule, tagError } = ruleOf(form.draft);
      return checkRules([checkedOf(rule, tagError)], others, editor?.maxDays || 36500);
    }

    function submitForm() {
      const error = formError();
      if (error) { sayForm(error, 'error'); return; }
      if (form.target) Object.assign(form.target, { ...form.draft, key: form.target.key, saved: form.target.saved });
      else entries.push({ rule: null, entry: null, draft: form.draft });
      newForm();
      sayForm('');
      render();
      changed();
    }

    // An action of the form: a checkbox, the short label, the days and "d". The title gives the whole sentence.
    function dayInput(draft, action) {
      const on = draft[action.property] > 0;
      const box = h('input', { type: 'checkbox', 'data-lifecycle-action': action.name, 'aria-label': action.title });
      box.checked = on;
      const days = h('input', { type: 'number', class: 'input', min: '1', max: String(editor?.maxDays || 36500), step: '1', 'aria-label': `Days: ${action.title.toLowerCase()}`, 'data-lifecycle-days': action.name });
      days.value = String(on ? draft[action.property] : draft.shown[action.property]);
      days.disabled = !on;
      // A checked action with no valid number keeps -1: the check refuses it.
      const value = () => (/^\d+$/.test(days.value.trim()) && Number(days.value) > 0 ? Number(days.value) : -1);
      box.addEventListener('change', () => {
        draft[action.property] = box.checked ? value() : 0;
        days.disabled = !box.checked;
        sayForm('');
      });
      days.addEventListener('input', () => {
        draft.shown[action.property] = Number(days.value);
        if (box.checked) draft[action.property] = value();
        sayForm('');
      });
      return h('label', { class: 'lifecycleForm__action', title: action.title }, box, h('span', {}, action.label), days, h('span', { class: 'lifecycleForm__unit' }, 'd'));
    }

    function textInput(label, key, value, placeholder, onInput) {
      const input = h('input', { type: 'text', class: 'input', 'aria-label': label, placeholder, autocomplete: 'off', [`data-lifecycle-${key}`]: '' });
      input.value = value;
      input.addEventListener('input', () => { onInput(input.value); sayForm(''); });
      return h('label', { class: 'lifecycleForm__field' }, h('span', {}, label), input);
    }

    // The form of the left column: a new rule, or the rule that the person edits.
    function formView() {
      const draft = form.draft;
      const editing = Boolean(form.target);
      const fields = [
        textInput('Name', 'id', draft.id, 'Rule ID', value => { draft.id = value; }),
        textInput('Prefix', 'prefix', draft.prefix, 'logs/ (empty: all)', value => { draft.prefix = value.replace(/^\/+/, ''); })
      ];
      if (offered('tagFilter')) fields.push(textInput('Tag', 'tag', draft.tagText, 'key=value', value => { draft.tagText = value; draft.tagEdited = true; }));
      const actionRows = ACTIONS.filter(action => !action.field || offered(action.field)).map(action => dayInput(draft, action));
      if (offered('expiredDeleteMarker')) {
        const marker = h('input', { type: 'checkbox', 'data-lifecycle-action': 'deleteMarker', 'aria-label': 'Remove the expired delete markers' });
        marker.checked = draft.expiredDeleteMarker;
        marker.addEventListener('change', () => { draft.expiredDeleteMarker = marker.checked; sayForm(''); });
        actionRows.push(h('label', { class: 'lifecycleForm__action', title: 'Remove the delete markers that have no version left' }, marker, h('span', {}, 'Remove expired delete markers')));
      }
      const buttons = editing
        ? [h('button', { type: 'submit', class: 'bb-btn bb-btn-primary', 'data-lifecycle-update': '', disabled: !formReady() }, icon('check'), h('span', {}, 'Update')),
          h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-cancel': '', onclick: () => { newForm(); sayForm(''); render(); } }, h('span', {}, 'Cancel'))]
        : [h('button', { type: 'submit', class: 'bb-btn', 'data-lifecycle-add': '', disabled: !formReady() || entries.length >= (editor?.maxRules || 1000) }, icon('plus'), h('span', {}, 'Add'))];
      const node = h('form', { class: 'lifecycleForm', 'data-lifecycle-form': editing ? 'edit' : 'new', novalidate: true },
        h('h3', { class: 'lifecycleForm__title' }, editing ? `Edit ${form.target.id || 'rule'}` : 'New rule'),
        h('div', { class: 'lifecycleForm__fields' }, fields),
        h('div', { class: 'lifecycleForm__actions' }, actionRows),
        h('div', { class: 'lifecycleForm__buttons' }, buttons),
        formNote);
      node.addEventListener('submit', event => { event.preventDefault(); submitForm(); });
      return node;
    }

    // A rule of the list that the editor edits: Enabled, the ID, the summary, Edit and Delete. Delete asks in the row.
    function editableRow(draft) {
      const enabled = h('input', { type: 'checkbox', 'data-lifecycle-enabled': '', 'aria-label': `Enabled: ${draft.id}`, title: 'Enabled' });
      enabled.checked = draft.enabled;
      enabled.addEventListener('change', () => { draft.enabled = enabled.checked; changed(); });
      const tools = h('span', { class: 'lifecycleRule__tools' });
      const edit = h('button', { type: 'button', class: 'iconButton', title: 'Edit', 'aria-label': `Edit ${draft.id}`, 'data-lifecycle-edit': '' }, icon('pencil-outline'));
      edit.addEventListener('click', () => {
        editForm(draft);
        sayForm('');
        render();
        formBox.querySelector('[data-lifecycle-id]')?.focus();
      });
      const remove = h('button', { type: 'button', class: 'iconButton', title: 'Delete', 'aria-label': `Delete ${draft.id}`, 'data-lifecycle-remove': '' }, icon('delete-outline'));
      remove.addEventListener('click', () => {
        const yes = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-remove-confirm': '' }, 'Delete');
        const no = h('button', { type: 'button', class: 'bb-btn', 'data-lifecycle-remove-cancel': '' }, 'Cancel');
        yes.addEventListener('click', () => {
          entries = entries.filter(entry => entry.draft !== draft);
          if (form?.target === draft) newForm();
          render();
          changed();
        });
        no.addEventListener('click', () => { tools.replaceChildren(edit, remove); edit.focus(); });
        tools.replaceChildren(h('span', { class: 'lifecycleRule__ask' }, 'Delete?'), yes, no);
        yes.focus();
      });
      tools.append(edit, remove);
      const rule = ruleOf(draft).rule;
      const full = describeRule({ ...rule, tags: rule.tag ? [rule.tag] : [], noncurrentExpirationDays: rule.noncurrentDays, abortIncompleteMultipartDays: rule.abortMultipartDays, expiredObjectDeleteMarker: rule.expiredDeleteMarker });
      return h('div', { class: ['lifecycleRule', !draft.saved && 'is-new', form?.target === draft && 'is-editing'], 'data-lifecycle-rule': draft.id },
        enabled,
        h('span', { class: 'lifecycleRule__name mono', title: draft.id }, draft.id || '(no ID)'),
        h('span', { class: 'lifecycleRule__summary', title: full }, shortRule(rule)),
        tools);
    }

    // A rule that the editor does not edit: its state, its ID and its summary. "Kept as is" has the reason in its title.
    function readOnlyRow(item) {
      const rule = item.rule || {};
      const kept = item.entry && !item.entry.editable;
      const other = kept && !item.entry.xml;
      const summary = other ? 'Another part of the bucket' : shortRule(rule);
      return h('div', { class: ['lifecycleRule', 'is-readonly'], 'data-lifecycle-kept': kept ? (rule.id || '') : null, 'data-lifecycle-view': kept ? null : (rule.id || '') },
        h('span', { class: ['lifecycleRule__state', rule.enabled && 'is-on'], title: rule.enabled ? 'Enabled' : 'Disabled' }, rule.enabled ? 'On' : 'Off'),
        h('span', { class: 'lifecycleRule__name mono', title: rule.id || '' }, rule.id || (other ? 'Other rule' : '(no ID)')),
        h('span', { class: 'lifecycleRule__summary', title: other ? summary : describeRule(rule) }, summary),
        h('span', { class: 'lifecycleRule__tools' },
          kept ? h('span', { class: 'badge badge--accent', 'data-lifecycle-kept-note': '', title: `${item.entry.reason ? `${item.entry.reason} ` : ''}Stowr writes it back unchanged.` }, 'Kept as is') : null));
    }

    function renderState() {
      const canEdit = writable();
      formBox.hidden = !canEdit;
      host.classList.toggle('is-readonly', !canEdit);
      saveButton.hidden = !canEdit;
      revertButton.hidden = !canEdit;
      const changes = canEdit && dirty();
      saveButton.disabled = busy || !changes;
      revertButton.disabled = busy || !changes;
      syncFormButtons();
    }

    // A change of the list: the message says that the change is not saved yet.
    function changed() {
      if (dirty()) say('Not saved yet.');
      else if (message.textContent === 'Not saved yet.') say('');
      renderState();
    }

    function render() {
      const root = editor?.rootPrefix || '';
      intro.replaceChildren(...(root
        ? ['Rules under ', h('code', {}, root), '.']
        : []));
      intro.hidden = !editor || !root;
      // The note of the provider is long: the page does not show it. The reason of a field that the provider does not
      // keep is in the title of the line "Not offered".
      providerNote.textContent = '';
      providerNote.hidden = true;
      readonly.textContent = !editor ? '' : !editor.writable ? `Read only. ${editor.readOnlyReason || ''}`.trim() : !canWrite ? 'Read only: no write permission.' : '';
      readonly.hidden = !readonly.textContent;
      const notOffered = editor?.hidden || [];
      hidden.replaceChildren(...(notOffered.length ? [h('li', { 'data-field': notOffered.map(item => item.field).join(' '), title: notOffered.map(item => `${FIELD_LABELS[item.field] || item.field}: ${item.reason}`).join('\n') },
        `Not offered: ${notOffered.map(item => FIELD_LABELS[item.field] || item.field).join(', ')}`)] : []));
      hidden.hidden = !writable() || !notOffered.length;
      state.hidden = Boolean(editor) && entries.length > 0;
      if (editor && !entries.length) state.textContent = 'No rule.';
      ruleCount.textContent = entries.length ? String(entries.length) : '';
      if (form?.target && !entries.some(entry => entry.draft === form.target)) newForm();
      if (!form && editor) newForm();
      formBox.replaceChildren(...(form && writable() ? [formView(), intro, hidden] : []));
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
          editor = { writable: false, readOnlyReason: 'This storage provider does not let Stowr change the rules.', entries: [], fields: {}, hidden: [] };
        }
        reloadButton.hidden = true;
        if (pendingPrefill) {
          const values = pendingPrefill;
          pendingPrefill = null;
          if (!writable()) say('You cannot add the rule here: the rules are read only.', 'error');
          else if (values.abortMultipartDays && !offered('abortMultipart')) say('This storage provider does not keep a rule that aborts the incomplete uploads.', 'error');
          else {
            newForm(values);
            sayForm('Abort rule ready: Add it, then Save.', 'ok');
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
      const checked = prepared.map(({ rule, tagError }) => checkedOf(rule, tagError));
      const error = checkRules(checked, keptIds(), editor?.maxDays || 36500);
      if (error) { say(error, 'error'); return; }
      // The confirmation names each action that deletes data and that is new or changed.
      const sentences = prepared
        .filter(({ draft }) => changedDraft(draft))
        .flatMap(({ rule }) => destructiveActions(rule, editor?.rootPrefix || ''));
      if (sentences.length) {
        const confirmed = await confirmInline(sentences);
        if (!confirmed) return;
      }
      busy = true;
      renderState();
      say('Saving…');
      warnings.replaceChildren();
      try {
        const response = await BB.api.putLifecycle({ hash: editor.hash, rules: prepared.map(item => item.rule), instance });
        // Without a state, the server could not read the rules again after the write: the editor reads them.
        if (response.editor) apply(response);
        else { busy = false; await load(); }
        const changes = response.warnings || [];
        warnings.replaceChildren(...changes.map(text => h('li', {}, icon('alert-circle-outline'), text)));
        say(changes.length ? 'Saved, but the storage provider changed them:' : 'Saved.', changes.length ? 'error' : 'ok');
        document.dispatchEvent(new CustomEvent('bb:lifecycle-changed', { detail: { instance } }));
      } catch (failure) {
        if (failure?.code === 'lifecycle_changed') {
          say('The rules changed after this page read them. Reload, then make your change again.', 'error');
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

    saveButton.addEventListener('click', () => { void save(); });
    revertButton.addEventListener('click', () => {
      apply({ editor, rules });
      newForm();
      sayForm('');
      say('');
      warnings.replaceChildren();
      render();
    });
    reloadButton.addEventListener('click', () => { say(''); warnings.replaceChildren(); void load(); });
    reloadButton.hidden = true;

    // The left column: the form. The right column: the head of the list (the count, Save, Revert, Reload), the rules,
    // the confirmation, the message and the changes of the provider.
    host.replaceChildren(providerNote, readonly,
      h('div', { class: 'lifecycle__columns' },
        formBox,
        h('div', { class: 'lifecycle__listBox' },
          h('div', { class: 'lifecycle__listHead' }, h('h3', { class: 'lifecycle__listTitle' }, 'Rules', ruleCount), actions),
          state, list, confirmBox, message, warnings)));
    render();
    void load();
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

  BB.lifecycle = { mount, abortRuleSupport, destructiveActions, describeRule, checkRules };
})();
