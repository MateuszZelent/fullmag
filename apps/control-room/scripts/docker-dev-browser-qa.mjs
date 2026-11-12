import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runViewportAppearanceBrowserQa } from "./lib/viewport-appearance-browser-qa.mjs";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";
import { runViewportExportBrowserQa } from "./lib/viewport-export-browser-qa.mjs";
import { runViewportLifecycleBrowserQa } from "./lib/viewport-lifecycle-browser-qa.mjs";
import { installViewportPerformanceProbe } from "./lib/viewport-performance-proof.mjs";
import { runViewportLayoutBrowserQa } from "./lib/viewport-layout-browser-qa.mjs";
import { runViewportQaFixtureBrowser } from "./lib/viewport-qa-fixture-browser.mjs";
import { runViewportCameraBrowserQa } from "./lib/viewport-camera-browser-qa.mjs";
import { runTerminalFooterTelemetryBrowserQa } from "./docker-dev-terminal-telemetry.mjs";

const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json");
const playwrightRequire = createRequire(require.resolve("playwright/package.json"));
const { PNG } = playwrightRequire("playwright-core/lib/utilsBundle");
const runnerSourcePath = fileURLToPath(import.meta.url);
const appearanceQaSourcePath = fileURLToPath(new URL("./lib/viewport-appearance-browser-qa.mjs", import.meta.url));
const proxySourcePath = fileURLToPath(new URL("./lib/browser-qa-loopback-proxy.mjs", import.meta.url));
const exportSourcePath = fileURLToPath(new URL("./lib/viewport-export-browser-qa.mjs", import.meta.url));
const lifecycleSourcePath = fileURLToPath(new URL("./lib/viewport-lifecycle-browser-qa.mjs", import.meta.url));
const performanceSourcePath = fileURLToPath(new URL("./lib/viewport-performance-proof.mjs", import.meta.url));
const layoutSourcePath = fileURLToPath(new URL("./lib/viewport-layout-browser-qa.mjs", import.meta.url));
const fixtureSourcePath = fileURLToPath(new URL("./lib/viewport-qa-fixture-browser.mjs", import.meta.url));
const scratchSourcePath = fileURLToPath(new URL("./lib/scratch-authoring-browser.mjs", import.meta.url));
const fixtureDataPath = fileURLToPath(new URL("./fixtures/scratch-authoring/fdm.v1.json", import.meta.url));
const cameraSourcePath = fileURLToPath(new URL("./lib/viewport-camera-browser-qa.mjs", import.meta.url));
const terminalTelemetrySourcePath = fileURLToPath(new URL("./docker-dev-terminal-telemetry.mjs", import.meta.url));
const planarFieldEvidenceSourcePath = fileURLToPath(new URL("./lib/planar-field-evidence.mjs", import.meta.url));
const expectedVersion = process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION ?? "1.62.1";
// Leave room for bounded UI restoration and result publication before the
// managed outer runtime deadline expires.
const timeout = Math.min(Number.parseInt(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS ?? "180000", 10), 30_000);
const publicUrl = process.env.CONTROL_ROOM_PUBLIC_URL ?? "";
const probeUrl = process.env.CONTROL_ROOM_URL ?? "http://frontend:8080";
const browserGpuMode = process.env.CONTROL_ROOM_BROWSER_GPU_MODE ?? "swiftshader-webgl-requested";
const resultSchema = "fullmag.docker-dev-browser-qa-result.v1";
const canvasOnlySetting = process.env.CONTROL_ROOM_BROWSER_QA_CANVAS_ONLY ?? "0";
const canvasOnly = canvasOnlySetting === "1";
const expectedLiveFieldSetting = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_LIVE_FIELD;
const expectedLiveField = expectedLiveFieldSetting ? expectedLiveFieldSetting : null;
const expectAirboxVectorsSetting = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS ?? "0";
const expectAirboxVectors = expectAirboxVectorsSetting === "1";
const expectFemAirboxVectorsSetting = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_FEM_AIRBOX_VECTORS;
const expectFemAirboxVectors = expectFemAirboxVectorsSetting === "1";
const scenarioSetting = process.env.CONTROL_ROOM_BROWSER_QA_SCENARIO ?? "standard";
const expectAmbiguousComputeFieldsSetting =
  process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_AMBIGUOUS_COMPUTE_FIELDS ?? "0";
const expectAmbiguousComputeFields = expectAmbiguousComputeFieldsSetting === "1";
const expectTerminalTelemetrySetting = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_TERMINAL_TELEMETRY;
const expectTerminalTelemetry = expectTerminalTelemetrySetting === "1";
const expectFdmCellPhysicsSetting = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_FDM_CELL_PHYSICS;
const expectFdmCellPhysics = expectFdmCellPhysicsSetting === "1";
const expectRunPerformanceSetting = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_RUN_PERFORMANCE;
const expectRunPerformance = expectRunPerformanceSetting === "1";
const expectPlanarAirboxSetting = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_PLANAR_AIRBOX ?? "0";
const expectPlanarAirbox = expectPlanarAirboxSetting === "1";
const maxCanvasScreenshotBytes = 512 * 1024;
const canvasOnlySkippedAreas = [
  "viewport appearance and color-profile checks",
  "camera interaction checks",
  "viewport export checks at DPR 1 and DPR 2",
  "layout and DPR 1/2 checks",
  "20-cycle viewport lifecycle checks",
  "viewport QA fixture preparation",
  "scene/model adoption readiness endpoint",
  "viewport performance instrumentation",
];
const performanceOnlyViewportDomSkippedArea =
  "viewport DOM/model-adoption observations (performance-only scope)";
const performanceOnlyViewportDomOmissionReason =
  "The performance-only scope proves the viewport canvas and footer performance panel; it does not inspect model-adoption or quantity-label DOM.";
const runPerformanceQaScope = "canvas-engine-run-performance";
const viewportDomObservationNote = "Viewport dataset and quantity label attributes are DOM observations only; they do not prove field payload presence or values.";
const liveFieldObservationNote = "Quantity label data-ready and viewport datasets are DOM readiness observations only; they do not prove field payload presence or values.";
const simulationCommandsPath = "/v2/sessions/current/simulation/commands";

const pageErrors = [];
const consoleErrors = [];
const expectedConsoleErrors = [];
const intentionalResponseDropUrls = new Set();
const requestFailures = [];
const requestCancellations = [];
const expectedResponseDrops = [];
const intentionalResponseDropRequests = new WeakSet();
const resourceResponses = [];
const femAirboxVectorResponses = [];
const planarAirboxMetaResponses = [];
const fieldTransportLifecycle = [];
const fieldTransportLifecycleByRequest = new WeakMap();
const fieldTransportLifecycleStartedAt = new WeakMap();
const blockedMutations = [];
let visualizationClientAckRequestCount = 0;
let displayPatchRequestCount = 0;
const httpErrors = [];
let harnessSourceHashes = null;
let failurePageState = null;
let browserRoute = null;
let partialProof = {};
let cleanupStarted = false;
const bounded = (value) => String(value).slice(0, 2048);
const collect = (target, value) => {
  if (target.length < 32) target.push(bounded(value));
};

const fieldTransportPathPattern = /^\/v2\/sessions\/current\/data\/fields\/[^/]+\/samples\/vector$/;
const recordFieldTransportRequest = (request) => {
  let url;
  try {
    url = new URL(request.url());
  } catch {
    return null;
  }
  if (!fieldTransportPathPattern.test(url.pathname)) return null;
  const existing = fieldTransportLifecycleByRequest.get(request);
  if (existing) return existing;
  if (fieldTransportLifecycle.length >= 16) return null;
  const relativePath = `${url.pathname}${url.search}`;
  const record = {
    method: request.method(),
    path: relativePath.slice(0, 2048),
    ...(relativePath.length > 2048 ? { path_truncated: true } : {}),
    cleanupStarted,
    events: [],
  };
  fieldTransportLifecycleByRequest.set(request, record);
  fieldTransportLifecycleStartedAt.set(request, Date.now());
  fieldTransportLifecycle.push(record);
  return record;
};
const recordFieldTransportEvent = (request, event, details = {}) => {
  const record = fieldTransportLifecycleByRequest.get(request);
  if (!record || record.events.length >= 3) return;
  const startedAt = fieldTransportLifecycleStartedAt.get(request) ?? Date.now();
  record.events.push({
    event,
    ...details,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    cleanupStarted,
  });
};
const installFieldTransportLifecycleObserver = (page) => {
  page.on("request", (request) => recordFieldTransportRequest(request));
  page.on("response", (response) => recordFieldTransportEvent(
    response.request(), "response", { status: response.status() },
  ));
  page.on("requestfinished", (request) =>
    recordFieldTransportEvent(request, "requestfinished"));
  page.on("requestfailed", (request) => recordFieldTransportEvent(
    request,
    "requestfailed",
    { error: bounded(request.failure()?.errorText ?? "failed") },
  ));
};

const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const readHarnessSourceHashes = async () => {
  const hashes = {
    runner: await sha256File(runnerSourcePath),
    appearance_helper: await sha256File(appearanceQaSourcePath),
    loopback_proxy: await sha256File(proxySourcePath),
    export_helper: await sha256File(exportSourcePath),
    lifecycle_helper: await sha256File(lifecycleSourcePath),
    performance_helper: await sha256File(performanceSourcePath),
    layout_helper: await sha256File(layoutSourcePath),
    fixture_helper: await sha256File(fixtureSourcePath),
    fixture_builders: await sha256File(scratchSourcePath),
    fixture_data: await sha256File(fixtureDataPath),
    camera_helper: await sha256File(cameraSourcePath),
  };
  if (expectTerminalTelemetry) {
    hashes.terminal_telemetry_helper = await sha256File(terminalTelemetrySourcePath);
  }
  if (expectPlanarAirbox) {
    hashes.planar_field_evidence = await sha256File(planarFieldEvidenceSourcePath);
  }
  return hashes;
};
const sameHarnessSourceHashes = (left, right) =>
  Object.keys(left).every((key) => left[key] === right[key]);

// Check the rendered decimal itself, including the precision used by the panel.
function assertVisibleCellNumber({ raw, text }) {
  const literal = text.trim();
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(literal)) throw new Error("Cell Inspector displayed a malformed number");
  const visible = Number(literal.replaceAll(",", ""));
  if (!Number.isFinite(raw) || !Number.isFinite(visible)) throw new Error("Cell Inspector displayed a non-finite number");
  if (visible === raw) return;
  const absolute = Math.abs(raw);
  const digits = absolute < 1e-3 || absolute >= 1e6 ? 4 : 6;
  const tolerance = absolute === 0 ? 0 : 0.5 * 10 ** (Math.floor(Math.log10(absolute)) - digits + 1) + absolute * Number.EPSILON * 4;
  if (Math.abs(visible - raw) > tolerance) throw new Error("Cell Inspector visible text differs from its numeric value");
}

// Terminal FDM inspection is read-only: real pointer picking, public probes and visible values.
async function proveFdmCellPhysics(page) {
  const originalViewport = page.viewportSize();
  const inspector = page.getByTestId("panel-right");
  const originalWidth = (await inspector.boundingBox())?.width;
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  let resizeInspector = null;
  const toggleTheme = async () => {
    const previous = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press("Control+Shift+T");
    await page.waitForFunction((theme) => document.documentElement.dataset.theme !== theme, previous, { timeout: 5000 });
  };
  const samples = [];
  const pending = new Set();
  const onResponse = (response) => {
    if (!/\/data\/fields\/[^/]+\/planar-default\/probe\?/.test(response.url())) return;
    const task = response.json().then((body) => {
      if (response.ok() && samples.length < 64) samples.push(body);
    }).catch(() => {}).finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on("response", onResponse);
  try {
    await page.setViewportSize({ width: 1600, height: 1280 });
    const canvas = page.locator(".fm-viewport-3d canvas");
    const tabs = page.getByRole("tablist", { name: "FDM Cell details", exact: true });
    const box = await canvas.boundingBox();
    if (!box) throw new Error("FDM cell picking requires a visible canvas");
    // Pick actual rendered cells, never inject selection or write model state.
    for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.5], [0.55, 0.5], [0.5, 0.45], [0.5, 0.55]]) {
      await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
      if (await tabs.waitFor({ state: "visible", timeout: 1000 }).then(() => true).catch(() => false)) break;
    }
    await tabs.getByRole("tab", { name: "Physics", exact: true }).waitFor({ timeout: 15_000 });
    const panel = page.locator("[data-fdm-cell-physics-status]");
    await page.waitForFunction(() => document.querySelector("[data-fdm-cell-physics-status]")?.getAttribute("data-fdm-cell-physics-status") === "ready", null, { timeout: 30_000 });
    await Promise.all([...pending]);
    const observation = await panel.evaluate((node) => ({
      ordinal: Number(node.getAttribute("data-fdm-cell-ordinal")),
      rows: [...node.querySelectorAll("[data-fdm-quantity-id]")].map((row) => ({
        id: row.getAttribute("data-fdm-quantity-id"), status: row.getAttribute("data-fdm-sample-status"),
        values: [...row.querySelectorAll("data[data-fdm-value]")].map((value) => ({
          kind: value.getAttribute("data-fdm-value"), raw: Number(value.getAttribute("value")), text: value.textContent?.trim() ?? "",
        })),
      })),
    }));
    if (!Number.isSafeInteger(observation.ordinal) || observation.ordinal < 0) throw new Error("Inspector omitted selected cell ordinal");
    for (const row of observation.rows) {
      for (const value of row.values) assertVisibleCellNumber(value);
    }
    for (const id of ["m", "mat_ms", "mat_aex", "mat_alpha", "eden_total"]) {
      const row = observation.rows.find((r) => r.id === id);
      const sample = samples.findLast((r) => r.quantity_id === id && r.cell_id === observation.ordinal);
      if (!row || row.status !== "ready" || !sample) throw new Error(`FDM cell inspection missing ready ${id} and exact public probe`);
      if (id === "m") {
        for (const [i, label] of ["mx", "my", "mz"].entries()) {
          const value = row.values.find((v) => v.kind === label);
          const visible = value?.text ? value.raw : NaN;
          if (!Number.isFinite(visible) || Math.abs(visible - sample.vector[i]) > 5e-6) throw new Error(`Visible ${label} disagrees with selected-cell probe`);
        }
      } else {
        const numeric = row.values.filter((v) => v.kind === "scalar" && v.text.length > 0).map((v) => v.raw).filter(Number.isFinite);
        if (!numeric.some((v) => Math.abs(v - sample.scalar) <= Math.max(Math.abs(sample.scalar) * 5e-6, 1e-30))) throw new Error(`Visible ${id} disagrees with exact public probe`);
      }
    }
    const domainResponse = await page.request.get(new URL("/v2/sessions/current/data/domain/meta", page.url()).toString());
    if (!domainResponse.ok()) throw new Error("Cell energy check requires current domain metadata");
    const domain = await domainResponse.json();
    const volume = domain.grid?.spacing?.reduce((a, b) => a * b, 1);
    const total = observation.rows.find((r) => r.id === "eden_total");
    const density = samples.findLast((r) => r.quantity_id === "eden_total" && r.cell_id === observation.ordinal)?.scalar;
    const cellEnergy = total.values.find((v) => v.kind === "cell-energy" && v.text.length > 0)?.raw;
    if (!(volume > 0) || !Number.isFinite(cellEnergy) || Math.abs(cellEnergy - density * volume) > Math.max(Math.abs(density * volume) * 1e-5, 1e-40)) throw new Error("Visible cell energy does not equal signed density times cell volume");
    await tabs.getByRole("tab", { name: "Grid", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Current Cell", { exact: true }).waitFor({ timeout: 5000 });
    await tabs.getByRole("tab", { name: "Physics", exact: true }).focus();
    await page.keyboard.press("Enter");
    await panel.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("[data-fdm-cell-physics-status]")?.getAttribute("data-fdm-cell-physics-status") === "ready", null, { timeout: 30_000 });
    if (Number(await panel.getAttribute("data-fdm-cell-ordinal")) !== observation.ordinal) throw new Error("Cell selection changed across inspector tabs");
    const handle = page.getByRole("separator", { name: /Resize .* and Inspector panels/i });
    resizeInspector = async (width) => {
      const bounds = await inspector.boundingBox();
      const grip = await handle.boundingBox();
      if (!bounds || !grip) throw new Error("Inspector resize requires a visible dock handle");
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 + bounds.width - width, grip.y + grip.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const measured = (await inspector.boundingBox())?.width;
      if (!Number.isFinite(measured) || Math.abs(measured - width) > 3) throw new Error(`Inspector resize requested ${width}px, measured ${measured}px`);
    };
    const checkLayout = async () => panel.evaluate((node) => {
      const values = [...node.querySelectorAll("data[data-fdm-value]")];
      const clipped = values.filter((value) => value.getBoundingClientRect().width > value.parentElement.clientWidth + 1).map((value) => value.textContent);
      const total = node.querySelector('[data-fdm-energy-term="total"]')?.getBoundingClientRect();
      const inspectorWidth = document.querySelector('[data-testid="panel-right"]')?.getBoundingClientRect().width;
      const details = node.querySelector('[data-slot="inspector-group"]:last-child')?.getBoundingClientRect();
      const summary = node.querySelector('.fm-fdm-cell-physics__summary')?.getBoundingClientRect();
      const tabs = document.querySelector('[role="tablist"][aria-label="FDM Cell details"]')?.getBoundingClientRect();
      const footer = document.querySelector('[data-testid="panel-right"] .fm-inspector__action-bar')?.getBoundingClientRect();
      return { inspector_width: inspectorWidth, summary_top: summary?.top, tabs_bottom: tabs?.bottom, details_bottom: details?.bottom, width: node.clientWidth, scroll_width: node.scrollWidth, clipped_values: clipped, total_bottom: total?.bottom, footer_top: footer?.top };
    });
    let screenshot, topScreenshot, alternateScreenshot, narrowScreenshot, workspaceScreenshot;
    let layout, narrowLayout;
    {
      await resizeInspector(380);
      await panel.locator(".fm-fdm-cell-physics__summary").scrollIntoViewIfNeeded();
      if (themeBefore !== "light") await toggleTheme();
      const overview = await checkLayout();
      if (!(overview.details_bottom <= overview.footer_top && overview.total_bottom <= overview.footer_top && overview.summary_top >= overview.tabs_bottom - 1)) throw new Error("Full Inspector overview does not fit its visible body");
      topScreenshot = await inspector.screenshot({ type: "png" });
      workspaceScreenshot = await page.screenshot({ type: "png" });
      await panel.locator('[data-fdm-energy-term="total"]').scrollIntoViewIfNeeded();
      layout = await checkLayout();
      screenshot = await inspector.screenshot({ type: "png" });
      await toggleTheme();
      await panel.locator(".fm-fdm-cell-physics__summary").scrollIntoViewIfNeeded();
      alternateScreenshot = await inspector.screenshot({ type: "png" });
      await resizeInspector(300);
      await panel.locator(".fm-fdm-cell-physics__summary").scrollIntoViewIfNeeded();
      narrowLayout = await checkLayout();
      if (!(narrowLayout.details_bottom <= narrowLayout.footer_top && narrowLayout.total_bottom <= narrowLayout.footer_top && narrowLayout.summary_top >= narrowLayout.tabs_bottom - 1)) throw new Error("Full narrow Inspector does not fit its visible body");
      narrowScreenshot = await inspector.screenshot({ type: "png" });
      for (const current of [layout, narrowLayout]) {
        if (current.scroll_width > current.width + 1 || current.clipped_values.length) throw new Error(`Cell physics clips at inspector width ${current.width}: ${JSON.stringify(current)}`);
        if (current.footer_top && current.total_bottom > current.footer_top) throw new Error("Cell energy total is covered by the Inspector footer");
      }
    }
    if ([screenshot, topScreenshot, alternateScreenshot, narrowScreenshot, workspaceScreenshot].some((png) => png.length > maxCanvasScreenshotBytes)) throw new Error("Cell inspector screenshot exceeds proof budget");
    return { state: "passed", real_pointer_pick: true, keyboard_tabs: true, observation, public_probes: samples, layout, narrow_layout: narrowLayout, themes: ["light", "dark"], inspector_png_base64: screenshot.toString("base64"), inspector_top_png_base64: topScreenshot.toString("base64"), inspector_alternate_theme_png_base64: alternateScreenshot.toString("base64"), inspector_narrow_png_base64: narrowScreenshot.toString("base64"), workspace_png_base64: workspaceScreenshot.toString("base64"), canvas: await assertCanvas(page, "after FDM cell Physics inspection") };
  } finally {
    page.off("response", onResponse);
    try {
      await Promise.all([...pending]);
      if (originalViewport) await page.setViewportSize(originalViewport);
    } finally {
      try {
        if (resizeInspector && originalWidth) await resizeInspector(originalWidth);
      } finally {
        if (await page.evaluate(() => document.documentElement.dataset.theme) !== themeBefore) await toggleTheme();
      }
    }
  }
}

