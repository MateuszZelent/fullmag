/**
 * Automated smoke and unit test suite for Fullmag Runner Console.
 * Validates file structure, exports, utilities, API client, and component rendering.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('[test] Running Runner Console smoke & unit test suite...');

// 1. Check index.html
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
assert(indexHtml.includes('id="app"'), 'index.html must have #app');
assert(indexHtml.includes('id="topbar-container"'), 'index.html must have #topbar-container');
assert(indexHtml.includes('id="sidebar-container"'), 'index.html must have #sidebar-container');
assert(indexHtml.includes('id="main-content"'), 'index.html must have #main-content');
assert(indexHtml.includes('id="banner-container"'), 'index.html must have #banner-container');
assert(indexHtml.includes('id="modal-container"'), 'index.html must have #modal-container');
console.log('✓ index.html structure verified');

// 2. Check styles.css
const stylesCss = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf-8');
assert(stylesCss.includes('data-theme="dark"'), 'styles.css must have dark theme');
assert(stylesCss.includes('data-theme="light"'), 'styles.css must have light theme');
assert(stylesCss.includes('tabular-nums'), 'styles.css must have tabular-nums font formatting');
assert(stylesCss.includes('prefers-reduced-motion'), 'styles.css must respect reduced motion');
assert(stylesCss.includes(':focus-visible'), 'styles.css must have accessible :focus-visible rules');
console.log('✓ styles.css verified');

// 3. Test utils.js module and unit functions
const {
  formatBytes,
  formatDuration,
  formatDurationBetween,
  formatTimestamp,
  formatRelative,
  parseTimestampMs,
  escapeHtml,
  renderStatusBadge,
} = await import('./src/utils.js');

// formatBytes
assert.strictEqual(formatBytes(0), '0 B');
assert.strictEqual(formatBytes(1024), '1.00 KiB');
assert.strictEqual(formatBytes(1048576), '1.00 MiB');
assert.strictEqual(formatBytes(1073741824), '1.00 GiB');
assert.strictEqual(formatBytes(null), 'niedostępne');
assert.strictEqual(formatBytes(undefined), 'niedostępne');
assert.strictEqual(formatBytes(NaN), 'niedostępne');

// formatDuration
assert.strictEqual(formatDuration(0), '0s');
assert.strictEqual(formatDuration(45), '45s');
assert.strictEqual(formatDuration(125), '2m 5s');
assert.strictEqual(formatDuration(3660), '1h 1m');
assert.strictEqual(formatDuration(null), 'niedostępne');
assert.strictEqual(formatDuration(undefined), 'niedostępne');

// parseTimestampMs
const nowSec = 1726239123;
const nowMs = 1726239123000;
const isoStr = '2026-09-13T14:52:03.000Z';
assert.strictEqual(parseTimestampMs(nowSec), nowMs);
assert.strictEqual(parseTimestampMs(nowMs), nowMs);
assert.strictEqual(parseTimestampMs(isoStr), Date.parse(isoStr));
assert.strictEqual(parseTimestampMs(null), null);
assert.strictEqual(parseTimestampMs('invalid-date'), null);

// formatDurationBetween
assert.strictEqual(formatDurationBetween(nowSec, nowSec + 65), '1m 5s');
assert.strictEqual(formatDurationBetween(isoStr, Date.parse(isoStr) + 120000), '2m 0s');
assert.strictEqual(formatDurationBetween(null), 'niedostępne');

// formatTimestamp
assert(formatTimestamp(nowSec).includes('2024') || formatTimestamp(nowSec).includes('2026'));
assert(formatTimestamp(isoStr).includes('2026-09-13'));
assert.strictEqual(formatTimestamp(null), 'niedostępne');
assert.strictEqual(formatTimestamp('not-a-date'), 'niedostępne');

// formatRelative
assert.strictEqual(formatRelative(Date.now() / 1000 - 2), 'przed chwilą');
assert.strictEqual(formatRelative(Date.now() / 1000 - 30), '30 s temu');
assert.strictEqual(formatRelative(Date.now() / 1000 - 300), '5 min temu');

// escapeHtml
assert.strictEqual(escapeHtml('<script>alert("xss")&\'</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&amp;&#039;&lt;/script&gt;');
assert.strictEqual(escapeHtml(null), '');

// renderStatusBadge
assert(renderStatusBadge('running').includes('badge-running'));
assert(renderStatusBadge('queued').includes('badge-queued'));
assert(renderStatusBadge('succeeded').includes('badge-success'));
assert(renderStatusBadge('failed').includes('badge-danger'));
assert(renderStatusBadge('paused').includes('badge-warning'));
assert(renderStatusBadge(null).includes('badge-muted'));
console.log('✓ utils.js unit tests passed');

// 4. Test api.js methods contract
const { api } = await import('./src/api.js');
const expectedApiMethods = [
  'request', 'login', 'checkAuth', 'logout',
  'getOverview', 'getHealth', 'getJobs', 'getJobDetail',
  'getJobLogs', 'getJobEvents', 'getJobMetrics', 'getJobResources',
  'cancelJob', 'pauseQueue', 'resumeQueue',
  'getStorageVolumes', 'getStorageResources', 'getProcesses', 'getAlerts', 'getEvents',
  'getRetentionPolicy', 'updateRetentionPolicy', 'getRetentionPlans', 'createRetentionPlan',
  'applyRetentionPlan', 'pinResource',
];
for (const method of expectedApiMethods) {
  assert.strictEqual(typeof api[method], 'function', `api.${method} must be a function`);
}
console.log(`✓ All ${expectedApiMethods.length} API client methods verified`);

// Verify that a stalled request is aborted and retried without leaking the
// timeout/retry-only options into the FetchInit object.
const originalFetch = globalThis.fetch;
let timeoutFetchAttempts = 0;
globalThis.fetch = (_url, options = {}) => {
  timeoutFetchAttempts += 1;
  assert(!Object.prototype.hasOwnProperty.call(options, 'timeoutMs'), 'timeoutMs must stay client-side');
  assert(!Object.prototype.hasOwnProperty.call(options, 'retries'), 'retries must stay client-side');
  if (timeoutFetchAttempts === 1) {
    return new Promise((_, reject) => {
      const rejectAborted = () => {
        const err = new Error('request aborted by test');
        err.name = 'AbortError';
        reject(err);
      };
      options.signal?.addEventListener('abort', rejectAborted, { once: true });
      setTimeout(rejectAborted, 50);
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ attempts: timeoutFetchAttempts }),
  });
};
try {
  const timeoutRetryResult = await api.request('/timeout-retry-test', { timeoutMs: 5, retries: 1 });
  assert.strictEqual(timeoutRetryResult.attempts, 2, 'timed out requests must retry once');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('✓ api.js timeout abort and retry verified');

// 5. Setup synthetic DOM environment to test component and view renders
class MockElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.innerHTML = '';
    this.children = [];
    const classes = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c) => classes.has(c) ? classes.delete(c) : classes.add(c),
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    };
    this.attributes = {};
    this.listeners = {};
    this._elements = new Map();
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] || null; }
  appendChild(child) { this.children.push(child); }
  querySelector(sel) {
    if (!this._elements.has(sel)) {
      this._elements.set(sel, new MockElement('div', sel));
    }
    return this._elements.get(sel);
  }
  querySelectorAll() { return [new MockElement('button')]; }
  addEventListener(event, fn) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(fn);
  }
}

globalThis.window = {
  location: { hash: '#overview' },
  addEventListener: () => {},
  removeEventListener: () => {},
  history: { replaceState: () => {} },
};
globalThis.document = {
  documentElement: new MockElement('html'),
  addEventListener: () => {},
  getElementById: () => new MockElement('div'),
  createElement: (tag) => new MockElement(tag),
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// 6. Test rendering of all components
const { renderTopBar } = await import('./src/components/TopBar.js');
const { renderSidebar } = await import('./src/components/Sidebar.js');
const { renderBlockBanner } = await import('./src/components/BlockBanner.js');
const { renderBuildDetailsModal } = await import('./src/components/BuildDetailsModal.js');
const { renderAuthModal } = await import('./src/components/AuthModal.js');

const container = new MockElement('div');
renderTopBar(container);
assert(container.innerHTML.includes('Fullmag Build Runner'), 'TopBar must render brand');
assert(container.innerHTML.includes('48765'), 'TopBar must render port 48765 by default');
assert(!container.innerHTML.includes(':8765'), 'TopBar must not contain hardcoded port :8765');
assert(!container.innerHTML.includes('desktop-linux'), 'TopBar must not contain hardcoded desktop-linux');

renderSidebar(container);
assert(container.innerHTML.includes('sidebar-nav'), 'Sidebar must render navigation');

renderBlockBanner(container);
renderBuildDetailsModal(container);
renderAuthModal(container);
console.log('✓ All 5 components successfully rendered');

// 4b. Test api.getJobs URL query construction including sort
let capturedUrl = null;
api.request = async (url) => { capturedUrl = url; return []; };
await api.getJobs({ status: 'succeeded', profile: 'fem-cpu-release', worktree: 'wt-1', sort: 'oldest', page: 2, limit: 25 });
assert(capturedUrl.includes('status=succeeded'), 'getJobs must include status in query');
assert(capturedUrl.includes('profile=fem-cpu-release'), 'getJobs must include profile in query');
assert(capturedUrl.includes('worktree=wt-1'), 'getJobs must include worktree in query');
assert(capturedUrl.includes('sort=oldest'), 'getJobs must include sort in query');
assert(capturedUrl.includes('page=2'), 'getJobs must include page in query');
assert(capturedUrl.includes('limit=25'), 'getJobs must include limit in query');
console.log('✓ api.getJobs query parameters including sort verified');

// 6b. Test state tab switching and details modal tab selection
const { state } = await import('./src/state.js');
assert.strictEqual(state.selectedJobTab, 'timeline', 'Default tab must be timeline');
state.openJobDetails('job-456', 'logs');
assert.strictEqual(state.selectedJobId, 'job-456', 'selectedJobId must be set');
assert.strictEqual(state.selectedJobTab, 'logs', 'selectedJobTab must be logs');

const modalContainer = new MockElement('div');
const modalHandle = renderBuildDetailsModal(modalContainer);
assert(modalContainer.innerHTML.includes('data-tab="logs"'), 'Modal must render logs tab');
assert(modalContainer.innerHTML.includes('class="modal-tab active" data-tab="logs"'), 'Logs tab button must have active class when opened with logs');
assert(modalHandle && typeof modalHandle.update === 'function', 'BuildDetailsModal must return an update() lifecycle hook');
assert(modalHandle && typeof modalHandle.destroy === 'function', 'BuildDetailsModal must return a destroy() lifecycle hook');
modalHandle.update();
modalHandle.destroy();

state.closeJobDetails();
assert.strictEqual(state.selectedJobId, null, 'selectedJobId must be cleared');
assert.strictEqual(state.selectedJobTab, 'timeline', 'selectedJobTab must reset to timeline');
console.log('✓ State tab management and modal dynamic tab rendering verified');

// 7. Test rendering of all 8 views and their lifecycle handles
const views = [
  { name: 'OverviewView', file: './src/views/OverviewView.js', fn: 'renderOverviewView', expectUpdate: true },
  { name: 'QueueView', file: './src/views/QueueView.js', fn: 'renderQueueView', expectUpdate: true },
  { name: 'HistoryView', file: './src/views/HistoryView.js', fn: 'renderHistoryView', expectUpdate: true },
  { name: 'StorageView', file: './src/views/StorageView.js', fn: 'renderStorageView', expectUpdate: true },
  { name: 'ProcessesView', file: './src/views/ProcessesView.js', fn: 'renderProcessesView', expectUpdate: true },
  { name: 'LogsView', file: './src/views/LogsView.js', fn: 'renderLogsView', expectUpdate: true },
  { name: 'PoliciesView', file: './src/views/PoliciesView.js', fn: 'renderPoliciesView', expectUpdate: true },
  { name: 'DiagnosticsView', file: './src/views/DiagnosticsView.js', fn: 'renderDiagnosticsView', expectUpdate: true },
];

for (const v of views) {
  const mod = await import(v.file);
  assert.strictEqual(typeof mod[v.fn], 'function', `${v.file} must export ${v.fn}`);
  const viewContainer = new MockElement('div');
  const handle = mod[v.fn](viewContainer);
  assert(viewContainer.innerHTML.length > 0, `${v.name} must produce non-empty markup`);
  if (v.expectUpdate) {
    assert(handle && typeof handle.update === 'function', `${v.name} must return an update() lifecycle hook`);
    handle.update(); // Verify update() runs without error
  }
  if (v.name === 'DiagnosticsView') {
    await new Promise((r) => setTimeout(r, 20));
    const card = viewContainer.querySelector('#diag-content');
    assert(card.innerHTML.includes('48765'), 'DiagnosticsView must render port 48765');
    assert(!card.innerHTML.includes('Port 8765'), 'DiagnosticsView must not contain hardcoded Port 8765');
  }
  console.log(`  ✓ View ${v.name} rendered and verified`);
}

// 8. Test dynamic port override in TopBar and DiagnosticsView
globalThis.window.location.port = '54321';
globalThis.window.location.host = '127.0.0.1:54321';
const customTopBar = new MockElement('div');
renderTopBar(customTopBar);
assert(customTopBar.innerHTML.includes('54321'), 'TopBar must render custom port 54321');

const diagMod = await import('./src/views/DiagnosticsView.js');
const customDiag = new MockElement('div');
diagMod.renderDiagnosticsView(customDiag);
await new Promise((r) => setTimeout(r, 20));
const customCard = customDiag.querySelector('#diag-content');
assert(customCard.innerHTML.includes('Port 54321'), 'DiagnosticsView must render custom Port 54321');
delete globalThis.window.location.port;
delete globalThis.window.location.host;
console.log('✓ Dynamic port propagation (54321) verified for TopBar and DiagnosticsView');

console.log('✓ All 8 views successfully rendered and lifecycle verified');

// 9. Test OverviewView honest cleanup state and trends with gaps
state.overviewData = {
  active_build: null,
  queued_count: 0,
  storage: { free_bytes: 50 * 1024 * 1024 * 1024, reserved_bytes: 10 * 1024 * 1024 * 1024 },
  worker: { memory_mb: 512, limit_mb: 4096, cpu_percent: 12.5 },
  last_cleanup: { candidates_count: null, reclaimed_bytes: null, status: 'brak' },
  trends: [
    { disk_free_gb: null, storage_growth_mb: null, ram_mb: null, cpu_percent: null, io_mb_s: null },
    { disk_free_gb: 45.2, storage_growth_mb: -5.2, ram_mb: 256, cpu_percent: 5.0, io_mb_s: 1.2 },
  ],
};
const overviewContainer = new MockElement('div');
const overviewMod = await import('./src/views/OverviewView.js');
overviewMod.renderOverviewView(overviewContainer);
assert(!overviewContainer.innerHTML.includes('>0 B</div>'), 'OverviewView must not display 0 B when cleanup is missing');
assert(overviewContainer.innerHTML.includes('niedostępne'), 'OverviewView must display niedostępne for missing cleanup');
assert(!overviewContainer.innerHTML.includes('+-'), 'OverviewView must not format negative growth with +-');
assert(overviewContainer.innerHTML.includes('-5.2 MiB'), 'OverviewView must format negative growth as -5.2 MiB');
console.log('✓ OverviewView honest cleanup and trends with gaps verified');

// 10. Test BuildDetailsModal honest empty resources/files and dynamic retention
state.selectedJobId = 'job-verify-10';
state.policiesData = {
  ttl_success_hours: 48,
  ttl_failure_hours: 240,
};
api.getJobDetail = async () => ({
  job_id: 'job-verify-10',
  state: 'succeeded',
  profile: 'fem-cpu-release',
  created_at: 1726239000,
  stages: [],
});
api.getJobMetrics = async () => []; // No metrics collected
api.getJobResources = async () => []; // No files registered

const modalWrap = new MockElement('div');
const bModal = await import('./src/components/BuildDetailsModal.js');
const mHandle = bModal.renderBuildDetailsModal(modalWrap);
await new Promise(r => setTimeout(r, 20));

// Verify resources tab empty
state.selectedJobTab = 'resources';
mHandle.update();
await new Promise(r => setTimeout(r, 20));
const tabContent = modalWrap.querySelector('#modal-tab-content');
assert(tabContent.innerHTML.includes('Brak zarejestrowanych próbek telemetrycznych'), 'Modal resources tab must display honest empty hint when metrics absent');
assert(!tabContent.innerHTML.includes('1.8 GiB'), 'Modal must not contain dummy RAM values');

// Verify resources tab with multiple metrics calculates peak RAM and avg CPU
api.getJobMetrics = async () => [
  { ram_mb: 100, cpu_percent: 10, storage_growth_mb: 5 },
  { ram_mb: 500, cpu_percent: 30, storage_growth_mb: 15 },
];
mHandle.update();
await new Promise(r => setTimeout(r, 20));
assert(tabContent.innerHTML.includes('500 MiB'), 'BuildDetailsModal must compute peak RAM from metrics');
assert(tabContent.innerHTML.includes('20.0%'), 'BuildDetailsModal must compute average CPU from metrics');

// Verify files tab
state.selectedJobTab = 'files';
mHandle.update();
await new Promise(r => setTimeout(r, 20));
assert(tabContent.innerHTML.includes('Brak zarejestrowanych zasobów plików'), 'Modal files tab must display honest empty hint when files absent');

// Verify cleanup tab succeeded
state.selectedJobTab = 'cleanup';
mHandle.update();
await new Promise(r => setTimeout(r, 20));
assert(tabContent.innerHTML.includes('48h'), 'Modal cleanup tab must display real retention policy (48h)');

// Verify cleanup tab running job
api.getJobDetail = async () => ({
  job_id: 'job-verify-10',
  state: 'running',
  profile: 'fem-cpu-release',
  created_at: 1726239000,
  stages: [],
});
mHandle.update();
await new Promise(r => setTimeout(r, 20));
assert(tabContent.innerHTML.includes('Zadanie aktywne'), 'Modal cleanup tab must show Zadanie aktywne for running job');

mHandle.destroy();
state.closeJobDetails();
console.log('✓ BuildDetailsModal honest empty states, peak/avg metrics and dynamic retention verified');

// 11. Test StorageView completeness badge and error handling
api.getStorageVolumes = async () => [
  { name: 'Root Volume', mount_point: '/storage', total_bytes: 100e9, used_bytes: 20e9, free_bytes: 80e9, reserved_bytes: 10e9, warning_threshold_bytes: 15e9, status: 'healthy' }
];
api.getStorageResources = async () => ({
  total_measured_bytes: 20e9,
  measured_at: new Date().toISOString(),
  categories: [
    { name: 'Execution', logical_bytes: 10e9, file_count: 150, completeness: 'partial', eligible_cleanup_bytes: 5e9, reclaimable_bytes: 5e9 },
    { name: 'Artifacts', logical_bytes: 10e9, file_count: 50, completeness: 'complete', eligible_cleanup_bytes: 0, reclaimable_bytes: 0 },
  ],
  resources: [],
});

const storageContainer = new MockElement('div');
const storageMod = await import('./src/views/StorageView.js');

// A slow resources scan must not hold back the fast volumes response.
let resolveStorageResources;
api.getStorageResources = () => new Promise(resolve => {
  resolveStorageResources = resolve;
});
const deferredStorageContainer = new MockElement('div');
storageMod.renderStorageView(deferredStorageContainer);
await new Promise(r => setTimeout(r, 20));
const deferredVolumesEl = deferredStorageContainer.querySelector('#volumes-table-container');
const deferredCategoriesEl = deferredStorageContainer.querySelector('#categories-breakdown-container');
assert(deferredVolumesEl.innerHTML.includes('Root Volume'), 'StorageView must render volumes before resource scan completes');
assert(deferredCategoriesEl.innerHTML.includes('Wczytywanie podziału klas storage'), 'StorageView must keep resource sections loading independently');
resolveStorageResources({ total_measured_bytes: 1, categories: [], resources: [] });
await new Promise(r => setTimeout(r, 20));
assert(deferredCategoriesEl.innerHTML.includes('Brak danych inwentaryzacji klas storage'), 'StorageView must render resource response after deferred scan resolves');

api.getStorageResources = async () => ({
  total_measured_bytes: 20e9,
  measured_at: new Date().toISOString(),
  categories: [
    { name: 'Execution', logical_bytes: 10e9, file_count: 150, completeness: 'partial', eligible_cleanup_bytes: 5e9, reclaimable_bytes: 5e9 },
    { name: 'Artifacts', logical_bytes: 10e9, file_count: 50, completeness: 'complete', eligible_cleanup_bytes: 0, reclaimable_bytes: 0 },
  ],
  resources: [],
});
storageMod.renderStorageView(storageContainer);
await new Promise(r => setTimeout(r, 20));

const catEl = storageContainer.querySelector('#categories-breakdown-container');
assert(catEl.innerHTML.includes('Częściowy'), 'StorageView must render Częściowy badge for partial completeness');
assert(catEl.innerHTML.includes('Pełny (100%)'), 'StorageView must render Pełny badge for complete completeness');

// Test error handling
api.getStorageVolumes = async () => { throw new Error('Simulated disk error'); };
api.getStorageResources = async () => { throw new Error('Simulated scanner timeout'); };
storageMod.renderStorageView(storageContainer);
await new Promise(r => setTimeout(r, 20));
const volEl = storageContainer.querySelector('#volumes-table-container');
assert(volEl.innerHTML.includes('Simulated disk error'), 'StorageView must display honest error on volume failure');
assert(catEl.innerHTML.includes('Simulated scanner timeout'), 'StorageView must display honest error on resource failure');
console.log('✓ StorageView completeness badges and error honesty verified');

// 12. Test DiagnosticsView dynamic environment, security absence and alert error handling
api.getHealth = async () => ({
  ok: true,
  runtime_environment: 'podman-rootless-linux',
  allowed_profiles: ['fdm-cpu-release', 'fem-cpu-release'],
  qualification: 'NOT VERIFIED',
  worker_security: null, // security info absent
  worker_alive: true,
  worker_state: 'idle',
});
api.getAlerts = async () => { throw new Error('Alerts service unavailable'); };

const diagContainer = new MockElement('div');
diagMod.renderDiagnosticsView(diagContainer);
await new Promise(r => setTimeout(r, 20));
const dContent = diagContainer.querySelector('#diag-content');
assert(dContent.innerHTML.includes('podman-rootless-linux'), 'DiagnosticsView must display dynamic runtime environment');
assert(!dContent.innerHTML.includes('desktop-linux'), 'DiagnosticsView must not hardcode desktop-linux');
assert(!dContent.innerHTML.includes('Izolowany kontener wykonawcy'), 'DiagnosticsView must not fabricate worker security claim');
assert(dContent.innerHTML.includes('niedostępne'), 'DiagnosticsView must display niedostępne when worker_security is absent');
assert(dContent.innerHTML.includes('Błąd pobierania alertów operacyjnych'), 'DiagnosticsView must honestly report alert fetch error');
assert(!dContent.innerHTML.includes('Wszystkie testy diagnostyczne pozytywne'), 'DiagnosticsView must not claim all tests positive on alert error');

// Test DiagnosticsView when alerts is null
api.getAlerts = async () => null;
diagMod.renderDiagnosticsView(diagContainer);
await new Promise(r => setTimeout(r, 20));
assert(diagContainer.querySelector('#diag-content').innerHTML.includes('Błąd pobierania alertów operacyjnych'), 'DiagnosticsView must report error when alerts is null');
assert(!diagContainer.querySelector('#diag-content').innerHTML.includes('Brak aktywnych alertów'), 'DiagnosticsView must not claim healthy when alerts is null');

console.log('✓ DiagnosticsView dynamic runtime environment and alert error honesty verified');

// 13. Test api.js failure honesty on HTTP 500
delete api.getJobDetail;
delete api.getJobLogs;
delete api.getOverview;
delete api.getJobs;
delete api.getAlerts;
delete api.getHealth;
delete api.getStorageVolumes;
delete api.getStorageResources;

const serverErr = new Error('Internal Server Error 500');
serverErr.status = 500;
api.request = async () => { throw serverErr; };

await assert.rejects(
  async () => await api.getOverview(),
  (err) => err.status === 500,
  'api.getOverview must propagate HTTP 500 errors'
);
await assert.rejects(
  async () => await api.getJobs(),
  (err) => err.status === 500,
  'api.getJobs must propagate HTTP 500 errors'
);
await assert.rejects(
  async () => await api.getJobDetail('j-500'),
  (err) => err.status === 500,
  'api.getJobDetail must propagate HTTP 500 errors without falling back'
);
await assert.rejects(
  async () => await api.getJobLogs('j-500'),
  (err) => err.status === 500,
  'api.getJobLogs must propagate HTTP 500 errors without falling back'
);
console.log('✓ api.js error honesty verified (no synthetic fallback on 500)');

console.log('[test] All Runner Console unit and smoke tests passed successfully!');
