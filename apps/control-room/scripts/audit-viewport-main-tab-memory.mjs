import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CENTER_TAB_IDS = Object.freeze([
  "viewport-3d",
  "field-map",
  "analysis-plots",
  "live-charts",
]);
const CENTER_TAB_TITLES = Object.freeze({
  "analysis-plots": "Analysis",
  "field-map": "2D View",
  "live-charts": "Live Charts",
  "viewport-3d": "3D Viewport",
});
const THREE_D_RENDER_MEASURE_PREFIX =
  "fullmag.react.render.Viewport3DModule.";
const THREE_D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const DEFAULT_SWITCH_COUNT = 100;
const DEFAULT_SETTLE_MS = 250;
const DEFAULT_MAX_HEAP_GROWTH_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_REOPEN_LATENCY_MS = 2_000;
const DEFAULT_MAX_CONFIGURES_PER_CONTEXT = 2;
const DEFAULT_MAX_REOPEN_TOPOLOGY_BUILDS = 1;
const DEFAULT_MAX_REOPEN_GPU_UPLOAD_BYTES = 256 * 1024 * 1024;
const VIEWPORT_FRAME_COMMIT_REASON = "frame-commit";

const directScriptPath = process.argv[1]
  ? resolve(process.argv[1])
  : null;
const isDirectRun = directScriptPath === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  await main();
}