const sessionIdentity = async (page) => {
  const endpoint = new URL("/v2/sessions/current/status", page.url()).toString();
  const response = await page.request.get(endpoint, { timeout });
  if (response.status() !== 200) {
    throw new Error(`GET /v2/sessions/current/status returned ${response.status()}`);
  }
  const body = await response.json();
  const session = body?.session;
  const lifecycle = body?.lifecycle;
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    if (typeof session?.[key] !== "string" || session[key].trim() === "") {
      throw new Error(`Current status response omitted session.${key}`);
    }
  }
  if (lifecycle?.session_resource !== "active") {
    throw new Error("Current status response did not identify an active session resource");
  }
  return {
    session_id: session.session_id,
    session_epoch: session.session_epoch,
    request_scope_epoch: session.request_scope_epoch,
  };
};

const activeFemRunIdentity = async (page) => {
  const endpoint = new URL("/v2/sessions/current/status", page.url()).toString();
  const response = await page.request.get(endpoint, { timeout });
  if (response.status() !== 200) {
    throw new Error(`GET /v2/sessions/current/status returned ${response.status()}`);
  }
  const body = await response.json();
  const session = body?.session;
  const runId = body?.run?.run_id;
  const lifecycle = body?.lifecycle;
  const discretization = body?.capabilities?.active_lane?.resolved?.discretization;
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    if (typeof session?.[key] !== "string" || session[key].trim() === "") {
      throw new Error(`Current status response omitted session.${key}`);
    }
  }
  if (lifecycle?.session_resource !== "active") {
    throw new Error("Current status response did not identify an active session resource");
  }
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("Current status response did not identify a current run");
  }
  if (typeof discretization !== "string" || discretization.trim().toLowerCase() !== "fem") {
    throw new Error("FEM Airbox vector proof requires an explicitly resolved FEM session lane");
  }
  return {
    session_id: session.session_id,
    session_epoch: session.session_epoch,
    request_scope_epoch: session.request_scope_epoch,
    run_id: runId,
    discretization: "fem",
  };
};

const assertStableFemRunIdentity = (before, after, phase) => {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`FEM Airbox proof changed the active session/run identity ${phase}`);
  }
};

const canvasState = async (page) => page.locator(".fm-viewport-3d canvas").first().evaluate((canvas) => {
  const rect = canvas.getBoundingClientRect();
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const debugInfo = context?.getExtension("WEBGL_debug_renderer_info");
  return {
    rect: { width: rect.width, height: rect.height },
    width: canvas.width,
    height: canvas.height,
    context_type: context?.constructor?.name ?? null,
    context_lost: context?.isContextLost?.() ?? null,
    drawing_buffer_width: context?.drawingBufferWidth ?? 0,
    drawing_buffer_height: context?.drawingBufferHeight ?? 0,
    topology_transfers: performance.getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.endsWith("/data/domain/topology"))
      .slice(-24).map((entry) => ({ start_ms: entry.startTime, duration_ms: entry.duration,
        transfer_bytes: entry.transferSize, encoded_bytes: entry.encodedBodySize })),
    depth_bits: context ? context.getParameter(context.DEPTH_BITS) : null,
    preserve_drawing_buffer: context?.getContextAttributes?.().preserveDrawingBuffer ?? null,
    vendor: debugInfo ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
    renderer: debugInfo ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
  };
});

const viewportDomObservation = async (page) => page.locator(".fm-viewport-3d").evaluate((viewport) => {
  const datasetEntries = Object.entries(viewport.dataset);
  const quantityLabels = [...viewport.querySelectorAll("[data-quantity-id]")];
  return {
    dataset: Object.fromEntries(datasetEntries.slice(0, 64).map(([key, value]) => [key, value.slice(0, 1024)])),
    dataset_entry_count: datasetEntries.length,
    dataset_truncated: datasetEntries.length > 64 || datasetEntries.some(([, value]) => value.length > 1024),
    quantity_labels: quantityLabels.slice(0, 32).map((element) => ({
      tag_name: element.tagName.toLowerCase(),
      quantity_id: element.getAttribute("data-quantity-id"),
      field_state: element.getAttribute("data-field-state"),
    })),
    quantity_label_count: quantityLabels.length,
    quantity_labels_truncated: quantityLabels.length > 32,
  };
});

const liveFieldObservation = async (page, quantityId) => page.locator(".fm-viewport-3d").evaluate((viewport, expectedId) => {
  const label = [...viewport.querySelectorAll("[data-quantity-id]")]
    .find((element) => element.getAttribute("data-quantity-id") === expectedId);
  const rect = label?.getBoundingClientRect();
  const style = label ? getComputedStyle(label) : null;
  const bounds = viewport.getAttribute("data-fdm-domain-bounds") ?? "";
  const parseCount = (name) => {
    const value = Number(viewport.getAttribute(name));
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  };
  const modelCount = parseCount("data-fdm-model-count");
  return {
    quantity_id: expectedId,
    label_visible: Boolean(label && style && style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) > 0 && rect && rect.width > 0 && rect.height > 0),
    field_state: label?.getAttribute("data-field-state") ?? null,
    readiness_signal: "visible quantity label data-field-state=data-ready",
    solver_family: bounds.trim() || modelCount > 0 ? "fdm" : "fem",
    dataset: {
      fdm_domain_bounds: bounds.slice(0, 1024),
      fdm_model_count: modelCount,
      fdm_vector_segment_count: parseCount("data-fdm-vector-segment-count"),
      fdm_airbox_model_count: parseCount("data-fdm-airbox-model-count"),
      fdm_airbox_vectors_visible: viewport.getAttribute("data-fdm-airbox-vectors-visible") === "true",
      fdm_airbox_vector_segment_count: parseCount("data-fdm-airbox-vector-segment-count"),
    },
  };
}, quantityId);

const waitForLiveField = async (page, quantityId, requireAirboxVectors) => {
  await page.waitForFunction(({ expectedId, airboxVectors }) => {
    const viewport = document.querySelector(".fm-viewport-3d");
    if (!viewport) return false;
    const label = [...viewport.querySelectorAll("[data-quantity-id]")]
      .find((element) => element.getAttribute("data-quantity-id") === expectedId);
    if (!label || label.getAttribute("data-field-state") !== "data-ready") return false;
    const rect = label.getBoundingClientRect();
    const style = getComputedStyle(label);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0 ||
        rect.width <= 0 || rect.height <= 0) return false;
    const bounds = viewport.getAttribute("data-fdm-domain-bounds") ?? "";
    const modelCount = Number(viewport.getAttribute("data-fdm-model-count"));
    const isFdm = Boolean(bounds.trim()) || (Number.isSafeInteger(modelCount) && modelCount > 0);
    if (isFdm && (!Number.isSafeInteger(modelCount) || modelCount <= 0)) return false;
    // Return a ready non-FDM observation so the caller can report that the
    // requested airbox gate is FDM-only instead of timing out or passing it.
    if (airboxVectors && !isFdm) return true;
    if (airboxVectors) {
      return viewport.getAttribute("data-fdm-airbox-vectors-visible") === "true" &&
        Number(viewport.getAttribute("data-fdm-airbox-vector-segment-count")) > 0;
    }
    return true;
  }, { expectedId: quantityId, airboxVectors: requireAirboxVectors }, { timeout });
  const observed = await liveFieldObservation(page, quantityId);
  if (requireAirboxVectors && observed.solver_family !== "fdm") {
    throw new Error("FDM-only airbox-vector gate unavailable: viewport exposes no FDM domain/model dataset; FEM has no corresponding airbox-vector dataset");
  }
  return observed;
};

const currentSessionRunIdentity = async (page) => {
  const status = await page.request.get(
    new URL("/v2/sessions/current/status", page.url()).toString(), { timeout },
  );
  if (status.status() !== 200) {
    throw new Error(`GET /v2/sessions/current/status returned ${status.status()}`);
  }
  const body = await status.json();
  const identity = {
    session_id: body?.session?.session_id,
    session_epoch: body?.session?.session_epoch,
    request_scope_epoch: body?.session?.request_scope_epoch,
    run_id: body?.run?.run_id,
  };
  if (Object.values(identity).some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("Planar Airbox proof requires a current session, run, and request-scope identity");
  }
  return identity;
};

const canonicalizeJsonValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeJsonValue(value[key])]));
};

const sameCanonicalJsonValue = (left, right) =>
  JSON.stringify(canonicalizeJsonValue(left)) === JSON.stringify(canonicalizeJsonValue(right));

const expectedAirboxDefaultFrame = (layout, planar) => {
  const airbox = layout?.airbox;
  const cells = airbox?.cells;
  const origin = airbox?.origin_m;
  const spacing = airbox?.cell_size_m;
  if (!Array.isArray(cells) || cells.length !== 3 || cells.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      !Array.isArray(origin) || origin.length !== 3 || origin.some((value) => !Number.isFinite(value)) ||
      !Array.isArray(spacing) || spacing.length !== 3 || spacing.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("fdm-multilayer-layout.airbox does not expose a physical target grid");
  }
  const bounds = {
    min: [...origin],
    max: origin.map((value, axis) => value + cells[axis] * spacing[axis]),
  };
  const defaultSlice = planar?.default_slice;
  const plane = defaultSlice?.plane;
  const positionFraction = defaultSlice?.position_fraction;
  const operatorKind = defaultSlice?.operator?.kind;
  if (!(["xy", "xz", "yz"].includes(plane)) || !Number.isFinite(positionFraction) ||
      positionFraction < 0 || positionFraction > 1 || !["plane_sample", "slab_average"].includes(operatorKind)) {
    throw new Error("Current default planar slice presentation is not a supported axis-aligned slice");
  }
  const [normalAxis, uAxis, vAxis] = {
    xy: [2, 0, 1], xz: [1, 0, 2], yz: [0, 1, 2],
  }[plane];
  const lengths = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const frameOrigin = bounds.min.map((value, axis) => (value + bounds.max[axis]) * 0.5);
  const requestedCoordinate = bounds.min[normalAxis] + positionFraction * lengths[normalAxis];
  let resolvedCoordinateM = requestedCoordinate;
  if (operatorKind === "plane_sample") {
    const count = cells[normalAxis];
    const scaled = positionFraction * count;
    const index = Math.min(Math.max(scaled <= 0 ? 0 : Math.ceil(scaled) - 1, 0), count - 1);
    resolvedCoordinateM = origin[normalAxis] + (index + 0.5) * spacing[normalAxis];
  }
  frameOrigin[normalAxis] = resolvedCoordinateM;
  const axes = {
    xy: { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    xz: { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    yz: { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  }[plane];
  return {
    plane,
    positionFraction,
    operatorKind,
    resolvedCoordinateM,
    originM: frameOrigin,
    uAxis: axes.u,
    vAxis: axes.v,
    normal: axes.normal,
    boundsUvM: [-0.5 * lengths[uAxis], 0.5 * lengths[uAxis], -0.5 * lengths[vAxis], 0.5 * lengths[vAxis]],
    bounds,
  };
};

const assertPlanarFrameMatchesAirbox = (meta, expected) => {
  if (meta?.source?.kind !== "default" || meta?.scope_kind !== "airbox" ||
      meta?.operator?.kind !== expected.operatorKind) {
    throw new Error("Planar metadata does not describe the default Airbox field slice");
  }
  const close = (left, right) => Number.isFinite(left) && Number.isFinite(right) &&
    Math.abs(left - right) <= Math.max(Math.abs(right) * 1e-10, 1e-18);
  const frame = meta.frame;
  for (const [key, expectedValues] of [
    ["origin_m", expected.originM], ["bounds_uv_m", expected.boundsUvM],
    ["u_axis", expected.uAxis], ["v_axis", expected.vAxis], ["normal", expected.normal],
  ]) {
    const actual = frame?.[key];
    if (!Array.isArray(actual) || actual.length !== expectedValues.length ||
        actual.some((value, index) => !close(value, expectedValues[index]))) {
      throw new Error(`Planar metadata ${key} differs from fdm-multilayer-layout.airbox: ${JSON.stringify({ actual, expected: expectedValues })}`);
    }
  }
  return frame;
};

const readPlanarAirboxJson = async (page, path, label) => {
  const response = await page.request.get(new URL(path, page.url()).toString(), { timeout });
  if (response.status() !== 200) throw new Error(`${label} returned ${response.status()}`);
  return response.json();
};

const waitForPlanarAirboxMeta = async (firstIndex) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const isCurrentAirboxMeta = (entry) =>
      entry.method === "GET" && entry.path === "/v2/sessions/current/data/fields/H_demag/planar-default/meta" &&
      entry.scope_kind === "airbox" && entry.scope_id_present === false && entry.status === 200 && entry.payload;
    const match = [...planarAirboxMetaResponses.slice(firstIndex)].reverse().find(isCurrentAirboxMeta) ??
      [...planarAirboxMetaResponses].reverse().find(isCurrentAirboxMeta);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The browser did not load planar-default metadata for scope_kind=airbox without scope_id");
};

const capturePlanarFieldMapScreenshot = async (page) => {
  const png = await page.locator(".fm-field-map__canvas-stack:visible").first().screenshot({ type: "png", timeout });
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Planar Airbox screenshot was not a PNG");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png.length > maxCanvasScreenshotBytes || width <= 0 || height <= 0) {
    throw new Error(`Planar Airbox screenshot exceeds its bounded PNG limits: ${png.length} bytes`);
  }
  return {
    state: "captured", image_proof: true, media_type: "image/png", width, height,
    byte_length: png.length, png_base64: png.toString("base64"),
  };
};

const planarFilenameToken = (value) => String(value)
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "") || "value";

