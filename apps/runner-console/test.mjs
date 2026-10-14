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
const repositoryRoot = path.resolve(__dirname, '..', '..');
const ignoredBuildDirectories = new Set(['dist', 'node_modules']);

function collectSourceAssetInventory(root) {
  const files = new Map();

  function visit(relativePath) {
    const absolutePath = path.join(root, relativePath);
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolutePath).sort()) {
        if (ignoredBuildDirectories.has(child)) continue;
        visit(path.join(relativePath, child));
      }
      return;
    }
    assert(stat.isFile(), 'unsupported source asset entry: ' + relativePath);
    files.set(relativePath.split(path.sep).join('/'), fs.readFileSync(absolutePath));
  }

  for (const requiredInput of ['index.html', 'styles.css', 'src']) {
    assert(fs.existsSync(path.join(root, requiredInput)),
      'canonical Runner Console input is missing: ' + requiredInput);
    visit(requiredInput);
  }
  return files;
}

function collectPackageAssetInventory(root) {
  assert(fs.existsSync(root) && fs.statSync(root).isDirectory(),
    'Runner Console package is missing: ' + root);
  const files = new Map();

  function visit(absolutePath, relativePath) {
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, child), path.join(relativePath, child));
      }
      return;
    }
    assert(stat.isFile(), 'unsupported packaged asset entry: ' + relativePath);
    files.set(relativePath.split(path.sep).join('/'), fs.readFileSync(absolutePath));
  }

  visit(root, '');
  return files;
}

function assertPackageMatchesSources(label, outputRoot, expectedFiles) {
  const actualFiles = collectPackageAssetInventory(outputRoot);
  const expectedPaths = [...expectedFiles.keys()].sort();
  const actualPaths = [...actualFiles.keys()].sort();
  assert.deepStrictEqual(actualPaths, expectedPaths,
    label + ' must contain the complete canonical index.html, styles.css, and src file inventory');
  for (const relativePath of expectedPaths) {
    assert.deepStrictEqual(actualFiles.get(relativePath), expectedFiles.get(relativePath),
      label + ' bytes differ from canonical source at ' + relativePath);
  }
}

const canonicalAssetFiles = collectSourceAssetInventory(__dirname);
assertPackageMatchesSources(
  'apps/runner-console/dist',
  path.join(__dirname, 'dist'),
  canonicalAssetFiles,
);
assertPackageMatchesSources(
  'scripts/local_runner/ui_dist',
  path.join(repositoryRoot, 'scripts', 'local_runner', 'ui_dist'),
  canonicalAssetFiles,
);
console.log('✓ generated Runner Console package inventories and bytes match canonical inputs');

console.log('[test] Running Runner Console smoke & unit test suite...');
const browserSmokeSource = fs.readFileSync(path.join(__dirname, 'browser-smoke.cjs'), 'utf-8');
assert(browserSmokeSource.includes("require.resolve(playwrightRequest"),
  'browser smoke must resolve Playwright from the supported Control Room package');
assert(browserSmokeSource.includes("path.join(repositoryRoot, 'apps', 'control-room')"),
  'browser smoke Playwright resolution must stay repository-relative');
assert(browserSmokeSource.includes('FULLMAG_RUNNER_PLAYWRIGHT') &&
  browserSmokeSource.includes('FULLMAG_RUNNER_CHROMIUM'),
  'browser smoke must retain explicit dependency overrides');
assert(browserSmokeSource.includes('playwright install --with-deps chromium'),
  'missing Playwright Chromium must give the portable provisioning command');
assert(browserSmokeSource.includes('os.tmpdir()'),
  'browser smoke screenshot fallback must use the platform temporary directory');
assert(!browserSmokeSource.includes('C:/Users/Mateusz/.cache/codex-runtimes'),
  'browser smoke must not depend on a user-private Playwright installation');
assert(!browserSmokeSource.includes('C:/git/fullmag/storage/cache/windows/playwright-browsers'),
  'browser smoke must not depend on a host-specific Chromium cache');
assert(!browserSmokeSource.includes('C:/Windows/Temp'),
  'browser smoke must not depend on a Windows-only screenshot directory');

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
  'getRetentionPlan', 'getRetentionPlanPage', 'applyRetentionPlan', 'pinResource',
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

