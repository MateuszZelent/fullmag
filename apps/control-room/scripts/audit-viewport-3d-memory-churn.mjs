import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import {
  FIELD_GRID,
  FDM_PARTIAL_ACTIVE_MASK,
  FDM_PARTIAL_INACTIVE_CELL_INDICES,
  FDM_PARTIAL_LAYER_ID,
  applyPatch,
  createFdmFixture,
  currentFixtureQuantity,
  fdmMultilayerActiveMaskPath,
  installFdmFixtureApi,
} from "./lib/ready-fdm-viewport-fixture.mjs";
import {
  assertNoSettledR3FFrames,
  assertQuantitySwitchPerformanceDelta,
  assertViewportPerformanceTrace,
  captureViewportPerformanceSnapshot,
  installViewportPerformanceProbe,
} from "./lib/viewport-performance-proof.mjs";

const configuredUrl = process.env.CONTROL_ROOM_URL ?? null;
const requestedAuditPort = Number(process.env.CONTROL_ROOM_AUDIT_PORT ?? 0);
const auditArtifactsDirectory = path.resolve(
  process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ??
    ".artifacts/viewport-3d-browser-audit",
);
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081";

// The gate measures ownership/lifecycle across many real WebGL uploads, not
// throughput at production field sizes. Keep the fixture dense enough to
// exercise every pass while bounded enough for 120 rendered transitions in CI.
const QUANTITY_SEQUENCE = Array.from(
  { length: 120 },
  (_, index) => ["m", "H_eff", "H_demag", "H_ex"][index % 4],
);
const WARM_QUANTITIES = ["m", "H_eff", "H_demag", "H_ex"];
const FDM_READY_OBJECT_TARGET_ID = "object:fdm-ready-box";
const FDM_READY_OBJECT_SCOPE_ID = FDM_READY_OBJECT_TARGET_ID.slice("object:".length);
const FDM_NEUTRAL_SURFACE_COLOR = "#d752a7";
const MAX_NEUTRAL_PIXEL_SAMPLE_PREFIX = 64;
const MAX_NEUTRAL_PIXEL_HISTOGRAM_ENTRIES = 16;
const MAX_NEUTRAL_PIXEL_MATCH_COORDINATES = 32;
const MAX_NEUTRAL_PIXEL_CHANGED_COORDINATES = 32;
const MAX_NEUTRAL_PIXEL_NEAREST_COLORS = 8;
const MAX_NEUTRAL_PNG_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_HEAP_GROWTH_BYTES = 25 * 1024 * 1024;
const QUANTITY_SWITCH_TIMEOUT_MS = 20_000;
const MAX_GPU_LIFECYCLE_TIMELINE_ENTRIES = 256;
const MAX_INSTANCE_COLOR_LIFECYCLE_EVENTS = 512;
const injectDroppedPublication =
  process.env.CONTROL_ROOM_AUDIT_INJECT_DROPPED_PUBLICATION === "1";
const injectBlankScene = process.env.CONTROL_ROOM_AUDIT_INJECT_BLANK_SCENE === "1";
const injectListenerLeak = process.env.CONTROL_ROOM_AUDIT_INJECT_LISTENER_LEAK === "1";
const injectIdleLoop = process.env.CONTROL_ROOM_AUDIT_INJECT_IDLE_LOOP === "1";
const injectWorkerLeak = process.env.CONTROL_ROOM_AUDIT_INJECT_WORKER_LEAK === "1";
const injectGpuBufferLeak =
  process.env.CONTROL_ROOM_AUDIT_INJECT_GPU_BUFFER_LEAK === "1";

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

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error(
    "Viewport 3D memory-churn audit requires Playwright or @playwright/test.",
  );
  process.exit(2);
}

const managedRuntime = configuredUrl ? null : await startAuditRuntime();
const url = configuredUrl ?? managedRuntime.url;
const browser = await playwright.chromium.launch({
  args: ["--js-flags=--expose-gc"],
});
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
await cdp.send("HeapProfiler.enable").catch(() => undefined);

const errors = [];
const fixtureRequests = [];
const fieldRequests = [];
const topologyRequests = [];
const auditedRequests = [];
// Failed transport URLs are distinct evidence from the viewport's canonical
// resource keys; retain the URL Playwright actually requested for fixture review.
const requestFailureDiagnostics = [];
const visualizationAckRequests = [];
const fixture = createFdmFixture({ trackFieldResponses: true });
let auditActive = false;
let auditPhase = "bootstrap";
const gpuLifecycleTimeline = [];
let gpuLifecycleTimelineDropped = 0;
let fdmSurfaceInstanceColorBeforeStress = null;
let fdmSurfaceInstanceColorStressDelta = null;
let fdmNeutralSurfaceColorProof = null;
let fdmNeutralSurfaceColorDiagnostics = null;

await installFdmFixtureApi(page, fixture, fixtureRequests);
await installBrowserAuditInstrumentation(page);
await installViewportPerformanceProbe(page);
await page.addInitScript(({ baseUrl }) => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    allowMissingSessionSmoke: true,
    controlRoomApiBase: baseUrl,
    disableRealtime: true,
  };
}, { baseUrl: apiBase });

page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (
    text.includes("/v2/sessions/current/events/ws") &&
    text.includes("ERR_CONNECTION_REFUSED")
  ) {
    return;
  }
  errors.push(text);
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("response", (response) => {
  const status = response.status();
  if (status >= 400) errors.push(`${status} ${response.url()}`);
});
page.on("request", (request) => {
  if (
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/v2/sessions/current/visualization/client-acks"
  ) {
    const acknowledgement = request.postDataJSON();
    visualizationAckRequests.push({
      error: acknowledgement.error ?? null,
      observedAtUnixMs: Date.now(),
      phase: auditPhase,
      revision: acknowledgement.revision,
      status: acknowledgement.status,
      viewportId: acknowledgement.viewport_id ?? null,
    });
    if (visualizationAckRequests.length > 512) visualizationAckRequests.shift();
  }
  if (!auditActive) return;
  const requestUrl = request.url();
  auditedRequests.push(`${request.method()} ${requestUrl}`);
  if (requestUrl.includes("/v2/sessions/current/data/fields/")) {
    fieldRequests.push(`${request.method()} ${requestUrl}`);
  }
  if (
    requestUrl.includes("/v2/sessions/current/data/domain/topology") ||
    requestUrl.includes(
      "/v2/sessions/current/meshing/meshes/shared-domain/topology",
    )
  ) {
    topologyRequests.push(`${request.method()} ${requestUrl}`);
  }
});
page.on("requestfailed", (request) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url());
  } catch {
    return;
  }
  if (!requestUrl.pathname.includes("/v2/")) return;
  requestFailureDiagnostics.push({
    error: request.failure()?.errorText ?? "unknown request failure",
    method: request.method(),
    phase: auditPhase,
    scope: {
      component: requestUrl.searchParams.get("component"),
      maxSamples: requestUrl.searchParams.get("max_samples"),
      scopeId: requestUrl.searchParams.get("scope_id"),
      scopeKind: requestUrl.searchParams.get("scope_kind"),
    },
    url: requestUrl.toString(),
  });
});