const readPlanarExportDownload = async (download, { expectedFrame, fieldRevision, visibleLayers }) => {
  const filename = download.suggestedFilename();
  if (!filename || !filename.toLowerCase().endsWith(".png")) {
    throw new Error(`Export 2D PNG returned an unexpected filename: ${filename || "empty"}`);
  }
  const normalizedFilename = filename.toLowerCase();
  const filenameChecks = {
    png_extension: true,
    quantity_id: normalizedFilename.includes("h-demag"),
    field_revision: normalizedFilename.includes(`_r${String(fieldRevision).toLowerCase()}_`),
    default_plane: normalizedFilename.includes(`default-${planarFilenameToken(expectedFrame.plane)}-`),
    visible_layer_count: visibleLayers.length === 0 ||
      normalizedFilename.includes(`-layers-${visibleLayers.length}-`),
    visible_layer_ids: visibleLayers.every((layer) =>
      normalizedFilename.includes(`${planarFilenameToken(layer.id)}-${planarFilenameToken(layer.quantity_id)}`)),
  };
  const failedFilenameChecks = Object.entries(filenameChecks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedFilenameChecks.length) {
    throw new Error(`Exported PNG filename did not preserve current field/layer identity: ${failedFilenameChecks.join(", ")}`);
  }

  const stream = await download.createReadStream();
  if (!stream) throw new Error("Export 2D PNG download did not expose a readable stream");
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > maxCanvasScreenshotBytes) {
      stream.destroy?.();
      throw new Error(`Exported PNG exceeds the bounded ${maxCanvasScreenshotBytes}-byte image proof limit`);
    }
    chunks.push(bytes);
  }
  const png = Buffer.concat(chunks, byteLength);
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Export 2D PNG download did not contain a non-empty PNG payload");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png.length === 0 || width <= 0 || height <= 0) {
    throw new Error("Export 2D PNG download has an empty image size");
  }
  const decoded = PNG.sync.read(png);
  if (decoded.width !== width || decoded.height !== height) {
    throw new Error("Export 2D PNG dimensions disagree with its decoded image");
  }
  return {
    state: "captured",
    command_id: "field-map.export-png",
    command_title: "Export 2D PNG",
    filename,
    filename_checks: filenameChecks,
    media_type: "image/png",
    width,
    height,
    byte_length: png.length,
    png_base64: png.toString("base64"),
    visible_layers: visibleLayers,
    png_validation: "signature, non-zero dimensions, and pinned PNG decoder passed",
  };
};

const exportVisiblePlanarComposition = async (page, expected) => {
  const commandSearchButton = page.getByRole("button", { name: /Command search/i });
  if (await commandSearchButton.count() !== 1) {
    throw new Error("Workspace did not expose one accessible Command search button");
  }
  await commandSearchButton.click();
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  try {
    await palette.waitFor({ state: "visible", timeout });
    const search = palette.getByPlaceholder("Search commands");
    await search.fill("Export 2D PNG");
    const command = palette.getByRole("option").filter({ hasText: "Export 2D PNG" });
    await command.waitFor({ state: "visible", timeout });
    if (await command.count() !== 1) {
      throw new Error("Command palette did not resolve one Export 2D PNG command");
    }
    const commandValue = await command.getAttribute("data-value");
    const commandText = await command.innerText();
    if (!commandValue?.includes("field-map.export-png") && !commandText.includes("field-map.export-png")) {
      throw new Error("Export 2D PNG palette entry did not expose command id field-map.export-png");
    }
    if ((await command.getAttribute("aria-disabled")) === "true") {
      throw new Error("Export 2D PNG is disabled in the current command palette");
    }
    const downloadPromise = page.waitForEvent("download", { timeout });
    try {
      await command.click();
      const download = await downloadPromise;
      return await readPlanarExportDownload(download, expected);
    } catch (error) {
      await downloadPromise.catch(() => {});
      throw error;
    }
  } finally {
    if (await palette.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
};

/** Run one UI action and wait for the display-state PATCH it causes. */
const withDisplayStatePatch = async (page, action, description) => {
  const acknowledgement = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PATCH" && url.pathname === "/v2/sessions/current/visualization/state";
  }, { timeout });
  await action();
  const response = await acknowledgement;
  if (response.status() < 200 || response.status() >= 300) {
    throw new Error(`${description} display-state acknowledgement returned ${response.status()}`);
  }
};

/** Pixel proof of one field layer's raster canvas in the visible composition slot. */
const assertPlanarLayerRasterCanvas = async (page, layerId) => {
  const handle = await page.waitForFunction((id) => {
    const slot = document.querySelector('[data-planar-composition-slot][aria-hidden="false"]');
    const node = slot && [...slot.querySelectorAll("canvas[data-planar-overlay-id]")]
      .find((candidate) => candidate.getAttribute("data-planar-overlay-id") === id &&
        candidate.getAttribute("data-planar-overlay-layer") === "raster");
    if (!(node instanceof HTMLCanvasElement) || node.width <= 0 || node.height <= 0) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) return null;
    const context = node.getContext("2d");
    if (!context) return null;
    const pixels = context.getImageData(0, 0, node.width, node.height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) return { visible: true, width: node.width, height: node.height, non_transparent: true };
    }
    return null;
  }, layerId, { timeout });
  return handle.jsonValue();
};

/**
 * Airbox H_demag through the 2D field layers (ADR 0080). Quantity and scope
 * left the canvas toolbar ("2D view tools"); the Airbox field is a layer in
 * the inspector's layer list whose quantity and component are set in the
 * selected-layer editor. The base sample only names the frame, so the proof
 * binds the Airbox layer's own metadata, overlay canvases and export, and
 * restores the original layer list exactly.
 */
const runPlanarAirboxBrowserQa = async (page, expectedSession) => {
  const sessionBefore = await currentSessionRunIdentity(page);
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    if (sessionBefore[key] !== expectedSession[key]) throw new Error(`Planar Airbox initial ${key} differs from the active browser session`);
  }
  const originalState = await readPlanarAirboxJson(
    page, "/v2/sessions/current/visualization/state", "Visualization state",
  );
  const planar = originalState?.planar;
  if (planar?.source?.kind !== "default") {
    throw new Error("Planar Airbox QA requires the loaded session's existing default field source");
  }
  if (planar.layer_model !== "layers") {
    throw new Error("Planar Airbox QA requires the field-layer model (layer_model = layers)");
  }
  if (planar.layers?.raster !== true) {
    throw new Error("Planar Airbox QA requires the toolbar raster mask to be on");
  }
  const originalLayers = Array.isArray(planar.field_overlays) ? planar.field_overlays : [];
  const originalAirboxLayer = originalLayers.find((layer) => layer.id === "airbox") ?? null;
  const layout = await readPlanarAirboxJson(
    page, "/v2/sessions/current/data/domain/fdm-multilayer-layout", "FDM multilayer layout",
  );
  const airbox = layout?.airbox;
  if (layout?.schema_version !== "fdm-multilayer-layout.v1" || layout.available !== true ||
      layout.backend !== "fdm_multilayer" || airbox?.carrier_available !== true ||
      airbox?.h_demag_available !== true || airbox?.target_only !== true) {
    throw new Error("Current session has no authoritative materialized FDM multilayer Airbox H_demag carrier");
  }
  const expectedFrame = expectedAirboxDefaultFrame(layout, planar);
  const open2d = page.getByRole("tab", { name: "2D View", exact: true });
  const originalViewWas2d = (await open2d.getAttribute("aria-selected")) === "true";
  if (!originalViewWas2d) await open2d.click();
  const toolbar = page.getByRole("toolbar", { name: "2D view tools", exact: true });
  await toolbar.waitFor({ state: "visible", timeout });
  for (const name of ["Quantity", "Scope"]) {
    if (await toolbar.getByRole("combobox", { name, exact: true }).count() !== 0) {
      throw new Error(`2D view tools still expose a ${name} selector; it belongs to the inspector's field layers`);
    }
  }
  const layerList = page.locator('[data-slot="planar-field-layer-list"]');
  await layerList.waitFor({ state: "visible", timeout });
  const airboxRow = layerList.locator('li[data-layer-id="airbox"]');
  const metadataStart = planarAirboxMetaResponses.length;
  const patchStart = displayPatchRequestCount;
  const catalog = await readPlanarAirboxJson(
    page, "/v2/sessions/current/data/fields", "Field catalog",
  );
  const demagEntries = Array.isArray(catalog?.quantities)
    ? catalog.quantities.filter((entry) => entry.quantity_id === "H_demag") : [];
  if (demagEntries.length !== 1 || demagEntries[0].available !== true) {
    throw new Error("The live field catalog did not expose one available H_demag quantity");
  }
  let presentationRestored = false;
  let originalViewRestored = originalViewWas2d;
  let observation = null;
  const selectAirboxLayer = async () => {
    await airboxRow.waitFor({ state: "visible", timeout });
    await airboxRow.getByRole("button", { name: /^Edit / }).click();
    const quantity = page.getByRole("combobox", { name: "Quantity", exact: true });
    const component = page.getByRole("combobox", { name: "Component", exact: true });
    await quantity.waitFor({ state: "visible", timeout });
    if (await quantity.count() !== 1 || await component.count() !== 1) {
      throw new Error("The selected-layer editor did not expose one Quantity and one Component selector");
    }
    return { quantity, component };
  };
  const setSelect = async (select, value, description) => {
    if ((await select.inputValue()) === value) return;
    await withDisplayStatePatch(page, () => select.selectOption(value), description);
  };
  const setPressed = async (button, pressed, description) => {
    if (((await button.getAttribute("aria-pressed")) === "true") === pressed) return;
    await withDisplayStatePatch(page, () => button.click(), description);
  };
  try {
    if (!originalAirboxLayer) {
      await layerList.getByRole("button", { name: "Add field", exact: true }).click();
      const item = layerList.getByRole("menu", { name: "Add field for" })
        .getByRole("menuitem").filter({ hasText: /airbox/i });
      if (await item.count() !== 1) throw new Error("The Add field menu did not offer one Airbox target");
      await withDisplayStatePatch(page, () => item.click(), "Add Airbox field layer");
    }
    const editor = await selectAirboxLayer();
    await setSelect(editor.quantity, "H_demag", "Airbox layer H_demag quantity");
    await setSelect(editor.component, "magnitude", "Airbox layer magnitude component");
    await setPressed(airboxRow.getByRole("button", { name: /^(Show|Hide) / }), true, "Show Airbox layer");
    await setPressed(airboxRow.getByRole("button", { name: /^Raster for / }), true, "Airbox layer raster");
    const metaRequest = await waitForPlanarAirboxMeta(metadataStart);
    const meta = metaRequest.payload;
    const evidenceHandle = await page.waitForFunction(() => {
      const raw = document.querySelector("[aria-label='Planar field evidence']")?.getAttribute("data-planar-evidence");
      if (!raw) return null;
      try {
        const evidence = JSON.parse(raw);
        return evidence.status === "ready" && evidence.sourceKind === "default" && evidence.sourceId === "default" &&
          Number.isFinite(evidence.resolvedCoordinateM) ? evidence : null;
      } catch {
        return null;
      }
    }, null, { timeout });
    // The base evidence names the shared frame; every layer samples its exact plane.
    const evidence = await evidenceHandle.jsonValue();
    if (evidence.domainGenerationId !== layout.domain_generation_id) {
      throw new Error("Planar base evidence is not bound to the current domain layout");
    }
    const normalAxis = expectedFrame.normal.findIndex((value) => value !== 0);
    const layerFrame = {
      ...expectedFrame,
      originM: expectedFrame.originM.map((value, axis) => axis === normalAxis ? evidence.resolvedCoordinateM : value),
    };
    const matchedFrame = assertPlanarFrameMatchesAirbox(meta, layerFrame);
    if (meta.quantity_id !== "H_demag" || meta.component !== "magnitude" || !meta.sample_token) {
      throw new Error("Airbox layer metadata does not describe the H_demag magnitude sample");
    }
    const layerState = await readPlanarAirboxJson(
      page, "/v2/sessions/current/visualization/state", "Airbox layer state",
    );
    const requestedLayers = (layerState?.planar?.field_overlays ?? [])
      .filter((layer) => layer.visible !== false && (layer.raster_visible || layer.vectors_visible))
      .map((layer) => ({
        id: layer.id,
        quantity_id: layer.quantity_id,
        raster_visible: layer.raster_visible,
        vectors_visible: layer.vectors_visible,
      }));
    if (!requestedLayers.some((layer) => layer.id === "airbox" && layer.quantity_id === "H_demag")) {
      throw new Error("Visualization state has no visible Airbox H_demag field layer");
    }
    let composition = null;
    {
      const handle = await page.waitForFunction((expected) => {
        const buffers = document.querySelector("[data-planar-composition-state]");
        if (!buffers || !["verified", "unverified"].includes(buffers.getAttribute("data-planar-composition-state"))) return null;
        const slot = buffers.querySelector('[data-planar-composition-slot][aria-hidden="false"]');
        if (!slot) return null;
        const layers = expected.map((profile) => {
          const surfaces = ["raster", "vectors"].map((kind) => {
            const node = [...slot.querySelectorAll("canvas[data-planar-overlay-id]")]
              .find((candidate) => candidate.getAttribute("data-planar-overlay-id") === profile.id &&
                candidate.getAttribute("data-planar-overlay-layer") === kind);
            if (!(node instanceof HTMLCanvasElement) || node.width <= 0 || node.height <= 0 ||
                node.getAttribute("data-planar-overlay-quantity") !== profile.quantity_id ||
                node.getAttribute("data-planar-overlay-rendered-current") !== "true") return null;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            if (rect.width <= 0 || rect.height <= 0 || style.display === "none" ||
                style.visibility === "hidden" || Number(style.opacity) <= 0) return null;
            const sample = node.getAttribute("data-planar-overlay-sample");
            if (!sample || node.getAttribute("data-planar-overlay-rendered-sample") !== sample) return null;
            const evidence = JSON.parse(node.getAttribute("data-planar-overlay-rendered-evidence") ?? "null");
            if (!evidence || evidence.sampleIdentity !== sample) return null;
            return { kind, width: node.width, height: node.height, sample_identity: sample };
          });
          return surfaces.every(Boolean) ? { ...profile, surfaces } : null;
        });
        const actualIds = [...new Set([...slot.querySelectorAll("canvas[data-planar-overlay-id]")]
          .map((node) => node.getAttribute("data-planar-overlay-id")).filter(Boolean))];
        const expectedIds = expected.map((profile) => profile.id);
        if (actualIds.length !== expectedIds.length || expectedIds.some((id) => !actualIds.includes(id))) return null;
        return layers.every(Boolean) ? {
          state: buffers.getAttribute("data-planar-composition-state"),
          visible_slot: slot.getAttribute("data-planar-composition-slot"),
          layers,
        } : null;
      }, requestedLayers, { timeout });
      composition = await handle.jsonValue();
    }
    const airboxSurface = composition?.layers?.find((layer) => layer.id === "airbox")
      ?.surfaces?.find((surface) => surface.kind === "raster");
    if (!airboxSurface || airboxSurface.sample_identity !== meta.etag) {
      throw new Error("Airbox layer raster is not bound to the Airbox layer metadata identity");
    }
    const canvas = await assertPlanarLayerRasterCanvas(page, "airbox");
    const screenshot = await capturePlanarFieldMapScreenshot(page);
    const exportProof = await exportVisiblePlanarComposition(page, {
      expectedFrame,
      fieldRevision: meta.field_revision,
      visibleLayers: composition?.layers ?? [],
    });
    observation = {
      schema: "fullmag.docker-dev-planar-airbox-browser-proof.v1",
      state: "passed",
      quantity_id: "H_demag",
      source_kind: "default",
      source_id: "default",
      scope_kind: "airbox",
      scope_id: null,
      layer_id: "airbox",
      layer_added: originalAirboxLayer === null,
      session_before: sessionBefore,
      session_after: null,
      meta_request: {
        method: metaRequest.method,
        path: metaRequest.path,
        scope_kind: metaRequest.scope_kind,
        scope_id_present: metaRequest.scope_id_present,
        status: metaRequest.status,
      },
      meta,
      evidence,
      domain_layout: {
        schema_version: layout.schema_version,
        available: layout.available,
        backend: layout.backend,
        domain_generation_id: layout.domain_generation_id,
        layout_fingerprint: layout.layout_fingerprint,
        airbox: {
          carrier_available: airbox.carrier_available,
          h_demag_available: airbox.h_demag_available,
          target_only: airbox.target_only,
          cells: airbox.cells,
          origin_m: airbox.origin_m,
          cell_size_m: airbox.cell_size_m,
        },
      },
      expected_frame: layerFrame,
      matched_frame: matchedFrame,
      canvas,
      composition,
      screenshot,
      export: exportProof,
      display_state_patch_count: displayPatchRequestCount - patchStart,
      visualization_client_ack_request_count: visualizationClientAckRequestCount,
      blocked_mutation_count: blockedMutations.length,
      no_computation_or_monitor_mutations: blockedMutations.length === 0,
      presentation_restored: false,
    };
  } finally {
    if (!originalAirboxLayer) {
      if (await airboxRow.count() === 1) {
        await withDisplayStatePatch(
          page, () => airboxRow.getByRole("button", { name: /^Remove / }).click(), "Airbox layer removal",
        );
      }
    } else if (await airboxRow.count() === 1) {
      const editor = await selectAirboxLayer();
      await setSelect(editor.quantity, originalAirboxLayer.quantity_id, "Original Airbox quantity restoration");
      await setSelect(editor.component, String(originalAirboxLayer.component), "Original Airbox component restoration");
      await setPressed(airboxRow.getByRole("button", { name: /^Raster for / }), Boolean(originalAirboxLayer.raster_visible), "Original Airbox raster restoration");
      await setPressed(airboxRow.getByRole("button", { name: /^(Show|Hide) / }), originalAirboxLayer.visible !== false, "Original Airbox visibility restoration");
    }
    const restoredState = await readPlanarAirboxJson(
      page, "/v2/sessions/current/visualization/state", "Restored visualization state",
    );
    presentationRestored = sameCanonicalJsonValue(planar, restoredState?.planar);
    if (!presentationRestored) throw new Error("Planar Airbox QA could not restore the original field layers");
    if (!originalViewWas2d) {
      await page.getByRole("tab", { name: "3D Viewport", exact: true }).click();
    }
    originalViewRestored =
      (await page.getByRole("tab", { name: originalViewWas2d ? "2D View" : "3D Viewport", exact: true })
        .getAttribute("aria-selected")) === "true";
    presentationRestored = presentationRestored && originalViewRestored;
    const sessionAfter = await currentSessionRunIdentity(page);
    if (JSON.stringify(sessionBefore) !== JSON.stringify(sessionAfter)) {
      throw new Error("Planar Airbox presentation changed session/run identity");
    }
    if (observation) {
      observation.session_after = sessionAfter;
      observation.presentation_restored = presentationRestored;
      observation.display_state_patch_count = displayPatchRequestCount - patchStart;
      observation.blocked_mutation_count = blockedMutations.length;
      observation.no_computation_or_monitor_mutations = blockedMutations.length === 0;
    }
  }
  if (!observation || !presentationRestored || observation.blocked_mutation_count !== 0) {
    throw new Error("Planar Airbox browser proof did not complete its presentation-only round trip");
  }
  return observation;
};

