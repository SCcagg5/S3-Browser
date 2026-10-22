/*
 * BB.switcher: the bucket selector of the header, one implementation for the listing (app.js) and the information page
 * (info.js). The two pages have the same markup, the same classes, the same facts and the same reads.
 * - the trigger: the icon, the name of the current bucket and the marks of a full bucket; then one link with the seven
 *   state icons (states.js) and the usage (the amount, the percent and the bar) to the information page of the bucket;
 * - one visible instance: a static trigger with the same link, and no list;
 * - the list of the hosts and of their buckets: a button for each bucket, and next to it the link of its state icons and
 *   its usage. The host of the current bucket opens with the list; the other hosts keep the state of the person;
 * - the usage: the list reads the usage of each bucket when it opens (usage.js sends 4 reads at most at the same time,
 *   and keeps each answer for 60 seconds). A full bucket gets an alert mark;
 * - the versioning and the lifecycle rules of the state icons: the read of GET /api/lifecycle for a bucket that the page
 *   opened, else the probe of the server (versioningState and lifecycleRules of /api/instances);
 * - the keyboard: Down opens the list, Up and Down go from row to row, Right goes from a bucket to its link, Left goes
 *   back, Escape closes the list, and Tab closes it when the focus leaves it.
 * create({ root, onSelect, beforeOpen, onRefresh, watchLifecycle }) gives the controller of one selector. onSelect(entry)
 * acts on a click on a bucket of the list: the listing selects the instance, the information page opens the
 * information page of that bucket. onRefresh({ instance, full }) runs after each fill of the facts.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const ic = (name, extra = '') => h('i', { class: ['ic', `ic-${name}`, extra], 'aria-hidden': 'true' });

  function plural(count, singular, pluralForm = `${singular}s`) {
    const value = Math.max(0, Number(count) || 0);
    return `${value.toLocaleString('en-US')} ${value === 1 ? singular : pluralForm}`;
  }

  // A volume (provider fs) is a folder of the server. The selector names it a volume, not a bucket.
  const isVolume = instance => String(instance?.provider || '') === 'fs';
  const storageNoun = instance => (isVolume(instance) ? 'volume' : 'bucket');
  const storageIcon = instance => (isVolume(instance) ? 'folder-open' : 'database');
  const storageName = instance => instance.name || instance.id;
  const canList = instance => (BB.capabilities?.actionable ? BB.capabilities.actionable(instance, 'list') : true);

  // The address of the information page of a bucket: /-/<host>/<bucket>/?info.
  const infoPageURL = instance => `${BB.api.browserPageURL('', { instance: instance.id })}?info`;

  // Puts nodes in a container when they differ from the nodes that it has. The focus stays on the same fact.
  const filled = new WeakMap();

  function fillNodes(container, nodes) {
    if (!container) return;
    const html = nodes.map(node => node.outerHTML).join('');
    if (filled.get(container) === html) return;
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.fact : '';
    filled.set(container, html);
    container.replaceChildren(...nodes);
    if (focused) container.querySelector(`[data-fact="${focused}"]`)?.focus();
  }

  function create({ root, onSelect = () => {}, beforeOpen = () => {}, onRefresh = () => {}, watchLifecycle = true } = {}) {
    const model = { instances: [], currentId: '', loading: true, loadError: '', emptyText: '' };
    const expandedHosts = {};
    // The versioning and the rules of each instance that the page read (GET /api/lifecycle).
    let bucketInfo = {};
    let signature = '';
    let trigger = null;
    let menu = null;

    const current = () => model.instances.find(instance => instance.id === model.currentId) || null;

    // The versioning and the lifecycle rules of a bucket. versioning: 'enabled', 'suspended', 'off' or '' (unknown).
    // rules: a list, a count or null.
    function bucketState(instance) {
      const info = bucketInfo[instance.id];
      if (info) return { versioning: { Enabled: 'enabled', Suspended: 'suspended' }[info.versioning] || 'off', rules: info.rules };
      return { versioning: String(instance.versioningState || ''), rules: Number.isInteger(instance.lifecycleRules) ? instance.lifecycleRules : null };
    }

    const bucketStates = instance => BB.states.list(instance, bucketState(instance));

    function details(instance) {
      return [
        storageName(instance),
        `id: ${instance.id}`,
        `host: ${instance.host}`,
        `${storageNoun(instance)}: ${instance.rootPrefix ? `${instance.bucket}/${instance.rootPrefix}` : instance.bucket}`,
        isVolume(instance) ? 'provider: a folder of the server (FS)' : `provider: ${String(instance.provider || '').toUpperCase()}`,
        ...bucketStates(instance).map(item => item.text),
        BB.usage?.selectorLine(BB.usage.cached(instance.id)) || null
      ].filter(Boolean).join('\n');
    }

    function hosts() {
      const out = [];
      const byId = new Map();
      for (const instance of model.instances) {
        const id = String(instance.host || instance.id || '');
        let host = byId.get(id);
        if (!host) {
          host = { id, provider: String(instance.provider || ''), instances: [] };
          byId.set(id, host);
          out.push(host);
        }
        host.instances.push(instance);
      }
      return out;
    }

    // --- Facts ---------------------------------------------------------------------------------------------------

    // A fact: an icon and a label for a screen reader.
    function bucketFact(name, iconName, label, detail, { tone = '' } = {}) {
      return h('span', { class: ['bucketFact', tone && `is-${tone}`], 'data-fact': name },
        ic(iconName), h('span', { class: 'visually-hidden' }, `${label}. ${detail ? `${detail}. ` : ''}`));
    }

    // The usage: the text, the amount, a short text, the thin bar of the used part. A full bucket has a red bar. The
    // used part is the more constraining of the quota of the bucket and the storage behind it (data-constraint). The
    // selector shows the amount that the bucket holds ("3 MB", "≥ 3 MB" or "computing…" for a volume), then the short
    // text (the percent, or the used bytes when there is no limit). The whole text is for a screen reader only.
    function usageFact(usage) {
      const limited = BB.usage.hasLimit(usage);
      const amount = BB.usage.amountText(usage);
      const node = h('span', {
        class: ['bucketFact', 'bucketUsage', usage.level && `is-${usage.level}`, BB.usage.full(usage) && 'is-full'], 'data-fact': 'usage',
        'data-level': usage.level || 'none', 'data-constraint': BB.usage.constraint(usage) || 'none', 'data-used-bytes': String(usage.usedBytes)
      }, h('span', { class: 'bucketUsage__text' }, BB.usage.text(usage)),
      amount ? h('span', { class: 'bucketUsage__amount', 'aria-hidden': 'true' }, amount) : null,
      h('span', { class: 'bucketUsage__short', 'aria-hidden': 'true' }, BB.usage.shortText(usage)),
      limited ? h('span', { class: 'usageMeter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(usage.percent), 'aria-label': 'Used part of the limit' },
        h('span', { class: 'usageMeter__fill' })) : null);
      const fill = node.querySelector('.usageMeter__fill');
      if (fill) fill.style.width = `${Math.min(100, Math.max(Number(usage.percent) || 0, usage.usedBytes > 0 ? 2 : 0))}%`;
      return node;
    }

    // The facts of a bucket after its state icons: the usage. The line of the trigger also shows a failed read of the
    // usage, as a muted icon.
    function bucketFacts(instance, { trigger: inTrigger = false } = {}) {
      const items = [];
      if (instance.usageSupported === true && canList(instance)) {
        const usage = BB.usage.cached(instance.id);
        if (BB.usage.shown(usage)) {
          items.push(usageFact(usage));
        } else if (!usage && BB.usage.loading(instance.id)) {
          items.push(h('span', { class: 'bucketFact bucketUsage is-loading', 'data-fact': 'usage', 'data-level': 'loading' }, '…', h('span', { class: 'visually-hidden' }, `Reading the usage of the ${storageNoun(instance)}`)));
        } else if (usage?.supported === true && inTrigger) {
          const node = bucketFact('usage', 'database', 'Usage unavailable', BB.usage.title(usage), { tone: 'muted' });
          node.dataset.level = 'unavailable';
          items.push(node);
        }
      }
      return items;
    }

    const fullUsage = instance => instance?.usageSupported === true && canList(instance) && BB.usage.full(BB.usage.cached(instance.id));

    // The alert mark of a full bucket, after its name.
    function fullMark(instance) {
      const text = BB.usage.fullText(BB.usage.cached(instance.id));
      return h('span', { class: 'bucketMark is-full', role: 'img', title: text, 'aria-label': text, 'data-mark': 'full' }, ic('alert-triangle'));
    }

    // --- The link of the state icons and the usage ---------------------------------------------------------------

    // The seven state icons and the usage of a bucket are ONE link to its information page: one element, one hover,
    // one click. It has no tooltip: the page gives each line. In the trigger and in the list, the link is next to the
    // button, not in it. It is a link, so Enter opens it; Space opens it too, as on a button. The accessible name gives
    // the state of each icon and the usage.
    function infoLink(instance, { inMenu = false } = {}) {
      const link = h('a', {
        id: inMenu ? null : 'storageSwitcherInfo',
        class: inMenu ? 'storageBucket__info' : 'storageSwitcher__info',
        href: infoPageURL(instance),
        'data-info': instance.id,
        'data-volume': isVolume(instance) ? 'true' : null,
        onclick: event => event.stopPropagation(),
        onkeydown: event => {
          if (event.key !== ' ') return;
          event.preventDefault();
          event.currentTarget.click();
        }
      }, h('span', { class: ['stateGroup', inMenu ? 'storageBucket__states' : 'storageSwitcher__states'] }),
      h('span', { class: inMenu ? 'bucketFacts' : 'storageSwitcher__facts bucketFacts' }));
      fillInfo(link, instance, { inMenu });
      return link;
    }

    function fillInfo(link, instance, { inMenu = false } = {}) {
      if (!link) return;
      const states = bucketStates(instance);
      fillNodes(link.querySelector('.stateGroup'), BB.states.nodes(states, { tip: false }));
      const usage = instance.usageSupported === true && canList(instance) ? BB.usage.cached(instance.id) : null;
      const label = `Information and permissions of this ${storageNoun(instance)}${inMenu ? `: ${storageName(instance)}` : ''}`;
      link.setAttribute('aria-label', [`${label}. ${states.map(item => item.text).join(', ')}`, usage && BB.usage.shown(usage) ? BB.usage.text(usage) : ''].filter(Boolean).join('. '));
    }

    // The name of the bucket and the marks of a full bucket.
    function switcherCopy(instance) {
      return h('span', { class: 'storageSwitcher__copy' },
        h('span', { class: 'storageSwitcher__titleRow' }, h('strong', {}, storageName(instance)), h('span', { class: 'bucketMarks' })));
    }

    // --- Render ----------------------------------------------------------------------------------------------------

    function render() {
      const instance = current();
      const multiple = model.instances.length > 1;
      const next = JSON.stringify([model.loading, model.loadError, model.emptyText, instance?.id,
        model.instances.map(item => [item.id, item.host, item.name, item.bucket, item.rootPrefix, item.provider, item.encryption, item.defaultEncryption, item.encryptionApplied,
          BB.states.permissions(item).map(entry => BB.capabilities.normalizeState(entry.state))])]);
      if (signature === next) return;
      signature = next;
      menu = null;
      trigger = null;
      root.classList.toggle('is-loading', model.loading);
      root.classList.remove('is-open');
      if (model.loading) {
        root.replaceChildren(h('div', { class: 'storageSwitcher__trigger is-static', 'aria-hidden': 'true' }, h('span', { class: 'storageSwitcher__skeleton' })));
      } else if (!instance) {
        root.replaceChildren(h('div', { class: 'storageSwitcher__trigger is-static', 'data-empty': 'true' },
          ic('database', 'storageSwitcher__icon'),
          h('span', { class: 'storageSwitcher__copy' }, h('strong', {}, 'No bucket'),
            h('small', {}, model.emptyText || (model.loadError ? 'The list of buckets cannot be loaded' : 'No bucket is visible to you')))));
      } else if (!multiple) {
        root.replaceChildren(h('div', { class: 'storageSwitcher__trigger is-static', title: details(instance), 'aria-describedby': 'storageSwitcherInfo' },
          ic(storageIcon(instance), 'storageSwitcher__icon'), switcherCopy(instance)), infoLink(instance));
      } else {
        trigger = h('button', {
          type: 'button',
          class: 'storageSwitcher__trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': 'false',
          'aria-controls': 'storageSwitcherMenu',
          'aria-describedby': 'storageSwitcherInfo',
          title: details(instance),
          onclick: event => { event.stopPropagation(); toggle(); },
          onkeydown: event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); open(true); }
          }
        }, ic(storageIcon(instance), 'storageSwitcher__icon'), switcherCopy(instance), ic('chevron-down', 'storageSwitcher__chevron'));
        menu = h('div', {
          id: 'storageSwitcherMenu', class: 'storageSwitcher__menu', role: 'dialog', 'aria-label': 'Storage hosts and buckets', hidden: true,
          onclick: event => event.stopPropagation(),
          onkeydown: onKey
        }, hosts().map(host => {
          const expanded = expandedHosts[host.id] === true;
          const list = h('div', { class: 'storageHost__buckets', role: 'group', 'aria-label': `${host.id} buckets`, hidden: !expanded },
            // An entry is the button of the bucket, and next to it the link of its state icons to its information
            // page: a button cannot hold a link. The rows of a host share their columns, so the icons make one column.
            host.instances.map(entry => h('div', { class: 'storageBucket__row', 'data-instance': entry.id },
              h('button', {
                type: 'button',
                class: 'storageBucket',
                'aria-current': entry.id === model.currentId ? 'true' : null,
                'data-instance': entry.id,
                title: details(entry),
                onclick: () => {
                  close(true);
                  onSelect(entry);
                }
              },
              h('span', { class: 'storageBucket__copy' },
                h('span', { class: 'storageBucket__titleRow' }, h('strong', {}, storageName(entry)),
                  entry.rootPrefix ? h('small', { class: 'storageBucket__prefix' }, `/${entry.rootPrefix}`) : null, h('span', { class: 'bucketMarks' })))),
              infoLink(entry, { inMenu: true }))));
          const row = h('button', {
            type: 'button', class: 'storageHost__row', 'aria-expanded': expanded ? 'true' : 'false', 'data-host': host.id,
            // The row of a host is one line: the volumes say what they are in the tooltip.
            title: isVolume(host) ? 'The folders of the server that the browser shows as buckets (provider FS)' : null,
            onclick: () => {
              const openHost = row.getAttribute('aria-expanded') !== 'true';
              expandedHosts[host.id] = openHost;
              row.setAttribute('aria-expanded', String(openHost));
              list.hidden = !openHost;
            }
          }, ic('chevron-right', 'storageHost__chevron'), ic(storageIcon(host)),
          h('span', { class: 'storageHost__copy' }, h('strong', {}, host.id),
            h('small', {}, `${host.provider.toUpperCase()} · ${plural(host.instances.length, isVolume(host) ? 'volume' : 'bucket')}`)));
          return h('section', { class: 'storageHost', 'data-host': host.id }, row, list);
        }));
        root.replaceChildren(trigger, infoLink(instance), menu);
      }
    }

    // The facts of the current bucket in the trigger and of each bucket in the list, the marks of a full bucket and the
    // tooltips. An open list stays open.
    function refresh() {
      const instance = current();
      const readable = Boolean(instance) && canList(instance);
      fillNodes(root.querySelector('.storageSwitcher__facts'), readable ? bucketFacts(instance, { trigger: true }) : []);
      if (instance) fillInfo(root.querySelector('.storageSwitcher__info'), instance);
      const full = readable && fullUsage(instance);
      const others = model.instances.filter(entry => entry !== instance && fullUsage(entry));
      const otherText = others.length === 1 ? `Another bucket is almost full: ${storageName(others[0])}`
        : `Other buckets are almost full: ${others.map(storageName).join(', ')}`;
      const marks = root.querySelector('.storageSwitcher__trigger .bucketMarks');
      if (marks) {
        fillNodes(marks, [full ? fullMark(instance) : null,
          others.length ? h('span', { class: 'bucketMark is-other', role: 'img', title: otherText, 'aria-label': otherText, 'data-mark': 'other' }, ic('alert-triangle')) : null].filter(Boolean));
      }
      root.classList.toggle('is-full', full);
      const triggerNode = root.querySelector('.storageSwitcher__trigger');
      if (instance && triggerNode && !triggerNode.dataset.empty && !model.loading) triggerNode.title = details(instance);
      for (const node of menu?.querySelectorAll('.storageBucket[data-instance]') || []) {
        const entry = model.instances.find(item => item.id === node.dataset.instance);
        if (!entry) continue;
        fillNodes(node.parentElement.querySelector('.bucketFacts'), canList(entry) ? bucketFacts(entry) : []);
        fillInfo(node.parentElement.querySelector('.storageBucket__info'), entry, { inMenu: true });
        fillNodes(node.querySelector('.bucketMarks'), fullUsage(entry) ? [fullMark(entry)] : []);
        node.classList.toggle('is-full', fullUsage(entry));
        node.title = details(entry);
      }
      onRefresh({ instance, full });
    }

    // --- Open and close ------------------------------------------------------------------------------------------

    function items() {
      return Array.from(menu?.querySelectorAll('.storageHost__row, .storageBucket:not([hidden])') || [])
        .filter(node => node.offsetParent !== null);
    }

    function open(focus = false) {
      if (!menu || !menu.hidden) return;
      beforeOpen();
      // The host of the current bucket opens with the list.
      const host = String(current()?.host || '');
      if (host && expandedHosts[host] !== true) {
        expandedHosts[host] = true;
        const row = menu.querySelector(`.storageHost__row[data-host="${CSS.escape(host)}"]`);
        row?.setAttribute('aria-expanded', 'true');
        if (row) row.nextElementSibling.hidden = false;
      }
      menu.hidden = false;
      root.classList.add('is-open');
      // The usage of each bucket goes into its line. The page and the server keep each answer for 60 seconds.
      loadAllUsage();
      trigger.setAttribute('aria-expanded', 'true');
      if (focus) (menu.querySelector('.storageBucket[aria-current="true"]') || items()[0])?.focus();
    }

    function close(focus = false) {
      if (!menu || menu.hidden) return;
      menu.hidden = true;
      root.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }

    function toggle() {
      if (menu?.hidden) open(false);
      else close(false);
    }

    // The arrows Up and Down go from row to row. The arrow Right goes from a bucket to the link of its state icons,
    // and the arrow Left goes back. Tab goes through the controls of the list, and closes it when the focus leaves it.
    function onKey(event) {
      const active = document.activeElement;
      const link = active?.closest?.('.storageBucket__info');
      const rows = items();
      const index = rows.indexOf(link ? link.previousElementSibling : active);
      if (event.key === 'ArrowDown') { event.preventDefault(); rows[Math.min(rows.length - 1, index + 1)]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); rows[Math.max(0, index - 1)]?.focus(); }
      else if (event.key === 'ArrowRight' && active?.classList?.contains('storageBucket')) { event.preventDefault(); active.nextElementSibling?.focus(); }
      else if (event.key === 'ArrowLeft' && link) { event.preventDefault(); link.previousElementSibling?.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') {
        const controls = Array.from(menu.querySelectorAll('button, a[href]')).filter(node => node.offsetParent !== null);
        const next = controls.indexOf(active) + (event.shiftKey ? -1 : 1);
        if (next < 0 || next >= controls.length) close(false);
      }
    }

    // --- Reads -----------------------------------------------------------------------------------------------------

    // The answer of GET /api/lifecycle gives the versioning status and the rules of the bucket in one read.
    function setBucketInfo(id, answer) {
      if (!id) return;
      bucketInfo = { ...bucketInfo, [id]: { versioning: String(answer?.editor?.versioning || ''), rules: Array.isArray(answer?.rules) ? answer.rules : [] } };
      refresh();
    }

    async function loadInfo(instance, { force = false } = {}) {
      if (!instance || instance.lifecycleSupported === false || isVolume(instance) || !canList(instance)) return;
      if (bucketInfo[instance.id] && !force) return;
      try {
        setBucketInfo(instance.id, await BB.api.lifecycle(instance.id));
      } catch (error) {
        console.warn('Unable to load the lifecycle rules for the state icons of the bucket', error);
      }
    }

    function loadUsage(instance, { fresh = false } = {}) {
      if (instance?.usageSupported !== true || !canList(instance)) return Promise.resolve(null);
      const read = BB.usage.load(instance, { fresh }).then(answer => { refresh(); return answer; });
      refresh();
      return read;
    }

    // The usage of every bucket: the line of each bucket in the list, and the mark of a full bucket.
    function loadAllUsage() {
      for (const entry of model.instances) {
        if (entry.usageSupported === true && canList(entry)) void BB.usage.load(entry).then(refresh);
      }
      refresh();
    }

    // The facts of an instance: its versioning and its rules, and its usage.
    function loadStatus(instance, { fresh = false } = {}) {
      void loadInfo(instance, { force: fresh });
      void loadUsage(instance, { fresh });
    }

    function setState(next = {}) {
      Object.assign(model, next);
      render();
      refresh();
    }

    document.addEventListener('click', event => { if (!root.contains(event.target)) close(false); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(false); });
    // A save of the lifecycle rules changes the count of the rules in the state icons of the bucket.
    if (watchLifecycle) {
      document.addEventListener('bb:lifecycle-changed', event => {
        const id = String(event.detail?.instance || model.currentId || '');
        const instance = model.instances.find(item => item.id === id);
        if (instance) void loadInfo(instance, { force: true });
      });
    }

    return {
      setState, refresh, open, close, toggle, setBucketInfo, loadInfo, loadUsage, loadAllUsage, loadStatus,
      bucketState, details, fullUsage, isOpen: () => Boolean(menu && !menu.hidden)
    };
  }

  BB.switcher = { create, infoPageURL };
})();
