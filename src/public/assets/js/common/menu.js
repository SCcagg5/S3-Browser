/*!
 * BB.menu — lightweight popover for kebab menus
 * - Trigger: .bb-kebab (icon only)
 * - Container: .bb-menu (must contain .bb-menu-popover)
 * - Positions popover bottom-left of the icon using position: fixed
 * - Prevents clipping by ancestors with overflow hidden
 * - Closes on outside interaction (pointerdown/mousedown/touchstart capture), on item click, ESC, resize, scroll
 */
(function () {
  const BB = (window.BB = window.BB || {});
  function hidePopover(menu) {
    const pop = menu.querySelector('.bb-menu-popover');
    if (!pop) return;
    pop.style.display = 'none';
    pop.style.visibility = '';
    pop.style.left = '';
    pop.style.top = '';
    pop.style.position = '';
  }

  function closeAll() {
    document.querySelectorAll('.bb-menu.is-open').forEach((m) => {
      m.classList.remove('is-open');
      hidePopover(m);
    });
  }

  function getOpenMenu() {
    return document.querySelector('.bb-menu.is-open');
  }

  function positionPopover(menu, anchorPoint = null) {
    const icon = menu.querySelector('.bb-kebab');
    const pop = menu.querySelector('.bb-menu-popover');
    if (!icon || !pop) return;

    pop.style.display = 'block';
    pop.style.visibility = 'hidden';

    const r = icon.getBoundingClientRect();
    const pw = pop.offsetWidth || 220;
    const ph = pop.offsetHeight || 280;
    const point = anchorPoint && Number.isFinite(anchorPoint.x) && Number.isFinite(anchorPoint.y)
      ? anchorPoint
      : null;

    let left = point ? point.x : r.right - pw;
    let top = point ? point.y : r.bottom + 8;

    const maxLeft = Math.max(8, window.innerWidth - pw - 8);
    left = Math.max(8, Math.min(left, maxLeft));
    const maxTop = Math.max(8, window.innerHeight - ph - 8);
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

  window.addEventListener(
    'scroll',
    () => {
      if (getOpenMenu()) closeAll();
    },
    true
  );
  window.addEventListener('blur', closeAll);

  document.addEventListener(
    'click',
    (e) => {
      const item = e.target.closest('.bb-menu-item');
      if (item) {
        setTimeout(closeAll, 0);
        return;
      }

      const kebab = e.target.closest('.bb-kebab');
      const menu = e.target.closest('.bb-menu');
      if (kebab && menu) {
        const wasOpen = menu.classList.contains('is-open');
        closeAll();
        if (!wasOpen) {
          menu.classList.add('is-open');
          requestAnimationFrame(() => positionPopover(menu));
        }
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
    if (e.key === 'Escape') closeAll();
  });

  function openAt(menu, x, y) {
    if (!menu) return false;
    closeAll();
    menu.classList.add('is-open');
    requestAnimationFrame(() => positionPopover(menu, { x: Number(x), y: Number(y) }));
    return true;
  }

  BB.menu = Object.assign(BB.menu || {}, { closeAll, openAt });
})();
