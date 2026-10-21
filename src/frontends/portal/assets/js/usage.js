/*
 * BB.usage: the usage and the quota of a bucket (GET /api/usage).
 * - the read: one answer for each instance, kept in the page; a read with fresh asks the server to read the admin API
 *   of the provider again (the server reads it again only when its value is older than 10 seconds);
 * - the texts: "12.3 GB of 20 GB" or "12.3 GB used", "~" for an approximate number, and the tooltip with the bucket,
 *   the objects, the source, the time of the count and the reason of an approximate number.
 * The numbers are for the whole bucket, also for an instance with a root prefix. The server reads the admin API only for
 * an instance with a usage block in its configuration (usageSupported of /api/instances).
 */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const SOURCES = { garage: 'Garage', seaweedfs: 'SeaweedFS', minio: 'MinIO' };
  // The page reads an instance again after this time, also without a change.
  const PAGE_TTL_MS = 60000;
  const answers = new Map();

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

  // The answer of an instance: { supported: false }, an answer with available false and the error, or the numbers.
  // Two reads of the same instance at the same time share one request.
  function load(instance, { fresh = false } = {}) {
    const id = String(instance?.id || instance || '');
    if (!id) return Promise.resolve({ supported: false });
    const entry = answers.get(id);
    if (entry?.pending && !fresh) return entry.pending;
    if (entry?.answer && !fresh && Date.now() - entry.at < PAGE_TTL_MS) return Promise.resolve(entry.answer);
    const pending = BB.api.usage(id, { fresh })
      .then(answer => {
        answers.set(id, { answer, at: Date.now() });
        return answer;
      })
      .catch(error => {
        const answer = { supported: true, available: false, error: { code: 'usage_unavailable', message: `The usage of the bucket is unavailable: ${error?.message || error}` } };
        answers.set(id, { answer, at: Date.now() });
        return answer;
      });
    answers.set(id, { ...(entry || {}), pending });
    return pending;
  }

  // The last answer of an instance in the page, or null.
  const cached = id => answers.get(String(id || ''))?.answer || null;
  const shown = answer => answer?.supported === true && answer.available === true;

  // The short text of the status line: "~12.3 GB of 20 GB" or "12.3 GB used".
  function text(answer) {
    if (!shown(answer)) return '';
    const used = `${answer.approximate ? '~' : ''}${formatBytes(answer.usedBytes)}`;
    return Number(answer.limitBytes) > 0 ? `${used} of ${formatBytes(answer.limitBytes)}` : `${used} used`;
  }

  // The lines of the tooltip.
  function title(answer) {
    if (answer?.supported === true && answer.available !== true) return answer.error?.message || 'The usage of the bucket is unavailable.';
    if (!shown(answer)) return '';
    const lines = [];
    lines.push(answer.rootPrefix
      ? `Usage of the whole bucket ${answer.bucket}, not only of ${answer.rootPrefix}`
      : `Usage of the whole bucket ${answer.bucket}`);
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

  BB.usage = { load, cached, shown, text, title, selectorLine, formatBytes };
})();
