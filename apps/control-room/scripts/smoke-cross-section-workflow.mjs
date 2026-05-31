import { inflateSync } from "node:zlib";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  null;

const WORKFLOW_TIMEOUT_MS = 20_000;
const CANVAS_SCREENSHOT_TIMEOUT_MS = 15_000;
const VISUALIZATION_STATE_PATH = "/v2/sessions/current/visualization/state";
const VISUALIZATION_CLIENT_ACKS_PATH =
  "/v2/sessions/current/visualization/client-acks";
const CROSS_SECTION_PATH =
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section";
const CROSS_SECTION_IMAGE_PATH =
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image";
const CROSS_SECTION_QUALITY_PATH =
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality";
const VIEWPORT_3D_REACT_MEASURE_NAMES = [
  "fullmag.react.render.Viewport3DModule.mount",
  "fullmag.react.render.Viewport3DModule.update",
];

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
  await import("./smoke-cross-section-workflow-cdp.mjs");
  process.exit(0);
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
const errors = [];
const fixtureRequests = [];
let visualizationState = visualizationStateFixture();

await installCrossSectionFixtureApi(page, fixtureRequests);
await installViewportTabLifecycleProbe(page);
await page.addInitScript(({ baseUrl }) => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    allowMissingSessionSmoke: true,
    ...(baseUrl ? { controlRoomApiBase: baseUrl } : {}),
  };
}, { baseUrl: apiBase ?? "http://localhost:8081" });

