/*
 * BB.objectLock: the retention section of the file details.
 * - the read: the mode and the date of the retention, the legal hold and the default retention of the bucket, for one
 *   version of the object;
 * - the edit: a frameless "Edit" button opens the form in the same window, with Save and Revert as in the tags section;
 * - the checks before the save: a date in the future, no shorter Compliance retention, and a confirmation before a
 *   change that needs the bypass of the Governance retention.
 * The server checks each request again. A bucket without Object Lock answers 501: the section goes.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const DAY_MS = 86400000;
  const GOVERNANCE = 'GOVERNANCE';
  const COMPLIANCE = 'COMPLIANCE';
  const MODE_NAMES = { [GOVERNANCE]: 'Governance', [COMPLIANCE]: 'Compliance' };
  const MODE_NOTES = {
    [GOVERNANCE]: 'Users with the bypass right can shorten or remove it.',
    [COMPLIANCE]: 'Nobody can shorten or remove it before this date, not even the owner of the bucket.'
  };

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
  const pad = value => String(value).padStart(2, '0');
  const modeName = mode => MODE_NAMES[mode] || String(mode || '');

  // The date in the local time of the browser, in the form of the input "datetime-local" (with the seconds).
  function inputValue(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  // The date for a person: the local time of the browser and, when it differs from UTC, the UTC time.
  function dateText(ms) {
    const date = new Date(ms);
    const utc = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
    const local = inputValue(ms).replace('T', ' ');
    return `${local} UTC` === utc ? utc : `${local} (${utc})`;
  }

  // The date for the API: an RFC 3339 text in UTC, with no fraction of a second.
  const apiDate = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const seconds = ms => Math.floor(ms / 1000);

  function bucketDefaultText(value) {
    if (!value) return 'None';
    const period = value.years ? `${value.years} ${value.years === 1 ? 'year' : 'years'}` : `${value.days || 0} ${value.days === 1 ? 'day' : 'days'}`;
    return `${modeName(value.mode)}, ${period}`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Retention section of the file details
  // ---------------------------------------------------------------------------------------------------------------

  // onChanged gets the new state after a save.
  async function mountSection(host, { key, instance = null, version = '', canWrite = false, onChanged = null }) {
    const editButton = h('button', { type: 'button', class: 'iconButton detailsEditButton', 'data-lock-edit': '', title: 'Edit the retention', 'aria-label': 'Edit the retention', 'aria-pressed': 'false', hidden: true }, icon('pencil-outline'));
    const body = h('div', { class: 'metaEditor lockEditor' }, h('span', { class: 'metaEditor__state' }, 'Loading the retention…'));
    host.replaceChildren(h('div', { class: 'bb-details-section-title' }, icon('shield-lock-outline'), ' Retention', editButton), body);

    let saved;
    // The difference between the clock of the server and the clock of the browser, read with the state.
    let skew = 0;
    const load = async () => {
      saved = await BB.api.objectLock(key, { version, instance });
      skew = Date.parse(saved.now) - Date.now();
      if (!Number.isFinite(skew)) skew = 0;
    };
    try {
      await load();
    } catch (error) {
      if (error?.status === 501 || error?.code === 'object_lock_unsupported') {
        host.remove();
        return;
      }
      body.replaceChildren(h('span', { class: 'metaEditor__state' }, error?.status === 403 ? 'You cannot read the retention of this object.' : `The retention cannot be loaded: ${error?.message || error}`));
      return;
    }

    const now = () => Date.now() + skew;
    const untilOf = retention => (retention ? Date.parse(retention.retainUntil) : NaN);
    const isActive = retention => Boolean(retention) && untilOf(retention) > now();

    let editing = false;
    let draft = null;
    const startDraft = () => ({
      legalHold: saved.legalHold === true,
      mode: saved.retention?.mode || GOVERNANCE,
      until: isActive(saved.retention) ? inputValue(untilOf(saved.retention)) : ''
    });

    // The change that the draft makes: the legal hold when the box changed, and the retention when the mode or the
    // date changed. An empty date means no change of the retention.
    function changes() {
      const result = {};
      if (draft.legalHold !== (saved.legalHold === true)) result.legalHold = draft.legalHold;
      if (draft.until) {
        const until = Date.parse(draft.until);
        const same = isActive(saved.retention) && seconds(until) === seconds(untilOf(saved.retention)) && draft.mode === saved.retention.mode;
        if (!same) result.retention = { mode: draft.mode, until };
      }
      return result;
    }
    const dirty = () => editing && Object.keys(changes()).length > 0;

    const view = h('div', { class: 'bb-kv metaEditor__view' });
    const note = h('p', { class: 'lockEditor__note', 'data-lock-note': '' });
    const form = h('div', { class: 'metaEditor__form lockEditor__form' });
    const message = h('p', { class: 'metaEditor__message', role: 'status', 'data-lock-message': '' });
    const saveButton = h('button', { type: 'button', class: 'bb-btn', 'data-lock-save': '' }, icon('check'), h('span', {}, 'Save retention'));
    const revertButton = h('button', { type: 'button', class: 'bb-btn', 'data-lock-revert': '' }, h('span', {}, 'Revert'));
    const actions = h('div', { class: 'metaEditor__actions' }, saveButton, revertButton);
    const say = (text, tone = '') => { message.textContent = text; message.dataset.tone = tone; };

    const row = (label, field, value) => h('div', { class: 'kv-row' }, h('div', { class: 'kv-k' }, label), h('div', { class: 'kv-v', 'data-lock-field': field }, value));

    function renderView() {
      const retention = saved.retention;
      const active = isActive(retention);
      const rows = [];
      if (!retention) rows.push(row('Mode', 'mode', 'No retention'));
      else {
        rows.push(row('Mode', 'mode', active ? modeName(retention.mode) : `${modeName(retention.mode)}, ended`));
        rows.push(row('Retain until', 'until', active ? dateText(untilOf(retention)) : `${dateText(untilOf(retention))}, ended`));
      }
      rows.push(row('Legal hold', 'legalHold', saved.legalHold ? 'On' : 'Off'));
      rows.push(row('Bucket default', 'default', bucketDefaultText(saved.bucketDefault)));
      view.replaceChildren(...rows);
      note.textContent = active ? MODE_NOTES[retention.mode] || '' : '';
      note.hidden = editing || !active;
    }

    const legalInput = h('input', { type: 'checkbox', 'data-lock-legal-hold': '', 'aria-label': 'Legal hold' });
    const modeSelect = h('select', { 'data-lock-mode': '', 'aria-label': 'Mode of the retention' },
      h('option', { value: GOVERNANCE }, 'Governance'), h('option', { value: COMPLIANCE }, 'Compliance'));
    const untilInput = h('input', { type: 'datetime-local', step: '1', class: 'input lockEditor__until', 'data-lock-until': '', 'aria-label': 'Retain until' });
    const formNotes = h('ul', { class: 'metaEditor__notes' });

    legalInput.addEventListener('change', () => { draft.legalHold = legalInput.checked; say(''); renderState(); });
    modeSelect.addEventListener('change', () => { draft.mode = modeSelect.value; say(''); renderState(); });
    untilInput.addEventListener('input', () => { draft.until = untilInput.value; say(''); renderState(); });

    form.append(
      h('label', { class: 'metaEditor__field' }, h('span', {}, 'Legal hold'),
        h('div', { class: 'lockEditor__check' }, legalInput, h('span', {}, 'Keep the version while the hold is on'))),
      h('label', { class: 'metaEditor__field' }, h('span', {}, 'Mode'), h('div', {}, h('span', { class: 'select' }, modeSelect))),
      h('label', { class: 'metaEditor__field' }, h('span', {}, 'Retain until'), untilInput),
      formNotes
    );

    function renderState() {
      const retention = saved.retention;
      const compliance = isActive(retention) && retention.mode === COMPLIANCE;
      modeSelect.disabled = compliance;
      const lines = ['Leave the date empty to keep the retention as it is. The legal hold goes on and off with no rule.'];
      if (compliance) lines.push(`This version has a Compliance retention until ${dateText(untilOf(retention))}. Nobody can shorten it. A later date is possible.`);
      else if (isActive(retention)) lines.push('A later date in the mode Governance needs no bypass. A shorter date, or the mode Compliance, asks for a confirmation.');
      formNotes.replaceChildren(...lines.map(text => h('li', {}, icon('information-outline'), text)));
      saveButton.disabled = !dirty();
      revertButton.disabled = !dirty();
    }

    function renderForm() {
      legalInput.checked = draft.legalHold;
      modeSelect.value = draft.mode;
      untilInput.value = draft.until;
      renderState();
    }

    function render() {
      editButton.hidden = !canWrite;
      editButton.setAttribute('aria-pressed', String(editing));
      editButton.classList.toggle('is-open', editing);
      view.hidden = editing;
      form.hidden = !editing;
      actions.hidden = !editing;
      renderView();
      if (editing) renderForm();
    }

    function startEdit() {
      editing = true;
      draft = startDraft();
      render();
    }

    function stopEdit() {
      editing = false;
      draft = null;
      render();
    }

    editButton.addEventListener('click', () => {
      say('');
      if (editing) stopEdit(); else startEdit();
    });
    revertButton.addEventListener('click', () => { draft = startDraft(); say(''); renderForm(); });

    // The checks before the request. It gives the text of an error, or the data of the request. bypass is true when
    // the change needs the confirmation of the bypass of the Governance retention.
    function checkRetention({ mode, until }) {
      if (!Number.isFinite(until)) return { error: 'Retain until needs a valid date and time.' };
      if (until <= now()) return { error: 'Retain until must be in the future.' };
      const limit = saved.maxRetentionDays || 36500;
      if (until - now() > limit * DAY_MS) return { error: `Retain until is at most ${limit.toLocaleString('en-US')} days from now.` };
      const retention = saved.retention;
      if (!isActive(retention)) return { bypass: '' };
      const old = untilOf(retention);
      if (retention.mode === COMPLIANCE) {
        if (seconds(until) < seconds(old)) return { error: `A Compliance retention cannot be shortened: nobody can shorten or remove it before ${dateText(old)}, not even the owner of the bucket.` };
        return { bypass: '' };
      }
      if (mode === COMPLIANCE) {
        return { bypass: `This change replaces the Governance retention with a Compliance retention until ${dateText(until)}. Nobody can shorten or remove a Compliance retention, not even the owner of the bucket.` };
      }
      if (seconds(until) < seconds(old)) {
        return { bypass: `This change shortens the Governance retention of this version from ${dateText(old)} to ${dateText(until)}. S3-Browser sends it with the bypass of the Governance retention (x-amz-bypass-governance-retention). The version can then be deleted from ${dateText(until)}.` };
      }
      return { bypass: '' };
    }

    saveButton.addEventListener('click', async () => {
      const change = changes();
      const request = { version: saved.version || version, instance };
      let bypass = false;
      if (change.retention) {
        const checked = checkRetention(change.retention);
        if (checked.error) { say(checked.error, 'error'); return; }
        if (checked.bypass) {
          const toCompliance = change.retention.mode === COMPLIANCE;
          const confirmed = await BB.ui.confirm({
            title: toCompliance ? 'Replace the Governance retention' : 'Bypass the Governance retention',
            message: checked.bypass,
            confirmLabel: toCompliance ? 'Replace and save' : 'Bypass and save'
          });
          if (!confirmed) return;
          bypass = true;
        }
        request.retention = { mode: change.retention.mode, retainUntil: apiDate(change.retention.until) };
        if (bypass) request.bypassGovernance = true;
      }
      if (change.legalHold !== undefined) request.legalHold = change.legalHold;
      saveButton.disabled = true;
      revertButton.disabled = true;
      say('Saving…');
      try {
        const response = await BB.api.putObjectLock(key, request);
        saved = response;
        skew = Date.parse(saved.now) - Date.now();
        if (!Number.isFinite(skew)) skew = 0;
        stopEdit();
        say('The retention is saved.', 'ok');
        document.dispatchEvent(new CustomEvent('bb:object-lock-changed', { detail: { key } }));
        if (onChanged) onChanged(response);
      } catch (failure) {
        if (failure?.status === 501) {
          host.remove();
          return;
        }
        say(failure?.status === 403 ? 'You cannot change the retention of this object.' : `The retention is not saved: ${failure?.message || failure}`, 'error');
        renderState();
      }
    });

    body.replaceChildren(view, note, form, actions, message);
    render();
  }

  BB.objectLock = { mountSection };
})();