async function main() {
  const configuredUrl = process.env.CONTROL_ROOM_URL ?? null;
  if (!configuredUrl) {
    throw new Error(
      "Viewport-main tab memory audit requires CONTROL_ROOM_URL pointing at a running Control Room.",
    );
  }

  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Viewport-main tab memory audit requires Playwright or @playwright/test.",
    );
  }

  const workspaceUrl = new URL(configuredUrl);
  workspaceUrl.searchParams.set("fullmagReactProfiler", "1");
  const outputDir = path.resolve(
    process.env.CONTROL_ROOM_TAB_AUDIT_ARTIFACTS_DIR ??
      ".artifacts/viewport-main-tab-memory",
  );
  const switchCount = positiveInteger(
    process.env.CONTROL_ROOM_TAB_MEMORY_SWITCH_COUNT,
    DEFAULT_SWITCH_COUNT,
  );
  const settleMs = positiveInteger(
    process.env.CONTROL_ROOM_TAB_MEMORY_SETTLE_MS,
    DEFAULT_SETTLE_MS,
  );
  const maxHeapGrowthBytes = positiveInteger(
    process.env.CONTROL_ROOM_TAB_MEMORY_MAX_HEAP_GROWTH_BYTES,
    DEFAULT_MAX_HEAP_GROWTH_BYTES,
  );
  const maxReopenLatencyMs = positiveInteger(
    process.env.CONTROL_ROOM_TAB_MEMORY_MAX_REOPEN_LATENCY_MS,
    DEFAULT_MAX_REOPEN_LATENCY_MS,
  );
  const maxReopenTopologyBuilds = positiveInteger(
    process.env.CONTROL_ROOM_TAB_MEMORY_MAX_REOPEN_TOPOLOGY_BUILDS,
    DEFAULT_MAX_REOPEN_TOPOLOGY_BUILDS,
  );
  const maxReopenGpuUploadBytes = positiveInteger(
    process.env.CONTROL_ROOM_TAB_MEMORY_MAX_REOPEN_GPU_UPLOAD_BYTES,
    DEFAULT_MAX_REOPEN_GPU_UPLOAD_BYTES,
  );

  await mkdir(outputDir, { recursive: true });
  let browser;
  try {
    browser = await playwright.chromium.launch({
      args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
    });
  } catch (error) {
    await writeReport(outputDir, {
      browser_errors: [],
      center_tabs: CENTER_TAB_IDS,
      error: error instanceof Error ? error.message : String(error),
      observations: [],
      pass: false,
      raw_counters: null,
      raw_reasons: null,
      schema_version: "viewport-main-active-tab-memory-v1",
      switch_count: switchCount,
      workspace_url: workspaceUrl.href,
    });
    throw error;
  }
  const page = await browser.newPage({
    viewport: { height: 900, width: 1440 },
  });
  await page.addInitScript(() => {
    window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    };
    window.__FULLMAG_VIEWPORT_MAIN_TAB_AUDIT__ = { contextLosses: 0 };
    const pendingAnimationFrames = new Set();
    const requestAnimationFrame = window.requestAnimationFrame.bind(window);
    const cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    window.__FULLMAG_VIEWPORT_MAIN_TAB_AUDIT__.pendingAnimationFrames = pendingAnimationFrames;
    window.requestAnimationFrame = (callback) => {
      let frameId = 0;
      frameId = requestAnimationFrame((time) => {
        pendingAnimationFrames.delete(frameId);
        callback(time);
      });
      pendingAnimationFrames.add(frameId);
      return frameId;
    };
    window.cancelAnimationFrame = (frameId) => {
      pendingAnimationFrames.delete(frameId);
      cancelAnimationFrame(frameId);
    };
    document.addEventListener(
      "webglcontextlost",
      () => {
        window.__FULLMAG_VIEWPORT_MAIN_TAB_AUDIT__.contextLosses += 1;
      },
      true,
    );
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable").catch(() => undefined);

  const classifiedRequests = [];
  const browserErrors = [];
  let captureRequests = false;
  let transitionTarget = null;
  page.on("request", (request) => {
    if (!captureRequests) return;
    const kind = classifyViewport3DOnlyRequest(
      request.url(),
      request.method(),
    );
    if (!kind) return;
    classifiedRequests.push({
      kind,
      method: request.method(),
      target: transitionTarget,
      timestampMs: Date.now(),
      url: request.url(),
    });
  });
  page.on("pageerror", (error) => {
    if (captureRequests) browserErrors.push(error.message);
  });
  page.on("response", (response) => {
    if (!captureRequests || response.status() < 500) return;
    browserErrors.push(`${response.status()} ${response.url()}`);
  });

  const observations = [];
  let latestSignals = null;
  let report = null;
  try {
    await page.goto(workspaceUrl.href, {
      timeout: timeoutMs(),
      waitUntil: "domcontentloaded",
    });
    const registeredTabs = await readRegisteredTabs(page);
    assert.deepEqual(
      registeredTabs.slice().sort(),
      CENTER_TAB_IDS.slice().sort(),
      `viewport-main registered tabs changed: ${JSON.stringify(registeredTabs)}`,
    );

    await activateTab(page, "viewport-3d", settleMs);
    const initialCanvas = await assertHealthyCanvas(page, "initial 3D tab");
    await waitForViewportProfilerMeasure(page);
    await page.waitForTimeout(settleMs);
    await collectGarbage(cdp);
    const baselineHeapBytes = await readHeapBytes(page, cdp);
    if (baselineHeapBytes === null) {
      throw new Error(
        "Browser does not expose a measurable JS heap; memory gate cannot run.",
      );
    }

    captureRequests = true;
    const transitionSequence = Array.from(
      { length: switchCount },
      (_, index) => CENTER_TAB_IDS[(index + 1) % CENTER_TAB_IDS.length],
    );
    for (const [index, moduleId] of transitionSequence.entries()) {
      const before = await readViewportSignals(page);
      const requestStart = classifiedRequests.length;
      transitionTarget = moduleId;
      const transitionStartedAtMs = performance.now();
      await activateTab(page, moduleId, settleMs);
      const transitionLatencyMs = performance.now() - transitionStartedAtMs;
      const after = await readViewportSignals(page);
      latestSignals = after;
      const requests = classifiedRequests.slice(requestStart);
      const observation = {
        activeModuleId: after.activeModuleId,
        canvasCount: after.canvasCount,
        canvasContextsCreatedDelta: counterDelta(
          after.debug.canvasContextsCreated,
          before.debug.canvasContextsCreated,
        ),
        canvasContextsDisposedDelta: counterDelta(
          after.debug.canvasContextsDisposed,
          before.debug.canvasContextsDisposed,
        ),
        canvasEventConnectionsDelta: counterDelta(
          after.debug.canvasEventConnections,
          before.debug.canvasEventConnections,
        ),
        canvasEventDisconnectionsDelta: counterDelta(
          after.debug.canvasEventDisconnections,
          before.debug.canvasEventDisconnections,
        ),
        canvasRootConfigureCompletedDelta: counterDelta(
          after.debug.canvasRootConfigureCompleted,
          before.debug.canvasRootConfigureCompleted,
        ),
        canvasRootConfigureStartedDelta: counterDelta(
          after.debug.canvasRootConfigureStarted,
          before.debug.canvasRootConfigureStarted,
        ),
        clientAckRequestsDelta: requests.filter(
          (request) => request.kind === "client-ack",
        ).length,
        index: index + 1,
        moduleId,
        contextLossesDelta: counterDelta(
          after.contextLosses,
          before.contextLosses,
        ),
        pendingAnimationFrames: after.pendingAnimationFrames,
        rootCount: after.rootCount,
        threeDRequests: requests.filter(
          (request) => request.kind !== "client-ack",
        ),
        viewport3DRenderMeasuresAfter: after.viewport3DRenderMeasures,
        viewport3DRenderMeasuresBefore: before.viewport3DRenderMeasures,
        viewport3DRenderMeasuresDelta:
          after.viewport3DRenderMeasures - before.viewport3DRenderMeasures,
        viewportFrameReasonsDelta: reasonDeltas(
          after.debug.viewportFrameReasons,
          before.debug.viewportFrameReasons,
        ),
        viewportFramesDelta: counterDelta(
          after.debug.viewportFrames,
          before.debug.viewportFrames,
        ),
        workerJobsDelta: counterDelta(
          after.debug.workerJobs,
          before.debug.workerJobs,
        ),
        resourceCounts: after.debug.resourceCounts ?? {
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
        workerInstances: after.debug.resourceCounts?.workers ?? 0,
        topologyBuildsDelta: counterDelta(
          after.debug.topologyBuilds,
          before.debug.topologyBuilds,
        ),
        gpuUploadBytesDelta: counterDelta(
          after.debug.gpuUploadBytes,
          before.debug.gpuUploadBytes,
        ),
        viewportFrameReasonsDroppedDelta: counterDelta(
          after.debug.viewportFrameReasonsDropped,
          before.debug.viewportFrameReasonsDropped,
        ),
        viewportFrameReasonsOverflowed: after.debug.viewportFrameReasonsOverflowed === true,
        transitionLatencyMs,
      };
      if (moduleId !== "viewport-3d") {
        try {
          assertInactiveTabObservation(observation);
        } finally {
          observations.push(observation);
        }
        await page.screenshot({
          path: path.join(outputDir, `${moduleId}.png`),
        });
      } else {
        await assertHealthyCanvas(page, `3D tab transition ${index + 1}`);
        assertActiveThreeDObservation(observation, {
          maxReopenGpuUploadBytes,
          maxReopenLatencyMs,
          maxReopenTopologyBuilds,
        });
        observations.push(observation);
      }
    }

    if (CENTER_TAB_IDS[0] !== await readActiveModuleId(page)) {
      await activateTab(page, "viewport-3d", settleMs);
    }
    const finalCanvas = await assertHealthyCanvas(page, "final 3D tab");
    await collectGarbage(cdp);
    const finalHeapBytes = await readHeapBytes(page, cdp);
    if (finalHeapBytes === null) {
      throw new Error("Browser stopped exposing a measurable JS heap.");
    }
    const heapGrowthBytes = finalHeapBytes - baselineHeapBytes;
    const inactiveObservations = observations.filter(
      (observation) => observation.moduleId !== "viewport-3d",
    );
    const finalSignals = await readViewportSignals(page);
    assertTeardownLifecycleBudget({
      finalSignals,
      maxConfiguresPerContext: DEFAULT_MAX_CONFIGURES_PER_CONTEXT,
    });
    const pass =
      inactiveObservations.every((observation) => observation.passed === true) &&
      heapGrowthBytes <= maxHeapGrowthBytes &&
      browserErrors.length === 0 &&
      finalCanvas.drawingBufferWidth > 0 &&
      finalCanvas.drawingBufferHeight > 0 &&
      !finalCanvas.isContextLost;
    report = {
      browser_errors: browserErrors,
      center_tabs: CENTER_TAB_IDS,
      final_canvas: finalCanvas,
      heap: {
        baseline_bytes: baselineHeapBytes,
        growth_bytes: heapGrowthBytes,
        max_growth_bytes: maxHeapGrowthBytes,
        final_bytes: finalHeapBytes,
      },
      initial_canvas: initialCanvas,
      lifecycle: finalSignals,
      observations,
      pass,
      raw_counters: finalSignals.debug,
      raw_reasons: finalSignals.debug.viewportFrameReasons,
      schema_version: "viewport-main-active-tab-memory-v1",
      switch_count: switchCount,
      teardown_budget: {
        max_configures_per_context: DEFAULT_MAX_CONFIGURES_PER_CONTEXT,
        max_reopen_gpu_upload_bytes: maxReopenGpuUploadBytes,
        max_reopen_latency_ms: maxReopenLatencyMs,
        max_reopen_topology_builds: maxReopenTopologyBuilds,
      },
      workspace_url: workspaceUrl.href,
    };
    await writeReport(outputDir, report);
    if (!pass) {
      throw new Error(
        `Viewport-main inactive-tab memory gate failed: ${outputDir}`,
      );
    }
    console.log(
      `Viewport-main active-tab memory audit passed: switches=${switchCount} heap=${baselineHeapBytes}->${finalHeapBytes} bytes`,
    );
  } catch (error) {
    if (!report) {
      report = {
        browser_errors: browserErrors,
        center_tabs: CENTER_TAB_IDS,
        classified_requests: classifiedRequests,
        error: error instanceof Error ? error.message : String(error),
        lifecycle: latestSignals,
        observations,
        pass: false,
        raw_counters: latestSignals?.debug ?? null,
        raw_reasons: latestSignals?.debug?.viewportFrameReasons ?? null,
        schema_version: "viewport-main-active-tab-memory-v1",
        switch_count: switchCount,
        workspace_url: workspaceUrl.href,
      };
      await writeReport(outputDir, report);
    }
    throw error;
  } finally {
    await browser.close();
  }
}

export function assertInactiveTabObservation(observation) {
  const failures = [];
  if (observation.activeModuleId !== observation.moduleId) {
    failures.push(
      `active module is ${observation.activeModuleId ?? "unknown"}, expected ${observation.moduleId}`,
    );
  }
  if (observation.canvasCount > 0 || observation.rootCount > 0) {
    failures.push(
      `3D DOM remains mounted (canvas=${observation.canvasCount}, root=${observation.rootCount})`,
    );
  }
  if (observation.threeDRequests.length > 0) {
    failures.push(
      `3D field/topology requests: ${observation.threeDRequests
        .map((request) => `${request.method} ${request.url}`)
        .join("; ")}`,
    );
  }
  if (observation.viewport3DRenderMeasuresDelta > 0) {
    failures.push(
      `Viewport3DModule render measures increased by ${observation.viewport3DRenderMeasuresDelta}`,
    );
  }
  if (observation.clientAckRequestsDelta > 0) {
    failures.push(
      `visualization client acknowledgements increased by ${observation.clientAckRequestsDelta}`,
    );
  }
  if (observation.workerJobsDelta > 0) {
    failures.push(`worker jobs increased by ${observation.workerJobsDelta}`);
  }
  if (observation.viewportFramesDelta > 0) {
    failures.push(`viewport frames increased by ${observation.viewportFramesDelta}`);
  }
  if (observation.contextLossesDelta > 0) {
    failures.push(`WebGL context losses increased by ${observation.contextLossesDelta}`);
  }
  if (observation.pendingAnimationFrames > 0) {
    failures.push(`pending animation frames=${observation.pendingAnimationFrames}`);
  }
  if (observation.workerInstances > 0) {
    failures.push(`worker instances=${observation.workerInstances}`);
  }
  const leakedResources = Object.entries(observation.resourceCounts ?? {}).filter(
    ([, count]) => count > 0,
  );
  if (leakedResources.length > 0) {
    failures.push(
      `3D resources remain allocated: ${leakedResources
        .map(([resource, count]) => `${resource}=${count}`)
        .join(", ")}`,
    );
  }
  if (observation.viewportFrameReasonsDroppedDelta > 0 || observation.viewportFrameReasonsOverflowed) {
    failures.push("viewport frame reason overflow or dropped reason");
  }
  if (
    observation.viewportFramesDelta > 0 &&
    Object.values(observation.viewportFrameReasonsDelta).every((count) => count <= 0)
  ) {
    failures.push("viewport frame lacks dirty reason evidence");
  }
  observation.passed = failures.length === 0;
  if (!observation.passed) {
    throw new Error(
      `Inactive ${observation.moduleId} tab violated the 3D lifecycle contract: ${failures.join(" | ")}`,
    );
  }
}

export function assertActiveThreeDObservation(observation, {
  maxReopenGpuUploadBytes,
  maxReopenLatencyMs,
  maxReopenTopologyBuilds,
}) {
  const failures = [];
  if (observation.canvasCount !== 1 || observation.rootCount !== 1) {
    failures.push(
      `expected one active 3D root (canvas=${observation.canvasCount}, root=${observation.rootCount})`,
    );
  }
  if (observation.contextLossesDelta > 0) {
    failures.push(`WebGL context losses increased by ${observation.contextLossesDelta}`);
  }
  if (
    observation.canvasContextsCreatedDelta > 1 ||
    observation.canvasEventConnectionsDelta > 1
  ) {
    failures.push("reopen created more than one context or event connection");
  }
  if (observation.canvasRootConfigureStartedDelta > DEFAULT_MAX_CONFIGURES_PER_CONTEXT) {
    failures.push(`configure churn=${observation.canvasRootConfigureStartedDelta}`);
  }
  if (observation.canvasRootConfigureCompletedDelta > observation.canvasRootConfigureStartedDelta) {
    failures.push("completed configure count exceeds starts");
  }
  if (observation.viewportFrameReasonsDroppedDelta > 0 || observation.viewportFrameReasonsOverflowed) {
    failures.push("viewport frame reason overflow or dropped reason");
  }
  // CanvasLifecycleProbe records exactly one frame-commit for every actual R3F
  // frame. Other dirty reasons are additional provenance and cannot substitute
  // for this one-to-one commit evidence.
  const frameCommitEvidence =
    observation.viewportFrameReasonsDelta[VIEWPORT_FRAME_COMMIT_REASON] ?? 0;
  if (frameCommitEvidence !== observation.viewportFramesDelta) {
    failures.push(
      `frame commits=${observation.viewportFramesDelta}, frame-commit evidence=${frameCommitEvidence}`,
    );
  }
  if (observation.transitionLatencyMs > maxReopenLatencyMs) {
    failures.push(`reopen latency=${observation.transitionLatencyMs.toFixed(1)}ms`);
  }
  if (observation.topologyBuildsDelta > maxReopenTopologyBuilds) {
    failures.push(`reopen topology builds=${observation.topologyBuildsDelta}`);
  }
  if (observation.gpuUploadBytesDelta > maxReopenGpuUploadBytes) {
    failures.push(`reopen GPU upload bytes=${observation.gpuUploadBytesDelta}`);
  }
  if (failures.length > 0) {
    throw new Error(`Active 3D teardown lifecycle violated: ${failures.join(" | ")}`);
  }
}

export function assertTeardownLifecycleBudget({ finalSignals, maxConfiguresPerContext }) {
  const counters = finalSignals.debug;
  if (finalSignals.contextLosses > 0) {
    throw new Error(`WebGL context loss count=${finalSignals.contextLosses}`);
  }
  if (counters.canvasContextsCreated !== counters.canvasContextsDisposed + 1) {
    throw new Error("teardown context counts are not balanced with one active root");
  }
  if (counters.canvasEventConnections !== counters.canvasEventDisconnections + 1) {
    throw new Error("teardown event counts are not balanced with one active root");
  }
  if (counters.canvasRootConfigureStarted > counters.canvasContextsCreated * maxConfiguresPerContext) {
    throw new Error("configure generations exceed the teardown budget");
  }
  if (counters.canvasRootConfigureCompleted > counters.canvasRootConfigureStarted) {
    throw new Error("completed configure count exceeds starts");
  }
  if (counters.viewportFrameReasonsDropped > 0 || counters.viewportFrameReasonsOverflowed) {
    throw new Error("viewport frame reason overflow or dropped reason");
  }
}

function classifyViewport3DOnlyRequest(requestUrl, method = "GET") {
  let pathname;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }
  if (
    method === "POST" &&
    pathname.endsWith("/v2/sessions/current/visualization/client-acks")
  ) {
    return "client-ack";
  }
  if (
    /^\/v2\/sessions\/current\/data\/fields\/[^/]+\/samples\/(?:vector|scalar)$/.test(
      pathname,
    )
  ) {
    return "field";
  }
  if (
    pathname.endsWith("/v2/sessions/current/data/domain/topology") ||
    pathname.endsWith("/v2/sessions/current/meshing/meshes/shared-domain/topology")
  ) {
    return "topology";
  }
  return null;
}

