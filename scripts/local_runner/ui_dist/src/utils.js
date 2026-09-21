/**
 * Formatting and DOM utility functions for Fullmag Runner Console.
 * Follows Fullmag specification: missing data displays as "n/a", never misleading zero.
 */

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || isNaN(bytes)) {
    return 'niedostępne';
  }
  const num = Number(bytes);
  if (num === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  const val = (num / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2);
  return `${val} ${sizes[i] || 'B'}`;
}

export function parseTimestampMs(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    if (isNaN(val)) return null;
    return val < 1e11 ? val * 1000 : val;
  }
  const str = String(val).trim();
  if (!str) return null;
  const num = Number(str);
  if (!isNaN(num)) {
    return num < 1e11 ? num * 1000 : num;
  }
  const parsed = Date.parse(str);
  return isNaN(parsed) ? null : parsed;
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) {
    return 'niedostępne';
  }
  const sec = Math.round(Number(seconds));
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) return `${mins}m ${remSec}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function formatDurationBetween(startVal, endVal = Date.now()) {
  const startMs = parseTimestampMs(startVal);
  const endMs = parseTimestampMs(endVal);
  if (startMs === null || endMs === null) return 'niedostępne';
  const diffSec = Math.max(0, (endMs - startMs) / 1000);
  return formatDuration(diffSec);
}

export function formatTimestamp(val) {
  const ms = parseTimestampMs(val);
  if (ms === null) return 'niedostępne';
  try {
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  } catch (_) {
    return 'niedostępne';
  }
}

export function formatRelative(val) {
  const ms = parseTimestampMs(val);
  if (ms === null) return 'niedostępne';
  try {
    const diffSec = Math.floor((Date.now() - ms) / 1000);
    if (diffSec < 5) return 'przed chwilą';
    if (diffSec < 60) return `${diffSec} s temu`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins} min temu`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} godz. temu`;
    const days = Math.floor(hours / 24);
    return `${days} dni temu`;
  } catch (_) {
    return 'niedostępne';
  }
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderStatusBadge(status) {
  if (!status) return '<span class="badge badge-muted">niedostępne</span>';
  const s = String(status).toLowerCase();
  let badgeClass = 'badge-muted';
  let label = status;

  switch (s) {
    case 'running':
      badgeClass = 'badge-running';
      label = 'W toku (Running)';
      break;
    case 'queued':
      badgeClass = 'badge-queued';
      label = 'W kolejce (Queued)';
      break;
    case 'succeeded':
    case 'success':
    case 'healthy':
    case 'ok':
      badgeClass = 'badge-success';
      label = 'Sukces';
      break;
    case 'failed':
    case 'error':
    case 'critical':
      badgeClass = 'badge-danger';
      label = 'Błąd';
      break;
    case 'cancelled':
    case 'cancel_requested':
      badgeClass = 'badge-warning';
      label = 'Anulowane';
      break;
    case 'paused':
    case 'stopping':
      badgeClass = 'badge-warning';
      label = 'Wstrzymany (Paused)';
      break;
    case 'warning':
      badgeClass = 'badge-warning';
      label = 'Ostrzeżenie';
      break;
    default:
      badgeClass = 'badge-muted';
      label = status;
  }

  return `<span class="badge ${badgeClass}"><span class="badge-dot"></span>${escapeHtml(label)}</span>`;
}
