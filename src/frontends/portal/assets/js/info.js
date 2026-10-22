/*
 * The information page of a bucket or a volume: /-/<host>/<bucket>/?info. It is read only, and the bucket selector
 * opens it (the state icons of the trigger and of each entry of the list). The page has the visual language of the
 * System page of ClickHouse Dash: a row of section links under the header, then parts with a heading, tiles for the
 * numbers, cards with key-value lists, gauges for the used parts, and status chips. Each row shows only when it is
 * known. The parts:
 * - summary: tiles with what the bucket holds, the quota, the storage, the free bytes, and read, write and delete;
 * - identity and permissions: the name, the id, the kind of storage, the host, the bucket, the root prefix and the
 *   region; read, write and delete with the reason of each decision (the ceiling of the configuration,
 *   server.access_mode = "force_read_only", the access policy). It never shows an endpoint, an admin URL, a token or
 *   the path of a volume on the server;
 * - storage: what the bucket or the volume holds, its quota, and the capacity of the storage behind it (GET /api/usage);
 * - functions: versioning, encryption, Object Lock, lifecycle rules (GET /api/lifecycle), tags, the edit of the
 *   metadata, the incomplete uploads and the SHA-256 checksum of the uploads.
 * The chips have the colours of the state icons of the selector: green (on, allowed), orange (on, with a problem) and
 * grey (off, not available, denied). The data comes from /api/instances, /api/usage and /api/lifecycle. A source that
 * the person cannot read gives "Not allowed". The button of the lifecycle rules opens the listing of the bucket with
 * ?lifecycle, which opens the editor there.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const ic = name => h('i', { class: `ic ic-${name}`, 'aria-hidden': 'true' });
  const byId = id => document.getElementById(id);
  const count = value => Number(value || 0).toLocaleString('en-US');
  const plural = (value, one, many = `${one}s`) => `${count(value)} ${Number(value) === 1 ? one : many}`;
  const bytes = value => BB.usage.formatBytes(value);
  const mark = approximate => (approximate ? '~' : '');
  // A percent as the selector shows it: "<1 %" for a small part, else the whole number.
  const percentText = (value, approximate = false) => {
    const number = Number(value) || 0;
    return number > 0 && number < 1 ? '<1 %' : `${mark(approximate)}${Math.floor(number)} %`;
  };
  // The tone of a used part: a warning from 80 %, an error from 95 % (the level of the server).
  const levelTone = level => (level === 'error' ? 'error' : level === 'warning' ? 'warn' : '');

  const FLAVOURS = { aws: 'AWS S3', minio: 'MinIO', seaweedfs: 'SeaweedFS', garage: 'Garage' };
  const NOT_ALLOWED = 'You cannot read this bucket.';

  const isVolume = instance => String(instance?.provider || '') === 'fs';
  const noun = instance => (isVolume(instance) ? 'volume' : 'bucket');
  const can = (instance, operation) => (BB.capabilities?.actionable ? BB.capabilities.actionable(instance, operation) : true);

  // --- Parts of the page ----------------------------------------------------------------------------------------------

  // A status chip: "on" (green), "warn" (orange), "off" (grey) or "accent".
  const chip = (tone, text, title = '') => h('span', { class: ['infoChip', `infoChip--${tone}`], 'data-tone': tone, title: title || null }, text);

  // A part of the page: a heading (h2), a count or a note, and the body.
  function part(key, title, extra, ...body) {
    return h('section', { class: 'infoPart', id: `info-${key}`, 'data-part': key, 'aria-labelledby': `info-${key}-title` },
      h('div', { class: 'infoPart__head' }, h('h2', { class: 'infoPart__title', id: `info-${key}-title` }, title),
        extra ? h('span', { class: 'infoPart__count' }, extra) : null),
      h('div', { class: 'infoPart__body' }, body));
  }

  // A card: a title (h3), a count and a chip, then the content.
  function card(key, title, { countText = '', badge = null } = {}, ...body) {
    return h('section', { class: 'infoCard', 'data-card': key },
      h('div', { class: 'infoCard__head' }, h('h3', { class: 'infoCard__title' }, title),
        countText ? h('span', { class: 'infoCard__count' }, countText) : null, badge),
      body);
  }

  // Two cards side by side on a wide window: the larger one first.
  const grid = (main, side) => h('div', { class: 'infoGrid' }, h('div', { class: 'infoGrid__main' }, main), side ? h('div', { class: 'infoGrid__side' }, side) : null);

  // A row of a key-value list: the term, the value (text or nodes) and a note. A row without a value is left out.
  const row = (term, value, note = '', key = '') => (value === null || value === undefined || value === '' ? null : { term, value, note, key });

  function kv(rows, label) {
    return h('dl', { class: 'infoKv', 'aria-label': label || null }, rows.filter(Boolean).map(item =>
      h('div', { class: 'infoKv__row', 'data-row': item.key || null },
        h('dt', { class: 'infoKv__key' }, item.term),
        h('dd', { class: 'infoKv__value' }, h('span', { class: 'infoKv__main' }, item.value),
          item.note ? h('span', { class: 'infoKv__note' }, item.note) : null))));
  }

  // A tile: a label, the value and a sub line. tone: "ok", "warn", "error" or "off".
  const tile = ({ key, label, value, sub = '', tone = '', title = '' }) => h('div', { class: ['infoTile', tone && `is-${tone}`], 'data-tile': key, title: title || null },
    h('span', { class: 'infoTile__label' }, label), h('span', { class: 'infoTile__value' }, value), sub ? h('span', { class: 'infoTile__sub' }, sub) : null);

  // A gauge, as a disk of the System page of Dash: its name and chips, the percent over a track, a summary and facts.
  function gauge({ key, title, chips = [], percent = null, level = '', approximate = false, value = '', summary = '', facts = [], note = '' }) {
    const tone = levelTone(level);
    const meter = percent === null ? null : h('div', { class: 'infoGauge__meter', 'data-fill': tone || 'ok' },
      h('span', { class: 'infoGauge__percent' }, percentText(percent, approximate)),
      h('span', { class: 'infoGauge__track', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent), 'aria-label': `Used part: ${title}` },
        h('span', { class: 'infoGauge__fill' })));
    if (meter) meter.querySelector('.infoGauge__fill').style.width = `${Math.min(100, Math.max(Number(percent) || 0, percent > 0 ? 1 : 0))}%`;
    return h('section', { class: 'infoGauge', 'data-gauge': key, 'data-fill': tone || 'ok', 'aria-label': title },
      h('header', { class: 'infoGauge__head' }, h('h3', { class: 'infoGauge__name' }, title), h('span', { class: 'infoGauge__chips' }, chips)),
      meter, value ? h('div', { class: 'infoGauge__value' }, value) : null,
      summary ? h('p', { class: 'infoGauge__summary' }, summary) : null,
      facts.filter(Boolean).length ? h('dl', { class: 'infoGauge__facts' }, facts.filter(Boolean).map(item =>
        h('div', { class: 'infoGauge__fact', 'data-fact': item.key || null }, h('dt', {}, item.term), h('dd', {}, item.value)))) : null,
      note ? h('p', { class: 'infoGauge__note' }, note) : null);
  }

  // A part without numbers: a title and the reason, in a dashed box.
  const empty = (title, text, key = '') => h('div', { class: 'infoEmpty', 'data-empty': key || null }, h('strong', {}, title), text ? h('span', {}, text) : null);

  // --- Identity and permissions ---------------------------------------------------------------------------------------

  function kindText(instance) {
    if (isVolume(instance)) return 'Mounted folder of the server';
    if (instance.provider === 'gcs') return 'Google Cloud Storage';
    return FLAVOURS[instance.flavour] || 'S3';
  }

  function identityRows(instance) {
    return [
      row('Name', instance.name, '', 'name'),
      row('Id', h('span', { class: 'mono' }, instance.id), 'The label of the block in the configuration, and the id of the resource of the access policy.', 'id'),
      row('Kind', kindText(instance), instance.provider === 's3' && !FLAVOURS[instance.flavour] ? 'The server did not recognise the S3 provider.' : '', 'kind'),
      row('Host', h('span', { class: 'mono' }, instance.host), '', 'host'),
      isVolume(instance)
        ? row('Bucket', 'None: a volume', 'The server reads and writes the files of the folder with the identity of its process.', 'bucket')
        : row('Bucket', h('span', { class: 'mono' }, instance.bucket), '', 'bucket'),
      row('Root prefix', instance.rootPrefix ? h('span', { class: 'mono' }, `/${instance.rootPrefix}`) : '', `The browser shows only this part of the ${noun(instance)}.`, 'root-prefix'),
      row('Region', instance.region ? h('span', { class: 'mono' }, instance.region) : '', '', 'region')
    ];
  }

  // The reason of a decision, in the words of its source.
  function decisionSource(state) {
    switch (String(state?.source || '')) {
      case 'configuration': return 'The permissions of the block in the configuration do not give it.';
      case 'runtime': return 'server.access_mode = "force_read_only" refuses each write and each delete.';
      case 'access': return 'The access policy (AuthZEN) does not give it to you.';
      case 'provider': return 'The storage provider refused a real request a short time ago.';
      default: return '';
    }
  }

  // Allowed and allowed on use are green, denied is grey: the colours of the icons of the selector.
  const permissionTone = state => (BB.capabilities.normalizeState(state) === 'denied' ? 'off' : 'on');

  function permissionRows(instance) {
    const caps = instance.capabilities || {};
    const rows = BB.states.permissions(instance).map(item => {
      const name = BB.capabilities.normalizeState(item.state);
      const badge = h('span', { class: ['infoChip', `infoChip--${permissionTone(item.state)}`], 'data-permission': item.key, 'data-state': name },
        ic(item.icon), BB.capabilities.stateLabel(item.state));
      const reasons = [name === 'denied' ? decisionSource(item.state) : '', String(item.state.reason || '')].filter(Boolean);
      return row(item.label, badge, reasons.join(' '), item.key);
    });
    const provider = Array.from(caps.permissions || []).map(String).join(', ');
    rows.push(row('Permissions of the configuration', provider ? h('span', { class: 'mono' }, provider) : 'Not reported', '', 'configuration'));
    if (isVolume(instance)) {
      const write = BB.capabilities.normalizeState(caps.write || {});
      rows.push(row('Writable', write === 'denied' ? chip('off', 'No') : chip('on', 'Yes'), 'The start of the server checks that its process can write in the folder.', 'writable'));
    }
    return rows;
  }

  function permissionCount(instance) {
    const allowed = BB.states.permissions(instance).filter(item => permissionTone(item.state) === 'on').length;
    return `${allowed} of 3 allowed`;
  }

  // --- Storage --------------------------------------------------------------------------------------------------------

  const usageShown = usage => usage?.supported === true && (usage.available === true || Boolean(usage.storage));
  const lineNote = (usage, term) => BB.usage.lines(usage).find(line => line.term === term)?.note || '';

  // What the bucket holds: "~12 MB", and for a volume "computing…" or "at least 10 GB" while the count runs.
  function holdsText(usage) {
    const volume = usage.source === 'statfs';
    if (!volume) return `${mark(usage.approximate)}${bytes(usage.usedBytes)}`;
    const amount = Number(usage.selfBytes ?? usage.usedBytes) || 0;
    if (usage.selfState === 'computing') return amount > 0 ? `≥ ${bytes(amount)}` : 'computing…';
    return `${usage.selfState === 'partial' ? '≥ ' : ''}${bytes(amount)}`;
  }

  function holdsSub(usage) {
    const volume = usage.source === 'statfs';
    if (volume && usage.selfState !== 'ready') return usage.selfState === 'computing' ? 'the count runs' : 'the count stopped at its limit';
    return Number(usage.usedObjects) >= 0 ? plural(usage.usedObjects, volume ? 'file' : 'object') : '';
  }

  function summaryTiles(instance, usage) {
    const tiles = [];
    if (usageShown(usage) && usage.available === true) {
      tiles.push(tile({ key: 'holds', label: isVolume(instance) ? 'This volume holds' : 'This bucket holds', value: holdsText(usage), sub: holdsSub(usage) }));
      if (Number(usage.limitBytes) > 0) {
        const quota = usage.quotaPercent ?? usage.percent;
        tiles.push(tile({ key: 'quota', label: 'Quota', value: percentText(quota, usage.approximate), tone: levelTone(usage.quotaLevel ?? usage.level),
          sub: `${mark(usage.approximate)}${bytes(usage.usedBytes)} of ${bytes(usage.limitBytes)}` }));
      }
    }
    if (usageShown(usage) && usage.storage) {
      const storage = usage.storage;
      tiles.push(tile({ key: 'storage', label: 'Storage', value: percentText(storage.percent, storage.approximate), tone: levelTone(storage.level),
        sub: `${mark(storage.approximate)}${bytes(storage.usedBytes)} of ${bytes(storage.totalBytes)}` }));
      tiles.push(tile({ key: 'free', label: 'Free', value: bytes(storage.freeBytes), sub: isVolume(instance) ? 'on the file system' : 'on the storage' }));
    }
    for (const item of BB.states.permissions(instance)) {
      tiles.push(tile({ key: item.key, label: item.label, value: BB.capabilities.stateLabel(item.state), tone: permissionTone(item.state) === 'on' ? 'ok' : 'off',
        title: String(item.state.reason || '') }));
    }
    return h('div', { class: 'infoTiles', role: 'group', 'aria-label': 'Summary' }, tiles);
  }

  function storageBody(instance, usage) {
    if (instance.usageSupported !== true) {
      return empty('Not available', isVolume(instance)
        ? 'This build of the server cannot read the size of the file system.'
        : 'The configuration has no usage block for this bucket: the server does not read its usage. AWS S3 has no quota and no limit of its storage.', 'unsupported');
    }
    if (!can(instance, 'list')) return empty('Not allowed', NOT_ALLOWED, 'not-allowed');
    if (usage === undefined) return empty('Loading the usage…', '', 'loading');
    if (!usage || usage.supported !== true) return empty('Not available', '', 'unavailable');
    const volume = isVolume(instance);
    const holdsTerm = volume ? 'This volume holds' : 'This bucket holds';
    const counted = usage.asOf ? BB.runtime.formatDateTimeUTC(usage.asOf) : '';
    const cards = [];
    if (usage.available === true) {
      cards.push(gauge({
        key: 'holds', title: holdsTerm, value: holdsText(usage), summary: holdsSub(usage),
        chips: usage.approximate ? [chip('warn', 'Approximate', usage.approximateReason || '')] : [],
        facts: [
          { key: 'source', term: 'Source', value: BB.usage.sourceName(usage) },
          counted ? { key: 'counted', term: 'Counted', value: counted } : null,
          volume && usage.selfState === 'partial' ? { key: 'limit', term: 'Count of the files', value: 'Stopped at its limit: 1,000,000 entries or 20 seconds' } : null
        ],
        note: lineNote(usage, holdsTerm)
      }));
      if (Number(usage.limitBytes) > 0) {
        cards.push(gauge({
          key: 'quota', title: 'Quota', percent: Number(usage.quotaPercent ?? usage.percent) || 0, level: usage.quotaLevel ?? usage.level, approximate: usage.approximate,
          chips: [chip('accent', usage.limitSource === 'config' ? 'Set by S3-Browser' : 'Set by the provider')],
          summary: `${mark(usage.approximate)}${bytes(usage.usedBytes)} used of ${bytes(usage.limitBytes)}`,
          facts: [
            { key: 'left', term: 'Left', value: bytes(Math.max(0, Number(usage.limitBytes) - Number(usage.usedBytes))) },
            Number(usage.limitObjects) > 0 && Number(usage.usedObjects) >= 0 ? { key: 'objects', term: 'Objects', value: `${count(usage.usedObjects)} of ${count(usage.limitObjects)}` } : null
          ],
          note: lineNote(usage, 'Quota')
        }));
      }
    } else if (usage.error) {
      cards.push(gauge({ key: 'holds', title: holdsTerm, chips: [chip('warn', 'Unavailable')], note: usage.error.message || '' }));
    }
    if (usage.storage) {
      const storage = usage.storage;
      cards.push(gauge({
        key: 'storage', title: 'Storage', percent: Number(storage.percent) || 0, level: storage.level, approximate: storage.approximate,
        chips: storage.approximate ? [chip('warn', 'Approximate', storage.approximateReason || '')] : [],
        summary: `${mark(storage.approximate)}${bytes(storage.usedBytes)} used of ${bytes(storage.totalBytes)}`,
        facts: [{ key: 'free', term: 'Free', value: bytes(storage.freeBytes) }],
        note: lineNote(usage, 'Storage')
      }));
    } else if (usage.storageError) {
      cards.push(gauge({ key: 'storage', title: 'Storage', chips: [chip('warn', 'Unavailable')], note: usage.storageError.message || '' }));
    }
    return cards.length ? h('div', { class: 'infoGauges' }, cards) : empty('Not available', '', 'unavailable');
  }

  // --- Functions ------------------------------------------------------------------------------------------------------

  // The versioning: the read of the rules of the page, else the probe of the server at start.
  function versioningOf(instance, lifecycle) {
    const editor = String(lifecycle?.editor?.versioning || '');
    if (lifecycle && Array.isArray(lifecycle.rules)) return { Enabled: 'enabled', Suspended: 'suspended' }[editor] || 'off';
    return String(instance.versioningState || '');
  }

  const rulesOf = (instance, lifecycle) => (Array.isArray(lifecycle?.rules) ? lifecycle.rules : Number.isInteger(instance.lifecycleRules) ? instance.lifecycleRules : null);

  function versioningRow(instance, lifecycle) {
    if (instance.versioningSupported !== true) return row('Versioning', chip('off', 'Not available'), 'This provider has no versions.', 'versioning');
    switch (versioningOf(instance, lifecycle)) {
      case 'enabled': return row('Versioning', chip('on', 'Enabled'), 'A change or a delete keeps the older versions of a file.', 'versioning');
      case 'suspended': return row('Versioning', chip('warn', 'Suspended'), 'The bucket keeps the older versions that it has, and makes no new ones.', 'versioning');
      case 'off': return row('Versioning', chip('off', 'Never enabled'), '', 'versioning');
      default: return row('Versioning', chip('off', 'Unknown'), 'The server could not read the versioning of the bucket.', 'versioning');
    }
  }

  function encryptionRows(instance) {
    const lock = BB.encryption?.bucketLock(instance);
    const asked = instance.encryption === 'sse-s3';
    const configured = asked
      ? [chip(instance.encryptionApplied === 'no' ? 'warn' : 'on', 'SSE-S3'), ' for each write (encryption = "sse-s3")']
      : [chip('off', 'No header'), ' the default encryption of the bucket applies'];
    const name = BB.states.ENCRYPTION_NAMES[instance.defaultEncryption] || instance.defaultEncryption;
    const bucketDefault = instance.bucketEncryptionSupported === true ? (instance.defaultEncryption ? chip('on', name) : chip('off', 'None')) : '';
    const applied = { yes: chip('on', 'Yes'), no: [chip('warn', 'No'), ' the provider accepts the header and does not encrypt (Garage)'], unknown: chip('off', 'Unknown') }[instance.encryptionApplied] || '';
    return [
      row('Encryption of the writes', configured, '', 'encryption'),
      row('Default encryption of the bucket', bucketDefault, '', 'default-encryption'),
      row('The provider applies SSE-S3', applied, lock?.tone === 'warn' ? lock.title : '', 'encryption-applied')
    ];
  }

  function lifecycleRow(instance, lifecycle) {
    if (instance.lifecycleSupported === false) return row('Lifecycle rules', chip('off', 'Not available'), '', 'lifecycle');
    if (!can(instance, 'list')) return row('Lifecycle rules', chip('off', 'Not allowed'), NOT_ALLOWED, 'lifecycle');
    if (lifecycle === undefined) return row('Lifecycle rules', 'Loading…', '', 'lifecycle');
    const rules = rulesOf(instance, lifecycle);
    let state;
    if (Array.isArray(rules)) {
      const enabled = rules.filter(item => item.enabled).length;
      state = !rules.length ? chip('off', 'No rule') : [chip(enabled ? 'on' : 'off', `${count(enabled)} on`), ` of ${plural(rules.length, 'rule')}`];
    } else {
      state = rules == null ? chip('off', 'Unknown') : chip(rules > 0 ? 'on' : 'off', rules > 0 ? plural(rules, 'rule') : 'No rule');
    }
    const target = `${BB.api.browserPageURL('', { instance: instance.id })}?lifecycle`;
    const open = h('a', { class: 'button infoAction', href: target, 'data-info-lifecycle': '' }, ic('hourglass'), 'Open the lifecycle rules');
    return row('Lifecycle rules', [state, open], 'The editor opens on the listing of the bucket.', 'lifecycle');
  }

  function checksumRow(instance) {
    if (instance.provider === 's3') return row('SHA-256 checksum of the uploads', [chip('on', 'Yes'), ' each part of an upload carries its SHA-256, and the provider checks it where it can'], '', 'checksum');
    if (isVolume(instance)) return row('SHA-256 checksum of the uploads', [chip('on', 'Yes'), ' the server checks the SHA-256 of an upload in one request'], '', 'checksum');
    return row('SHA-256 checksum of the uploads', chip('off', 'No'), '', 'checksum');
  }

  const supported = (value, yes = 'Yes') => (value ? chip('on', yes) : chip('off', 'Not available'));

  function functionCards(instance, lifecycle) {
    if (isVolume(instance)) {
      return grid(card('volume', 'Functions of a mounted folder', {}, kv([
        row('Folders', chip('on', 'Real folders'), 'An empty folder exists.', 'folders'),
        row('Incomplete uploads', supported(instance.multipartUploadsSupported === true), 'The temporary files of the uploads that stopped.', 'multipart'),
        checksumRow(instance),
        row('Versions, tags, metadata, lifecycle rules, Object Lock, encryption of S3', chip('off', 'Not available for a mounted folder'), '', 'not-available')
      ], 'Functions')));
    }
    const lockDefault = instance.objectLockSupported === true && instance.objectLockDefault ? `Default retention: ${BB.objectLock.defaultText(instance.objectLockDefault)}` : '';
    return grid(
      card('protection', 'Data protection', {}, kv([
        versioningRow(instance, lifecycle),
        ...encryptionRows(instance),
        row('Object Lock', instance.objectLockSupported === true ? chip('on', 'On') : chip('off', 'Off'), lockDefault, 'object-lock')
      ], 'Data protection')),
      card('operations', 'Operations', {}, kv([
        lifecycleRow(instance, lifecycle),
        row('Tags', supported(instance.tagsSupported === true), '', 'tags'),
        row('Edit of the metadata', supported(instance.metadataEditSupported === true), '', 'metadata'),
        row('Incomplete uploads', supported(instance.multipartUploadsSupported === true), 'The list and the abort of the incomplete multipart uploads.', 'multipart'),
        checksumRow(instance)
      ], 'Operations')));
  }

  // --- Selector ---------------------------------------------------------------------------------------------------------
  // The selector of the page: the same hosts and buckets as the selector of the listing. An entry opens the information
  // page of the bucket, not its listing. The classes are the classes of the selector of the listing.

  const infoURL = instance => `${BB.api.browserPageURL('', { instance: instance.id })}?info`;

  function statesOf(instance) {
    const rules = Number.isInteger(instance.lifecycleRules) ? instance.lifecycleRules : null;
    return BB.states.list(instance, { versioning: String(instance.versioningState || ''), rules });
  }

  function renderSelector(instances, current) {
    const root = byId('storageSwitcher');
    if (!root || instances.length < 2) return;
    const hosts = [];
    instances.forEach(item => {
      const id = String(item.host || item.id || '');
      let host = hosts.find(entry => entry.id === id);
      if (!host) { host = { id, provider: String(item.provider || ''), instances: [] }; hosts.push(host); }
      host.instances.push(item);
    });
    const trigger = h('button', {
      type: 'button', class: 'storageSwitcher__trigger', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'storageSwitcherMenu',
      title: [current.name || current.id, `id: ${current.id}`, `host: ${current.host}`].join('\n')
    }, ic(isVolume(current) ? 'folder-open' : 'database'),
    h('span', { class: 'storageSwitcher__copy' }, h('span', { class: 'storageSwitcher__titleRow' }, h('strong', {}, current.name || current.id))),
    ic('chevron-down'));
    trigger.firstChild.classList.add('storageSwitcher__icon');
    trigger.lastChild.classList.add('storageSwitcher__chevron');
    const menu = h('div', { id: 'storageSwitcherMenu', class: 'storageSwitcher__menu', role: 'dialog', 'aria-label': 'Storage hosts and buckets', hidden: true },
      hosts.map(host => {
        const expanded = host.id === String(current.host || current.id || '');
        const list = h('div', { class: 'storageHost__buckets', role: 'group', 'aria-label': `${host.id} buckets`, hidden: !expanded },
          host.instances.map(entry => {
            const states = statesOf(entry);
            const link = h('a', { class: 'storageBucket__info', href: infoURL(entry), 'data-volume': isVolume(entry) ? 'true' : null, 'aria-label': states.map(item => item.text).join(', ') },
              h('span', { class: 'stateGroup' }, BB.states.nodes(states, { tip: false })), h('span', { class: 'bucketFacts' }));
            return h('div', { class: 'storageBucket__row', 'data-instance': entry.id },
              h('a', { class: 'storageBucket', href: infoURL(entry), 'aria-current': entry.id === current.id ? 'true' : null,
                title: [entry.name || entry.id, `id: ${entry.id}`, `host: ${entry.host}`].join('\n') },
              h('span', { class: 'storageBucket__copy' }, h('span', { class: 'storageBucket__titleRow' }, h('strong', {}, entry.name || entry.id),
                entry.rootPrefix ? h('small', { class: 'storageBucket__prefix' }, `/${entry.rootPrefix}`) : null))),
              link);
          }));
        const row = h('button', {
          type: 'button', class: 'storageHost__row', 'aria-expanded': expanded ? 'true' : 'false', 'data-host': host.id,
          onclick: () => {
            const open = row.getAttribute('aria-expanded') !== 'true';
            row.setAttribute('aria-expanded', String(open));
            list.hidden = !open;
          }
        }, ic('chevron-right'), ic(isVolume(host) ? 'folder-open' : 'database'),
        h('span', { class: 'storageHost__copy' }, h('strong', {}, host.id),
          h('small', {}, `${host.provider.toUpperCase()} · ${host.instances.length} ${isVolume(host) ? 'volume' : 'bucket'}${host.instances.length === 1 ? '' : 's'}`)));
        row.querySelector('.ic-chevron-right').classList.add('storageHost__chevron');
        return h('section', { class: 'storageHost', 'data-host': host.id }, row, list);
      }));
    const close = focus => {
      if (menu.hidden) return;
      menu.hidden = true;
      root.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    };
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      if (menu.hidden) {
        menu.hidden = false;
        root.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
      } else close(false);
    });
    menu.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => close(false));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(true); });
    root.replaceChildren(trigger, menu);
    root.hidden = false;
  }

  // --- Page -----------------------------------------------------------------------------------------------------------

  const page = { instance: null, usage: undefined, lifecycle: undefined };

  function renderHead(instance) {
    byId('infoChips').replaceChildren(...[chip('accent', kindText(instance)), instance.rootPrefix ? chip('off', `/${instance.rootPrefix}`) : null].filter(Boolean));
    const states = BB.states.list(instance, { versioning: versioningOf(instance, page.lifecycle), rules: rulesOf(instance, page.lifecycle) });
    const strip = byId('infoStates');
    strip.replaceChildren(...BB.states.nodes(states));
    strip.setAttribute('aria-label', states.map(item => item.text).join(', '));
    strip.title = states.map(item => item.text).join('\n');
    strip.hidden = false;
  }

  function render() {
    const instance = page.instance;
    renderHead(instance);
    const sections = byId('infoSections');
    sections.replaceChildren(
      part('summary', 'Summary', '', summaryTiles(instance, page.usage)),
      part('access', 'Identity and permissions', '',
        grid(card('identity', 'Identity', {}, kv(identityRows(instance), 'Identity')),
          card('permissions', 'Permissions', { countText: permissionCount(instance) },
            kv(permissionRows(instance), 'Permissions'),
            h('p', { class: 'infoCard__note' }, 'The page hides what you cannot do. The server checks each request again.')))),
      part('storage', 'Storage', page.usage?.source ? BB.usage.sourceName(page.usage) : '', storageBody(instance, page.usage)),
      part('functions', 'Functions', '', functionCards(instance, page.lifecycle)));
    sections.removeAttribute('aria-busy');
    const banner = byId('infoBanner');
    const text = page.usage ? BB.usage.fullText(page.usage) : '';
    banner.hidden = !text;
    banner.replaceChildren(...(text ? [ic('alert-triangle'), h('span', { class: 'usageBanner__text' }, text)] : []));
  }

  function renderBuild(build) {
    const badge = byId('versionBadge');
    const version = String(build?.version || build?.display || '');
    if (!badge || !version) return;
    const commit = String(build.shortCommit || '');
    badge.textContent = commit && commit !== 'unknown' && !version.includes(commit) ? `${version} (${commit})` : version;
    badge.title = `Server version\n${badge.textContent}${build.date ? `\nBuild: ${build.date}` : ''}`;
  }

  function fail(title, text) {
    byId('infoTitle').textContent = title;
    byId('infoLede').textContent = text;
    byId('infoSections').removeAttribute('aria-busy');
  }

  // The usage. While the count of the files of a volume runs, the page reads it again every 3 seconds, 20 times at most.
  async function loadUsage(instance, fresh, rounds = 20) {
    page.usage = await BB.usage.load(instance, { fresh });
    if (page.usage?.selfState === 'computing' && rounds > 0) {
      window.setTimeout(() => { void loadUsage(instance, true, rounds - 1).then(render); }, 3000);
    }
  }

  async function start() {
    const route = BB.runtime.storageRoute();
    let payload;
    try {
      payload = await BB.api.instances();
    } catch (error) {
      fail('The information cannot be loaded', String(error?.message || error));
      return;
    }
    renderBuild(payload?.build);
    const instance = (payload?.instances || []).find(item => String(item.host || item.id || '') === route?.host && item.id === route?.bucket);
    if (!instance) {
      fail('No such bucket', 'This bucket does not exist, or you cannot see it.');
      return;
    }
    page.instance = instance;
    renderSelector(payload.instances || [], instance);
    BB.api.setInstance(instance);
    const back = byId('infoBack');
    back.href = BB.api.browserPageURL('', { instance: instance.id });
    back.title = `Back to ${instance.name || instance.id}`;
    // A narrow window shows only the chevron of the link: the label names it.
    back.setAttribute('aria-label', back.title);
    back.querySelector('.backLink__text').textContent = `Back to ${instance.name || instance.id}`;
    document.title = `${instance.name || instance.id} - Information`;
    byId('infoTitle').textContent = instance.name || instance.id;
    byId('infoLede').textContent = `Information and permissions of this ${noun(instance)}. Read only.`;
    render();
    const reads = [];
    if (instance.usageSupported === true && can(instance, 'list')) reads.push(loadUsage(instance, false));
    if (instance.lifecycleSupported !== false && !isVolume(instance) && can(instance, 'list')) {
      reads.push(BB.api.lifecycle(instance.id).then(answer => { page.lifecycle = answer; }, () => { page.lifecycle = null; }));
    }
    await Promise.all(reads.map(read => read.then(render)));
    render();
  }

  void start();
})();
