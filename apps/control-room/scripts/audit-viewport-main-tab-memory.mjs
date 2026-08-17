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

  await mkdir(outputDir, { recursive: true });
  const browser = await playwright.chromium.launch({
    args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
  });
  const page = await browser.newPage({
    viewport: { height: 900, width: 1440 },
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
      await activateTab(page, moduleId, settleMs);
      const after = await readViewportSignals(page);
      const requests = classifiedRequests.slice(requestStart);
      const observation = {
        activeModuleId: after.activeModuleId,
        canvasCount: after.canvasCount,
        clientAckRequestsDelta: requests.filter(
          (request) => request.kind === "client-ack",
        ).length,
        index: index + 1,
        moduleId,
        rootCount: after.rootCount,
        threeDRequests: requests.filter(
          (request) => request.kind !== "client-ack",
        ),
        viewport3DRenderMeasuresAfter: after.viewport3DRenderMeasures,
        viewport3DRenderMeasuresBefore: before.viewport3DRenderMeasures,
        viewport3DRenderMeasuresDelta:
          after.viewport3DRenderMeasures - before.viewport3DRenderMeasures,
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
      observations,
      pass,
      schema_version: "viewport-main-active-tab-memory-v1",
      switch_count: switchCount,
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
        observations,
        pass: false,
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

function assertInactiveTabObservation(observation) {
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
  observation.passed = failures.length === 0;
  if (!observation.passed) {
    throw new Error(
      `Inactive ${observation.moduleId} tab violated the 3D lifecycle contract: ${failures.join(" | ")}`,
    );
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
  }), THREE_D_RENDER_MEASURE_PREFIX);
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
