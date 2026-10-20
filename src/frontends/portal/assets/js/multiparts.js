/*
 * BB.multiparts: the window "Incomplete uploads" of the Actions menu.
 * - the incomplete multipart uploads of the folder (or of the bucket at the root), as a table with the start date, the
 *   parts, the size and the age of each upload;
 * - Abort selected, the abort button of a row, and "Abort everything older than N days", which runs as a job;
 * - the age comes from the clock of the server, not from the clock of the browser.
 * - the note about the lifecycle rules: a button opens the window of the lifecycle rules (lifecycle.js) with a new rule
 *   that aborts the incomplete uploads of the folder, where the provider keeps such a rule.
 * The server checks each request again. A provider without the list answers 501: the window says it in one line.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  // The most uploads of one request "Abort selected" (the limit of the server).
  const ABORT_BATCH = 1000;
  const MAX_DAYS = 36500;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

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

  const count = value => Number(value || 0).toLocaleString('en-US');
  const plural = (value, one, many = `${one}s`) => `${count(value)} ${Number(value) === 1 ? one : many}`;
  const formatBytes = value => (BB.versions?.formatBytes ? BB.versions.formatBytes(value) : `${count(value)} B`);

  // ---------------------------------------------------------------------------------------------------------------
  // The values of a row, in plain words
  // ---------------------------------------------------------------------------------------------------------------

  function formatAge(milliseconds) {
    if (milliseconds === null) return 'unknown';
    if (milliseconds >= DAY) return plural(Math.floor(milliseconds / DAY), 'day');
    if (milliseconds >= HOUR) return plural(Math.floor(milliseconds / HOUR), 'hour');
    if (milliseconds >= MINUTE) return plural(Math.floor(milliseconds / MINUTE), 'minute');
    return 'less than 1 minute';
  }

  // The row keeps the age that the server gave at the time of its answer: a later page has its own "now".
  function describe(upload, now) {
    const initiated = upload.initiated ? Date.parse(upload.initiated) : NaN;
    const dated = !Number.isNaN(initiated);
    const unknown = upload.partsUnknown === true;
    const atLeast = upload.partsAtLeast === true;
    return {
      key: upload.key,
      uploadId: upload.uploadId,
      active: upload.active === true,
      dated,
      started: dated ? (BB.versions?.formatDate ? BB.versions.formatDate(initiated) : new Date(initiated).toLocaleString()) : 'unknown',
      parts: unknown ? 'unknown' : `${atLeast ? 'at least ' : ''}${count(upload.parts)}`,
      size: unknown ? 'unknown' : `${atLeast ? 'at least ' : ''}${formatBytes(upload.bytes)}`,
      age: dated && !Number.isNaN(now) ? formatAge(Math.max(0, now - initiated)) : 'unknown'
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The answers of the server, in plain words
  // ---------------------------------------------------------------------------------------------------------------

  const distinct = items => [...new Set(items.map(item => item.reason).filter(Boolean))].slice(0, 3).join('; ');

  // The answer of "Abort selected": the uploads that the server aborted, kept, or could not abort.
  function selectedSummary({ aborted, skipped, failed }) {
    const parts = [];
    if (aborted.length) parts.push(`${plural(aborted.length, 'upload')} aborted.`);
    if (skipped.length) parts.push(`${plural(skipped.length, 'upload')} stayed${distinct(skipped) ? `: ${distinct(skipped)}` : ''}.`);
    if (failed.length) parts.push(`${plural(failed.length, 'upload')} not aborted${distinct(failed) ? `: ${distinct(failed)}` : ''}.`);
    return parts.length ? parts.join(' ') : 'No upload was aborted.';
  }

  // The counts of the job "older than": only the parts that are not zero.
  function olderSummary(result, days) {
    const parts = [];
    if (result.aborted) parts.push(`${plural(result.aborted, 'upload')} aborted.`);
    else if (!result.failed) parts.push(`No upload was older than ${plural(days, 'day')}.`);
    if (result.skippedUndated) parts.push(`${plural(result.skippedUndated, 'upload')} without a start date stayed.`);
    if (result.skippedRecent) parts.push(`${plural(result.skippedRecent, 'younger upload')} stayed.`);
    if (result.skippedActive) parts.push(`${plural(result.skippedActive, 'upload')} that S3-Browser sends now stayed.`);
    if (result.failed) parts.push(`${plural(result.failed, 'upload')} not aborted because of an error.`);
    return parts.join(' ');
  }

  function failureText(error, what) {
    if (error?.status === 403) return 'You cannot abort the incomplete uploads here.';
    if (error?.status === 501 || error?.code === 'multipart_unsupported') return 'This storage provider does not let S3-Browser list the incomplete uploads.';
    return `${what}: ${error?.message || error}`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The window
  // ---------------------------------------------------------------------------------------------------------------

  // The note about the lifecycle rules. The button closes this window and opens the window of the lifecycle rules, with
  // a new rule that aborts the uploads of the folder after 7 days where the provider keeps such a rule.
  async function renderLifecycleNote(note, { prefix, canWrite, instance, close }) {
    const lead = 'A lifecycle rule can abort the incomplete uploads by itself, a number of days after their start.';
    note.replaceChildren(lead);
    if (BB.cfg?.lifecycleSupported === false || !BB.lifecycle) return;
    const support = await BB.lifecycle.abortRuleSupport(instance);
    if (!support.supported || !note.isConnected) return;
    const prefill = support.offered && support.writable && canWrite;
    const button = h('button', { type: 'button', class: 'bb-btn multiparts__lifecycle', 'data-multipart-lifecycle': '' },
      icon('timer-sand'), h('span', {}, prefill ? 'Add a lifecycle rule' : 'Lifecycle rules'));
    button.addEventListener('click', () => {
      close();
      void BB.lifecycle.open({ instance, canWrite, prefix, prefill: prefill ? { id: 'abort-incomplete-uploads', prefix, abortMultipartDays: 7 } : null });
    });
    const unsupported = support.offered ? '' : support.reason || 'This storage provider does not keep a lifecycle rule that aborts them.';
    note.replaceChildren(h('span', {}, lead, unsupported ? ` ${unsupported}` : ''), button);
    note.dataset.abortRule = support.offered ? 'offered' : 'not-offered';
  }

  // prefix is the folder of the listing ('' for the bucket). canWrite tells if the person can abort. close closes the
  // window.
  function mount(host, { prefix = '', canWrite = false, instance = null, close = () => {} }) {
    let rows = [];
    let nextToken = '';
    let minimumHours = 24;
    let unsupported = false;
    let loaded = false;
    let busy = false;
    const selected = new Set();

    const scope = h('p', { class: 'multiparts__scope' }, prefix ? ['Under ', h('code', {}, prefix)] : 'In this bucket');
    const readonly = h('p', { class: 'multiparts__hint' }, 'You can see the incomplete uploads, but you cannot abort them.');
    readonly.hidden = canWrite;

    const abortSelectedButton = h('button', { type: 'button', class: 'bb-btn multiparts__danger', 'data-multipart-abort-selected': '', disabled: true }, icon('file-remove-outline'), h('span', {}, 'Abort selected'));
    const daysInput = h('input', { type: 'number', class: 'input', min: '1', step: '1', value: '1', 'aria-label': 'Number of days', 'data-multipart-older-days': '' });
    const abortOlderButton = h('button', { type: 'button', class: 'bb-btn multiparts__danger', 'data-multipart-abort-older': '' }, h('span', {}, 'Abort'));
    const olderGroup = h('div', { class: 'multiparts__older' }, h('span', {}, 'Abort everything older than'), daysInput, h('span', {}, 'days'), abortOlderButton);
    const controls = h('div', { class: 'multiparts__controls' }, abortSelectedButton, olderGroup);
    controls.hidden = true;

    const undated = h('p', { class: 'multiparts__hint', 'data-multipart-undated-note': '' });
    undated.hidden = true;

    const selectAll = h('input', { type: 'checkbox', 'aria-label': 'Select all the uploads', 'data-multipart-select-all': '' });
    const body = h('tbody');
    const table = h('div', { class: 'data-table-scroll multiparts__table' }, h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {},
        canWrite && h('th', { class: 'multiparts__check' }, selectAll),
        h('th', { class: 'multiparts__key' }, 'Key'),
        h('th', { class: 'multiparts__started' }, 'Started'),
        h('th', { class: 'multiparts__parts' }, 'Parts'),
        h('th', { class: 'multiparts__size' }, 'Size'),
        h('th', { class: 'multiparts__age' }, 'Age'),
        canWrite && h('th', { class: 'multiparts__action' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      body));
    table.hidden = true;

    const state = h('p', { class: 'multiparts__state' }, 'Loading the incomplete uploads…');
    const empty = h('p', { class: 'multiparts__empty' }, 'No incomplete upload');
    empty.hidden = true;
    const total = h('span', { class: 'multiparts__count' });
    const moreButton = h('button', { type: 'button', class: 'bb-btn', 'data-multipart-more': '' }, h('span', {}, 'Show more'));
    moreButton.hidden = true;
    const footer = h('div', { class: 'multiparts__footer' }, total, moreButton);
    footer.hidden = true;
    const message = h('p', { class: 'multiparts__message', role: 'status', 'data-multipart-message': '' });
    const note = h('p', { class: 'multiparts__note', 'data-multipart-lifecycle-note': '' });
    const say = (text, tone = '') => { message.textContent = text; message.dataset.tone = tone; };

    // The parts of the window that follow each change: the buttons, the state of the checkboxes and the notes.
    function renderState() {
      const selectable = rows.filter(row => !row.active);
      const picked = selectable.filter(row => selected.has(row)).length;
      abortSelectedButton.disabled = busy || picked === 0;
      daysInput.disabled = busy;
      abortOlderButton.disabled = busy;
      moreButton.disabled = busy;
      selectAll.disabled = busy;
      selectAll.checked = selectable.length > 0 && picked === selectable.length;
      selectAll.indeterminate = picked > 0 && picked < selectable.length;
      for (const node of host.querySelectorAll('[data-multipart-select], [data-multipart-abort-one]')) node.disabled = busy;
      const dateless = rows.filter(row => !row.dated).length;
      undated.hidden = !canWrite || dateless === 0;
      if (dateless) {
        const them = dateless === 1 ? 'it' : 'them';
        undated.textContent = `The storage provider gives no start date for ${plural(dateless, 'upload')}. S3-Browser does not abort ${them} by age: select ${them} and use Abort selected.`;
      }
      total.textContent = `${plural(rows.length, 'upload')}${nextToken ? ' shown' : ''}`;
    }

    function setBusy(value) {
      busy = value;
      renderState();
    }

    function rowNode(row) {
      const check = canWrite && !row.active
        ? h('input', { type: 'checkbox', 'aria-label': `Select ${row.key}`, 'data-multipart-select': '' })
        : null;
      if (check) {
        check.checked = selected.has(row);
        check.addEventListener('change', () => {
          if (check.checked) selected.add(row); else selected.delete(row);
          renderState();
        });
      }
      const abortOne = canWrite && !row.active
        ? h('button', { type: 'button', class: 'iconButton', title: 'Abort this upload', 'aria-label': 'Abort this upload', 'data-multipart-abort-one': '' }, icon('file-remove-outline'))
        : null;
      if (abortOne) abortOne.addEventListener('click', () => { void abort([row]); });
      return h('tr', { 'data-upload-id': row.uploadId, 'data-key': row.key },
        canWrite && h('td', { class: 'multiparts__check' }, check),
        h('td', { class: 'multiparts__key', title: row.key }, h('div', { class: 'multiparts__keyline' },
          h('span', { class: 'multiparts__name mono' }, row.key),
          row.active && h('span', { class: 'badge badge--ok multiparts__active' }, 'Uploading now'))),
        h('td', { class: 'multiparts__started' }, row.started),
        h('td', { class: 'multiparts__parts' }, row.parts),
        h('td', { class: 'multiparts__size' }, row.size),
        h('td', { class: 'multiparts__age' }, row.age),
        canWrite && h('td', { class: 'multiparts__action' }, abortOne));
    }

    // added is the list of the new rows after "Show more", or null when the table starts again.
    function render(added = null) {
      const none = loaded && !unsupported && rows.length === 0;
      state.hidden = loaded;
      empty.hidden = !none;
      table.hidden = unsupported || rows.length === 0;
      controls.hidden = !canWrite || unsupported || none || !loaded;
      footer.hidden = unsupported || rows.length === 0;
      moreButton.hidden = !nextToken;
      if (unsupported) {
        state.hidden = false;
        state.textContent = 'This storage provider does not let S3-Browser list the incomplete uploads.';
      }
      if (added) body.append(...added.map(rowNode));
      else body.replaceChildren(...rows.map(rowNode));
      renderState();
    }

    // Read one page. The first page starts the list again and drops the selection.
    async function load(more = false) {
      if (!host.isConnected) return;
      setBusy(true);
      try {
        const page = await BB.api.multiparts({ prefix, token: more ? nextToken : '', instance });
        const now = Date.parse(page.now);
        const known = new Set(more ? rows.map(row => `${row.uploadId}\n${row.key}`) : []);
        const added = (page.uploads || []).map(upload => describe(upload, now)).filter(row => !known.has(`${row.uploadId}\n${row.key}`));
        if (!more) { rows = []; selected.clear(); }
        rows = rows.concat(added);
        nextToken = page.nextToken || '';
        minimumHours = Number(page.minimumAbortAgeHours) || minimumHours;
        unsupported = false;
        loaded = true;
        render(more ? added : null);
      } catch (error) {
        if (error?.status === 501 || error?.code === 'multipart_unsupported') {
          unsupported = true;
          loaded = true;
          rows = [];
          nextToken = '';
          render();
        } else {
          state.textContent = loaded ? state.textContent : 'The incomplete uploads cannot be loaded.';
          say(failureText(error, 'The incomplete uploads cannot be loaded'), 'error');
        }
      } finally {
        setBusy(false);
      }
    }

    // Abort the listed rows at any age, then read the list again.
    async function abort(items) {
      const names = items.length === 1 ? `the incomplete upload of ${items[0].key}` : `${plural(items.length, 'incomplete upload')}`;
      const confirmed = await BB.ui.confirm({
        title: 'Abort incomplete uploads',
        message: `Abort ${names}? The parts are deleted and ${items.length === 1 ? 'the upload cannot' : 'the uploads cannot'} continue.`,
        confirmLabel: 'Abort'
      });
      if (!confirmed) return;
      setBusy(true);
      say('Aborting…');
      try {
        const outcome = { aborted: [], skipped: [], failed: [] };
        for (let start = 0; start < items.length; start += ABORT_BATCH) {
          const uploads = items.slice(start, start + ABORT_BATCH).map(({ key, uploadId }) => ({ key, uploadId }));
          const result = await BB.api.abortMultiparts({ uploads, instance });
          for (const name of Object.keys(outcome)) outcome[name].push(...(result[name] || []));
        }
        await load(false);
        say(selectedSummary(outcome), outcome.failed.length ? 'error' : 'ok');
      } catch (error) {
        await load(false);
        say(failureText(error, 'The abort failed'), 'error');
      } finally {
        setBusy(false);
      }
    }

    // Abort each upload with a start date older than the number of days: a job of the server.
    async function abortOlder() {
      const days = Number(daysInput.value);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
        say(`The number of days is a whole number from 1 to ${count(MAX_DAYS)}.`, 'error');
        return;
      }
      // The two numbers are integers: the text has no data of the storage.
      const confirmed = await BB.ui.confirm({
        title: 'Abort incomplete uploads',
        html: `<p>Abort the incomplete uploads that started more than ${plural(days, 'day')} ago? The parts are deleted and the uploads cannot continue.</p>`
          + `<p>These uploads stay: an upload without a start date, an upload younger than ${plural(minimumHours, 'hour')}, and an upload that this S3-Browser sends now.</p>`,
        confirmLabel: 'Abort'
      });
      if (!confirmed) return;
      setBusy(true);
      say('Aborting…');
      try {
        const started = await BB.api.abortMultiparts({ olderThanDays: days, prefix, instance });
        const job = await BB.api.waitForJob(started, {
          onUpdate: update => say(update.multipartAbort?.aborted ? `Aborting… ${count(update.multipartAbort.aborted)} aborted` : 'Aborting…')
        });
        await load(false);
        if (job.status !== 'completed') say('The job is paused. The uploads that it aborted before are gone.');
        else say(olderSummary(job.multipartAbort || {}, days), job.multipartAbort?.failed ? 'error' : 'ok');
      } catch (error) {
        await load(false);
        say(failureText(error, 'The abort failed'), 'error');
      } finally {
        setBusy(false);
      }
    }

    abortSelectedButton.addEventListener('click', () => {
      const items = rows.filter(row => selected.has(row) && !row.active);
      if (items.length) void abort(items);
    });
    abortOlderButton.addEventListener('click', () => { void abortOlder(); });
    daysInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void abortOlder(); } });
    moreButton.addEventListener('click', () => { void load(true); });
    selectAll.addEventListener('change', () => {
      for (const check of body.querySelectorAll('[data-multipart-select]')) check.checked = selectAll.checked;
      for (const row of rows) {
        if (row.active) continue;
        if (selectAll.checked) selected.add(row); else selected.delete(row);
      }
      renderState();
    });

    host.replaceChildren(scope, readonly, controls, undated, state, empty, table, footer, message, note);
    render();
    void renderLifecycleNote(note, { prefix, canWrite, instance, close });
    void load(false);
  }

  // Open the window. prefix is the folder of the listing, canWrite tells if the person can abort.
  function open({ prefix = '', canWrite = false, instance = null } = {}) {
    return BB.ui.alert({
      title: 'Incomplete uploads',
      large: true,
      onOpen: ({ modal }) => {
        const body = modal.querySelector('.bb-modal-body');
        const root = h('div', { class: 'multiparts', 'data-multiparts': '' });
        body.replaceChildren(root);
        mount(root, { prefix, canWrite, instance, close: () => modal.querySelector('.bb-modal-x')?.click() });
      }
    });
  }

  BB.multiparts = { open, formatAge, selectedSummary, olderSummary };
})();
