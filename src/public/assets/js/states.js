/*
 * BB.states: the seven state icons of a bucket or a volume, always in this order: read, write, delete, encryption,
 * Object Lock, versioning and lifecycle rules. The bucket selector (app.js) and the information page (info.js) show
 * the same icons with the same rules.
 * - list(instance, { versioning, rules }) gives one item for each icon: { key, icon, tone, text, count, s3 }. tone is
 *   "on" (green: allowed, on or active), "off" (grey: off, not available or denied) or "warn" (orange: on, with a
 *   problem). text is the word of the state, for the title, a hidden text and the tooltip. versioning is "enabled",
 *   "suspended", "off" or "" (unknown); rules is the list of the rules, their number, or null (unknown).
 * - nodes(items) gives the elements of the icons.
 * - permissions(instance) gives read, write and delete with their capability state.
 * A volume has the same seven icons: its three permissions, and the four icons of S3 off ("not available for a
 * mounted folder").
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const ENCRYPTION_NAMES = { AES256: 'SSE-S3', 'aws:kms': 'SSE-KMS', 'aws:kms:dsse': 'DSSE-KMS' };

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const ic = name => h('i', { class: `ic ic-${name}`, 'aria-hidden': 'true' });
  const isVolume = instance => String(instance?.provider || '') === 'fs';

  function permissions(instance) {
    const capabilities = instance?.capabilities || {};
    return [
      { key: 'read', label: 'Read', icon: 'eye', state: capabilities.read || {} },
      { key: 'write', label: 'Write', icon: 'pencil', state: capabilities.write || {} },
      { key: 'delete', label: 'Delete', icon: 'trash', state: capabilities.delete || {} }
    ];
  }

  function list(instance, { versioning = '', rules = null } = {}) {
    const out = permissions(instance).map(item => {
      const name = BB.capabilities.normalizeState(item.state);
      return { key: item.key, icon: item.icon, tone: name === 'denied' ? 'off' : 'on', text: `${item.label}: ${BB.capabilities.stateLabel(item.state).toLowerCase()}` };
    });
    // A mounted folder has no encryption, no Object Lock, no versioning and no lifecycle rules: its icons would show
    // a setting that cannot exist, so they are not drawn. It keeps the three icons of the rights.
    if (isVolume(instance)) return out;
    const lock = BB.encryption?.bucketLock(instance);
    const algorithm = instance.encryption === 'sse-s3' && instance.encryptionApplied === 'yes' ? 'AES256' : String(instance.defaultEncryption || (instance.encryption === 'sse-s3' ? 'AES256' : ''));
    const encryption = !lock ? { tone: 'off', text: 'Encryption: off' }
      : lock.tone === 'warn'
        ? { tone: 'warn', text: instance.encryptionApplied === 'no' ? 'Encryption: requested but not applied by this provider' : 'Encryption: requested, the provider may not apply it' }
        : { tone: 'on', text: `Encryption: on (${ENCRYPTION_NAMES[algorithm] || algorithm})` };
    out.push({ key: 'encryption', icon: 'key', ...encryption });
    const retention = instance.objectLockDefault ? `, default retention ${BB.objectLock.defaultText(instance.objectLockDefault)}` : '';
    out.push(instance.objectLockSupported === true
      ? { key: 'object-lock', icon: 'lock', tone: 'on', text: `Object Lock: on${retention}` }
      : { key: 'object-lock', icon: 'lock', tone: 'off', text: 'Object Lock: off' });
    out.push({ key: 'versioning', icon: 'git-commit', ...(versioning === 'enabled' ? { tone: 'on', text: 'Versioning: on' }
      : versioning === 'suspended' ? { tone: 'warn', text: 'Versioning: suspended' }
        : instance.versioningSupported === false ? { tone: 'off', text: 'Versioning: not available on this provider' } : { tone: 'off', text: 'Versioning: off' }) });
    if (instance.lifecycleSupported === false || rules == null) {
      out.push({ key: 'lifecycle', icon: 'hourglass', tone: 'off', text: instance.lifecycleSupported === false ? 'Lifecycle rules: not available on this provider' : 'Lifecycle rules: unknown' });
    } else {
      // The read of the rules gives each rule and its state; the probe of the server gives the number of rules.
      const total = Array.isArray(rules) ? rules.length : rules;
      const enabled = Array.isArray(rules) ? rules.filter(rule => rule.enabled).length : rules;
      out.push({ key: 'lifecycle', icon: 'hourglass', tone: enabled > 0 ? 'on' : 'off', count: enabled > 0 ? enabled : 0,
        text: !total ? 'Lifecycle rules: none' : `Lifecycle rules: ${enabled.toLocaleString('en-US')} on${Array.isArray(rules) ? ` of ${total.toLocaleString('en-US')}` : ''}` });
    }
    return out;
  }

  // The count of the lifecycle rules follows the hourglass when a rule is on.
  // tip: false gives no tooltip on the icons (the selector shows none: the click opens the information page).
  function nodes(items, { tip = true } = {}) {
    return items.map(item => h('span', {
      class: ['stateIcon', `is-${item.tone}`], 'data-state-icon': item.key, 'data-tone': item.tone, 'data-s3': item.s3 ? 'true' : null, title: tip ? item.text : null
    }, ic(item.icon), item.count ? h('span', { class: 'stateIcon__count', 'aria-hidden': 'true' }, item.count.toLocaleString('en-US')) : null,
    h('span', { class: 'visually-hidden' }, `${item.text}. `)));
  }

  BB.states = { list, nodes, permissions, ENCRYPTION_NAMES };
})();