try {
  await mkdir(auditArtifactsDirectory, { recursive: true });
  const rawPerformanceTrace = [];
  auditLog("goto", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const viewport = page.locator(".fm-viewport-3d");
  const canvas = page.locator(".fm-viewport-3d canvas");
  auditLog("waiting for viewport canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await waitForCanvasReady(canvas);
  auditLog("waiting for diagnostics hud");
  await waitForDiagnostics(viewport);

  auditPhase = "quantity-cache-warmup";
  for (const quantity of WARM_QUANTITIES) {
    auditLog("warming quantity", quantity);
    await withTimeout(
      setGlobalQuantity(page, fixture, fixtureRequests, quantity, {
        allowExistingFieldRequest: true,
        // Bootstrap may have loaded this quantity already, but an empty field
        // cache must never count as a successful warmed-cache audit.
        requireFieldRequest: true,
      }),
      QUANTITY_SWITCH_TIMEOUT_MS,
      `Timed out warming viewport quantity ${quantity}.`,
    );
    await captureGpuLifecycleSnapshot(
      page,
      gpuLifecycleTimeline,
      "warmup-quantity-settled",
      quantity,
    );
  }
  await waitForCondition(
    () => WARM_QUANTITIES.every((quantityId) =>
      fixture.fieldVectorResponses.some((response) =>
        response.quantityId === quantityId &&
        response.status === 200 &&
        /^[a-f0-9]{64}$/.test(response.payloadHash ?? ""),
      ),
    ),
    15_000,
    "Quantity warmup did not receive every canonical binary field payload.",
  );
  const warmedFieldPayloads = WARM_QUANTITIES.map((quantityId) =>
    fixture.fieldVectorResponses.find((response) =>
      response.quantityId === quantityId && response.status === 200,
    ),
  );
  const initialQuantityId = currentFixtureQuantity(fixture);
  const initialFullFieldResponse = fixture.fieldVectorResponses
    .slice()
    .reverse()
    .find((response) =>
      response.quantityId === initialQuantityId &&
      response.status === 200 &&
      response.query?.component === "full" &&
      response.query?.scope_kind === "full",
    );
  if (!initialFullFieldResponse?.etag) {
    throw new Error(
      `FDM field ${initialQuantityId} has no successful full-field response with a recorded payload ETag.`,
    );
  }
  const neutralSurfaceColorResult = await assertFdmNeutralSurfaceColorPixels(
    page,
    fixture,
    viewport,
    initialQuantityId,
    initialFullFieldResponse.etag,
  );
  fdmNeutralSurfaceColorProof = neutralSurfaceColorResult.pixelProof;
  const fdmFieldAdoption = neutralSurfaceColorResult.fieldAdoption;
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "warmup-active-object-adoption",
    initialQuantityId,
  );

  auditLog("reading baseline diagnostics");
  const baseline = {
    diagnostics: await readDiagnostics(viewport),
    gpu: await readBrowserAuditCounters(page),
    runtime: await readViewportAuditRuntime(page),
    heapBytes: await readJsHeapBytes(cdp),
  };
  rawPerformanceTrace.push(await captureViewportPerformanceSnapshot(page, "baseline"));
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "baseline",
    initialQuantityId,
  );

  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "before-initial-unmount",
    currentFixtureQuantity(fixture),
  );
  await page.locator('[data-action-id="ws-2d"]').click();
  await page.locator(".fm-viewport-3d canvas").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(1_000);
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "after-initial-unmount",
    currentFixtureQuantity(fixture),
  );
  const unmountedBaselineRuntime = await readViewportAuditRuntime(page);
  const viewport3DMenuItem = page.getByRole("menuitem", { name: "3D viewport" });
  if (await viewport3DMenuItem.isVisible()) {
    await viewport3DMenuItem.click();
  } else {
    await page.locator('[data-action-id="viewport-3d.open"]').click();
  }
  await page.evaluate(() => {
    window.__FULLMAG_CONTROL_ROOM_AUDIT__?.setActiveViewportModule("viewport-3d");
  });
  await canvas.waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await waitForDiagnostics(viewport);
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "viewport-reopened",
    currentFixtureQuantity(fixture),
  );
  if (injectListenerLeak) {
    await page.evaluate(() => window.__FULLMAG_CONTROL_ROOM_AUDIT__?.injectViewportAuditListenerLeak());
  }
  if (injectWorkerLeak) {
    await page.evaluate(() => window.__FULLMAG_CONTROL_ROOM_AUDIT__?.injectViewportAuditWorkerLeak());
  }

  auditActive = true;
  auditPhase = "cached-quantity-switch-stress";
  fdmSurfaceInstanceColorBeforeStress = await readInstanceColorLifecycleAudit(page);
  const quantitySwitchFieldGetsBefore = fieldRequests.length;
  const quantitySwitchPerformanceBefore = await captureViewportPerformanceSnapshot(
    page,
    "quantity-switch-before",
  );
  rawPerformanceTrace.push(quantitySwitchPerformanceBefore);
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "quantity-stress-start",
    currentFixtureQuantity(fixture),
  );
  for (const [index, quantity] of QUANTITY_SEQUENCE.entries()) {
    if (index % 12 === 0) {
      auditLog("switching cached quantity batch", `${index + 1}-${index + 12}`);
    }
    fixture.visualizationState = applyPatch(fixture.visualizationState, {
      active_quantity_id: quantity,
      field_component: index % 2 === 0 ? "x" : "magnitude",
      layers: {
        points: { visible: index % 3 === 0 },
        vectors: { visible: index % 4 !== 0 },
        wireframe: { visible: index % 5 !== 0 },
      },
      quantity: {
        active_quantity_id: quantity,
        field_component: index % 2 === 0 ? "x" : "magnitude",
      },
      vector_style: {
        color_mode: index % 2 === 0 ? "magnitude" : "orientation",
      },
    });
    fixture.visualizationState.revision += 1;
    fixture.status.resources.visualization_state_revision =
      fixture.visualizationState.revision;
    const beforePublicationGpu = await readBrowserAuditCounters(page);
    await page.evaluate(async ({ state, drop }) => {
      const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
      if (!drop) hook.publishVisualizationState(state);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }, { drop: injectDroppedPublication && index === 0, state: fixture.visualizationState });
    await assertPublicationRendered(
      page,
      viewport,
      quantity,
      fixture.visualizationState.revision,
      beforePublicationGpu,
    );
    await captureGpuLifecycleSnapshot(
      page,
      gpuLifecycleTimeline,
      "quantity-stress-rendered",
      quantity,
    );
  }
  await page.waitForTimeout(500);
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "quantity-stress-stable-end",
    currentFixtureQuantity(fixture),
  );
  const fdmSurfaceInstanceColorAfterStress =
    await readInstanceColorLifecycleAudit(page);
  fdmSurfaceInstanceColorStressDelta = assertNoFdmSurfaceInstanceColorChurn(
    fdmSurfaceInstanceColorBeforeStress,
    fdmSurfaceInstanceColorAfterStress,
  );
  const quantitySwitchPerformanceAfter = await captureViewportPerformanceSnapshot(
    page,
    "quantity-switch-after",
  );
  rawPerformanceTrace.push(quantitySwitchPerformanceAfter);
  const quantitySwitchPerformanceDelta = assertQuantitySwitchPerformanceDelta({
    after: quantitySwitchPerformanceAfter,
    before: quantitySwitchPerformanceBefore,
    fieldGetsAfter: fieldRequests.length,
    fieldGetsBefore: quantitySwitchFieldGetsBefore,
    maxFieldDecodes: 0,
    maxFieldGets: 0,
    maxFieldSwaps: 0,
    plan: "warmed-cache",
  });

  auditLog("reading final diagnostics");
  const after = {
    diagnostics: await readDiagnostics(viewport),
    heapBytes: await readJsHeapBytes(cdp),
  };

  const heapGrowth = after.heapBytes - baseline.heapBytes;
  const allowedHeapGrowth = Math.max(
    MAX_HEAP_GROWTH_BYTES,
    Math.floor(baseline.heapBytes * 0.35),
  );
  const cacheGrowth =
    after.diagnostics.cacheBytes - baseline.diagnostics.cacheBytes;
  const geometryGrowth = after.diagnostics.geo - baseline.diagnostics.geo;

  if (heapGrowth > allowedHeapGrowth) {
    throw new Error(
      `Viewport quantity churn grew JS heap by ${formatBytes(heapGrowth)}; allowed ${formatBytes(allowedHeapGrowth)}. baseline=${formatBytes(baseline.heapBytes)} after=${formatBytes(after.heapBytes)}.`,
    );
  }
  if (cacheGrowth > 6 * 1024 * 1024) {
    throw new Error(
      `Viewport quantity churn grew decoded cache by ${formatBytes(cacheGrowth)}; baseline=${formatBytes(baseline.diagnostics.cacheBytes)} after=${formatBytes(after.diagnostics.cacheBytes)}.`,
    );
  }
  if (geometryGrowth > 16) {
    throw new Error(
      `Viewport quantity churn leaked geometry resources: baseline=${baseline.diagnostics.geo}, after=${after.diagnostics.geo}.`,
    );
  }
  if (topologyRequests.length > 0) {
    throw new Error(
      `Quantity switching refetched topology resources:\n${topologyRequests.join("\n")}`,
    );
  }
  if (fieldRequests.length > 0) {
    throw new Error(
      `Cached quantity switching refetched field resources:\n${fieldRequests.join("\n")}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Browser console/network errors:\n${errors.join("\n")}`);
  }

  if (injectIdleLoop) {
    await injectViewportIdleLoop(page);
  }
  auditPhase = "idle-observation";
  const idleRequestStart = auditedRequests.length;
  const idlePerformanceBefore = await captureViewportPerformanceSnapshot(page, "idle-before");
  const idle = await verifyViewportIdle(page, 5_000);
  const idlePerformanceAfter = await captureViewportPerformanceSnapshot(page, "idle-after");
  assertNoSettledR3FFrames(idlePerformanceBefore, idlePerformanceAfter, idle.observeMs);
  rawPerformanceTrace.push(idlePerformanceBefore, idlePerformanceAfter);
  const idleRequests = auditedRequests.slice(idleRequestStart);
  if (idleRequests.length > 0) {
    throw new Error(
      `Viewport issued resource requests during the ${idle.observeMs}ms idle window:\n${idleRequests.join("\n")}`,
    );
  }
  auditActive = false;
  const fidelity = await assertCanvasHasFidelity(page);
  if (injectBlankScene) {
    await clearViewportCanvas(page);
    await assertCanvasHasFidelity(page);
  }
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "shader-signature-phase-start",
    currentFixtureQuantity(fixture),
  );
  const shaderSignatures = await collectStableShaderSignatures(
    page,
    fixture,
    viewport,
    gpuLifecycleTimeline,
  );
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "shader-signature-phase-complete",
    currentFixtureQuantity(fixture),
  );
  await page.screenshot({ path: path.join(auditArtifactsDirectory, "settled-3d.png") });
  if (injectGpuBufferLeak) {
    await injectViewportGpuBufferLeak(page);
  }
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    injectGpuBufferLeak ? "pre-gpu-gate-after-negative-control" : "pre-gpu-gate",
    currentFixtureQuantity(fixture),
  );
  const gpuAfterStress = await readBrowserAuditCounters(page);
  const baselineLiveBuffers =
    baseline.gpu.buffersCreated - baseline.gpu.buffersDeleted;
  const stressLiveBuffers =
    gpuAfterStress.buffersCreated - gpuAfterStress.buffersDeleted;
  const createdDuringStress =
    gpuAfterStress.buffersCreated - baseline.gpu.buffersCreated;
  if (createdDuringStress < QUANTITY_SEQUENCE.length) {
    throw new Error(
      `GPU lifecycle gate did not observe every rendered transition: created ${createdDuringStress} buffers for ${QUANTITY_SEQUENCE.length} switches.`,
    );
  }
  if (stressLiveBuffers > baselineLiveBuffers + 16) {
    throw new Error(
      `Live WebGL buffers did not return to a post-warmup plateau: baseline=${baselineLiveBuffers}, after=${stressLiveBuffers}.`,
    );
  }
  await page.locator('[data-action-id="ws-2d"]').click();
  await page.locator(".fm-viewport-3d canvas").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(1_000);
  await captureGpuLifecycleSnapshot(
    page,
    gpuLifecycleTimeline,
    "after-final-unmount",
    currentFixtureQuantity(fixture),
  );
  const afterUnmount = await readBrowserAuditCounters(page);
  const afterUnmountRuntime = await readViewportAuditRuntime(page);
  rawPerformanceTrace.push(await captureViewportPerformanceSnapshot(page, "after-unmount"));
  assertViewportPerformanceTrace(rawPerformanceTrace);
  if (afterUnmount.buffersDeleted < gpuAfterStress.buffersDeleted) {
    throw new Error("WebGL buffer delete counter regressed after viewport unmount.");
  }
  const unmountedLiveBuffers =
    afterUnmount.buffersCreated - afterUnmount.buffersDeleted;
  if (unmountedLiveBuffers > 4) {
    throw new Error(
      `Viewport unmount retained ${unmountedLiveBuffers} WebGL buffers; allowed 4 instrumentation/runtime buffers.`,
    );
  }
  assertViewportRuntimeReleased(afterUnmountRuntime, unmountedBaselineRuntime);
  await page.screenshot({ path: path.join(auditArtifactsDirectory, "after-unmount.png") });
  const partialMultilayer = await assertPartialMultilayerNativeMaskRendered(
    page,
    fixture,
    fixtureRequests,
  );
  if (errors.length > 0) {
    throw new Error(`Browser console/network errors:\n${errors.join("\n")}`);
  }
  const instanceColorLifecycle = await readInstanceColorLifecycleAudit(page);
  await writeAuditArtifact({
    after,
    afterUnmount,
    afterUnmountRuntime,
    baseline,
    fdmFieldAdoption,
    fdmNeutralSurfaceColorProof,
    unmountedBaselineRuntime,
    shaderSignatures,
    fixtureRequests,
    gpuAfterStress,
    gpuLifecycleTimeline,
    gpuLifecycleTimelineDropped,
    idle,
    idleRequests,
    partialMultilayer,
    quantitySwitchPerformanceDelta,
    rawPerformanceTrace,
    fidelity,
    instanceColorLifecycle,
    instanceColorLifecycleBeforeStress:
      fdmSurfaceInstanceColorBeforeStress?.summary ?? null,
    instanceColorLifecycleStressDelta: fdmSurfaceInstanceColorStressDelta,
    topologyRequests,
    url,
    warmedFieldPayloads,
  });

  console.log(
    "Viewport 3D memory-churn audit passed:",
    `switches=${QUANTITY_SEQUENCE.length}`,
    `heap=${formatBytes(baseline.heapBytes)}->${formatBytes(after.heapBytes)}`,
    `cache=${formatBytes(baseline.diagnostics.cacheBytes)}->${formatBytes(after.diagnostics.cacheBytes)}`,
    `geo=${baseline.diagnostics.geo}->${after.diagnostics.geo}`,
    `frames=${baseline.diagnostics.frames}->${after.diagnostics.frames}`,
    `fieldRequests=${fieldRequests.length}`,
    `fixtureRequests=${fixtureRequests.length}`,
    `gpuBuffers=${gpuAfterStress.buffersCreated}/${gpuAfterStress.buffersDeleted}`,
    `gpuUploaded=${formatBytes(gpuAfterStress.bufferBytesUploaded)}`,
  );
} catch (error) {
  await reportAuditFailure(page, fixture, {
    errors,
    fieldRequests,
    fixtureRequests,
    requestFailureDiagnostics,
    topologyRequests,
    visualizationAckRequests,
    gpuLifecycleTimeline,
    gpuLifecycleTimelineDropped,
    fdmSurfaceInstanceColorBeforeStress,
    fdmSurfaceInstanceColorStressDelta,
    fdmNeutralSurfaceColorProof,
    fdmNeutralSurfaceColorDiagnostics,
  });
  throw error;
} finally {
  auditActive = false;
  await browser.close();
  await managedRuntime?.stop();
}