// A null timeout disables only the elapsed timer; a recursive inventory read
// can outlast the old 7-second client deadline while remaining externally cancellable.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realFetchForResourceTimeout = globalThis.fetch;
let fakeClockNow = 0;
let nextFakeTimerId = 1;
const fakeTimers = new Map();
globalThis.setTimeout = (callback, delay = 0) => {
  const id = nextFakeTimerId++;
  fakeTimers.set(id, { dueAt: fakeClockNow + Math.max(0, Number(delay) || 0), callback });
  return id;
};
globalThis.clearTimeout = (id) => { fakeTimers.delete(id); };
const advanceFakeClock = async (milliseconds) => {
  fakeClockNow += milliseconds;
  const dueTimers = [...fakeTimers.entries()]
    .filter(([, timer]) => timer.dueAt <= fakeClockNow)
    .sort((left, right) => left[1].dueAt - right[1].dueAt);
  for (const [id, timer] of dueTimers) {
    if (!fakeTimers.delete(id)) continue;
    timer.callback();
    await Promise.resolve();
  }
};
try {
  let resolveInventoryFetch;
  let inventoryFetchAttempts = 0;
  let inventoryFetchSignal = null;
  globalThis.fetch = (_url, options = {}) => {
    inventoryFetchAttempts += 1;
    inventoryFetchSignal = options.signal;
    return new Promise(resolve => { resolveInventoryFetch = resolve; });
  };
  const inventoryAbortController = new AbortController();
  let inventorySettled = false;
  const slowInventory = api.getStorageResources({
    timeoutMs: null,
    retries: 1,
    signal: inventoryAbortController.signal,
  }).then(value => {
    inventorySettled = true;
    return value;
  }, error => {
    inventorySettled = true;
    throw error;
  });
  await Promise.resolve();
  assert.strictEqual(inventoryFetchAttempts, 1, 'resource inventory must start one pending fetch');
  assert(inventoryFetchSignal, 'resource inventory must retain an AbortController signal');
  assert.strictEqual(fakeTimers.size, 0, 'timeoutMs:null must not schedule an elapsed timer');
  await advanceFakeClock(8001);
  assert.strictEqual(inventorySettled, false, 'a valid inventory read must remain pending beyond seven seconds');
  assert.strictEqual(inventoryFetchAttempts, 1, 'a slow inventory read must not be retried');
  assert.strictEqual(inventoryFetchSignal.aborted, false, 'elapsed time must not abort an untimed inventory read');
  resolveInventoryFetch({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ resources: ['complete inventory'] }),
  });
  assert.deepStrictEqual(await slowInventory, { resources: ['complete inventory'] });

  let externallyAbortedMutationAttempts = 0;
  globalThis.fetch = (_url, options = {}) => {
    externallyAbortedMutationAttempts += 1;
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted by caller');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const externalAbortController = new AbortController();
  const abortedMutation = api.request('/external-abort-mutation', {
    method: 'POST',
    body: '{}',
    timeoutMs: null,
    retries: 1,
    signal: externalAbortController.signal,
  });
  const abortExpectation = assert.rejects(
    abortedMutation,
    error => error?.name === 'AbortError' && error.status === undefined && error.code === undefined,
    'external cancellation must remain AbortError rather than becoming HTTP 408',
  );
  await Promise.resolve();
  externalAbortController.abort();
  await abortExpectation;
  assert.strictEqual(externallyAbortedMutationAttempts, 1, 'an externally aborted mutation must never retry');
} finally {
  globalThis.fetch = realFetchForResourceTimeout;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
console.log('✓ untimed resource inventory and non-retryable external cancellation verified');

// 5. Setup synthetic DOM environment to test component and view renders
class MockElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.innerHTML = '';
    this.children = [];
    this.style = {};
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

// 4b. Test api.getJobs URL query construction including pagination
let capturedUrl = null;
api.request = async (url) => { capturedUrl = url; return []; };
await api.getJobs({ status: 'succeeded', profile: 'fem-cpu-release', worktree: 'wt-1', sort: 'oldest', page: 2, limit: 25, cursor: 'opaque-cursor' });
assert(capturedUrl.includes('status=succeeded'), 'getJobs must include status in query');
assert(capturedUrl.includes('profile=fem-cpu-release'), 'getJobs must include profile in query');
assert(capturedUrl.includes('worktree=wt-1'), 'getJobs must include worktree in query');
assert(capturedUrl.includes('sort=oldest'), 'getJobs must include sort in query');
assert(capturedUrl.includes('page=2'), 'getJobs must include page in query');
assert(capturedUrl.includes('limit=25'), 'getJobs must include limit in query');
assert(capturedUrl.includes('cursor=opaque-cursor'), 'getJobs must include cursor in query');
const retentionRevision = 'a'.repeat(64);
await api.getRetentionPlanPage('plan-01234567', {
  collection: 'items', cursor: 12, limit: 25, revision: retentionRevision,
});
assert(capturedUrl.includes('/api/v1/retention/plans/plan-01234567?'), 'retention page request must encode the plan path');
assert(capturedUrl.includes('collection=items'), 'retention page request must identify its collection');
assert(capturedUrl.includes('cursor=12'), 'retention page request must preserve its offset');
assert(capturedUrl.includes('limit=25'), 'retention page request must preserve its bounded page size');
assert(capturedUrl.includes(`revision=${retentionRevision}`), 'retention page request must bind the page revision');
await assert.rejects(
  async () => api.getRetentionPlanPage('plan-01234567', { collection: 'items', cursor: 1, limit: 25 }),
  /Invalid retention detail page request/,
  'nonzero retention page cursors must include a collection revision',
);
console.log('✓ API query construction for jobs and revision-bound retention pages verified');

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

// 7b. Test backend-advertised automatic and runtime retention capabilities
const originalPolicyApi = {
  get: api.getRetentionPolicy,
  update: api.updateRetentionPolicy,
};
const originalPolicyAlert = globalThis.alert;
const policyAlerts = [];
const policyUpdatePayloads = [];
const policyViewModule = await import('./src/views/PoliciesView.js');

globalThis.alert = (message) => policyAlerts.push(message);
api.updateRetentionPolicy = async (payload) => {
  policyUpdatePayloads.push(payload);
  return {};
};

function makePolicyViewFixture(mode = 'preview') {
  const container = new MockElement('div');
  const card = new MockElement('div');
  const saveButton = new MockElement('button');
  const form = new MockElement('form');
  container._elements.set('#policy-card', card);
  container._elements.set('#btn-save-policy', saveButton);
  card._elements.set('#policy-form', form);

  const values = {
    '#pol-mode': mode,
    '#pol-ttl-success': '48',
    '#pol-ttl-failure': '240',
    '#pol-warn-gib': '40',
    '#pol-crit-gib': '12',
    '#pol-min-free': '9',
    '#pol-min-artifacts': '5',
  };
  for (const [selector, value] of Object.entries(values)) {
    const input = new MockElement('input');
    input.value = value;
    if (selector === '#pol-min-artifacts') {
      input.checkValidity = () => true;
      input.reportValidity = () => {};
    }
    card._elements.set(selector, input);
  }
  const runtimeToggle = new MockElement('input');
  runtimeToggle.checked = true;
  card._elements.set('#pol-runtime-enabled', runtimeToggle);
  return { container, card, saveButton };
}

try {
  const availablePolicy = {
    mode: 'preview',
    automatic_mode_available: true,
    runtime_available: true,
    runtime_retention_enabled: false,
    min_artifacts_to_keep: 4,
    ttl_success_hours: 24,
    ttl_failure_hours: 168,
    notice: 'Execution retention is available; sources and results are preserved.',
  };
  api.getRetentionPolicy = async () => availablePolicy;
  const availableView = makePolicyViewFixture('automatic');
  policyViewModule.renderPoliciesView(availableView.container);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(availableView.card.innerHTML.includes(availablePolicy.notice),
    'PoliciesView must render the backend capability notice');
  assert.match(availableView.card.innerHTML, /<option value="automatic"[^>]*>/,
    'PoliciesView must render the automatic mode option');
  assert(!/<option value="automatic"[^>]*disabled/.test(availableView.card.innerHTML),
    'PoliciesView must enable automatic mode when the backend advertises it');
  assert(!/<input type="checkbox" id="pol-runtime-enabled"[^>]*disabled/.test(availableView.card.innerHTML),
    'PoliciesView must enable runtime retention when the backend advertises it');
  await availableView.saveButton.listeners.click[0]();
  assert.deepStrictEqual(policyUpdatePayloads[0], {
    mode: 'automatic',
    ttl_success_hours: 48,
    ttl_failure_hours: 240,
    disk_warning_threshold_gib: 40,
    disk_critical_threshold_gib: 12,
    min_free_space_gib: 9,
    runtime_retention_enabled: true,
    min_artifacts_to_keep: 5,
  }, 'PoliciesView must submit selected automatic/runtime settings through the existing API');

  const unavailablePolicy = {
    ...availablePolicy,
    automatic_mode_available: false,
    runtime_available: false,
    runtime_retention_enabled: false,
    notice: 'Only preview is available; protected artifacts are preserved.',
  };
  api.getRetentionPolicy = async () => unavailablePolicy;
  const unavailableView = makePolicyViewFixture('preview');
  policyViewModule.renderPoliciesView(unavailableView.container);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(/<option value="automatic"[^>]*disabled/.test(unavailableView.card.innerHTML),
    'PoliciesView must disable automatic mode when unavailable');
  assert(/<input type="number" id="pol-min-artifacts"[^>]*disabled/.test(unavailableView.card.innerHTML),
    'PoliciesView must disable runtime artifact retention when unavailable');
  assert(/<input type="checkbox" id="pol-runtime-enabled"[^>]*disabled/.test(unavailableView.card.innerHTML),
    'PoliciesView must disable runtime cleanup when unavailable');
  unavailableView.card.querySelector('#pol-mode').value = 'automatic';
  const updateCountBeforeRejectedMode = policyUpdatePayloads.length;
  await unavailableView.saveButton.listeners.click[0]();
  assert.strictEqual(policyUpdatePayloads.length, updateCountBeforeRejectedMode,
    'PoliciesView must reject automatic mode client-side when the backend says it is unavailable');
  assert(policyAlerts.some((message) => message.includes('Tryb automatyczny niedostępny')),
    'PoliciesView must explain why unavailable automatic mode was rejected');

  unavailableView.card.querySelector('#pol-mode').value = 'preview';
  await unavailableView.saveButton.listeners.click[0]();
  const previewPayload = policyUpdatePayloads.at(-1);
  assert.strictEqual(previewPayload.mode, 'preview');
  assert(!Object.hasOwn(previewPayload, 'runtime_retention_enabled'),
    'PoliciesView must omit the runtime-retention flag when unavailable');
  assert(!Object.hasOwn(previewPayload, 'min_artifacts_to_keep'),
    'PoliciesView must omit the runtime artifact count when unavailable');
  console.log('✓ PoliciesView follows advertised automatic/runtime retention capabilities');
} finally {
  api.getRetentionPolicy = originalPolicyApi.get;
  api.updateRetentionPolicy = originalPolicyApi.update;
  globalThis.alert = originalPolicyAlert;
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
let observedStorageVolumeOptions = null;
api.getStorageVolumes = async (options = {}) => {
  observedStorageVolumeOptions = options;
  return [
    { name: 'Root Volume', mount_point: '/storage', total_bytes: 100e9, used_bytes: 20e9, free_bytes: 80e9, reserved_bytes: 10e9, warning_threshold_bytes: 15e9, status: 'healthy' }
  ];
};
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
let pendingStorageRequests = 0;
let deferredStorageOptions = null;
api.getStorageResources = (options = {}) => new Promise(resolve => {
  pendingStorageRequests += 1;
  deferredStorageOptions = options;
  resolveStorageResources = resolve;
});
const deferredStorageContainer = new MockElement('div');
const deferredStorageHandle = storageMod.renderStorageView(deferredStorageContainer);
const deferredLoadPromise = deferredStorageHandle.update();
assert.strictEqual(deferredStorageHandle.update(), deferredLoadPromise,
  'repeated StorageView updates must share one in-flight load promise');
await new Promise(r => setTimeout(r, 20));
const deferredVolumesEl = deferredStorageContainer.querySelector('#volumes-table-container');
const deferredCategoriesEl = deferredStorageContainer.querySelector('#categories-breakdown-container');
assert(deferredVolumesEl.innerHTML.includes('Root Volume'), 'StorageView must render volumes before resource scan completes');
assert(deferredCategoriesEl.innerHTML.includes('Wczytywanie podziału klas storage'), 'StorageView must keep resource sections loading independently');
assert.strictEqual(pendingStorageRequests, 1, 'Repeated updates must share the pending storage request');
assert.strictEqual(observedStorageVolumeOptions.timeoutMs, 5000,
  'the independent storage-volume request must retain its bounded five-second timeout');
assert.strictEqual(deferredStorageOptions.timeoutMs, null,
  'StorageView must opt the potentially long resource inventory out of elapsed timeout');
assert(deferredStorageOptions.signal && typeof deferredStorageOptions.signal.aborted === 'boolean',
  'StorageView must pass a lifecycle AbortSignal to the resource inventory request');
resolveStorageResources({ total_measured_bytes: 1, categories: [], resources: [] });
await deferredLoadPromise;
assert(deferredCategoriesEl.innerHTML.includes('Brak danych inwentaryzacji klas storage'), 'StorageView must render resource response after deferred scan resolves');
deferredStorageHandle.destroy();

// Leaving the view must prevent a late response from writing into its old DOM.
let resolveLateStorageResources;
let lateStorageRequests = 0;
let lateStorageOptions = null;
api.getStorageResources = (options = {}) => new Promise(resolve => {
  lateStorageRequests += 1;
  lateStorageOptions = options;
  resolveLateStorageResources = resolve;
});
const lateStorageContainer = new MockElement('div');
const lateStorageHandle = storageMod.renderStorageView(lateStorageContainer);
await new Promise(r => setTimeout(r, 20));
const lateCategoriesEl = lateStorageContainer.querySelector('#categories-breakdown-container');
const beforeDestroy = lateCategoriesEl.innerHTML;
const lateStorageLoad = lateStorageHandle.update();
assert.strictEqual(lateStorageOptions.timeoutMs, null,
  'destroy-lifecycle inventory request must not use an elapsed timeout');
lateStorageHandle.destroy();
assert.strictEqual(lateStorageOptions.signal.aborted, true,
  'destroying StorageView must abort its pending inventory request');
lateStorageHandle.update();
resolveLateStorageResources({ total_measured_bytes: 1, categories: [], resources: [] });
await lateStorageLoad;
assert.strictEqual(lateCategoriesEl.innerHTML, beforeDestroy, 'Destroyed StorageView must discard late resource response');
assert.strictEqual(lateStorageRequests, 1, 'Destroyed StorageView must not start new requests');


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

const storageResourcesBeforeStaleCheck = api.getStorageResources;
const lastGoodInventory = {
  total_measured_bytes: 15,
  measured_at: new Date().toISOString(),
  categories: [
    { name: 'Last good category', logical_bytes: 15, file_count: 1, completeness: 'complete', eligible_cleanup_bytes: 0, reclaimable_bytes: 0 },
  ],
  resources: [
    { resource_id: 'last-good-resource', name: 'Last good item', path: '/storage/last-good', category: 'sources', size_bytes: 15, file_count: 1, pinned: false, why_retained: 'active' },
  ],
};
api.getStorageResources = async () => lastGoodInventory;
const staleInventoryContainer = new MockElement('div');
const staleInventoryHandle = storageMod.renderStorageView(staleInventoryContainer);
await staleInventoryHandle.update();
const staleInventoryCategories = staleInventoryContainer.querySelector('#categories-breakdown-container');
const staleInventoryResources = staleInventoryContainer.querySelector('#resources-table-container');
assert(staleInventoryCategories.innerHTML.includes('Last good category'),
  'the last successful category inventory must be visible before a failed refresh');
assert(staleInventoryResources.innerHTML.includes('Last good item'),
  'the last successful resource inventory must be visible before a failed refresh');
api.getStorageResources = async () => { throw new Error('Inventory refresh unavailable'); };
await staleInventoryHandle.update();
assert(staleInventoryCategories.innerHTML.includes('Last good category') &&
  staleInventoryCategories.innerHTML.includes('Inventory refresh unavailable') &&
  staleInventoryCategories.innerHTML.includes('stale'),
  'a refresh failure must preserve category data and visibly identify it as stale');
assert(staleInventoryResources.innerHTML.includes('Last good item') &&
  staleInventoryResources.innerHTML.includes('Inventory refresh unavailable') &&
  staleInventoryResources.innerHTML.includes('stale'),
  'a refresh failure must preserve detailed resources and visibly identify them as stale');
staleInventoryHandle.destroy();

api.getStorageResources = async () => { throw new Error('Initial inventory unavailable'); };
const firstLoadErrorContainer = new MockElement('div');
const firstLoadErrorHandle = storageMod.renderStorageView(firstLoadErrorContainer);
await firstLoadErrorHandle.update();
assert(firstLoadErrorContainer.querySelector('#categories-breakdown-container').innerHTML.includes('Initial inventory unavailable'),
  'an initial category inventory failure must be visible instead of leaving a spinner');
assert(firstLoadErrorContainer.querySelector('#resources-table-container').innerHTML.includes('Initial inventory unavailable'),
  'an initial detailed inventory failure must be visible instead of leaving a spinner');
firstLoadErrorHandle.destroy();
api.getStorageResources = storageResourcesBeforeStaleCheck;

const originalRetentionMethods = {
  create: api.createRetentionPlan,
  get: api.getRetentionPlan,
  getPage: api.getRetentionPlanPage,
  apply: api.applyRetentionPlan,
};
const originalAlert = globalThis.alert;
const originalConfirm = globalThis.confirm;
const pageAlerts = [];
globalThis.alert = (message) => pageAlerts.push(message);
globalThis.confirm = () => true;
const planId = 'plan-aabbccdd';
const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);
const revisionItems = 'c'.repeat(64);
const candidate = (name) => ({ name, path: `/${name}`, size_bytes: 1, reason: name });
const planSnapshot = (revision, name, total) => ({
  plan_id: planId,
  scope: 'sources',
  status: 'preview',
  created_at: '2026-10-13T00:00:00Z',
  candidates_count: total,
  retained_count: 0,
  representation: 'paged',
  complete: false,
  omitted_fields: ['internal_progress'],
  omitted_fields_count: 21,
  omitted_fields_truncated: true,
  candidates: [candidate(name)],
  retained: [],
  collections: {
    candidates: {
      total, offset: 0, returned: 1, next_cursor: 1, revision,
      complete: false, blocked: false,
    },
    retained: {
      total: 0, offset: 0, returned: 0, next_cursor: null, revision: 'd'.repeat(64),
      complete: true, blocked: false,
    },
  },
});
let currentPlanSnapshot = planSnapshot(revisionA, 'old-a', 3);
let resolveStalePage;
let resolveDestroyedPage;
let deferNextPageUntilDestroy = false;
const retentionPageCalls = [];
api.createRetentionPlan = async () => currentPlanSnapshot;
api.getRetentionPlan = async () => currentPlanSnapshot;
api.getRetentionPlanPage = (...args) => {
  retentionPageCalls.push(args);
  if (args[1].revision === revisionA) {
    return new Promise(resolve => { resolveStalePage = resolve; });
  }
  if (deferNextPageUntilDestroy) {
    deferNextPageUntilDestroy = false;
    return new Promise(resolve => { resolveDestroyedPage = resolve; });
  }
  return Promise.resolve({
    representation: 'paged',
    page: {
      collection: 'candidates',
      offset: 1,
      returned: 1,
      total: 2,
      next_cursor: null,
      revision: revisionB,
      complete: false,
      blocked: false,
      entries: [candidate('fresh-b')],
    },
  });
};
api.applyRetentionPlan = async () => ({
  plan_id: planId,
  scope: 'sources',
  status: 'succeeded',
  applied: true,
  representation: 'paged',
  complete: false,
  candidates_count: 2,
  retained_count: 0,
  compacted_items_count: 74,
  candidates: [candidate('fresh-a')],
  retained: [],
  items: Array.from({ length: 50 }, (_, index) => ({
    job_id: `job-${index}`, status: 'compacted',
  })),
  collections: {
    candidates: {
      total: 2, offset: 0, returned: 1, next_cursor: 1, revision: revisionB,
      complete: false, blocked: false,
    },
    retained: {
      total: 0, offset: 0, returned: 0, next_cursor: null, revision: 'd'.repeat(64),
      complete: true, blocked: false,
    },
    items: {
      total: 74, offset: 0, returned: 50, next_cursor: 50, revision: revisionItems,
      complete: false, blocked: false,
    },
  },
});

const pagedStorageContainer = new MockElement('div');
const pagedStorageHandle = storageMod.renderStorageView(pagedStorageContainer);
await pagedStorageContainer.querySelector('#btn-create-plan').listeners.click[0]();
const pagedPlanContent = pagedStorageContainer.querySelector('#plan-content-container');
assert(pagedPlanContent.innerHTML.includes('old-a'), 'StorageView must render the first candidate range');
assert(pagedPlanContent.innerHTML.includes('Wyświetlono 1–1 z 3'), 'StorageView must label a partial range and total');
assert(pagedPlanContent.innerHTML.includes('pokazano ograniczoną próbkę nazw'),
  'StorageView must disclose when omitted-field names are only a bounded sample');
const stalePageRequest = pagedPlanContent.querySelector('#retention-page-candidates').onclick();
await Promise.resolve();
assert.strictEqual(retentionPageCalls[0][0], planId, 'page request must capture the active plan identity');
assert.strictEqual(retentionPageCalls[0][1].cursor, 1, 'page request must use the next offset');
assert.strictEqual(retentionPageCalls[0][1].revision, revisionA, 'page request must carry the current collection revision');

currentPlanSnapshot = planSnapshot(revisionB, 'fresh-a', 2);
await pagedStorageContainer.querySelector('#btn-plan-refresh').listeners.click[0]();
assert(pagedPlanContent.innerHTML.includes('fresh-a'), 'a new collection revision must reset loaded rows');
assert(!pagedPlanContent.innerHTML.includes('old-a'), 'a new collection revision must remove prior rows');
resolveStalePage({
  representation: 'paged',
  page: {
    collection: 'candidates',
    offset: 1,
    returned: 1,
    total: 3,
    next_cursor: 2,
    revision: revisionA,
    complete: false,
    blocked: false,
    entries: [candidate('stale-b')],
  },
});
await stalePageRequest;
assert(!pagedPlanContent.innerHTML.includes('stale-b'), 'late pages from an old revision must be ignored');

await pagedPlanContent.querySelector('#retention-page-candidates').onclick();
assert(pagedPlanContent.innerHTML.includes('fresh-b'), 'the current revision page must append in order');
assert(pagedPlanContent.innerHTML.includes('fresh-a'), 'the current revision page must preserve its first range');

const destroyedPageContainer = new MockElement('div');
const destroyedPageHandle = storageMod.renderStorageView(destroyedPageContainer);
await destroyedPageContainer.querySelector('#btn-create-plan').listeners.click[0]();
const destroyedPageContent = destroyedPageContainer.querySelector('#plan-content-container');
deferNextPageUntilDestroy = true;
const latePageRequest = destroyedPageContent.querySelector('#retention-page-candidates').onclick();
await Promise.resolve();
const destroyedPageMarkup = destroyedPageContent.innerHTML;
destroyedPageHandle.destroy();
resolveDestroyedPage({
  representation: 'paged',
  page: {
    collection: 'candidates',
    offset: 1,
    returned: 1,
    total: 2,
    next_cursor: null,
    revision: revisionB,
    complete: false,
    blocked: false,
    entries: [candidate('destroyed-late-row')],
  },
});
await latePageRequest;
assert.strictEqual(destroyedPageContent.innerHTML, destroyedPageMarkup,
  'a late retention page must not publish after StorageView is destroyed');

await pagedStorageContainer.querySelector('#btn-apply-plan').listeners.click[0]();
assert(pageAlerts.some(message => message.includes('74 kapsuł źródeł')),
  'apply outcome must use the aggregate count, not the loaded 50-row page');
assert(!pageAlerts.some(message => message.includes('50 kapsuł źródeł')),
  'a partial page count must never be presented as the full apply outcome');
pagedStorageHandle.destroy();

const hadSessionStorage = Object.prototype.hasOwnProperty.call(globalThis, 'sessionStorage');
const previousSessionStorage = globalThis.sessionStorage;
const savedPlanId = 'plan-11111111';
const createdPlanId = 'plan-22222222';
const secondCreatedPlanId = 'plan-33333333';
const staleSimplePlan = (id, name) => ({
  plan_id: id,
  scope: 'sources',
  status: 'preview',
  candidates_count: 1,
  retained_count: 0,
  candidates: [candidate(name)],
  retained: [],
});
let reconnectResolver;
let manualRefreshResolver;
let destroyedRefreshResolver;
let nextCreatedPlan = staleSimplePlan(createdPlanId, 'created-plan-b');
globalThis.sessionStorage = {
  getItem: () => savedPlanId,
  setItem: () => {},
};
api.createRetentionPlan = async () => nextCreatedPlan;
api.getRetentionPlan = (id) => {
  if (id === savedPlanId) return new Promise(resolve => { reconnectResolver = resolve; });
  if (id === createdPlanId) return new Promise(resolve => { manualRefreshResolver = resolve; });
  if (id === secondCreatedPlanId) return new Promise(resolve => { destroyedRefreshResolver = resolve; });
  return Promise.resolve(staleSimplePlan(id, 'unexpected-plan'));
};
const planRaceContainer = new MockElement('div');
const planRaceHandle = storageMod.renderStorageView(planRaceContainer);
const planRaceContent = planRaceContainer.querySelector('#plan-content-container');
assert.strictEqual(typeof reconnectResolver, 'function', 'saved-plan reconnect must start its read');
await planRaceContainer.querySelector('#btn-create-plan').listeners.click[0]();
assert(planRaceContent.innerHTML.includes('created-plan-b'), 'the created plan must replace the reconnect placeholder');
reconnectResolver(staleSimplePlan(savedPlanId, 'stale-reconnect-plan'));
await new Promise(resolve => setTimeout(resolve, 0));
assert(planRaceContent.innerHTML.includes('created-plan-b'), 'a late reconnect must not replace a newer created plan');
assert(!planRaceContent.innerHTML.includes('stale-reconnect-plan'), 'a late reconnect must not render its stale result');

const manualRefresh = planRaceContainer.querySelector('#btn-plan-refresh').listeners.click[0]();
assert.strictEqual(typeof manualRefreshResolver, 'function', 'manual refresh must start its read');
nextCreatedPlan = staleSimplePlan(secondCreatedPlanId, 'created-plan-c');
await planRaceContainer.querySelector('#btn-create-plan').listeners.click[0]();
manualRefreshResolver(staleSimplePlan(createdPlanId, 'stale-manual-refresh'));
await manualRefresh;
assert(planRaceContent.innerHTML.includes('created-plan-c'), 'the second created plan must remain active');
assert(!planRaceContent.innerHTML.includes('stale-manual-refresh'), 'a late manual refresh must not overwrite a newer plan');

const destroyPlanMarkup = planRaceContent.innerHTML;
const destroyedRefresh = planRaceContainer.querySelector('#btn-plan-refresh').listeners.click[0]();
assert.strictEqual(typeof destroyedRefreshResolver, 'function', 'destroy guard test must start a pending plan read');
planRaceHandle.destroy();
destroyedRefreshResolver(staleSimplePlan(secondCreatedPlanId, 'late-after-destroy'));
await destroyedRefresh;
assert.strictEqual(planRaceContent.innerHTML, destroyPlanMarkup,
  'a pending plan refresh must not write into the view after destroy');

const conflictPlanId = 'plan-44444444';
const conflictRevision = 'e'.repeat(64);
const latestRevision = 'f'.repeat(64);
const staleConflictRevision = 'a'.repeat(64);
const pagedConflictPlan = (revision, name) => ({
  ...staleSimplePlan(conflictPlanId, name),
  representation: 'paged',
  complete: false,
  candidates: [candidate(name)],
  collections: {
    candidates: {
      total: 2, offset: 0, returned: 1, next_cursor: 1, revision,
      complete: false, blocked: false,
    },
    retained: {
      total: 0, offset: 0, returned: 0, next_cursor: null, revision: 'd'.repeat(64),
      complete: true, blocked: false,
    },
  },
});
let conflictReadResolver;
let currentReadResolver;
let conflictReadCount = 0;
globalThis.sessionStorage.getItem = () => null;
api.createRetentionPlan = async () => pagedConflictPlan(conflictRevision, 'before-conflict-refresh');
api.getRetentionPlan = (id) => {
  if (id === conflictPlanId && ++conflictReadCount === 1) {
    return new Promise(resolve => { conflictReadResolver = resolve; });
  }
  if (id === conflictPlanId) return new Promise(resolve => { currentReadResolver = resolve; });
  return Promise.resolve(staleSimplePlan(id, 'unexpected-conflict-plan'));
};
api.getRetentionPlanPage = async () => {
  const error = new Error('stale collection revision');
  error.status = 409;
  throw error;
};
const conflictContainer = new MockElement('div');
const conflictHandle = storageMod.renderStorageView(conflictContainer);
await conflictContainer.querySelector('#btn-create-plan').listeners.click[0]();
const conflictContent = conflictContainer.querySelector('#plan-content-container');
const pendingConflictPage = conflictContent.querySelector('#retention-page-candidates').onclick();
await new Promise(resolve => setTimeout(resolve, 0));
assert.strictEqual(typeof conflictReadResolver, 'function', 'a page conflict must start a plan refresh');
const latestPlanRefresh = conflictContainer.querySelector('#btn-plan-refresh').listeners.click[0]();
assert.strictEqual(typeof currentReadResolver, 'function', 'manual refresh must supersede a conflict refresh');
currentReadResolver(pagedConflictPlan(latestRevision, 'latest-same-plan-revision'));
await latestPlanRefresh;
conflictReadResolver(pagedConflictPlan(staleConflictRevision, 'stale-conflict-revision'));
await pendingConflictPage;
assert(conflictContent.innerHTML.includes('latest-same-plan-revision'),
  'a stale conflict refresh must not roll back the same plan to an older revision');
assert(!conflictContent.innerHTML.includes('stale-conflict-revision'),
  'the older conflict response must not render after the current same-plan revision');
conflictHandle.destroy();

const applyingPlanId = 'plan-55555555';
const createdWhileApplyingId = 'plan-66666666';
let nextApplyRacePlan = staleSimplePlan(applyingPlanId, 'plan-before-apply');
let resolvePendingApply;
let applyMutationCalls = 0;
api.createRetentionPlan = async () => nextApplyRacePlan;
api.applyRetentionPlan = (id) => {
  applyMutationCalls += 1;
  assert.strictEqual(id, applyingPlanId, 'apply must use the plan identity captured before the mutation');
  return new Promise(resolve => { resolvePendingApply = resolve; });
};
const applyRaceContainer = new MockElement('div');
const applyRaceHandle = storageMod.renderStorageView(applyRaceContainer);
await applyRaceContainer.querySelector('#btn-create-plan').listeners.click[0]();
const applyRaceContent = applyRaceContainer.querySelector('#plan-content-container');
assert(applyRaceContent.innerHTML.includes('plan-before-apply'), 'the plan to apply must be active before the mutation starts');
const applyAlertsBefore = pageAlerts.length;
const pendingApply = applyRaceContainer.querySelector('#btn-apply-plan').listeners.click[0]();
assert.strictEqual(typeof resolvePendingApply, 'function', 'apply must start one deferred mutation request');
nextApplyRacePlan = staleSimplePlan(createdWhileApplyingId, 'created-during-apply');
await applyRaceContainer.querySelector('#btn-create-plan').listeners.click[0]();
assert(applyRaceContent.innerHTML.includes('created-during-apply'), 'a newer plan must become active while apply is pending');
resolvePendingApply({
  ...staleSimplePlan(applyingPlanId, 'stale-apply-response'),
  status: 'succeeded',
  applied: true,
  compacted_items_count: 1,
  disk_free_change_bytes: 0,
});
await pendingApply;
assert.strictEqual(applyMutationCalls, 1, 'a stale apply response must never retry the mutation');
assert(applyRaceContent.innerHTML.includes('created-during-apply'), 'a late apply response must preserve the newer active plan');
assert(!applyRaceContent.innerHTML.includes('stale-apply-response'), 'a late apply response must not render its old plan');
assert.strictEqual(pageAlerts.length, applyAlertsBefore, 'a stale apply result must not publish an outcome for the newer plan');
applyRaceHandle.destroy();

if (hadSessionStorage) globalThis.sessionStorage = previousSessionStorage;
else delete globalThis.sessionStorage;
globalThis.alert = originalAlert;
globalThis.confirm = originalConfirm;
api.createRetentionPlan = originalRetentionMethods.create;
api.getRetentionPlan = originalRetentionMethods.get;
api.getRetentionPlanPage = originalRetentionMethods.getPage;
api.applyRetentionPlan = originalRetentionMethods.apply;

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

// Queue pagination follows a stable keyset cursor through a mutable active set.
const { renderQueueView } = await import('./src/views/QueueView.js');
const originalGetJobs = api.getJobs;
const expectedQueueIds = Array.from({ length: 205 }, (_, index) =>
  `queue-job-${String(index).padStart(4, '0')}`);
const queueRequests = [];
const queuePages = [
  {
    items: expectedQueueIds.slice(0, 200).map(job_id => ({job_id, state: 'queued', created_at: 10})),
    next_cursor: 'watermark-after-200',
    as_of_sequence: 205,
    page: 1,
    pages: 1,
    total: 201,
    is_truncated: false,
  },
  {
    items: expectedQueueIds.slice(200).map(job_id => ({job_id, state: 'queued', created_at: 10})),
    next_cursor: null,
    as_of_sequence: 205,
    page: 1,
    pages: 1,
    total: 5,
    is_truncated: false,
  },
];
api.getJobs = async (params) => {
  queueRequests.push(params);
  return queuePages.shift();
};
const queueContainer = new MockElement('div');
renderQueueView(queueContainer);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(queueRequests, [
  {status: 'queue', sort: 'oldest', limit: 200},
  {status: 'queue', sort: 'oldest', limit: 200, cursor: 'watermark-after-200'},
]);
const queueHtml = queueContainer.querySelector('#queue-table-card').innerHTML;
const renderedQueueIds = [...queueHtml.matchAll(/title="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(renderedQueueIds, expectedQueueIds, 'QueueView must render every cursor page in FIFO order');
assert.strictEqual(new Set(renderedQueueIds).size, expectedQueueIds.length,
  'QueueView must not render duplicate jobs across cursor pages');

api.getJobs = async () => ({items: [], next_cursor: null, as_of_sequence: 205, is_truncated: true});
const truncatedQueue = new MockElement('div');
renderQueueView(truncatedQueue);
await new Promise(resolve => setTimeout(resolve, 0));
assert(truncatedQueue.querySelector('#queue-table-card').innerHTML.includes('niekompletna'));

api.getJobs = async () => ({
  items: [{job_id: 'legacy-offset-only', state: 'queued', created_at: 10}],
  page: 1, pages: 1, total: 1, is_truncated: false,
});
const legacyOffsetQueue = new MockElement('div');
renderQueueView(legacyOffsetQueue);
await new Promise(resolve => setTimeout(resolve, 0));
const legacyOffsetHtml = legacyOffsetQueue.querySelector('#queue-table-card').innerHTML;
assert(legacyOffsetHtml.includes('Nieprawidłowa odpowiedź kolejki'),
  'QueueView must reject an old OFFSET response without cursor and watermark fields');
assert(!legacyOffsetHtml.includes('legacy-offset-only'),
  'QueueView must not present a partial first OFFSET page as a complete queue');

api.getJobs = async () => ({items: [], next_cursor: null, as_of_sequence: -1, is_truncated: false});
const invalidWatermarkQueue = new MockElement('div');
renderQueueView(invalidWatermarkQueue);
await new Promise(resolve => setTimeout(resolve, 0));
assert(invalidWatermarkQueue.querySelector('#queue-table-card').innerHTML.includes('Nieprawidłowa odpowiedź kolejki'),
  'QueueView must reject a negative as-of watermark');

const repeatedCursorResponses = [
  {items: [{job_id: 'cursor-page-one', state: 'queued'}], next_cursor: 'repeat-cursor', as_of_sequence: 10},
  {items: [{job_id: 'cursor-page-two', state: 'queued'}], next_cursor: 'repeat-cursor', as_of_sequence: 10},
];
api.getJobs = async () => repeatedCursorResponses.shift();
const repeatedCursorQueue = new MockElement('div');
renderQueueView(repeatedCursorQueue);
await new Promise(resolve => setTimeout(resolve, 0));
assert(repeatedCursorQueue.querySelector('#queue-table-card').innerHTML.includes('Nieprawidłowa odpowiedź kolejki'),
  'QueueView must reject a cursor repeated across pages');

const duplicateJobResponses = [
  {items: [{job_id: 'duplicate-queue-job', state: 'queued'}], next_cursor: 'next-cursor', as_of_sequence: 10},
  {items: [{job_id: 'duplicate-queue-job', state: 'queued'}], next_cursor: null, as_of_sequence: 10},
];
api.getJobs = async () => duplicateJobResponses.shift();
const duplicateJobQueue = new MockElement('div');
renderQueueView(duplicateJobQueue);
await new Promise(resolve => setTimeout(resolve, 0));
const duplicateJobHtml = duplicateJobQueue.querySelector('#queue-table-card').innerHTML;
assert(duplicateJobHtml.includes('Nieprawidłowa odpowiedź kolejki'),
  'QueueView must reject a duplicate job id across cursor pages');
assert(!duplicateJobHtml.includes('duplicate-queue-job'),
  'QueueView must not present duplicate rows as a valid queue');

api.getJobs = originalGetJobs;
console.log('✓ Queue cursor completeness, stable watermark, FIFO order, duplicate cursor/job rejection and legacy response rejection verified');
