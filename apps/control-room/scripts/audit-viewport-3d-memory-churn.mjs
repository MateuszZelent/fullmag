import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";

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
const FIELD_GRID = [24, 16, 2];
const FDM_PARTIAL_LAYER_ID = "layer:partial";
const FDM_DENSE_LAYER_ID = "layer:dense";
const FDM_MULTILAYER_LAYOUT_REVISION = 7;
const FDM_MULTILAYER_GRID_FINGERPRINT = "a1".repeat(32);
const FDM_PARTIAL_INACTIVE_CELL_INDICES = [0, 23, 384, 767];
const FDM_PARTIAL_ACTIVE_MASK = createPartialActiveMask();
const FDM_PARTIAL_PACKED_MASK = packActiveMask(FDM_PARTIAL_ACTIVE_MASK);
const FDM_PARTIAL_MASK_HASH = createHash("sha256")
  .update(FDM_PARTIAL_PACKED_MASK)
  .digest("hex");
const QUANTITY_SEQUENCE = Array.from(
  { length: 120 },
  (_, index) => ["m", "H_eff", "H_demag", "H_ex"][index % 4],
);
const WARM_QUANTITIES = ["m", "H_eff", "H_demag", "H_ex"];
const MAX_HEAP_GROWTH_BYTES = 25 * 1024 * 1024;
const QUANTITY_SWITCH_TIMEOUT_MS = 20_000;
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
const fixture = createFdmFixture();
let auditActive = false;

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

  for (const quantity of WARM_QUANTITIES) {
    auditLog("warming quantity", quantity);
    await withTimeout(
      setGlobalQuantity(page, fixture, fixtureRequests, quantity, {
        allowExistingFieldRequest: true,
        // The production-like no-session fixture may already have the selected
        // field in its browser resource cache during bootstrap.
        requireFieldRequest: false,
      }),
      QUANTITY_SWITCH_TIMEOUT_MS,
      `Timed out warming viewport quantity ${quantity}.`,
    );
  }
  await page.waitForTimeout(500);

  auditLog("reading baseline diagnostics");
  const baseline = {
    diagnostics: await readDiagnostics(viewport),
    gpu: await readBrowserAuditCounters(page),
    runtime: await readViewportAuditRuntime(page),
    heapBytes: await readJsHeapBytes(cdp),
  };
  rawPerformanceTrace.push(await captureViewportPerformanceSnapshot(page, "baseline"));

  await page.locator('[data-action-id="ws-2d"]').click();
  await page.locator(".fm-viewport-3d canvas").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(1_000);
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
  if (injectListenerLeak) {
    await page.evaluate(() => window.__FULLMAG_CONTROL_ROOM_AUDIT__?.injectViewportAuditListenerLeak());
  }
  if (injectWorkerLeak) {
    await page.evaluate(() => window.__FULLMAG_CONTROL_ROOM_AUDIT__?.injectViewportAuditWorkerLeak());
  }

  auditActive = true;
  const quantitySwitchFieldGetsBefore = fieldRequests.length;
  const quantitySwitchPerformanceBefore = await captureViewportPerformanceSnapshot(
    page,
    "quantity-switch-before",
  );
  rawPerformanceTrace.push(quantitySwitchPerformanceBefore);
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
  }
  await page.waitForTimeout(500);
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
  const shaderSignatures = await collectStableShaderSignatures(page, fixture, viewport);
  await page.screenshot({ path: path.join(auditArtifactsDirectory, "settled-3d.png") });
  if (injectGpuBufferLeak) {
    await injectViewportGpuBufferLeak(page);
  }
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
  await writeAuditArtifact({
    after,
    afterUnmount,
    afterUnmountRuntime,
    baseline,
    unmountedBaselineRuntime,
    shaderSignatures,
    fixtureRequests,
    gpuAfterStress,
    idle,
    idleRequests,
    partialMultilayer,
    quantitySwitchPerformanceDelta,
    rawPerformanceTrace,
    fidelity,
    topologyRequests,
    url,
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
    topologyRequests,
  });
  throw error;
} finally {
  auditActive = false;
  await browser.close();
  await managedRuntime?.stop();
}