async function assertCanvasHasFidelity(
  page,
  {
    expectedPixelColor = null,
    includePixelSamples = false,
    pngArtifactName = null,
  } = {},
) {
  const canvas = page.locator(".fm-viewport-3d canvas");
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("Viewport fidelity gate could not measure the WebGL canvas.");
  }
  await canvas.evaluate(() => {
    const style = document.createElement("style");
    style.dataset.viewportAuditIsolation = "true";
    style.textContent = `
      .fm-viewport-3d *:not(canvas) { visibility: hidden !important; }
      .fm-viewport-3d canvas { visibility: visible !important; }
    `;
    document.head.append(style);
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  let screenshot;
  let screenshotArtifact = null;
  try {
    screenshot = await page.screenshot({ clip: box });
    screenshotArtifact = await writeBoundedCanvasPngArtifact(
      screenshot,
      pngArtifactName,
    );
  } finally {
    await canvas.evaluate(() => {
      document.querySelector('[data-viewport-audit-isolation="true"]')?.remove();
    });
  }
  const sample = await page.evaluate(async ({
    encodedPng,
    expectedPixelColor: expectedColor,
    includePixelSamples: capturePixels,
    maxExpectedColorMatchCoordinates,
  }) => {
    // Decode locally: the application CSP intentionally disallows data: fetches.
    const bytes = Uint8Array.from(atob(encodedPng), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const target = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = target.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let varied = 0;
    let signature = 2166136261;
    const pixelSamples = capturePixels ? [] : null;
    const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
    const reference = [pixels[0], pixels[1], pixels[2]];
    const expectedColorMatches = expectedColor ? [] : null;
    let expectedColorFullResolutionMatchCount = expectedColor ? 0 : null;
    const expectedColorFullResolutionMatchCoordinates = expectedColor ? [] : null;
    if (expectedColor) {
      for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
        if (
          pixels[offset] !== expectedColor[0] ||
          pixels[offset + 1] !== expectedColor[1] ||
          pixels[offset + 2] !== expectedColor[2]
        ) {
          continue;
        }
        expectedColorFullResolutionMatchCount += 1;
        if (
          expectedColorFullResolutionMatchCoordinates.length <
          maxExpectedColorMatchCoordinates
        ) {
          const pixelIndex = offset / 4;
          expectedColorFullResolutionMatchCoordinates.push([
            pixelIndex % bitmap.width,
            Math.floor(pixelIndex / bitmap.width),
          ]);
        }
      }
    }
    for (let y = 0; y < bitmap.height; y += stride) {
      for (let x = 0; x < bitmap.width; x += stride) {
        const offset = (y * bitmap.width + x) * 4;
        signature ^= pixels[offset] ^ pixels[offset + 1] ^ pixels[offset + 2] ^ pixels[offset + 3];
        signature = Math.imul(signature, 16777619);
        if (pixelSamples) {
          pixelSamples.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
        }
        if (
          expectedColor &&
          pixels[offset] === expectedColor[0] &&
          pixels[offset + 1] === expectedColor[1] &&
          pixels[offset + 2] === expectedColor[2]
        ) {
          expectedColorMatches.push([x, y]);
        }
        if (
          Math.abs(pixels[offset] - reference[0]) > 8 ||
          Math.abs(pixels[offset + 1] - reference[1]) > 8 ||
          Math.abs(pixels[offset + 2] - reference[2]) > 8
        ) varied += 1;
      }
    }
    return {
      expectedColorMatches,
      expectedColorFullResolutionMatchCount,
      expectedColorFullResolutionMatchCoordinates,
      height: bitmap.height,
      pixelSamples,
      sampleStride: stride,
      signature: String(signature >>> 0),
      varied,
      width: bitmap.width,
    };
  }, {
    encodedPng: screenshot.toString("base64"),
    expectedPixelColor,
    includePixelSamples,
    maxExpectedColorMatchCoordinates: MAX_NEUTRAL_PIXEL_MATCH_COORDINATES,
  });
  if (!sample || sample.varied === 0) {
    throw new Error("Viewport fidelity gate detected a blank or uniform WebGL drawing buffer.");
  }
  return { ...sample, screenshotArtifact };
}

async function writeBoundedCanvasPngArtifact(screenshot, fileName) {
  if (!fileName) return null;
  const byteLength = screenshot?.byteLength ?? null;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    return { fileName, status: "invalid-screenshot-buffer" };
  }
  if (byteLength > MAX_NEUTRAL_PNG_ARTIFACT_BYTES) {
    return {
      byteLength,
      fileName,
      maxBytes: MAX_NEUTRAL_PNG_ARTIFACT_BYTES,
      status: "skipped-size-limit",
    };
  }
  try {
    await writeFile(path.join(auditArtifactsDirectory, fileName), screenshot);
    return { byteLength, fileName, status: "written" };
  } catch (error) {
    return {
      byteLength,
      errorCode:
        typeof error?.code === "string" ? error.code.slice(0, 64) : "unknown",
      fileName,
      status: "write-failed",
    };
  }
}

