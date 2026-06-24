import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  null;
const scenario = process.env.CONTROL_ROOM_DIAGNOSTICS_SCENARIO ?? "boot";
const interactive = process.env.CONTROL_ROOM_DIAGNOSTICS_INTERACTIVE === "1";
const headless =
  process.env.CONTROL_ROOM_DIAGNOSTICS_HEADLESS === "0" ? false : !interactive;
const allowMissingSession =
  process.env.CONTROL_ROOM_DIAGNOSTICS_ALLOW_MISSING_SESSION === "1";
const traceEnabled = process.env.CONTROL_ROOM_DIAGNOSTICS_TRACE === "1";
const disable3DAirbox =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_AIRBOX === "1";
const disable3DObjects =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_OBJECTS === "1";
const disable3DOrientationHud =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_ORIENTATION_HUD === "1";
const disable3DDimensionFrame =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_DIMENSION_FRAME === "1";
const disable3DOverlays =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_OVERLAYS === "1";
const disable3DPrimitives =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_PRIMITIVES === "1";
const disable3DTopologyMesh =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_TOPOLOGY_MESH === "1";
const disable3DVectors =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_VECTORS === "1";
const disable3DFieldColors =
  process.env.CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_FIELD_COLORS === "1";
const timeoutMs = numericEnv("CONTROL_ROOM_DIAGNOSTICS_TIMEOUT_MS", 120_000);
const canvasTimeoutMs = numericEnv(
  "CONTROL_ROOM_DIAGNOSTICS_CANVAS_TIMEOUT_MS",
  Math.min(timeoutMs, 120_000),
);
const outputRoot =
  process.env.CONTROL_ROOM_DIAGNOSTICS_OUTPUT_DIR ??
  path.join(process.cwd(), "artifacts", "diagnostics");

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
  console.error("Diagnostic recorder requires Playwright or @playwright/test.");
  process.exit(2);
}

const artifactDir = path.join(outputRoot, `${timestampSlug()}-${scenario}`);
const screenshotsDir = path.join(artifactDir, "screenshots");
await mkdir(screenshotsDir, { recursive: true });

const browser = await playwright.chromium.launch({
  args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
  headless,
});
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
const cdp = await page.context().newCDPSession(page);
const consoleRecords = [];
const requestRecords = [];
const browserMetricRecords = [];
const traceEvents = [];
let traceComplete = Promise.resolve();

await cdp.send("Performance.enable").catch(() => undefined);
await cdp.send("HeapProfiler.enable").catch(() => undefined);
await cdp.send("Runtime.enable").catch(() => undefined);

if (traceEnabled) {
  traceComplete = new Promise((resolve) => {
    cdp.on("Tracing.dataCollected", (event) => {
      traceEvents.push(...(event.value ?? []));
    });
    cdp.on("Tracing.tracingComplete", resolve);
  });
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,v8,blink,disabled-by-default-v8.cpu_profiler",
    transferMode: "ReportEvents",
  });
}

await page.addInitScript(
  ({
    allowMissingSession,
    apiBase,
    disable3DAirbox,
    disable3DDimensionFrame,
    disable3DFieldColors,
    disable3DObjects,
    disable3DOverlays,
    disable3DOrientationHud,
    disable3DPrimitives,
    disable3DTopologyMesh,
    disable3DVectors,
    scenario,
  }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      ...(apiBase ? { controlRoomApiBase: apiBase } : {}),
      ...(allowMissingSession ? { allowMissingSessionSmoke: true } : {}),
      ...(disable3DAirbox ? { disableViewport3DAirboxLayer: true } : {}),
      ...(disable3DObjects ? { disableViewport3DSceneLayers: true } : {}),
      ...(disable3DOrientationHud
        ? { disableViewport3DOrientationHud: true }
        : {}),
      ...(disable3DDimensionFrame
        ? { disableViewport3DDimensionFrame: true }
        : {}),
      ...(disable3DOverlays ? { disableViewport3DOverlayLayers: true } : {}),
      ...(disable3DPrimitives
        ? { disableViewport3DPrimitiveObjectLayer: true }
        : {}),
      ...(disable3DTopologyMesh
        ? { disableViewport3DTopologyMeshLayer: true }
        : {}),
      ...(disable3DVectors ? { disableViewport3DVectorLayers: true } : {}),
      ...(disable3DFieldColors
        ? { disableViewport3DFieldColorLayers: true }
        : {}),
      diagnosticRecorderProfile: "forensic",
      diagnosticRecorderScenario: scenario,
      enableDiagnosticRecorder: true,
    };
  },
  {
    allowMissingSession,
    apiBase,
    disable3DAirbox,
    disable3DDimensionFrame,
    disable3DFieldColors,
    disable3DObjects,
    disable3DOverlays,
    disable3DOrientationHud,
    disable3DPrimitives,
    disable3DTopologyMesh,
    disable3DVectors,
    scenario,
  },
);

