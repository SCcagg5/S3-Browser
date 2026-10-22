/*
 * The information page of a bucket or a volume: /-/<host>/<bucket>/?info. It is read only, and the bucket selector
 * opens it (the permission icons of the trigger and of each entry of the list). It has four sections, each row only
 * when it is known:
 * - identity: the name, the id, the kind of storage, the host, the bucket, the root prefix and the region. It never shows
 *   an endpoint, an admin URL, a token or the path of a volume on the server;
 * - permissions: read, write and delete for this person, with the reason of each decision (the ceiling of the
 *   configuration, server.access_mode = "force_read_only", the access policy);
 * - storage: what the bucket or the volume holds, its quota, and the capacity of the storage behind it (GET /api/usage);
 * - functions: versioning, encryption, Object Lock, lifecycle rules (GET /api/lifecycle), tags, the edit of the
 *   metadata, the incomplete uploads and the SHA-256 checksum of the uploads.
 * The data comes from /api/instances, /api/usage and /api/lifecycle. A source that the person cannot read gives
 * "Not allowed". The button of the lifecycle rules opens the listing of the bucket with ?lifecycle, which opens the
 * editor there.
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
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const ic = name => h('i', { class: `ic ic-${name}`, 'aria-hidden': 'true' });
  const byId = id => document.getElementById(id);
  const count = value => Number(value || 0).toLocaleString('en-US');
  const plural = (value, one, many = `${one}s`) => `${count(value)} ${Number(value) === 1 ? one : many}`;

  const FLAVOURS = { aws: 'AWS S3', minio: 'MinIO', seaweedfs: 'SeaweedFS', garage: 'Garage' };
  const VOLUME_ONLY = 'Not available for a mounted folder';
  const NOT_ALLOWED = 'Not allowed: you cannot read this bucket.';

  const isVolume = instance => String(instance?.provider || '') === 'fs';
  const noun = instance => (isVolume(instance) ? 'volume' : 'bucket');
  const can = (instance, operation) => (BB.capabilities?.actionable ? BB.capabilities.actionable(instance, operation) : true);

  // A row of a section: the term, the value (text or nodes) and an optional note. A row without a value is left out.
  const row = (term, value, note = '') => (value === null || value === undefined || value === '' ? null : { term, value, note });

  function list(rows) {
    return h('dl', { class: 'infoList' }, rows.filter(Boolean).flatMap(item => [
      h('dt', {}, item.term),
      h('dd', {}, h('span', { class: 'infoList__value' }, item.value), item.note ? h('small', { class: 'infoList__note' }, item.note) : null)
    ]));
  }

  function section(id, title, icon, rows, lede = '') {
    return h('section', { class: 'part infoSection', id: `info-${id}`, 'aria-labelledby': `info-${id}-title` },
      h('h2', { class: 'infoSection__title', id: `info-${id}-title` }, ic(icon), title),
      lede ? h('p', { class: 'part__lede infoSection__lede' }, lede) : null,
      list(rows));
  }

  // A thin bar of a used part, in the colours of the bar of the selector: a warning from 80 %, an error from 95 %.
  function meter(percent, level, label) {
    const node = h('span', { class: ['usageMeter', 'infoMeter', level && `is-${level}`], role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent), 'aria-label': label },
      h('span', { class: 'usageMeter__fill' }));
    node.firstChild.style.width = `${Math.min(100, Math.max(Number(percent) || 0, percent > 0 ? 2 : 0))}%`;
    return node;
  }

  // --- Identity -------------------------------------------------------------------------------------------------------

  function kindText(instance) {
    if (isVolume(instance)) return 'Mounted folder of the server';
    if (instance.provider === 'gcs') return 'Google Cloud Storage';
    return FLAVOURS[instance.flavour] || 'S3';
  }

  function identityRows(instance) {
    return [
      row('Name', instance.name),
      row('Id', instance.id, 'The label of the block in the configuration, and the id of the resource of the access policy.'),
      row('Kind', kindText(instance), instance.provider === 's3' && !FLAVOURS[instance.flavour] ? 'The server did not recognise the S3 provider.' : ''),
      row('Host', instance.host),
      isVolume(instance)
        ? row('Bucket', 'None: a volume', 'The server reads and writes the files of the folder with the identity of its process.')
        : row('Bucket', instance.bucket),
      row('Root prefix', instance.rootPrefix ? `/${instance.rootPrefix}` : '', `The browser shows only this part of the ${noun(instance)}.`),
      row('Region', instance.region)
    ];
  }

  // --- Permissions ----------------------------------------------------------------------------------------------------

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

  function permissionRows(instance) {
    const caps = instance.capabilities || {};
    const rows = [['Read', 'read', 'eye'], ['Write', 'write', 'pencil'], ['Delete', 'delete', 'trash']].map(([label, key, iconName]) => {
      const state = caps[key] || {};
      const name = BB.capabilities.normalizeState(state);
      const badge = h('span', { class: ['badge', name === 'denied' && 'badge--danger', name === 'allowed' && 'badge--ok'], 'data-permission': key, 'data-state': name },
        ic(iconName), BB.capabilities.stateLabel(state));
      const reasons = [name === 'denied' ? decisionSource(state) : '', String(state.reason || '')].filter(Boolean);
      return row(label, badge, reasons.join(' '));
    });
    const provider = Array.from(caps.permissions || []).map(String).join(', ');
    rows.push(row('Permissions of the configuration', provider || 'Not reported'));
    if (isVolume(instance)) {
      const write = BB.capabilities.normalizeState(caps.write || {});
      rows.push(row('Writable', write === 'denied' ? 'No' : 'Yes', 'The start of the server checks that its process can write in the folder.'));
    }
    return rows;
  }

  // --- Storage --------------------------------------------------------------------------------------------------------

  function storageRows(instance, usage) {
    if (instance.usageSupported !== true) {
      const reason = isVolume(instance)
        ? 'This build of the server cannot read the size of the file system.'
        : 'The configuration has no usage block for this bucket: the server does not read its usage. AWS S3 has no quota and no limit of its storage.';
      return [row('Usage', 'Not available', reason)];
    }
    if (!can(instance, 'list')) return [row('Usage', NOT_ALLOWED)];
    if (usage === undefined) return [row('Usage', 'Loading…')];
    if (!usage || usage.supported !== true) return [row('Usage', 'Not available')];
    const rows = BB.usage.lines(usage).map(line => row(line.term,
      line.percent === undefined ? line.value : [h('span', {}, line.value), meter(line.percent, line.level, `Used part: ${line.term}`)], line.note));
    if (isVolume(instance) && usage.selfState === 'partial') {
      rows.push(row('Count of the files', 'Stopped at its limit', 'The count reads 1,000,000 entries in 20 seconds at most: the size is at least this number.'));
    }
    const counted = usage.asOf ? BB.runtime.formatDateTimeUTC(usage.asOf) : '';
    rows.push(row('Source', `${BB.usage.sourceName(usage)}${counted ? `, counted ${counted}` : ''}`));
    return rows;
  }

  // --- Functions ------------------------------------------------------------------------------------------------------

  function versioningText(instance) {
    if (instance.versioningSupported !== true) return { value: 'Not available on this provider' };
    switch (instance.versioningState) {
      case 'enabled': return { value: 'Enabled', note: 'A change or a delete keeps the older versions of a file.' };
      case 'suspended': return { value: 'Suspended', note: 'The bucket keeps the older versions that it has, and makes no new ones.' };
      case 'off': return { value: 'Never enabled' };
      default: return { value: 'Unknown', note: 'The server could not read the versioning of the bucket.' };
    }
  }

  function encryptionRows(instance) {
    const lock = BB.encryption?.bucketLock(instance);
    const configured = instance.encryption === 'sse-s3'
      ? 'SSE-S3 for each write (encryption = "sse-s3")'
      : 'No encryption header: the default encryption of the bucket applies';
    const bucketDefault = instance.bucketEncryptionSupported === true ? (instance.defaultEncryption || 'None') : '';
    const applied = { yes: 'Yes', no: 'No: the provider accepts the header and does not encrypt (Garage)', unknown: 'Unknown' }[instance.encryptionApplied] || '';
    return [
      row('Encryption of the writes', configured),
      row('Default encryption of the bucket', bucketDefault),
      row('The provider applies SSE-S3', applied, lock?.tone === 'warn' ? lock.title : '')
    ];
  }

  function lifecycleRow(instance, lifecycle) {
    if (instance.lifecycleSupported === false) return row('Lifecycle rules', 'Not available on this provider');
    if (!can(instance, 'list')) return row('Lifecycle rules', NOT_ALLOWED);
    if (lifecycle === undefined) return row('Lifecycle rules', 'Loading…');
    const rules = Array.isArray(lifecycle?.rules) ? lifecycle.rules : null;
    const text = rules ? (rules.length ? `${plural(rules.length, 'rule')}, ${count(rules.filter(rule => rule.enabled).length)} on` : 'No rule')
      : (Number.isInteger(instance.lifecycleRules) ? plural(instance.lifecycleRules, 'rule') : 'Unknown');
    const target = `${BB.api.browserPageURL('', { instance: instance.id })}?lifecycle`;
    const open = h('a', { class: 'button infoAction', href: target, 'data-info-lifecycle': '' }, ic('hourglass'), 'Open the lifecycle rules');
    return row('Lifecycle rules', [h('span', {}, text), open], 'The editor opens on the listing of the bucket.');
  }

  function checksumText(instance) {
    if (instance.provider === 's3') return 'Yes: each part of an upload carries its SHA-256, and the provider checks it where it can';
    if (isVolume(instance)) return 'Yes: the server checks the SHA-256 of an upload in one request';
    return 'No';
  }

  const yesNo = (value, no = 'No') => (value ? 'Yes' : no);

  function functionRows(instance, lifecycle) {
    if (isVolume(instance)) {
      return [
        row('Folders', 'Real folders: an empty folder exists'),
        row('Incomplete uploads', yesNo(instance.multipartUploadsSupported === true), 'The temporary files of the uploads that stopped.'),
        row('SHA-256 checksum of the uploads', checksumText(instance)),
        row('Versions, tags, metadata, lifecycle rules, Object Lock, encryption of S3', VOLUME_ONLY)
      ];
    }
    const versioning = versioningText(instance);
    return [
      row('Versioning', versioning.value, versioning.note || ''),
      ...encryptionRows(instance),
      row('Object Lock', instance.objectLockSupported === true ? 'On' : 'Off',
        instance.objectLockSupported === true && instance.objectLockDefault ? `Default retention: ${BB.objectLock.defaultText(instance.objectLockDefault)}` : ''),
      lifecycleRow(instance, lifecycle),
      row('Tags', yesNo(instance.tagsSupported === true, 'Not available on this provider')),
      row('Edit of the metadata', yesNo(instance.metadataEditSupported === true, 'Not available on this provider')),
      row('Incomplete uploads', yesNo(instance.multipartUploadsSupported === true, 'Not available on this provider'), 'The list and the abort of the incomplete multipart uploads.'),
      row('SHA-256 checksum of the uploads', checksumText(instance))
    ];
  }

  // --- Page -----------------------------------------------------------------------------------------------------------

  const page = { instance: null, usage: undefined, lifecycle: undefined };

  function render() {
    const instance = page.instance;
    const sections = byId('infoSections');
    sections.replaceChildren(
      section('identity', 'Identity', isVolume(instance) ? 'folder-open' : 'database', identityRows(instance)),
      section('permissions', 'Permissions', 'eye', permissionRows(instance), 'The page hides what you cannot do. The server checks each request again.'),
      section('storage', 'Storage', 'chart-donut', storageRows(instance, page.usage)),
      section('functions', 'Functions', 'settings', functionRows(instance, page.lifecycle)));
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