async function assertFdmNeutralSurfaceColorPixels(
  page,
  fixture,
  viewport,
  quantityId,
  payloadEtag,
) {
  if (currentFixtureQuantity(fixture) !== quantityId) {
    throw new Error("FDM neutral-color proof quantity changed before capture.");
  }
  const objectOverride = fixture.visualizationState.overrides.find(
    (entry) => entry.scope === "object" && entry.scope_id === FDM_READY_OBJECT_SCOPE_ID,
  );
  if (!objectOverride || objectOverride.style?.surface_color_source === "solid") {
    throw new Error("FDM neutral-color proof must begin from a field-derived object color source.");
  }
  const originalSurfaceColorSource = objectOverride.style?.surface_color_source ?? null;
  const originalSurfaceMonoColor = objectOverride.style?.surface_mono_color ?? null;
  const originalSurfaceOpacity = fixture.visualizationState.layers?.surface?.opacity;
  if (!Number.isFinite(originalSurfaceOpacity)) {
    throw new Error("FDM neutral-color proof requires a finite original surface opacity.");
  }
  // Use a distinct canonical object material color and opaque pass so exact
  // screenshot samples identify the surface material, not arbitrary changes.
  const expectedMaterialColor = parseRgbHex(FDM_NEUTRAL_SURFACE_COLOR);
  await publishFdmSurfaceColorSource(page, fixture, viewport, "solid", {
    surfaceMonoColor: FDM_NEUTRAL_SURFACE_COLOR,
    surfaceOpacity: 1,
  });
  const solid = await assertCanvasHasFidelity(page, {
    expectedPixelColor: expectedMaterialColor,
    includePixelSamples: true,
    pngArtifactName: "fdm-neutral-solid-first.png",
  });
  fdmNeutralSurfaceColorDiagnostics = {
    expectedMaterialColor: {
      css: FDM_NEUTRAL_SURFACE_COLOR,
      rgb: expectedMaterialColor,
    },
    stage: "solid-first-capture",
    solid: summarizeNeutralSurfaceColorSample(solid, expectedMaterialColor),
  };
  const solidRepeat = await assertCanvasHasFidelity(page, {
    expectedPixelColor: expectedMaterialColor,
    includePixelSamples: true,
    pngArtifactName: "fdm-neutral-solid-repeat.png",
  });
  const solidRepeatDelta = compareCanvasPixelSamples(solid, solidRepeat);
  fdmNeutralSurfaceColorDiagnostics = {
    expectedMaterialColor: {
      css: FDM_NEUTRAL_SURFACE_COLOR,
      rgb: expectedMaterialColor,
    },
    solid: summarizeNeutralSurfaceColorSample(solid, expectedMaterialColor),
    solidRepeat: summarizeNeutralSurfaceColorSample(
      solidRepeat,
      expectedMaterialColor,
    ),
    solidRepeatChangedSamples: solidRepeatDelta.changedSamples,
    solidRepeatChangedSampleCoordinates: changedCanvasSampleCoordinates(
      solid,
      solidRepeat,
      MAX_NEUTRAL_PIXEL_CHANGED_COORDINATES,
    ),
    stage: "solid-repeat-captured",
  };
  if (solidRepeatDelta.changedSamples !== 0) {
    throw new Error("FDM solid surface-color pixels were not stable across repeated captures.");
  }
  if (
    !solid.expectedColorMatches?.length ||
    JSON.stringify(solid.expectedColorMatches) !==
      JSON.stringify(solidRepeat.expectedColorMatches)
  ) {
    throw new Error(
      `FDM solid material color ${FDM_NEUTRAL_SURFACE_COLOR} was absent or unstable in sampled canvas pixels.`,
    );
  }

  await publishFdmSurfaceColorSource(
    page,
    fixture,
    viewport,
    originalSurfaceColorSource,
    {
      surfaceMonoColor: originalSurfaceMonoColor,
      surfaceOpacity: 1,
    },
  );
  const fieldAdoption = await assertInitialFdmFieldAdoption(
    page,
    quantityId,
    payloadEtag,
    FDM_READY_OBJECT_TARGET_ID,
  );
  const field = await assertCanvasHasFidelity(page, { includePixelSamples: true });
  const fieldRepeat = await assertCanvasHasFidelity(page, { includePixelSamples: true });
  const fieldRepeatDelta = compareCanvasPixelSamples(field, fieldRepeat);
  if (fieldRepeatDelta.changedSamples !== 0) {
    throw new Error("FDM field surface-color pixels were not stable across repeated captures.");
  }
  const solidToFieldDelta = compareCanvasPixelSamples(solid, field);
  if (solidToFieldDelta.changedSamples === 0) {
    throw new Error(
      "FDM solid mode did not produce a pixel change when field-derived surface colors were restored.",
    );
  }
  await publishFdmSurfaceColorSource(
    page,
    fixture,
    viewport,
    originalSurfaceColorSource,
    {
      surfaceMonoColor: originalSurfaceMonoColor,
      surfaceOpacity: originalSurfaceOpacity,
    },
  );
  return {
    fieldAdoption,
    pixelProof: {
      field: summarizeCanvasPixelSample(field),
      fieldRepeatChangedSamples: fieldRepeatDelta.changedSamples,
      fieldSource: originalSurfaceColorSource ?? "resolved-default",
      expectedMaterialColor: {
        css: FDM_NEUTRAL_SURFACE_COLOR,
        rgb: expectedMaterialColor,
        sampledCanvasCoordinates: solid.expectedColorMatches,
        repeatedSampledCanvasCoordinates: solidRepeat.expectedColorMatches,
      },
      solid: summarizeCanvasPixelSample(solid),
      solidRepeatChangedSamples: solidRepeatDelta.changedSamples,
      solidToFieldChangedSamples: solidToFieldDelta.changedSamples,
      sampledPixels: solidToFieldDelta.sampledPixels,
    },
  };
}

async function publishFdmSurfaceColorSource(
  page,
  fixture,
  viewport,
  source,
  { surfaceMonoColor, surfaceOpacity } = {},
) {
  const overrideIndex = fixture.visualizationState.overrides.findIndex(
    (entry) => entry.scope === "object" && entry.scope_id === FDM_READY_OBJECT_SCOPE_ID,
  );
  if (overrideIndex < 0) {
    throw new Error("FDM surface-color proof is missing its canonical object override.");
  }
  const overrides = fixture.visualizationState.overrides.map((entry, index) => {
    if (index !== overrideIndex) return entry;
    const nextOverride = { ...entry };
    const nextStyle = { ...(entry.style ?? {}) };
    if (source === null) delete nextStyle.surface_color_source;
    else nextStyle.surface_color_source = source;
    if (surfaceMonoColor === null) delete nextStyle.surface_mono_color;
    else if (surfaceMonoColor !== undefined) {
      nextStyle.surface_mono_color = surfaceMonoColor;
    }
    if (Object.keys(nextStyle).length === 0) delete nextOverride.style;
    else nextOverride.style = nextStyle;
    return nextOverride;
  });
  const nextState = {
    ...fixture.visualizationState,
    overrides,
    revision: fixture.visualizationState.revision + 1,
  };
  if (surfaceOpacity !== undefined) {
    nextState.layers = {
      ...fixture.visualizationState.layers,
      surface: {
        ...fixture.visualizationState.layers?.surface,
        opacity: surfaceOpacity,
      },
    };
  }
  fixture.visualizationState = nextState;
  fixture.status.resources.visualization_state_revision =
    fixture.visualizationState.revision;
  const before = await readBrowserAuditCounters(page);
  await page.evaluate((state) => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
    hook.publishVisualizationState(state);
  }, fixture.visualizationState);
  await assertPublicationRendered(
    page,
    viewport,
    currentFixtureQuantity(fixture),
    fixture.visualizationState.revision,
    before,
  );
}

function parseRgbHex(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) throw new Error(`Expected an opaque six-digit material color, got ${color}.`);
  const value = match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function compareCanvasPixelSamples(left, right) {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error("FDM surface-color pixel captures have different canvas dimensions.");
  }
  if (
    !Array.isArray(left.pixelSamples) ||
    !Array.isArray(right.pixelSamples) ||
    left.pixelSamples.length !== right.pixelSamples.length ||
    left.pixelSamples.length % 3 !== 0
  ) {
    throw new Error("FDM surface-color pixel captures have incompatible samples.");
  }
  let changedSamples = 0;
  for (let offset = 0; offset < left.pixelSamples.length; offset += 3) {
    if (
      left.pixelSamples[offset] !== right.pixelSamples[offset] ||
      left.pixelSamples[offset + 1] !== right.pixelSamples[offset + 1] ||
      left.pixelSamples[offset + 2] !== right.pixelSamples[offset + 2]
    ) {
      changedSamples += 1;
    }
  }
  return {
    changedSamples,
    sampledPixels: left.pixelSamples.length / 3,
  };
}

function summarizeCanvasPixelSample(sample) {
  return {
    height: sample.height,
    signature: sample.signature,
    varied: sample.varied,
    width: sample.width,
  };
}

function summarizeNeutralSurfaceColorSample(sample, expectedColor) {
  const pixelSamples = Array.isArray(sample.pixelSamples)
    ? sample.pixelSamples
    : [];
  const colors = new Map();
  for (let offset = 0; offset + 2 < pixelSamples.length; offset += 3) {
    const rgb = pixelSamples.slice(offset, offset + 3);
    const key = rgb.join(",");
    const entry = colors.get(key) ?? {
      count: 0,
      distanceSquared: rgb.reduce(
        (sum, channel, index) => sum + (channel - expectedColor[index]) ** 2,
        0,
      ),
      rgb,
    };
    entry.count += 1;
    colors.set(key, entry);
  }
  const colorEntries = Array.from(colors.values());
  const histogram = colorEntries
    .slice()
    .sort((left, right) =>
      right.count - left.count || left.rgb.join(",").localeCompare(right.rgb.join(",")),
    )
    .slice(0, MAX_NEUTRAL_PIXEL_HISTOGRAM_ENTRIES)
    .map(({ count, rgb }) => ({ count, rgb }));
  const nearestColors = colorEntries
    .slice()
    .sort((left, right) =>
      left.distanceSquared - right.distanceSquared ||
      right.count - left.count ||
      left.rgb.join(",").localeCompare(right.rgb.join(",")),
    )
    .slice(0, MAX_NEUTRAL_PIXEL_NEAREST_COLORS)
    .map(({ count, distanceSquared, rgb }) => ({
      count,
      distanceSquared,
      rgb,
    }));
  const samplePrefix = [];
  for (
    let offset = 0;
    offset + 2 < pixelSamples.length &&
    samplePrefix.length < MAX_NEUTRAL_PIXEL_SAMPLE_PREFIX;
    offset += 3
  ) {
    samplePrefix.push(pixelSamples.slice(offset, offset + 3));
  }
  return {
    exactExpectedColorMatchCount: sample.expectedColorMatches?.length ?? null,
    exactExpectedColorMatchCoordinates:
      sample.expectedColorMatches?.slice(0, MAX_NEUTRAL_PIXEL_MATCH_COORDINATES) ??
      null,
    exactExpectedColorFullResolutionMatchCount:
      sample.expectedColorFullResolutionMatchCount ?? null,
    exactExpectedColorFullResolutionMatchCoordinates:
      sample.expectedColorFullResolutionMatchCoordinates?.slice(
        0,
        MAX_NEUTRAL_PIXEL_MATCH_COORDINATES,
      ) ?? null,
    height: sample.height,
    nearestColors,
    sampleCount: pixelSamples.length / 3,
    samplePrefix,
    sampleStride: sample.sampleStride,
    signature: sample.signature,
    screenshotArtifact: sample.screenshotArtifact ?? null,
    topColorHistogram: histogram,
    uniqueSampledColorCount: colorEntries.length,
    varied: sample.varied,
    width: sample.width,
  };
}

