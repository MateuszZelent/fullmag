import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  captureViewportPerformanceSnapshot,
  installViewportPerformanceProbe,
} from "./lib/viewport-performance-proof.mjs";

const NOT_MEASURED = "NOT MEASURED";
const CANONICAL_LANE_IDS = Object.freeze([
  "fdm-single-grid",
  "fdm-multilayer",
  "fem",
]);
const MINIMUM_TARGET_COUNT = 3;
const QUANTITY_SWITCH_SEQUENCE = Object.freeze([
  "m",
  "H_eff",
  "H_demag",
  "H_ext",
]);
const REQUIRED_TRIAL_METRICS = Object.freeze([
  "bytes",
  "requestDurationMs",
  "pointCount",
  "decodeMs",
  "transferMs",
  "workerMs",
  "glyphMs",
  "gpuUploadMs",
  "firstGlyphMs",
  "longTaskCount",
  "longTaskTotalMs",
  "dirtyFrames",
  "drawCalls",
  "heapBytes",
  "webglDrawingBufferPixels",
  "webglHealthy",
  "workers",
  "workerJobs",
  "workerTimers",
  "workerActiveLeases",
  "fallbackCount",
  "fallbackReasons",
]);
const SUMMARY_NUMERIC_METRICS = Object.freeze(
  REQUIRED_TRIAL_METRICS.filter((metric) => metric !== "webglHealthy" && metric !== "fallbackReasons"),
);
const configuredUrl = process.env.CONTROL_ROOM_URL;
const artifactDirectory = path.resolve(
  process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ??
    ".artifacts/airbox-vector-cold-toggle",
);
const trialsPerTemperature = minimumCountEnv("CONTROL_ROOM_AUDIT_TRIALS", 20);
const rapidToggleCount = minimumCountEnv(
  "CONTROL_ROOM_AUDIT_RAPID_TOGGLES",
  50,
);
const quantitySwitchCount = minimumCountEnv(
  "CONTROL_ROOM_AUDIT_QUANTITY_SWITCHES",
  100,
);
const surfaceTransitionCount = minimumCountEnv(
  "CONTROL_ROOM_AUDIT_SURFACE_TRANSITIONS",
  100,
);
const vectorBuildTimeoutMs = positiveIntegerEnv(
  "CONTROL_ROOM_AUDIT_VECTOR_BUILD_TIMEOUT_MS",
  20_000,
);

if (!configuredUrl) {
  throw new Error(
    "CONTROL_ROOM_URL is required; this qualification never starts or stops an external dev server.",
  );
}

const laneEntries = resolveLaneEntries();

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return await import("@playwright/test");
  }
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  throw new Error("Playwright/Chromium is required for Airbox qualification.");
}