const readFemAirboxDebugDom = () => {
  const panel = document.querySelector(".fm-visualization-debug-panel");
  if (!panel) return false;
  const health = panel.querySelector(".fm-visualization-debug-health");
  const panelDisposition = health?.getAttribute("data-disposition");
  if (!["ready", "unknown"].includes(panelDisposition) ||
      panel.querySelector('.fm-inspector-feedback[role="alert"]')) return false;
  // A sampled query has no exact backend-statistics comparison. Require the
  // canonical render snapshot to be complete instead of treating panel-wide
  // scientific comparison availability as proof of rendering.
  let exported;
  try {
    exported = JSON.parse(panel.querySelector(".fm-visualization-debug-json code")?.textContent ?? "");
  } catch {
    return false;
  }
  if (exported.schemaVersion !== "fullmag.visualization-debug.v2" ||
      exported.issues?.length !== 0 || !Array.isArray(exported.model?.viewports) ||
      !Array.isArray(exported.model?.issues) || exported.model.issues.some((issue) =>
        issue.code !== "backend-meta-incomparable" || issue.severity !== "info")) return false;
  const snapshots = exported.model.viewports.flatMap((viewport) => viewport.snapshots ?? [])
    .filter((snapshot) => snapshot.target?.kind === "airbox" && snapshot.target.id === "airbox");
  if (snapshots.length !== 1 || snapshots[0].disposition !== "ready") return false;
  const fieldRows = (container) => [...container.querySelectorAll(".fm-inspector-field-row")]
    .map((row) => ({
      label: row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "",
      value: row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? "",
    }));
  const group = (title) => [...panel.querySelectorAll('[data-slot="inspector-group"]')]
    .find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === title) ?? null;
  const groupRows = (title) => {
    const selected = group(title);
    return selected ? fieldRows(selected) : [];
  };
  const rowValue = (rows, label) => rows.find((row) => row.label === label)?.value ?? null;
  const subsections = (title) => {
    const selected = group(title);
    return selected ? [...selected.querySelectorAll(".fm-visualization-debug-subsection")].map((section) => ({
      carrier_id: section.querySelector("h4")?.textContent?.trim() ?? "",
      rows: fieldRows(section),
    })) : [];
  };
  const targetRows = groupRows("Active target");
  if (rowValue(targetRows, "Selection kind") !== "airbox.visualization.debug" ||
      rowValue(targetRows, "Target kind") !== "airbox" ||
      rowValue(targetRows, "Target ID") !== "airbox") return false;
  const requests = subsections("Request & transport");
  const renders = subsections("Render passes");
  const payloads = subsections("Decoded payload");
  const resources = subsections("Viewport & carriers");
  for (const request of requests) {
    const resourceKey = rowValue(request.rows, "Canonical resource key");
    const component = rowValue(request.rows, "Requested component");
    if (!resourceKey || component !== "full" || !request.carrier_id) continue;
    let url;
    try {
      url = new URL(resourceKey, "http://fullmag.invalid");
    } catch {
      continue;
    }
    const scopeId = url.searchParams.get("scope_id");
    if (url.pathname !== "/v2/sessions/current/data/fields/H_demag/samples/vector" ||
        url.searchParams.get("component") !== "full" ||
        url.searchParams.get("scope_kind") !== "airbox" ||
        !scopeId || scopeId.trim() === "") continue;
    const render = renders.find((candidate) => candidate.carrier_id === request.carrier_id &&
      rowValue(candidate.rows, "Vector source") === resourceKey);
    const payload = payloads.find((candidate) => candidate.carrier_id === request.carrier_id &&
      rowValue(candidate.rows, "Scope") === `airbox:${scopeId}`);
    const resource = resources.find((candidate) => candidate.carrier_id === request.carrier_id);
    if (!render || !payload || !resource) continue;
    const fieldResourceState = rowValue(resource.rows, "Field resource") ?? "";
    if (!fieldResourceState.startsWith("ready · data present · last-valid present")) continue;
    const fieldBuffer = rowValue(render.rows, "Vector field buffer") ?? "";
    const [fieldBufferState, ...fieldBufferIdParts] = fieldBuffer.split(" · ");
    const fieldBufferId = fieldBufferIdParts.join(" · ").trim();
    if (fieldBufferState !== "target-buffer" || !fieldBufferId || fieldBufferId === "not adopted") continue;
    const vectors = rowValue(render.rows, "Vectors") ?? "";
    const vectorMatch = vectors.match(/^(.+?) · ([0-9][0-9,]*) segments · (.*)$/);
    if (!vectorMatch || vectorMatch[1] === "not built") continue;
    const segmentCount = Number(vectorMatch[2].replaceAll(",", ""));
    if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) continue;
    const pointValues = rowValue(payload.rows, "Points / values") ?? "";
    const pointValueMatch = pointValues.match(/^([0-9][0-9,]*) \/ ([0-9][0-9,]*)$/);
    if (!pointValueMatch || Number(pointValueMatch[1].replaceAll(",", "")) <= 0 ||
        Number(pointValueMatch[2].replaceAll(",", "")) <= 0) continue;
    return {
      health_disposition: "ready",
      health_scope: "render-snapshot",
      render_snapshot_frame_commit_id: snapshots[0].viewport?.frameCommitId ?? null,
      panel_health_disposition: panelDisposition,
      panel_comparison_limitations: exported.model.issues.map((issue) => issue.code),
      target_id: "airbox",
      target_kind: "airbox",
      selection_kind: "airbox.visualization.debug",
      carrier_id: request.carrier_id,
      quantity_id: "H_demag",
      component,
      scope_kind: "airbox",
      scope_id: scopeId,
      resource_key: resourceKey,
      field_resource_state: fieldResourceState,
      payload_scope: rowValue(payload.rows, "Scope"),
      payload_points: Number(pointValueMatch[1].replaceAll(",", "")),
      payload_values: Number(pointValueMatch[2].replaceAll(",", "")),
      payload_n_comp: Number((rowValue(payload.rows, "nComp") ?? "").replaceAll(",", "")),
      field_buffer_state: fieldBufferState,
      adopted_field_buffer_id: fieldBufferId,
      adopted_resource_key: rowValue(render.rows, "Vector source"),
      vector_build_key: vectorMatch[1],
      rendered_vector_segment_count: segmentCount,
      vector_degradation: vectorMatch[3],
    };
  }
  return false;
};

const selectFemAirboxVisualization = async (page) => {
  const modelSelector = '[data-node-id="model:airbox"]';
  await page.waitForFunction((selector) => {
    const visibleTrees = [...document.querySelectorAll(".fm-explorer-tree")]
      .filter((tree) => tree.offsetParent !== null);
    for (const tree of visibleTrees) tree.scrollTop = 0;
    return Boolean(document.querySelector(selector));
  }, modelSelector, { timeout });
  const expand = async (nodeId) => {
    const selector = `[data-node-id="${nodeId}"]`;
    const node = page.locator(selector).first();
    await node.waitFor({ state: "visible", timeout });
    if ((await node.getAttribute("aria-expanded")) !== "false") return;
    await node.scrollIntoViewIfNeeded();
    await node.dblclick();
    await page.waitForFunction((id) =>
      document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-expanded") === "true",
    nodeId, { timeout });
  };
  const select = async (nodeId, parentId) => {
    const selector = `[data-node-id="${nodeId}"]`;
    const parentSelector = `[data-node-id="${parentId}"]`;
    await page.locator(parentSelector).scrollIntoViewIfNeeded();
    const node = page.locator(selector).first();
    await node.waitFor({ state: "visible", timeout });
    await node.click();
    await page.waitForFunction((id) =>
      document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true",
    nodeId, { timeout });
  };
  await expand("model:airbox");
  await select("model:airbox:visualization", "model:airbox");
  await expand("model:airbox:visualization");
  return page.locator(".fm-inspector-panel").last();
};

const proveFemAirboxVectors = async (page, initialRunIdentity, primaryBefore) => {
  const airboxPanel = await selectFemAirboxVisualization(page);
  const applyDisplayControl = async (action, label) => {
    const acknowledgement = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "PATCH" &&
        url.pathname === "/v2/sessions/current/visualization/state";
    }, { timeout });
    await action();
    const response = await acknowledgement;
    if (response.status() < 200 || response.status() >= 300) {
      throw new Error(`${label} display-state PATCH returned ${response.status()}`);
    }
  };
  const quantity = airboxPanel.getByRole("combobox", { name: "Quantity source", exact: true });
  if (await quantity.count() !== 1) throw new Error("Airbox inspector did not expose one Quantity source combobox");
  // The picker uses the capability catalog's label. Radix does not expose
  // the React value prop as a data-value attribute on its option elements.
  const catalogResponse = await page.request.get(
    new URL("/v2/sessions/current/data/quantities", page.url()).toString(), { timeout },
  );
  if (catalogResponse.status() !== 200) throw new Error("The live quantity catalog is unavailable");
  const catalog = await catalogResponse.json();
  const demagEntries = Array.isArray(catalog?.quantities)
    ? catalog.quantities.filter((entry) => entry.id === "H_demag") : [];
  if (demagEntries.length !== 1) throw new Error("The live quantity catalog did not identify one H_demag entry");
  const demagLabel = demagEntries[0].label || demagEntries[0].id;
  await quantity.click();
  const option = page.getByRole("option", { name: demagLabel, exact: true });
  await option.waitFor({ state: "visible", timeout });
  if ((await option.getAttribute("aria-disabled")) === "true") {
    throw new Error("Airbox H_demag quantity is not available in the live field catalog");
  }
  if ((await option.getAttribute("aria-selected")) !== "true") {
    await applyDisplayControl(() => option.click(), "Airbox H_demag");
  } else {
    await page.keyboard.press("Escape");
  }

  const vectors = airboxPanel.getByRole("button", { name: "Toggle vector field arrows", exact: true });
  await vectors.waitFor({ state: "visible", timeout });
  if ((await vectors.getAttribute("aria-pressed")) !== "true") {
    await applyDisplayControl(() => vectors.click(), "Airbox vectors");
  }
  await page.waitForFunction(() =>
    document.querySelector('.fm-inspector-panel button[aria-label="Toggle vector field arrows"]')
      ?.getAttribute("aria-pressed") === "true",
  null, { timeout });

  // Fit the selected Airbox through the same display action available to users.
  await page.locator(".fm-inspector__action-bar")
    .getByRole("button", { name: "Fit view", exact: true }).click();

  const debugSelector = '[data-node-id="model:airbox:visualization:debug"]';
  const debugNode = page.locator(debugSelector).first();
  await debugNode.waitFor({ state: "visible", timeout });
  await debugNode.scrollIntoViewIfNeeded();
  await debugNode.click();
  await page.waitForFunction((selector) =>
    document.querySelector(selector)?.getAttribute("aria-selected") === "true",
  debugSelector, { timeout });
  await page.locator(".fm-visualization-debug-panel")
    .getByRole("button", { name: "Raw bounded JSON", exact: true }).click();
  try {
    await page.waitForFunction(readFemAirboxDebugDom, null, { timeout });
  } catch (error) {
    const rawToggle = page.locator(".fm-visualization-debug-panel")
      .getByRole("button", { name: "Raw bounded JSON", exact: true });
    if (await rawToggle.count() === 1 && (await rawToggle.getAttribute("aria-expanded")) !== "true") {
      await rawToggle.click();
    }
    partialProof.fem_airbox_debug_snapshot_json = await page
      .locator(".fm-visualization-debug-json code").innerText({ timeout: 3000 }).catch(() => null);
    partialProof.fem_airbox_debug = await page.locator(".fm-visualization-debug-panel")
      .evaluate((panel) => ({ state: panel.dataset.state, text: panel.innerText.slice(0, 24000) }))
      .catch(() => null);
    partialProof.fem_airbox_vector_responses = femAirboxVectorResponses.slice(-16);
    partialProof.fem_airbox_canvas_screenshot = await captureCanvasScreenshot(page, null);
    throw error;
  }
  const debug = await page.evaluate(readFemAirboxDebugDom);
  if (!debug || typeof debug !== "object") throw new Error("Airbox debug panel did not expose accepted FEM vector observations");

  const matchingResponses = femAirboxVectorResponses.filter((entry) =>
    entry.method === "GET" && entry.status === 200 && entry.same_origin === true &&
    entry.quantity_id === "H_demag" && entry.component === "full" &&
    entry.scope_kind === "airbox" && entry.scope_id === debug.scope_id,
  );
  if (matchingResponses.length === 0) {
    throw new Error("No successful live scoped FEM H_demag Airbox vector response was observed");
  }
  const primaryAfter = await waitForLiveField(page, "m", false);
  if (primaryBefore.quantity_id !== "m" || primaryAfter.quantity_id !== "m" ||
      primaryAfter.solver_family !== "fem") {
    throw new Error("Airbox H_demag selection changed or obscured the primary FEM magnetization quantity");
  }
  const canvas = await assertCanvas(page, "FEM Airbox H_demag vectors");
  if (blockedMutations.length > 0) {
    throw new Error(`FEM Airbox proof blocked unexpected non-display mutation requests: ${JSON.stringify(blockedMutations)}`);
  }
  const runIdentityAfter = await activeFemRunIdentity(page);
  assertStableFemRunIdentity(initialRunIdentity, runIdentityAfter, "during Airbox visualization");
  return {
    schema: "fullmag.fem-airbox-vector-observation.v1",
    health_disposition: debug.health_disposition,
    health_scope: debug.health_scope,
    render_snapshot_frame_commit_id: debug.render_snapshot_frame_commit_id,
    panel_health_disposition: debug.panel_health_disposition,
    panel_comparison_limitations: debug.panel_comparison_limitations,
    solver_family: "fem",
    session_run_identity_before: initialRunIdentity,
    session_run_identity_after: runIdentityAfter,
    primary_quantity_id_before: primaryBefore.quantity_id,
    primary_quantity_id_after: primaryAfter.quantity_id,
    primary_field_state_after: primaryAfter.field_state,
    target_id: debug.target_id,
    target_kind: debug.target_kind,
    selection_kind: debug.selection_kind,
    carrier_id: debug.carrier_id,
    quantity_id: debug.quantity_id,
    component: debug.component,
    scope_kind: debug.scope_kind,
    scope_id: debug.scope_id,
    resource_key: debug.resource_key,
    request: matchingResponses.at(-1),
    field_resource_state: debug.field_resource_state,
    payload_scope: debug.payload_scope,
    payload_points: debug.payload_points,
    payload_values: debug.payload_values,
    payload_n_comp: debug.payload_n_comp,
    field_buffer_state: debug.field_buffer_state,
    adopted_field_buffer_id: debug.adopted_field_buffer_id,
    adopted_resource_key: debug.adopted_resource_key,
    vector_build_key: debug.vector_build_key,
    rendered_vector_segment_count: debug.rendered_vector_segment_count,
    vector_degradation: debug.vector_degradation,
    display_state_patch_count: displayPatchRequestCount,
    visualization_client_ack_request_count: visualizationClientAckRequestCount,
    blocked_mutation_count: blockedMutations.length,
    canvas,
  };
};