function changedCanvasSampleCoordinates(left, right, limit) {
  const leftSamples = left.pixelSamples ?? [];
  const rightSamples = right.pixelSamples ?? [];
  if (
    left.width !== right.width ||
    left.height !== right.height ||
    left.sampleStride !== right.sampleStride ||
    leftSamples.length !== rightSamples.length ||
    left.sampleStride <= 0
  ) {
    return { count: null, coordinates: null };
  }
  const columns = Math.ceil(left.width / left.sampleStride);
  const coordinates = [];
  let count = 0;
  for (let offset = 0; offset + 2 < leftSamples.length; offset += 3) {
    if (
      leftSamples[offset] === rightSamples[offset] &&
      leftSamples[offset + 1] === rightSamples[offset + 1] &&
      leftSamples[offset + 2] === rightSamples[offset + 2]
    ) {
      continue;
    }
    count += 1;
    if (coordinates.length < limit) {
      const sampleIndex = offset / 3;
      coordinates.push([
        (sampleIndex % columns) * left.sampleStride,
        Math.floor(sampleIndex / columns) * left.sampleStride,
      ]);
    }
  }
  return { count, coordinates };
}

async function assertInitialFdmFieldAdoption(
  page,
  quantityId,
  payloadEtag,
  expectedObjectTargetId,
) {
  let trace = [];
  let adoption = null;
  let lastCheck = null;
  try {
    await waitForCondition(
      async () => {
        trace = await page.evaluate(() =>
          window.__FM_VIEWPORT_BROWSER_AUDIT__?.viewportAckTrace?.slice(-512) ?? [],
        );
        try {
          adoption = resolveInitialFdmFieldAdoption(
            trace,
            quantityId,
            payloadEtag,
            expectedObjectTargetId,
          );
          lastCheck = null;
          return true;
        } catch (error) {
          lastCheck = error instanceof Error ? error.message : String(error);
          return false;
        }
      },
      QUANTITY_SWITCH_TIMEOUT_MS,
      `Timed out waiting for the current FDM field ${quantityId} buffer to be adopted.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} Last check: ${lastCheck ?? "no complete browser acknowledgement trace"}; latest trace entries: ${JSON.stringify(trace.slice(-3))}.`,
    );
  }
  return adoption;
}

function resolveInitialFdmFieldAdoption(
  trace,
  quantityId,
  payloadEtag,
  expectedObjectTargetId,
) {
  if (!Array.isArray(trace) || trace.length === 0) {
    throw new Error("The browser acknowledgement trace is empty.");
  }
  let frameIndex = -1;
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (
      entry.event === "frame-commit" &&
      entry.currentFullBuffer?.fieldBufferId &&
      entry.latestActiveAdoption?.fieldBufferId
    ) {
      frameIndex = index;
      break;
    }
  }
  const frame = frameIndex >= 0 ? trace[frameIndex] : null;
  const identity = frame?.currentFullBuffer ?? null;
  if (
    !identity?.fieldBufferId ||
    !identity.fieldRevision ||
    !identity.resourceKey ||
    !identity.sessionId ||
    !identity.sessionEpoch
  ) {
    throw new Error(
      `FDM field ${quantityId} did not publish a complete current full-field buffer identity before churn: ${JSON.stringify(identity)}.`,
    );
  }
  if (identity.fieldRevision !== payloadEtag) {
    throw new Error(
      `FDM field ${quantityId} buffer revision ${identity.fieldRevision} did not match recorded payload ETag ${payloadEtag}.`,
    );
  }
  const resourceUrl = new URL(
    identity.resourceKey.slice(identity.resourceKey.lastIndexOf("|") + 1),
    "http://localhost",
  );
  if (
    resourceUrl.pathname !==
      `/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/samples/vector` ||
    resourceUrl.searchParams.get("component") !== "full" ||
    resourceUrl.searchParams.get("scope_kind") !== "full"
  ) {
    throw new Error(
      `FDM field identity did not refer to the requested full-domain ${quantityId} vector resource: ${identity.resourceKey}.`,
    );
  }

  const receipt = frame.latestActiveAdoption;
  if (
    !frame.requestScopeEpoch ||
    !frame.latestActiveAdoption.requestScopeEpoch ||
    receipt.resourceKey !== identity.resourceKey ||
    receipt.sessionId !== identity.sessionId ||
    receipt.sessionEpoch !== identity.sessionEpoch ||
    receipt.requestScopeEpoch !== frame.requestScopeEpoch
  ) {
    throw new Error(
      `FDM field ${quantityId} full buffer did not have a matching active adoption receipt: ${JSON.stringify(receipt)}.`,
    );
  }

  const activeObjectAdoption = Array.isArray(frame.currentFullBufferActiveAdoptions)
    ? frame.currentFullBufferActiveAdoptions.find((adoption) => (
        adoption?.targetKind === "object" &&
        adoption.targetId === expectedObjectTargetId &&
        adoption.kind === "surface" &&
        adoption.fieldBufferId === identity.fieldBufferId &&
        adoption.resourceKey === identity.resourceKey &&
        adoption.sessionId === identity.sessionId &&
        adoption.sessionEpoch === identity.sessionEpoch &&
        adoption.requestScopeEpoch === frame.requestScopeEpoch &&
        Boolean(adoption.targetId) &&
        Boolean(adoption.carrierId)
      ))
    : null;
  if (!activeObjectAdoption) {
    throw new Error(
      `FDM field ${quantityId} current full-field buffer had no active object surface adoption: ${JSON.stringify(frame.currentFullBufferActiveAdoptions ?? null)}.`,
    );
  }

  const surfaceEvent = trace.slice().reverse().find((entry) => {
    const adoption = entry.surfaceAdoption;
    return (
      entry.event === "surface-adoption" &&
      adoption?.result?.status === "adopted" &&
      adoption.fieldBufferId === identity.fieldBufferId &&
      adoption.resourceKey === identity.resourceKey &&
      adoption.sessionId === identity.sessionId &&
      adoption.sessionEpoch === identity.sessionEpoch &&
      adoption.requestScopeEpoch === frame.requestScopeEpoch &&
      adoption.carrierId === activeObjectAdoption.carrierId &&
      (!adoption.targetId || adoption.targetId === activeObjectAdoption.targetId)
    );
  });
  if (!surfaceEvent) {
    throw new Error(
      `FDM field ${quantityId} had no successful surface-adoption event for its current full-field buffer ${identity.fieldBufferId}.`,
    );
  }
  return {
    fieldBufferId: identity.fieldBufferId,
    fieldRevision: identity.fieldRevision,
    quantityId,
    resourceKey: identity.resourceKey,
    sessionEpoch: identity.sessionEpoch,
    sessionId: identity.sessionId,
    activeObjectAdoption,
    latestActiveAdoption: receipt,
    surfaceAdoption: surfaceEvent.surfaceAdoption,
  };
}

async function assertPublicationRendered(page, viewport, quantityId, revision, beforeGpu) {
  await waitForCondition(
    async () => {
      const diagnostics = await readDiagnostics(viewport);
      const runtime = await readViewportAuditRuntime(page);
      const gpu = await readBrowserAuditCounters(page);
      return (
        diagnostics.raw.includes(`q:${quantityId}`) &&
        String(runtime.visualizationRevision) === String(revision) &&
        (gpu.frames > beforeGpu.frames || gpu.drawCalls > beforeGpu.drawCalls)
      );
    },
    2_000,
    `Audit publication r${revision} (${quantityId}) was not observed by the mounted viewport.`,
  );
}

async function assertPartialMultilayerNativeMaskRendered(
  page,
  fixture,
  fixtureRequests,
) {
  const activeMaskPath = fdmMultilayerActiveMaskPath(FDM_PARTIAL_LAYER_ID);
  const requestsBeforeReload = countFixtureRequests(fixtureRequests, activeMaskPath);
  fixture.multilayerEnabled = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => Boolean(window.__FULLMAG_CONTROL_ROOM_AUDIT__),
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    window.__FULLMAG_CONTROL_ROOM_AUDIT__?.setActiveViewportModule("viewport-3d");
  });
  const viewport = page.locator(".fm-viewport-3d");
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 10_000 });
  await waitForCanvasReady(canvas);
  await waitForDiagnostics(viewport);
  await waitForCondition(
    () => countFixtureRequests(fixtureRequests, activeMaskPath) > requestsBeforeReload,
    10_000,
    `FDM multilayer fixture did not request its declared partial active mask: ${activeMaskPath}`,
  );
  const expectedCellIndices = Array.from(FDM_PARTIAL_ACTIVE_MASK, (active, index) => (
    active ? index : null
  )).filter((cellIndex) => cellIndex !== null);
  let partialModel;
  await waitForCondition(
    async () => {
      const results = await readFdmBuildResults(page);
      partialModel = results.find((result) => (
        sameNumberArray(result.activeMask, Array.from(FDM_PARTIAL_ACTIVE_MASK)) &&
        sameNumberArray(result.shape, FIELD_GRID)
      ));
      return Boolean(partialModel);
    },
    10_000,
    "FDM multilayer partial-mask build did not return an observable worker model.",
  );
  if (!partialModel || partialModel.count !== expectedCellIndices.length) {
    throw new Error(
      `FDM multilayer partial-mask model count was ${partialModel?.count ?? "missing"}; expected ${expectedCellIndices.length} active cells.`,
    );
  }
  if (!sameNumberArray(partialModel.cellIndices, expectedCellIndices)) {
    const inactive = partialModel.cellIndices.filter((cellIndex) => (
      FDM_PARTIAL_ACTIVE_MASK[cellIndex] !== 1
    ));
    throw new Error(
      `FDM multilayer partial-mask model did not preserve exact active membership; inactive cellIndices=${inactive.join(",") || "none"}.`,
    );
  }
  return {
    activeCellCount: partialModel.count,
    inactiveCellIndices: FDM_PARTIAL_INACTIVE_CELL_INDICES,
    maskPath: activeMaskPath,
    requested: countFixtureRequests(fixtureRequests, activeMaskPath) - requestsBeforeReload,
  };
}

