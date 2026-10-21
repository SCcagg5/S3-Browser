/*
 * BB.summary: the summary strip at the top of the details of a file, and the sections that close.
 * - the strip: one row of pills: the version ("v5 of 5", only with versions), the encryption (a key, and SSE-S3,
 *   SSE-KMS or "Key of the client"), the lock (a padlock, and the retention or the legal hold) and the number of tags.
 *   A pill shows only when its fact is true. A click on a pill opens its section and moves to it, or opens the version
 *   picker;
 * - the sections: each section has a chevron button in its title. The sections "Storage object" and "Tags" start open,
 *   the other ones start closed. The browser keeps the choice of the person for each section (localStorage).
 * The sections keep all their content: a closed section only hides it.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const STORE_KEY = 'portal.details.sections';
  // The sections that start open.
  const OPEN_BY_DEFAULT = { storage: true, tags: true };
  const ENCRYPTION_NAMES = { AES256: 'SSE-S3', 'aws:kms': 'SSE-KMS', 'aws:kms:dsse': 'DSSE-KMS' };

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

  function header(headers, name) {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
      if (key.toLowerCase() === wanted) return String(value || '').trim();
    }
    return '';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sections that close
  // ---------------------------------------------------------------------------------------------------------------

  function storedChoices() {
    try {
      const value = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function storeChoice(id, open) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...storedChoices(), [id]: open }));
    } catch (_) {}
  }

  const startsOpen = id => {
    const stored = storedChoices()[id];
    return typeof stored === 'boolean' ? stored : OPEN_BY_DEFAULT[id] === true;
  };

  function setOpen(section, open, { remember = false } = {}) {
    section.classList.toggle('is-collapsed', !open);
    const toggle = section.querySelector(':scope > .bb-details-section-title > .detailsToggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.title = open ? 'Close the section' : 'Open the section';
    }
    if (remember) storeChoice(section.dataset.section, open);
  }

  // The title of a section gets its chevron button. A section module writes its title when it loads (encryption) or
  // writes it again: an observer adds the button to each new title.
  function decorate(section) {
    const title = section.querySelector(':scope > .bb-details-section-title');
    if (!title || title.querySelector(':scope > .detailsToggle')) return;
    const name = title.textContent.trim();
    const toggle = h('button', {
      type: 'button', class: 'iconButton detailsToggle', 'data-section-toggle': section.dataset.section,
      'aria-label': `Section ${name}`, 'aria-expanded': 'false',
      onclick: event => {
        event.stopPropagation();
        setOpen(section, section.classList.contains('is-collapsed'), { remember: true });
      }
    }, icon('chevron-down'));
    title.prepend(toggle);
    setOpen(section, !section.classList.contains('is-collapsed'));
  }

  function collapsible(section) {
    if (section.dataset.collapsible) return;
    section.dataset.collapsible = 'true';
    section.classList.add('is-collapsible');
    section.classList.toggle('is-collapsed', !startsOpen(section.dataset.section));
    decorate(section);
    new MutationObserver(() => decorate(section)).observe(section, { childList: true });
    section.addEventListener('click', event => {
      const title = event.target.closest('.bb-details-section-title');
      if (!title || title.parentElement !== section || event.target.closest('.detailsToggle')) return;
      // A button of the title (Edit) opens a closed section. A click on the text of the title opens or closes it.
      if (event.target.closest('button')) setOpen(section, true, { remember: section.classList.contains('is-collapsed') });
      else setOpen(section, section.classList.contains('is-collapsed'), { remember: true });
    }, true);
  }

  // Opens a section and moves to it.
  function reveal(overlay, id) {
    const section = overlay.querySelector(`.bb-details-section[data-section="${id}"]`);
    if (!section) return;
    setOpen(section, true);
    section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    section.querySelector('.detailsToggle')?.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Summary strip
  // ---------------------------------------------------------------------------------------------------------------

  // The encryption of the object from its headers: SSE-S3, SSE-KMS, DSSE-KMS, the key of the client, or ''.
  function encryptionText(headers, customerKey) {
    if (customerKey || header(headers, 'x-amz-server-side-encryption-customer-algorithm')) return 'Key of the client';
    const algorithm = header(headers, 'x-amz-server-side-encryption');
    return algorithm ? (ENCRYPTION_NAMES[algorithm] || algorithm) : '';
  }

  // versions: { position, count } of the version that the details show (1 is the oldest), or null.
  function mount(overlay, { versions = null, headers = {}, customerKey = false } = {}) {
    const strip = overlay.querySelector('[data-details-summary]');
    overlay.querySelectorAll('.bb-details-column > .bb-details-section[data-section]').forEach(collapsible);
    if (!strip) return { setTags() {}, setLock() {} };
    const pills = {};
    const pill = (name, iconName, onclick) => {
      const label = h('span', { class: 'detailsPill__text' });
      const node = h('button', { type: 'button', class: 'detailsPill', 'data-pill': name, hidden: true, onclick }, icon(iconName), label);
      pills[name] = { node, label };
      return node;
    };
    const show = (name, text, title) => {
      const entry = pills[name];
      entry.node.hidden = !text;
      entry.label.textContent = text || '';
      entry.node.title = title || '';
      strip.hidden = !Object.values(pills).some(item => !item.node.hidden);
    };
    strip.replaceChildren(
      pill('version', 'source-commit', () => overlay.querySelector('[data-details-versions] .versionPicker__button')?.click()),
      pill('encryption', 'key', () => reveal(overlay, 'encryption')),
      pill('lock', 'lock-outline', () => reveal(overlay, 'retention')),
      pill('tags', 'tag-multiple-outline', () => reveal(overlay, 'tags')));

    if (versions && versions.count > 1) {
      show('version', `v${versions.position} of ${versions.count}`, `Version ${versions.position} of ${versions.count}${versions.position === versions.count ? ', the current version' : ''}. Open the version picker.`);
    }
    const encryption = encryptionText(headers, customerKey);
    if (encryption) show('encryption', encryption, `Encrypted: ${encryption}. Open the section Encryption.`);

    return {
      // tags: the saved tags of the version.
      setTags(tags) {
        const count = Array.isArray(tags) ? tags.length : 0;
        show('tags', count ? `${count} ${count === 1 ? 'tag' : 'tags'}` : '', 'Open the section Tags.');
      },
      // state: the answer of GET /api/object-lock. The pill shows what holds the version now.
      setLock(state) {
        const until = state?.retention ? Date.parse(state.retention.retainUntil) : NaN;
        const title = BB.objectLock?.lockTitle({ mode: state?.retention?.mode || '', until, legalHold: state?.legalHold === true }) || '';
        show('lock', title.replace(/^Object Lock: /, ''), title ? `${title}. Open the section Retention.` : '');
      }
    };
  }

  BB.summary = { mount, collapsible, reveal, encryptionText };
})();