page.on("console", (message) => {
  if (message.type() !== "error" && message.type() !== "warning") return;
  consoleRecords.push(consoleRecord({
    level: message.type() === "error" ? "error" : "warn",
    message: message.text(),
    source: "playwright.console",
  }));
});
page.on("pageerror", (error) => {
  consoleRecords.push(consoleRecord({
    level: "error",
    message: error.stack ?? error.message,
    source: "playwright.pageerror",
  }));
});
page.on("request", (request) => {
  requestRecords.push({
    method: request.method(),
    startedAtMs: Date.now(),
    url: request.url(),
  });
});
page.on("response", (response) => {
  const request = response.request();
  const record = requestRecords.findLast(
    (item) => item.url === request.url() && item.method === request.method(),
  );
  if (record) {
    record.finishedAtMs = Date.now();
    record.status = response.status();
    record.contentType = response.headers()["content-type"] ?? null;
    record.requestId = response.headers()["x-request-id"] ?? null;
    record.etag = response.headers().etag ?? null;
  }
});

try {
  await page.goto(withDiagnosticQuery(url), {
    timeout: timeoutMs,
    waitUntil: "domcontentloaded",
  });
  await page.screenshot({ path: path.join(screenshotsDir, "000-start.png") });
  await waitForInPageRecorder(page);
  await runScenario(page, scenario);
  await collectBrowserMetrics(cdp, browserMetricRecords);
  await page.screenshot({
    path: path.join(screenshotsDir, "020-after-scenario.png"),
  });

  if (interactive) {
    await waitForInteractiveStop();
  }

  const artifact = await exportInPageArtifact(page);
  mergePlaywrightStreams(artifact, {
    browserMetricRecords,
    consoleRecords,
    requestRecords,
  });

  if (traceEnabled) {
    await cdp.send("Tracing.end").catch(() => undefined);
    await traceComplete;
  }

  await writeArtifactDirectory(artifact, {
    artifactDir,
    traceEvents,
  });

  console.log(`Diagnostic artifact: ${artifactDir}`);
  console.log(topSuspectsText(artifact));
} catch (error) {
  await page.screenshot({
    path: path.join(screenshotsDir, "999-failure.png"),
  }).catch(() => undefined);
  throw error;
} finally {
  await browser.close();
}

async function runScenario(page, scenarioName) {
  if (scenarioName === "interactive") return;
  if (scenarioName === "viewport-3d" || scenarioName === "memory-leak") {
    const canvas = page.locator(".fm-viewport-3d canvas");
    await canvas.waitFor({ state: "visible", timeout: canvasTimeoutMs });
    await waitForCanvasReady(page);
    await page.screenshot({
      path: path.join(screenshotsDir, "010-first-viewport.png"),
    });
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40);
      await page.mouse.up({ button: "right" });
    }
  }
  if (scenarioName === "memory-leak") {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
    await collectBrowserMetrics(cdp, browserMetricRecords);
  }
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
}

async function waitForInPageRecorder(page) {
  await page.waitForFunction(
    () =>
      typeof window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__ === "function" ||
      Boolean(window.__FULLMAG_DIAGNOSTIC_RECORDER__?.exportArtifact),
    undefined,
    { timeout: Math.min(timeoutMs, 30_000) },
  );
}

async function exportInPageArtifact(page) {
  const artifact = await page.evaluate(() => {
    if (typeof window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__ === "function") {
      return window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__();
    }
    return window.__FULLMAG_DIAGNOSTIC_RECORDER__?.exportArtifact?.() ?? null;
  });
  if (!artifact) {
    throw new Error("The page did not expose a diagnostic artifact.");
  }
  return artifact;
}

async function waitForCanvasReady(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    return Boolean(
      gl &&
      !gl.isContextLost() &&
      gl.drawingBufferWidth > 0 &&
      gl.drawingBufferHeight > 0,
    );
  }, undefined, { timeout: canvasTimeoutMs });
}

async function collectBrowserMetrics(cdp, records) {
  const metrics = await cdp.send("Performance.getMetrics").catch(() => null);
  const timestampMs = Date.now();
  for (const metric of metrics?.metrics ?? []) {
    records.push({
      byteLength: null,
      detail: { source: "cdp.performance" },
      droppedCount: 0,
      durationMs: null,
      id: `cdp-${timestampMs}-${metric.name}`,
      kind: "browser-metric",
      lane: "browser",
      metricName: metric.name,
      name: `cdp.metric.${metric.name}`,
      severity: "info",
      startTimeMs: null,
      timestampMs,
      unit: inferMetricUnit(metric.name),
      value: metric.value,
    });
  }
  const heap = await cdp.send("Runtime.getHeapUsage").catch(() => null);
  if (heap) {
    records.push({
      byteLength: heap.usedSize,
      detail: { source: "cdp.heap" },
      droppedCount: 0,
      durationMs: null,
      id: `cdp-${timestampMs}-heap-used`,
      kind: "browser-metric",
      lane: "browser",
      metricName: "JSHeapUsedSize",
      name: "cdp.heap.used",
      severity: "info",
      startTimeMs: null,
      timestampMs,
      unit: "bytes",
      value: heap.usedSize,
    });
  }
}