async function readFdmBuildResults(page) {
  return page.evaluate(() => (
    window.__FM_VIEWPORT_BROWSER_AUDIT__?.fdmBuildResults ?? []
  ));
}

function sameNumberArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readViewportAuditRuntime(page) {
  return page.evaluate(() => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
    return hook.readViewportAuditRuntime();
  });
}

async function readInstanceColorLifecycleAudit(page) {
  try {
    return await page.evaluate((maxEvents) => {
      const audit = window.__FM_VIEWPORT_BROWSER_AUDIT__;
      const summary = audit?.instanceColorLifecycleSummary ?? null;
      const roleActionCounts = summary?.objectRoleActionCounts ?? {};
      const actionCounts = summary?.actionCounts ?? {};
      return {
        events: Array.isArray(audit?.instanceColorLifecycleEvents)
          ? audit.instanceColorLifecycleEvents.slice(-maxEvents)
          : [],
        summary: summary ? {
          actionCounts: {
            attach: Number(actionCounts.attach ?? 0),
            detach: Number(actionCounts.detach ?? 0),
            replace: Number(actionCounts.replace ?? 0),
          },
          droppedEventCount: Number(summary.droppedEventCount ?? 0),
          objectRoleActionCounts: {
            "fdm-surface": {
              attach: Number(roleActionCounts["fdm-surface"]?.attach ?? 0),
              detach: Number(roleActionCounts["fdm-surface"]?.detach ?? 0),
              replace: Number(roleActionCounts["fdm-surface"]?.replace ?? 0),
            },
            "vector-head": {
              attach: Number(roleActionCounts["vector-head"]?.attach ?? 0),
              detach: Number(roleActionCounts["vector-head"]?.detach ?? 0),
              replace: Number(roleActionCounts["vector-head"]?.replace ?? 0),
            },
            "vector-shaft": {
              attach: Number(roleActionCounts["vector-shaft"]?.attach ?? 0),
              detach: Number(roleActionCounts["vector-shaft"]?.detach ?? 0),
              replace: Number(roleActionCounts["vector-shaft"]?.replace ?? 0),
            },
          },
          totalEvents: Number(summary.totalEvents ?? 0),
        } : null,
      };
    }, MAX_INSTANCE_COLOR_LIFECYCLE_EVENTS);
  } catch (error) {
    return {
      captureError: error instanceof Error ? error.message : String(error),
      events: [],
      summary: null,
    };
  }
}

function assertNoFdmSurfaceInstanceColorChurn(before, after) {
  const beforeCounts = before?.summary?.objectRoleActionCounts?.["fdm-surface"];
  const afterCounts = after?.summary?.objectRoleActionCounts?.["fdm-surface"];
  if (!beforeCounts || !afterCounts) {
    throw new Error(
      "FDM surface instance-color lifecycle counters were unavailable during quantity stress.",
    );
  }
  const delta = {
    attach: afterCounts.attach - beforeCounts.attach,
    detach: afterCounts.detach - beforeCounts.detach,
    replace: afterCounts.replace - beforeCounts.replace,
  };
  if (delta.attach !== 0 || delta.detach !== 0 || delta.replace !== 0) {
    throw new Error(
      `FDM surface instance-color owner changed during quantity stress: ${JSON.stringify(delta)}.`,
    );
  }
  return delta;
}

async function clearViewportCanvas(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Viewport canvas is missing.");
    canvas.style.opacity = "0";
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) throw new Error("Viewport WebGL context is missing.");
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.finish();
  });
}

async function injectViewportIdleLoop(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Viewport canvas is missing.");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) throw new Error("Viewport WebGL context is missing.");
    const loop = () => {
      gl.drawArrays(gl.POINTS, 0, 0);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function injectViewportGpuBufferLeak(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Viewport canvas is missing.");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) throw new Error("Viewport WebGL context is missing.");
    for (let index = 0; index < 8; index += 1) {
      gl.createBuffer();
    }
  });
}

async function collectStableShaderSignatures(
  page,
  fixture,
  viewport,
  gpuLifecycleTimeline,
) {
  const modes = [
    { colorMode: "magnitude", component: "magnitude", id: "scalar" },
    { colorMode: "orientation", component: "magnitude", id: "orientation" },
    { colorMode: "magnitude", component: "x", id: "component" },
  ];
  const signatures = {};
  for (const mode of modes) {
    fixture.visualizationState = applyPatch(fixture.visualizationState, {
      active_quantity_id: "m",
      field_component: mode.component,
      quantity: {
        active_quantity_id: "m",
        field_component: mode.component,
      },
      vector_style: { color_mode: mode.colorMode },
    });
    fixture.visualizationState.revision += 1;
    fixture.status.resources.visualization_state_revision = fixture.visualizationState.revision;
    const before = await readBrowserAuditCounters(page);
    await page.evaluate((state) => window.__FULLMAG_CONTROL_ROOM_AUDIT__?.publishVisualizationState(state), fixture.visualizationState);
    await assertPublicationRendered(page, viewport, "m", fixture.visualizationState.revision, before);
    const first = await assertCanvasHasFidelity(page);
    const second = await assertCanvasHasFidelity(page);
    await captureGpuLifecycleSnapshot(
      page,
      gpuLifecycleTimeline,
      "shader-signature-" + mode.id,
      "m",
    );
    if (first.signature !== second.signature) {
      throw new Error(`Shader visual signature for ${mode.id} was not repeatable.`);
    }
    signatures[mode.id] = first.signature;
  }
  return signatures;
}

function assertViewportRuntimeReleased(afterUnmountRuntime, baselineRuntime) {
  const { resources, workers } = afterUnmountRuntime;
  if (
    workers.activeLeases !== 0 ||
    workers.workers !== 0 ||
    workers.timers !== 0 ||
    workers.jobs !== 0
  ) {
    throw new Error(`Viewport worker runtime survived unmount: ${JSON.stringify(workers)}.`);
  }
  if (resources.listenerCount !== baselineRuntime.resources.listenerCount) {
    const changedListeners = Object.fromEntries(
      new Set([
        ...Object.keys(baselineRuntime.listenerCounts),
        ...Object.keys(afterUnmountRuntime.listenerCounts),
      ])
        .values()
        .map((resourceKey) => [
          resourceKey,
          {
            after: afterUnmountRuntime.listenerCounts[resourceKey] ?? 0,
            baseline: baselineRuntime.listenerCounts[resourceKey] ?? 0,
          },
        ])
        .filter(([, counts]) => counts.after !== counts.baseline),
    );
    throw new Error(
      `Viewport resource subscriptions did not return to the pre-3D baseline: baseline=${baselineRuntime.resources.listenerCount}, after=${resources.listenerCount}, changed=${JSON.stringify(changedListeners)}.`,
    );
  }
}

async function readBrowserAuditCounters(page) {
  return page.evaluate(() => ({ ...(window.__FM_VIEWPORT_BROWSER_AUDIT__ ?? {}) }));
}

function appendBoundedGpuLifecycleSnapshot(timeline, snapshot, maxEntries = 256) {
  timeline.push(snapshot);
  const overflow = Math.max(0, timeline.length - maxEntries);
  if (overflow > 0) timeline.splice(0, overflow);
  return overflow;
}

async function captureGpuLifecycleSnapshot(
  page,
  timeline,
  phase,
  requestedQuantity = null,
) {
  let browserSnapshot;
  try {
    browserSnapshot = await page.evaluate((expectedObjectTargetId) => {
      const counters = window.__FM_VIEWPORT_BROWSER_AUDIT__ ?? null;
      const trace = counters?.viewportAckTrace ?? [];
      const frame = trace.slice().reverse().find((entry) =>
        entry.event === "frame-commit" &&
        entry.currentFullBuffer?.fieldBufferId,
      ) ?? null;
      const identity = frame?.currentFullBuffer ?? null;
      let actualQuantityId = null;
      if (identity?.resourceKey) {
        try {
          const resourceKey = identity.resourceKey;
          const resourceUrl = new URL(
            resourceKey.slice(resourceKey.lastIndexOf("|") + 1),
            window.location.href,
          );
          const match = resourceUrl.pathname.match(
            /\/data\/fields\/([^/]+)\/samples\/vector$/,
          );
          actualQuantityId = match ? decodeURIComponent(match[1]) : null;
        } catch {
          actualQuantityId = null;
        }
      }
      const activeObjectAdoption = frame?.currentFullBufferActiveAdoptions?.find(
        (adoption) =>
          adoption?.targetKind === "object" &&
          adoption.targetId === expectedObjectTargetId &&
          adoption.kind === "surface" &&
          adoption.fieldBufferId === identity?.fieldBufferId,
      ) ?? null;
      const hudText = Array.from(
        document.querySelectorAll(".fm-viewport-3d__hud span"),
      ).map((node) => node.textContent?.trim() ?? "").join(" ");
      const hudQuantityMatch = hudText.match(/(?:^|\s)q:([^\s]+)/);
      const gpuContextDiagnostics =
        typeof counters?.gpuContextDiagnostics === "function"
          ? counters.gpuContextDiagnostics()
          : null;
      return {
        frameCommitProvenance:
          "latest recorded frame-commit from viewportAckTrace; history only and not proof of the currently mounted canvas",
        activeObjectAdoption: activeObjectAdoption ? {
          carrierId: activeObjectAdoption.carrierId ?? null,
          fieldBufferId: activeObjectAdoption.fieldBufferId ?? null,
          requestScopeEpoch: activeObjectAdoption.requestScopeEpoch ?? null,
          resourceKey: activeObjectAdoption.resourceKey ?? null,
          sessionEpoch: activeObjectAdoption.sessionEpoch ?? null,
          sessionId: activeObjectAdoption.sessionId ?? null,
          targetId: activeObjectAdoption.targetId ?? null,
        } : null,
        currentFullBuffer: identity ? {
          fieldBufferId: identity.fieldBufferId ?? null,
          fieldRevision: identity.fieldRevision ?? null,
          quantityId: actualQuantityId,
          requestScopeEpoch: frame?.requestScopeEpoch ?? null,
          resourceKey: identity.resourceKey ?? null,
          sessionEpoch: identity.sessionEpoch ?? null,
          sessionId: identity.sessionId ?? null,
        } : null,
        gpuContextDiagnostics,
        gpuCounters: counters ? {
          bufferBytesUploaded: counters.bufferBytesUploaded ?? null,
          buffersCreated: counters.buffersCreated ?? null,
          buffersDeleted: counters.buffersDeleted ?? null,
          drawCalls: counters.drawCalls ?? null,
          frames: counters.frames ?? null,
        } : null,
        latestActiveAdoption: frame?.latestActiveAdoption ? {
          fieldBufferId: frame.latestActiveAdoption.fieldBufferId ?? null,
          requestScopeEpoch: frame.latestActiveAdoption.requestScopeEpoch ?? null,
          resourceKey: frame.latestActiveAdoption.resourceKey ?? null,
          sessionEpoch: frame.latestActiveAdoption.sessionEpoch ?? null,
          sessionId: frame.latestActiveAdoption.sessionId ?? null,
          targetId: frame.latestActiveAdoption.targetId ?? null,
          targetKind: frame.latestActiveAdoption.targetKind ?? null,
        } : null,
        observedHudQuantity: hudQuantityMatch?.[1] ?? null,
      };
    }, FDM_READY_OBJECT_TARGET_ID);
  } catch (error) {
    browserSnapshot = {
      captureError: error instanceof Error ? error.message : String(error),
    };
  }
  const snapshot = {
    observedAtUnixMs: Date.now(),
    phase,
    requestedQuantity,
    ...browserSnapshot,
  };
  gpuLifecycleTimelineDropped += appendBoundedGpuLifecycleSnapshot(
    timeline,
    snapshot,
    MAX_GPU_LIFECYCLE_TIMELINE_ENTRIES,
  );
  return snapshot;
}