async function activateTab(page, moduleId, settleMs) {
  const tab = page.getByRole("tab", {
    exact: true,
    name: CENTER_TAB_TITLES[moduleId],
  });
  await tab.waitFor({ state: "visible", timeout: timeoutMs() });
  await tab.click();
  await page
    .locator(
      `[data-slot-id="viewport-main"][data-active-module-id="${moduleId}"]`,
    )
    .waitFor({ state: "attached", timeout: timeoutMs() });
  await page.waitForTimeout(settleMs);
}

async function readRegisteredTabs(page) {
  return page
    .locator('[data-slot-id="viewport-main"] [role="tab"]')
    .evaluateAll((tabs) =>
      tabs
        .map((tab) => tab.getAttribute("data-value"))
        .filter((value) => typeof value === "string"),
    );
}

async function readActiveModuleId(page) {
  return page
    .locator('[data-slot-id="viewport-main"]')
    .getAttribute("data-active-module-id");
}

async function readViewportSignals(page) {
  return page.evaluate((measurePrefix) => ({
    activeModuleId:
      document
        .querySelector('[data-slot-id="viewport-main"]')
        ?.getAttribute("data-active-module-id") ?? null,
    canvasCount: document.querySelectorAll(".fm-viewport-3d canvas").length,
    rootCount: document.querySelectorAll(".fm-viewport-3d").length,
    viewport3DRenderMeasures: performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith(measurePrefix)).length,
    contextLosses: window.__FULLMAG_VIEWPORT_MAIN_TAB_AUDIT__?.contextLosses ?? 0,
    pendingAnimationFrames:
      window.__FULLMAG_VIEWPORT_MAIN_TAB_AUDIT__?.pendingAnimationFrames?.size ?? 0,
    debug: {
      ...(window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ ?? {
        publishes: 0,
        scans: 0,
        viewportFrames: 0,
      }),
      viewportFrameReasons: {
        ...(window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__?.viewportFrameReasons ?? {}),
      },
    },
  }), THREE_D_RENDER_MEASURE_PREFIX);
}