page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (isIgnorableConsoleError(text)) return;
  errors.push(text);
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("response", (response) => {
  const status = response.status();
  if (status < 400 || isAllowedMissingSessionResponse(response.url(), status)) {
    return;
  }
  errors.push(`${status} ${response.url()}`);
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const canvas3d = page.locator(".fm-viewport-3d canvas");
  await waitForWebGLCanvasReady(canvas3d, "3D viewport");
  const baseline3d = await sampleCanvasComposite(page, canvas3d, ".fm-viewport-3d");

  await page.getByRole("tab", { name: "View" }).first().click();
  const crossSectionAction = page.locator(
    '[data-action-id="ribbon.cross-section.begin-draft"]',
  );
  await crossSectionAction.waitFor({
    state: "visible",
    timeout: WORKFLOW_TIMEOUT_MS,
  });
  const draftRequestStart = fixtureRequests.length;
  await crossSectionAction.click();

  await waitForLocatorVisible(
    page.locator(`[data-node-id="${cssAttributeValue("model:visualizations-2d")}"]`),
    "Explorer Visualizations 2D branch",
  );
  await waitForLocatorVisible(
    page.locator(`[data-node-id="${cssAttributeValue("model:visualizations-2d:draft")}"]`),
    "Explorer cross-section draft row",
  );
  await waitForLocatorText(
    page.locator(".fm-inspector"),
    "Cut Frame",
    "Inspector cross-section draft editor",
  );
  await waitForCondition("2D Cross keeps canonical clip state disabled", () => {
    if (
      !visualizationState.clip.enabled &&
      visualizationState.clip.axis === "z" &&
      visualizationState.clip.position_percent === 50
    ) {
      return true;
    }
    throw new Error(
      `clip=${JSON.stringify(visualizationState.clip)}`,
    );
  });
  assertNoRequestsSince(
    draftRequestStart,
    "2D Cross draft",
    (request) => request.method === "PATCH" && request.path === VISUALIZATION_STATE_PATH,
    "canonical visualization PATCH requests",
  );
  assertNoRequestsSince(
    draftRequestStart,
    "2D Cross draft",
    (request) =>
      request.path === CROSS_SECTION_PATH ||
      request.path === CROSS_SECTION_QUALITY_PATH ||
      request.path === CROSS_SECTION_IMAGE_PATH,
    "cross-section data-plane requests before image generation",
  );
  await waitForCanvasCompositeChange(
    page,
    canvas3d,
    baseline3d,
    ".fm-viewport-3d",
    "3D cut-frame overlay renders after 2D Cross",
  );

  await fillInspectorInput(page, "Name", "Smoke 2D Cross");
  await fillInspectorInput(page, "Position", "62.5");
  await fillInspectorInput(page, "Rotation", "17");

  await page
    .locator(".fm-cross-section-inspector button")
    .filter({ hasText: "Generate Image" })
    .first()
    .click();

  await waitForLocatorVisible(
    page.locator(`[data-node-id="${cssAttributeValue("model:visualizations-2d:plot-1")}"]`),
    "Explorer saved cross-section plot",
  );
  for (const suffix of ["frame", "plane", "quality", "render"]) {
    await waitForLocatorVisible(
      page.locator(
        `[data-node-id="${cssAttributeValue(`model:visualizations-2d:plot-1:${suffix}`)}"]`,
      ),
      `Explorer saved cross-section ${suffix} row`,
    );
  }
  await waitForLocatorText(
    page.locator(`[data-node-id="${cssAttributeValue("model:visualizations-2d:plot-1:frame")}"]`),
    "Universe / 17 deg",
    "Explorer frame parameters",
  );
  await waitForLocatorText(
    page.locator(`[data-node-id="${cssAttributeValue("model:visualizations-2d:plot-1:plane")}"]`),
    "XY 62.5%",
    "Explorer plane parameters",
  );

  const crossSectionImage = page.locator(".fm-cross-section-image__img");
  await waitForLocatorVisible(crossSectionImage, "cross-section image");
  await waitForLocatorText(
    page.locator(".fm-cross-section-image"),
    "Smoke 2D Cross",
    "cross-section image surface",
  );
  const imageState = await crossSectionImage.evaluate((node) => ({
    complete: node.complete,
    naturalHeight: node.naturalHeight,
    naturalWidth: node.naturalWidth,
  }));
  if (!imageState.complete || imageState.naturalWidth <= 0 || imageState.naturalHeight <= 0) {
    throw new Error(`Cross-section PNG did not load: ${JSON.stringify(imageState)}`);
  }
  await assertNoViewport3DCanvas(page, "Cross-section image tab");
  const crossSectionImageActivityStart =
    await captureViewport3DActivityCheckpoint(page);
  const crossSectionImageRequestStart = fixtureRequests.length;
  await page.waitForTimeout(150);
  await assertNoViewport3DActivitySince({
    checkpoint: crossSectionImageActivityStart,
    label: "Cross-section image tab",
    page,
    requestStart: crossSectionImageRequestStart,
  });

  const imageRequest = fixtureRequests.find(
    (request) => request.path === CROSS_SECTION_IMAGE_PATH,
  );
  if (!imageRequest) {
    throw new Error("Cross-section image module did not request the PNG resource.");
  }
  const imageParams = new URLSearchParams(imageRequest.search);
  if (imageParams.get("rotation_degrees") !== "17") {
    throw new Error(
      `Cross-section PNG request did not include rotation_degrees=17: ${imageRequest.search}`,
    );
  }

  const analysisActivityStart = await captureViewport3DActivityCheckpoint(page);
  const non3dRequestStart = fixtureRequests.length;
  await page.getByRole("tab", { name: "Analysis" }).click();
  await waitForLocatorText(
    page.locator(".fm-analysis-plots"),
    "No scalar samples",
    "analysis tab",
  );
  await assertNoViewport3DCanvas(page, "Analysis tab");
  await assertNoViewport3DActivitySince({
    checkpoint: analysisActivityStart,
    label: "Analysis tab",
    page,
    requestStart: non3dRequestStart,
  });

  await page.getByRole("tab", { name: "3D Viewport" }).click();
  await waitForWebGLCanvasReady(canvas3d, "3D viewport after tab restore");

  const requestedPaths = new Set(fixtureRequests.map((request) => request.path));
  if (!requestedPaths.has(CROSS_SECTION_IMAGE_PATH)) {
    throw new Error("Cross-section image module did not request the PNG resource.");
  }
  if (errors.length > 0) {
    throw new Error(`Browser console/network errors:\n${errors.join("\n")}`);
  }

  console.log(
    [
      "Cross-section workflow smoke passed:",
      "ribbon=2D Cross",
      "3d=cut-frame",
      "explorer=draft+plot-1+parameters",
      "inspector=commit",
      "cross-section-image=png",
      "analysis=no-3d",
      "3d-lifecycle=inactive-tabs-clean",
      `requests=${fixtureRequests.length}`,
    ].join(" "),
  );
} finally {
  await browser.close();
}

async function installViewportTabLifecycleProbe(page) {
  await page.addInitScript((measureNames) => {
    window.__FULLMAG_REACT_PROFILER__ = true;
    const state = {
      measures: [],
      supportedEntryTypes:
        typeof PerformanceObserver === "undefined"
          ? []
          : PerformanceObserver.supportedEntryTypes ?? [],
    };
    window.__FULLMAG_VIEWPORT_TAB_LIFECYCLE__ = state;

    if (
      typeof PerformanceObserver === "undefined" ||
      !PerformanceObserver.supportedEntryTypes?.includes("measure")
    ) {
      return;
    }

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!measureNames.includes(entry.name)) continue;
          state.measures.push({
            duration: entry.duration,
            name: entry.name,
            startTime: entry.startTime,
          });
        }
      });
      observer.observe({ buffered: true, type: "measure" });
    } catch {
      // Browser support for buffered observers differs across Chromium versions.
    }
  }, VIEWPORT_3D_REACT_MEASURE_NAMES);
}

