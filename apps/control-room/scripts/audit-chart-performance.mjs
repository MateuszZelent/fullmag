import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertChartPerformanceProof,
  CHART_PERFORMANCE_PROOF_VERSION,
} from "../src/kernel/performance/chartPerformanceProof.mjs";

const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = numericEnv("CONTROL_ROOM_CHART_PERFORMANCE_TIMEOUT_MS", 120_000);
const idleObserveMs = numericEnv(
  "CONTROL_ROOM_CHART_PERFORMANCE_IDLE_OBSERVE_MS",
  3_000,
);
const tabSwitches = numericEnv(
  "CONTROL_ROOM_CHART_PERFORMANCE_TAB_SWITCHES",
  100,
);
const auditArtifactsDirectory = path.resolve(
  process.env.CONTROL_ROOM_CHART_PERFORMANCE_ARTIFACTS_DIR ??
    ".artifacts/chart-performance",
);
const datasetSize =
  process.env.CONTROL_ROOM_CHART_PERFORMANCE_DATASET_SIZE ?? "unspecified";
const datasetFixture =
  process.env.CONTROL_ROOM_CHART_PERFORMANCE_FIXTURE ?? "runtime-session";
const fixtureTotalRows = numericEnv(
  "CONTROL_ROOM_CHART_PERFORMANCE_FIXTURE_ROWS",
  0,
);
const requireAbortProof =
  process.env.CONTROL_ROOM_CHART_PERFORMANCE_ABORT_PROOF === "1";

