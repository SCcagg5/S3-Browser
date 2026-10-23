/*
 * BB.suggest: a text field with a small popover of suggested values (the ARIA combobox pattern).
 * - the popover has the look of the other menus of the portal, and it is in the large window or in the body, so that the
 *   scroll area of a window does not clip it;
 * - the keys: Down and Up move the highlight (Down opens a closed popover), Enter chooses the highlighted row, Escape
 *   closes the popover and stops there, Tab leaves the field as usual;
 * - the person can type any text: the popover shows the values that contain the text, and a value that is not in the
 *   list stays in the field.
 * BB.suggest.field(input, { values, onChoose }) gives the wrapper of the field. values is a list, or a function that
 * returns the list. A value is a text, or { value, label, hint, tag }: hint is a muted text at the right of the row, and
 * tag is a small mark such as "Guess".
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const MAX_HEIGHT = 280;
  let counter = 0;

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

  // The list without empty values and without a second row for the same value.
  function normalize(list) {
    const seen = new Set();
    const rows = [];
    for (const item of list || []) {
      const row = typeof item === 'string' ? { value: item } : item;
      if (!row || !row.value || seen.has(row.value)) continue;
      seen.add(row.value);
      rows.push(row);
    }
    return rows;
  }

  // The nearest ancestor that scrolls: the popover closes when the field leaves its area.
  function scrollParent(node) {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
    }
    return document.documentElement;
  }

  function attach(input, { values = [], onChoose = null } = {}) {
    counter += 1;
    const id = `suggest-${counter}`;
    const menu = h('div', { class: 'suggest__menu', id: `${id}-list`, role: 'listbox', 'aria-label': input.getAttribute('aria-label') || 'Suggestions' });
    let rows = [];
    let active = -1;
    // True after the person types: only then the text of the field filters the list.
    let typed = false;
    let choosing = false;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', menu.id);

    const isOpen = () => menu.isConnected;
    const options = () => normalize(typeof values === 'function' ? values() : values);

    function shown() {
      const text = typed ? input.value.trim().toLowerCase() : '';
      if (!text) return options();
      return options().filter(option => {
        const value = option.value.toLowerCase();
        return value !== text && (value.includes(text) || String(option.label || '').toLowerCase().includes(text));
      });
    }

    function setActive(index) {
      active = index;
      rows.forEach((row, position) => {
        row.node.classList.toggle('is-active', position === index);
        row.node.setAttribute('aria-selected', String(position === index));
      });
      if (index < 0) { input.removeAttribute('aria-activedescendant'); return; }
      input.setAttribute('aria-activedescendant', rows[index].node.id);
      rows[index].node.scrollIntoView({ block: 'nearest' });
    }

    function place() {
      const box = (input.closest('.suggest') || input).getBoundingClientRect();
      const clip = scrollParent(input).getBoundingClientRect();
      if (box.bottom < clip.top || box.top > clip.bottom) { close(); return; }
      menu.style.minWidth = `${Math.min(box.width, window.innerWidth - 16)}px`;
      const width = menu.offsetWidth;
      menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      // The popover goes above the field when the room below is small.
      if (below < 160 && above > below) {
        menu.style.top = '';
        menu.style.bottom = `${window.innerHeight - box.top + 6}px`;
        menu.style.maxHeight = `${Math.min(MAX_HEIGHT, above)}px`;
      } else {
        menu.style.bottom = '';
        menu.style.top = `${box.bottom + 6}px`;
        menu.style.maxHeight = `${Math.min(MAX_HEIGHT, Math.max(120, below))}px`;
      }
    }

    // A click outside the field and the popover closes it. A scroll keeps it under the field.
    const outside = event => { if (!menu.contains(event.target) && event.target !== input) close(); };
    const scrolled = event => { if (!menu.contains(event.target)) place(); };

    function open() {
      const list = shown();
      if (!list.length) { close(); return; }
      rows = list.map((option, index) => ({
        option,
        node: h('div', { class: ['suggest__option', option.value === input.value && 'is-current'], id: `${id}-option-${index}`, role: 'option', 'aria-selected': 'false', 'data-value': option.value },
          h('span', { class: 'suggest__text mono' }, option.label || option.value),
          option.tag ? h('span', { class: 'suggest__tag' }, option.tag) : null,
          option.hint ? h('span', { class: 'suggest__hint' }, option.hint) : null,
          option.value === input.value ? icon('check') : null)
      }));
      for (const row of rows) {
        // The mouse down does not take the focus from the field.
        row.node.addEventListener('mousedown', event => event.preventDefault());
        row.node.addEventListener('mousemove', () => { if (active !== rows.indexOf(row)) setActive(rows.indexOf(row)); });
        row.node.addEventListener('click', () => choose(row.option));
      }
      menu.replaceChildren(...rows.map(row => row.node));
      if (!isOpen()) {
        (input.closest('.bb-overlay') || document.body).append(menu);
        document.addEventListener('click', outside, true);
        document.addEventListener('scroll', scrolled, true);
        window.addEventListener('resize', place);
      }
      input.setAttribute('aria-expanded', 'true');
      setActive(-1);
      place();
    }

    function close() {
      if (!isOpen()) return;
      menu.remove();
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      document.removeEventListener('click', outside, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', place);
    }

    function choose(option) {
      choosing = true;
      input.value = option.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      choosing = false;
      typed = false;
      close();
      if (onChoose) onChoose(option.value, option);
    }

    input.addEventListener('focus', () => { typed = false; open(); });
    input.addEventListener('click', () => { if (!isOpen()) { typed = false; open(); } });
    input.addEventListener('input', () => { if (choosing) return; typed = true; open(); });
    input.addEventListener('blur', close);
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!isOpen()) { typed = false; open(); }
        if (!rows.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive(active < 0 ? (step > 0 ? 0 : rows.length - 1) : (active + step + rows.length) % rows.length);
      } else if (event.key === 'Enter' && isOpen() && active >= 0) {
        event.preventDefault();
        event.stopPropagation();
        choose(rows[active].option);
      } else if (event.key === 'Escape' && isOpen()) {
        // The window behind the popover stays open.
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        close();
      }
    });
    return { open, close };
  }

  // The field in a wrapper with a small arrow, and the popover of its values.
  function field(input, options) {
    input.classList.add('suggest__input');
    const wrapper = h('span', { class: 'suggest' }, input);
    attach(input, options);
    return wrapper;
  }

  BB.suggest = { attach, field };
})();