function mergePlaywrightStreams(
  artifact,
  { browserMetricRecords, consoleRecords, requestRecords },
) {
  artifact.streams.console.push(...consoleRecords);
  artifact.streams.browserMetrics.push(...browserMetricRecords);
  artifact.streams.requests.push(
    ...requestRecords
      .filter((record) => record.finishedAtMs)
      .map((record, index) => requestRecord(record, index)),
  );
  if (consoleRecords.some((record) => record.level === "error")) {
    artifact.suspectReport.text +=
      "\n\n## Playwright Page Errors\n" +
      consoleRecords
        .filter((record) => record.level === "error")
        .slice(0, 20)
        .map((record) => `- ${record.message}`)
        .join("\n");
  }
}

async function writeArtifactDirectory(artifact, { artifactDir, traceEvents }) {
  await writeJson(path.join(artifactDir, "manifest.json"), artifact.manifest);
  await writeJson(path.join(artifactDir, "summary.json"), artifact.summary);
  await writeFile(
    path.join(artifactDir, "suspect-report.md"),
    artifact.suspectReport.text,
  );
  await writeNdjson(path.join(artifactDir, "timeline.ndjson"), artifact.streams.timeline);
  await writeNdjson(path.join(artifactDir, "performance.ndjson"), artifact.streams.performance);
  await writeNdjson(path.join(artifactDir, "requests.ndjson"), artifact.streams.requests);
  await writeNdjson(path.join(artifactDir, "resources.ndjson"), artifact.streams.resources);
  await writeNdjson(path.join(artifactDir, "memory.ndjson"), artifact.streams.memory);
  await writeNdjson(path.join(artifactDir, "viewport-3d.ndjson"), artifact.streams.viewport3d);
  await writeNdjson(path.join(artifactDir, "console.ndjson"), artifact.streams.console);
  await writeNdjson(path.join(artifactDir, "react.ndjson"), artifact.streams.react);
  await writeNdjson(
    path.join(artifactDir, "browser-metrics.ndjson"),
    artifact.streams.browserMetrics,
  );
  await writeJson(path.join(artifactDir, "artifact.json"), artifact);
  await writeJson(path.join(artifactDir, "chromium-trace.json"), {
    traceEvents,
  });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeNdjson(filePath, records) {
  await writeFile(
    filePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}

function requestRecord(record, index) {
  const { pathname, search } = new URL(record.url);
  return {
    byteLength: null,
    contentType: record.contentType ?? null,
    detail: { source: "playwright" },
    droppedCount: 0,
    durationMs: Math.max(0, record.finishedAtMs - record.startedAtMs),
    etag: record.etag ?? null,
    id: `playwright-request-${index}`,
    kind: "request",
    lane: "api",
    method: record.method,
    name: "playwright.request.finished",
    outcome: record.status >= 400 ? "error" : "ok",
    path: pathname,
    query: search ? search.slice(1) : null,
    requestId: record.requestId,
    resourceKey: `${pathname}${search}`,
    severity: record.status >= 500 ? "warning" : "info",
    startTimeMs: null,
    status: record.status,
    timestampMs: record.finishedAtMs,
  };
}

function consoleRecord({ level, message, source }) {
  const timestampMs = Date.now();
  return {
    byteLength: null,
    detail: { source },
    droppedCount: 0,
    durationMs: null,
    id: `playwright-console-${timestampMs}-${consoleRecords.length}`,
    kind: "console",
    lane: "console",
    level,
    message: message.slice(0, 4_000),
    name: source,
    severity: level === "error" ? "critical" : "warning",
    source,
    startTimeMs: null,
    timestampMs,
  };
}

function topSuspectsText(artifact) {
  const suspects = artifact.suspectReport.suspects ?? [];
  if (suspects.length === 0) return "Suspects: none";
  return [
    "Suspects:",
    ...suspects
      .slice(0, 5)
      .map((suspect, index) => `${index + 1}. [${suspect.severity}] ${suspect.reason}`),
  ].join("\n");
}

async function waitForInteractiveStop() {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await readline.question("Recording. Press Enter to export diagnostics.\n");
  readline.close();
}

function withDiagnosticQuery(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.searchParams.set("diagnostics", "record");
  return parsed.toString();
}

function inferMetricUnit(name) {
  return /bytes|size/i.test(name) ? "bytes" : /duration|time/i.test(name) ? "ms" : "count";
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
