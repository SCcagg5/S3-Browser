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
  // An answer with numbers: the part of the bucket, or the storage behind it (the read of the bucket part can fail).
  const shown = answer => answer?.supported === true && (answer.available === true || Boolean(answer.storage));
  const bucketShown = answer => answer?.supported === true && answer.available === true;
  // The part that gives the percent, the colour and the warning: "quota", "storage" or "" (no limit). An answer of an
  // older server has no constraint: its limit of bytes is the quota.
  const constraint = answer => (answer?.constraint !== undefined ? String(answer.constraint || '') : (Number(answer?.limitBytes) > 0 ? 'quota' : ''));
  const hasLimit = answer => shown(answer) && constraint(answer) !== '';
  const mark = approximate => (approximate ? '~' : '');

  // The short text of the chip of the selector: the percent of the constraining part, or the used bytes.
  function shortText(answer) {
    if (!shown(answer)) return '';
    if (hasLimit(answer)) {
      const percent = Number(answer.percent) || 0;
      const approximate = constraint(answer) === 'storage' ? answer.storage?.approximate : answer.approximate;
      return percent > 0 && percent < 1 ? '<1 %' : `${mark(approximate)}${Math.floor(percent)} %`;
    }
    return bucketShown(answer) ? `${mark(answer.approximate)}${formatBytes(answer.usedBytes)}` : '';
  }

  // The text of the chip for a screen reader: "~12.3 GB of 20 GB", "Storage: 910 GB of 1000 GB" or "12.3 GB used".
  function text(answer) {
    if (!shown(answer)) return '';
    if (constraint(answer) === 'storage') {
      return `Storage: ${mark(answer.storage.approximate)}${formatBytes(answer.storage.usedBytes)} of ${formatBytes(answer.storage.totalBytes)}`;
    }
    const used = `${mark(answer.approximate)}${formatBytes(answer.usedBytes)}`;
    return Number(answer.limitBytes) > 0 ? `${used} of ${formatBytes(answer.limitBytes)}` : `${used} used`;
  }

  // What a volume holds: "10 GB", "at least 10 GB" while the count runs or when it stopped at its budget.
  function selfText(answer) {
    const bytes = formatBytes(answer.selfBytes ?? answer.usedBytes);
    if (answer.selfState === 'computing') return Number(answer.selfBytes) > 0 ? `at least ${bytes} (counting…)` : 'computing…';
    if (answer.selfState === 'partial') return `at least ${bytes} (the count stopped at its limit)`;
    return bytes;
  }

  // The lines of the usage: the term, the value, the bar (percent and level) and a note. The popover and the tooltip
  // show them. Each line is there only when it is known.
  function lines(answer) {
    const out = [];
    if (!answer || answer.supported !== true) return out;
    const volume = volumeAnswer(answer);
    if (bucketShown(answer)) {
      const objects = Number(answer.usedObjects) >= 0 ? `, ${count(answer.usedObjects)} ${volume ? 'files' : 'objects'}` : '';
      out.push({ term: volume ? 'This volume holds' : 'This bucket holds', value: volume ? `${selfText(answer)}${answer.selfState === 'ready' ? objects : ''}` : `${mark(answer.approximate)}${formatBytes(answer.usedBytes)}${objects}`,
        note: answer.rootPrefix && !volume ? `The numbers are for the whole bucket ${answer.bucket}, not only for ${answer.rootPrefix}.` : (answer.approximate ? answer.approximateReason || '' : '') });
      if (Number(answer.limitBytes) > 0) {
        out.push({ term: 'Quota', value: `${mark(answer.approximate)}${formatBytes(answer.usedBytes)} of ${formatBytes(answer.limitBytes)} (${answer.quotaPercent ?? answer.percent} %)`,
          percent: Number(answer.quotaPercent ?? answer.percent) || 0, level: answer.quotaLevel ?? answer.level,
          note: answer.limitSource === 'config' ? 'The configuration of S3-Browser sets this limit. The provider does not enforce it.' : '' });
      }
      if (Number(answer.limitObjects) > 0 && Number(answer.usedObjects) >= 0) {
        out.push({ term: 'Objects', value: `${count(answer.usedObjects)} of ${count(answer.limitObjects)}` });
      }
    } else if (answer.error) {
      out.push({ term: volume ? 'This volume holds' : 'This bucket holds', value: 'unavailable', note: answer.error.message || '' });
    }
    const storage = answer.storage;
    if (storage) {
      out.push({ term: 'Storage', value: `${mark(storage.approximate)}${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)} (${storage.percent} %), ${formatBytes(storage.freeBytes)} left`,
        percent: Number(storage.percent) || 0, level: storage.level,
        note: [volume ? 'The file system of the volume: the other folders on it count too.' : capitalize(storage.note || ''),
          storage.approximate ? `~ Approximate: ${storage.approximateReason || 'the storage counts with a delay.'}` : ''].filter(Boolean).join(' ') });
    } else if (answer.storageError) {
      out.push({ term: 'Storage', value: 'unavailable', note: answer.storageError.message || '' });
    }
    return out;
  }

  const capitalize = value => (value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}${value.endsWith('.') ? '' : '.'}` : '');

  // The lines of the tooltip.
  function title(answer) {
    if (answer?.supported === true && !shown(answer)) return answer.error?.message || `The usage of the ${noun(answer)} is unavailable.`;
    if (!shown(answer)) return '';
    const out = lines(answer).map(line => `${line.term}: ${line.value}${line.note ? `\n  ${line.note}` : ''}`);
    if (answer.level === 'error') out.push(`More than 95 % of the ${constraint(answer) === 'storage' ? 'storage' : 'limit'} is used.`);
    else if (answer.level === 'warning') out.push(`More than 80 % of the ${constraint(answer) === 'storage' ? 'storage' : 'limit'} is used.`);
    const counted = answer.asOf && bucketShown(answer) ? BB.runtime.formatDateTimeUTC(answer.asOf) : '';
    out.push(`Source: ${SOURCES[answer.source] || answer.source}${counted ? `, counted ${counted}` : ''}`);
    return out.join('\n');
  }

  // The line of the tooltip of a bucket in the selector, or ''.
  function selectorLine(answer) {
    if (answer?.supported === true && !shown(answer)) return 'usage: unavailable';
    if (!shown(answer)) return '';
    const parts = [];
    if (bucketShown(answer)) {
      parts.push(`usage: ${volumeAnswer(answer) ? selfText(answer) : text({ ...answer, constraint: Number(answer.limitBytes) > 0 ? 'quota' : '' })}${Number(answer.limitBytes) > 0 ? ` (${answer.quotaPercent ?? answer.percent} %)` : ''}`);
    }
    if (answer.storage) parts.push(`storage: ${mark(answer.storage.approximate)}${formatBytes(answer.storage.usedBytes)} of ${formatBytes(answer.storage.totalBytes)} (${answer.storage.percent} %), ${formatBytes(answer.storage.freeBytes)} left`);
    return parts.join('\n');
  }

  // A full bucket: FULL_PERCENT or more of the constraining part (the quota or the storage). A bucket without a limit
  // is never full.
  const full = answer => hasLimit(answer) && Number(answer.percent) >= FULL_PERCENT;

  // The text of the warning of a full bucket, or ''. The percent of the server is the larger part: the text names the
  // storage, the objects or the bytes of the quota. note: the reason of an approximate number, as a second sentence.
  function fullText(answer, { note = true } = {}) {
    if (!full(answer)) return '';
    const percent = Math.floor(Number(answer.percent));
    const reason = note ? approximateNote(answer) : '';
    const tail = reason ? ` ${reason}` : '';
    if (constraint(answer) === 'storage') {
      const storage = answer.storage;
      const sign = mark(storage.approximate);
      const amount = `${sign}${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)}, ${formatBytes(storage.freeBytes)} left`;
      const where = volumeAnswer(answer) ? 'This volume is on a file system that is' : 'The storage of this bucket is';
      return percent >= 100
        ? `${where} full: ${amount}. New uploads fail.${tail}`
        : `${where} ${sign}${percent} % full: ${amount}. New uploads can fail.${tail}`;
    }
    const sign = mark(answer.approximate);
    const objects = Number(answer.limitObjects) > 0 && Number(answer.usedObjects) >= 0
      && Number(answer.usedObjects) / Number(answer.limitObjects) > Number(answer.usedBytes) / Number(answer.limitBytes);
    const amount = objects
      ? `${count(answer.usedObjects)} objects of ${count(answer.limitObjects)}`
      : `${sign}${formatBytes(answer.usedBytes)} used of ${formatBytes(answer.limitBytes)}`;
    return percent >= 100
      ? `This ${noun(answer)} is full: ${amount} (${sign}${percent} %). New uploads fail.${tail}`
      : `This ${noun(answer)} is ${sign}${percent} % full: ${amount}. New uploads can fail.${tail}`;
  }

  // The reason of an approximate number of the constraining part, or ''.
  function approximateNote(answer) {
    if (constraint(answer) === 'storage') {
      return answer?.storage?.approximate ? `The numbers are approximate: ${answer.storage.approximateReason || 'the storage counts with a delay.'}` : '';
    }
    return answer?.approximate ? `The numbers are approximate: ${answer.approximateReason || 'the provider counts with a delay.'}` : '';
  }

  const sourceName = answer => SOURCES[answer?.source] || String(answer?.source || '');

  BB.usage = { load, cached, loading, shown, hasLimit, sourceName, constraint, shortText, text, lines, title, selectorLine, full, fullText, approximateNote, formatBytes };
})();