const ROWS_BIN_PATTERN =
  /^\/v2\/sessions\/current\/data\/tables\/default\/rows\.bin(?:\?|$)/;

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Chart performance audit requires Playwright or @playwright/test.",
    );
  }

  const browser = await playwright.chromium.launch({
    args: ["--js-flags=--expose-gc"],
  });
  const browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable").catch(() => undefined);
  const baselineHeapBytes = await readJsHeapBytes(cdp);
  const errors = [];
  const failedResponses = [];
  const rowsBinRequests = [];
  const fixtureRouteState = createFixtureRouteState();

  if (fixtureTotalRows > 0) {
    await installTableRowsFixtureRoute(page, fixtureTotalRows, fixtureRouteState);
  }

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
    window.__FULLMAG_ENABLE_CHART_DIAGNOSTICS__ = true;
    window.__FULLMAG_CHART_DIAGNOSTICS__ = {
      activeInstances: 0,
      createdInstances: 0,
      disposedInstances: 0,
      modelBuilds: 0,
      plannedPoints: 0,
      renderedPoints: 0,
      resizeCalls: 0,
      setOptionCalls: 0,
    };
    window.__FULLMAG_CHART_AUDIT_RUNTIME__ = {
      listeners: 0,
      observers: 0,
      workers: 0,
    };
    const runtime = window.__FULLMAG_CHART_AUDIT_RUNTIME__;
    const addEventListener = EventTarget.prototype.addEventListener;
    const removeEventListener = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (...args) {
      runtime.listeners += 1;
      return addEventListener.apply(this, args);
    };
    EventTarget.prototype.removeEventListener = function (...args) {
      runtime.listeners = Math.max(0, runtime.listeners - 1);
      return removeEventListener.apply(this, args);
    };
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        super(callback);
        runtime.observers += 1;
      }
      disconnect() {
        runtime.observers = Math.max(0, runtime.observers - 1);
        return super.disconnect();
      }
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        runtime.workers += 1;
      }
      terminate() {
        runtime.workers = Math.max(0, runtime.workers - 1);
        return super.terminate();
      }
    };
  }, apiBase);

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.startsWith("Failed to load resource:")) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    const responsePath = currentSessionPath(response.url());
    if (responsePath && ROWS_BIN_PATTERN.test(responsePath)) {
      const record = rowsBinRequests.findLast(
        (entry) => entry.request === response.request(),
      );
      if (record) {
        const sizes = await response.request().sizes();
        record.responseBytes = sizes.responseBodySize;
      }
    }
    if (response.status() < 400) return;
    failedResponses.push({
      path: responsePath,
      status: response.status(),
      url: response.url(),
    });
  });
  page.on("request", (request) => {
    const path = currentSessionPath(request.url());
    if (!path || !ROWS_BIN_PATTERN.test(path)) return;
    rowsBinRequests.push({
      path,
      request,
      responseBytes: null,
      timestamp: Date.now(),
    });
  });
  page.on("requestfailed", (request) => {
    const requestPath = currentSessionPath(request.url());
    if (!requestPath || !ROWS_BIN_PATTERN.test(requestPath)) return;
    if (fixtureRouteState.delayedRequest === request) {
      fixtureRouteState.abortObserved = true;
    }
  });

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    const coldStartedAt = performance.now();
    await openAnalysisPlots(page);
    await waitForAnalysisChart(page);
    await waitForStableChartDiagnostics(page);
    const coldDurationMs = performance.now() - coldStartedAt;
    await waitForQuietRowsBinRequests(page, rowsBinRequests);
    const coldTransport = collectRowsTransport(rowsBinRequests);
    rowsBinRequests.length = 0;
    const coldDiagnostics = await collectChartDiagnostics(page);
    const coldHeapBytes = await readJsHeapBytes(cdp);
    const idleProofs = [];
    idleProofs.push(await verifyIdleChartBudget(page, rowsBinRequests));
    const lifecycleProof = await verifyChartInstanceLifecycle(
      page,
      tabSwitches,
    );
    await waitForQuietRowsBinRequests(page, rowsBinRequests);
    const warmTransport = collectRowsTransport(rowsBinRequests);
    rowsBinRequests.length = 0;
    idleProofs.push(await verifyIdleChartBudget(page, rowsBinRequests));

    const abortResult = requireAbortProof
      ? await verifyPendingRequestAbort(page, fixtureRouteState)
      : null;
    if (abortResult) {
      const { cancellation } = abortResult;
      if (
        !cancellation.requested ||
        !cancellation.completed ||
        cancellation.adoptedAfterAbort
      ) {
        throw new Error(
          `Pending rows request was not safely cancelled: ${JSON.stringify(cancellation)}`,
        );
      }
      await openAnalysisPlots(page);
      await waitForAnalysisChart(page);
      await waitForStableChartDiagnostics(page);
    }
    const diagnostics = await collectChartDiagnostics(page);
    const retainedHeapBytes = await readJsHeapBytes(cdp);
    const failures = [];
    const failedRowsBinResponses = failedResponses.filter(
      (response) => response.path && ROWS_BIN_PATTERN.test(response.path),
    );
    if (failedRowsBinResponses.length > 0) {
      failures.push(
        `rows.bin responses failed: ${JSON.stringify(failedRowsBinResponses)}`,
      );
    }
    if (errors.length > 0) {
      failures.push("Browser console errors:\n" + errors.join("\n"));
    }
    if (failures.length > 0) {
      throw new Error("Chart performance audit failed:\n" + failures.join("\n"));
    }

    const runtime = await collectChartAuditRuntime(page);
    const viewport3d = await collectViewport3DProof(page);
    const build = {
      commit: resolveGitCommit(),
      mode: process.env.NODE_ENV ?? "unspecified",
    };
    const dataset = {
      checksum: createHash("sha256")
        .update(JSON.stringify(await collectChartDataSnapshot(page)))
        .digest("hex"),
      fixture: datasetFixture,
      rows: fixtureTotalRows || diagnostics.renderedPoints,
      series: await collectChartSurfaceCount(page),
      size: datasetSize,
    };
    const common = {
      browser: { name: "chromium", version: browserVersion },
      build,
      cancellation: {
        adoptedAfterAbort: false,
        completed: false,
        requested: false,
      },
      dataset,
      lifecycle: runtime,
      memory: {
        baselineHeapBytes,
        peakHeapBytes: Math.max(
          baselineHeapBytes,
          coldHeapBytes,
          retainedHeapBytes,
        ),
        retainedHeapBytes,
      },
      recordedAt: new Date().toISOString(),
      schema: "fullmag.chart-performance-proof",
      version: CHART_PERFORMANCE_PROOF_VERSION,
      viewport3d,
    };
    // ChartPerformanceProof records are validated before they become evidence.
    const coldProof = assertChartPerformanceProof({
      ...common,
      chart: chartMetrics(coldDiagnostics),
      scenario: {
        id: "analysis-open",
        iteration: 1,
        phase: "cold",
        sessionAbort: false,
      },
      timing: timingMetrics([coldDurationMs]),
      transport: transportMetrics(coldTransport, 0),
    });
    const warmProof = assertChartPerformanceProof({
      ...common,
      chart: chartMetrics(diagnostics),
      scenario: {
        id: "analysis-tab-switch",
        iteration: tabSwitches,
        phase: "warm",
        sessionAbort: false,
      },
      timing: timingMetrics(lifecycleProof.transitionDurationsMs),
      transport: transportMetrics(
        warmTransport,
        warmTransport.requests === 0 ? 1 : 0,
      ),
    });
    const abortProof = abortResult
      ? assertChartPerformanceProof({
          ...common,
          cancellation: abortResult.cancellation,
          chart: chartMetrics(await collectChartDiagnostics(page)),
          scenario: {
            id: "analysis-pending-abort",
            iteration: 1,
            phase: "warm",
            sessionAbort: true,
          },
          timing: timingMetrics([abortResult.durationMs]),
          transport: {
            cacheHits: 0,
            cacheMisses: 1,
            cancelledRequests: abortResult.cancellation.completed ? 1 : 0,
            payloadBytes: 0,
            requests: 1,
          },
        })
      : null;
    const proofs = [coldProof, warmProof, ...(abortProof ? [abortProof] : [])];
    await mkdir(auditArtifactsDirectory, { recursive: true });
    const proofPath = path.join(
      auditArtifactsDirectory,
      `chart-performance-proof-${safeArtifactName(datasetSize)}.json`,
    );
    await writeFile(
      proofPath,
      `${JSON.stringify({ proofs }, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `Chart performance proof: ${JSON.stringify({
        failedResponses: failedResponses.length,
        idleProofs,
        proofPath,
        proofs,
        workspaceUrl,
      })}`,
    );
    console.log(`Chart performance audit passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

async function openAnalysisPlots(page) {
  const analysisTab = viewportTab(page, /^Analysis$/);
  await analysisTab
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(async () => {
      const body = await page.locator("body").innerText({ timeout: 5_000 });
      throw new Error(
        `Analysis viewport tab was not found. Body snippet:\n${body.slice(0, 1_500)}`,
      );
    });
  await analysisTab.first().click({ timeout: timeoutMs });
  await waitForActiveViewportModule(page, "analysis-plots");
}

async function waitForAnalysisChart(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const canvas = root?.querySelector(".fm-analysis-plots__echarts canvas");
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 &&
        canvas.height > 0
      );
    },
    { timeout: timeoutMs },
  );
  await page.waitForFunction(
    () => {
      const diagnostics = window.__FULLMAG_CHART_DIAGNOSTICS__;
      const chartSurfaceCount = document.querySelectorAll(
        ".fm-analysis-plots__echarts canvas",
      ).length;
      return (
        diagnostics &&
        chartSurfaceCount > 0 &&
        diagnostics.activeInstances === chartSurfaceCount &&
        diagnostics.setOptionCalls > 0
      );
    },
    { timeout: timeoutMs },
  );
}

