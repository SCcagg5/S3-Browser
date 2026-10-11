/*!
 * BB.menu — lightweight popover for kebab menus
 * - Trigger: .bb-kebab (icon only) or .bb-menu-trigger (labelled button)
 * - Container: .bb-menu (must contain .bb-menu-popover)
 * - Positions popover bottom-left of the icon using position: fixed
 * - Prevents clipping by ancestors with overflow hidden
 * - Closes on outside interaction (pointerdown/mousedown/touchstart capture), on item click, ESC, resize, scroll
 * - Keyboard: Enter/Space/ArrowDown on the trigger opens and focuses the first item; Arrow/Home/End move
 *   between items; Escape closes and returns focus to the trigger; Tab closes and continues from the trigger;
 *   activating an item returns focus to the trigger unless the action moved it (a dialog, a file chooser).
 */
(function () {
  const BB = (window.BB = window.BB || {});
  const TRIGGER = '.bb-menu-trigger, .bb-kebab';
  function hidePopover(menu) {
    const pop = menu.querySelector('.bb-menu-popover');
    if (!pop) return;
    pop.style.display = 'none';
    pop.style.visibility = '';
    pop.style.left = '';
    pop.style.top = '';
    pop.style.position = '';
  }

  function setExpanded(menu, expanded) {
    const trigger = menu.querySelector(TRIGGER);
    if (trigger) trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  // restoreFocus: hand focus back to the trigger when it is still inside the popover (or nowhere), so
  // activating an item never leaves the keyboard on <body>. A dialog that already took focus is left alone.
  function closeAll(options) {
    const restoreFocus = !!(options && options.restoreFocus === true);
    document.querySelectorAll('.bb-menu.is-open').forEach((m) => {
      const trigger = m.querySelector(TRIGGER);
      const active = document.activeElement;
      const focusLost = !active || active === document.body || (active !== trigger && m.contains(active));
      m.classList.remove('is-open');
      setExpanded(m, false);
      hidePopover(m);
      if (restoreFocus && focusLost && trigger && trigger.offsetParent !== null) trigger.focus();
    });
  }

  function menuItems(menu) {
    return Array.from(menu.querySelectorAll('.bb-menu-item')).filter((item) => !item.hidden && !item.disabled && item.offsetParent !== null);
  }

  function focusItem(menu, index) {
    const items = menuItems(menu);
    if (!items.length) return;
    items[(index + items.length) % items.length].focus();
  }

  function openMenu(menu, { focusFirst = false, point = null } = {}) {
    closeAll();
    openScrollY = window.scrollY;
    menu.classList.add('is-open');
    setExpanded(menu, true);
    requestAnimationFrame(() => {
      // A scroll or outside click may have closed the menu before this frame: never re-show a closed popover.
      if (!menu.classList.contains('is-open')) return;
      positionPopover(menu, point);
      if (focusFirst) focusItem(menu, 0);
    });
  }

  function getOpenMenu() {
    return document.querySelector('.bb-menu.is-open');
  }

  function positionPopover(menu, anchorPoint = null) {
    const icon = menu.querySelector(TRIGGER);
    const pop = menu.querySelector('.bb-menu-popover');
    if (!icon || !pop) return;

    pop.style.display = 'block';
    pop.style.visibility = 'hidden';

    const r = icon.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const pw = pop.offsetWidth || 220;
    const ph = pop.offsetHeight || 280;
    const point = anchorPoint && Number.isFinite(anchorPoint.x) && Number.isFinite(anchorPoint.y)
      ? {
          x: anchorPoint.x,
          y: anchorPoint.y
        }
      : null;

    let left = point ? point.x : r.right - pw;
    let top = point ? point.y : r.bottom + 8;

    const maxLeft = Math.max(8, viewport.width - pw - 8);
    left = Math.max(8, Math.min(left, maxLeft));
    const maxTop = Math.max(8, viewport.height - ph - 8);
    if (top > maxTop) top = point ? maxTop : Math.max(8, r.top - ph - 8);
    top = Math.max(8, top);

    pop.style.position = 'fixed';
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = 'visible';
  }

  function eventInsideOpenMenu(e) {
    const open = getOpenMenu();
    if (!open) return false;

    const pop = open.querySelector('.bb-menu-popover');
    const t = e.target;

    if (open.contains(t)) return true;
    if (pop && pop.contains(t)) return true;

    if (e.composedPath) {
      const path = e.composedPath();
      if (path.includes(open)) return true;
      if (pop && path.includes(pop)) return true;
    }
    return false;
  }

  function onGlobalDown(e) {
    const open = getOpenMenu();
    if (!open) return;
    if (!eventInsideOpenMenu(e)) closeAll();
  }
  ['pointerdown', 'mousedown', 'touchstart'].forEach((type) =>
    document.addEventListener(type, onGlobalDown, true)
  );

  // The popover is fixed-positioned, so it only needs to close when the page or a container really moved
  // beneath it. A scroll event queued by the very action that opened the menu must not close it.
  let openScrollY = 0;
  window.addEventListener(
    'scroll',
    (event) => {
      const open = getOpenMenu();
      if (!open) return;
      const popover = open.querySelector('.bb-menu-popover');
      if (popover && event.target instanceof Node && popover.contains(event.target)) return;
      const pageScroll = event.target === document || event.target === document.documentElement;
      if (pageScroll && Math.abs(window.scrollY - openScrollY) <= 4) return;
      closeAll();
    },
    true
  );
  window.addEventListener('blur', () => closeAll());

  document.addEventListener(
    'click',
    (e) => {
      const item = e.target.closest('.bb-menu-item');
      if (item) {
        setTimeout(() => closeAll({ restoreFocus: true }), 0);
        return;
      }

      const kebab = e.target.closest(TRIGGER);
      const menu = e.target.closest('.bb-menu');
      if (kebab && menu) {
        const wasOpen = menu.classList.contains('is-open');
        if (wasOpen) closeAll();
        // detail === 0 means the click came from the keyboard (Enter or Space).
        else openMenu(menu, { focusFirst: e.detail === 0 });
        e.preventDefault();
        e.stopPropagation();
        return;
      }

    },
    true
  );

  window.addEventListener('resize', () => {
    const open = getOpenMenu();
    if (open) positionPopover(open);
  });

  document.addEventListener('keydown', (e) => {
    const open = getOpenMenu();
    const kebab = e.target.closest && e.target.closest(TRIGGER);

    if (!open) {
      if (kebab && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const menu = kebab.closest('.bb-menu');
        if (menu) {
          e.preventDefault();
          openMenu(menu, { focusFirst: true });
        }
      }
      return;
    }

    const items = menuItems(open);
    const current = items.indexOf(document.activeElement);
    switch (e.key) {
      case 'Escape': {
        const trigger = open.querySelector(TRIGGER);
        closeAll();
        if (trigger && trigger.offsetParent !== null) trigger.focus();
        break;
      }
      case 'ArrowDown':
        e.preventDefault();
        focusItem(open, current + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(open, current < 0 ? -1 : current - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(open, 0);
        break;
      case 'End':
        e.preventDefault();
        focusItem(open, -1);
        break;
      case 'Tab': {
        // Leave the popover from its trigger so the browser continues the tab order from there.
        const trigger = open.querySelector(TRIGGER);
        if (trigger && trigger.offsetParent !== null) trigger.focus();
        closeAll();
        break;
      }
    }
  });

  function openAt(menu, x, y) {
    if (!menu) return false;
    openMenu(menu, { focusFirst: true, point: { x: Number(x), y: Number(y) } });
    return true;
  }

  BB.menu = Object.assign(BB.menu || {}, { closeAll, openAt });
})();
