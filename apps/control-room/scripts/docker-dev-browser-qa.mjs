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
const expectAmbiguousComputeFieldsSetting =
  process.env.CONTROL_ROOM_BROWSER_QA_EXPECT_AMBIGUOUS_COMPUTE_FIELDS ?? "0";
const expectAmbiguousComputeFields = expectAmbiguousComputeFieldsSetting === "1";
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
const httpErrors = [];
let harnessSourceHashes = null;
let failurePageState = null;
let browserRoute = null;
let partialProof = {};
const bounded = (value) => String(value).slice(0, 2048);
const collect = (target, value) => {
  if (target.length < 32) target.push(bounded(value));
};

const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const readHarnessSourceHashes = async () => ({
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
});
const sameHarnessSourceHashes = (left, right) =>
  Object.keys(left).every((key) => left[key] === right[key]);

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
  if (expectAirboxVectors && !expectedLiveField) {
    throw new Error("FDM airbox-vector expectation requires a live-field quantity");
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
  if (!canvasOnly && typeof PNG?.sync?.read !== "function") {
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
    const viewportDomBefore = await viewportDomObservation(page);
    const viewportDomObservations = {
      before_home: viewportDomBefore,
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
    const viewportDomAfter = await viewportDomObservation(page);
    viewportDomObservations.after_home = viewportDomAfter;
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
    if (pageErrors.length || consoleErrors.length || requestFailures.length || httpErrors.length) {
      throw new Error("Browser flow recorded page, console, transport, or HTTP failures");
    }

    const result = {
      schema: resultSchema,
      state: "passed",
      qa_scope: expectAmbiguousComputeFields ? "canvas-home-ambiguous-compute-fields" :
        expectAirboxVectors ? "canvas-home-live-field-airbox" :
        expectedLiveField ? "canvas-home-live-field" : canvasOnly ? "canvas-home-only" : "full-browser-qa",
      skipped_areas: canvasOnly ? canvasOnlySkippedAreas : [],
      public_url: publicUrl,
      probe_url: probeUrl,
      final_url: page.url(),
      playwright_version: playwrightPackage.version,
      browser_gpu_mode: browserGpuMode,
      canvas_only: canvasOnly,
      expect_live_field: expectedLiveField,
      expect_airbox_vectors: expectAirboxVectors,
      expect_ambiguous_compute_fields: expectAmbiguousComputeFields,
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
      ...(expectAmbiguousComputeFields ? {
        ambiguous_command_submission: ambiguousCommandSubmission,
        canvas_after_compute_fields: canvasAfterComputeFields,
      } : { ambiguous_command_submission: null }),
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
  console.log(JSON.stringify({
    schema: resultSchema,
    state: "failed",
    canvas_only: canvasOnly,
    expect_live_field: expectedLiveField,
    expect_airbox_vectors: expectAirboxVectors,
    expect_ambiguous_compute_fields: expectAmbiguousComputeFields,
    qa_scope: expectAmbiguousComputeFields ? "canvas-home-ambiguous-compute-fields" :
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