async function captureViewport3DActivityCheckpoint(page) {
  return page.evaluate((measureNames) => {
    const state = window.__FULLMAG_VIEWPORT_TAB_LIFECYCLE__ ?? {
      measures: [],
      supportedEntryTypes: [],
    };
    const measureEntries = performance
      .getEntriesByType("measure")
      .filter((entry) => measureNames.includes(entry.name))
      .map((entry) => ({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      }));
    const measures = dedupePerformanceRows([
      ...state.measures,
      ...measureEntries,
    ]);

    return {
      lastMeasureStartTime: Math.max(
        0,
        ...measures.map((entry) => entry.startTime),
      ),
      measureCount: measures.length,
      measures,
      supportedEntryTypes: state.supportedEntryTypes,
    };

    function dedupePerformanceRows(rows) {
      const seen = new Set();
      return rows.filter((row) => {
        const key = `${row.name}:${row.startTime}:${row.duration}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }, VIEWPORT_3D_REACT_MEASURE_NAMES);
}

async function assertNoViewport3DActivitySince({
  checkpoint,
  label,
  page,
  requestStart,
}) {
  assertNo3DResourceRequestsSince(requestStart, label);
  assertNoVisualizationClientAcksSince(requestStart, label);
  const current = await captureViewport3DActivityCheckpoint(page);
  const newMeasures = current.measures.filter(
    (entry) => entry.startTime > checkpoint.lastMeasureStartTime + 0.01,
  );
  if (newMeasures.length > 0) {
    throw new Error(
      `${label} rendered Viewport3DModule while inactive: ${newMeasures
        .map((entry) => `${entry.name}@${entry.startTime.toFixed(1)}`)
        .join(", ")}`,
    );
  }
}

async function installCrossSectionFixtureApi(page, requests) {
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    requests.push({ method: request.method(), path, search: requestUrl.search });

    if (request.method() === "OPTIONS") {
      await fulfillEmpty(route, 204);
      return;
    }

    if (path === "/v2/sessions/current/status") {
      await fulfillJson(route, statusFixture());
      return;
    }
    if (path === VISUALIZATION_STATE_PATH) {
      if (request.method() === "PATCH") {
        visualizationState = applyVisualizationPatch(
          visualizationState,
          parseRequestJson(request),
        );
      }
      await fulfillJson(route, visualizationState);
      return;
    }
    if (path === "/v2/sessions/current/data/domain/meta") {
      await fulfillJson(route, femDomainMetaFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/topology") {
      await fulfillBinary(route, makeTopologyBuffer(), '"topology-fixture"');
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      await fulfillJson(route, { objects: [], revision: 0, schema_version: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/universe") {
      await fulfillJson(route, universeFixture());
      return;
    }
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
      await fulfillJson(route, sharedDomainManifestFixture());
      return;
    }
    if (path === CROSS_SECTION_IMAGE_PATH) {
      await fulfillBinary(
        route,
        makeCrossSectionPngBuffer(),
        '"cross-section-image-fixture"',
        200,
        "image/png",
      );
      return;
    }
    if (path === CROSS_SECTION_PATH) {
      await fulfillBinary(route, makeCrossSectionBuffer(), '"cross-section-fixture"');
      return;
    }
    if (path === CROSS_SECTION_QUALITY_PATH) {
      await fulfillBinary(
        route,
        makeCrossSectionQualityBuffer(),
        '"cross-section-quality-fixture"',
      );
      return;
    }

    await fulfillEmpty(route, 204);
  });
}

async function waitForWebGLCanvasReady(canvas, label) {
  await canvas.waitFor({ state: "visible", timeout: WORKFLOW_TIMEOUT_MS });
  await canvas.evaluate(
    (node, label) =>
      new Promise((resolve, reject) => {
        const deadline = performance.now() + 5_000;
        const tick = () => {
          const rect = node.getBoundingClientRect();
          const gl = node.getContext("webgl2") ?? node.getContext("webgl");
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            gl &&
            !gl.isContextLost() &&
            gl.drawingBufferWidth > 0 &&
            gl.drawingBufferHeight > 0
          ) {
            resolve(undefined);
            return;
          }
          if (performance.now() > deadline) {
            reject(
              new Error(
                `${label} WebGL canvas is not ready: ${rect.width}x${rect.height}, drawingBuffer=${gl?.drawingBufferWidth ?? 0}x${gl?.drawingBufferHeight ?? 0}, contextLost=${gl?.isContextLost?.() ?? "no-context"}`,
              ),
            );
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      }),
    label,
  );
}

async function waitForCanvasCompositeChange(
  page,
  canvas,
  baseline,
  viewportSelector,
  label,
) {
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
  let lastDelta = null;
  while (Date.now() <= deadline) {
    const current = await sampleCanvasComposite(page, canvas, viewportSelector);
    const delta = canvasCompositeDifference(baseline, current);
    if (current.nonBlank && delta.changed) return current;
    lastDelta = delta;
    await page.waitForTimeout(100);
  }

  const suffix = lastDelta
    ? `${lastDelta.changedPixels}/${lastDelta.sampledPixels} sampled pixels changed; threshold=${lastDelta.minimumChangedPixels}`
    : "no canvas sample was collected";
  throw new Error(`${label} timed out: ${suffix}.`);
}

async function assertNoViewport3DCanvas(page, label) {
  const state = await page.evaluate(() => ({
    canvasCount: document.querySelectorAll(".fm-viewport-3d canvas").length,
    viewportCount: document.querySelectorAll(".fm-viewport-3d").length,
  }));
  if (state.viewportCount > 0 || state.canvasCount > 0) {
    throw new Error(
      `${label} still has a 3D viewport mounted: ${JSON.stringify(state)}`,
    );
  }
}

function assertNo3DResourceRequestsSince(startIndex, label) {
  const unexpected = fixtureRequests
    .slice(startIndex)
    .filter((request) => is3DOnlyResourcePath(request.path));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} triggered 3D-only resources: ${unexpected.map(formatRequest).join(", ")}`,
    );
  }
}

function assertNoVisualizationClientAcksSince(startIndex, label) {
  const unexpected = fixtureRequests
    .slice(startIndex)
    .filter((request) => request.path === VISUALIZATION_CLIENT_ACKS_PATH);
  if (unexpected.length > 0) {
    throw new Error(
      `${label} emitted 3D visualization client acks: ${unexpected
        .map(formatRequest)
        .join(", ")}`,
    );
  }
}

function assertNoRequestsSince(startIndex, label, predicate, description) {
  const unexpected = fixtureRequests.slice(startIndex).filter(predicate);
  if (unexpected.length > 0) {
    throw new Error(
      `${label} triggered ${description}: ${unexpected.map(formatRequest).join(", ")}`,
    );
  }
}

function is3DOnlyResourcePath(path) {
  return (
    path === "/v2/sessions/current/data/domain/meta" ||
    path === "/v2/sessions/current/data/domain/topology" ||
    path === "/v2/sessions/current/model/scene" ||
    path === "/v2/sessions/current/model/universe" ||
    path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest" ||
    path.startsWith("/v2/sessions/current/data/fields")
  );
}

function formatRequest(request) {
  return `${request.method} ${request.path}${request.search ?? ""}`;
}

async function sampleCanvasComposite(page, canvas, viewportSelector) {
  const box = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
  });
  if (box.width <= 0 || box.height <= 0) {
    throw new Error(
      `Canvas has no measurable bounding box: ${box.width}x${box.height}.`,
    );
  }

  const background = await page.locator(viewportSelector).evaluate((node) =>
    getComputedStyle(node).backgroundColor,
  );
  const backgroundRgb = parseCssRgb(background);
  const png = await withTimeout(
    page.screenshot({
      clip: {
        height: Math.max(1, Math.floor(box.height)),
        width: Math.max(1, Math.floor(box.width)),
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
      },
    }),
    CANVAS_SCREENSHOT_TIMEOUT_MS,
    "canvas composite screenshot",
  );
  const bitmap = parsePng(png);
  const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
  const signature = [];
  let sampledPixels = 0;
  let variedPixels = 0;

  for (let y = 0; y < bitmap.height; y += stride) {
    for (let x = 0; x < bitmap.width; x += stride) {
      sampledPixels += 1;
      const offset = (y * bitmap.width + x) * 4;
      const rgb = [
        bitmap.rgba[offset],
        bitmap.rgba[offset + 1],
        bitmap.rgba[offset + 2],
      ];
      signature.push(...rgb);
      if (pixelDiffers(rgb, backgroundRgb)) variedPixels += 1;
    }
  }

  return {
    nonBlank: variedPixels > 0,
    sampledPixels,
    signature,
    variedPixels,
  };
}

function canvasCompositeDifference(before, after) {
  const length = Math.min(before.signature.length, after.signature.length);
  let changedPixels = 0;
  for (let offset = 0; offset < length; offset += 3) {
    const delta =
      Math.abs(before.signature[offset] - after.signature[offset]) +
      Math.abs(before.signature[offset + 1] - after.signature[offset + 1]) +
      Math.abs(before.signature[offset + 2] - after.signature[offset + 2]);
    if (delta > 18) changedPixels += 1;
  }

  const sampledPixels = Math.floor(length / 3);
  const minimumChangedPixels = Math.max(6, Math.floor(sampledPixels * 0.003));
  return {
    changed: changedPixels >= minimumChangedPixels,
    changedPixels,
    minimumChangedPixels,
    sampledPixels,
  };
}

async function fillInspectorInput(page, label, value) {
  const input = page
    .locator(`.fm-cross-section-inspector input[aria-label="${cssAttributeValue(label)}"]`)
    .first();
  await input.waitFor({ state: "visible", timeout: WORKFLOW_TIMEOUT_MS });
  await input.fill("", { force: true });
  await input.fill(value, { force: true });
  await input.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.blur();
  });
}

