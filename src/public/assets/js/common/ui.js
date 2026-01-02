/*!
 * BB.ui — minimal modal/toast utilities (framework-agnostic)
 * - Alert / Confirm / Prompt rendered as centered overlay with backdrop
 * - ESC / click on backdrop closes (confirm stays on OK)
 * - Focus management for accessibility
 * - Small toast in bottom-right
 */
(function () {
  const BB = (window.BB = window.BB || {});

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  function lockScroll(lock) {
    const b = document.body;
    if (lock) {
      if (!b.classList.contains('bb-no-scroll')) {
        b.dataset.prevOverflow = b.style.overflow || '';
        b.classList.add('bb-no-scroll');
        b.style.overflow = 'hidden';
      }
    } else {
      if (b.classList.contains('bb-no-scroll')) {
        b.classList.remove('bb-no-scroll');
        b.style.overflow = b.dataset.prevOverflow || '';
        delete b.dataset.prevOverflow;
      }
    }
  }

  function buildModal({ title = '', message = '', html = '', kind = 'alert', defaultValue = '' }) {
    const overlay = el('div', 'bb-overlay', '');
    const modal = el('div', 'bb-modal', '');

    const btnClose = el('button', 'bb-btn bb-btn-ghost bb-modal-x', '<i class="mdi mdi-close"></i>');
    btnClose.setAttribute('aria-label', 'Close');
    var header = void 0;
    if (title != '' || html == '') {
      header = el('div', 'bb-modal-header', '');
      const hTitle = el('div', 'bb-modal-title', '');
      hTitle.textContent = title || '';
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
      input.setAttribute('aria-label', 'Input');
      body.append(msg, input);
   } else if (html) {
      const wrap = el('div', 'bb-modal-html', '');
      wrap.innerHTML = String(html || '');
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
    const btnCancel = el('button', 'bb-btn', 'Annuler');
    const btnOk = el('button', 'bb-btn bb-btn-primary', kind === 'confirm' ? 'OK' : (kind === 'prompt' ? 'OK' : 'OK'));
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

  function attachAndShow(overlay) {
    document.body.appendChild(overlay);
    lockScroll(true);
    requestAnimationFrame(() => overlay.classList.add('is-open'));
  }

  function cleanup(overlay) {
    overlay.classList.remove('is-open');
    setTimeout(() => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      lockScroll(false);
    }, 120);
  }

  async function alert({ title = '', message = '', html = '' }) {
    return new Promise((resolve) => {
      const { overlay, btnOk, btnClose } = buildModal({ title, message, html, kind: 'alert' });

      function close() { cleanup(overlay); resolve(); }
      btnClose.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

      attachAndShow(overlay);
    });
  }

  async function confirm({ title = '', message = '' }) {
    return new Promise((resolve) => {
      const { overlay, btnOk, btnCancel, btnClose } = buildModal({ title, message, kind: 'confirm' });

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
        if (e.key === 'Enter') ok();
      });

      attachAndShow(overlay);
      input.focus();
      input.select();
    });
  }

  function toast(message = '', { duration = 3000 } = {}) {
    let host = $('#bb-toast-host');
    if (!host) {
      host = el('div', 'bb-toast-host', '');
      host.id = 'bb-toast-host';
      document.body.appendChild(host);
    }
    const t = el('div', 'bb-toast', '');
    t.textContent = String(message || '');
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('is-show'));
    setTimeout(() => {
      t.classList.remove('is-show');
      setTimeout(() => t.remove(), 200);
    }, Math.max(1000, duration));
  }

  BB.ui = { alert, confirm, prompt, toast };
})();