async function verifyViewportIdle(page, observeMs) {
  await page.waitForTimeout(500);
  const before = await readBrowserAuditCounters(page);
  await page.waitForTimeout(observeMs);
  const after = await readBrowserAuditCounters(page);
  const deltas = Object.fromEntries(
    Object.keys(after).map((key) => [key, Number(after[key]) - Number(before[key])]),
  );
  for (const metric of ["frames", "drawCalls"]) {
    if (deltas[metric] !== 0) {
      throw new Error(`Viewport rendered during ${observeMs}ms idle window: ${metric} +${deltas[metric]}.`);
    }
  }
  return { after, before, deltas, observeMs };
}

async function writeAuditArtifact(payload) {
  await mkdir(auditArtifactsDirectory, { recursive: true });
  await writeFile(
    path.join(auditArtifactsDirectory, "metrics.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

async function startAuditRuntime() {
  await runPnpm(["run", "build:audit:webpack"], {
    NEXT_PUBLIC_AUDIT_BUILD: "1",
  });
  const port = await reserveAuditPort(requestedAuditPort);
  const child = spawn("pnpm", ["exec", "next", "start", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_PUBLIC_AUDIT_BUILD: "1" },
    stdio: "pipe",
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const serverUrl = `http://localhost:${port}/workspace`;
  try {
    await waitForHttp(serverUrl, 30_000, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`Audit server did not become ready: ${error.message}\n${output.join("")}`);
  }
  return {
    url: serverUrl,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
  };
}

async function reserveAuditPort(requestedPort) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function runPnpm(args, extraEnvironment) {
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`pnpm ${args.join(" ")} exited with ${code ?? "signal"}.`));
    });
  });
}