async function waitForLocatorVisible(locator, label) {
  await locator.waitFor({ state: "visible", timeout: WORKFLOW_TIMEOUT_MS }).catch(
    (error) => {
      throw new Error(`${label} was not visible: ${error.message}`);
    },
  );
}

async function waitForLocatorText(locator, expectedText, label) {
  await waitForCondition(label, async () => {
    const text = await locator.textContent().catch(() => "");
    if (text?.includes(expectedText)) return text;
    throw new Error(`text=${text ?? ""}`);
  });
}

async function waitForCondition(label, predicate) {
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`${label} timed out after ${WORKFLOW_TIMEOUT_MS}ms.${suffix}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: fixtureHeaders({ "content-type": "application/json" }),
    status,
  });
}

async function fulfillBinary(
  route,
  arrayBuffer,
  etag,
  status = 200,
  contentType = "application/octet-stream",
) {
  await route.fulfill({
    body: Buffer.from(arrayBuffer),
    headers: fixtureHeaders({
      "content-type": contentType,
      etag,
    }),
    status,
  });
}

async function fulfillEmpty(route, status = 204) {
  await route.fulfill({
    body: "",
    headers: fixtureHeaders(),
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

function parseRequestJson(request) {
  const body = request.postData();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function applyVisualizationPatch(state, patch) {
  const next = {
    ...state,
    revision: state.revision + 1,
  };
  if (patch.clip && typeof patch.clip === "object") {
    next.clip = { ...state.clip, ...withoutUndefined(patch.clip) };
  }
  if (patch.slice && typeof patch.slice === "object") {
    next.slice = { ...state.slice, ...withoutUndefined(patch.slice) };
  }
  if (patch.quantity && typeof patch.quantity === "object") {
    next.quantity = { ...state.quantity, ...withoutUndefined(patch.quantity) };
  }
  for (const key of [
    "active_quantity_id",
    "auto_contrast",
    "colormap",
    "contrast_max",
    "contrast_min",
    "field_component",
    "max_points",
    "slice_layer",
    "slice_mode",
    "vector_density",
    "vector_glyphs",
    "view_mode",
    "x_chosen_size",
    "y_chosen_size",
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      next[key] = patch[key];
    }
  }
  return next;
}

function withoutUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function statusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: false,
      eigen_modes: false,
      explicit_topology: true,
      gpu_telemetry: false,
      node_fields: true,
      preview_2d: true,
      preview_3d: true,
      scalar_history: false,
      structured_grid: false,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 120000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 0,
      vector_glyphs: false,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: 1,
      discretization: "fem",
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
      display_revision: 1,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 0,
      field_revision: 0,
      fields_revision: 0,
      mesh_build_revision: 1,
      mesh_revision: 1,
      scalars_revision: 0,
      scene_revision: 0,
      slice_revision: 1,
      stages_revision: 0,
      topology_revision: 1,
      visualization_state_revision: visualizationState.revision,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "cross-section-smoke-fixture",
    session: {
      created_at: "0",
      name: "cross-section-smoke-fixture",
      session_id: "cross-section-fixture",
      workspace_root: "/tmp/fullmag-cross-section-fixture",
    },
    solver: {
      state: "idle",
    },
  };
}

function femDomainMetaFixture() {
  return {
    bounds: {
      max: [1.0e-6, 8.0e-7, 3.0e-7],
      min: [-1.0e-6, -8.0e-7, -3.0e-7],
    },
    coordinate_system: "cartesian",
    counts: { cells: 1 },
    dimension: 3,
    discretization: "fem",
    domain_id: "cross-section-fem-domain",
    generation_id: 1,
    grid: null,
    units: { length: "m" },
  };
}

function universeFixture() {
  return {
    mesh_dirty: false,
    object_bounds_max: [1.0e-6, 8.0e-7, 3.0e-7],
    object_bounds_min: [-1.0e-6, -8.0e-7, -3.0e-7],
    scene_revision: 0,
    study_universe_mesh: null,
    universe: {
      bounds_max: [1.0e-6, 8.0e-7, 3.0e-7],
      bounds_min: [-1.0e-6, -8.0e-7, -3.0e-7],
    },
  };
}

function sharedDomainManifestFixture() {
  return {
    domain_mesh_mode: "shared_domain",
    generation_id: "cross-section-fixture",
    mesh_id: "shared-domain",
    mesh_name: "Shared-domain FEM mesh",
    mesh_parts: [
      {
        boundary_face_count: 4,
        boundary_face_indices: [0, 1, 2, 3],
        boundary_face_start: 0,
        bounds_max: [1.0e-6, 8.0e-7, 3.0e-7],
        bounds_min: [-1.0e-6, -8.0e-7, -3.0e-7],
        element_count: 1,
        element_start: 0,
        geometry_id: "body_geom",
        id: "part-body",
        label: "Body",
        material_id: "material-1",
        node_count: 4,
        node_indices: [0, 1, 2, 3],
        node_start: 0,
        object_id: "body",
        role: "magnetic",
        surface_faces: [
          [0, 1, 2],
          [0, 1, 3],
          [0, 2, 3],
          [1, 2, 3],
        ],
      },
    ],
    object_segments: [],
    regions: [],
    revision: 1,
    source_scene_revision: 0,
  };
}

function visualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [1.8e-6, 1.4e-6, 1.1e-6],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: {
      axis: "z",
      enabled: false,
      flipped: false,
      position_percent: 50,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: {
      active_scope: "domain",
      object_id: null,
      part_id: null,
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
      airbox: {
        bounds: { opacity: 1, visible: false },
        opacity: 0.18,
        points: { opacity: 1, visible: false },
        surface: { opacity: 0.18, visible: false },
        vectors: { density: 0, domain: "full_domain", visible: false },
        visible: false,
        wireframe: { opacity: 1, visible: false },
      },
      bounds: { opacity: 1, visible: true },
      points: { opacity: 1, visible: false },
      primitives: { opacity: 1, visible: true },
      quantity_overlay: { opacity: 1, visible: false },
      surface: { opacity: 0.92, visible: true },
      vectors: { density: 0, domain: "full_domain", visible: false },
      volume_mesh: { opacity: 1, visible: false },
      wireframe: { opacity: 1, visible: true },
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
      max_bytes: null,
      max_glyphs: 0,
      max_points: 120000,
      profile: "interactive",
      progressive: true,
    },
    schema_version: 1,
    slice: {
      airbox_render_mode: "zero",
      auto_contrast: true,
      axis: "z",
      colormap: "viridis",
      component: "magnitude",
      layer_index: 0,
      mesh_color_scale: "jet",
      mesh_filter_expression: "",
      mesh_quality_metric: "skewness",
      mesh_shrink_factor: 1,
      mode: "plane",
      position_percent: 50,
      projection_include_air_as_zero: false,
      projection_reduction: "mean",
      projection_resolution: 256,
      projection_samples: 32,
      quantity_id: "m",
      render_mode: "mesh_quality",
      show_airbox: false,
      show_airbox_vectors: false,
      show_magnetic_texture: false,
      show_mesh: true,
      show_primitives: true,
      show_quantity: false,
      show_vectors: false,
    },
    slice_layer: 0,
    slice_mode: "xy",
    targets: {
      airbox: {
        id: "airbox",
        label: "Airbox",
        parts: [],
        source: "airbox",
      },
      objects: [],
      parts: [],
    },
    trim: {
      axes: {
        x: { max: 1, min: 0 },
        y: { max: 1, min: 0 },
        z: { max: 1, min: 0 },
      },
      enabled: false,
    },
    vector_density: 0,
    vector_glyphs: false,
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

function makeTopologyBuffer() {
  const nodeCount = 4;
  const elementCount = 1;
  const boundaryFaceCount = 4;
  const markerCount = 1;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, markerCount, true);
  view.setUint32(24, boundaryFaceCount, true);

  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    -1.0e-6, -8.0e-7, -3.0e-7,
    1.0e-6, -8.0e-7, -3.0e-7,
    -1.0e-6, 8.0e-7, -3.0e-7,
    0, 0, 3.0e-7,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 4).set([0, 1, 2, 3]);
  offset += 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount * 3).set([
    0, 1, 2,
    0, 1, 3,
    0, 2, 3,
    1, 2, 3,
  ]);
  offset += boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([1]);
  offset += Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount).set([1, 1, 1, 1]);
  return buffer;
}

function makeCrossSectionBuffer() {
  const polygonCount = 1;
  const vertexCount = 4;
  const segmentCount = 4;
  const metadataVertexCount = vertexCount;
  const byteLength =
    64 +
    vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT +
    (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT +
    polygonCount * Uint32Array.BYTES_PER_ELEMENT +
    segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT +
    metadataVertexCount * 3 * Float32Array.BYTES_PER_ELEMENT +
    metadataVertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT +
    metadataVertexCount * Float32Array.BYTES_PER_ELEMENT +
    metadataVertexCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMCS"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint32(4, 2, true);
  view.setUint32(8, polygonCount, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, segmentCount, true);
  view.setUint32(20, polygonCount, true);
  view.setUint32(24, metadataVertexCount, true);
  view.setUint32(28, 1, true);
  view.setFloat64(32, -4.0e-7, true);
  view.setFloat64(40, 4.0e-7, true);
  view.setFloat64(48, -3.0e-7, true);
  view.setFloat64(56, 3.0e-7, true);

  let offset = 64;
  new Float32Array(buffer, offset, vertexCount * 2).set([
    -4.0e-7, -3.0e-7,
    4.0e-7, -3.0e-7,
    4.0e-7, 3.0e-7,
    -4.0e-7, 3.0e-7,
  ]);
  offset += vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount + 1).set([0, 4]);
  offset += (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount).set([8]);
  offset += polygonCount * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, segmentCount * 4).set([
    -4.0e-7, -3.0e-7, 4.0e-7, -3.0e-7,
    4.0e-7, -3.0e-7, 4.0e-7, 3.0e-7,
    4.0e-7, 3.0e-7, -4.0e-7, 3.0e-7,
    -4.0e-7, 3.0e-7, -4.0e-7, -3.0e-7,
  ]);
  offset += segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, metadataVertexCount * 3).set([
    -4.0e-7, -3.0e-7, 0,
    4.0e-7, -3.0e-7, 0,
    4.0e-7, 3.0e-7, 0,
    -4.0e-7, 3.0e-7, 0,
  ]);
  offset += metadataVertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, metadataVertexCount * 2).set([
    0, 1,
    1, 3,
    2, 3,
    0, 2,
  ]);
  offset += metadataVertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, metadataVertexCount).set([0.5, 0.5, 0.5, 0.5]);
  offset += metadataVertexCount * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, metadataVertexCount).set([1, 0, 0, 0]);
  return buffer;
}

function makeCrossSectionQualityBuffer() {
  const valueCount = 1;
  const buffer = new ArrayBuffer(20 + valueCount * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMQS"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint32(4, 1, true);
  view.setUint32(8, valueCount, true);
  view.setFloat32(12, 0.18, true);
  view.setFloat32(16, 0.18, true);
  new Float32Array(buffer, 20, valueCount).set([0.18]);
  return buffer;
}

function makeCrossSectionPngBuffer() {
  const buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAGElEQVR42mP8z8BQz0AEYBxVSFUBAA2TAYPdiun8AAAAAElFTkSuQmCC",
    "base64",
  );
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function parsePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Screenshot is not a PNG image.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(
      `Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const sourceStride = width * bytesPerPixel;
  const targetStride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(sourceStride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++];
    const scanline = Buffer.from(
      raw.subarray(sourceOffset, sourceOffset + sourceStride),
    );
    sourceOffset += sourceStride;
    unfilterScanline(scanline, previous, filter, bytesPerPixel);
    if (colorType === 6) {
      scanline.copy(rgba, y * targetStride);
    } else {
      for (let x = 0; x < width; x += 1) {
        const source = x * 3;
        const target = y * targetStride + x * 4;
        rgba[target] = scanline[source];
        rgba[target + 1] = scanline[source + 1];
        rgba[target + 2] = scanline[source + 2];
        rgba[target + 3] = 255;
      }
    }
    previous = scanline;
  }

  return { height, rgba, width };
}