await mkdir(artifactDirectory, { recursive: true });
const browser = await playwright.chromium.launch({
  args: ["--js-flags=--expose-gc"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
await installViewportPerformanceProbe(page);
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable").catch(() => undefined);
await cdp.send("Performance.enable").catch(() => undefined);
const responseSamples = [];
const requestStarts = new Map();

await installBrowserAuditInstrumentation(page);

page.on("request", (request) => {
  if (isFieldVectorRequest(request.url())) {
    requestStarts.set(request, Date.now());
  }
});
page.on("response", async (response) => {
  if (!isFieldVectorRequest(response.url())) return;
  await response.finished().catch(() => undefined);
  const headers = response.headers();
  const startedAtMs = requestStarts.get(response.request());
  requestStarts.delete(response.request());
  responseSamples.push({
    bytes: numericHeader(headers, ["content-length", "x-fullmag-byte-length"]),
    durationMs:
      typeof startedAtMs === "number"
        ? Math.max(0, Date.now() - startedAtMs)
        : NOT_MEASURED,
    pointCount: numericHeader(headers, ["x-fullmag-point-count"]),
    status: response.status(),
    url: response.url(),
  });
});

const metrics = [];
const rawPerformanceTrace = [];
const rapidToggleReports = [];
const quantitySwitchReports = [];
const surfaceTransitionReports = [];
let runError = null;
try {
  for (const lane of laneEntries) {
    await page.goto(lane.url, { waitUntil: "domcontentloaded" });
    rawPerformanceTrace.push(
      await captureViewportPerformanceSnapshot(page, `lane:${lane.id}:loaded`),
    );
    await waitForAuditHooks(page);
    await waitForCanvas(page);

    for (const warm of [false, true]) {
      for (let trial = 0; trial < trialsPerTemperature; trial += 1) {
        if (!warm) {
          await cdp.send("Network.clearBrowserCache").catch(() => undefined);
        }
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForAuditHooks(page);
        await waitForCanvas(page);
        const trialSample = await runVectorToggleTrial({
            cdp,
            lane,
            page,
            trial,
            warm,
          });
        assertRequiredTrialMetrics(trialSample);
        metrics.push(trialSample);
      }
    }

    quantitySwitchReports.push(
      await runQuantitySwitchAudit({
        lane,
        page,
        count: quantitySwitchCount,
      }),
    );
    rapidToggleReports.push(
      await runRapidVectorToggleAudit({ lane, page, count: rapidToggleCount }),
    );
    surfaceTransitionReports.push(
      await runSurfaceTransitionAudit({
        lane,
        page,
        count: surfaceTransitionCount,
      }),
    );
    rawPerformanceTrace.push(
      await captureViewportPerformanceSnapshot(page, `lane:${lane.id}:complete`),
    );
  }
} catch (error) {
  runError = error;
} finally {
  await browser.close();
}

if (runError) throw runError;

const report = {
  generatedAt: new Date().toISOString(),
  lanes: laneEntries.map(({ id }) => id),
  measurementContract: {
    unavailableMetric: NOT_MEASURED,
    requiredTrialMetrics: REQUIRED_TRIAL_METRICS,
    requiredTrialsPerTemperature: 20,
    diagnosticSource:
      "window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__().streams plus browser WebGL/RAF instrumentation",
    webglGate:
      "canvas visible, gl.isContextLost() === false, drawingBufferWidth/Height > 0",
    wireframeVectorOrder: "wireframe on -> wireframe off -> vectors on",
  },
  laneMatrix: laneEntries.map(({ id, quantityId }) => ({ id, quantityId })),
  rapidToggles: rapidToggleReports,
  quantitySwitches: quantitySwitchReports,
  surfaceTransitions: surfaceTransitionReports,
  trialsPerTemperature,
  missingMetrics: metrics.flatMap((sample) =>
    collectMissingTrialMetrics(sample).map((metric) => ({
      lane: sample.lane,
      metric,
      trial: sample.trial,
      warm: sample.warm,
    })),
  ),
  metrics,
  rawPerformanceTrace,
  summary: Object.fromEntries(
    laneEntries.map(({ id }) => [
      id,
      summarize(metrics.filter((sample) => sample.lane === id)),
    ]),
  ),
};
const outputPath = path.join(artifactDirectory, "airbox-vector-cold-toggle.json");
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Airbox vector qualification report: ${outputPath}`);

async function runVectorToggleTrial({ cdp: trialCdp, lane, page: trialPage, trial, warm }) {
  const canvas = trialPage.locator(".fm-viewport-3d canvas");
  const responseOffset = responseSamples.length;
  await setActiveViewport3D(trialPage);
  await setGlobalQuantity(trialPage, lane.quantityId);

  const trialStartClock = await readClockSnapshot(trialPage);
  const trialStart = trialStartClock.performanceNow;
  const countersAtStart = await readBrowserCounters(trialPage);
  const initialArtifact = await readDiagnosticArtifact(trialPage);

  await applyVisualizationPhase(trialPage, "wireframe-on");
  const wireframeOn = await samplePhase(trialPage);
  assertHealthyWebgl(wireframeOn.webgl, `${lane.id} trial ${trial} wireframe-on`);
  assertWireframeVectorFrame(wireframeOn.state, true, false, lane.id, trial);

  await applyVisualizationPhase(trialPage, "wireframe-off");
  const wireframeOff = await samplePhase(trialPage);
  assertHealthyWebgl(wireframeOff.webgl, `${lane.id} trial ${trial} wireframe-off`);
  assertWireframeVectorFrame(wireframeOff.state, false, false, lane.id, trial);

  const vectorStartClock = await readClockSnapshot(trialPage);
  const vectorStart = vectorStartClock.performanceNow;
  await applyVisualizationPhase(trialPage, "vectors-on");
  const vectorOnState = await readVisualizationState(trialPage);
  const vectorOnWebgl = await readWebglStatus(canvas);
  assertHealthyWebgl(vectorOnWebgl, `${lane.id} trial ${trial} vectors-on`);
  assertWireframeVectorFrame(vectorOnState, false, true, lane.id, trial);
  const vectorBuildObserved = await waitForVectorBuild(
    trialPage,
    vectorStart,
    warm ? Math.min(vectorBuildTimeoutMs, 2_000) : vectorBuildTimeoutMs,
  );
  await trialPage.waitForTimeout(vectorBuildObserved ? 0 : 150);

  const trialEndClock = await readClockSnapshot(trialPage);
  const trialEnd = trialEndClock.performanceNow;
  const [countersAtEnd, diagnosticArtifact, heapBytes, runtime, webgl] =
    await Promise.all([
      readBrowserCounters(trialPage),
      readDiagnosticArtifact(trialPage),
      readHeapBytes(trialCdp),
      readViewportAuditRuntime(trialPage),
      readWebglStatus(canvas),
    ]);
  assertHealthyWebgl(webgl, `${lane.id} trial ${trial}`);

  const responses = responseSamples.slice(responseOffset);
  const diagnostics = extractDiagnosticMetrics(
    diagnosticArtifact ?? initialArtifact,
    trialStart,
    trialEnd,
    {
      epochStart: trialStartClock.epochNow,
      epochEnd: trialEndClock.epochNow,
    },
  );
  const vectorDiagnostics = extractDiagnosticMetrics(
    diagnosticArtifact ?? initialArtifact,
    vectorStart,
    trialEnd,
    {
      epochStart: vectorStartClock.epochNow,
      epochEnd: trialEndClock.epochNow,
    },
  );
  const firstGlyphMs = vectorDiagnostics.firstGlyphMs;
  if (firstGlyphMs === NOT_MEASURED) {
    throw new Error(
      `${warm ? "Warm" : "Cold"} ${lane.id} trial ${trial} produced no ready vector-glyph diagnostic record. ` +
        `The browser gate refuses to infer first-glyph timing from a fixed sleep.`,
    );
  }

  const longTasksMs = await readLongTasks(trialPage, trialStart, trialEnd);
  const request = summarizeResponses(responses);
  const webglHealthy = isHealthyWebgl(webgl);
  const webglDrawingBufferPixels =
    typeof webgl?.drawingBufferWidth === "number" &&
    Number.isFinite(webgl.drawingBufferWidth) &&
    typeof webgl?.drawingBufferHeight === "number" &&
    Number.isFinite(webgl.drawingBufferHeight)
      ? webgl.drawingBufferWidth * webgl.drawingBufferHeight
      : NOT_MEASURED;
  const workerRuntime = runtime.workers ?? {};

  return {
    lane: lane.id,
    quantityId: lane.quantityId,
    trial,
    warm,
    firstGlyphMs,
    bytes: request.bytes,
    requestDurationMs: request.durationMs,
    requestCount: request.count,
    decodeMs: diagnostics.decodeMs,
    dirtyFrames: diagnostics.dirtyFrames,
    drawCalls: diffCounter(
      countersAtStart,
      countersAtEnd,
      "drawCalls",
      "drawCallsInstrumented",
    ),
    fallbackCount: vectorDiagnostics.fallbackCount,
    fallbackReasons: vectorDiagnostics.fallbackReasons,
    glyphMs: vectorDiagnostics.glyphMs,
    gpuUploadMs: vectorDiagnostics.gpuUploadMs,
    heapBytes,
    longTaskCount: Array.isArray(longTasksMs) ? longTasksMs.length : NOT_MEASURED,
    longTaskTotalMs: Array.isArray(longTasksMs)
      ? sumNumbers(longTasksMs)
      : NOT_MEASURED,
    longTasksMs,
    pointCount: resolvePointCount(vectorDiagnostics, responses),
    request,
    rafFrames: diffCounter(countersAtStart, countersAtEnd, "rafFrames"),
    runtime,
    transferMs: vectorDiagnostics.transferMs,
    vectorBuildObserved,
    webgl,
    webglDrawingBufferPixels,
    webglHealthy,
    workerActiveLeases: numericOrNotMeasured(workerRuntime.activeLeases),
    workerJobs: numericOrNotMeasured(workerRuntime.jobs),
    workerTimers: numericOrNotMeasured(workerRuntime.timers),
    workers: numericOrNotMeasured(workerRuntime.workers),
    workerMs: vectorDiagnostics.workerMs,
    wireframeOn,
    wireframeOff,
    gpuBufferBytesUploaded: diffCounter(
      countersAtStart,
      countersAtEnd,
      "bufferBytesUploaded",
      "bufferBytesInstrumented",
    ),
  };
}

async function runQuantitySwitchAudit({ lane, page, count }) {
  const before = await readBrowserCounters(page);
  const start = await readPerformanceNow(page);
  const targetIdsSeen = new Set();
  const switches = [];
  let previousQuantity = null;

  for (let index = 0; index < count; index += 1) {
    const quantityId = QUANTITY_SWITCH_SEQUENCE[index % QUANTITY_SWITCH_SEQUENCE.length];
    if (quantityId === previousQuantity) {
      throw new Error(
        `Quantity audit generated a non-changing quantity at switch ${index} for ${lane.id}.`,
      );
    }
    previousQuantity = quantityId;
    await setGlobalQuantity(page, quantityId);
    await waitForGlobalQuantity(page, quantityId);
    const state = await readVisualizationState(page);
    const targetIds = resolveTargetIds(state);
    if (targetIds.length < MINIMUM_TARGET_COUNT) {
      throw new Error(
        `Quantity audit requires at least ${MINIMUM_TARGET_COUNT} targets for ${lane.id}; ` +
          `observed ${targetIds.length} at switch ${index}.`,
      );
    }
    for (const targetId of targetIds) targetIdsSeen.add(targetId);
    const webgl = await readWebglStatus(page.locator(".fm-viewport-3d canvas"));
    assertHealthyWebgl(webgl, `${lane.id} quantity switch ${index}`);
    switches.push({ index, quantityId, targetCount: targetIds.length, targetIds, webgl });
  }

  if (targetIdsSeen.size < MINIMUM_TARGET_COUNT) {
    throw new Error(
      `Quantity audit observed fewer than ${MINIMUM_TARGET_COUNT} distinct targets for ${lane.id}.`,
    );
  }
  const after = await readBrowserCounters(page);
  return {
    count,
    distinctQuantityCount: new Set(switches.map((entry) => entry.quantityId)).size,
    durationMs: Math.max(0, (await readPerformanceNow(page)) - start),
    drawCalls: diffCounter(
      before,
      after,
      "drawCalls",
      "drawCallsInstrumented",
    ),
    lane: lane.id,
    rafFrames: diffCounter(before, after, "rafFrames"),
    targetCount: targetIdsSeen.size,
    targetIds: Array.from(targetIdsSeen).sort(),
    switches,
  };
}

async function runRapidVectorToggleAudit({ lane, page, count }) {
  const before = await readBrowserCounters(page);
  const start = await readPerformanceNow(page);
  for (let index = 0; index < count; index += 1) {
    await applyVisualizationPhase(page, index % 2 === 0 ? "vectors-on" : "vectors-off");
  }
  await applyVisualizationPhase(page, "vectors-on");
  const webgl = await readWebglStatus(page.locator(".fm-viewport-3d canvas"));
  assertHealthyWebgl(webgl, `${lane.id} rapid toggles`);
  const after = await readBrowserCounters(page);
  return {
    count,
    durationMs: Math.max(0, (await readPerformanceNow(page)) - start),
    drawCalls: diffCounter(
      before,
      after,
      "drawCalls",
      "drawCallsInstrumented",
    ),
    lane: lane.id,
    rafFrames: diffCounter(before, after, "rafFrames"),
    webgl,
  };
}

async function runSurfaceTransitionAudit({ lane, page, count }) {
  const transitions = [];
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => {
      const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
      hook.setActiveViewportModule("field-map");
    });
    await page.waitForFunction(
      () => window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readActiveViewportModule?.() === "field-map",
    );
    await page.locator(".fm-viewport-3d canvas").waitFor({
      state: "detached",
      timeout: vectorBuildTimeoutMs,
    });
    await page.evaluate(() => {
      const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
      hook.setActiveViewportModule("viewport-3d");
    });
    await waitForCanvas(page);
    const webgl = await readWebglStatus(page.locator(".fm-viewport-3d canvas"));
    assertHealthyWebgl(webgl, `${lane.id} 3D/2D transition ${index}`);
    transitions.push({ index, webgl });
  }
  return { count, lane: lane.id, transitions };
}

async function installBrowserAuditInstrumentation(page) {
  await page.addInitScript(() => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      diagnosticRecorderProfile: "forensic",
      diagnosticRecorderScenario: "airbox-vector-cold-toggle",
      enableAuditHooks: true,
      enableDiagnosticRecorder: true,
    };

    const counters = {
      bufferBytesUploaded: 0,
      buffersCreated: 0,
      buffersDeleted: 0,
      drawCalls: 0,
      drawCallsInstrumented: false,
      rafFrames: 0,
      bufferBytesInstrumented: false,
    };
    window.__FULLMAG_AIRBOX_VECTOR_AUDIT__ = counters;

    const originalRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      originalRaf((timestamp) => {
        counters.rafFrames += 1;
        callback(timestamp);
      });

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = originalGetContext.apply(this, args);
      if (
        !context ||
        !["webgl", "webgl2", "experimental-webgl"].includes(String(args[0]))
      ) {
        return context;
      }
      const gl = context;
      if (gl.__fullmagAirboxAuditWrapped) return gl;
      gl.__fullmagAirboxAuditWrapped = true;
      for (const name of [
        "createBuffer",
        "deleteBuffer",
        "drawArrays",
        "drawElements",
        "drawArraysInstanced",
        "drawElementsInstanced",
      ]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        try {
          gl[name] = function (...methodArgs) {
            if (name === "createBuffer") counters.buffersCreated += 1;
            if (name === "deleteBuffer") counters.buffersDeleted += 1;
            if (name.startsWith("draw")) {
              counters.drawCallsInstrumented = true;
              counters.drawCalls += 1;
            }
            return original.apply(this, methodArgs);
          };
        } catch {
          // Some Chromium contexts expose non-writable methods. The WebGL
          // health gate still runs; unavailable counters remain NOT MEASURED.
        }
      }
      for (const name of ["bufferData", "bufferSubData"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        try {
          gl[name] = function (...methodArgs) {
            counters.bufferBytesInstrumented = true;
            const data = methodArgs[1];
            if (typeof data === "number") counters.bufferBytesUploaded += data;
            else if (data && typeof data.byteLength === "number") {
              counters.bufferBytesUploaded += data.byteLength;
            }
            return original.apply(this, methodArgs);
          };
        } catch {
          // See the method-wrapping note above.
        }
      }
      return gl;
    };
  });
}

async function waitForAuditHooks(page) {
  await page.waitForFunction(
    () =>
      typeof window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditRuntime ===
        "function" &&
      typeof window.__FULLMAG_CONTROL_ROOM_AUDIT__?.patchVisualization ===
        "function" &&
      typeof window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__ === "function",
    undefined,
    { timeout: 20_000 },
  );
}

async function waitForCanvas(page) {
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 20_000 });
  await assertWebgl(canvas);
}

async function setActiveViewport3D(page) {
  await page.evaluate(() => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
    hook.setActiveViewportModule("viewport-3d");
  });
  await waitForCanvas(page);
}

async function setGlobalQuantity(page, quantityId) {
  await page.evaluate(async (quantity) => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
    await hook.setGlobalQuantity(quantity);
  }, quantityId);
}

async function waitForGlobalQuantity(page, quantityId) {
  await page.waitForFunction(
    (expectedQuantityId) => {
      const resource = window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource?.(
        "/v2/sessions/current/visualization/state",
      );
      const visualization = resource?.data?.data ?? resource?.data;
      return (
        visualization?.quantity?.active_quantity_id === expectedQuantityId ||
        visualization?.active_quantity_id === expectedQuantityId
      );
    },
    quantityId,
    { timeout: 15_000 },
  );
}

const PHASE_PATCHES = {
  "wireframe-on": {
    layers: {
      airbox: {
        vectors: { domain: "airbox_only", visible: false },
        wireframe: { visible: true },
      },
      vectors: { visible: false },
      wireframe: { visible: true },
    },
  },
  "wireframe-off": {
    layers: {
      airbox: {
        vectors: { domain: "airbox_only", visible: false },
        wireframe: { visible: false },
      },
      vectors: { visible: false },
      wireframe: { visible: false },
    },
  },
  "vectors-on": {
    layers: {
      airbox: {
        vectors: { domain: "airbox_only", visible: true },
        wireframe: { visible: false },
      },
      vectors: { visible: false },
      wireframe: { visible: false },
    },
  },
  "vectors-off": {
    layers: {
      airbox: {
        vectors: { domain: "airbox_only", visible: false },
        wireframe: { visible: false },
      },
      vectors: { visible: false },
      wireframe: { visible: false },
    },
  },
};

async function applyVisualizationPhase(page, phase) {
  const patch = PHASE_PATCHES[phase];
  if (!patch) throw new Error(`Unknown Airbox audit phase: ${phase}`);
  await page.evaluate(async (nextPatch) => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
    await hook.patchVisualization(nextPatch);
  }, patch);
  const expected = {
    airboxVectors: phase === "vectors-on",
    airboxWireframe: phase === "wireframe-on",
    vectors: false,
    wireframe: phase === "wireframe-on",
  };
  await page.waitForFunction(
    (state) => {
      const resource = window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource?.(
        "/v2/sessions/current/visualization/state",
      );
      const visualization = resource?.data?.data ?? resource?.data;
      return Boolean(
        visualization &&
          visualization.layers?.airbox?.vectors?.visible === state.airboxVectors &&
          visualization.layers?.airbox?.wireframe?.visible === state.airboxWireframe &&
          visualization.layers?.vectors?.visible === state.vectors &&
          visualization.layers?.wireframe?.visible === state.wireframe,
      );
    },
    expected,
    { timeout: 15_000 },
  );
  await waitForAnimationFrames(page, 2);
}

async function samplePhase(page) {
  return {
    counters: await readBrowserCounters(page),
    state: await readVisualizationState(page),
    webgl: await readWebglStatus(page.locator(".fm-viewport-3d canvas")),
  };
}

function assertWireframeVectorFrame(state, wireframe, vectors, lane, trial) {
  const visualization = state?.data ?? state;
  const actual = {
    vectors: visualization?.layers?.airbox?.vectors?.visible === true,
    wireframe: visualization?.layers?.airbox?.wireframe?.visible === true,
  };
  if (actual.wireframe !== wireframe || actual.vectors !== vectors) {
    throw new Error(
      `Airbox phase ordering failed for ${lane} trial ${trial}: expected ` +
        `wireframe=${wireframe}, vectors=${vectors}; got ${JSON.stringify(actual)}.`,
    );
  }
}

async function waitForVectorBuild(page, startTime, timeoutMs) {
  try {
    await page.waitForFunction(
      (startedAt) => {
        const artifact = window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.();
        return Boolean(
          artifact?.streams?.viewport3dBuild?.some(
            (record) =>
              record.buildLane === "vector-glyph" &&
              record.buildState === "ready" &&
              record.timestampMs >= startedAt,
          ),
        );
      },
      startTime,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

async function readPerformanceNow(page) {
  return page.evaluate(() => performance.now());
}

async function readClockSnapshot(page) {
  return page.evaluate(() => ({
    epochNow: Date.now(),
    performanceNow: performance.now(),
  }));
}

async function readBrowserCounters(page) {
  return page.evaluate(() => ({
    ...(window.__FULLMAG_AIRBOX_VECTOR_AUDIT__ ?? {}),
  }));
}

async function readDiagnosticArtifact(page) {
  return page.evaluate(() => window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.() ?? null);
}

async function readViewportAuditRuntime(page) {
  return page.evaluate((unavailableMetric) => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
    const runtime = hook.readViewportAuditRuntime();
    const numeric = (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? value
        : unavailableMetric;
    return {
      resources: {
        entries: numeric(runtime.resources?.entryCount),
        listeners: numeric(runtime.resources?.listenerCount),
      },
      visualizationRevision: runtime.visualizationRevision ?? unavailableMetric,
      workers: {
        activeLeases: numeric(runtime.workers?.activeLeases),
        jobs: numeric(runtime.workers?.jobs),
        timers: numeric(runtime.workers?.timers),
        workers: numeric(runtime.workers?.workers),
      },
    };
  }, NOT_MEASURED);
}

async function readVisualizationState(page) {
  return page.evaluate(() => {
    const resource = window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource?.(
      "/v2/sessions/current/visualization/state",
    );
    return resource?.data?.data ?? resource?.data ?? null;
  });
}

function resolveTargetIds(state) {
  const visualization = state?.data ?? state;
  const targets = visualization?.targets;
  const entries = [
    targets?.airbox,
    ...(Array.isArray(targets?.objects) ? targets.objects : []),
    ...(Array.isArray(targets?.parts) ? targets.parts : []),
  ].filter((entry) => entry && typeof entry === "object");
  return entries
    .map((entry) => entry.scope_id ?? entry.id ?? entry.label)
    .filter((targetId) => typeof targetId === "string" && targetId.length > 0);
}

async function readWebglStatus(canvas) {
  return canvas.evaluate((element) => {
    const gl = element.getContext("webgl2") ?? element.getContext("webgl");
    return gl
      ? {
          contextLost: gl.isContextLost(),
          drawingBufferHeight: gl.drawingBufferHeight,
          drawingBufferWidth: gl.drawingBufferWidth,
        }
      : { contextLost: true, drawingBufferHeight: 0, drawingBufferWidth: 0 };
  });
}

async function assertWebgl(canvas) {
  const status = await readWebglStatus(canvas);
  assertHealthyWebgl(status, "initial viewport");
  return status;
}

function assertHealthyWebgl(status, label) {
  if (!isHealthyWebgl(status)) {
    throw new Error(`WebGL qualification failed for ${label}: ${JSON.stringify(status)}`);
  }
}

function isHealthyWebgl(status) {
  return Boolean(
    status &&
      status.contextLost === false &&
      typeof status.drawingBufferWidth === "number" &&
      status.drawingBufferWidth > 0 &&
      typeof status.drawingBufferHeight === "number" &&
      status.drawingBufferHeight > 0,
  );
}

async function waitForAnimationFrames(page, count) {
  await page.evaluate(
    (frameCount) =>
      new Promise((resolve) => {
        let remaining = frameCount;
        const next = () => {
          remaining -= 1;
          if (remaining <= 0) resolve(undefined);
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
    count,
  );
}

function extractDiagnosticMetrics(
  artifact,
  startTime,
  endTime,
  { epochStart = null, epochEnd = null } = {},
) {
  const records = Object.values(artifact?.streams ?? {})
    .flat()
    .filter(
      (record) =>
        typeof record?.timestampMs === "number" &&
        timestampInWindow(record.timestampMs, startTime, endTime, epochStart, epochEnd),
    );
  const buildRecords = records.filter(
    (record) => record.kind === "viewport-3d-build-job",
  );
  const vectorRecords = buildRecords.filter(
    (record) => record.buildLane === "vector-glyph",
  );
  const uploadRecords = buildRecords.filter(
    (record) =>
      record.buildLane === "gpu-upload" || record.buildLane?.endsWith("-upload"),
  );
  const decodeRecords = records.filter((record) => record.kind === "binary-decode");
  const viewportRecords = records.filter((record) => record.kind === "viewport-3d");
  const dirtyFrameRecords = viewportRecords.filter(
    (record) =>
      typeof record.dirtyReason === "string" &&
      record.dirtyReason.length > 0,
  );
  const readyVector = vectorRecords
    .filter((record) => record.buildState === "ready")
    .sort((left, right) => left.timestampMs - right.timestampMs)[0];
  const fallbackReasons = vectorRecords
    .map((record) => record.fallbackReason)
    .filter((reason) => typeof reason === "string" && reason.length > 0);
  const readyVectorStart =
    isEpochTimestamp(readyVector?.timestampMs) && typeof epochStart === "number"
      ? epochStart
      : startTime;
  return {
    decodeMs: sumMetric(decodeRecords.map((record) => record.durationMs)),
    dirtyFrames:
      viewportRecords.length > 0 ? dirtyFrameRecords.length : NOT_MEASURED,
    firstGlyphMs:
      readyVector && typeof readyVector.timestampMs === "number"
        ? Math.max(
            0,
            readyVector.timestampMs - readyVectorStart,
          )
        : NOT_MEASURED,
    fallbackCount: vectorRecords.length > 0 ? fallbackReasons.length : NOT_MEASURED,
    fallbackReasons:
      vectorRecords.length > 0 ? fallbackReasons : NOT_MEASURED,
    glyphMs: sumMetric(
      vectorRecords.map((record) => record.totalWallMs ?? record.durationMs),
    ),
    gpuUploadMs: sumMetric(uploadRecords.map((record) => record.mainUploadMs)),
    pointCount: readyVector
      ? numericOrNotMeasured(readyVector.itemCount)
      : NOT_MEASURED,
    transferMs: sumMetric(vectorRecords.map((record) => record.transferMs)),
    workerMs: sumMetric(vectorRecords.map((record) => record.workerComputeMs)),
  };
}

function timestampInWindow(timestamp, startTime, endTime, epochStart, epochEnd) {
  if (timestamp >= startTime && timestamp <= endTime) return true;
  return (
    typeof epochStart === "number" &&
    typeof epochEnd === "number" &&
    timestamp >= epochStart &&
    timestamp <= epochEnd
  );
}

function isEpochTimestamp(timestamp) {
  return timestamp >= 1_000_000_000_000;
}

function resolvePointCount(diagnostics, responses) {
  if (diagnostics.pointCount !== NOT_MEASURED) return diagnostics.pointCount;
  const responsePointCounts = responses
    .map((response) => response.pointCount)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return responsePointCounts.length === responses.length && responses.length > 0
    ? Math.max(...responsePointCounts)
    : NOT_MEASURED;
}

function summarizeResponses(responses) {
  const bytes = responses.map((response) => response.bytes);
  const durations = responses.map((response) => response.durationMs);
  const missingMetrics = [];
  if (responses.length === 0) {
    missingMetrics.push("response.bytes", "response.durationMs");
  }
  bytes.forEach((value, index) => {
    if (value === NOT_MEASURED) missingMetrics.push(`response[${index}].bytes`);
  });
  durations.forEach((value, index) => {
    if (value === NOT_MEASURED) {
      missingMetrics.push(`response[${index}].durationMs`);
    }
  });
  return {
    bytes: sumMetric(bytes),
    count: responses.length,
    durationMs: sumMetric(durations),
    missingMetrics,
    statuses: responses.map((response) => response.status),
  };
}

async function readLongTasks(page, startTime, endTime) {
  return page.evaluate(
    ({ from, to, unavailableMetric }) => {
      if (typeof performance.getEntriesByType !== "function") {
        return unavailableMetric;
      }
      return performance
        .getEntriesByType("longtask")
        .filter((entry) => entry.startTime >= from && entry.startTime <= to)
        .map((entry) => entry.duration);
    },
    { from: startTime, to: endTime, unavailableMetric: NOT_MEASURED },
  );
}

async function readHeapBytes(cdp) {
  const usage = await cdp.send("Runtime.getHeapUsage").catch(() => null);
  return numericOrNotMeasured(usage?.usedSize);
}

function summarize(samples) {
  return {
    cold: summarizeTemperature(samples.filter((sample) => !sample.warm)),
    warm: summarizeTemperature(samples.filter((sample) => sample.warm)),
  };
}

function summarizeTemperature(samples) {
  const summary = {
    count: samples.length,
  };
  for (const metric of SUMMARY_NUMERIC_METRICS) {
    summary[metric] = summarizeMetric(samples, metric);
  }
  summary.webglHealthy = summarizeBooleanMetric(samples, "webglHealthy");
  summary.fallbackReasons = summarizeFallbackReasons(samples);
  return summary;
}

function summarizeMetric(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    count: values.length,
    p50: values.length > 0 ? percentile(values, 0.5) : NOT_MEASURED,
    p95: values.length > 0 ? percentile(values, 0.95) : NOT_MEASURED,
  };
}

function summarizeBooleanMetric(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => typeof value === "boolean");
  return {
    count: values.length,
    falseCount: values.filter((value) => !value).length,
    trueCount: values.filter(Boolean).length,
  };
}

function summarizeFallbackReasons(samples) {
  const reasons = samples
    .flatMap((sample) => (Array.isArray(sample.fallbackReasons) ? sample.fallbackReasons : []));
  return {
    count: reasons.length,
    values: Array.from(new Set(reasons)).sort(),
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function diffCounter(before, after, field, availabilityField = null) {
  if (
    typeof before?.[field] !== "number" ||
    typeof after?.[field] !== "number" ||
    (availabilityField &&
      (before?.[availabilityField] !== true || after?.[availabilityField] !== true))
  ) {
    return NOT_MEASURED;
  }
  return Math.max(0, after[field] - before[field]);
}

function sumMetric(values) {
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    return NOT_MEASURED;
  }
  return sumNumbers(values);
}

function sumNumbers(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

function numericOrNotMeasured(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : NOT_MEASURED;
}

function collectMissingTrialMetrics(trial) {
  const missing = [];
  for (const metric of REQUIRED_TRIAL_METRICS) {
    const value = trial?.[metric];
    const invalidNumber =
      typeof value === "number" && !Number.isFinite(value);
    const invalidShape =
      value === undefined ||
      value === null ||
      value === NOT_MEASURED ||
      invalidNumber ||
      (metric === "webglHealthy" && typeof value !== "boolean") ||
      (metric === "fallbackReasons" && !Array.isArray(value));
    if (invalidShape) missing.push(metric);
  }
  for (const metric of trial?.request?.missingMetrics ?? []) {
    missing.push(metric);
  }
  return Array.from(new Set(missing));
}

function assertRequiredTrialMetrics(trial) {
  const missing = collectMissingTrialMetrics(trial);
  if (missing.length > 0) {
    throw new Error(
      `Airbox qualification is missing required metrics for ${trial?.lane ?? "unknown"} ` +
        `trial ${trial?.trial ?? "unknown"} (${trial?.warm ? "warm" : "cold"}): ${missing.join(", ")}`,
    );
  }
  return trial;
}

function numericHeader(headers, names) {
  for (const name of names) {
    const value = Number(headers[name]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return NOT_MEASURED;
}

function isFieldVectorRequest(url) {
  return url.includes("/data/fields/") && url.includes("/samples/vector");
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function minimumCountEnv(name, minimum) {
  const value = Number(process.env[name] ?? minimum);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}; got ${process.env[name] ?? "unset"}.`);
  }
  return value;
}

function resolveLaneEntries() {
  const raw = process.env.CONTROL_ROOM_AUDIT_LANE_URLS;
  if (!raw) {
    throw new Error(
      `CONTROL_ROOM_AUDIT_LANE_URLS is required and must define ${CANONICAL_LANE_IDS.join(", ")}.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `CONTROL_ROOM_AUDIT_LANE_URLS must be JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CONTROL_ROOM_AUDIT_LANE_URLS must be a JSON object.");
  }
  const unexpectedLanes = Object.keys(parsed).filter(
    (id) => !CANONICAL_LANE_IDS.includes(id),
  );
  if (unexpectedLanes.length > 0) {
    throw new Error(
      `CONTROL_ROOM_AUDIT_LANE_URLS contains unexpected lanes: ${unexpectedLanes.join(", ")}.`,
    );
  }
  return CANONICAL_LANE_IDS.map((id) => {
    const laneUrl = parsed[id];
    if (typeof laneUrl !== "string" || laneUrl.length === 0) {
      throw new Error(`Missing required audit lane ${id}.`);
    }
    return { id, quantityId: quantityForLane(id), url: laneUrl };
  });
}

function quantityForLane(lane) {
  return lane === "fem" ? "m" : "H_demag";
}