async function waitForHttp(targetUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Audit server exited before readiness with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(targetUrl, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The process is still binding its port.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${targetUrl}.`);
}

async function installBrowserAuditInstrumentation(page) {
  await page.addInitScript(() => {
    const MAX_WEBGL_CONTEXT_DIAGNOSTICS = 16;
    const MAX_WEBGL_CONTEXT_EVENTS = 64;
    const contextStateByGl = new WeakMap();
    const contextSummaries = new Map();
    const contextEvents = [];
    let nextWebGlContextId = 1;
    let omittedContextCount = 0;
    const counters = {
      bufferBytesUploaded: 0,
      buffersCreated: 0,
      buffersDeleted: 0,
      drawCalls: 0,
      frames: 0,
    };
    const viewportAckTrace = [];
    Object.defineProperty(counters, "viewportAckTrace", {
      enumerable: false,
      value: viewportAckTrace,
    });
    const instanceColorLifecycleEvents = [];
    const instanceColorLifecycleSummary = {
      actionCounts: { attach: 0, detach: 0, replace: 0 },
      droppedEventCount: 0,
      objectRoleActionCounts: {
        "fdm-surface": { attach: 0, detach: 0, replace: 0 },
        "vector-head": { attach: 0, detach: 0, replace: 0 },
        "vector-shaft": { attach: 0, detach: 0, replace: 0 },
      },
      totalEvents: 0,
    };
    Object.defineProperty(counters, "instanceColorLifecycleEvents", {
      enumerable: false,
      value: instanceColorLifecycleEvents,
    });
    Object.defineProperty(counters, "instanceColorLifecycleSummary", {
      enumerable: false,
      value: instanceColorLifecycleSummary,
    });
    const fdmBuildRequests = new Map();
    const fdmBuildResults = [];
    Object.defineProperty(counters, "fdmBuildResults", {
      enumerable: false,
      value: fdmBuildResults,
    });
    window.__FM_VIEWPORT_BROWSER_AUDIT__ = counters;
    Object.defineProperty(counters, "gpuContextDiagnostics", {
      enumerable: false,
      value: () => ({
        contextEvents: contextEvents.map((event) => ({ ...event })),
        contexts: Array.from(contextSummaries.values(), (context) => ({
          bufferCreateCalls: context.bufferCreateCalls,
          bufferDeleteCalls: context.bufferDeleteCalls,
          contextId: context.contextId,
          contextLostEvents: context.contextLostEvents,
          contextRestoredEvents: context.contextRestoredEvents,
          contextType: context.contextType,
        })),
        measurementKind:
          "WebGL createBuffer/deleteBuffer call counts; not retained GPU objects or driver bytes",
        omittedContextCount,
      }),
    });
    const recordContextEvent = (contextState, eventName) => {
      if (eventName === "webglcontextlost") contextState.contextLostEvents += 1;
      if (eventName === "webglcontextrestored") contextState.contextRestoredEvents += 1;
      contextEvents.push({
        contextId: contextState.contextId,
        eventName,
        observedAtUnixMs: Date.now(),
        phase: window.__FM_VIEWPORT_AUDIT_STEP__ ?? null,
      });
      if (contextEvents.length > MAX_WEBGL_CONTEXT_EVENTS) contextEvents.shift();
    };

    const workerMessageListeners = new WeakMap();
    const originalWorkerAddEventListener = Worker.prototype.addEventListener;
    const originalWorkerRemoveEventListener = Worker.prototype.removeEventListener;
    const originalWorkerPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (
        message?.nativeActiveMask instanceof Uint8Array &&
        Number.isSafeInteger(message.id)
      ) {
        fdmBuildRequests.set(message.id, {
          activeMask: Array.from(message.nativeActiveMask),
          shape: Array.from(message.domain?.shape ?? []),
        });
      }
      return originalWorkerPostMessage.call(this, message, transfer);
    };
    Worker.prototype.addEventListener = function (type, listener, options) {
      if (type !== "message" || typeof listener !== "function") {
        return originalWorkerAddEventListener.call(this, type, listener, options);
      }
      let listeners = workerMessageListeners.get(this);
      if (!listeners) {
        listeners = new WeakMap();
        workerMessageListeners.set(this, listeners);
      }
      let wrapped = listeners.get(listener);
      if (!wrapped) {
        wrapped = function (event) {
          const request = fdmBuildRequests.get(event.data?.id);
          const model = event.data?.ok ? event.data.data?.model : null;
          if (request && model?.cellIndices instanceof Uint32Array) {
            fdmBuildResults.push({
              activeMask: request.activeMask,
              cellIndices: Array.from(model.cellIndices),
              count: model.count,
              shape: request.shape,
            });
            fdmBuildRequests.delete(event.data.id);
          }
          return listener.call(this, event);
        };
        listeners.set(listener, wrapped);
      }
      return originalWorkerAddEventListener.call(this, type, wrapped, options);
    };
    Worker.prototype.removeEventListener = function (type, listener, options) {
      const wrapped = workerMessageListeners.get(this)?.get(listener) ?? listener;
      return originalWorkerRemoveEventListener.call(this, type, wrapped, options);
    };

    const originalRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      originalRaf((timestamp) => {
        counters.frames += 1;
        callback(timestamp);
      });

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = originalGetContext.apply(this, args);
      if (!context || !["webgl", "webgl2", "experimental-webgl"].includes(String(args[0]))) {
        return context;
      }
      const gl = context;
      let contextState = contextStateByGl.get(gl);
      if (!contextState) {
        const contextId = nextWebGlContextId++;
        const tracked = contextSummaries.size < MAX_WEBGL_CONTEXT_DIAGNOSTICS;
        contextState = {
          bufferCreateCalls: 0,
          bufferDeleteCalls: 0,
          contextId,
          contextLostEvents: 0,
          contextRestoredEvents: 0,
          contextType: String(args[0]),
          tracked,
        };
        contextStateByGl.set(gl, contextState);
        if (tracked) {
          contextSummaries.set(contextId, contextState);
          const canvas = gl.canvas;
          if (canvas && typeof canvas.addEventListener === "function") {
            canvas.addEventListener("webglcontextlost", () =>
              recordContextEvent(contextState, "webglcontextlost"),
            );
            canvas.addEventListener("webglcontextrestored", () =>
              recordContextEvent(contextState, "webglcontextrestored"),
            );
          }
        } else {
          omittedContextCount += 1;
        }
      }
      if (gl.__fullmagAuditWrapped) return gl;
      gl.__fullmagAuditWrapped = true;
      for (const name of ["createBuffer", "deleteBuffer", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          if (name === "createBuffer") {
            counters.buffersCreated += 1;
            if (contextState.tracked) contextState.bufferCreateCalls += 1;
          }
          if (name === "deleteBuffer") {
            counters.buffersDeleted += 1;
            if (contextState.tracked) contextState.bufferDeleteCalls += 1;
          }
          if (name.startsWith("draw")) counters.drawCalls += 1;
          return original.apply(this, methodArgs);
        };
      }
      for (const name of ["bufferData", "bufferSubData"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          const data = methodArgs[1];
          if (typeof data === "number") counters.bufferBytesUploaded += data;
          else if (data && typeof data.byteLength === "number") counters.bufferBytesUploaded += data.byteLength;
          return original.apply(this, methodArgs);
        };
      }
      return gl;
    };
  });
}

async function setGlobalQuantity(
  page,
  fixture,
  requests,
  quantityId,
  { allowExistingFieldRequest = false, requireFieldRequest = false } = {},
) {
  const previousFieldRequestCount = countFieldRequests(requests, quantityId);
  if (currentFixtureQuantity(fixture) === quantityId) {
    if (requireFieldRequest) {
      await waitForFieldRequest(requests, quantityId, {
        afterCount: allowExistingFieldRequest
          ? undefined
          : previousFieldRequestCount,
      });
    }
    return;
  }

  await setAuditStep(page, `quantity:${quantityId}:audit-hook`);
  await page.evaluate(async (expected) => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) {
      throw new Error("Fullmag browser audit hook is not installed.");
    }
    await hook.setGlobalQuantity(expected);
  }, quantityId);
  await setAuditStep(page, `quantity:${quantityId}:wait-patch`);
  await waitForCondition(
    () => currentFixtureQuantity(fixture) === quantityId,
    5_000,
    `Timed out waiting for visualization PATCH to persist quantity ${quantityId}.`,
  );
  if (requireFieldRequest) {
    await setAuditStep(page, `quantity:${quantityId}:wait-field-request`);
    await waitForFieldRequest(requests, quantityId, {
      afterCount: allowExistingFieldRequest
        ? undefined
        : previousFieldRequestCount,
    });
  }
  await page.waitForTimeout(120);
}

async function waitForFieldRequest(
  requests,
  quantityId,
  { afterCount = undefined } = {},
) {
  await waitForCondition(
    () => {
      const count = countFieldRequests(requests, quantityId);
      return afterCount === undefined ? count > 0 : count > afterCount;
    },
    15_000,
    `Timed out waiting for field vector request ${quantityId}.`,
  );
}

function countFieldRequests(requests, quantityId) {
  const expected = fieldVectorRequest(quantityId);
  return requests.filter((request) => request === expected).length;
}

function countFixtureRequests(requests, path) {
  return requests.filter((request) => request.endsWith(` ${path}`)).length;
}

function fieldVectorRequest(quantityId) {
  return `GET /v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/samples/vector`;
}

async function reportAuditFailure(
  page,
  fixture,
  {
    errors,
    fieldRequests,
    fixtureRequests,
    requestFailureDiagnostics,
    topologyRequests,
    visualizationAckRequests,
    gpuLifecycleTimeline,
    gpuLifecycleTimelineDropped,
    fdmSurfaceInstanceColorBeforeStress,
    fdmSurfaceInstanceColorStressDelta,
    fdmNeutralSurfaceColorProof,
    fdmNeutralSurfaceColorDiagnostics,
  },
) {
  const instanceColorLifecycle = await readInstanceColorLifecycleAudit(page);
  const snapshot = await page
    .evaluate(() => {
      const hud = Array.from(
        document.querySelectorAll(".fm-viewport-3d__hud span"),
      ).map((node) => node.textContent?.trim() ?? "");
      const menuItems = Array.from(
        document.querySelectorAll('[role="menuitemradio"]'),
      ).map((node) => ({
        box: (() => {
          const rect = node.getBoundingClientRect();
          return {
            height: rect.height,
            width: rect.width,
            x: rect.x,
            y: rect.y,
          };
        })(),
        checked: node.getAttribute("aria-checked"),
        disabled: node.getAttribute("aria-disabled"),
        text: node.textContent?.trim() ?? "",
      }));
      const actionIds = Array.from(document.querySelectorAll("[data-action-id]"))
        .map((node) => ({
          box: (() => {
            const rect = node.getBoundingClientRect();
            return {
              height: rect.height,
              width: rect.width,
              x: rect.x,
              y: rect.y,
            };
          })(),
          id: node.getAttribute("data-action-id"),
          text: node.textContent?.trim() ?? "",
        }))
        .slice(0, 80);
      return {
        actionIds,
        auditEvents: window.__FM_VIEWPORT_AUDIT_EVENTS__ ?? [],
        auditStep: window.__FM_VIEWPORT_AUDIT_STEP__ ?? null,
        hud,
        menuItems,
        viewportAckTrace:
          window.__FM_VIEWPORT_BROWSER_AUDIT__?.viewportAckTrace?.slice(-512) ?? [],
        url: window.location.href,
      };
    })
    .catch((innerError) => ({
      error: innerError instanceof Error ? innerError.message : String(innerError),
    }));
  console.error(
    "Viewport 3D memory-churn audit failure context:",
    JSON.stringify(
      {
        browser: snapshot,
        instanceColorLifecycle,
        instanceColorLifecycleBeforeStress:
          fdmSurfaceInstanceColorBeforeStress?.summary ?? null,
        instanceColorLifecycleStressDelta: fdmSurfaceInstanceColorStressDelta,
        fdmNeutralSurfaceColorProof,
        fdmNeutralSurfaceColorDiagnostics,
        gpuLifecycleTimeline,
        gpuLifecycleTimelineDropped,
        errors: errors.slice(-10),
        fieldRequests: fieldRequests.slice(-10),
        fixtureRequests: fixtureRequests.slice(-20),
        requestFailureDiagnostics,
        topologyRequests: topologyRequests.slice(-10),
        visualizationAckRequests: visualizationAckRequests.slice(-32),
        latestVisualizationAcks: fixture.clientAcks,
        visualizationState: fixture.visualizationState,
      },
      null,
      2,
    ),
  );
  try {
    await mkdir(auditArtifactsDirectory, { recursive: true });
    await writeFile(
      path.join(auditArtifactsDirectory, "instance-color-lifecycle.failure.json"),
      `${JSON.stringify({
        instanceColorLifecycle,
        fdmNeutralSurfaceColorProof,
        fdmNeutralSurfaceColorDiagnostics,
        instanceColorLifecycleBeforeStress:
          fdmSurfaceInstanceColorBeforeStress?.summary ?? null,
        instanceColorLifecycleStressDelta: fdmSurfaceInstanceColorStressDelta,
      }, null, 2)}\n`,
    );
  } catch {
    // Diagnostic artifact failure must not replace the original audit failure.
  }
}

async function setAuditStep(page, step) {
  await page.evaluate((nextStep) => {
    window.__FM_VIEWPORT_AUDIT_STEP__ = nextStep;
  }, step);
}

async function waitForCondition(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function waitForCanvasReady(canvas) {
  await canvas.evaluate((node) =>
    new Promise((resolve) => {
      const deadline = performance.now() + 5_000;
      const tick = () => {
        const rect = node.getBoundingClientRect();
        if ((rect.width > 0 && rect.height > 0) || performance.now() > deadline) {
          resolve(undefined);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    }),
  );
}

async function waitForDiagnostics(viewport) {
  await viewport.evaluate((node) =>
    new Promise((resolve, reject) => {
      const deadline = performance.now() + 15_000;
      const tick = () => {
        const spans = Array.from(node.querySelectorAll(".fm-viewport-3d__hud span"));
        if (spans.some((span) => span.textContent?.includes("geo:"))) {
          resolve(undefined);
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error("Timed out waiting for viewport diagnostics HUD."));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    }),
  );
}

async function readDiagnostics(viewport) {
  const value = await viewport.evaluate((node) => {
    const spans = Array.from(node.querySelectorAll(".fm-viewport-3d__hud span"));
    return spans.find((span) => span.textContent?.includes("geo:"))?.textContent ?? "";
  });
  return {
    cacheBytes: parseCacheBytes(readDiagnosticToken(value, "cache")),
    frames: Number(readDiagnosticToken(value, "frames") ?? 0),
    geo: Number(readDiagnosticToken(value, "geo") ?? 0),
    raw: value,
  };
}

async function readJsHeapBytes(cdp) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const result = await cdp.send("Performance.getMetrics");
  const metric = result.metrics.find((entry) => entry.name === "JSHeapUsedSize");
  if (!metric || !Number.isFinite(metric.value)) {
    throw new Error("Chromium did not expose JSHeapUsedSize.");
  }
  return Number(metric.value);
}

function readDiagnosticToken(value, key) {
  const match = value.match(new RegExp(`(?:^|\\s)${key}:([^\\s]+)`));
  return match?.[1] ?? null;
}

function parseCacheBytes(value) {
  if (!value) return 0;
  const match = value.match(/^([0-9]+)(B|KB|MB)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  if (match[2] === "MB") return amount * 1024 * 1024;
  if (match[2] === "KB") return amount * 1024;
  return amount;
}

function formatBytes(value) {
  const amount = Math.max(0, Math.round(Number(value)));
  if (amount >= 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)}MB`;
  if (amount >= 1024) return `${(amount / 1024).toFixed(1)}KB`;
  return `${amount}B`;
}

function auditLog(...parts) {
  console.log("[viewport-memory-audit]", ...parts);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function sleep(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