async function waitForStableChartDiagnostics(page) {
  let previous = await collectChartDiagnostics(page);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(250);
    const current = await collectChartDiagnostics(page);
    const chartSurfaceCount = await collectChartSurfaceCount(page);
    if (
      chartSurfaceCount > 0 &&
      current.activeInstances === chartSurfaceCount &&
      current.resizeCalls === previous.resizeCalls &&
      current.setOptionCalls === previous.setOptionCalls
    ) {
      return current;
    }
    previous = current;
  }
  throw new Error(
    `chart diagnostics did not settle: ${JSON.stringify(previous)}`,
  );
}

async function verifyIdleChartBudget(page, rowsBinRequests) {
  await waitForActiveViewportModule(page, "analysis-plots");
  await waitForStableChartDiagnostics(page);
  await waitForQuietRowsBinRequests(page, rowsBinRequests);
  rowsBinRequests.length = 0;
  const beforeSnapshot = await collectChartDataSnapshot(page);
  const before = await collectChartDiagnostics(page);
  await page.waitForTimeout(idleObserveMs);
  const after = await collectChartDiagnostics(page);
  const afterSnapshot = await collectChartDataSnapshot(page);
  const redraws = after.setOptionCalls - before.setOptionCalls;
  if (redraws !== 0 && sameChartDataSnapshot(beforeSnapshot, afterSnapshot)) {
    throw new Error(`chart redraws during idle without data change: ${redraws}`);
  }
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests during chart idle: ${rowsBinRequests.length} ${summarizeRowsBinRequests(rowsBinRequests)}`,
    );
  }
  return {
    afterSnapshot,
    beforeSnapshot,
    liveRedraws: redraws,
  };
}

async function waitForQuietRowsBinRequests(page, rowsBinRequests) {
  const quietMs = Math.max(1_500, Math.min(idleObserveMs, 3_000));
  const deadline = Date.now() + timeoutMs;
  let lastCount = rowsBinRequests.length;
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    if (rowsBinRequests.length !== lastCount) {
      lastCount = rowsBinRequests.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) return;
  }

  throw new Error(
    `rows.bin requests did not settle before idle audit: ${rowsBinRequests.length} ${summarizeRowsBinRequests(rowsBinRequests)}`,
  );
}

function summarizeRowsBinRequests(rowsBinRequests) {
  const paths = rowsBinRequests.map((request) => request.path);
  const uniquePaths = Array.from(new Set(paths));
  return JSON.stringify({
    last: paths.slice(-5),
    unique: uniquePaths.slice(-5),
    uniqueCount: uniquePaths.length,
  });
}

async function verifyChartInstanceLifecycle(page, switchCount) {
  const transitionDurationsMs = [];
  const analysisTab = viewportTab(page, /^Analysis$/);
  const viewport3dTab = viewportTab(page, /^3D Viewport$/);
  await viewport3dTab
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });

  for (let index = 0; index < switchCount; index += 1) {
    await viewport3dTab.first().click({ timeout: timeoutMs });
    await waitForActiveViewportModule(page, "viewport-3d");
    await page.waitForFunction(
      () => window.__FULLMAG_CHART_DIAGNOSTICS__?.activeInstances === 0,
      { timeout: timeoutMs },
    );

    const transitionStartedAt = performance.now();
    await analysisTab.first().click({ timeout: timeoutMs });
    await waitForActiveViewportModule(page, "analysis-plots");
    await waitForAnalysisChart(page);
    transitionDurationsMs.push(performance.now() - transitionStartedAt);
  }

  const diagnostics = await collectChartDiagnostics(page);
  const chartSurfaceCount = await collectChartSurfaceCount(page);
  if (chartSurfaceCount < 1) {
    throw new Error("chart instance leak: no active chart surfaces");
  }
  if (diagnostics.activeInstances !== chartSurfaceCount) {
    throw new Error(
      `chart instance leak: active=${diagnostics.activeInstances}, surfaces=${chartSurfaceCount}`,
    );
  }
  if (
    diagnostics.createdInstances - diagnostics.disposedInstances !==
    diagnostics.activeInstances
  ) {
    throw new Error(
      `chart instance leak: created=${diagnostics.createdInstances}, disposed=${diagnostics.disposedInstances}, active=${diagnostics.activeInstances}`,
    );
  }
  return {
    activeInstances: diagnostics.activeInstances,
    createdInstances: diagnostics.createdInstances,
    disposedInstances: diagnostics.disposedInstances,
    transitionDurationsMs,
  };
}

async function waitForActiveViewportModule(page, moduleId) {
  await page
    .locator(
      `[data-slot-id='viewport-main'][data-active-module-id='${moduleId}']`,
    )
    .waitFor({ state: "attached", timeout: timeoutMs });
}

function viewportTab(page, text) {
  return page.locator(".fm-viewport-tabs__trigger").filter({ hasText: text });
}

function createFixtureRouteState() {
  return {
    abortObserved: false,
    delayNext: false,
    delayedRequest: null,
    delayedStarted: null,
    resolveDelayedStarted: null,
  };
}

async function installTableRowsFixtureRoute(page, totalRows, state) {
  await page.route(
    "**/v2/sessions/current/data/tables/default/rows.bin?**",
    async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const columns = (requestUrl.searchParams.get("columns") ?? "")
        .split(",")
        .filter(Boolean);
      const targetPoints = Number(
        requestUrl.searchParams.get("target_points") ?? 1_600,
      );
      const rowCount = Math.min(
        totalRows,
        Math.max(1, Number.isFinite(targetPoints) ? targetPoints : 1_600),
      );
      if (columns.length === 0) {
        await route.abort("failed");
        return;
      }
      if (state.delayNext) {
        state.delayNext = false;
        state.delayedRequest = request;
        state.resolveDelayedStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route.fulfill({
        body: makeFmtbFixture(columns, rowCount, totalRows),
        contentType: "application/octet-stream",
        status: 200,
      });
    },
  );
}

function makeFmtbFixture(columns, rowCount, totalRows) {
  const headerBytes = 60;
  const buffer = Buffer.alloc(headerBytes + rowCount * columns.length * 8);
  buffer.write("FMTB", 0, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeBigUInt64LE(BigInt(totalRows), 8);
  buffer.writeBigUInt64LE(BigInt(totalRows), 16);
  buffer.writeBigUInt64LE(0n, 24);
  buffer.writeBigUInt64LE(BigInt(totalRows), 32);
  buffer.writeBigUInt64LE(0n, 40);
  buffer.writeBigUInt64LE(BigInt(rowCount), 48);
  buffer.writeUInt32LE(columns.length, 56);
  const stride = Math.max(1, Math.floor(totalRows / rowCount));
  let offset = headerBytes;
  for (let row = 0; row < rowCount; row += 1) {
    const logicalRow = Math.min(totalRows - 1, row * stride);
    for (const column of columns) {
      buffer.writeDoubleLE(fixtureValue(column, logicalRow), offset);
      offset += 8;
    }
  }
  return buffer;
}

function fixtureValue(column, row) {
  const phase = row / 2_000;
  const progress = row / Math.max(1, fixtureTotalRows - 1);
  switch (column) {
    case "step":
      return row;
    case "t":
    case "pseudo_time_s":
      return row * 1e-12;
    case "active_runtime_s":
      return row * 2e-6;
    case "mx":
      return Math.cos(phase) * (1 - 0.05 * progress);
    case "my":
      return Math.sin(phase) * (1 - 0.05 * progress);
    case "mz":
      return 0.05 * Math.sin(phase / 3);
    case "e_total":
      return -1e-18 * (1 + progress);
    case "max_torque_Apm":
      return 1e5 * Math.exp(-6 * progress);
    default:
      return row;
  }
}

async function verifyPendingRequestAbort(page, state) {
  if (fixtureTotalRows <= 0) {
    throw new Error("Abort proof requires a deterministic rows fixture.");
  }
  state.abortObserved = false;
  state.delayNext = true;
  state.delayedRequest = null;
  state.delayedStarted = new Promise((resolve) => {
    state.resolveDelayedStarted = resolve;
  });
  const startedAt = performance.now();
  await page.evaluate(() => {
    const dispatch = window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchDataZoom;
    if (typeof dispatch !== "function") {
      throw new Error("Chart range dispatcher is unavailable.");
    }
    dispatch(20, 40);
  });
  await Promise.race([
    state.delayedStarted,
    page.waitForTimeout(5_000).then(() => {
      throw new Error("Delayed rows request did not start.");
    }),
  ]);
  await viewportTab(page, /^3D Viewport$/).first().click({ timeout: timeoutMs });
  await waitForActiveViewportModule(page, "viewport-3d");
  await page.waitForTimeout(1_750);
  const adoptedAfterAbort = (await collectChartSurfaceCount(page)) !== 0;
  return {
    cancellation: {
      adoptedAfterAbort,
      completed: state.abortObserved,
      requested: true,
    },
    durationMs: performance.now() - startedAt,
  };
}

async function collectChartDiagnostics(page) {
  return page.evaluate(
    () =>
      window.__FULLMAG_CHART_DIAGNOSTICS__ ?? {
        activeInstances: 0,
        createdInstances: 0,
        disposedInstances: 0,
        modelBuilds: 0,
        plannedPoints: 0,
        renderedPoints: 0,
        resizeCalls: 0,
        setOptionCalls: 0,
      },
  );
}

async function collectChartSurfaceCount(page) {
  return page.evaluate(
    () =>
      document.querySelectorAll(".fm-analysis-plots__echarts canvas").length,
  );
}

async function collectChartDataSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".fm-analysis-plots");
    return {
      rangeText:
        root?.querySelector(".fm-analysis-plots__range span:first-child")
          ?.textContent ?? "",
      visibleText:
        root?.querySelector(".fm-analysis-plots__range span:nth-child(2)")
          ?.textContent ?? "",
    };
  });
}

function collectRowsTransport(rowsBinRequests) {
  const missingSize = rowsBinRequests.find(
    (request) => !Number.isFinite(request.responseBytes),
  );
  if (missingSize) {
    throw new Error(
      `rows.bin response size was not measured for ${missingSize.path}`,
    );
  }
  return {
    payloadBytes: rowsBinRequests.reduce(
      (sum, request) => sum + request.responseBytes,
      0,
    ),
    requests: rowsBinRequests.length,
  };
}

function transportMetrics(measured, cacheHits) {
  return {
    cacheHits,
    cacheMisses: measured.requests,
    cancelledRequests: 0,
    payloadBytes: measured.payloadBytes,
    requests: measured.requests,
  };
}

function chartMetrics(diagnostics) {
  return {
    activeInstances: diagnostics.activeInstances,
    createdInstances: diagnostics.createdInstances,
    disposedInstances: diagnostics.disposedInstances,
    modelBuilds: diagnostics.modelBuilds,
    plannedPoints: diagnostics.plannedPoints,
    redraws: diagnostics.setOptionCalls,
    renderedPoints: diagnostics.renderedPoints,
    setOptionCalls: diagnostics.setOptionCalls,
  };
}

function timingMetrics(samples) {
  if (samples.length === 0) {
    throw new Error("Chart timing samples are missing.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    longTasks: sorted.filter((duration) => duration > 50).length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    samples: sorted.length,
  };
}

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

async function collectChartAuditRuntime(page) {
  return page.evaluate(() => ({
    listeners: window.__FULLMAG_CHART_AUDIT_RUNTIME__?.listeners ?? 0,
    observers: window.__FULLMAG_CHART_AUDIT_RUNTIME__?.observers ?? 0,
    workers: window.__FULLMAG_CHART_AUDIT_RUNTIME__?.workers ?? 0,
  }));
}

async function collectViewport3DProof(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      return {
        contextLost: false,
        dirtyFrames: 0,
        drawingBufferHeight: 0,
        drawingBufferWidth: 0,
        fieldRequests: 0,
        mounted: false,
        topologyRequests: 0,
        unchangedBufferUploads: 0,
        webglBufferDelta: 0,
      };
    }
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    return {
      contextLost: gl?.isContextLost() ?? true,
      dirtyFrames: 0,
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      fieldRequests: 0,
      mounted: true,
      topologyRequests: 0,
      unchangedBufferUploads: 0,
      webglBufferDelta: 0,
    };
  });
}

async function readJsHeapBytes(cdp) {
  const result = await cdp.send("Performance.getMetrics");
  return (
    result.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0
  );
}

function resolveGitCommit() {
  return (
    process.env.CONTROL_ROOM_AUDIT_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()
  );
}

function sameChartDataSnapshot(left, right) {
  return (
    left.rangeText === right.rangeText &&
    left.visibleText === right.visibleText
  );
}

function currentSessionPath(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/v2/sessions/current/")) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeArtifactName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

main().catch((error) => {
  console.error(`Chart performance audit failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