function counterDelta(after, before) {
  return (after ?? 0) - (before ?? 0);
}

function reasonDeltas(after = {}, before = {}) {
  const reasons = new Set([...Object.keys(after), ...Object.keys(before)]);
  return Object.fromEntries(
    Array.from(reasons)
      .map((reason) => [reason, counterDelta(after[reason], before[reason])])
      .filter(([, delta]) => delta !== 0),
  );
}

async function assertHealthyCanvas(page, label) {
  const canvas = page.locator(THREE_D_CANVAS_SELECTOR);
  await canvas.waitFor({ state: "visible", timeout: timeoutMs() });
  const proof = await canvas.evaluate((element) => {
    const canvas = element;
    const gl =
      canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return {
      canvasHeight: canvas.height,
      canvasWidth: canvas.width,
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      isContextLost: gl?.isContextLost() ?? true,
    };
  });
  if (
    proof.canvasWidth <= 0 ||
    proof.canvasHeight <= 0 ||
    proof.drawingBufferWidth <= 0 ||
    proof.drawingBufferHeight <= 0 ||
    proof.isContextLost
  ) {
    throw new Error(`${label} has an unhealthy WebGL canvas: ${JSON.stringify(proof)}`);
  }
  return proof;
}

async function waitForViewportProfilerMeasure(page) {
  await page.waitForFunction(
    (prefix) =>
      performance
        .getEntriesByType("measure")
        .some((entry) => entry.name.startsWith(prefix)),
    THREE_D_RENDER_MEASURE_PREFIX,
    { timeout: timeoutMs() },
  );
}

async function collectGarbage(cdp) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
}

async function readHeapBytes(page, cdp) {
  try {
    const usage = await cdp.send("Runtime.getHeapUsage");
    if (Number.isFinite(usage.usedSize)) return usage.usedSize;
  } catch {
    // Fall back to the browser memory surface below.
  }
  return page.evaluate(() => {
    const memory = performance.memory;
    return memory && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : null;
  });
}

async function writeReport(outputDir, report) {
  await writeFile(
    path.join(outputDir, "browser-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutMs() {
  return positiveInteger(
    process.env.CONTROL_ROOM_TAB_MEMORY_TIMEOUT_MS,
    30_000,
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