const captureCanvasScreenshot = async (page, fallbackCanvas) => {
  try {
    const png = await page.locator(".fm-viewport-3d canvas").first().screenshot({ type: "png", timeout });
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Canvas screenshot was not a PNG");
    }
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (png.length > maxCanvasScreenshotBytes) {
      return {
        state: "omitted-size-limit", image_proof: false, media_type: "image/png",
        width, height, byte_length: png.length,
      };
    }
    return {
      state: "captured", image_proof: true, media_type: "image/png", width, height,
      byte_length: png.length, png_base64: png.toString("base64"),
    };
  } catch (error) {
    return {
      state: "omitted-capture-failed", image_proof: false, media_type: "image/png",
      width: Math.max(1, Math.round(fallbackCanvas?.rect?.width ?? 1)),
      height: Math.max(1, Math.round(fallbackCanvas?.rect?.height ?? 1)),
      byte_length: null, reason: bounded(error?.message ?? error),
    };
  }
};

const assertCanvas = async (page, label) => {
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.first().waitFor({ state: "visible", timeout });
  if (await canvas.count() !== 1) throw new Error(`${label}: expected one viewport canvas`);
  const state = await canvasState(page);
  if (state.rect.width <= 0 || state.rect.height <= 0 || state.width <= 0 || state.height <= 0
      || !state.context_type || state.context_lost !== false
      || state.drawing_buffer_width <= 0 || state.drawing_buffer_height <= 0) {
    throw new Error(`${label}: visible WebGL canvas/context/drawing buffer is invalid`);
  }
  return state;
};

const expectedSessionScopeHeader = (identity) =>
  `session=${encodeURIComponent(identity.session_id)}&epoch=${encodeURIComponent(identity.session_epoch)}&request_scope_epoch=${encodeURIComponent(identity.request_scope_epoch)}`;

const isApiInstanceId = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

const installComputeFieldsFeedbackObserver = async (page) => page.evaluate(() => {
  const capture = { statuses: [], messages: [], observer: null };
  const sample = () => {
    for (const toast of document.querySelectorAll('[data-command-id="study.compute-fields"]')) {
      const status = toast.getAttribute("data-command-status");
      const message = toast.querySelector(".fm-toast__body")?.textContent?.trim() ?? "";
      if (status && capture.statuses.length < 32 && capture.statuses.at(-1) !== status) {
        capture.statuses.push(status);
      }
      if (message && capture.messages.length < 32 && capture.messages.at(-1) !== message) {
        capture.messages.push(message.slice(0, 512));
      }
    }
  };
  capture.observer = new MutationObserver(sample);
  capture.observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-command-status"],
    childList: true,
    subtree: true,
  });
  window.__fullmagComputeFieldsFeedbackCapture = capture;
  sample();
});

const scopedComputeFieldsJournalSnapshot = async (page, sessionScopeHeader, apiInstance, intentId, commandId) => {
  const headers = {
    "x-fullmag-session-scope": sessionScopeHeader,
    "x-fullmag-api-instance": apiInstance,
  };
  const listUrl = new URL(simulationCommandsPath, page.url()).toString();
  const listResponse = await page.request.get(listUrl, { headers, timeout: Math.min(timeout, 5000) });
  if (listResponse.status() !== 200) {
    throw new Error(`Scoped command journal GET returned HTTP ${listResponse.status()}`);
  }
  const listApiInstance = listResponse.headers()["x-fullmag-api-instance"] ?? null;
  if (listApiInstance !== apiInstance) throw new Error("Scoped command journal API instance changed");
  const queue = await listResponse.json();
  if (!Array.isArray(queue?.commands)) throw new Error("Scoped command journal omitted commands[]");
  const intentRecords = queue.commands.filter((entry) => entry?.client_intent_id === intentId);
  if (intentRecords.length === 0) {
    return {
      state: "not-found",
      queue_status: listResponse.status(),
      list_api_instance: listApiInstance,
    };
  }
  if (intentRecords.length !== 1) throw new Error("Scoped command journal contains duplicate client intents");
  const record = intentRecords[0];
  if (record.kind !== "compute_fields" || record.command_id !== commandId) {
    throw new Error("Scoped command journal intent matched a different kind or command id");
  }
  const commandIdRecords = queue.commands.filter((entry) => entry?.command_id === commandId);
  if (commandIdRecords.length !== 1) throw new Error("Scoped command journal command id is not unique");

  const detailUrl = new URL(`${simulationCommandsPath}/${encodeURIComponent(commandId)}`, page.url()).toString();
  const detailResponse = await page.request.get(detailUrl, { headers, timeout: Math.min(timeout, 5000) });
  if (detailResponse.status() !== 200) {
    throw new Error(`Scoped command detail GET returned HTTP ${detailResponse.status()}`);
  }
  const detailApiInstance = detailResponse.headers()["x-fullmag-api-instance"] ?? null;
  if (detailApiInstance !== apiInstance) throw new Error("Scoped command detail API instance changed");
  const detail = await detailResponse.json();
  if (detail?.command_id !== commandId || detail?.client_intent_id !== intentId || detail?.kind !== "compute_fields") {
    throw new Error("Scoped command detail differs from the exact intent, kind, or command id");
  }
  const effectiveStatus = detail.status === "completed"
    ? detail.completion_status ?? "completed"
    : detail.status;
  if (["failed", "rejected", "cancelled"].includes(effectiveStatus)) {
    throw new Error(`Compute Fields command reached terminal status ${effectiveStatus}`);
  }
  return {
    state: effectiveStatus === "completed" ? "completed" : "pending",
    queue_status: listResponse.status(),
    detail_status: detailResponse.status(),
    list_api_instance: listApiInstance,
    detail_api_instance: detailApiInstance,
    matching_intent_count: intentRecords.length,
    client_intent_id: intentId,
    command_id: record.command_id,
    kind: record.kind,
    detail_command_id: detail.command_id,
    detail_client_intent_id: detail.client_intent_id,
    detail_kind: detail.kind,
    effective_status: effectiveStatus,
  };
};

const observeAmbiguousComputeFieldsSubmission = async (page, expectedSession) => {
  const studyTab = page.getByRole("tab", { name: "Study", exact: true });
  await studyTab.click();
  const computeFieldsButton = page.getByRole("button", { name: "Compute Fields", exact: true });
  await computeFieldsButton.waitFor({ state: "visible", timeout });
  if (await computeFieldsButton.isDisabled()) throw new Error("Compute Fields is disabled in the active session");
  await installComputeFieldsFeedbackObserver(page);

  const submission = {
    state: "not-started",
    command_posts: [],
    forwarded_count: 0,
    expected_abort_count: 0,
    error: null,
    client_intent_id: null,
    request_api_instance: null,
    upstream_response: null,
  };
  const routePattern = new RegExp(`${simulationCommandsPath}(?:\\?.*)?$`);
  const routeHandler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "POST" || url.pathname !== simulationCommandsPath) {
      await route.continue();
      return;
    }
    let body = null;
    try {
      body = JSON.parse(request.postData() ?? "null");
    } catch {
      body = null;
    }
    submission.command_posts.push(typeof body?.kind === "string" ? body.kind : "unknown");
    if (body?.kind !== "compute_fields") {
      submission.error = `Unexpected simulation command POST kind: ${String(body?.kind ?? "unknown")}`;
      submission.state = "unexpected-command-post";
      await route.abort("blockedbyclient");
      return;
    }
    if (submission.command_posts.filter((kind) => kind === "compute_fields").length !== 1) {
      submission.error = "A second Compute Fields POST was blocked before forwarding";
      submission.state = "duplicate-compute-fields-post";
      await route.abort("blockedbyclient");
      return;
    }
    const intentId = body?.client_intent_id;
    const requestHeaders = request.headers();
    const expectedScope = expectedSessionScopeHeader(expectedSession);
    if (typeof intentId !== "string" || !intentId.trim() || intentId.length > 512) {
      submission.error = "Compute Fields request omitted a stable client_intent_id";
      submission.state = "missing-client-intent";
      await route.abort("blockedbyclient");
      return;
    }
    if (requestHeaders["x-fullmag-session-scope"] !== expectedScope) {
      submission.error = "Compute Fields POST did not carry the exact current session scope";
      submission.state = "session-scope-mismatch";
      await route.abort("blockedbyclient");
      return;
    }
    submission.client_intent_id = intentId;
    submission.session_scope_header_matches = true;
    submission.request_api_instance = requestHeaders["x-fullmag-api-instance"] ?? null;
    submission.state = "forwarding-once";
    submission.forwarded_count += 1;
    try {
      const upstreamResponse = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout });
      const upstreamBody = await upstreamResponse.json().catch(() => null);
      const responseApiInstance = upstreamResponse.headers()["x-fullmag-api-instance"] ?? null;
      submission.upstream_response = {
        status: upstreamResponse.status(),
        accepted: upstreamBody?.accepted === true,
        command_id: typeof upstreamBody?.command_id === "string" ? upstreamBody.command_id : null,
        api_instance: responseApiInstance,
        request_api_instance: submission.request_api_instance,
      };
      if (
        !upstreamResponse.ok() ||
        upstreamBody?.accepted !== true ||
        typeof upstreamBody?.command_id !== "string" ||
        !upstreamBody.command_id ||
        !isApiInstanceId(responseApiInstance) ||
        (submission.request_api_instance && submission.request_api_instance !== responseApiInstance)
      ) {
        submission.error = "Real Compute Fields POST did not return one accepted, API-instance-pinned response";
        submission.state = "upstream-not-accepted";
        await route.fulfill({ response: upstreamResponse });
        return;
      }
      submission.state = "accepted-response-dropped";
      intentionalResponseDropUrls.add(request.url());
      intentionalResponseDropRequests.add(request);
      await route.abort("connectionreset");
      submission.expected_abort_count += 1;
    } catch (error) {
      submission.error = bounded(error?.message ?? error);
      submission.state = "forward-or-abort-failed";
      await route.abort("failed").catch(() => {});
    }
  };

  await page.route(routePattern, routeHandler);
  try {
    await computeFieldsButton.click();
    await page.waitForFunction(() => {
      const capture = window.__fullmagComputeFieldsFeedbackCapture;
      return capture?.statuses.includes("pending") || capture?.statuses.includes("failed");
    }, null, { timeout });
    if (submission.state !== "accepted-response-dropped") {
      throw new Error(submission.error ?? `Unexpected response-loss injection state: ${submission.state}`);
    }
    const apiInstance = submission.upstream_response.api_instance;
    const intentId = submission.client_intent_id;
    const commandId = submission.upstream_response.command_id;
    const scopeHeader = expectedSessionScopeHeader(expectedSession);
    const journalDeadline = Date.now() + timeout;
    let journal = null;
    let journalAttempts = 0;
    while (Date.now() < journalDeadline) {
      journalAttempts += 1;
      const snapshot = await scopedComputeFieldsJournalSnapshot(page, scopeHeader, apiInstance, intentId, commandId);
      if (snapshot.state === "completed") {
        journal = snapshot;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!journal) throw new Error("Scoped command journal did not reach completed within the bounded wait");

    await page.waitForFunction(() => {
      const capture = window.__fullmagComputeFieldsFeedbackCapture;
      return capture?.statuses.includes("completed") || capture?.statuses.includes("failed");
    }, null, { timeout });
    const uiFeedback = await page.evaluate(() => {
      const capture = window.__fullmagComputeFieldsFeedbackCapture;
      capture?.observer?.disconnect();
      return { statuses: [...(capture?.statuses ?? [])], messages: [...(capture?.messages ?? [])] };
    });
    if (
      uiFeedback.statuses.includes("failed") ||
      uiFeedback.statuses.includes("cancelled") ||
      !uiFeedback.statuses.includes("pending") ||
      !uiFeedback.statuses.includes("completed") ||
      uiFeedback.statuses.indexOf("completed") <= uiFeedback.statuses.indexOf("pending")
    ) {
      throw new Error("Compute Fields UI feedback did not progress from pending to completed");
    }
    if (submission.command_posts.length !== 1 || submission.command_posts[0] !== "compute_fields") {
      throw new Error("Compute Fields UI dispatched an unexpected or repeated command POST");
    }
    if (expectedResponseDrops.length !== 1 || submission.expected_abort_count !== 1) {
      throw new Error("The accepted Compute Fields browser response was not dropped exactly once");
    }
    return {
      state: "passed",
      session_scope: expectedSession,
      session_scope_header_matches: submission.session_scope_header_matches === true,
      client_intent_id: intentId,
      command_posts: {
        count: submission.command_posts.length,
        kinds: submission.command_posts,
        solve_count: submission.command_posts.filter((kind) => kind === "solve").length,
        forwarded_count: submission.forwarded_count,
        expected_abort_count: submission.expected_abort_count,
        expected_request_failure_count: expectedResponseDrops.length,
      },
      upstream_response: submission.upstream_response,
      journal: { ...journal, poll_attempts: journalAttempts },
      ui_feedback: uiFeedback,
      expected_response_drop: expectedResponseDrops[0],
    };
  } catch (error) {
    error.partialProof = {
      qa_scope: "canvas-home-ambiguous-compute-fields",
      state: submission.state,
      command_posts: [...submission.command_posts],
      forwarded_count: submission.forwarded_count,
      expected_abort_count: submission.expected_abort_count,
      expected_response_drops: [...expectedResponseDrops],
      client_intent_id: submission.client_intent_id,
      upstream_response: submission.upstream_response,
      error: bounded(error?.message ?? error),
    };
    throw error;
  } finally {
    await page.unroute(routePattern, routeHandler);
  }
};

const RUN_PERFORMANCE_PATH = "/v2/sessions/current/diagnostics/performance";

const requireRunPerformanceText = (value, label) => {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    throw new Error(`Run performance API omitted ${label}`);
  }
  return value;
};

const requireRunPerformanceInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Run performance API returned an invalid ${label}`);
  }
  return value;
};

const RUN_PERFORMANCE_MAX_SNAPSHOTS = 8;
const RUN_PERFORMANCE_MAX_OBSERVATION_MS = 20_000;
const RUN_PERFORMANCE_REQUEST_TIMEOUT_MS = 1_000;

const readRunPerformanceApiContext = async (page, expectedSession) => {
  const sessionScope = expectedSessionScopeHeader(expectedSession);
  const statusPath = "/v2/sessions/current/status";
  const statusResponse = await page.request.get(new URL(statusPath, page.url()).toString(), {
    timeout: Math.min(timeout, RUN_PERFORMANCE_REQUEST_TIMEOUT_MS),
    headers: { "x-fullmag-session-scope": sessionScope },
  });
  if (statusResponse.status() !== 200) {
    throw new Error(`GET ${statusPath} returned ${statusResponse.status()}`);
  }
  const apiInstanceId = statusResponse.headers()["x-fullmag-api-instance"] ?? "";
  if (!isApiInstanceId(apiInstanceId)) {
    throw new Error(`GET ${statusPath} omitted a valid API instance identity`);
  }
  const statusBody = await statusResponse.json();
  const statusSession = statusBody?.session;
  if (statusBody?.lifecycle?.session_resource !== "active" ||
      statusSession?.session_id !== expectedSession.session_id ||
      statusSession?.session_epoch !== expectedSession.session_epoch ||
      statusSession?.request_scope_epoch !== expectedSession.request_scope_epoch) {
    throw new Error("Run performance status probe changed or omitted the active session identity");
  }
  const requestEvidence = (path, response, apiInstanceIdSent, errorCode = null) => ({
    api_instance_header_sent: apiInstanceIdSent,
    api_instance_id: response.headers()["x-fullmag-api-instance"] ?? null,
    ...(errorCode ? { error_code: errorCode } : {}),
    method: "GET",
    path,
    session_scope_header_sent: sessionScope,
    status: response.status(),
  });
  return {
    apiInstanceId,
    requests: [requestEvidence(statusPath, statusResponse, null)],
    requestEvidence,
    sessionScope,
    statusRunId: requireRunPerformanceText(statusBody?.run?.run_id, "status.run.run_id"),
  };
};

const readRunPerformanceApiSnapshot = async (page, expectedSession, context) => {
  const performanceResponse = await page.request.get(
    new URL(RUN_PERFORMANCE_PATH, page.url()).toString(),
    {
      timeout: Math.min(timeout, RUN_PERFORMANCE_REQUEST_TIMEOUT_MS),
      headers: {
        "x-fullmag-api-instance": context.apiInstanceId,
        "x-fullmag-session-scope": context.sessionScope,
      },
    },
  );
  if (performanceResponse.status() === 409) {
    const body = await performanceResponse.json().catch(() => null);
    const errorCode = body?.code ?? body?.error?.code ?? null;
    context.requests.push(context.requestEvidence(
      RUN_PERFORMANCE_PATH, performanceResponse, context.apiInstanceId, errorCode,
    ));
    if (errorCode === "performance_observation_busy") return { busy: true };
    throw new Error(`GET ${RUN_PERFORMANCE_PATH} returned unexpected 409: ${String(errorCode)}`);
  }
  if (performanceResponse.status() !== 200) {
    throw new Error(`GET ${RUN_PERFORMANCE_PATH} returned ${performanceResponse.status()}`);
  }
  context.requests.push(context.requestEvidence(
    RUN_PERFORMANCE_PATH, performanceResponse, context.apiInstanceId,
  ));
  const performanceApiInstanceId = performanceResponse.headers()["x-fullmag-api-instance"] ?? "";
  if (performanceApiInstanceId !== context.apiInstanceId) {
    throw new Error("Run performance resource changed the pinned API instance");
  }
  const resource = await performanceResponse.json();
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new Error("Run performance API returned a non-object resource");
  }
  const runId = requireRunPerformanceText(resource.run_id, "run_id");
  const taskId = requireRunPerformanceText(resource.task_id, "task_id");
  const stepId = requireRunPerformanceText(resource.step_id, "step_id");
  const attemptId = requireRunPerformanceText(resource.attempt_id, "attempt_id");
  const ownershipEpoch = requireRunPerformanceInteger(resource.ownership_epoch, "ownership_epoch");
  const firstStepIndex = requireRunPerformanceInteger(resource.first_step_index, "first_step_index");
  const stepIndex = requireRunPerformanceInteger(resource.step_index, "step_index");
  const sampleSequence = requireRunPerformanceInteger(resource.sample_sequence, "sample_sequence");
  const elapsedMonotonicNs = requireRunPerformanceInteger(
    resource.elapsed_monotonic_ns,
    "elapsed_monotonic_ns",
  );
  if (resource.state === "unavailable" || runId !== context.statusRunId || elapsedMonotonicNs <= 0 ||
      stepIndex < firstStepIndex || typeof resource.revision !== "string" || !resource.revision ||
      !Array.isArray(resource.points) || resource.points.length < 1 || resource.points.length > 120) {
    throw new Error("Run performance API resource is unavailable, incomplete, or outside the active run");
  }
  const latest = resource.points.at(-1);
  if (!latest || (latest.step_index != null && latest.step_index !== stepIndex)) {
    throw new Error("Run performance API latest sample does not match its step index");
  }
  const cpuPercent = latest.cpu_percent;
  const gpuPercent = latest.gpu_percent;
  for (const [label, value] of [["cpu_percent", cpuPercent], ["gpu_percent", gpuPercent]]) {
    if (value !== null && value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`Run performance API returned an invalid ${label}`);
    }
  }
  if (cpuPercent == null && gpuPercent == null) {
    throw new Error("Run performance API did not publish a measured CPU or GPU value");
  }
  const stageRate = (stepIndex - firstStepIndex) / (elapsedMonotonicNs / 1_000_000_000);
  return {
    api: {
      api_instance_id: context.apiInstanceId,
      attempt_id: attemptId,
      cpu_percent: cpuPercent ?? null,
      elapsed_monotonic_ns: elapsedMonotonicNs,
      first_step_index: firstStepIndex,
      gpu_percent: gpuPercent ?? null,
      ownership_epoch: ownershipEpoch,
      point_count: resource.points.length,
      revision: resource.revision,
      run_id: runId,
      sample_sequence: sampleSequence,
      session_epoch: expectedSession.session_epoch,
      session_id: expectedSession.session_id,
      request_scope_epoch: expectedSession.request_scope_epoch,
      state: resource.state,
      status_run_id: context.statusRunId,
      step_id: stepId,
      step_index: stepIndex,
      stage_rate_steps_per_s: stageRate,
      task_id: taskId,
    },
    latest,
  };
};

const formatRunPerformanceDecimal = (value) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });

const formatRunPerformancePercent = (value) =>
  value == null ? "N/A" : `${formatRunPerformanceDecimal(value)}%`;

const formatRunPerformanceElapsed = (nanoseconds) => {
  if (nanoseconds >= 1_000_000_000) {
    return `${formatRunPerformanceDecimal(nanoseconds / 1_000_000_000)} s`;
  }
  if (nanoseconds >= 1_000_000) {
    return `${formatRunPerformanceDecimal(nanoseconds / 1_000_000)} ms`;
  }
  return `${Math.round(nanoseconds).toLocaleString()} ns`;
};

const formatRunPerformancePanelValues = (api) => ({
  cpu: formatRunPerformancePercent(api.cpu_percent),
  elapsed: formatRunPerformanceElapsed(api.elapsed_monotonic_ns),
  gpu: formatRunPerformancePercent(api.gpu_percent),
  identity: [
    `Run ${api.run_id}`,
    `Task ${api.task_id}`,
    `Step ${api.step_id}`,
    `Attempt ${api.attempt_id}`,
    `Epoch ${api.ownership_epoch}`,
  ].join(" · "),
  stage_rate: `${formatRunPerformanceDecimal(api.stage_rate_steps_per_s)} steps/s`,
});

const observeRunPerformancePanel = (panel) => panel.evaluate((node) => {
  const valueFor = (label) => {
    const stat = [...node.querySelectorAll(".fm-auto-performance__stat")]
      .find((item) => item.querySelector("dt")?.textContent?.trim() === label);
    return stat?.querySelector("dd")?.textContent?.trim() ?? null;
  };
  const rect = node.getBoundingClientRect();
  const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
  const hit = document.elementFromPoint(x, y);
  const style = getComputedStyle(node);
  const chart = node.querySelector(".fm-auto-performance__chart .fm-analysis-plots__echarts");
  const canvases = chart ? [...chart.querySelectorAll("canvas")] : [];
  const canvas = canvases.find((item) => item.width > 0 && item.height > 0);
  const canvasRect = canvas?.getBoundingClientRect();
  const chartRect = chart?.getBoundingClientRect();
  const scopeNotes = [...node.querySelectorAll(".fm-auto-performance__scope-note")]
    .map((note) => note.textContent?.trim() ?? "");
  return {
    chart: {
      canvas_count: canvases.length,
      canvas_height: canvas?.height ?? 0,
      canvas_width: canvas?.width ?? 0,
      css_height: canvasRect?.height ?? 0,
      css_width: canvasRect?.width ?? 0,
      visible: Boolean(chartRect?.width > 0 && chartRect?.height > 0 &&
        canvasRect?.width > 0 && canvasRect?.height > 0),
    },
    cpu: valueFor("CPU/core"),
    elapsed: valueFor("Elapsed"),
    gpu: valueFor("GPU/device"),
    gpu_scope_note: scopeNotes.at(-1) ?? "",
    identity: node.querySelector(".fm-auto-performance__identity")?.textContent?.trim() ?? "",
    stage_rate: valueFor("Stage rate"),
    status: node.querySelector(".fm-footer-diagnostics__meta")?.textContent?.trim() ?? "",
    visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 &&
      rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth &&
      rect.bottom > 0 && rect.top < window.innerHeight && hit && node.contains(hit),
  };
});

const runPerformancePanelMatches = (api, panel) => {
  const expected = formatRunPerformancePanelValues(api);
  return panel.visible === true && panel.identity === expected.identity &&
    panel.elapsed === expected.elapsed && panel.stage_rate === expected.stage_rate &&
    panel.cpu === expected.cpu && panel.gpu === expected.gpu;
};

const captureRunPerformanceScreenshot = async (panel) => {
  const png = await panel.screenshot({ type: "png", timeout, animations: "disabled" });
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Automatic performance panel screenshot was not a PNG");
  }
  if (png.length > maxCanvasScreenshotBytes) {
    throw new Error("Automatic performance panel screenshot exceeds its bounded size");
  }
  return {
    byte_length: png.length,
    height: png.readUInt32BE(20),
    image_proof: true,
    media_type: "image/png",
    png_base64: png.toString("base64"),
    state: "captured",
    width: png.readUInt32BE(16),
  };
};

const runAutomaticPerformanceBrowserQa = async (page, expectedSession) => {
  const engineTab = page.getByRole("tab", { name: "Engine", exact: true });
  await engineTab.waitFor({ state: "visible", timeout });
  if (await engineTab.getAttribute("aria-selected") !== "true") await engineTab.click();
  const panel = page.getByRole("region", { name: "Automatic performance", exact: true });
  await panel.waitFor({ state: "visible", timeout });
  const apiContext = await readRunPerformanceApiContext(page, expectedSession);
  const apiSnapshots = [];
  const panelMatches = [];
  const deadline = Date.now() + RUN_PERFORMANCE_MAX_OBSERVATION_MS;
  let selectedMetric = null;
  let initialIdentity = null;
  let stateWasRunning = false;
  for (let attempt = 0; attempt < RUN_PERFORMANCE_MAX_SNAPSHOTS && Date.now() < deadline; attempt += 1) {
    const snapshot = await readRunPerformanceApiSnapshot(page, expectedSession, apiContext);
    if (!snapshot.busy) {
      const { api } = snapshot;
      const identity = [api.api_instance_id, api.session_id, api.session_epoch,
        api.request_scope_epoch, api.run_id, api.task_id, api.step_id, api.attempt_id,
        api.ownership_epoch].join("\u0000");
      if (initialIdentity === null) {
        initialIdentity = identity;
        selectedMetric = api.cpu_percent == null
          ? "GPU whole device (%)"
          : "CPU per core (%)";
        if (selectedMetric.startsWith("GPU")) {
          const metricSelect = panel.getByRole("combobox");
          await metricSelect.click();
          await page.getByRole("option", { name: selectedMetric, exact: true }).click();
        }
      } else if (identity !== initialIdentity) {
        throw new Error("Run performance API changed run/task/attempt/session/API identity during bounded observation");
      }
      stateWasRunning ||= api.state === "running";
      apiSnapshots.push(api);
      const panelObservation = await observeRunPerformancePanel(panel);
      const matchingApi = [...apiSnapshots].reverse().find((candidate) =>
        runPerformancePanelMatches(candidate, panelObservation));
      const observation = {
        api: matchingApi ?? api,
        matched: matchingApi !== undefined,
        panel: panelObservation,
      };
      if (observation.matched &&
          !panelMatches.some(({ api: matched }) => matched.sample_sequence === matchingApi.sample_sequence)) {
        panelMatches.push(observation);
      }
      const latestMatch = panelMatches.at(-1);
      const hasVisibleChart = latestMatch?.panel.chart.visible === true &&
        latestMatch.panel.chart.canvas_width > 0 && latestMatch.panel.chart.canvas_height > 0;
      if (stateWasRunning) {
        const refreshed = panelMatches.some((first, index) => panelMatches.slice(index + 1).some((second) =>
          first.api.state === "running" && second.api.state === "running" &&
          first.api.revision !== second.api.revision &&
          first.api.sample_sequence < second.api.sample_sequence &&
          first.api.elapsed_monotonic_ns < second.api.elapsed_monotonic_ns &&
          first.panel.elapsed !== second.panel.elapsed));
        if (refreshed && hasVisibleChart) break;
      } else if (panelMatches.length > 0 && hasVisibleChart) {
        break;
      }
    }
    if (attempt + 1 < RUN_PERFORMANCE_MAX_SNAPSHOTS && Date.now() + 750 < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  if (!selectedMetric || panelMatches.length === 0) {
    throw new Error(`Automatic performance panel did not match any scoped API snapshot within ${RUN_PERFORMANCE_MAX_OBSERVATION_MS} ms`);
  }
  const refreshedPair = panelMatches.find((first, index) => panelMatches.slice(index + 1).some((second) =>
    first.api.state === "running" && second.api.state === "running" &&
    first.api.revision !== second.api.revision &&
    first.api.sample_sequence < second.api.sample_sequence &&
    first.api.elapsed_monotonic_ns < second.api.elapsed_monotonic_ns &&
    first.panel.elapsed !== second.panel.elapsed));
  if (stateWasRunning && !refreshedPair) {
    throw new Error(`Running performance panel did not match two distinct revisions/sequences within ${RUN_PERFORMANCE_MAX_OBSERVATION_MS} ms; matches=${panelMatches.length}, snapshots=${apiSnapshots.length}`);
  }
  const matchedObservation = panelMatches.at(-1);
  const panelObservation = matchedObservation.panel;
  const chartObservation = panelObservation.chart;
  const visiblePanel = panelObservation.visible;
  if (!visiblePanel) throw new Error("Automatic performance panel is not visibly rendered in the Engine footer");
  if (!chartObservation.visible || chartObservation.canvas_width <= 0 || chartObservation.canvas_height <= 0) {
    throw new Error("Automatic performance chart did not render on a nonzero canvas");
  }
  if (blockedMutations.length > 0) {
    throw new Error(`Run performance QA blocked unexpected non-read-only requests: ${JSON.stringify(blockedMutations)}`);
  }
  const api = matchedObservation.api;
  const metricValue = selectedMetric.startsWith("GPU") ? api.gpu_percent : api.cpu_percent;
  const liveRefresh = stateWasRunning
    ? {
      state: "verified",
      matched_revision_count: new Set(panelMatches.map(({ api: matched }) => matched.revision)).size,
      matched_sample_sequence_count: new Set(panelMatches.map(({ api: matched }) => matched.sample_sequence)).size,
      observations: panelMatches.map(({ api: matched, panel: matchedPanel }) => ({
        elapsed: matchedPanel.elapsed,
        elapsed_monotonic_ns: matched.elapsed_monotonic_ns,
        revision: matched.revision,
        sample_sequence: matched.sample_sequence,
        step_index: matched.step_index,
      })),
      window_ms: Math.min(RUN_PERFORMANCE_MAX_OBSERVATION_MS, Date.now() - (deadline - RUN_PERFORMANCE_MAX_OBSERVATION_MS)),
    }
    : {
      state: "terminal-single-snapshot",
      matched_revision_count: new Set(panelMatches.map(({ api: matched }) => matched.revision)).size,
      matched_sample_sequence_count: new Set(panelMatches.map(({ api: matched }) => matched.sample_sequence)).size,
      observations: panelMatches.slice(-1).map(({ api: matched, panel: matchedPanel }) => ({
        elapsed: matchedPanel.elapsed,
        elapsed_monotonic_ns: matched.elapsed_monotonic_ns,
        revision: matched.revision,
        sample_sequence: matched.sample_sequence,
        step_index: matched.step_index,
      })),
      window_ms: Math.min(RUN_PERFORMANCE_MAX_OBSERVATION_MS, Date.now() - (deadline - RUN_PERFORMANCE_MAX_OBSERVATION_MS)),
    };
  const screenshot = await captureRunPerformanceScreenshot(panel);
  return {
    api,
    api_requests: apiContext.requests,
    api_snapshots: apiSnapshots,
    blocked_mutation_count: blockedMutations.length,
    chart: chartObservation,
    engine_tab_clicked: true,
    live_refresh: liveRefresh,
    no_non_read_only_requests: true,
    panel: {
      ...panelObservation,
      metric_label: selectedMetric.startsWith("GPU") ? "GPU whole device" : "CPU per core",
      metric_value: formatRunPerformancePercent(metricValue),
      visible: visiblePanel,
    },
    panel_matches: panelMatches,
    schema: "fullmag.docker-dev-run-performance-browser-proof.v1",
    screenshot,
    state: "passed",
  };
};

const main = async () => {
  if (!["0", "1"].includes(canvasOnlySetting)) {
    throw new Error("CONTROL_ROOM_BROWSER_QA_CANVAS_ONLY must be exactly 0 or 1");
  }
  const liveFieldEnvPresent = expectedLiveFieldSetting !== undefined;
  const airboxEnvPresent = process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS !== undefined;
  if (liveFieldEnvPresent !== airboxEnvPresent) {
    throw new Error("Focused live-field Compose environment must pin both expected-field variables");
  }
  if (liveFieldEnvPresent && (!canvasOnly || !expectedLiveFieldSetting ||
      expectedLiveFieldSetting !== expectedLiveFieldSetting.trim() || expectedLiveFieldSetting.length > 512 ||
      [...expectedLiveFieldSetting].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw new Error("Focused live-field expectation is malformed or outside canvas-only scope");
  }
  if (!["0", "1"].includes(expectAirboxVectorsSetting)) {
    throw new Error("CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS must be exactly 0 or 1");
  }
  if (expectFemAirboxVectorsSetting !== undefined && !["0", "1"].includes(expectFemAirboxVectorsSetting)) {
    throw new Error("CONTROL_ROOM_BROWSER_QA_EXPECT_FEM_AIRBOX_VECTORS must be exactly 0 or 1");
  }
  if (expectAirboxVectors && !expectedLiveField) {
    throw new Error("FDM airbox-vector expectation requires a live-field quantity");
  }
  if (expectFemAirboxVectors && (!canvasOnly || expectedLiveField !== "m" || expectAirboxVectors ||
      expectAmbiguousComputeFields || scenarioSetting !== "fem-airbox-vectors")) {
    throw new Error("FEM Airbox vector QA requires its canvas-only m field scenario and excludes other mutations");
  }
  if (!expectFemAirboxVectors && scenarioSetting === "fem-airbox-vectors") {
    throw new Error("FEM Airbox vector scenario is missing its explicit observation flag");
  }
  if (!(["0", "1"].includes(expectPlanarAirboxSetting))) {
    throw new Error("CONTROL_ROOM_BROWSER_QA_EXPECT_PLANAR_AIRBOX must be exactly 0 or 1");
  }
  if (expectPlanarAirbox && (!canvasOnly || expectedLiveField !== "m" || expectAirboxVectors ||
      expectFemAirboxVectors || expectAmbiguousComputeFields || expectTerminalTelemetry ||
      expectRunPerformance || scenarioSetting !== "planar-airbox" ||
      process.env.CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE === "1")) {
    throw new Error("Planar Airbox QA requires its canvas-only primary-m scenario and excludes other browser mutations");
  }
  if (!expectPlanarAirbox && scenarioSetting === "planar-airbox") {
    throw new Error("Planar Airbox scenario is missing its explicit observation flag");
  }
  if (expectTerminalTelemetrySetting !== undefined && expectTerminalTelemetrySetting !== "1") {
    throw new Error("CONTROL_ROOM_BROWSER_QA_EXPECT_TERMINAL_TELEMETRY must be absent or exactly 1");
  }
  if (expectFdmCellPhysicsSetting !== undefined && expectFdmCellPhysicsSetting !== "1") {
    throw new Error("CONTROL_ROOM_BROWSER_QA_EXPECT_FDM_CELL_PHYSICS must be absent or exactly 1");
  }
  if (expectRunPerformanceSetting !== undefined && expectRunPerformanceSetting !== "1") {
    throw new Error("CONTROL_ROOM_BROWSER_QA_EXPECT_RUN_PERFORMANCE must be absent or exactly 1");
  }
  if (expectRunPerformance && (!canvasOnly || expectedLiveField || expectAirboxVectors ||
      expectFemAirboxVectors || expectAmbiguousComputeFields || expectTerminalTelemetry ||
      scenarioSetting !== "standard" || process.env.CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE === "1")) {
    throw new Error("Run performance QA requires standalone canvas-only scope and excludes other scenarios");
  }
  if (expectTerminalTelemetry && (!canvasOnly || expectedLiveField !== "m" || expectAirboxVectors ||
      expectFemAirboxVectors || expectAmbiguousComputeFields || scenarioSetting !== "standard" ||
      process.env.CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE === "1")) {
    throw new Error("Terminal telemetry QA requires canvas-only primary m observation and excludes mutation scenarios");
  }
  if (expectFdmCellPhysics && (!canvasOnly || expectedLiveField !== "m" || expectAirboxVectors ||
      expectFemAirboxVectors || expectAmbiguousComputeFields || expectTerminalTelemetry ||
      expectRunPerformance || expectPlanarAirbox || scenarioSetting !== "standard" ||
      process.env.CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE === "1")) {
    throw new Error("FDM cell physics QA requires its standalone canvas-only m profile");
  }
  if (!["0", "1"].includes(expectAmbiguousComputeFieldsSetting)) {
    throw new Error("CONTROL_ROOM_BROWSER_QA_EXPECT_AMBIGUOUS_COMPUTE_FIELDS must be exactly 0 or 1");
  }
  if (expectAmbiguousComputeFields && !canvasOnly) {
    throw new Error("Ambiguous Compute Fields QA requires canvas-only scope");
  }
  if (canvasOnly && process.env.CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE === "1") {
    throw new Error("Canvas-only browser QA cannot prepare a viewport fixture");
  }
  if (!publicUrl) throw new Error("CONTROL_ROOM_PUBLIC_URL is required");
  if (playwrightPackage.version !== expectedVersion || expectedVersion !== "1.62.1") {
    throw new Error(`Playwright package ${playwrightPackage.version} does not match ${expectedVersion}`);
  }
  if ((!canvasOnly || expectPlanarAirbox) && typeof PNG?.sync?.read !== "function") {
    throw new Error("Pinned Playwright utilsBundle does not expose PNG.sync.read");
  }
  const sourceHashesBefore = await readHarnessSourceHashes();
  let browser = null;
  let page = null;
  let loopbackProxy = null;
  try {
    loopbackProxy = await startBrowserQaLoopbackProxy(publicUrl, probeUrl);
    browserRoute = { document_origin: loopbackProxy.origin, private_upstream: loopbackProxy.upstream, published_ports: 0 };
    browser = await chromium.launch({
      headless: true,
      args: [
        "--headless=new",
        "--disable-dev-shm-usage",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--no-sandbox",
        "--use-angle=swiftshader-webgl",
        "--use-gl=angle",
      ],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.setDefaultTimeout(timeout);
    installFieldTransportLifecycleObserver(page);
    if (expectFemAirboxVectors || expectPlanarAirbox) {
      await page.route("**/v2/**", async (route) => {
        const request = route.request();
        const method = request.method();
        if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
        const url = new URL(request.url());
        if (method === "PATCH" && url.origin === loopbackProxy.origin &&
            url.pathname === "/v2/sessions/current/visualization/state") {
          return route.continue();
        }
        // This resource records presentation adoption and cannot start computation.
        if (method === "POST" && url.origin === loopbackProxy.origin &&
            url.pathname === "/v2/sessions/current/visualization/client-acks") {
          visualizationClientAckRequestCount += 1;
          return route.continue();
        }
        if (blockedMutations.length < 16) blockedMutations.push({ method, path: url.pathname });
        return route.abort("blockedbyclient");
      });
      page.on("request", (request) => {
        if (request.method() !== "PATCH") return;
        if (new URL(request.url()).pathname === "/v2/sessions/current/visualization/state") {
          displayPatchRequestCount += 1;
        }
      });
    }
    if (expectRunPerformance) {
      await page.route("**/v2/**", async (route) => {
        const request = route.request();
        if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
        const url = new URL(request.url());
        if (request.method() === "POST" && url.origin === loopbackProxy.origin &&
            url.pathname === "/v2/sessions/current/visualization/client-acks") {
          visualizationClientAckRequestCount += 1;
          return route.continue();
        }
        if (blockedMutations.length < 16) {
          blockedMutations.push({ method: request.method(), path: url.pathname });
        }
        return route.abort("blockedbyclient");
      });
    }
    if (!canvasOnly) await installViewportPerformanceProbe(page);
    page.on("pageerror", (error) => collect(pageErrors, error));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const locationUrl = message.location()?.url ?? "";
      if (
        text === "Failed to load resource: net::ERR_CONNECTION_RESET" &&
        intentionalResponseDropUrls.has(locationUrl) &&
        expectedConsoleErrors.length === 0
      ) {
        expectedConsoleErrors.push({ message: bounded(text), url: bounded(locationUrl) });
        return;
      }
      collect(consoleErrors, text);
    });
    page.on("requestfailed", (request) => {
      const error = request.failure()?.errorText ?? "failed";
      const record = `${request.method()} ${request.url()} ${error}`;
      if (intentionalResponseDropRequests.has(request)) {
        const url = new URL(request.url());
        if (request.method() === "POST" && url.pathname === simulationCommandsPath) {
          if (expectedResponseDrops.length < 4) {
            expectedResponseDrops.push({
              method: request.method(),
              url: bounded(request.url()),
              error: bounded(error),
            });
          }
          return;
        }
      }
      // Resource hooks cancel obsolete GET subscriptions during reload,
      // invalidation and unmount. Keep those observable without treating a
      // client abort as a failed HTTP response or transport connection.
      const resourceCancellation = request.method() === "GET" && error === "net::ERR_ABORTED" &&
        new URL(request.url()).pathname.startsWith("/v2/");
      collect(resourceCancellation ? requestCancellations : requestFailures, record);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      const planarMetaMatch = url.pathname.match(
        /^\/v2\/sessions\/current\/data\/fields\/H_demag\/planar-default\/meta$/,
      );
      if (expectPlanarAirbox && planarMetaMatch && planarAirboxMetaResponses.length < 16) {
        const record = {
          method: response.request().method(),
          path: url.pathname,
          scope_kind: url.searchParams.get("scope_kind"),
          scope_id_present: url.searchParams.has("scope_id"),
          status: response.status(),
          payload: null,
        };
        if (response.status() === 200) {
          response.json().then((payload) => { record.payload = payload; }).catch((error) => {
            collect(pageErrors, `Planar Airbox metadata inspection failed: ${String(error)}`);
          });
        }
        planarAirboxMetaResponses.push(record);
      }
      if (url.pathname === "/v2/sessions/current/data/fields/H_demag/samples/vector" &&
          femAirboxVectorResponses.length < 16) {
        femAirboxVectorResponses.push({
          method: response.request().method(),
          status: response.status(),
          same_origin: url.origin === new URL(page.url()).origin,
          path: url.pathname,
          quantity_id: "H_demag",
          component: url.searchParams.get("component"),
          scope_kind: url.searchParams.get("scope_kind"),
          scope_id: url.searchParams.get("scope_id"),
        });
      }
      if (response.status() >= 400 && httpErrors.length < 32) {
        httpErrors.push({ url: response.url(), status: response.status() });
      }
      if (!url.pathname.startsWith("/v2/") || resourceResponses.length >= 32) return;
      const headers = response.headers();
      resourceResponses.push({ url: response.url(), status: response.status(),
        content_type: headers["content-type"], contract_version: headers["x-fullmag-api-contract-version"] });
    });

    const response = await page.goto(loopbackProxy.origin, { waitUntil: "domcontentloaded", timeout });
    if (!response || response.status() >= 400) throw new Error(`Fullmag DEV returned ${response?.status() ?? "no response"}`);
    if (!new URL(page.url()).pathname.startsWith("/workspace")) throw new Error(`Expected /workspace, got ${page.url()}`);
    const home = page.locator('.fm-home-overlay[data-state="home-overlay"]');
    if (await home.isVisible()) {
      const returnToWorkspace = page.getByRole("button", { name: "Back to simulation", exact: true });
      await returnToWorkspace.click();
      await home.waitFor({ state: "hidden", timeout });
    }
    await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
    const sessionBefore = await sessionIdentity(page);
    const femRunIdentityBefore = expectFemAirboxVectors ? await activeFemRunIdentity(page) : null;
    if (femRunIdentityBefore && (
      femRunIdentityBefore.session_id !== sessionBefore.session_id ||
      femRunIdentityBefore.session_epoch !== sessionBefore.session_epoch ||
      femRunIdentityBefore.request_scope_epoch !== sessionBefore.request_scope_epoch
    )) {
      throw new Error("FEM Airbox status identity differs from the active session snapshot");
    }
    let appearanceQa = null;
    let exportQa = null;
    let layoutQa = null;
    let lifecycleQa = null;
    if (!canvasOnly) {
      const sceneResponse = await page.request.get(`${loopbackProxy.origin}/v2/sessions/current/model/scene`, { timeout });
      if (!sceneResponse.ok()) throw new Error(`Viewport model readiness returned HTTP ${sceneResponse.status()}`);
      const sceneSnapshot = await sceneResponse.json();
      if (!Array.isArray(sceneSnapshot.objects)) throw new Error("Viewport model readiness omitted canonical objects");
      const ringDepthRegression = sceneSnapshot.scene?.name === "permalloy_layer_cofeb_rings_relax_300nm" &&
        sceneSnapshot.objects.length === 2 &&
        sceneSnapshot.objects.some((object) => object.name === "cofeb_top_ring") &&
        sceneSnapshot.objects.some((object) => object.name === "permalloy_layer");
      if (ringDepthRegression) {
        await page.waitForFunction((ids) => {
          const adopted = document.querySelector(".fm-viewport-3d")
            ?.getAttribute("data-primitive-object-ids")?.split(" ") ?? [];
          return ids.every((id) => adopted.includes(id));
        }, sceneSnapshot.objects.map((object) => object.id), { timeout });
      }
      const fixtureObjectId = "qa-offset-film-mvgw65uf";
      partialProof.viewport_model_readiness = {
        scene_revision: sceneSnapshot.revision,
        object_count: sceneSnapshot.objects.length,
        fixture_adoption: "not-required-for-this-scene",
      };
      if (sceneSnapshot.objects.some((object) => object.id === fixtureObjectId)) {
        await page.waitForFunction((id) => {
          const viewport = document.querySelector(".fm-viewport-3d");
          return Number(viewport?.getAttribute("data-primitive-object-count")) > 0 &&
            viewport?.getAttribute("data-primitive-object-ids")?.split(" ").includes(id);
        }, fixtureObjectId, { timeout });
        partialProof.viewport_model_readiness.fixture_adoption = "primitive-model-adopted";
      }
      if (process.env.CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE === "1") {
        partialProof.fixture_preparation = await runViewportQaFixtureBrowser(page, {
          expectedSession: sessionBefore, getSessionIdentity: () => sessionIdentity(page), timeout,
        });
        if (partialProof.fixture_preparation.state !== "ready") {
          throw new Error(`Viewport QA fixture unavailable: ${partialProof.fixture_preparation.reason}`);
        }
      }
      appearanceQa = await runViewportAppearanceBrowserQa(page, {
        assertCanvas: (label) => assertCanvas(page, label),
        expectedSession: sessionBefore,
        getSessionIdentity: () => sessionIdentity(page),
        pngDecoder: PNG,
        timeout,
      });
      partialProof.viewport_appearance = appearanceQa;
      try {
        partialProof.viewport_camera = await runViewportCameraBrowserQa(page, {
          assertCanvas: (label) => assertCanvas(page, label), pngDecoder: PNG, timeout,
          ringDepthRegression,
        });
      } catch (error) {
        if (error?.partialProof) partialProof.viewport_camera = error.partialProof;
        throw error;
      }
      exportQa = await runViewportExportBrowserQa(page, {
        assertCanvas: (label) => assertCanvas(page, label), pngDecoder: PNG, timeout,
      });
      partialProof.viewport_export = exportQa;
      layoutQa = await runViewportLayoutBrowserQa(page, {
        assertCanvas: (label) => assertCanvas(page, label), pngDecoder: PNG, timeout, expectedDpr: 1,
      });
      partialProof.viewport_layout_dpr1 = layoutQa;
      const highDprContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2,
      });
      const originalPage = page;
      try {
        page = await highDprContext.newPage();
        page.setDefaultTimeout(timeout);
        installFieldTransportLifecycleObserver(page);
        await installViewportPerformanceProbe(page);
        page.on("pageerror", (error) => collect(pageErrors, error));
        page.on("console", (message) => {
          if (message.type() === "error") collect(consoleErrors, message.text());
        });
        page.on("requestfailed", (request) => {
          const error = request.failure()?.errorText ?? "failed";
          const cancelled = request.method() === "GET" && error === "net::ERR_ABORTED" &&
            new URL(request.url()).pathname.startsWith("/v2/");
          collect(cancelled ? requestCancellations : requestFailures,
            `${request.method()} ${request.url()} ${error}`);
        });
        page.on("response", (response) => {
          if (response.status() >= 400 && httpErrors.length < 32) {
            httpErrors.push({ url: response.url(), status: response.status() });
          }
        });
        const dprResponse = await page.goto(loopbackProxy.origin, { waitUntil: "domcontentloaded", timeout });
        if (!dprResponse || dprResponse.status() >= 400) throw new Error("DPR2 workspace navigation failed");
        const dprHome = page.locator('.fm-home-overlay[data-state="home-overlay"]');
        if (await dprHome.isVisible()) {
          await page.getByRole("button", { name: "Back to simulation", exact: true }).click();
          await dprHome.waitFor({ state: "hidden", timeout });
        }
        await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
        if (JSON.stringify(await sessionIdentity(page)) !== JSON.stringify(sessionBefore)) {
          throw new Error("DPR2 context has a different active session");
        }
        partialProof.viewport_layout_dpr2 = await runViewportLayoutBrowserQa(page, {
          assertCanvas: (label) => assertCanvas(page, label), pngDecoder: PNG, timeout, expectedDpr: 2,
        });
        partialProof.viewport_export_dpr2 = await runViewportExportBrowserQa(page, {
          assertCanvas: (label) => assertCanvas(page, label), pngDecoder: PNG, timeout, expectedCaptureDpr: 2,
        });
      } finally {
        await highDprContext.close();
        page = originalPage;
      }
      lifecycleQa = await runViewportLifecycleBrowserQa(page, {
        assertCanvas: (label) => assertCanvas(page, label), expectedSession: sessionBefore,
        getSessionIdentity: () => sessionIdentity(page), timeout, cycles: 20,
      });
      partialProof.viewport_lifecycle = lifecycleQa;
    }
    const before = await assertCanvas(page, "before Home");
    partialProof.canvas_before = before;
    let runPerformanceProof = null;
    if (expectRunPerformance) {
      try {
        runPerformanceProof = await runAutomaticPerformanceBrowserQa(page, sessionBefore);
        partialProof.run_performance = runPerformanceProof;
      } catch (error) {
        if (error?.partialProof) partialProof.run_performance = error.partialProof;
        throw error;
      }
    }
    if (canvasOnly && expectedLiveField) {
      partialProof.canvas_before_screenshot = await captureCanvasScreenshot(page, before);
    }
    const viewportDomObservations = expectRunPerformance && canvasOnly
      ? {
        field_data_proven: false,
        note: viewportDomObservationNote,
        reason: performanceOnlyViewportDomOmissionReason,
        scope: runPerformanceQaScope,
        state: "omitted",
      }
      : {
        before_home: await viewportDomObservation(page),
        after_home: null,
        field_data_proven: false,
        note: viewportDomObservationNote,
      };
    partialProof.viewport_dom_observations = viewportDomObservations;
    let liveFieldBefore = null;
    let liveFieldAfter = null;
    if (expectedLiveField) {
      try {
        liveFieldBefore = await waitForLiveField(page, expectedLiveField, expectAirboxVectors);
        if (expectFemAirboxVectors && liveFieldBefore.solver_family !== "fem") {
          throw new Error("FEM Airbox vector proof received an FDM viewport readiness observation");
        }
      } catch (error) {
        const current = await liveFieldObservation(page, expectedLiveField).catch(() => null);
        error.partialProof = {
          field_data_proven: false,
          note: liveFieldObservationNote,
          expected_quantity_id: expectedLiveField,
          airbox_vectors_expected: expectAirboxVectors,
          before_home: current,
          after_home: null,
        };
        throw error;
      }
      partialProof.live_field_observation = {
        field_data_proven: false,
        note: liveFieldObservationNote,
        expected_quantity_id: expectedLiveField,
        airbox_vectors_expected: expectAirboxVectors,
        before_home: liveFieldBefore,
        after_home: null,
      };
    }
    let planarAirboxObservation = null;
    if (expectPlanarAirbox) {
      try {
        planarAirboxObservation = await runPlanarAirboxBrowserQa(page, sessionBefore);
        partialProof.planar_airbox_observation = planarAirboxObservation;
      } catch (error) {
        if (error?.partialProof) partialProof.planar_airbox_observation = error.partialProof;
        throw error;
      }
    }
    const canvasHandle = await page.locator(".fm-viewport-3d canvas").first().elementHandle();
    if (!canvasHandle) throw new Error("before Home: could not retain the workspace canvas element");

    const start = page.getByRole("button", { name: "Home", exact: true });
    await start.waitFor({ state: "visible", timeout });
    await start.click();
    await home.waitFor({ state: "visible", timeout });
    await page.waitForFunction(() => document.querySelector(".fm-home-overlay .fm-start-status")?.textContent?.includes("Simulation open:") === true, null, { timeout });
    const homeText = await home.innerText();
    if (!homeText.includes("Simulation open:")) throw new Error("Home did not show the active session label");

    const back = page.getByRole("button", { name: "Back to simulation", exact: true });
    await back.waitFor({ state: "visible", timeout });
    await back.click();
    await home.waitFor({ state: "hidden", timeout });
    await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
    const canvasDomStable = await canvasHandle.evaluate((canvas) => canvas === document.querySelector(".fm-viewport-3d canvas") && document.contains(canvas));
    if (!canvasDomStable) throw new Error("Home unmounted or replaced the workspace canvas");
    const after = await assertCanvas(page, "after Home");
    partialProof.canvas_after = after;
    if (!(expectRunPerformance && canvasOnly)) {
      viewportDomObservations.after_home = await viewportDomObservation(page);
    }
    if (expectedLiveField) {
      try {
        liveFieldAfter = await waitForLiveField(page, expectedLiveField, expectAirboxVectors);
      } catch (error) {
        const current = await liveFieldObservation(page, expectedLiveField).catch(() => null);
        error.partialProof = {
          field_data_proven: false,
          note: liveFieldObservationNote,
          expected_quantity_id: expectedLiveField,
          airbox_vectors_expected: expectAirboxVectors,
          before_home: liveFieldBefore,
          after_home: current,
        };
        throw error;
      }
      partialProof.live_field_observation.after_home = liveFieldAfter;
    }
    let ambiguousCommandSubmission = null;
    let canvasAfterComputeFields = null;
    if (expectAmbiguousComputeFields) {
      ambiguousCommandSubmission = await observeAmbiguousComputeFieldsSubmission(page, sessionBefore);
      partialProof.ambiguous_command_submission = ambiguousCommandSubmission;
      canvasAfterComputeFields = await assertCanvas(page, "after ambiguous Compute Fields response loss");
    }
    const sessionAfter = await sessionIdentity(page);
    if (JSON.stringify(sessionBefore) !== JSON.stringify(sessionAfter)) throw new Error("Active session identity changed during Home round trip");
    const femRunIdentityAfterHome = expectFemAirboxVectors ? await activeFemRunIdentity(page) : null;
    if (femRunIdentityBefore && femRunIdentityAfterHome) {
      assertStableFemRunIdentity(femRunIdentityBefore, femRunIdentityAfterHome, "during the Home round trip");
    }
    let femAirboxObservation = null;
    if (expectFemAirboxVectors) {
      if (!femRunIdentityBefore || !liveFieldAfter || liveFieldAfter.solver_family !== "fem") {
        throw new Error("FEM Airbox proof is missing stable run identity or the primary m field after Home");
      }
      if (blockedMutations.length > 0) {
        throw new Error(`FEM Airbox proof blocked unexpected non-display mutation requests: ${JSON.stringify(blockedMutations)}`);
      }
      femAirboxObservation = await proveFemAirboxVectors(page, femRunIdentityBefore, liveFieldAfter);
      partialProof.fem_airbox_observation = femAirboxObservation;
    }
    let terminalTelemetry = null;
    if (expectTerminalTelemetry) {
      try {
        terminalTelemetry = await runTerminalFooterTelemetryBrowserQa({
          page,
          expectedSession: sessionBefore,
          timeout,
          assertCanvas: (label) => assertCanvas(page, label),
          waitForLiveField: (quantityId, requireAirboxVectors) =>
            waitForLiveField(page, quantityId, requireAirboxVectors),
        });
        partialProof.terminal_telemetry = terminalTelemetry;
      } catch (error) {
        if (error?.partialProof) partialProof.terminal_telemetry = error.partialProof;
        throw error;
      }
    }
    let fdmCellPhysics = null;
    if (expectFdmCellPhysics && liveFieldAfter?.solver_family !== "fdm") {
      throw new Error("FDM cell physics profile requires a live FDM field");
    }
    if (expectFdmCellPhysics || (expectTerminalTelemetry && liveFieldAfter?.solver_family === "fdm")) {
      fdmCellPhysics = await proveFdmCellPhysics(page);
      partialProof.fdm_cell_physics = fdmCellPhysics;
    }
    if (pageErrors.length || consoleErrors.length || requestFailures.length || httpErrors.length) {
      throw new Error("Browser flow recorded page, console, transport, or HTTP failures");
    }
    partialProof.field_transport_lifecycle = fieldTransportLifecycle;

    const result = {
      schema: resultSchema,
      state: "passed",
      qa_scope: expectRunPerformance ? runPerformanceQaScope :
        expectPlanarAirbox ? "canvas-home-planar-airbox" :
        expectFdmCellPhysics ? "canvas-home-fdm-cell-physics" :
        expectAmbiguousComputeFields ? "canvas-home-ambiguous-compute-fields" :
        expectFemAirboxVectors ? "canvas-home-fem-airbox-vectors" :
        expectAirboxVectors ? "canvas-home-live-field-airbox" :
        expectedLiveField ? "canvas-home-live-field" : canvasOnly ? "canvas-home-only" : "full-browser-qa",
      skipped_areas: expectRunPerformance && canvasOnly
        ? [...canvasOnlySkippedAreas, performanceOnlyViewportDomSkippedArea]
        : canvasOnly ? canvasOnlySkippedAreas : [],
      public_url: publicUrl,
      probe_url: probeUrl,
      final_url: page.url(),
      playwright_version: playwrightPackage.version,
      browser_gpu_mode: browserGpuMode,
      canvas_only: canvasOnly,
      expect_live_field: expectedLiveField,
      expect_airbox_vectors: expectAirboxVectors,
      expect_planar_airbox: expectPlanarAirbox,
      expect_ambiguous_compute_fields: expectAmbiguousComputeFields,
      ...(expectFemAirboxVectors ? { expect_fem_airbox_vectors: true } : {}),
      ...(expectFdmCellPhysics ? { expect_fdm_cell_physics: true, fdm_cell_physics: fdmCellPhysics } : {}),
      ...(expectTerminalTelemetry ? {
        expect_terminal_telemetry: true,
        terminal_telemetry: terminalTelemetry,
        ...(fdmCellPhysics ? { fdm_cell_physics: fdmCellPhysics } : {}),
      } : {}),
      ...(expectRunPerformance ? {
        expect_run_performance: true,
        run_performance: runPerformanceProof,
      } : {}),
      home_round_trip: true,
      home: { section: "home", visible: true, session_label: homeText.match(/Simulation open:[^\n]*/)?.[0] ?? "Simulation open:" },
      session: sessionAfter,
      workspace: { visible: true, canvas_dom_stable: canvasDomStable },
      canvas_before: before,
      canvas_after: after,
      viewport_dom_observations: viewportDomObservations,
      ...(expectedLiveField ? {
        live_field_observation: {
          field_data_proven: false,
          note: liveFieldObservationNote,
          expected_quantity_id: expectedLiveField,
          airbox_vectors_expected: expectAirboxVectors,
          before_home: liveFieldBefore,
          after_home: liveFieldAfter,
        },
        canvas_screenshot: await captureCanvasScreenshot(page, after),
      } : {}),
      ...(expectPlanarAirbox ? { planar_airbox_observation: planarAirboxObservation } : {}),
      ...(expectFemAirboxVectors ? { fem_airbox_observation: femAirboxObservation } : {}),
      ...(expectAmbiguousComputeFields ? {
        ambiguous_command_submission: ambiguousCommandSubmission,
        canvas_after_compute_fields: canvasAfterComputeFields,
      } : { ambiguous_command_submission: null }),
      ...(canvasOnly && (expectedLiveField || expectRunPerformance) ? { partial_proof: partialProof } : {}),
      page_errors: pageErrors.length,
      console_errors: consoleErrors.length,
      expected_console_errors: expectedConsoleErrors,
      request_failures: requestFailures.length,
      http_errors: httpErrors,
      resource_responses: resourceResponses,
      request_cancellations: requestCancellations,
      expected_response_drops: expectedResponseDrops,
    };
    if (canvasOnly) return result;
    return {
      ...result,
      viewport_appearance: appearanceQa,
      viewport_export: exportQa,
      viewport_lifecycle: lifecycleQa,
      viewport_layout_dpr1: layoutQa,
      viewport_layout_dpr2: partialProof.viewport_layout_dpr2,
      viewport_export_dpr2: partialProof.viewport_export_dpr2,
      fixture_preparation: partialProof.fixture_preparation ?? { state: "not-requested" },
      viewport_camera: partialProof.viewport_camera,
    };
  } catch (error) {
    if (error?.partialProof) partialProof.failed_step = error.partialProof;
    partialProof.field_transport_lifecycle = fieldTransportLifecycle;
    if (page) {
      failurePageState = {
        url: page.url(),
        visible_text: bounded(await page.locator("body").innerText({ timeout: 3000 }).catch(() => "unavailable")),
      };
      try {
        const response = await page.request.get(new URL("/v2/sessions/current/status", page.url()).toString(), { timeout: 3000 });
        const status = await response.json();
        failurePageState.session_probe = { http_status: response.status(), lifecycle: status?.lifecycle, session_identity: status?.session };
      } catch (probeError) {
        failurePageState.session_probe_error = bounded(probeError?.message ?? probeError);
      }
    }
    throw error;
  } finally {
    cleanupStarted = true;
    partialProof.cleanupStarted = cleanupStarted;
    try {
      await browser?.close();
    } finally {
      if (loopbackProxy) {
        browserRoute.proxy_failures = [...loopbackProxy.failures];
        await loopbackProxy.close();
      }
      const sourceHashesAfter = await readHarnessSourceHashes();
      const unchanged = sameHarnessSourceHashes(sourceHashesBefore, sourceHashesAfter);
      harnessSourceHashes = {
        algorithm: "sha256",
        runner_before: sourceHashesBefore.runner,
        runner_after: sourceHashesAfter.runner,
        appearance_helper_before: sourceHashesBefore.appearance_helper,
        appearance_helper_after: sourceHashesAfter.appearance_helper,
        loopback_proxy_before: sourceHashesBefore.loopback_proxy,
        loopback_proxy_after: sourceHashesAfter.loopback_proxy,
        export_helper_before: sourceHashesBefore.export_helper,
        export_helper_after: sourceHashesAfter.export_helper,
        lifecycle_helper_before: sourceHashesBefore.lifecycle_helper,
        lifecycle_helper_after: sourceHashesAfter.lifecycle_helper,
        performance_helper_before: sourceHashesBefore.performance_helper,
        performance_helper_after: sourceHashesAfter.performance_helper,
        layout_helper_before: sourceHashesBefore.layout_helper,
        layout_helper_after: sourceHashesAfter.layout_helper,
        fixture_helper_before: sourceHashesBefore.fixture_helper,
        fixture_helper_after: sourceHashesAfter.fixture_helper,
        fixture_builders_before: sourceHashesBefore.fixture_builders,
        fixture_builders_after: sourceHashesAfter.fixture_builders,
        fixture_data_before: sourceHashesBefore.fixture_data,
        fixture_data_after: sourceHashesAfter.fixture_data,
        camera_helper_before: sourceHashesBefore.camera_helper,
        camera_helper_after: sourceHashesAfter.camera_helper,
        ...(expectTerminalTelemetry ? {
          terminal_telemetry_helper_before: sourceHashesBefore.terminal_telemetry_helper,
          terminal_telemetry_helper_after: sourceHashesAfter.terminal_telemetry_helper,
        } : {}),
        ...(expectPlanarAirbox ? {
          planar_field_evidence_before: sourceHashesBefore.planar_field_evidence,
          planar_field_evidence_after: sourceHashesAfter.planar_field_evidence,
        } : {}),
        unchanged,
      };
      if (!unchanged) throw new Error("Browser QA harness source changed during the run");
      if (browserRoute?.proxy_failures?.length) throw new Error("Browser QA loopback proxy reported upstream failures");
    }
  }
};

try {
  const payload = await main();
  payload.harness_source_sha256 = harnessSourceHashes;
  payload.browser_route = browserRoute;
  console.log(JSON.stringify(payload));
} catch (error) {
  partialProof.field_transport_lifecycle = fieldTransportLifecycle;
  partialProof.cleanupStarted = cleanupStarted;
  console.log(JSON.stringify({
    schema: resultSchema,
    state: "failed",
    canvas_only: canvasOnly,
    expect_live_field: expectedLiveField,
    expect_airbox_vectors: expectAirboxVectors,
    expect_planar_airbox: expectPlanarAirbox,
    expect_ambiguous_compute_fields: expectAmbiguousComputeFields,
    ...(expectFemAirboxVectors ? { expect_fem_airbox_vectors: true } : {}),
    ...(expectFdmCellPhysics ? { expect_fdm_cell_physics: true } : {}),
    ...(expectTerminalTelemetry ? { expect_terminal_telemetry: true } : {}),
    ...(expectRunPerformance ? { expect_run_performance: true } : {}),
    qa_scope: expectRunPerformance ? "canvas-engine-run-performance" :
      expectPlanarAirbox ? "canvas-home-planar-airbox" :
      expectFdmCellPhysics ? "canvas-home-fdm-cell-physics" :
      expectAmbiguousComputeFields ? "canvas-home-ambiguous-compute-fields" :
      expectFemAirboxVectors ? "canvas-home-fem-airbox-vectors" :
      expectAirboxVectors ? "canvas-home-live-field-airbox" :
      expectedLiveField ? "canvas-home-live-field" : canvasOnly ? "canvas-home-only" : "full-browser-qa",
    skipped_areas: canvasOnly ? canvasOnlySkippedAreas : [],
    public_url: publicUrl,
    probe_url: probeUrl,
    playwright_version: playwrightPackage.version ?? null,
    browser_gpu_mode: browserGpuMode,
    harness_source_sha256: harnessSourceHashes,
    failure_page_state: failurePageState,
    browser_route: browserRoute,
    error: bounded(error?.stack ?? error),
    page_errors: pageErrors,
    console_errors: consoleErrors,
    expected_console_errors: expectedConsoleErrors,
    request_failures: requestFailures,
    resource_responses: resourceResponses,
    http_errors: httpErrors,
    request_cancellations: requestCancellations,
    expected_response_drops: expectedResponseDrops,
    partial_proof: partialProof,
  }));
  process.exitCode = 1;
}
