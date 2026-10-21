/*
 * BB.usage: the usage and the quota of a bucket (GET /api/usage).
 * - the read: one answer for each instance, kept in the page; a read with fresh asks the server to read the admin API
 *   of the provider again (the server reads it again only when its value is older than 10 seconds);
 * - the texts: "12.3 GB of 20 GB" or "12.3 GB used", "~" for an approximate number, and the tooltip with the bucket,
 *   the objects, the source, the time of the count and the reason of an approximate number.
 * - the warning of a full bucket: 90 % or more of the limit of bytes, with the text of the banner of the listing.
 * The numbers are for the whole bucket, also for an instance with a root prefix. The server reads the admin API only for
 * an instance with a usage block in its configuration (usageSupported of /api/instances). A volume (source statfs) gives
 * the size of its file system: the texts name a volume and its file system. The page sends at most MAX_READS reads at
 * the same time: the selector reads the usage of each bucket.
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const SOURCES = { garage: 'Garage', seaweedfs: 'SeaweedFS', minio: 'MinIO', statfs: 'the file system of the server (statfs)' };
  // The page reads an instance again after this time, also without a change.
  const PAGE_TTL_MS = 60000;
  const MAX_READS = 4;
  // A bucket is full from this part of its limit of bytes: the page shows a warning.
  const FULL_PERCENT = 90;
  const answers = new Map();
  const waiting = [];
  let active = 0;

  // Runs a read when fewer than MAX_READS reads are in flight, else when a read ends.
  function limited(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active += 1;
        task().then(resolve, reject).finally(() => {
          active -= 1;
          waiting.shift()?.();
        });
      };
      if (active < MAX_READS) run();
      else waiting.push(run);
    });
  }

  // Sizes in base 1024 with one decimal, as the listing shows them.
  function formatBytes(size) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    let scaled = Math.max(0, Number(size) || 0);
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024;
      unit += 1;
    }
    const text = unit === 0 ? String(Math.round(scaled)) : scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, '');
    return `${text} ${units[unit]}`;
  }

  const count = value => Number(value || 0).toLocaleString('en-US');

  // The usage of a volume is the size of its file system (source statfs).
  const volumeAnswer = answer => answer?.source === 'statfs';
  const noun = answer => (volumeAnswer(answer) ? 'volume' : 'bucket');

  // The answer of an instance: { supported: false }, an answer with available false and the error, or the numbers.
  // Two reads of the same instance at the same time share one request.
  function load(instance, { fresh = false } = {}) {
    const id = String(instance?.id || instance || '');
    if (!id) return Promise.resolve({ supported: false });
    const entry = answers.get(id);
    if (entry?.pending && !fresh) return entry.pending;
    if (entry?.answer && !fresh && Date.now() - entry.at < PAGE_TTL_MS) return Promise.resolve(entry.answer);
    const pending = limited(() => BB.api.usage(id, { fresh }))
      .then(answer => {
        answers.set(id, { answer, at: Date.now() });
        return answer;
      })
      .catch(error => {
        const answer = { supported: true, available: false, error: { code: 'usage_unavailable', message: `The usage is unavailable: ${error?.message || error}` } };
        answers.set(id, { answer, at: Date.now() });
        return answer;
      });
    answers.set(id, { ...(entry || {}), pending });
    return pending;
  }

  // The last answer of an instance in the page, or null. loading: a read of the instance is in flight.
  const cached = id => answers.get(String(id || ''))?.answer || null;
  const loading = id => Boolean(answers.get(String(id || ''))?.pending);
  const shown = answer => answer?.supported === true && answer.available === true;

  // The short text of the chip of the header: "~12.3 GB of 20 GB" or "12.3 GB used".
  function text(answer) {
    if (!shown(answer)) return '';
    const used = `${answer.approximate ? '~' : ''}${formatBytes(answer.usedBytes)}`;
    return Number(answer.limitBytes) > 0 ? `${used} of ${formatBytes(answer.limitBytes)}` : `${used} used`;
  }

  // The lines of the tooltip.
  function title(answer) {
    if (answer?.supported === true && answer.available !== true) return answer.error?.message || `The usage of the ${noun(answer)} is unavailable.`;
    if (!shown(answer)) return '';
    const lines = [];
    if (volumeAnswer(answer)) {
      lines.push(`Usage of the file system of the volume ${answer.bucket}`);
      lines.push('The numbers are for the whole file system: the other folders on it count too.');
    } else {
      lines.push(answer.rootPrefix
        ? `Usage of the whole bucket ${answer.bucket}, not only of ${answer.rootPrefix}`
        : `Usage of the whole bucket ${answer.bucket}`);
    }
    lines.push(`Used: ${formatBytes(answer.usedBytes)} (${count(answer.usedBytes)} bytes)`);
    if (Number(answer.limitBytes) > 0) {
      lines.push(`Limit: ${formatBytes(answer.limitBytes)} (${count(answer.limitBytes)} bytes), ${answer.percent} % used`);
      if (answer.limitSource === 'config') lines.push('The configuration of S3-Browser sets this limit. The provider does not enforce it.');
    } else {
      lines.push('No limit');
    }
    if (Number(answer.usedObjects) >= 0) {
      lines.push(Number(answer.limitObjects) > 0
        ? `Objects: ${count(answer.usedObjects)} of ${count(answer.limitObjects)}`
        : `Objects: ${count(answer.usedObjects)}`);
    }
    if (answer.level === 'error') lines.push('More than 95 % of the limit is used.');
    else if (answer.level === 'warning') lines.push('More than 80 % of the limit is used.');
    const counted = answer.asOf ? BB.runtime.formatDateTimeUTC(answer.asOf) : '';
    lines.push(`Source: ${SOURCES[answer.source] || answer.source}${counted ? `, counted ${counted}` : ''}`);
    if (answer.approximate) lines.push(`~ Approximate: ${answer.approximateReason || 'the provider counts with a delay.'}`);
    return lines.join('\n');
  }

  // The line of the tooltip of a bucket in the selector, or ''.
  function selectorLine(answer) {
    if (answer?.supported === true && answer.available !== true) return 'usage: unavailable';
    if (!shown(answer)) return '';
    return `usage: ${text(answer)}${Number(answer.limitBytes) > 0 ? ` (${answer.percent} %)` : ''}`;
  }

  // A full bucket: FULL_PERCENT or more of a limit of bytes. A bucket without a limit of bytes is never full.
  const full = answer => shown(answer) && Number(answer.limitBytes) > 0 && Number(answer.percent) >= FULL_PERCENT;

  // The text of the warning of a full bucket, or ''. The percent of the server is the larger part of the limit of bytes
  // and of the limit of objects: the text names the objects when they fill the bucket first. note: the reason of an
  // approximate number, as a second sentence.
  function fullText(answer, { note = true } = {}) {
    if (!full(answer)) return '';
    const mark = answer.approximate ? '~' : '';
    const percent = Math.floor(Number(answer.percent));
    const objects = Number(answer.limitObjects) > 0 && Number(answer.usedObjects) >= 0
      && Number(answer.usedObjects) / Number(answer.limitObjects) > Number(answer.usedBytes) / Number(answer.limitBytes);
    const amount = objects
      ? `${count(answer.usedObjects)} objects of ${count(answer.limitObjects)}`
      : `${mark}${formatBytes(answer.usedBytes)} used of ${formatBytes(answer.limitBytes)}`;
    const reason = note ? approximateNote(answer) : '';
    return percent >= 100
      ? `This ${noun(answer)} is full: ${amount} (${mark}${percent} %). New uploads fail.${reason ? ` ${reason}` : ''}`
      : `This ${noun(answer)} is ${mark}${percent} % full: ${amount}. New uploads can fail.${reason ? ` ${reason}` : ''}`;
  }

  // The reason of an approximate number, or ''.
  const approximateNote = answer => (answer?.approximate ? `The numbers are approximate: ${answer.approximateReason || 'the provider counts with a delay.'}` : '');

  BB.usage = { load, cached, loading, shown, text, title, selectorLine, full, fullText, approximateNote, formatBytes };
})();