function unfilterScanline(scanline, previous, filter, bytesPerPixel) {
  for (let index = 0; index < scanline.length; index += 1) {
    const left = index >= bytesPerPixel ? scanline[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    let value = scanline[index];
    if (filter === 1) {
      value = (value + left) & 0xff;
    } else if (filter === 2) {
      value = (value + up) & 0xff;
    } else if (filter === 3) {
      value = (value + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      value = (value + paethPredictor(left, up, upLeft)) & 0xff;
    } else if (filter !== 0) {
      throw new Error(`Unsupported PNG filter: ${filter}`);
    }
    scanline[index] = value;
  }
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function parseCssRgb(value) {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return [0, 0, 0];
  const channels = match[1].split(",").map((channel) => Number(channel.trim()));
  return [
    Number.isFinite(channels[0]) ? channels[0] : 0,
    Number.isFinite(channels[1]) ? channels[1] : 0,
    Number.isFinite(channels[2]) ? channels[2] : 0,
  ];
}

function pixelDiffers(rgb, backgroundRgb) {
  return rgb.some((channel, index) => Math.abs(channel - backgroundRgb[index]) > 8);
}

function cssAttributeValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isIgnorableConsoleError(text) {
  return (
    text === "Failed to load resource: the server responded with a status of 404 (Not Found)" ||
    (text.includes("/v2/sessions/current/events/ws") &&
      (text.includes("Unexpected response code: 404") ||
        text.includes("Unexpected response code: 204") ||
        text.includes("net::ERR_CONNECTION_REFUSED")))
  );
}

function isAllowedMissingSessionResponse(responseUrl, status) {
  if (status !== 404) return false;
  try {
    return new URL(responseUrl).pathname.startsWith("/v2/sessions/current/");
  } catch {
    return false;
  }
}