async function assertCanvasHasFidelity(page) {
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
  try {
    screenshot = await page.screenshot({ clip: box });
  } finally {
    await canvas.evaluate(() => {
      document.querySelector('[data-viewport-audit-isolation="true"]')?.remove();
    });
  }
  const sample = await page.evaluate(async (encodedPng) => {
    const response = await fetch(`data:image/png;base64,${encodedPng}`);
    const bitmap = await createImageBitmap(await response.blob());
    const target = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = target.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let varied = 0;
    let signature = 2166136261;
    const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
    const reference = [pixels[0], pixels[1], pixels[2]];
    for (let y = 0; y < bitmap.height; y += stride) {
      for (let x = 0; x < bitmap.width; x += stride) {
        const offset = (y * bitmap.width + x) * 4;
        signature ^= pixels[offset] ^ pixels[offset + 1] ^ pixels[offset + 2] ^ pixels[offset + 3];
        signature = Math.imul(signature, 16777619);
        if (
          Math.abs(pixels[offset] - reference[0]) > 8 ||
          Math.abs(pixels[offset + 1] - reference[1]) > 8 ||
          Math.abs(pixels[offset + 2] - reference[2]) > 8
        ) varied += 1;
      }
    }
    return { height: bitmap.height, signature: String(signature >>> 0), varied, width: bitmap.width };
  }, screenshot.toString("base64"));
  if (!sample || sample.varied === 0) {
    throw new Error("Viewport fidelity gate detected a blank or uniform WebGL drawing buffer.");
  }
  return sample;
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

async function collectStableShaderSignatures(page, fixture, viewport) {
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
    const counters = {
      bufferBytesUploaded: 0,
      buffersCreated: 0,
      buffersDeleted: 0,
      drawCalls: 0,
      frames: 0,
    };
    const fdmBuildRequests = new Map();
    const fdmBuildResults = [];
    Object.defineProperty(counters, "fdmBuildResults", {
      enumerable: false,
      value: fdmBuildResults,
    });
    window.__FM_VIEWPORT_BROWSER_AUDIT__ = counters;

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
      if (gl.__fullmagAuditWrapped) return gl;
      gl.__fullmagAuditWrapped = true;
      for (const name of ["createBuffer", "deleteBuffer", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          if (name === "createBuffer") counters.buffersCreated += 1;
          if (name === "deleteBuffer") counters.buffersDeleted += 1;
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

async function installFdmFixtureApi(page, fixture, requests) {
  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    requests.push(`${request.method()} ${requestUrl.pathname}`);
    if (request.method() === "OPTIONS") {
      await fulfillEmpty(route, 204);
      return;
    }

    const path = requestUrl.pathname;
    if (path === "/v2/sessions") {
      await fulfillJson(route, {
        schema_version: "session-list.v1",
        sessions: [{
          current: true,
          name: "FDM memory churn fixture",
          session_id: "fdm-memory-churn-fixture",
          status: "running",
        }],
      });
      return;
    }
    if (path === "/v2/platform/health") {
      await fulfillJson(route, {
        active_session: true,
        api_contract_version: "v2",
        status: "ok",
        uptime_seconds: 1,
      });
      return;
    }
    if (path === "/v2/platform/capabilities") {
      await fulfillJson(route, { engines: [], profile_version: "fixture.v1" });
      return;
    }
    if (path === "/v2/sessions/current/status") {
      await fulfillJson(route, fdmStatusFixture(fixture));
      return;
    }
    if (path === "/v2/sessions/current/visualization/state") {
      if (request.method() === "PATCH") {
        const patch = parsePatchBody(request);
        fixture.visualizationState = applyPatch(fixture.visualizationState, patch);
        fixture.visualizationState.revision += 1;
        fixture.patchCount += 1;
        fixture.status.resources.visualization_state_revision =
          fixture.visualizationState.revision;
      }
      await fulfillJson(route, fixture.visualizationState);
      return;
    }
    if (path === "/v2/sessions/current/data/domain/meta") {
      await fulfillJson(route, fdmDomainMetaFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/fdm-multilayer-layout") {
      if (fixture.multilayerEnabled) {
        await fulfillJson(route, fdmMultilayerLayoutFixture());
      } else {
        await fulfillEmpty(route, 204);
      }
      return;
    }
    if (path === fdmMultilayerActiveMaskPath(FDM_PARTIAL_LAYER_ID)) {
      if (fixture.multilayerEnabled) {
        await fulfillBinary(route, makeFdmMultilayerActiveMaskBuffer());
      } else {
        await fulfillEmpty(route, 404);
      }
      return;
    }
    if (path === "/v2/sessions/current/data/fields") {
      await fulfillJson(route, fdmFieldCatalogFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/topology") {
      await fulfillEmpty(route, 204);
      return;
    }
    if (path.startsWith("/v2/sessions/current/data/fields/")) {
      const quantityId = decodeURIComponent(path.split("/")[6] ?? "m");
      const etag = `"fdm-memory-${quantityId}"`;
      if (request.headers()["if-none-match"] === etag) {
        await fulfillEmpty(route, 304, { etag });
        return;
      }
      await fulfillBinary(route, makeFdmFieldVectorBuffer(quantityId), 200, {
        etag,
      });
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      await fulfillJson(route, { objects: [], revision: 0, schema_version: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/universe") {
      await fulfillJson(route, {
        mesh_dirty: false,
        object_bounds_max: [6e-7, 4e-7, 1e-7],
        object_bounds_min: [-6e-7, -4e-7, -1e-7],
        scene_revision: 0,
        study_universe_mesh: null,
        universe: null,
      });
      return;
    }
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
      await fulfillEmpty(route, 204);
      return;
    }

    await fulfillEmpty(route, 204);
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

function fdmMultilayerActiveMaskPath(layerId) {
  return `/v2/sessions/current/data/domain/fdm-multilayer-layers/${encodeURIComponent(layerId)}/active-mask`;
}

async function reportAuditFailure(
  page,
  fixture,
  { errors, fieldRequests, fixtureRequests, topologyRequests },
) {
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
        errors: errors.slice(-10),
        fieldRequests: fieldRequests.slice(-10),
        fixtureRequests: fixtureRequests.slice(-20),
        topologyRequests: topologyRequests.slice(-10),
        visualizationState: fixture.visualizationState,
      },
      null,
      2,
    ),
  );
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

function applyPatch(state, patch) {
  return mergeRecords(state, patch ?? {});
}

function parsePatchBody(request) {
  try {
    const value = request.postDataJSON();
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function mergeRecords(current, patch) {
  const output = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const previous = output[key];
    output[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? mergeRecords(previous, value)
        : value;
  }
  return output;
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: fixtureHeaders({ "content-type": "application/json" }),
    status,
  });
}

async function fulfillBinary(route, arrayBuffer, status = 200, extra = {}) {
  await route.fulfill({
    body: Buffer.from(arrayBuffer),
    headers: fixtureHeaders({
      "content-type": "application/octet-stream",
      ...extra,
    }),
    status,
  });
}

async function fulfillEmpty(route, status = 204, extra = {}) {
  await route.fulfill({
    body: "",
    headers: fixtureHeaders(extra),
    status,
  });
}

function fixtureHeaders(extra = {}) {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
    ...extra,
  };
}

function createFdmFixture() {
  const visualizationState = fdmVisualizationStateFixture();
  const status = fdmStatusFixture({ visualizationState });
  return { patchCount: 0, status, visualizationState };
}

function fdmStatusFixture(fixture) {
  const revision = fixture.visualizationState?.revision ?? 1;
  const quantityId =
    fixture.visualizationState?.quantity?.active_quantity_id ??
    fixture.visualizationState?.active_quantity_id ??
    "m";
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: false,
      node_fields: false,
      preview_2d: false,
      preview_3d: true,
      scalar_history: false,
      structured_grid: true,
    },
    display: {
      active_quantity_id: quantityId,
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 120000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 2,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2],
      discretization: "fdm",
      generation_id: 1,
    },
    energies: {},
    metrics: {
      steps_per_second: null,
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: revision,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 1,
      field_revision: 1,
      fields_revision: 1,
      mesh_build_revision: 0,
      mesh_revision: 0,
      scalars_revision: 0,
      scene_revision: 0,
      slice_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: revision,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "memory-churn-fixture",
    session: {
      created_at: "0",
      name: "fdm-memory-churn-fixture",
      session_epoch: "fdm-memory-churn-fixture@0",
      session_id: "fdm-memory-churn-fixture",
      workspace_root: "/tmp/fullmag-fdm-memory-fixture",
    },
    solver: {
      state: "idle",
    },
  };
}

function fdmDomainMetaFixture() {
  return {
    bounds: {
      max: [6e-7, 4e-7, 1e-7],
      min: [-6e-7, -4e-7, -1e-7],
    },
    coordinate_system: "cartesian",
    counts: { cells: FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2] },
    dimension: 3,
    discretization: "fdm",
    domain_id: "fdm-memory-churn-domain",
    generation_id: 1,
    grid: {
      origin: [-6e-7, -4e-7, -1e-7],
      shape: FIELD_GRID,
      spacing: [1.25e-8, 1.25e-8, 5e-8],
    },
    units: { length: "m" },
  };
}

function fdmMultilayerLayoutFixture() {
  const totalCells = FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2];
  const nativeCellSize = [1.25e-8, 1.25e-8, 5e-8];
  const nativeGridFingerprint = `sha256:${FDM_MULTILAYER_GRID_FINGERPRINT}`;
  return {
    airbox: {
      carrier_available: false,
      h_demag_available: false,
      h_eff_available: false,
    },
    available: true,
    backend: "fdm_multilayer",
    common_transform_layout: {
      cell_size: nativeCellSize,
      fft_shape: [48, 32, 4],
      is_physical_mesh: false,
      origin: [-6e-7, -4e-7, -1e-7],
      provenance: "audit-fixture;fft-scratch-only",
      shape: FIELD_GRID,
    },
    domain_generation_id: "1",
    execution_revision: 1,
    layers: [
      {
        active_cell_count: totalCells,
        active_mask_present: false,
        convolution_cell_size: nativeCellSize,
        convolution_grid: [48, 32, 4],
        inactive_cell_count: 0,
        layer_id: FDM_DENSE_LAYER_ID,
        magnet_name: "dense",
        native_cell_size: nativeCellSize,
        native_grid: FIELD_GRID,
        native_grid_fingerprint: nativeGridFingerprint,
        native_origin: [-6e-7, -4e-7, -1.5e-7],
        object_id: "object:dense",
        transfer_kind: "push_pull",
      },
      {
        active_cell_count: totalCells - FDM_PARTIAL_INACTIVE_CELL_INDICES.length,
        active_mask_hash: `sha256:${FDM_PARTIAL_MASK_HASH}`,
        active_mask_present: true,
        convolution_cell_size: nativeCellSize,
        convolution_grid: [48, 32, 4],
        inactive_cell_count: FDM_PARTIAL_INACTIVE_CELL_INDICES.length,
        layer_id: FDM_PARTIAL_LAYER_ID,
        magnet_name: "partial",
        mask_provenance: "execution_plan.layers.native_active_mask",
        mask_ref: fdmMultilayerActiveMaskPath(FDM_PARTIAL_LAYER_ID),
        native_cell_size: nativeCellSize,
        native_grid: FIELD_GRID,
        native_grid_fingerprint: nativeGridFingerprint,
        native_origin: [-6e-7, -4e-7, 5e-8],
        object_id: "object:partial",
        transfer_kind: "push_pull",
      },
    ],
    layout_fingerprint: "sha256:fdm-memory-churn-multilayer-layout",
    layout_revision: FDM_MULTILAYER_LAYOUT_REVISION,
    observation_revision: 1,
    requested_mode: "auto",
    resolved_mode: "three_d",
    schema_version: "fdm-multilayer-layout.v1",
    strategy: "multilayer_convolution",
  };
}

function makeFdmMultilayerActiveMaskBuffer() {
  const buffer = new ArrayBuffer(104 + FDM_PARTIAL_PACKED_MASK.byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMBM"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, FIELD_GRID[0], true);
  view.setUint32(12, FIELD_GRID[1], true);
  view.setUint32(16, FIELD_GRID[2], true);
  view.setUint32(20, FDM_PARTIAL_ACTIVE_MASK.length, true);
  view.setUint32(24, FDM_PARTIAL_PACKED_MASK.byteLength, true);
  view.setBigUint64(28, BigInt(FDM_MULTILAYER_LAYOUT_REVISION), true);
  writeHexBytes(view, 36, FDM_MULTILAYER_GRID_FINGERPRINT);
  writeHexBytes(view, 68, FDM_PARTIAL_MASK_HASH);
  new Uint8Array(buffer, 104).set(FDM_PARTIAL_PACKED_MASK);
  return buffer;
}

function createPartialActiveMask() {
  const activeMask = new Uint8Array(FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2]);
  activeMask.fill(1);
  for (const cellIndex of FDM_PARTIAL_INACTIVE_CELL_INDICES) {
    activeMask[cellIndex] = 0;
  }
  return activeMask;
}

function packActiveMask(activeMask) {
  const packed = new Uint8Array(Math.ceil(activeMask.length / 8));
  for (let cellIndex = 0; cellIndex < activeMask.length; cellIndex += 1) {
    packed[cellIndex >> 3] |= (activeMask[cellIndex] ?? 0) << (cellIndex & 7);
  }
  return packed;
}

function writeHexBytes(view, offset, hex) {
  for (let index = 0; index < hex.length / 2; index += 1) {
    view.setUint8(
      offset + index,
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    );
  }
}

function fdmFieldCatalogFixture() {
  return {
    domain_generation_id: "1",
    revision: 1,
    quantities: ["m", "H_eff", "H_demag", "H_ex"].map((quantityId) => ({
      available: true,
      components: 3,
      domain_generation_id: "1",
      field_revision: 1,
      kind: "vector",
      label: quantityId,
      location: "cell",
      materialization_wall_time_ns: 0,
      materialized_at_unix_ms: 0,
      quantity_id: quantityId,
      source_revision: 1,
      source_step: 0,
      stale_by_steps: 0,
      state: "complete",
      unit: "A/m",
    })),
  };
}

function fdmVisualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [1.4e-6, 1.0e-6, 8e-7],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: {
      enabled: false,
      normal_axis: "z",
      offset: 0,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: {
      active_scope_id: null,
      active_scope_kind: "domain",
    },
    fdm: {
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    fem: {
      topology_mode: "surface",
      volume_edges_budget: 0,
    },
    field_component: "magnitude",
    layers: {
      bounds: { visible: true },
      points: { visible: false },
      quantity_overlay: { visible: true },
      surface: { opacity: 0.94, visible: true },
      vectors: { density: 2, domain: "full_domain", visible: true },
      wireframe: { visible: true },
    },
    max_points: 120000,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision: 1,
    sampling: {
      max_glyphs: 192,
      max_points: 120000,
    },
    schema_version: 1,
    slice: {
      layer: 0,
      mode: "xy",
    },
    slice_layer: 0,
    slice_mode: "xy",
    trim: {
      enabled: false,
      max: [1, 1, 1],
      min: [0, 0, 0],
    },
    vector_density: 2,
    vector_glyphs: true,
    vector_style: {
      alpha: 1,
      color_mode: "orientation",
      ferromagnet_visibility: "ghost",
      length_scale: 1,
      mono_color: "#89b4fa",
      thickness: 1.4,
    },
    view_mode: "3d",
    x_chosen_size: 1,
    y_chosen_size: 1,
  };
}

function makeFdmFieldVectorBuffer(quantityId) {
  const pointCount = FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2];
  const valueCount = pointCount * 3;
  const buffer = new ArrayBuffer(
    48 + valueCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, FIELD_GRID[0], true);
  view.setUint32(20, FIELD_GRID[1], true);
  view.setUint32(24, FIELD_GRID[2], true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));

  const values = new Float64Array(buffer, 48);
  const phase = quantityPhase(quantityId);
  let offset = 0;
  for (let z = 0; z < FIELD_GRID[2]; z += 1) {
    for (let y = 0; y < FIELD_GRID[1]; y += 1) {
      for (let x = 0; x < FIELD_GRID[0]; x += 1) {
        const centeredX = (x - (FIELD_GRID[0] - 1) / 2) / ((FIELD_GRID[0] - 1) / 2);
        const centeredY = (y - (FIELD_GRID[1] - 1) / 2) / ((FIELD_GRID[1] - 1) / 2);
        const centeredZ = (z - (FIELD_GRID[2] - 1) / 2) / ((FIELD_GRID[2] - 1) / 2);
        const vx = Math.sin(centeredX * Math.PI + phase);
        const vy = Math.cos(centeredY * Math.PI - phase);
        const vz = Math.sin(centeredZ * Math.PI * 0.5 + phase * 0.5);
        const length = Math.hypot(vx, vy, vz) || 1;
        values[offset++] = vx / length;
        values[offset++] = vy / length;
        values[offset++] = vz / length;
      }
    }
  }

  return buffer;
}

function quantityPhase(quantityId) {
  if (quantityId === "H_eff") return 0.7;
  if (quantityId === "H_demag") return 1.4;
  if (quantityId === "H_ex") return 2.1;
  return 0.0;
}

function currentFixtureQuantity(fixture) {
  return (
    fixture.visualizationState?.quantity?.active_quantity_id ??
    fixture.visualizationState?.active_quantity_id ??
    "m"
  );
}
