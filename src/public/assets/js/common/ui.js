/*!
 * BB.ui — minimal modal/toast utilities (framework-agnostic)
 * - Alert / Confirm / Prompt rendered as centered overlay with backdrop
 * - ESC / click on backdrop closes (confirm stays on OK)
 * - Focus management for accessibility
 * - Small toast in bottom-right
 */
(function () {
  const BB = (window.BB = window.BB || {});
  let domSequence = 0; // unique, token-safe ids for aria-labelledby references

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  let scrollLockDepth = 0;
  let scrollLockState = null;

  function lockScroll(lock) {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;

    if (lock) {
      scrollLockDepth += 1;
      if (scrollLockDepth > 1) return;

      const scrollbarWidth = Math.max(0, Number(window.innerWidth || 0) - Number(root.clientWidth || 0));
      const computedBodyPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

      scrollLockState = {
        rootOverflow: root.style.overflow || '',
        bodyOverflow: body.style.overflow || '',
        rootOverscrollBehavior: root.style.overscrollBehavior || '',
        bodyOverscrollBehavior: body.style.overscrollBehavior || '',
        rootScrollbarGutter: root.style.scrollbarGutter || '',
        bodyScrollbarGutter: body.style.scrollbarGutter || '',
        bodyPaddingRight: body.style.paddingRight || '',
        scrollX: Number(window.scrollX || window.pageXOffset || 0),
        scrollY: Number(window.scrollY || window.pageYOffset || 0)
      };

      root.classList.add('bb-no-scroll');
      body.classList.add('bb-no-scroll');
      root.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
      root.style.overscrollBehavior = 'none';
      body.style.overscrollBehavior = 'none';
      root.style.scrollbarGutter = 'auto';
      body.style.scrollbarGutter = 'auto';
      if (scrollbarWidth > 0) {
        body.style.paddingRight = `${computedBodyPaddingRight + scrollbarWidth}px`;
      }
      return;
    }

    if (scrollLockDepth === 0) return;
    scrollLockDepth -= 1;
    if (scrollLockDepth > 0) return;

    const previous = scrollLockState;
    scrollLockState = null;
    root.classList.remove('bb-no-scroll');
    body.classList.remove('bb-no-scroll');
    root.style.overflow = previous?.rootOverflow || '';
    body.style.overflow = previous?.bodyOverflow || '';
    root.style.overscrollBehavior = previous?.rootOverscrollBehavior || '';
    body.style.overscrollBehavior = previous?.bodyOverscrollBehavior || '';
    root.style.scrollbarGutter = previous?.rootScrollbarGutter || '';
    body.style.scrollbarGutter = previous?.bodyScrollbarGutter || '';
    body.style.paddingRight = previous?.bodyPaddingRight || '';

    if (previous && typeof window.scrollTo === 'function') {
      window.scrollTo(previous.scrollX, previous.scrollY);
    }
  }

  let modalSequence = 0;

  function buildModal({ title = '', message = '', html = '', kind = 'alert', defaultValue = '', confirmLabel = 'OK', cancelLabel = 'Cancel' }) {
    const overlay = el('div', 'bb-overlay', '');
    const modal = el('div', 'bb-modal', '');
    modal.setAttribute('role', kind === 'alert' ? 'dialog' : 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.tabIndex = -1;

    const btnClose = el('button', 'btn btn-sm btn-ghost bb-modal-x', '<i class="mdi mdi-close"></i>');
    btnClose.setAttribute('aria-label', 'Close');
    var header = void 0;
    if (title != '' || html == '') {
      header = el('div', 'bb-modal-header', '');
      const hTitle = el('div', 'bb-modal-title', '');
      hTitle.textContent = title || '';
      hTitle.id = `bb-modal-title-${++modalSequence}`;
      hTitle.setAttribute('role', 'heading');
      hTitle.setAttribute('aria-level', '2');
      modal.setAttribute('aria-labelledby', hTitle.id);
      header.append(hTitle, btnClose);
    }


    const body = el('div', 'bb-modal-body', '');
    const looksCode = typeof message === 'string' && (message.includes('\n') || message.includes('{') || message.length > 120);
    if (kind === 'prompt') {
      const msg = el('div', 'bb-modal-text', '');
      msg.textContent = message || '';
      const input = el('input', 'bb-input', '');
      input.type = 'text';
      input.value = defaultValue || '';
      input.placeholder = defaultValue || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', message || title || 'Value');
      body.append(msg, input);
   } else if (html) {
      const wrap = el('div', 'bb-modal-html', '');
      wrap.innerHTML = String(html || '');
      const heading = wrap.querySelector('.bb-details-name');
      if (heading) {
        heading.id = `bb-modal-title-${++modalSequence}`;
        heading.setAttribute('role', 'heading');
        heading.setAttribute('aria-level', '2');
        modal.setAttribute('aria-labelledby', heading.id);
      } else {
        modal.setAttribute('aria-label', 'Dialog');
      }
      if (title == '' && html != '') {
        wrap.prepend(btnClose);
      }
      body.append(wrap);
    } else {
      if (looksCode) {
        const pre = el('pre', 'bb-pre', '');
        pre.textContent = String(message || '');
        body.append(pre);
      } else {
        const msg = el('div', 'bb-modal-text', '');
        msg.textContent = message || '';
        body.append(msg);
      }
    }

    const footer = el('div', 'bb-modal-actions', '');
    const btnCancel = el('button', 'btn btn-sm', '');
    btnCancel.textContent = cancelLabel || 'Cancel';
    const btnOk = el('button', 'btn btn-sm btn-primary', '');
    btnOk.textContent = confirmLabel || 'OK';
    if (kind != 'alert') {
      footer.append(btnCancel, btnOk);
    }
    if (title != '' || html == '') {
      modal.append(header);
    }
    modal.append(body, footer);
    overlay.append(modal);
    return { overlay, modal, header, body, footer, btnCancel, btnOk, btnClose };
  }

  function focusableIn(root) {
    // Tab order, not just focusability: a roving-tabindex tab with tabindex="-1" is never the last Tab stop.
    return Array.from(root.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]'))
      .filter((node) => !node.disabled && node.tabIndex >= 0 && node.offsetParent !== null);
  }

  // Keep Tab inside the modal, as aria-modal promises assistive technology.
  function trapTab(event, overlay) {
    if (event.key !== 'Tab') return;
    const nodes = focusableIn(overlay);
    if (!nodes.length) {
      event.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function attachAndShow(overlay) {
    // A dialog opened from a menu item returns focus to the control that owns the menu, not to the hidden item.
    let opener = document.activeElement;
    const ownerMenu = opener && opener.closest ? opener.closest('.bb-menu') : null;
    if (ownerMenu) opener = ownerMenu.querySelector('.bb-menu-trigger, .bb-kebab') || opener;
    overlay._bbReturnFocus = opener;
    overlay.addEventListener('keydown', (e) => trapTab(e, overlay));
    document.body.appendChild(overlay);
    lockScroll(true);
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    // Alerts have no input or default button: focus the dialog itself so Escape reaches it.
    const modal = overlay.querySelector('.bb-modal');
    if (modal) modal.focus({ preventScroll: true });
  }

  function cleanup(overlay) {
    if (overlay.dataset.bbClosing === 'true') return;
    overlay.dataset.bbClosing = 'true';
    overlay.classList.remove('is-open');
    setTimeout(() => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      lockScroll(false);
      const back = overlay._bbReturnFocus;
      const usable = back && back.isConnected && back.offsetParent !== null && typeof back.focus === 'function';
      // If the opener is gone (row deleted, list refreshed), fall back to the main content so focus never drops to <body>.
      const target = usable ? back : document.getElementById('main-content') || document.querySelector('main');
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }, 120);
  }

  async function alert({ title = '', message = '', html = '', onOpen = null }) {
    return new Promise((resolve) => {
      const { overlay, btnOk, btnClose } = buildModal({ title, message, html, kind: 'alert' });

      function close() { cleanup(overlay); resolve(); }
      btnClose.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

      attachAndShow(overlay);
      if (typeof onOpen === 'function') {
        try { onOpen({ overlay, modal: overlay.querySelector('.bb-modal') }); }
        catch (error) { console.error('modal onOpen failed', error); }
      }
      // A dialog built around tabs starts on its selected tab: a focused control, not the bare dialog box.
      overlay.querySelector('[role="tab"][aria-selected="true"], [role="tab"]')?.focus({ preventScroll: true });
    });
  }

  async function confirm({ title = '', message = '', html = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const { overlay, btnOk, btnCancel, btnClose } = buildModal({
        title,
        message,
        html,
        kind: 'confirm',
        confirmLabel,
        cancelLabel
      });
      if (danger) btnOk.classList.replace('btn-primary', 'btn-danger');

      function yes() { cleanup(overlay); resolve(true); }
      function no()  { cleanup(overlay); resolve(false); }

      btnOk.addEventListener('click', yes);
      btnCancel.addEventListener('click', no);
      btnClose.addEventListener('click', no);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) no(); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') no(); });

      attachAndShow(overlay);
      btnCancel.focus();
    });
  }

  async function prompt({ title = '', message = '', defaultValue = '' }) {
    return new Promise((resolve) => {
      const { overlay, body, btnOk, btnCancel, btnClose } = buildModal({ title, message, kind: 'prompt', defaultValue });
      const input = $('.bb-input', body);

      function ok() { const v = input.value; cleanup(overlay); resolve(v != null ? v : ''); }
      function cancel() { cleanup(overlay); resolve(null); }

      btnOk.addEventListener('click', ok);
      btnCancel.addEventListener('click', cancel);
      btnClose.addEventListener('click', cancel);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') cancel();
        if (e.key === 'Enter' && e.target === input) ok();
      });

      attachAndShow(overlay);
      input.focus();
      input.select();
    });
  }

  function toast(message = '', {
    duration = 5000,
    persistent = false,
    type = '',
    status = type,
    progress,
    indeterminate = false,
    detail = '',
    actions = []
  } = {}) {
    let host = $('#bb-toast-host');
    if (!host) {
      host = el('div', 'bb-toast-host', '');
      host.id = 'bb-toast-host';
      document.body.appendChild(host);
    }

    const t = el('div', 'bb-toast', '');
    t.setAttribute('role', 'status');
    const closeButton = el('button', 'bb-toast-close', '<i class="mdi mdi-close" aria-hidden="true"></i>');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Dismiss notification');
    const icon = el('i', 'mdi bb-toast-icon', '');
    const content = el('div', 'bb-toast-content', '');
    const copy = el('div', 'bb-toast-message', '');
    const detailNode = el('div', 'bb-toast-detail', '');
    const progressTrack = el('div', 'bb-toast-progress', '');
    const progressBar = el('div', 'bb-toast-progress-bar', '');
    const actionRow = el('div', 'bb-toast-actions', '');
    progressTrack.setAttribute('role', 'progressbar');
    copy.id = `bb-toast-message-${++domSequence}`;
    progressTrack.setAttribute('aria-labelledby', copy.id);
    progressTrack.appendChild(progressBar);
    content.append(copy, detailNode, progressTrack, actionRow);
    t.append(icon, content, closeButton);
    host.appendChild(t);

    let currentStatus = '';
    let currentPersistent = !!persistent;
    let currentDuration = duration;
    let currentProgress = undefined;
    let currentIndeterminate = !!indeterminate;
    let removalTimer = 0;
    let removed = false;
    const actionButtons = new Map();

    function hide() {
      if (removed) return;
      removed = true;
      window.clearTimeout(removalTimer);
      t.classList.remove('is-show');
      window.setTimeout(() => t.remove(), 200);
    }

    // Timing is adjustable: hovering or focusing a toast pauses its dismissal, and it can be closed at any time.
    let deadline = 0;
    let remaining = 0;
    let engaged = false;

    function scheduleRemoval(nextDuration) {
      window.clearTimeout(removalTimer);
      remaining = Math.max(4000, Number(nextDuration) || 0);
      if (engaged) return;
      deadline = Date.now() + remaining;
      removalTimer = window.setTimeout(hide, remaining);
    }

    function engage() {
      if (engaged || removed || currentPersistent) return;
      engaged = true;
      window.clearTimeout(removalTimer);
      remaining = Math.max(2000, deadline - Date.now());
    }

    function release() {
      if (!engaged || t.matches(':hover, :focus-within')) return;
      engaged = false;
      if (!removed && !currentPersistent) scheduleRemoval(remaining);
    }

    t.addEventListener('pointerenter', engage);
    t.addEventListener('pointerleave', release);
    t.addEventListener('focusin', engage);
    t.addEventListener('focusout', () => window.setTimeout(release, 0));
    closeButton.addEventListener('click', () => { window.clearTimeout(removalTimer); hide(); });

    function setStatus(nextStatus) {
      currentStatus = ['loading', 'success', 'error', 'paused', 'warning', 'info'].includes(nextStatus) ? nextStatus : '';
      t.classList.remove('is-loading', 'is-success', 'is-error', 'is-paused', 'is-warning', 'is-info');
      t.setAttribute('role', currentStatus === 'error' ? 'alert' : 'status');
      icon.className = 'mdi bb-toast-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.hidden = false;

      if (currentStatus === 'loading') {
        t.classList.add('is-loading');
        icon.classList.add('mdi-loading', 'mdi-spin');
      } else if (currentStatus === 'success') {
        t.classList.add('is-success');
        icon.classList.add('mdi-check-circle-outline');
      } else if (currentStatus === 'error') {
        t.classList.add('is-error');
        icon.classList.add('mdi-alert-circle-outline');
      } else if (currentStatus === 'paused') {
        t.classList.add('is-paused');
        icon.classList.add('mdi-pause-circle-outline');
      } else if (currentStatus === 'warning') {
        t.classList.add('is-warning');
        icon.classList.add('mdi-alert-outline');
      } else if (currentStatus === 'info') {
        t.classList.add('is-info');
        icon.classList.add('mdi-information-outline');
      } else {
        icon.hidden = true;
      }
    }

    function setDetail(nextDetail) {
      detailNode.textContent = String(nextDetail || '');
      detailNode.title = detailNode.textContent;
      detailNode.hidden = !detailNode.textContent;
      t.classList.toggle('has-detail', !detailNode.hidden);
    }

    function setProgress(nextProgress, nextIndeterminate) {
      if (nextProgress !== undefined) currentProgress = nextProgress;
      if (nextIndeterminate !== undefined) currentIndeterminate = !!nextIndeterminate;

      const numeric = Number(currentProgress);
      const hasNumericProgress = currentProgress !== null
        && currentProgress !== undefined
        && Number.isFinite(numeric);
      const visible = hasNumericProgress || currentIndeterminate;
      progressTrack.hidden = !visible;
      t.classList.toggle('has-progress', visible);
      progressTrack.classList.toggle('is-indeterminate', visible && currentIndeterminate && !hasNumericProgress);

      if (!visible) {
        progressTrack.removeAttribute('aria-valuenow');
        progressBar.style.removeProperty('--progress');
        return;
      }
      progressTrack.setAttribute('aria-valuemin', '0');
      progressTrack.setAttribute('aria-valuemax', '100');
      if (hasNumericProgress) {
        const bounded = Math.max(0, Math.min(1, numeric));
        progressTrack.setAttribute('aria-valuenow', String(Math.round(bounded * 100)));
        progressBar.style.setProperty('--progress', String(bounded));
      } else {
        progressTrack.removeAttribute('aria-valuenow');
        progressBar.style.removeProperty('--progress');
      }
    }

    function setActions(nextActions) {
      const list = Array.isArray(nextActions) ? nextActions : [];
      const activeKeys = new Set();
      list.forEach((action, index) => {
        if (!action || typeof action.onClick !== 'function') return;
        const key = String(action.id || `${action.label || 'action'}:${action.icon || ''}:${index}`);
        activeKeys.add(key);
        let button = actionButtons.get(key);
        if (!button) {
          button = el('button', 'bb-toast-action', '');
          button.type = 'button';
          button.dataset.actionKey = key;
          button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const currentAction = button.bbToastAction;
            if (!currentAction || button.disabled) return;
            try {
              const result = currentAction.onClick(controller);
              if (result && typeof result.catch === 'function') {
                result.catch(error => console.error('toast action failed', error));
              }
            } catch (error) {
              console.error('toast action failed', error);
            }
          });
          actionButtons.set(key, button);
        }

        button.bbToastAction = action;
        button.className = `bb-toast-action${action.danger ? ' is-danger' : ''}`;
        button.disabled = !!action.disabled;
        button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
        button.title = String(action.title || action.label || 'Action');

        const iconClass = action.icon ? `mdi mdi-${action.icon}` : '';
        const currentIcon = button.querySelector('i');
        if (iconClass) {
          const actionIcon = currentIcon || el('i', '', '');
          actionIcon.className = iconClass;
          if (!currentIcon) button.prepend(actionIcon);
        } else if (currentIcon) {
          currentIcon.remove();
        }

        let labelNode = button.querySelector('.bb-toast-action-label');
        if (!labelNode) {
          labelNode = el('span', 'bb-toast-action-label', '');
          button.appendChild(labelNode);
        }
        labelNode.textContent = String(action.label || 'Action');

        const expected = actionRow.children[index];
        if (button.parentNode !== actionRow) actionRow.insertBefore(button, expected || null);
        else if (expected !== button) actionRow.insertBefore(button, expected || null);
      });

      for (const [key, button] of actionButtons) {
        if (activeKeys.has(key)) continue;
        button.remove();
        actionButtons.delete(key);
      }
      actionRow.hidden = actionRow.childElementCount === 0;
      t.classList.toggle('has-actions', !actionRow.hidden);
    }

    const controller = {
      element: t,
      update(nextMessage, options = {}) {
        if (removed) return controller;
        if (nextMessage !== undefined) {
          copy.textContent = String(nextMessage || '');
          copy.title = copy.textContent;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'detail')) setDetail(options.detail);
        if (Object.prototype.hasOwnProperty.call(options, 'status')) setStatus(options.status);
        if (Object.prototype.hasOwnProperty.call(options, 'progress')
          || Object.prototype.hasOwnProperty.call(options, 'indeterminate')) {
          setProgress(options.progress, options.indeterminate);
        }
        if (Object.prototype.hasOwnProperty.call(options, 'actions')) setActions(options.actions);
        if (Object.prototype.hasOwnProperty.call(options, 'persistent')) currentPersistent = !!options.persistent;
        if (Object.prototype.hasOwnProperty.call(options, 'duration')) currentDuration = options.duration;
        window.clearTimeout(removalTimer);
        if (!currentPersistent) scheduleRemoval(currentDuration);
        return controller;
      },
      close(delay = 0) {
        if (removed) return;
        window.clearTimeout(removalTimer);
        if (Number(delay) > 0) removalTimer = window.setTimeout(hide, Math.max(1000, Number(delay)));
        else hide();
      }
    };

    setStatus(status);
    setDetail(detail);
    setProgress(progress, indeterminate);
    setActions(actions);
    copy.textContent = String(message || '');
    copy.title = copy.textContent;
    requestAnimationFrame(() => t.classList.add('is-show'));
    if (!currentPersistent) scheduleRemoval(currentDuration);
    return controller;
  }


  const transferGroups = new Map();

  function transferGroup(kind = 'transfer') {
    const normalizedKind = String(kind || 'transfer').toLowerCase();
    const existing = transferGroups.get(normalizedKind);
    if (existing && !existing.closed) return existing;

    let host = $('#bb-toast-host');
    if (!host) {
      host = el('div', 'bb-toast-host', '');
      host.id = 'bb-toast-host';
      document.body.appendChild(host);
    }

    const labels = {
      upload: { title: 'Uploads', icon: 'cloud-upload-outline' },
      download: { title: 'Downloads', icon: 'cloud-download-outline' },
      comparison: { title: 'Version comparison', icon: 'swap-vertical' }
    };
    const label = labels[normalizedKind] || { title: 'Transfers', icon: 'swap-vertical' };
    const panel = el('div', `bb-transfer-panel is-${normalizedKind}`, '');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', label.title);

    const header = el('div', 'bb-transfer-header', '');
    const heading = el('div', 'bb-transfer-heading', '');
    const headingIcon = el('i', `mdi mdi-${label.icon}`, '');
    const headingCopy = el('div', 'bb-transfer-heading-copy', '');
    const headingTitle = el('strong', '', '');
    headingTitle.textContent = label.title;
    const headingSummary = el('span', 'bb-transfer-summary', '');
    headingSummary.setAttribute('role', 'status');
    headingSummary.textContent = 'Preparing...';
    headingCopy.append(headingTitle, headingSummary);
    heading.append(headingIcon, headingCopy);

    const groupActions = el('div', 'bb-transfer-group-actions', '');
    const pauseButton = el('button', 'bb-transfer-group-action', '<i class="mdi mdi-pause"></i><span>Pause</span>');
    pauseButton.type = 'button';
    pauseButton.title = 'Pause active transfers';
    const resumeButton = el('button', 'bb-transfer-group-action', '<i class="mdi mdi-play"></i><span>Resume</span>');
    resumeButton.type = 'button';
    resumeButton.title = 'Resume paused transfers';
    const cancelButton = el('button', 'bb-transfer-group-action is-danger', '<i class="mdi mdi-close"></i><span>Cancel</span>');
    cancelButton.type = 'button';
    cancelButton.title = 'Cancel pending transfers';
    groupActions.append(pauseButton, resumeButton, cancelButton);
    header.append(heading, groupActions);

    const list = el('div', 'bb-transfer-list', '');
    panel.append(header, list);
    host.appendChild(panel);
    requestAnimationFrame(() => panel.classList.add('is-show'));

    const items = new Map();
    let closed = false;
    let sequence = 0;
    let removalTimer = 0;

    function boundedProgress(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : null;
    }

    function statusIcon(status) {
      if (status === 'completed') return 'check-circle-outline';
      if (status === 'paused') return 'pause-circle-outline';
      if (status === 'error') return 'alert-circle-outline';
      if (status === 'canceled') return 'close-circle-outline';
      if (status === 'queued') return 'clock-outline';
      return 'loading';
    }

    function activeCounts() {
      const values = Array.from(items.values());
      return {
        total: values.length,
        active: values.filter(item => ['queued', 'preparing', 'running'].includes(item.state.status)).length,
        paused: values.filter(item => item.state.status === 'paused').length,
        completed: values.filter(item => item.state.status === 'completed').length,
        failed: values.filter(item => item.state.status === 'error').length
      };
    }

    function updateHeader() {
      const counts = activeCounts();
      const parts = [];
      if (counts.active) parts.push(`${counts.active} active`);
      if (counts.paused) parts.push(`${counts.paused} paused`);
      if (counts.failed) parts.push(`${counts.failed} failed`);
      if (counts.completed && !counts.active && !counts.paused && !counts.failed) parts.push(`${counts.completed} completed`);
      headingSummary.textContent = parts.join(' · ') || 'No active transfers';

      const canPause = Array.from(items.values()).some(item =>
        ['queued', 'preparing', 'running'].includes(item.state.status) && typeof item.handlers.pause === 'function'
      );
      const canResume = Array.from(items.values()).some(item =>
        item.state.status === 'paused' && typeof item.handlers.resume === 'function'
      );
      const canCancel = Array.from(items.values()).some(item =>
        !['completed', 'canceled'].includes(item.state.status) && typeof item.handlers.cancel === 'function'
      );
      pauseButton.hidden = !canPause;
      resumeButton.hidden = !canResume;
      cancelButton.hidden = !canCancel;
      groupActions.hidden = !canPause && !canResume && !canCancel;
    }

    function schedulePanelRemoval() {
      window.clearTimeout(removalTimer);
      const values = Array.from(items.values());
      if (!values.length) {
        removalTimer = window.setTimeout(close, 250);
        return;
      }
      const hasActive = values.some(item => ['queued', 'preparing', 'running', 'paused', 'error'].includes(item.state.status));
      if (!hasActive) removalTimer = window.setTimeout(close, 5000);
    }

    function invokeTransferAction(action) {
      if (typeof action !== 'function') return;
      try {
        const result = action();
        if (result && typeof result.catch === 'function') {
          result.catch(error => console.error('transfer action failed', error));
        }
      } catch (error) {
        console.error('transfer action failed', error);
      }
    }

    function installRowActionButton(button) {
      const actionIcon = el('i', 'mdi', '');
      button.appendChild(actionIcon);
      button.bbTransferAction = null;
      button.bbPressedTransferAction = null;
      button.bbPressedPointerId = null;
      button.bbPointerInvokedAt = 0;

      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || button.disabled || typeof button.bbTransferAction !== 'function') return;
        event.preventDefault();
        event.stopPropagation();
        button.bbPressedTransferAction = button.bbTransferAction;
        button.bbPressedPointerId = event.pointerId;
        try { button.setPointerCapture(event.pointerId); } catch (_) {}
      });

      const clearPointerAction = event => {
        if (button.bbPressedPointerId !== null && event.pointerId !== button.bbPressedPointerId) return null;
        const action = button.bbPressedTransferAction;
        button.bbPressedTransferAction = null;
        button.bbPressedPointerId = null;
        try {
          if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
        } catch (_) {}
        return action;
      };

      button.addEventListener('pointerup', event => {
        const action = clearPointerAction(event);
        if (typeof action !== 'function') return;
        event.preventDefault();
        event.stopPropagation();
        button.bbPointerInvokedAt = Date.now();
        invokeTransferAction(action);
      });
      button.addEventListener('pointercancel', clearPointerAction);

      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        // Pointer activation is handled on pointerup so progress re-renders
        // cannot make the browser lose the click target. Keyboard activation
        // still arrives here with detail=0.
        if (Date.now() - Number(button.bbPointerInvokedAt || 0) < 500) return;
        invokeTransferAction(button.bbTransferAction);
      });
      return actionIcon;
    }

    function setRowAction(button, { visible = false, icon = 'circle-outline', label: actionLabel = 'Action', danger = false, onClick = null } = {}) {
      button.hidden = !visible;
      button.disabled = !visible || typeof onClick !== 'function';
      button.className = `bb-transfer-item-action${danger ? ' is-danger' : ''}`;
      button.title = actionLabel || 'Action';
      button.setAttribute('aria-label', actionLabel || 'Action');
      button.bbTransferAction = visible && typeof onClick === 'function' ? onClick : null;
      const actionIcon = button.firstElementChild || installRowActionButton(button);
      actionIcon.className = `mdi mdi-${icon || 'circle-outline'}`;
    }

    function transferStatusRank(item) {
      const value = String(item?.state?.status || 'queued');
      const recentlyTransferred = Date.now() - Number(item?.state?.lastActivityAt || 0) < 5000;
      if (value === 'running' && recentlyTransferred) return 0;
      if (value === 'running') return 1;
      if (value === 'preparing') return 2;
      if (value === 'queued') return 3;
      if (value === 'paused') return 4;
      if (value === 'error') return 5;
      if (value === 'completed') return 6;
      if (value === 'canceled') return 7;
      return 5;
    }

    function reorderItems() {
      Array.from(items.values())
        .sort((left, right) => {
          const statusDifference = transferStatusRank(left) - transferStatusRank(right);
          if (statusDifference) return statusDifference;
          if (left.state.status === 'running' && right.state.status === 'running') {
            const activityDifference = Number(right.state.lastActivityAt || 0) - Number(left.state.lastActivityAt || 0);
            if (activityDifference) return activityDifference;
          }
          return left.order - right.order;
        })
        .forEach(item => list.appendChild(item.nodes.row));
    }

    function renderItem(item) {
      const { state, nodes, handlers } = item;
      const status = state.status || 'queued';
      nodes.row.className = `bb-transfer-item is-${status}`;
      nodes.icon.className = `mdi mdi-${statusIcon(status)} bb-transfer-item-icon${['running', 'preparing'].includes(status) ? ' mdi-spin' : ''}`;
      nodes.name.textContent = state.name || 'Transfer';
      nodes.name.title = nodes.name.textContent;
      nodes.detail.textContent = state.detail || '';
      nodes.detail.title = nodes.detail.textContent;

      const progress = boundedProgress(state.progress);
      const progressVisible = progress !== null || !!state.indeterminate;
      nodes.progress.hidden = !progressVisible;
      nodes.progress.classList.toggle('is-indeterminate', progress === null && !!state.indeterminate);
      if (progress !== null) {
        nodes.progress.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
        nodes.progressBar.style.setProperty('--progress', String(progress));
      } else {
        nodes.progress.removeAttribute('aria-valuenow');
        nodes.progressBar.style.removeProperty('--progress');
      }

      const canPause = ['queued', 'preparing', 'running'].includes(status) && typeof handlers.pause === 'function';
      const canResume = status === 'paused' && typeof handlers.resume === 'function';
      const canRetry = status === 'error' && typeof handlers.resume === 'function';
      const canCancel = !['completed', 'canceled'].includes(status) && typeof handlers.cancel === 'function';
      const canDismiss = ['completed', 'canceled', 'error'].includes(status);

      setRowAction(nodes.primaryAction, canPause
        ? { visible: true, icon: 'pause', label: `Pause ${state.name || 'transfer'}`, onClick: handlers.pause }
        : canResume
          ? { visible: true, icon: 'play', label: `Resume ${state.name || 'transfer'}`, onClick: handlers.resume }
          : canRetry
            ? { visible: true, icon: 'refresh', label: `Retry ${state.name || 'transfer'}`, onClick: handlers.resume }
            : { visible: false });
      setRowAction(nodes.secondaryAction, canCancel
        ? { visible: true, icon: 'close', label: `Cancel ${state.name || 'transfer'}`, danger: true, onClick: handlers.cancel }
        : canDismiss
          ? { visible: true, icon: 'close', label: `Dismiss ${state.name || 'transfer'}`, onClick: () => removeItem(item.id) }
          : { visible: false });
      reorderItems();
      updateHeader();
      schedulePanelRemoval();
    }

    function removeItem(id) {
      const item = items.get(String(id));
      if (!item) return;
      window.clearTimeout(item.removeTimer || 0);
      item.nodes.row.remove();
      items.delete(String(id));
      updateHeader();
      schedulePanelRemoval();
    }

    function add(options = {}) {
      const id = String(options.id || `${normalizedKind}-${Date.now().toString(36)}-${++sequence}`);
      const existingItem = items.get(id);
      if (existingItem) {
        existingItem.controller.update(options);
        return existingItem.controller;
      }

      window.clearTimeout(removalTimer);
      const row = el('article', 'bb-transfer-item is-queued', '');
      const icon = el('i', 'mdi mdi-clock-outline bb-transfer-item-icon', '');
      const body = el('div', 'bb-transfer-item-body', '');
      const top = el('div', 'bb-transfer-item-top', '');
      const name = el('strong', 'bb-transfer-item-name', '');
      const actions = el('div', 'bb-transfer-item-actions', '');
      const primaryAction = el('button', 'bb-transfer-item-action', '');
      const secondaryAction = el('button', 'bb-transfer-item-action', '');
      primaryAction.type = 'button';
      secondaryAction.type = 'button';
      installRowActionButton(primaryAction);
      installRowActionButton(secondaryAction);
      actions.append(primaryAction, secondaryAction);
      top.append(name, actions);
      const detail = el('div', 'bb-transfer-item-detail', '');
      const progress = el('div', 'bb-transfer-item-progress', '');
      const progressBar = el('div', 'bb-transfer-item-progress-bar', '');
      progress.setAttribute('role', 'progressbar');
      name.id = `bb-transfer-name-${++domSequence}`;
      progress.setAttribute('aria-labelledby', name.id);
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.appendChild(progressBar);
      body.append(top, detail, progress);
      row.append(icon, body);
      list.appendChild(row);

      const item = {
        id,
        order: ++sequence,
        state: {
          name: options.name || 'Transfer',
          status: options.status || 'queued',
          progress: options.progress,
          indeterminate: !!options.indeterminate,
          detail: options.detail || '',
          lastActivityAt: options.status === 'running' ? Date.now() : 0,
          lastProgress: boundedProgress(options.progress)
        },
        handlers: {
          pause: options.onPause,
          resume: options.onResume,
          cancel: options.onCancel
        },
        nodes: { row, icon, body, top, name, actions, primaryAction, secondaryAction, detail, progress, progressBar },
        removeTimer: 0,
        controller: null
      };

      const controller = {
        id,
        element: row,
        update(next = {}) {
          if (!items.has(id)) return controller;
          if (Object.prototype.hasOwnProperty.call(next, 'name')) item.state.name = String(next.name || 'Transfer');
          if (Object.prototype.hasOwnProperty.call(next, 'status')) {
            const previousStatus = item.state.status;
            item.state.status = String(next.status || 'queued');
            if (item.state.status === 'running' && previousStatus !== 'running') item.state.lastActivityAt = Date.now();
          }
          if (Object.prototype.hasOwnProperty.call(next, 'progress')) {
            const nextProgress = boundedProgress(next.progress);
            if (nextProgress !== null && (item.state.lastProgress === null || nextProgress > item.state.lastProgress + 0.000001)) {
              item.state.lastActivityAt = Date.now();
            }
            item.state.lastProgress = nextProgress;
            item.state.progress = next.progress;
          }
          if (Object.prototype.hasOwnProperty.call(next, 'indeterminate')) item.state.indeterminate = !!next.indeterminate;
          if (Object.prototype.hasOwnProperty.call(next, 'detail')) item.state.detail = String(next.detail || '');
          if (Object.prototype.hasOwnProperty.call(next, 'onPause')) item.handlers.pause = next.onPause;
          if (Object.prototype.hasOwnProperty.call(next, 'onResume')) item.handlers.resume = next.onResume;
          if (Object.prototype.hasOwnProperty.call(next, 'onCancel')) item.handlers.cancel = next.onCancel;
          renderItem(item);
          return controller;
        },
        complete(next = {}) {
          controller.update({ ...next, status: 'completed', progress: 1, indeterminate: false, onPause: null, onResume: null, onCancel: null });
          window.clearTimeout(item.removeTimer || 0);
          item.removeTimer = window.setTimeout(() => removeItem(id), Math.max(2500, Number(next.duration) || 6000));
          return controller;
        },
        fail(next = {}) {
          controller.update({ ...next, status: 'error', indeterminate: false, onPause: null });
          return controller;
        },
        canceled(next = {}) {
          controller.update({ ...next, status: 'canceled', indeterminate: false, onPause: null, onResume: null, onCancel: null });
          window.clearTimeout(item.removeTimer || 0);
          item.removeTimer = window.setTimeout(() => removeItem(id), Math.max(2000, Number(next.duration) || 4500));
          return controller;
        },
        remove() { removeItem(id); }
      };
      item.controller = controller;
      items.set(id, item);
      renderItem(item);
      return controller;
    }

    function pauseTransfers() {
      for (const item of items.values()) {
        if (!['queued', 'preparing', 'running'].includes(item.state.status) || typeof item.handlers.pause !== 'function') continue;
        try { item.handlers.pause(); } catch (error) { console.error('bulk pause failed', error); }
      }
    }

    function resumeTransfers() {
      for (const item of items.values()) {
        if (item.state.status !== 'paused' || typeof item.handlers.resume !== 'function') continue;
        try { item.handlers.resume(); } catch (error) { console.error('bulk resume failed', error); }
      }
    }

    function cancelTransfers() {
      for (const item of Array.from(items.values())) {
        if (['completed', 'canceled'].includes(item.state.status) || typeof item.handlers.cancel !== 'function') continue;
        invokeTransferAction(item.handlers.cancel);
      }
    }

    function close() {
      if (closed) return;
      closed = true;
      window.clearTimeout(removalTimer);
      panel.classList.remove('is-show');
      window.setTimeout(() => panel.remove(), 200);
      transferGroups.delete(normalizedKind);
    }

    pauseButton.addEventListener('click', pauseTransfers);
    resumeButton.addEventListener('click', resumeTransfers);
    cancelButton.addEventListener('click', cancelTransfers);

    const controller = {
      kind: normalizedKind,
      element: panel,
      items,
      add,
      pause: pauseTransfers,
      resume: resumeTransfers,
      cancel: cancelTransfers,
      close,
      get closed() { return closed; }
    };
    transferGroups.set(normalizedKind, controller);
    updateHeader();
    return controller;
  }

  // Roving-tabindex tabs: links each tab to its panel and adds Arrow/Home/End navigation. `select` activates a tab;
  // when it re-renders the tab strip the replacement is found again through replaceContent's focus restoration.
  let tabSequence = 0;
  function enhanceTabs(tabs, panels, select) {
    const base = `bb-tabs-${++tabSequence}`;
    tabs.forEach((tab, index) => {
      tab.id = tab.id || `${base}-tab-${index}`;
      const panel = panels[index];
      if (panel) {
        panel.id = panel.id || `${base}-panel-${index}`;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        tab.setAttribute('aria-controls', panel.id);
      }
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let next = index;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        select(next);
        if (tabs[next].isConnected) tabs[next].focus();
      });
    });
  }

  // replaceChildren for a region that re-renders itself (grid sort, paging, filter toggle, sheet change). Focus
  // moves to the equivalent control in the new content, so a keyboard user never lands on <body>. A focused tab
  // follows the selection (roving tabindex). When the new content has no equivalent yet (a loading view), the
  // intent is kept for the next replacement.
  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const focusKey = element => [
    element.tagName,
    element.getAttribute('role') || '',
    element.getAttribute('aria-label') || '',
    element.getAttribute('title') || '',
    element.name || '',
    (element.textContent || '').trim().slice(0, 40),
    typeof element.className === 'string' ? element.className.split(/\s+/).filter(name => name && !name.startsWith('is-')).join(' ') : ''
  ].join('|');
  const focusableControls = root => Array.from(root.querySelectorAll(FOCUSABLE)).filter(element => !element.disabled && element.offsetParent !== null);

  function replaceContent(root, ...nodes) {
    const active = document.activeElement;
    let intent = null;
    if (active && active !== document.body && root.contains(active)) {
      const all = focusableControls(root);
      const key = focusKey(active);
      intent = {
        key,
        ordinal: all.filter(element => focusKey(element) === key).indexOf(active),
        index: all.indexOf(active),
        isTab: active.getAttribute('role') === 'tab',
        at: Date.now()
      };
    } else if (root._bbFocusIntent && Date.now() - root._bbFocusIntent.at < 10000 && (!active || active === document.body)) {
      intent = root._bbFocusIntent;
    }
    root.replaceChildren(...nodes);
    root._bbFocusIntent = null;
    if (!intent) return;
    const all = focusableControls(root);
    let target = null;
    if (intent.isTab) target = all.find(element => element.getAttribute('role') === 'tab' && element.getAttribute('aria-selected') === 'true') || null;
    if (!target) {
      const matches = all.filter(element => focusKey(element) === intent.key);
      target = matches[intent.ordinal] || matches[0] || null;
    }
    if (!target && all.length && nodes.some(node => node && node.querySelector && node.querySelector(FOCUSABLE))) {
      target = all[Math.max(0, Math.min(intent.index, all.length - 1))];
    }
    if (target) target.focus({ preventScroll: true });
    else root._bbFocusIntent = intent;
  }

  // A control that is disabled while its action runs (Refresh, "Count lines", pager buttons, "Run check") loses focus
  // to <body> in browsers. Remember it and hand focus back when it is enabled again, unless the user moved on.
  (function keepFocusAcrossDisabled() {
    if (typeof MutationObserver !== 'function') return;
    let held = null;
    new MutationObserver(records => {
      for (const record of records) {
        const element = record.target;
        if (element.disabled) {
          if (document.activeElement === element) held = element;
        } else if (held === element) {
          held = null;
          const active = document.activeElement;
          if (element.isConnected && (!active || active === document.body)) element.focus({ preventScroll: true });
        }
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['disabled'], subtree: true });
    document.addEventListener('focusin', event => { if (event.target !== held) held = null; });
  })();

  BB.ui = { alert, confirm, prompt, toast, transferGroup, enhanceTabs, replaceContent };
})();
