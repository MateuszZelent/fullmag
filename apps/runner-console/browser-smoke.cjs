/*
 * Browser smoke test for the static Runner Console.
 *
 * This intentionally uses a local, in-process HTTP fixture.  It does not start
 * the Fullmag coordinator, submit jobs, mutate a queue, or call a real API.
 * Paths can be overridden for another checkout/runtime with:
 *   FULLMAG_RUNNER_UI_ROOT
 *   FULLMAG_RUNNER_PLAYWRIGHT
 *   FULLMAG_RUNNER_CHROMIUM
 *   FULLMAG_RUNNER_SMOKE_SCREENSHOT
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const repositoryRoot = path.resolve(
  process.env.FULLMAG_RUNNER_UI_ROOT || path.resolve(__dirname, '..', '..'),
);
const appRoot = path.join(repositoryRoot, 'apps', 'runner-console');
const playwrightModule = process.env.FULLMAG_RUNNER_PLAYWRIGHT
  || 'C:/Users/Mateusz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
const chromiumExecutable = process.env.FULLMAG_RUNNER_CHROMIUM
  || 'C:/git/fullmag/storage/cache/windows/playwright-browsers/chromium-1234/chrome-win64/chrome.exe';
const screenshotPath = process.env.FULLMAG_RUNNER_SMOKE_SCREENSHOT
  || path.join(process.env.TEMP || process.env.TMP || 'C:/Windows/Temp', 'fullmag-runner-console-browser-smoke.png');

const { chromium } = require(playwrightModule);

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const now = Date.now();
const timestamps = {
  now: new Date(now).toISOString(),
  activeCreated: new Date(now - 8 * 60 * 1000).toISOString(),
  activeStarted: new Date(now - 7 * 60 * 1000).toISOString(),
  queuedCreated: new Date(now - 2 * 60 * 1000).toISOString(),
  successCreated: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
  successUpdated: new Date(now - 3 * 24 * 60 * 60 * 1000 + 11 * 60 * 1000).toISOString(),
  failedCreated: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
  failedUpdated: new Date(now - 2 * 24 * 60 * 60 * 1000 + 4 * 60 * 1000).toISOString(),
  event: new Date(now - 30 * 1000).toISOString(),
};

const ids = {
  active: 'job-active-browser-smoke',
  queued: 'job-queued-browser-smoke',
  success: 'job-success-browser-smoke',
  failed: 'job-failed-browser-smoke',
};

let mockMode = 'healthy';
const requestLog = [];

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function noContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('fixture request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jobSummary(job) {
  return {
    job_id: job.job_id,
    state: job.state,
    profile: job.profile,
    owner: job.owner,
    worktree_id: job.worktree_id,
    source_digest: job.source_digest,
    created_at: job.created_at,
    started_at: job.started_at,
    updated_at: job.updated_at,
    exit_code: job.exit_code,
  };
}

const activeJob = {
  job_id: ids.active,
  state: 'running',
  profile: 'cpu-release',
  owner: 'browser-smoke',
  worktree_id: 'runner-review-smoke',
  source_digest: 'sha256:browser-smoke-source',
  created_at: timestamps.activeCreated,
  started_at: timestamps.activeStarted,
  updated_at: timestamps.now,
  stage: 'compile',
  stages: [
    { name: 'preflight', status: 'succeeded', duration_seconds: 9 },
    { name: 'configure', status: 'succeeded', duration_seconds: 22 },
    { name: 'compile', status: 'running' },
    { name: 'receipt', status: 'pending' },
  ],
  receipt: {
    schema: 'fullmag.build-receipt.v1',
    source_digest: 'sha256:browser-smoke-source',
    requested_device: 'cpu',
    resolved_device: 'cpu',
    qualification: 'NOT VERIFIED',
  },
};

const queuedJob = {
  job_id: ids.queued,
  state: 'queued',
  profile: 'fem-cpu-release',
  owner: 'browser-smoke',
  worktree_id: 'runner-review-queued',
  source_digest: 'sha256:browser-smoke-queued',
  created_at: timestamps.queuedCreated,
  updated_at: timestamps.queuedCreated,
};

const successJob = {
  job_id: ids.success,
  state: 'succeeded',
  profile: 'cpu-release',
  owner: 'browser-smoke',
  worktree_id: 'runner-review-history',
  source_digest: 'sha256:browser-smoke-success',
  created_at: timestamps.successCreated,
  started_at: timestamps.successCreated,
  updated_at: timestamps.successUpdated,
  exit_code: 0,
};

const failedJob = {
  job_id: ids.failed,
  state: 'failed',
  profile: 'fem-cpu-release',
  owner: 'browser-smoke',
  worktree_id: 'runner-review-history',
  source_digest: 'sha256:browser-smoke-failed',
  created_at: timestamps.failedCreated,
  started_at: timestamps.failedCreated,
  updated_at: timestamps.failedUpdated,
  exit_code: 1,
};

const historyJobs = [successJob, failedJob, {
  ...failedJob,
  job_id: 'job-cancelled-browser-smoke',
  state: 'cancelled',
  updated_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
  exit_code: null,
}];

function overviewFixture() {
  return {
    active_build: activeJob,
    queued_count: 1,
    next_jobs: [jobSummary(queuedJob)],
    storage: {
      status: 'healthy',
      free_bytes: 50 * GIB,
      reserved_bytes: 8 * GIB,
      warning_threshold_bytes: 30 * GIB,
      critical_threshold_bytes: 10 * GIB,
    },
    worker: {
      state: 'running',
      memory_mb: 512,
      limit_mb: 8192,
      cpu_percent: 12.4,
    },
    last_cleanup: {
      status: 'none',
      reclaimed_bytes: null,
      candidates_count: null,
    },
    trends: [
      { timestamp: new Date(now - 60 * 1000).toISOString(), disk_free_gb: 50.1, storage_growth_mb: 1.5, ram_mb: 480, cpu_percent: 8.2, io_mb_s: 3.1 },
      { timestamp: timestamps.now, disk_free_gb: 50.0, storage_growth_mb: 2.2, ram_mb: 512, cpu_percent: 12.4, io_mb_s: 5.8 },
    ],
    incidents: [],
  };
}

function healthFixture() {
  return {
    ok: true,
    service: 'fullmag-build-runner',
    worker_alive: true,
    worker_state: 'running',
    accepting_jobs: true,
    stop_requested: false,
    storage_free_bytes: 50 * GIB,
    runtime_environment: 'browser-smoke-fixture',
    docker_context: 'mock-only',
    supported_operation: 'build',
    allowed_profiles: ['cpu-release', 'fem-cpu-release'],
    qualification: 'NOT VERIFIED',
    worker_security: 'fixture; no coordinator process',
    api: {
      started_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      last_request_at: timestamps.now,
    },
  };
}

function retentionPolicyFixture() {
  return {
    mode: 'preview',
    ttl_success_hours: 24,
    ttl_failure_hours: 168,
    ttl_orphan_hours: 24,
    ttl_sources_hours: 168,
    ttl_logs_days: 30,
    min_artifacts_to_keep: 3,
    disk_warning_threshold_gib: 30,
    disk_critical_threshold_gib: 10,
    min_free_space_gib: 8,
    version: 'smoke-1',
    updated_at: timestamps.now,
  };
}

function storageVolumesFixture() {
  return [{
    name: 'project-storage',
    mount_point: '/fullmag/storage',
    total_bytes: 100 * GIB,
    used_bytes: 50 * GIB,
    free_bytes: 50 * GIB,
    reserved_bytes: 8 * GIB,
    warning_threshold_bytes: 30 * GIB,
    status: 'healthy',
  }];
}

function storageResourcesFixture() {
  return {
    measured_at: timestamps.now,
    total_measured_bytes: 50 * GIB,
    categories: [
      { name: 'execution', logical_bytes: 20 * GIB, file_count: 14, completeness: 'complete', eligible_cleanup_bytes: 18 * GIB, reclaimable_bytes: 18 * GIB },
      { name: 'artifacts', logical_bytes: 20 * GIB, file_count: 8, completeness: 'complete', eligible_cleanup_bytes: 0, reclaimable_bytes: 0 },
      { name: 'source_capsules', logical_bytes: 10 * GIB, file_count: 3, completeness: 'partial', eligible_cleanup_bytes: 2 * GIB, reclaimable_bytes: 2 * GIB },
    ],
    resources: [
      { resource_id: 'resource-execution-smoke', name: 'execution', category: 'execution', path: 'builds/runner-review-smoke/execution', size_bytes: 20 * GIB, file_count: 14, pinned: false, why_retained: 'Chronione do upływu TTL po zakończeniu.' },
      { resource_id: 'resource-artifacts-smoke', name: 'artifacts', category: 'artifacts', path: 'builds/runner-review-smoke/artifacts', size_bytes: 20 * GIB, file_count: 8, pinned: true, why_retained: 'Receipt i artefakty dowodowe.' },
    ],
  };
}

function processFixture() {
  return [{
    id: 'fixture-worker-01',
    role: 'Build worker',
    type: 'container (mock)',
    job_id: ids.active,
    started_at: timestamps.activeStarted,
    cpu: '12.4%',
    ram: '512 MiB',
    limit: '8192 MiB',
    io: '5.8 MB/s',
    paths: '/fullmag/storage/builds/runner-review-smoke',
    cmd: 'fullmag-build-runner --profile cpu-release [redacted]',
    status: 'running',
  }];
}

function eventFixture() {
  return [
    { timestamp: timestamps.event, level: 'INFO', event: 'job.started', job_id: ids.active, message: 'Build rozpoczęty w fixture workerze.' },
    { timestamp: timestamps.activeStarted, level: 'WARN', event: 'retention.preview', job_id: ids.success, message: 'Plan retencji jest tylko podglądem.' },
  ];
}

function metricsFixture() {
  return [
    { timestamp: new Date(now - 60 * 1000).toISOString(), ram_mb: 480, cpu_percent: 8.2, storage_growth_mb: 1.5 },
    { timestamp: timestamps.now, ram_mb: 512, cpu_percent: 12.4, storage_growth_mb: 2.2 },
  ];
}

function resourcesFixture() {
  return [
    { name: 'execution', path: 'builds/runner-review-smoke/execution', size_bytes: 20 * GIB, file_count: 14 },
    { name: 'artifacts', path: 'builds/runner-review-smoke/artifacts', size_bytes: 20 * GIB, file_count: 8 },
  ];
}

function detailFixture(jobId) {
  const known = [activeJob, queuedJob, successJob, failedJob, ...historyJobs];
  const job = known.find(candidate => candidate.job_id === jobId) || activeJob;
  return {
    ...job,
    stages: job.stages || [
      { name: 'preflight', status: 'succeeded', duration_seconds: 5 },
      { name: 'compile', status: job.state === 'succeeded' ? 'succeeded' : job.state },
    ],
    source_digest: job.source_digest || 'sha256:browser-smoke',
    receipt: job.state === 'succeeded' ? {
      schema: 'fullmag.build-receipt.v1',
      source_digest: job.source_digest,
      requested_device: 'cpu',
      resolved_device: 'cpu',
      qualification: 'NOT VERIFIED',
    } : null,
  };
}

function retentionPlanFixture() {
  return {
    plan_id: 'plan-browser-smoke-preview',
    policy_version: 'smoke-1',
    created_at: timestamps.now,
    status: 'preview_only',
    estimated_reclaimed_bytes: 20 * GIB,
    candidates_count: 1,
    retained_count: 2,
    candidates: [{
      name: 'expired-execution',
      path: 'builds/old-worktree/execution',
      size_bytes: 20 * GIB,
      reason: 'TTL sukcesu przekroczony; fixture preview-only.',
    }],
  };
}

function apiFailureForMode(reqPath) {
  if (mockMode === 'unauthorized' && (reqPath === '/health' || reqPath.startsWith('/api/'))) {
    return { status: 401, error: 'Wymagana autoryzacja fixture' };
  }
  if (mockMode === 'unavailable' && (reqPath === '/health' || reqPath.startsWith('/api/'))) {
    return { status: 503, error: 'Koordynator fixture jest niedostępny' };
  }
  return null;
}

async function handleApi(req, res, url) {
  const reqPath = url.pathname;
  requestLog.push({ method: req.method, path: reqPath, mode: mockMode });

  if (reqPath === '/api/v1/auth/session' && req.method === 'POST') {
    await readBody(req);
    if (mockMode === 'unauthorized') {
      json(res, 401, { error: 'Token fixture odrzucony' });
      return;
    }
    json(res, 200, { authenticated: true, session: 'fixture-only' });
    return;
  }

  const failure = apiFailureForMode(reqPath);
  if (failure) {
    json(res, failure.status, { error: failure.error });
    return;
  }

  if (reqPath === '/api/v1/auth/session' && req.method === 'GET') {
    json(res, 200, { authenticated: true });
    return;
  }
  if (reqPath === '/api/v1/auth/logout' && req.method === 'POST') {
    await readBody(req);
    noContent(res);
    return;
  }
  if (reqPath === '/api/v1/overview') {
    json(res, 200, overviewFixture());
    return;
  }
  if (reqPath === '/health') {
    json(res, 200, healthFixture());
    return;
  }
  if (reqPath === '/api/v1/alerts') {
    json(res, 200, []);
    return;
  }
  if (reqPath === '/api/v1/retention/policy' && req.method === 'GET') {
    json(res, 200, retentionPolicyFixture());
    return;
  }
  if (reqPath === '/api/v1/retention/policy' && req.method === 'PUT') {
    await readBody(req);
    json(res, 200, retentionPolicyFixture());
    return;
  }
  if (reqPath === '/api/v1/retention/plans' && req.method === 'GET') {
    json(res, 200, { items: [], total: 0 });
    return;
  }
  if (reqPath === '/api/v1/retention/plans' && req.method === 'POST') {
    await readBody(req);
    json(res, 200, retentionPlanFixture());
    return;
  }
  if (reqPath === '/api/v1/retention/plans/plan-browser-smoke-preview/apply' && req.method === 'POST') {
    await readBody(req);
    json(res, 200, {
      status: 'preview_only',
      applied: false,
      message: 'Fixture preview-only: brak usuwania plików.',
    });
    return;
  }
  if (reqPath === '/api/v1/storage/volumes') {
    json(res, 200, storageVolumesFixture());
    return;
  }
  if (reqPath === '/api/v1/storage/resources') {
    json(res, 200, storageResourcesFixture());
    return;
  }
  if (reqPath === '/api/v1/processes') {
    json(res, 200, processFixture());
    return;
  }
  if (reqPath === '/api/v1/events') {
    json(res, 200, eventFixture());
    return;
  }
  if (reqPath === '/api/v1/jobs') {
    const status = url.searchParams.get('status');
    const items = status === 'history' || status === 'succeeded' || status === 'failed' || status === 'cancelled'
      ? historyJobs
      : [activeJob, queuedJob, ...historyJobs];
    json(res, 200, {
      items,
      total: items.length,
      pages: 1,
      worktrees: ['runner-review-smoke', 'runner-review-queued', 'runner-review-history'],
    });
    return;
  }

  const jobMatch = reqPath.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/(logs|events|metrics|resources))?$/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const suffix = jobMatch[2];
    if (suffix === 'logs') {
      json(res, 200, { tail: `[${timestamps.event}] fixture log for ${jobId}\ncompile: running\n` });
    } else if (suffix === 'events') {
      json(res, 200, eventFixture().filter(event => !event.job_id || event.job_id === jobId));
    } else if (suffix === 'metrics') {
      json(res, 200, metricsFixture());
    } else if (suffix === 'resources') {
      json(res, 200, resourcesFixture());
    } else {
      json(res, 200, detailFixture(jobId));
    }
    return;
  }
  if (reqPath.startsWith('/api/v1/resources/') && reqPath.endsWith('/pin') && req.method === 'POST') {
    await readBody(req);
    json(res, 200, { ok: true, pinned: true });
    return;
  }

  // Commands are implemented only as harmless fixture acknowledgements.
  if ((reqPath === '/stop' || reqPath === '/resume' || reqPath.match(/^\/jobs\/[^/]+\/cancel$/)) && req.method === 'POST') {
    await readBody(req);
    json(res, 200, { ok: true, fixture: true });
    return;
  }

  json(res, 404, { error: `Nieobsługiwany fixture endpoint: ${req.method} ${reqPath}` });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
}

function createFixtureServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/stop' || url.pathname === '/resume' || url.pathname.startsWith('/jobs/')) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        noContent(res);
        return;
      }

      let relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!relative) relative = 'index.html';
      const filePath = path.resolve(appRoot, relative);
      const appPrefix = `${appRoot}${path.sep}`;
      if (filePath !== appRoot && !filePath.startsWith(appPrefix)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
  return server;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.FULLMAG_RUNNER_SMOKE_PORT || 0);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  assert(fs.existsSync(appRoot), `Runner Console source not found: ${appRoot}`);
  assert(fs.existsSync(chromiumExecutable), `Chromium executable not found: ${chromiumExecutable}`);

  const server = createFixtureServer();
  let browser;
  let page;
  const pageErrors = [];
  const consoleErrors = [];
  const dialogMessages = [];
  let screenshotWritten = false;

  try {
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumExecutable,
      args: ['--no-sandbox'],
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => pageErrors.push({ message: error.message, stack: error.stack }));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('dialog', async dialog => {
      dialogMessages.push(dialog.message());
      await dialog.accept();
    });

    async function gotoView(view) {
      await page.goto(`${baseUrl}/?smoke_view=${view}-${Date.now()}#${view}`, { waitUntil: 'domcontentloaded' });
      await page.locator(`#main-content .${view}-view`).waitFor({ state: 'visible', timeout: 5000 });
      await wait(150);
      const autoButton = page.locator('#btn-toggle-autorefresh');
      const modalVisible = await page.locator('.modal-backdrop').isVisible().catch(() => false);
      if (!modalVisible && await autoButton.count() && (await autoButton.innerText()).includes('Auto')) {
        await autoButton.click();
      }
    }

    async function clickView(view) {
      const button = page.locator(`.nav-btn[data-view="${view}"]`);
      await button.click();
      await page.waitForFunction(expected => window.location.hash === `#${expected}`, view);
      await page.locator(`#main-content .${view}-view`).waitFor({ state: 'visible', timeout: 5000 });
      await wait(150);
    }

    async function textOf(selector) {
      return (await page.locator(selector).innerText()).trim();
    }

    console.log(`[browser-smoke] fixture server: ${baseUrl}`);
    console.log(`[browser-smoke] chromium: ${chromiumExecutable}`);

    mockMode = 'healthy';
    await gotoView('overview');
    await page.locator('.overview-view .view-title').waitFor();
    assert.match(await textOf('.overview-view .view-title'), /Przegląd operacyjny/);
    assert.match(await textOf('#topbar-container'), /Fullmag Build Runner/);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    screenshotWritten = true;

    const views = ['overview', 'queue', 'history', 'storage', 'processes', 'logs', 'policies', 'diagnostics'];
    for (const view of views.slice(1)) {
      await clickView(view);
      assert(await page.locator(`#main-content .${view}-view`).count() === 1, `view did not render: ${view}`);
    }
    console.log(`[browser-smoke] healthy navigation: ${views.length}/8 views`);

    mockMode = 'preview_only';
    await gotoView('storage');
    await page.locator('#btn-create-plan').click();
    await page.locator('#retention-plan-section').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await textOf('#retention-plan-section'), /Podgląd planu retencji/);
    assert.match(await textOf('#retention-plan-section'), /plan-browser-smoke-preview/);
    await page.locator('#btn-apply-plan').click();
    await wait(150);
    assert(dialogMessages.some(message => message.includes('Tryb podglądu')), 'preview-only apply did not show the safety notice');
    console.log('[browser-smoke] preview_only: plan preview and guarded apply exercised');

    mockMode = 'unavailable';
    await gotoView('storage');
    await page.locator('#volumes-table-container .error-box').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#resources-table-container .error-box').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await textOf('#volumes-table-container'), /Koordynator|Błąd/);
    console.log('[browser-smoke] unavailable: storage error state rendered');

    mockMode = 'unauthorized';
    await gotoView('overview');
    await page.locator('#auth-token-input').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await textOf('#modal-container'), /Połącz z runnerem/);
    mockMode = 'healthy';
    await page.locator('#auth-token-input').fill('browser-smoke-token');
    await page.locator('#btn-auth-submit').click();
    await page.locator('#auth-token-input').waitFor({ state: 'detached', timeout: 5000 });
    console.log('[browser-smoke] auth/error: 401 modal and recovery exercised');

    await wait(100);
    assert.equal(pageErrors.length, 0, `browser page errors:\n${pageErrors.map(error => `${error.message}\n${error.stack || ''}`).join('\n')}`);
    console.log(`[browser-smoke] page errors: 0; console errors: ${consoleErrors.length}`);
    console.log(`[browser-smoke] fixture requests: ${requestLog.length}`);
    console.log(`[browser-smoke] screenshot: ${screenshotWritten ? screenshotPath : 'not written'}`);
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }
}

run().catch(error => {
  console.error(`[browser-smoke] FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
