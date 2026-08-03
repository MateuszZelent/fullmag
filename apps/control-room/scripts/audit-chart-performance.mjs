import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const maxRetainedHeapGrowthBytes = numericEnv(
  "CONTROL_ROOM_CHART_PERFORMANCE_MAX_RETAINED_HEAP_GROWTH_BYTES",
  64 * 1024 * 1024,
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
const fixtureMode = fixtureTotalRows > 0;
const requireAbortProof =
  fixtureMode || process.env.CONTROL_ROOM_CHART_PERFORMANCE_ABORT_PROOF === "1";

const ROWS_BIN_PATTERN =
  /^\/v2\/sessions\/current\/data\/tables\/[^/]+\/rows\.bin(?:\?|$)/;
const VIEWPORT_UPLOAD_MEASURE_NAMES = [
  "fullmag.viewport3d.uploadVectorGlyphColors",
  "fullmag.viewport3d.uploadVectorGlyphMatrices",
];

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
  const sessionRequests = [];
  const fixtureRouteState = createFixtureRouteState();

  if (fixtureMode) {
    await installChartPerformanceFixtureRoutes(
      page,
      fixtureTotalRows,
      fixtureRouteState,
    );
  }

  await page.addInitScript(({ baseUrl, fixtureMode, uploadMeasureNames }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
      disableRealtime: fixtureMode,
      enableDiagnosticRecorder: true,
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
      animationFrameCallbacks: 0,
      animationFrames: 0,
      createdObjectUrls: 0,
      intervals: 0,
      listeners: 0,
      mutationObservers: 0,
      objectUrls: 0,
      resizeObservers: 0,
      revokedObjectUrls: 0,
      viewportUploads: 0,
      workers: 0,
    };
    const runtime = window.__FULLMAG_CHART_AUDIT_RUNTIME__;
    const addEventListener = EventTarget.prototype.addEventListener;
    const removeEventListener = EventTarget.prototype.removeEventListener;
    const __fullmagAuditListenerRegistry = new WeakMap();
    const normalizeListenerCapture = (options) =>
      typeof options === "boolean" ? options : options?.capture === true;
    const listenerBucket = (target, type, capture, create) => {
      let targetRegistry = __fullmagAuditListenerRegistry.get(target);
      if (!targetRegistry && create) {
        targetRegistry = new Map();
        __fullmagAuditListenerRegistry.set(target, targetRegistry);
      }
      if (!targetRegistry) return null;
      const key = `${type}\u0000${capture ? "capture" : "bubble"}`;
      let bucket = targetRegistry.get(key);
      if (!bucket && create) {
        bucket = new Map();
        targetRegistry.set(key, bucket);
      }
      return bucket ?? null;
    };
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (listener === null || listener === undefined) {
        return addEventListener.call(this, type, listener, options);
      }
      const capture = normalizeListenerCapture(options);
      const bucket = listenerBucket(this, type, capture, true);
      if (bucket.has(listener)) return;
      const once = typeof options === "object" && options?.once === true;
      const signal = typeof options === "object" ? options?.signal : undefined;
      if (signal?.aborted) return;
      const entry = { abortCleanup: null, wrapped: null };
      const unregister = () => {
        if (!bucket.delete(listener)) return;
        runtime.listeners = Math.max(0, runtime.listeners - 1);
        entry.abortCleanup?.();
      };
      entry.wrapped = function (event) {
        if (once) {
          removeEventListener.call(this, type, entry.wrapped, capture);
          unregister();
        }
        if (typeof listener === "function") {
          return listener.call(this, event);
        }
        return listener.handleEvent?.call(listener, event);
      };
      if (signal) {
        const abortHandler = () => {
          removeEventListener.call(this, type, entry.wrapped, capture);
          unregister();
        };
        addEventListener.call(signal, "abort", abortHandler, { once: true });
        entry.abortCleanup = () =>
          removeEventListener.call(signal, "abort", abortHandler, false);
      }
      bucket.set(listener, entry);
      runtime.listeners += 1;
      const nativeOptions =
        typeof options === "object" && options !== null
          ? { ...options, once: false, signal: undefined }
          : options;
      return addEventListener.call(this, type, entry.wrapped, nativeOptions);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      const capture = normalizeListenerCapture(options);
      const bucket = listenerBucket(this, type, capture, false);
      const entry = bucket?.get(listener);
      if (!entry) {
        return removeEventListener.call(this, type, listener, options);
      }
      bucket.delete(listener);
      runtime.listeners = Math.max(0, runtime.listeners - 1);
      entry.abortCleanup?.();
      return removeEventListener.call(this, type, entry.wrapped, capture);
    };
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        super(callback);
        this.__fullmagAuditActive = false;
        this.__fullmagAuditTargets = new Set();
      }
      observe(target, options) {
        if (!this.__fullmagAuditTargets.has(target)) {
          if (this.__fullmagAuditTargets.size === 0) {
            this.__fullmagAuditActive = true;
            runtime.resizeObservers += 1;
          }
          this.__fullmagAuditTargets.add(target);
        }
        return super.observe(target, options);
      }
      unobserve(target) {
        this.__fullmagAuditTargets.delete(target);
        if (this.__fullmagAuditTargets.size === 0) {
          this.__fullmagAuditDeactivate();
        }
        return super.unobserve(target);
      }
      disconnect() {
        this.__fullmagAuditTargets.clear();
        this.__fullmagAuditDeactivate();
        return super.disconnect();
      }
      __fullmagAuditDeactivate() {
        if (this.__fullmagAuditActive) {
          this.__fullmagAuditActive = false;
          runtime.resizeObservers = Math.max(0, runtime.resizeObservers - 1);
        }
      }
    };
    const NativeMutationObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeMutationObserver {
      constructor(callback) {
        super(callback);
        this.__fullmagAuditActive = true;
        runtime.mutationObservers += 1;
      }
      disconnect() {
        if (this.__fullmagAuditActive) {
          this.__fullmagAuditActive = false;
          runtime.mutationObservers = Math.max(
            0,
            runtime.mutationObservers - 1,
          );
        }
        return super.disconnect();
      }
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.__fullmagAuditActive = true;
        runtime.workers += 1;
      }
      terminate() {
        if (this.__fullmagAuditActive) {
          this.__fullmagAuditActive = false;
          runtime.workers = Math.max(0, runtime.workers - 1);
        }
        return super.terminate();
      }
    };
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const activeObjectUrls = new Set();
    URL.createObjectURL = (...args) => {
      const value = nativeCreateObjectURL(...args);
      activeObjectUrls.add(value);
      runtime.createdObjectUrls += 1;
      runtime.objectUrls = activeObjectUrls.size;
      return value;
    };
    URL.revokeObjectURL = (value) => {
      if (activeObjectUrls.delete(value)) {
        runtime.revokedObjectUrls += 1;
      }
      runtime.objectUrls = activeObjectUrls.size;
      return nativeRevokeObjectURL(value);
    };
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    const activeAnimationFrames = new Set();
    window.requestAnimationFrame = (callback) => {
      let handle = 0;
      handle = nativeRequestAnimationFrame((timestamp) => {
        activeAnimationFrames.delete(handle);
        runtime.animationFrames = activeAnimationFrames.size;
        runtime.animationFrameCallbacks += 1;
        callback(timestamp);
      });
      activeAnimationFrames.add(handle);
      runtime.animationFrames = activeAnimationFrames.size;
      return handle;
    };
    window.cancelAnimationFrame = (handle) => {
      activeAnimationFrames.delete(handle);
      runtime.animationFrames = activeAnimationFrames.size;
      return nativeCancelAnimationFrame(handle);
    };
    const intervalSchedulerKey = "set" + "Interval";
    const nativeIntervalScheduler = window[intervalSchedulerKey].bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const activeIntervals = new Set();
    window[intervalSchedulerKey] = (...args) => {
      const handle = nativeIntervalScheduler(...args);
      activeIntervals.add(handle);
      runtime.intervals = activeIntervals.size;
      return handle;
    };
    window.clearInterval = (handle) => {
      activeIntervals.delete(handle);
      runtime.intervals = activeIntervals.size;
      return nativeClearInterval(handle);
    };
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("measure")
    ) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (uploadMeasureNames.includes(entry.name)) {
            runtime.viewportUploads += 1;
          }
        }
      });
      observer.observe({ type: "measure" });
    }
    window.__FULLMAG_READ_CHART_AUDIT_VIEWPORT__ = () => {
      const viewport = document.querySelector(".fm-viewport-3d");
      const spans = Array.from(
        document.querySelectorAll(".fm-viewport-3d__hud span"),
      );
      const raw =
        spans.find((span) => span.textContent?.includes("frames:"))
          ?.textContent ?? "";
      const frames = Number(raw.match(/(?:^|\s)frames:([^\s]+)/)?.[1] ?? 0);
      const geometries = Number(raw.match(/(?:^|\s)geo:([^\s]+)/)?.[1] ?? 0);
      return {
        cameraSignature: viewport
          ? [
              viewport.getAttribute("data-camera-position") ?? "",
              viewport.getAttribute("data-camera-target") ?? "",
              viewport.getAttribute("data-camera-up") ?? "",
              viewport.getAttribute("data-camera-projection") ?? "",
            ].join("|")
          : "",
        frames: Number.isFinite(frames) ? frames : 0,
        geometries: Number.isFinite(geometries) ? geometries : 0,
        viewportUploads: runtime.viewportUploads,
      };
    };
  }, { baseUrl: apiBase, fixtureMode, uploadMeasureNames: VIEWPORT_UPLOAD_MEASURE_NAMES });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.startsWith("Failed to load resource:")) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const responsePath = currentSessionPath(response.url());
    if (response.status() < 400) return;
    failedResponses.push({
      path: responsePath,
      status: response.status(),
      url: response.url(),
    });
  });
  page.on("request", (request) => {
    const path = currentSessionPath(request.url());
    if (path) {
      sessionRequests.push({ method: request.method(), path, timestamp: Date.now() });
    }
    if (!path || !ROWS_BIN_PATTERN.test(path)) return;
    rowsBinRequests.push({
      path,
      request,
      responseBytes: null,
      timestamp: Date.now(),
    });
  });
  page.on("requestfinished", async (request) => {
    const requestPath = currentSessionPath(request.url());
    if (!requestPath || !ROWS_BIN_PATTERN.test(requestPath)) return;
    const record = findRowsBinRequest(rowsBinRequests, request);
    if (!record) return;
    const sizes = await request.sizes();
    record.responseBytes = sizes.responseBodySize;
  });
  page.on("requestfailed", (request) => {
    const requestPath = currentSessionPath(request.url());
    if (!requestPath || !ROWS_BIN_PATTERN.test(requestPath)) return;
    discardCancelledRowsBinRequest(rowsBinRequests, request);
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
    if (fixtureMode) {
      await selectExplicitAnalysisDataset(page);
    }
    await waitForAnalysisChart(page);
    await waitForStableChartDiagnostics(page);
    const coldDurationMs = performance.now() - coldStartedAt;
    await pauseAnalysisUpdates(page);
    await waitForQuietRowsBinRequests(page, rowsBinRequests);
    await waitForRowsTransportSizes(page, rowsBinRequests);
    const coldTransport = collectRowsTransport(rowsBinRequests);
    rowsBinRequests.length = 0;
    const coldDiagnostics = await collectChartDiagnostics(page);
    const coldHeapBytes = await readJsHeapBytes(cdp);
    const idleProofs = [];
    idleProofs.push(
      await verifyIdleChartBudget(page, rowsBinRequests, sessionRequests),
    );
    const lifecycleProof = await verifyChartInstanceLifecycle(
      cdp,
      page,
      tabSwitches,
    );
    await waitForQuietRowsBinRequests(page, rowsBinRequests);
    await waitForRowsTransportSizes(page, rowsBinRequests);
    const warmTransport = collectRowsTransport(rowsBinRequests);
    rowsBinRequests.length = 0;
    idleProofs.push(
      await verifyIdleChartBudget(page, rowsBinRequests, sessionRequests),
    );

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
    }
    const diagnostics = await collectChartDiagnostics(page);
    const analysisDataSnapshot = await collectChartDataSnapshot(page);
    const analysisSurfaceCount = await collectChartSurfaceCount(page);
    const quickChartProof = await verifyQuickChartViewportIsolation({
      cdp,
      page,
      sessionRequests,
      switchCount: tabSwitches,
    });
    const retainedHeapBytes = await readJsHeapBytes(cdp);
    const failures = [];
    const expectedFixtureFailures = failedResponses.filter((response) =>
      isExpectedFixtureFailure(response),
    );
    const unexpectedFailedResponses = failedResponses.filter(
      (response) => !isExpectedFixtureFailure(response),
    );
    const failedResponseSummary = summarizeFailedResponses(failedResponses);
    if (unexpectedFailedResponses.length > 0) {
      failures.push(
        "Unexpected fixture resource failures: " +
          JSON.stringify(summarizeFailedResponses(unexpectedFailedResponses)),
      );
    }
    if (errors.length > 0) {
      failures.push("Browser console errors:\n" + errors.join("\n"));
    }
    if (failures.length > 0) {
      throw new Error("Chart performance audit failed:\n" + failures.join("\n"));
    }

    const runtime = await collectChartAuditRuntime(page);
    const viewport3d = await collectViewport3DProof(
      page,
      quickChartProof.isolation,
    );
    const build = resolveBuildProvenance();
    const dataset = {
      checksum: createHash("sha256")
        .update(JSON.stringify(analysisDataSnapshot))
        .digest("hex"),
      fixture: datasetFixture,
      rows: fixtureTotalRows || diagnostics.renderedPoints,
      series: analysisSurfaceCount,
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
      transport: transportMetrics(coldTransport),
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
      transport: transportMetrics(warmTransport),
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
            cacheHits: null,
            cacheMeasurement: "NOT_MEASURED",
            cacheMisses: null,
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
      `${JSON.stringify({ lifecycleProof, proofs, quickChartProof }, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `Chart performance proof: ${JSON.stringify({
        expectedFixtureFailures: summarizeFailedResponses(
          expectedFixtureFailures,
        ),
        failedResponseSummary,
        idleProofs,
        proofPath,
        proofs,
        quickChartProof,
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

async function selectExplicitAnalysisDataset(page) {
  const trigger = page.getByRole("combobox", { name: "Analysis dataset" });
  await trigger.waitFor({ state: "visible", timeout: timeoutMs });
  await trigger.click({ timeout: timeoutMs });
  const option = page.getByRole("option").first();
  await option.waitFor({ state: "visible", timeout: timeoutMs });
  const datasetRef = (await option.innerText()).trim();
  if (!datasetRef) {
    throw new Error("Chart performance fixture dataset has an empty identity.");
  }
  await option.click({ timeout: timeoutMs });
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[aria-label="Analysis dataset"]')
        ?.textContent?.includes(expected),
    datasetRef,
    { timeout: timeoutMs },
  );
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

async function verifyIdleChartBudget(page, rowsBinRequests, sessionRequests) {
  await waitForActiveViewportModule(page, "analysis-plots");
  await waitForStableChartDiagnostics(page);
  await waitForQuietRowsBinRequests(page, rowsBinRequests);
  await waitForSessionRequestQuiet(page, sessionRequests);
  await waitForAnimationFrameQuiet(page);
  rowsBinRequests.length = 0;
  const requestStart = sessionRequests.length;
  const beforeSnapshot = await collectChartDataSnapshot(page);
  const before = await collectChartDiagnostics(page);
  const beforeLifecycle = await collectLifecycleSnapshot(page);
  await page.waitForTimeout(idleObserveMs);
  const after = await collectChartDiagnostics(page);
  const afterLifecycle = await collectLifecycleSnapshot(page);
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
  const idleRequests = sessionRequests.slice(requestStart);
  const animationFrameCallbacks =
    afterLifecycle.animationFrameCallbacks -
    beforeLifecycle.animationFrameCallbacks;
  const activeIntervalGrowth = Math.max(
    0,
    afterLifecycle.intervals - beforeLifecycle.intervals,
  );
  if (
    idleRequests.length > 0 ||
    animationFrameCallbacks > 0 ||
    afterLifecycle.animationFrames > 0 ||
    activeIntervalGrowth > 0
  ) {
    throw new Error(
      "chart performed work during settled idle: " +
        JSON.stringify({
          activeAnimationFrames: afterLifecycle.animationFrames,
          activeIntervalGrowth,
          activeIntervals: afterLifecycle.intervals,
          animationFrameCallbacks,
          requests: idleRequests,
        }),
    );
  }
  return {
    afterSnapshot,
    animationFrameCallbacks,
    beforeSnapshot,
    liveRedraws: redraws,
    requests: idleRequests.length,
  };
}

/** Analysis is dataset-driven after the Live Charts split. It must not expose
 * the former live pause/resume lifecycle or follow active-tail invalidations.
 */
async function pauseAnalysisUpdates(page) {
  const pauseButton = page.getByRole("button", {
    exact: true,
    name: "Pause chart — freeze current revision",
  });
  const resumeButton = page.getByRole("button", {
    exact: true,
    name: "Resume live chart updates",
  });
  if ((await pauseButton.count()) > 0 || (await resumeButton.count()) > 0) {
    throw new Error(
      "Analysis still exposes live pause/resume controls after dataset separation.",
    );
  }
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

async function waitForRowsTransportSizes(page, rowsBinRequests) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const missingSize = rowsBinRequests.find(
      (request) => !Number.isFinite(request.responseBytes),
    );
    if (!missingSize) return;
    await page.waitForTimeout(50);
  }
  const missingSize = rowsBinRequests.find(
    (request) => !Number.isFinite(request.responseBytes),
  );
  throw new Error(
    `rows.bin response size was not measured before transport audit: ${missingSize?.path ?? "unknown request"}`,
  );
}

function findRowsBinRequest(rowsBinRequests, request) {
  return rowsBinRequests.findLast((entry) => entry.request === request) ?? null;
}

function discardCancelledRowsBinRequest(rowsBinRequests, request) {
  const index = rowsBinRequests.findLastIndex((entry) => entry.request === request);
  if (index >= 0) rowsBinRequests.splice(index, 1);
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

async function verifyChartInstanceLifecycle(cdp, page, switchCount) {
  const transitionDurationsMs = [];
  const analysisTab = viewportTab(page, /^Analysis$/);
  const viewport3dTab = viewportTab(page, /^3D Viewport$/);
  await viewport3dTab
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });

  await viewport3dTab.first().click({ timeout: timeoutMs });
  await waitForActiveViewportModule(page, "viewport-3d");
  await page.waitForFunction(
    () => window.__FULLMAG_CHART_DIAGNOSTICS__?.activeInstances === 0,
    { timeout: timeoutMs },
  );
  await forceGarbageCollection(page, cdp);
  await waitForAnimationFrameQuiet(page);
  const analysisLifecycleBaseline = await collectLifecycleSnapshot(page);
  const baselineHeapBytes = await readJsHeapBytes(cdp);

  for (let index = 0; index < switchCount; index += 1) {
    const transitionStartedAt = performance.now();
    await analysisTab.first().click({ timeout: timeoutMs });
    await waitForActiveViewportModule(page, "analysis-plots");
    await waitForAnalysisChart(page);
    await viewport3dTab.first().click({ timeout: timeoutMs });
    await waitForActiveViewportModule(page, "viewport-3d");
    await page.waitForFunction(
      () => window.__FULLMAG_CHART_DIAGNOSTICS__?.activeInstances === 0,
      { timeout: timeoutMs },
    );
    transitionDurationsMs.push(performance.now() - transitionStartedAt);
  }

  await forceGarbageCollection(page, cdp);
  await waitForAnimationFrameQuiet(page);
  const analysisLifecycleAfterClose = await collectLifecycleSnapshot(page);
  const retainedHeapBytes = await readJsHeapBytes(cdp);
  assertBoundedLifecycle(
    analysisLifecycleBaseline,
    analysisLifecycleAfterClose,
    baselineHeapBytes,
    retainedHeapBytes,
    "Analysis",
  );

  await analysisTab.first().click({ timeout: timeoutMs });
  await waitForActiveViewportModule(page, "analysis-plots");
  await waitForAnalysisChart(page);
  await waitForStableChartDiagnostics(page);

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
    analysisLifecycleAfterClose,
    analysisLifecycleBaseline,
    createdInstances: diagnostics.createdInstances,
    disposedInstances: diagnostics.disposedInstances,
    heap: { baselineHeapBytes, retainedHeapBytes },
    transitionDurationsMs,
  };
}

async function verifyQuickChartViewportIsolation({
  cdp,
  page,
  sessionRequests,
  switchCount,
}) {
  await openAnalysisPlots(page);
  await waitForAnalysisChart(page);
  await ensureQuickChartPinned(page);
  await openViewport3D(page);
  await waitForQuickChartCanvas(page);
  await waitForSessionRequestQuiet(page, sessionRequests);

  const logsTab = footerTab(page, /^Logs$/);
  const quickChartTab = footerTab(page, /^Quick Chart$/);
  await logsTab.first().click({ timeout: timeoutMs });
  await waitForQuickChartUnmount(page);

  // One warm-up cycle pays lazy import/cache costs before the leak baseline.
  await quickChartTab.first().click({ timeout: timeoutMs });
  await waitForQuickChartCanvas(page);
  await logsTab.first().click({ timeout: timeoutMs });
  await waitForQuickChartUnmount(page);
  await forceGarbageCollection(page, cdp);
  await waitForAnimationFrameQuiet(page);

  const lifecycleBaseline = await collectLifecycleSnapshot(page);
  const baselineHeapBytes = await readJsHeapBytes(cdp);
  const requestStart = sessionRequests.length;
  let peakEchartsCanvases = lifecycleBaseline.echartsCanvases;
  const transitionDurationsMs = [];

  for (let index = 0; index < switchCount; index += 1) {
    const startedAt = performance.now();
    await quickChartTab.first().evaluate((button) => button.click());
    await waitForQuickChartCanvas(page);
    const mounted = await collectLifecycleSnapshot(page);
    peakEchartsCanvases = Math.max(
      peakEchartsCanvases,
      mounted.echartsCanvases,
    );
    await logsTab.first().evaluate((button) => button.click());
    await waitForQuickChartUnmount(page);
    transitionDurationsMs.push(performance.now() - startedAt);
  }

  await waitForSessionRequestQuiet(page, sessionRequests);
  await forceGarbageCollection(page, cdp);
  await waitForAnimationFrameQuiet(page);
  const lifecycleAfterClose = await collectLifecycleSnapshot(page);
  const retainedHeapBytes = await readJsHeapBytes(cdp);
  assertBoundedLifecycle(
    lifecycleBaseline,
    lifecycleAfterClose,
    baselineHeapBytes,
    retainedHeapBytes,
  );

  const cycleRequests = sessionRequests.slice(requestStart);
  const cycleIsolation = summarizeViewportRequests(cycleRequests);
  if (cycleIsolation.fieldRequests > 0 || cycleIsolation.topologyRequests > 0) {
    throw new Error(
      "Quick Chart + 3D isolation failed during open-close stress: " +
        JSON.stringify(cycleIsolation),
    );
  }

  await quickChartTab.first().click({ timeout: timeoutMs });
  await waitForQuickChartCanvas(page);
  await waitForSessionRequestQuiet(page, sessionRequests);
  await waitForAnimationFrameQuiet(page);
  const isolation = await verifyLocalQuickChartActionBudget(
    page,
    sessionRequests,
  );
  const lifecycleCoexisting = await collectLifecycleSnapshot(page);

  return {
    heap: {
      baselineHeapBytes,
      maxRetainedHeapGrowthBytes,
      retainedHeapBytes,
    },
    isolation: {
      ...isolation,
      fieldRequests: isolation.fieldRequests + cycleIsolation.fieldRequests,
      topologyRequests:
        isolation.topologyRequests + cycleIsolation.topologyRequests,
    },
    lifecycle: {
      afterClose: lifecycleAfterClose,
      baseline: lifecycleBaseline,
      coexisting: lifecycleCoexisting,
      peakEchartsCanvases,
    },
    scenario: {
      id: "quick-chart-open-close",
      iteration: switchCount,
      phase: "warm",
    },
    timing: timingMetrics(transitionDurationsMs),
  };
}

async function ensureQuickChartPinned(page) {
  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor({ state: "visible", timeout: timeoutMs });
  const input = palette.getByPlaceholder("Search commands");
  await input.fill("Pin Quick Chart");
  const command = palette.getByText("Pin Quick Chart", { exact: true }).first();
  await command.waitFor({ state: "visible", timeout: timeoutMs });
  await command.click({ timeout: timeoutMs });
  await page
    .locator(".fm-footer__tab")
    .filter({ hasText: /^Quick Chart$/ })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function openViewport3D(page) {
  const viewport3dTab = viewportTab(page, /^3D Viewport$/);
  await viewport3dTab.first().click({ timeout: timeoutMs });
  await waitForActiveViewportModule(page, "viewport-3d");
  await page
    .locator(".fm-viewport-3d canvas")
    .waitFor({ state: "visible", timeout: timeoutMs });
  const state = await collectViewport3DIsolationSnapshot(page);
  if (state.contextLost || state.drawingBufferWidth <= 0 || state.drawingBufferHeight <= 0) {
    throw new Error(
      `3D viewport is not healthy before Quick Chart stress: ${JSON.stringify(state)}`,
    );
  }
}

async function waitForQuickChartCanvas(page) {
  await page
    .locator(".fm-quick-chart .fm-quick-chart__canvas canvas")
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function waitForQuickChartUnmount(page) {
  await page.waitForFunction(
    () => document.querySelector(".fm-quick-chart") === null,
    { timeout: timeoutMs },
  );
}

async function verifyLocalQuickChartActionBudget(page, sessionRequests) {
  const requestStart = sessionRequests.length;
  const beforeViewport = await collectViewport3DIsolationSnapshot(page);
  const beforeLifecycle = await collectLifecycleSnapshot(page);
  const cursor = page.getByRole("application", { name: /^Quick Chart cursor/ });
  await cursor.focus();
  await cursor.press("ArrowRight");
  await page
    .locator(".fm-quick-chart .fm-analysis-chart-export")
    .getByRole("button", { exact: true, name: "CSV" })
    .evaluate((button) => button.click());
  await page.waitForTimeout(250);
  const afterLifecycle = await collectLifecycleSnapshot(page);
  const afterViewport = await collectViewport3DIsolationSnapshot(page);
  const actionRequests = sessionRequests.slice(requestStart);
  const requestSummary = summarizeViewportRequests(actionRequests);
  const result = {
    ...requestSummary,
    animationFrameCallbacks:
      afterLifecycle.animationFrameCallbacks -
      beforeLifecycle.animationFrameCallbacks,
    cameraChanges:
      beforeViewport.cameraSignature === afterViewport.cameraSignature ? 0 : 1,
    contextLost: afterViewport.contextLost,
    dirtyFrames: Math.max(0, afterViewport.frames - beforeViewport.frames),
    drawingBufferHeight: afterViewport.drawingBufferHeight,
    drawingBufferWidth: afterViewport.drawingBufferWidth,
    objectUrlsCreated:
      afterLifecycle.createdObjectUrls - beforeLifecycle.createdObjectUrls,
    objectUrlsRemaining:
      afterLifecycle.objectUrls - beforeLifecycle.objectUrls,
    objectUrlsRevoked:
      afterLifecycle.revokedObjectUrls - beforeLifecycle.revokedObjectUrls,
    unchangedBufferUploads: Math.max(
      0,
      afterViewport.viewportUploads - beforeViewport.viewportUploads,
    ),
    webglBufferDelta: Math.max(
      0,
      afterViewport.geometries - beforeViewport.geometries,
    ),
  };
  if (
    actionRequests.length > 0 ||
    result.animationFrameCallbacks > 0 ||
    result.cameraChanges > 0 ||
    result.dirtyFrames > 0 ||
    result.objectUrlsCreated !== 2 ||
    result.objectUrlsRemaining !== 0 ||
    result.objectUrlsRevoked !== result.objectUrlsCreated ||
    result.unchangedBufferUploads > 0 ||
    result.webglBufferDelta > 0 ||
    result.contextLost ||
    result.drawingBufferWidth <= 0 ||
    result.drawingBufferHeight <= 0
  ) {
    throw new Error(
      `Quick Chart + 3D isolation failed for local cursor action: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function collectLifecycleSnapshot(page) {
  return page.evaluate(() => {
    const runtime = window.__FULLMAG_CHART_AUDIT_RUNTIME__ ?? {};
    const resizeObservers = runtime.resizeObservers ?? 0;
    const mutationObservers = runtime.mutationObservers ?? 0;
    return {
      animationFrameCallbacks: runtime.animationFrameCallbacks ?? 0,
      animationFrames: runtime.animationFrames ?? 0,
      createdObjectUrls: runtime.createdObjectUrls ?? 0,
      echartsCanvases: document.querySelectorAll(
        ".fm-analysis-chart-surface canvas",
      ).length,
      intervals: runtime.intervals ?? 0,
      listeners: runtime.listeners ?? 0,
      mutationObservers,
      objectUrls: runtime.objectUrls ?? 0,
      observers: resizeObservers + mutationObservers,
      resizeObservers,
      revokedObjectUrls: runtime.revokedObjectUrls ?? 0,
      workers: runtime.workers ?? 0,
    };
  });
}

function assertBoundedLifecycle(
  baseline,
  afterClose,
  baselineHeapBytes,
  retainedHeapBytes,
  surfaceName = "Quick Chart",
) {
  const resourceKeys = [
    "animationFrames",
    "echartsCanvases",
    "intervals",
    "listeners",
    "mutationObservers",
    "objectUrls",
    "resizeObservers",
    "workers",
  ];
  const growth = Object.fromEntries(
    resourceKeys.map((key) => [key, afterClose[key] - baseline[key]]),
  );
  const growingResources = Object.entries(growth).filter(([, value]) => value > 0);
  const retainedHeapGrowthBytes = Math.max(
    0,
    retainedHeapBytes - baselineHeapBytes,
  );
  if (
    growingResources.length > 0 ||
    retainedHeapGrowthBytes > maxRetainedHeapGrowthBytes
  ) {
    throw new Error(
      `${surfaceName} lifecycle did not return to its bounded baseline: ` +
        JSON.stringify({
          afterClose,
          baseline,
          growth,
          maxRetainedHeapGrowthBytes,
          retainedHeapGrowthBytes,
        }),
    );
  }
}

async function forceGarbageCollection(page, cdp) {
  await page.evaluate(() => globalThis.gc?.());
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  await page.waitForTimeout(100);
}

async function waitForSessionRequestQuiet(page, sessionRequests) {
  const deadline = Date.now() + timeoutMs;
  let previousCount = sessionRequests.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    if (sessionRequests.length !== previousCount) {
      previousCount = sessionRequests.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= 500) return;
  }
  throw new Error(
    "Session resource requests did not settle before chart audit. Recent requests: " +
      JSON.stringify(sessionRequests.slice(-20)),
  );
}

async function waitForAnimationFrameQuiet(page) {
  const deadline = Date.now() + timeoutMs;
  let previous = await collectLifecycleSnapshot(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const current = await collectLifecycleSnapshot(page);
    if (
      current.animationFrames === 0 &&
      current.animationFrameCallbacks === previous.animationFrameCallbacks
    ) {
      return;
    }
    previous = current;
  }
  throw new Error("Animation frames did not settle before chart audit.");
}

function summarizeViewportRequests(requests) {
  const fieldRequests = requests.filter(({ path }) =>
    /^\/v2\/sessions\/current\/data\/fields\//.test(path),
  ).length;
  const topologyRequests = requests.filter(({ path }) =>
    /^\/v2\/sessions\/current\/(?:data\/domain|meshing\/meshes\/|meshing\/summary)/.test(
      path,
    ),
  ).length;
  return {
    fieldRequests,
    requests: requests.length,
    topologyRequests,
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

function footerTab(page, text) {
  return page.locator(".fm-footer__tab").filter({ hasText: text });
}

function createFixtureRouteState() {
  return {
    abortObserved: false,
    delayNext: false,
    delayedRequest: null,
    delayedStarted: null,
    resolveDelayedStarted: null,
    revision: 17,
    valueGeneration: 0,
  };
}

async function installChartPerformanceFixtureRoutes(page, totalRows, state) {
  const datasetRef = "analysis-performance-fixture";
  const columns = [
    { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
    { column_id: "t", component: null, dimension: "time", label: "time", quantity_id: "t", reduction: null, unit: "s", value_type: "float" },
    { column_id: "mx", component: "x", dimension: "magnetization", label: "mx", quantity_id: "mx", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "my", component: "y", dimension: "magnetization", label: "my", quantity_id: "my", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "mz", component: "z", dimension: "magnetization", label: "mz", quantity_id: "mz", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "e_total", component: null, dimension: "energy", label: "total energy", quantity_id: "e_total", reduction: "sum", unit: "J", value_type: "float" },
    { column_id: "max_torque_Apm", component: null, dimension: "magnetization", label: "maximum torque", quantity_id: "max_torque_Apm", reduction: "max", unit: "A/m", value_type: "float" },
  ];
  const tableFixture = () => ({
    binary_rows_href: `/v2/sessions/current/data/tables/${datasetRef}/rows.bin`,
    columns: [],
    columns_href: `/v2/sessions/current/data/tables/${datasetRef}/columns`,
    revision: state.revision,
    rows_href: `/v2/sessions/current/data/tables/${datasetRef}/rows`,
    schema_revision: 1,
    table_id: datasetRef,
    total_rows: totalRows,
  });
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version",
    "x-api-contract-version": "1.0.0",
  };

  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (request.method() !== "GET") {
      await route.fulfill({ body: "", headers: cors, status: 204 });
      return;
    }
    if (requestUrl.pathname === "/v2/sessions/current/status") {
      await route.fulfill({
        body: JSON.stringify(chartPerformanceStatusFixture()),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (requestUrl.pathname === "/v2/sessions/current/simulation/preparation") {
      await route.fulfill({
        body: JSON.stringify({ error: "fixture preparation not published" }),
        contentType: "application/json",
        headers: cors,
        status: 404,
      });
      return;
    }
    if (requestUrl.pathname === "/v2/sessions/current/model/couplings") {
      await route.fulfill({
        body: JSON.stringify({ couplings: [], revision: 0, scene_revision: 0 }),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    const auxiliaryFixture = chartPerformanceAuxiliaryFixture(
      requestUrl.pathname,
    );
    if (auxiliaryFixture) {
      await route.fulfill({
        ...(auxiliaryFixture.body === null
          ? { body: "" }
          : {
              body: JSON.stringify(auxiliaryFixture.body),
              contentType: "application/json",
            }),
        headers: cors,
        status: auxiliaryFixture.status,
      });
      return;
    }
    if (requestUrl.pathname === "/v2/sessions/current/data/tables") {
      await route.fulfill({
        body: JSON.stringify({ revision: state.revision, tables: [tableFixture()] }),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (requestUrl.pathname === `/v2/sessions/current/data/tables/${datasetRef}`) {
      await route.fulfill({
        body: JSON.stringify(tableFixture()),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (requestUrl.pathname === `/v2/sessions/current/data/tables/${datasetRef}/columns`) {
      await route.fulfill({
        body: JSON.stringify(columns),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (requestUrl.pathname === `/v2/sessions/current/data/tables/${datasetRef}/rows.bin`) {
      const requestedColumns = (requestUrl.searchParams.get("columns") ?? "")
        .split(",")
        .filter(Boolean);
      const targetPoints = Number(
        requestUrl.searchParams.get("target_points") ?? 1_600,
      );
      const rowCount = Math.min(
        totalRows,
        Math.max(1, Number.isFinite(targetPoints) ? targetPoints : 1_600),
      );
      if (requestedColumns.length === 0) {
        await route.abort("failed");
        return;
      }
      const responseRevision = state.revision;
      const responseGeneration = state.valueGeneration;
      if (state.delayNext) {
        state.delayNext = false;
        state.delayedRequest = request;
        state.resolveDelayedStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route
        .fulfill({
          body: makeFmtbFixture(
            requestedColumns,
            rowCount,
            totalRows,
            responseRevision,
            responseGeneration,
          ),
          contentType: "application/vnd.fullmag.table-rows.v1+octet-stream",
          headers: cors,
          status: 200,
        })
        .catch((error) => {
          if (request === state.delayedRequest && state.abortObserved) return;
          throw error;
        });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ error: "fixture resource not published" }),
      contentType: "application/json",
      headers: cors,
      status: 404,
    });
  });
}

function chartPerformanceAuxiliaryFixture(pathname) {
  const emptySceneList = { items: [], scene_revision: 0 };
  const fixtures = new Map([
    [
      "/v2/sessions/current/data/domain/meta",
      {
        bounds: { max: [1, 1, 0.25], min: [-1, -1, -0.25] },
        coordinate_system: "cartesian",
        counts: { cells: 4 },
        dimension: 3,
        discretization: "fdm",
        domain_id: "chart-performance-domain",
        generation_id: "1",
        grid: {
          origin: [-1, -1, -0.25],
          shape: [2, 2, 1],
          spacing: [1, 1, 0.5],
        },
        units: { length: "m" },
      },
    ],
    ["/v2/sessions/current/data/domain/topology", null],
    ["/v2/sessions/current/data/fdm-region-memberships", null],
    [
      "/v2/sessions/current/diagnostics/solver-profile",
      {
        aggregates: {
          average_demag_ns: 0,
          average_exchange_ns: 0,
          average_total_ns: 0,
          max_total_ns: 0,
          sample_count: 0,
        },
        artifact_refs: [],
        config: {
          emit_engine_log: false,
          enabled: false,
          max_samples: 128,
          persist_artifact: false,
          sample_every: 1,
          sample_interval_wall_ms: 0,
        },
        latest_samples: [],
        revision: 0,
        state: "disabled",
      },
    ],
    [
      "/v2/sessions/current/meshing/builds/current",
      {
        active_build: null,
        effective_airbox_target: null,
        effective_per_object_targets: null,
        last_build_error: null,
        last_build_summary: null,
        mesh_pipeline_status: [],
        policy_diff: [],
        provenance: null,
        published_resources: null,
        resolved_policy: null,
        revision: 0,
        shared_domain_build_report: null,
      },
    ],
    [
      "/v2/sessions/current/meshing/capabilities",
      { mesh_adaptivity_state: null, mesh_capabilities: null, revision: 0 },
    ],
    [
      "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
      {
        element_counts_by_type: {},
        facet_counts_by_type_and_role: {},
        fallbacks_triggered: [],
        generation_id: "1",
        mesh_id: "chart-performance-empty-mesh",
        mesh_name: "Chart performance empty mesh",
        mesh_parts: [],
        object_segments: [],
        regions: [],
        revision: 0,
        source_scene_revision: 0,
        topology_fingerprint: "chart-performance-empty-topology",
        topology_schema_version: 1,
      },
    ],
    [
      "/v2/sessions/current/meshing/mesh/periodic_pairs.v1",
      {
        pairs: [],
        revision: 0,
        schema_version: "periodic_pairs.v1",
        status: "unavailable",
        status_reasons: ["Fixture mesh has no periodic boundaries."],
      },
    ],
    [
      "/v2/sessions/current/meshing/semantics",
      {
        mesh_build_diagnostics: null,
        object_configs: [],
        render_only_controls_do_not_change_solver_domain: true,
        revision: 0,
        shared_domain_config: {},
        solver_mesh: null,
        universe_config: null,
      },
    ],
    ["/v2/sessions/current/model/current-transports", emptySceneList],
    [
      "/v2/sessions/current/model/geometry/capabilities",
      { csg_capabilities: [], primitive_capabilities: [], revision: 0 },
    ],
    [
      "/v2/sessions/current/model/geometry/validation",
      {
        backend_target: "fdm",
        diagnostics: [],
        dirty: false,
        scene_revision: 0,
        status: "valid",
      },
    ],
    [
      "/v2/sessions/current/model/material-fields",
      { fields: [], region_coefficients_revision: 0, scene_revision: 0 },
    ],
    ["/v2/sessions/current/model/oersted-fields", emptySceneList],
    [
      "/v2/sessions/current/model/planar-monitors",
      { count: 0, monitors: [], scene_revision: 0 },
    ],
    [
      "/v2/sessions/current/model/regions",
      {
        geometry_realization_revision: 0,
        region_coefficients_revision: 0,
        region_initial_state_revision: 0,
        region_membership_revision: 0,
        region_topology_revision: 0,
        regions: [],
        scene_revision: 0,
      },
    ],
    [
      "/v2/sessions/current/model/scene",
      { objects: [], revision: 0, schema_version: 1 },
    ],
    ["/v2/sessions/current/model/spin-interfaces", emptySceneList],
    ["/v2/sessions/current/model/spin-torques", emptySceneList],
    ["/v2/sessions/current/model/spin-transports", emptySceneList],
    [
      "/v2/sessions/current/model/universe",
      {
        mesh_dirty: false,
        object_bounds_max: [1, 1, 0.25],
        object_bounds_min: [-1, -1, -0.25],
        scene_revision: 0,
        study_universe_mesh: null,
        universe: null,
      },
    ],
    ["/v2/sessions/current/persistence/checkpoints", { checkpoints: [] }],
    [
      "/v2/sessions/current/simulation/runs/current",
      {
        active_stage_index: null,
        active_stage_kind: null,
        artifact_dir: "/tmp/fullmag-chart-performance-fixture/artifacts",
        requested_backend: "fdm",
        requested_device: "cpu",
        requested_mode: "strict",
        requested_precision: "double",
        resolved_backend: "fdm",
        resolved_device: "cpu",
        resolved_engine_id: "fixture",
        resolved_fallback: null,
        resolved_mode: "strict",
        resolved_precision: "double",
        resolved_runtime_family: "fixture",
        resolved_worker: null,
        revision: 0,
        run_id: "chart-performance-run",
        session_id: "chart-performance-fixture",
        solver_time_seconds: 0,
        started_at: "2026-08-03T00:00:00.000Z",
        status: "idle",
        status_reason: null,
        total_stages: 0,
        total_steps: 0,
      },
    ],
    [
      "/v2/sessions/current/simulation/solver/status",
      {
        can_accept_commands: true,
        converged: false,
        is_busy: false,
        max_rhs_norm_per_s: null,
        max_torque_Apm: null,
        max_torque_T: null,
        revision: 0,
        runtime_state: "idle",
        runtime_status_code: "idle",
        runtime_status_kind: "idle",
        session_status: "ready",
        sim_time_seconds: 0,
        step_index: 0,
        warnings: [],
      },
    ],
    [
      "/v2/sessions/current/simulation/stages/execution",
      {
        active_stage_index: null,
        active_stage_kind: null,
        completed_stage_indexes: [],
        revision: 0,
        runtime_state: "idle",
        stage_statuses: [],
        stages: [],
        total_stages: 0,
      },
    ],
    [
      "/v2/sessions/current/visualization/state",
      chartPerformanceVisualizationStateFixture(),
    ],
  ]);
  if (!fixtures.has(pathname)) return null;
  const body = fixtures.get(pathname);
  return { body, status: body === null ? 204 : 200 };
}

function chartPerformanceVisualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [3, 2, 2],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: { enabled: false, normal_axis: "z", offset: 0 },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: { active_scope_id: null, active_scope_kind: "domain" },
    fdm: { x_chosen_size: 1, y_chosen_size: 1 },
    fem: { topology_mode: "surface", volume_edges_budget: 0 },
    field_component: "magnitude",
    layers: {
      bounds: { visible: true },
      points: { visible: false },
      quantity_overlay: { visible: true },
      surface: { opacity: 0.94, visible: true },
      vectors: { density: 2, domain: "full_domain", visible: false },
      wireframe: { visible: true },
    },
    max_points: 120_000,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision: 0,
    sampling: { max_glyphs: 192, max_points: 120_000 },
    schema_version: 1,
    slice: { layer: 0, mode: "xy" },
    slice_layer: 0,
    slice_mode: "xy",
    trim: { enabled: false, max: [1, 1, 1], min: [0, 0, 0] },
    vector_density: 2,
    vector_glyphs: false,
    view_mode: "3d",
    x_chosen_size: 1,
    y_chosen_size: 1,
  };
}

function chartPerformanceStatusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: false,
      node_fields: true,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: false,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 1_000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 1,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: { cell_count: 0, discretization: "fem", generation_id: 0 },
    energies: {},
    metrics: { steps_per_second: null, total_steps: 0, uptime_seconds: 0 },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: 0,
      domain_generation_id: "0",
      engine_log_revision: 0,
      field_catalog_revision: 0,
      field_revision: 0,
      fields_revision: 0,
      mesh_build_revision: 0,
      mesh_revision: 0,
      region_coefficients_revision: 0,
      region_initial_state_revision: 0,
      region_membership_revision: 0,
      region_topology_revision: 0,
      scalars_revision: 0,
      scene_revision: 0,
      simulation_preparation_revision: 0,
      slice_revision: 0,
      solver_profile_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: 0,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "chart-performance-fixture",
    session: {
      created_at: "2026-08-03T00:00:00.000Z",
      name: "Chart performance fixture",
      session_id: "chart-performance-fixture",
      workspace_root: "/tmp/fullmag-chart-performance-fixture",
    },
    solver: { state: "awaiting_command" },
  };
}

function makeFmtbFixture(columns, rowCount, totalRows, revision, generation = 0) {
  const headerBytes = 60;
  const buffer = Buffer.alloc(headerBytes + rowCount * columns.length * 8);
  buffer.write("FMTB", 0, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeBigUInt64LE(BigInt(revision), 8);
  buffer.writeBigUInt64LE(1n, 16);
  buffer.writeBigUInt64LE(0n, 24);
  buffer.writeBigUInt64LE(BigInt(rowCount), 32);
  buffer.writeBigUInt64LE(BigInt(totalRows), 40);
  buffer.writeBigUInt64LE(BigInt(rowCount), 48);
  buffer.writeUInt32LE(columns.length, 56);
  const stride = Math.max(1, Math.floor(totalRows / rowCount));
  let offset = headerBytes;
  for (let row = 0; row < rowCount; row += 1) {
    const logicalRow = Math.min(totalRows - 1, row * stride);
    for (const column of columns) {
      buffer.writeDoubleLE(fixtureValue(column, logicalRow, generation), offset);
      offset += 8;
    }
  }
  return buffer;
}

function fixtureValue(column, row, generation = 0) {
  const phase = row / 2_000;
  const progress = row / Math.max(1, fixtureTotalRows - 1);
  const generationOffset = generation * 1_000;
  switch (column) {
    case "step":
      return row;
    case "t":
    case "pseudo_time_s":
      return row * 1e-12;
    case "active_runtime_s":
      return row * 2e-6;
    case "mx":
      return generationOffset + Math.cos(phase) * (1 - 0.05 * progress);
    case "my":
      return generationOffset + Math.sin(phase) * (1 - 0.05 * progress);
    case "mz":
      return generationOffset + 0.05 * Math.sin(phase / 3);
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
  const sourceRevision = state.revision;
  const staleValues = await collectAnalysisLegendReadings(page);
  if (staleValues.length === 0) {
    throw new Error("Abort proof could not capture the source revision legend values.");
  }
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
  const latestRevision = sourceRevision + 1;
  state.revision = latestRevision;
  state.valueGeneration += 1;
  await viewportTab(page, /^3D Viewport$/).first().click({ timeout: timeoutMs });
  await waitForActiveViewportModule(page, "viewport-3d");
  await page.waitForTimeout(1_750);
  await openAnalysisPlots(page);
  await selectExplicitAnalysisDataset(page);
  await waitForAnalysisChart(page);
  await waitForStableChartDiagnostics(page);
  const remountProvenance = await page
    .getByText(/^Dataset provenance:/)
    .first()
    .innerText({ timeout: timeoutMs });
  const remountValues = await collectAnalysisLegendReadings(page);
  const remountStaleRevisionVisible = remountProvenance.includes(
    `revision ${sourceRevision}`,
  );
  const remountStaleValuesAdopted =
    remountValues.length === 0 ||
    JSON.stringify(remountValues) === JSON.stringify(staleValues);
  if (remountStaleRevisionVisible || remountStaleValuesAdopted) {
    throw new Error(
      "Pending rows request adopted stale revision or values during same-runtime remount: " +
        JSON.stringify({
          remountProvenance,
          remountStaleRevisionVisible,
          remountStaleValuesAdopted,
          remountValues,
          sourceRevision,
          staleValues,
        }),
    );
  }

  // Force a new rows identity after the remount. This makes the fixture prove
  // that the newest N+1 payload is adopted without reloading the document.
  await page.evaluate(() => {
    const dispatch = window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchDataZoom;
    if (typeof dispatch !== "function") {
      throw new Error("Chart range dispatcher is unavailable after remount.");
    }
    dispatch(60, 80);
  });
  await page.waitForFunction(
    (expectedRevision) =>
      Array.from(document.querySelectorAll(".fm-analysis-plots *")).some(
        (node) =>
          node.textContent?.trim().startsWith("Dataset provenance:") &&
          node.textContent.includes(`revision ${expectedRevision}`),
      ),
    latestRevision,
    { timeout: timeoutMs },
  );
  const provenance = await page
    .getByText(/^Dataset provenance:/)
    .first()
    .innerText({ timeout: timeoutMs });
  const latestValues = await collectAnalysisLegendReadings(page);
  const staleRevisionVisible =
    remountStaleRevisionVisible || provenance.includes(`revision ${sourceRevision}`);
  const latestRevisionVisible = provenance.includes(`revision ${latestRevision}`);
  const staleValuesAdopted =
    remountStaleValuesAdopted ||
    latestValues.length === 0 ||
    JSON.stringify(latestValues) === JSON.stringify(staleValues);
  if (!latestRevisionVisible || staleRevisionVisible || staleValuesAdopted) {
    throw new Error(
      "Pending rows request adopted stale revision or values: " +
        JSON.stringify({
          latestRevision,
          latestRevisionVisible,
          latestValues,
          provenance,
          sourceRevision,
          staleRevisionVisible,
          staleValues,
          staleValuesAdopted,
        }),
    );
  }
  return {
    cancellation: {
      adoptedAfterAbort: staleRevisionVisible || staleValuesAdopted,
      completed: state.abortObserved,
      latestRevision,
      requested: true,
      sourceRevision,
      staleRevisionVisible,
      staleValuesAdopted,
    },
    durationMs: performance.now() - startedAt,
  };
}

async function collectAnalysisLegendReadings(page) {
  return page
    .locator(".fm-analysis-plots .fm-chart-legend__latest")
    .allTextContents()
    .then((values) => values.map((value) => value.trim()).filter(Boolean));
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

function transportMetrics(measured) {
  return {
    cacheHits: null,
    cacheMeasurement: "NOT_MEASURED",
    cacheMisses: null,
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
  const snapshot = await collectLifecycleSnapshot(page);
  return {
    listeners: snapshot.listeners,
    observers: snapshot.observers,
    workers: snapshot.workers,
  };
}

async function collectViewport3DIsolationSnapshot(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("3D viewport canvas is not mounted for chart isolation audit.");
    }
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!gl) {
      throw new Error("3D viewport WebGL context is unavailable for chart isolation audit.");
    }
    const diagnostics = window.__FULLMAG_READ_CHART_AUDIT_VIEWPORT__?.() ?? {};
    return {
      cameraSignature: diagnostics.cameraSignature ?? "",
      contextLost: gl.isContextLost(),
      drawingBufferHeight: gl.drawingBufferHeight,
      drawingBufferWidth: gl.drawingBufferWidth,
      frames: diagnostics.frames ?? 0,
      geometries: diagnostics.geometries ?? 0,
      viewportUploads: diagnostics.viewportUploads ?? 0,
    };
  });
}

async function collectViewport3DProof(page, measuredIsolation) {
  const state = await collectViewport3DIsolationSnapshot(page);
  if (
    state.contextLost ||
    state.drawingBufferWidth <= 0 ||
    state.drawingBufferHeight <= 0
  ) {
    throw new Error(
      `Final 3D WebGL proof failed: ${JSON.stringify(state)}`,
    );
  }
  return {
    contextLost: state.contextLost,
    dirtyFrames: measuredIsolation.dirtyFrames,
    drawingBufferHeight: state.drawingBufferHeight,
    drawingBufferWidth: state.drawingBufferWidth,
    fieldRequests: measuredIsolation.fieldRequests,
    mounted: true,
    topologyRequests: measuredIsolation.topologyRequests,
    unchangedBufferUploads: measuredIsolation.unchangedBufferUploads,
    webglBufferDelta: measuredIsolation.webglBufferDelta,
  };
}

async function readJsHeapBytes(cdp) {
  const result = await cdp.send("Performance.getMetrics");
  return (
    result.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0
  );
}

function resolveBuildProvenance() {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const git = (args, options = {}) =>
    execFileSync("git", args, { ...options, cwd: repoRoot });
  const commit = git(["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const requestedCommit = process.env.CONTROL_ROOM_AUDIT_COMMIT;
  if (requestedCommit && requestedCommit !== commit) {
    throw new Error(
      `CONTROL_ROOM_AUDIT_COMMIT ${requestedCommit} does not match current HEAD ${commit}.`,
    );
  }
  const status = git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  const dirty = status.length > 0;
  const trackedDiff = git(["diff", "--binary", "HEAD", "--"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  const untrackedPaths = git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\u0000")
    .filter(Boolean)
    .sort();
  const fingerprint = createHash("sha256").update(status).update(trackedDiff);
  for (const untrackedPath of untrackedPaths) {
    fingerprint.update("\u0000").update(untrackedPath).update("\u0000");
    fingerprint.update(readFileSync(path.resolve(repoRoot, untrackedPath)));
  }
  const mode = process.env.CONTROL_ROOM_AUDIT_BUILD_MODE ?? "unknown";
  if (
    process.env.CONTROL_ROOM_AUDIT_REQUIRE_PRODUCTION === "1" &&
    mode !== "production"
  ) {
    throw new Error(`Chart performance proof requires production mode, got ${mode}.`);
  }
  if (process.env.CONTROL_ROOM_AUDIT_REQUIRE_CLEAN === "1" && dirty) {
    throw new Error("Chart performance proof requires a clean working tree.");
  }
  return {
    commit,
    diffFingerprint: `sha256:${fingerprint.digest("hex")}`,
    dirty,
    mode,
  };
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

function isExpectedFixtureFailure(response) {
  return (
    fixtureMode &&
    response.status === 404 &&
    response.path === "/v2/sessions/current/simulation/preparation"
  );
}

function summarizeFailedResponses(responses) {
  const counts = new Map();
  for (const response of responses) {
    const key = `${response.status} ${response.path ?? new URL(response.url).pathname}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts, ([resource, count]) => ({ count, resource })).sort(
    (left, right) => left.resource.localeCompare(right.resource),
  );
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
