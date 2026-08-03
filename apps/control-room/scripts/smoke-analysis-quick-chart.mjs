import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const timeout = 120_000;
const useFixture =
  process.env.CONTROL_ROOM_ANALYSIS_QUICK_CHART_FIXTURE !== "0";
const acceptanceDirectory =
  process.env.CONTROL_ROOM_ACCEPTANCE_DIR ??
  path.resolve(".fullmag/reports/live-charts-analysis-acceptance/latest");
const FIELD_PATTERN = /\/v2\/sessions\/current\/data\/fields(?:\/|\?|$)/;
const TOPOLOGY_PATTERN =
  /\/v2\/sessions\/current\/(?:data\/domain\/topology|meshing\/meshes\/[^/]+\/topology)(?:\?|$)/;
const VISUALIZATION_PATTERN =
  /\/v2\/sessions\/current\/visualization\/state(?:\?|$)/;

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) throw new Error("Playwright is required.");
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const tableRequests = [];
  const tableResponses = [];
  const fieldRequests = [];
  const topologyRequests = [];
  const visualizationRequests = [];
  const pageErrors = [];

  await installQuickChartDiagnostics(page);
  if (useFixture) await installQuickChartFixtureRoutes(page);
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/v2/sessions/current/data/tables/")) {
      tableRequests.push(url);
    }
    if (FIELD_PATTERN.test(url)) fieldRequests.push(url);
    if (TOPOLOGY_PATTERN.test(url)) topologyRequests.push(url);
    if (VISUALIZATION_PATTERN.test(url)) visualizationRequests.push(url);
  });
  page.on("response", (response) => {
    if (response.url().includes("/v2/sessions/current/data/tables/")) {
      tableResponses.push({
        contentType: response.headers()["content-type"] ?? null,
        status: response.status(),
        url: response.url(),
      });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout });
    await page.locator("main").waitFor({ state: "visible", timeout });
    await openAnalysisAndPinExplicitDataset(page);
    await viewportTab(page, "3D Viewport").click();
    const viewport = page.locator(".fm-viewport-3d");
    await viewport.waitFor({ state: "visible", timeout });
    await waitForHealthyWebGl(page);
    await waitForViewportQuiet(page);

    const before = await snapshotQuickChartAndViewport(page, {
      fieldRequests,
      topologyRequests,
      visualizationRequests,
    });
    await openQuickChartFooter(page);
    await waitForQuickChart(page, tableRequests, tableResponses, pageErrors);
    await verifyExactQuickChartValuesAndUnits(page);
    await verifyExactQuickChartRange(page);
    const afterOpen = await snapshotQuickChartAndViewport(page, {
      fieldRequests,
      topologyRequests,
      visualizationRequests,
    });
    assertQuickChartDoesNotMutateViewport(before, afterOpen);

    await exerciseQuickChartLifecycle(page, before.lifecycle);
    await openQuickChartFooter(page);
    await waitForQuickChart(page, tableRequests, tableResponses, pageErrors);
    const screenshots = await captureQuickChartAcceptanceScreenshots(page);
    const finalWebGlProof = await readWebGlProof(page);
    if (
      finalWebGlProof.contextLost ||
      finalWebGlProof.drawingBufferWidth <= 0 ||
      finalWebGlProof.drawingBufferHeight <= 0
    ) {
      throw new Error(
        `3D WebGL is unhealthy after returning from Quick Chart lifecycle: ${JSON.stringify(finalWebGlProof)}`,
      );
    }
    if (pageErrors.length > 0) {
      throw new Error(`Browser errors: ${JSON.stringify(pageErrors)}`);
    }
    const proof = await snapshotQuickChartAndViewport(page, {
      fieldRequests,
      topologyRequests,
      visualizationRequests,
    });
    console.log(
      `Analysis Quick Chart smoke passed: ${JSON.stringify({
        finalWebGlProof,
        proof,
        screenshots,
        tableRequests: tableRequests.length,
      })}`,
    );
  } finally {
    await browser.close();
  }
}

async function installQuickChartDiagnostics(page) {
  await page.addInitScript(({ baseUrl, useFixture }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: useFixture,
      controlRoomApiBase: baseUrl,
      diagnosticRecorderProfile: "viewport-3d",
      diagnosticRecorderScenario: "analysis-quick-chart",
      disableRealtime: useFixture,
      enableDiagnosticRecorder: true,
    };
    window.__FULLMAG_ENABLE_CHART_DIAGNOSTICS__ = true;
    const lifecycle = {
      activeInstances: 0,
      activeObservers: 0,
      animationFrameCount: 0,
      createdInstances: 0,
      disposedInstances: 0,
      listenerCount: 0,
    };
    window.__FULLMAG_QUICK_CHART_LIFECYCLE__ = lifecycle;

    const NativeResizeObserver = window.ResizeObserver;
    if (NativeResizeObserver) {
      window.ResizeObserver = class extends NativeResizeObserver {
        disconnected = false;
        quickChartObserver = false;
        constructor(callback) {
          super(callback);
        }
        observe(target, options) {
          if (
            !this.quickChartObserver &&
            target instanceof Element &&
            target.closest(".fm-quick-chart")
          ) {
            this.quickChartObserver = true;
            lifecycle.activeObservers += 1;
          }
          super.observe(target, options);
        }
        disconnect() {
          if (!this.disconnected && this.quickChartObserver) {
            this.disconnected = true;
            lifecycle.activeObservers = Math.max(0, lifecycle.activeObservers - 1);
          }
          super.disconnect();
        }
      };
    }

    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    const activeFrames = new Set();
    window.requestAnimationFrame = (callback) => {
      let handle = 0;
      handle = nativeRequestAnimationFrame((time) => {
        activeFrames.delete(handle);
        lifecycle.animationFrameCount = activeFrames.size;
        callback(time);
      });
      activeFrames.add(handle);
      lifecycle.animationFrameCount = activeFrames.size;
      return handle;
    };
    window.cancelAnimationFrame = (handle) => {
      activeFrames.delete(handle);
      lifecycle.animationFrameCount = activeFrames.size;
      nativeCancelAnimationFrame(handle);
    };

    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const quickListenerTargets = new WeakSet();
    EventTarget.prototype.addEventListener = function (...args) {
      if (this instanceof Element && this.closest(".fm-quick-chart")) {
        quickListenerTargets.add(this);
        lifecycle.listenerCount += 1;
      }
      return nativeAdd.apply(this, args);
    };
    EventTarget.prototype.removeEventListener = function (...args) {
      if (quickListenerTargets.has(this)) {
        lifecycle.listenerCount = Math.max(0, lifecycle.listenerCount - 1);
      }
      return nativeRemove.apply(this, args);
    };

    const quickCanvases = new Set();
    const scanQuickChartCanvases = () => {
      const current = new Set(
        document.querySelectorAll(".fm-quick-chart__canvas canvas"),
      );
      for (const canvas of current) {
        if (!quickCanvases.has(canvas)) lifecycle.createdInstances += 1;
      }
      for (const canvas of quickCanvases) {
        if (!current.has(canvas)) lifecycle.disposedInstances += 1;
      }
      quickCanvases.clear();
      for (const canvas of current) quickCanvases.add(canvas);
      lifecycle.activeInstances = quickCanvases.size;
    };
    new MutationObserver(scanQuickChartCanvases).observe(document, {
      childList: true,
      subtree: true,
    });

    window.__FULLMAG_READ_VIEWPORT_3D_DIAGNOSTICS__ = () => {
      const artifact = window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.();
      const viewportRecords = artifact?.streams?.viewport3d ?? [];
      const requestRecords = artifact?.streams?.requests ?? [];
      const dirtyFrames = requestRecords.filter(
        (record) => record.path === "fullmag.viewport3d.frame-window",
      ).length;
      const gpuUploads = [
        ...(artifact?.streams?.viewport3dBuild ?? []),
        ...viewportRecords,
      ].filter((record) => /gpu|upload/i.test(JSON.stringify(record))).length;
      return { dirtyFrames, gpuUploads, viewportRecords: viewportRecords.length };
    };
  }, { baseUrl: apiBase, useFixture });
}

async function installQuickChartFixtureRoutes(page) {
  const revision = 1;
  const columns = [
    { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
    { column_id: "mx", component: "x", dimension: "dimensionless", label: "mx", quantity_id: "mx", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "my", component: "y", dimension: "dimensionless", label: "my", quantity_id: "my", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "mz", component: "z", dimension: "dimensionless", label: "mz", quantity_id: "mz", reduction: "mean", unit: "1", value_type: "float" },
  ];
  const table = {
    binary_rows_href: "/v2/sessions/current/data/tables/default/rows.bin",
    columns: [],
    columns_href: "/v2/sessions/current/data/tables/default/columns",
    revision,
    rows_href: "/v2/sessions/current/data/tables/default/rows",
    schema_revision: 1,
    table_id: "default",
    total_rows: 2,
  };
  const visualizationState = quickChartVisualizationStateFixture();
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = fixtureHeaders();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ body: "", headers, status: 204 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/status") {
      await route.fulfill({
        body: JSON.stringify(quickChartStatusFixture()),
        contentType: "application/json",
        headers,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/visualization/state") {
      await route.fulfill({
        body: JSON.stringify(visualizationState),
        contentType: "application/json",
        headers,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/domain/meta") {
      await route.fulfill({
        body: JSON.stringify(quickChartDomainMetaFixture()),
        contentType: "application/json",
        headers,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/model/scene") {
      await route.fulfill({
        body: JSON.stringify({ objects: [], revision: 0, schema_version: 1 }),
        contentType: "application/json",
        headers,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/model/universe") {
      await route.fulfill({
        body: JSON.stringify({
          mesh_dirty: false,
          object_bounds_max: [1, 1, 0.25],
          object_bounds_min: [-1, -1, -0.25],
          scene_revision: 0,
          study_universe_mesh: null,
          universe: null,
        }),
        contentType: "application/json",
        headers,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables") {
      await route.fulfill({ body: JSON.stringify({ revision, tables: [table] }), contentType: "application/json", headers, status: 200 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables/default") {
      await route.fulfill({ body: JSON.stringify(table), contentType: "application/json", headers, status: 200 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables/default/columns") {
      await route.fulfill({ body: JSON.stringify(columns), contentType: "application/json", headers, status: 200 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables/default/rows.bin") {
      const requestedColumns = (url.searchParams.get("columns") ?? "")
        .split(",")
        .filter(Boolean);
      await route.fulfill({
        body: makeRowsFixture(requestedColumns, 2),
        contentType: "application/vnd.fullmag.table-rows.v1+octet-stream",
        headers,
        status: 200,
      });
      return;
    }
    if (/^\/v2\/sessions\/current\/data\/fields\/[^/]+\/samples\/vector$/.test(url.pathname)) {
      await route.fulfill({
        body: Buffer.from(makeFdmFieldVectorBuffer("m")),
        contentType: "application/octet-stream",
        headers,
        status: 200,
      });
      return;
    }
    await route.fulfill({ body: "", headers, status: 204 });
  });
}

function fixtureHeaders() {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
  };
}

function quickChartStatusFixture() {
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
      scalar_history: true,
      structured_grid: true,
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
      vector_density: 2,
      vector_glyphs: false,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: { cell_count: 4, discretization: "fdm", generation_id: 1 },
    energies: {},
    metrics: { steps_per_second: null, total_steps: 0, uptime_seconds: 0 },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: 1,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 1,
      field_revision: 1,
      fields_revision: 1,
      mesh_build_revision: 0,
      mesh_revision: 0,
      scalars_revision: 1,
      scene_revision: 0,
      slice_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: 1,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "analysis-quick-chart-fixture",
    session: {
      created_at: "0",
      name: "analysis-quick-chart-fixture",
      session_id: "analysis-quick-chart-fixture",
      workspace_root: "/tmp/fullmag-analysis-quick-chart-fixture",
    },
    solver: { state: "idle" },
  };
}

function quickChartVisualizationStateFixture() {
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
    sampling: { max_glyphs: 192, max_points: 120000 },
    schema_version: 1,
    slice: { layer: 0, mode: "xy" },
    slice_layer: 0,
    slice_mode: "xy",
    trim: { enabled: false, max: [1, 1, 1], min: [0, 0, 0] },
    vector_density: 2,
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

function quickChartDomainMetaFixture() {
  return {
    bounds: { max: [1, 1, 0.25], min: [-1, -1, -0.25] },
    coordinate_system: "cartesian",
    counts: { cells: 4 },
    dimension: 3,
    discretization: "fdm",
    domain_id: "analysis-quick-chart-domain",
    generation_id: 1,
    grid: { origin: [-1, -1, -0.25], shape: [2, 2, 1], spacing: [1, 1, 0.5] },
    units: { length: "m" },
  };
}

function makeFdmFieldVectorBuffer(quantityId) {
  const shape = [2, 2, 1];
  const valueCount = shape[0] * shape[1] * shape[2] * 3;
  const buffer = new ArrayBuffer(48 + valueCount * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, shape[0], true);
  view.setUint32(20, shape[1], true);
  view.setUint32(24, shape[2], true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));
  const values = new Float64Array(buffer, 48);
  for (let offset = 0; offset < values.length; offset += 3) {
    values[offset] = 0.97982;
    values[offset + 1] = 0.10317;
    values[offset + 2] = 4.447e-6;
  }
  return buffer;
}

async function openAnalysisAndPinExplicitDataset(page) {
  await viewportTab(page, "Analysis").click();
  const trigger = page.getByRole("combobox", { name: "Analysis dataset" });
  await trigger.waitFor({ state: "visible", timeout });
  await trigger.click();
  const option = page.getByRole("option").first();
  await option.waitFor({ state: "visible", timeout });
  await option.click();
  const legend = page.locator(".fm-chart-legend__item");
  await legend.first().waitFor({ state: "visible", timeout });
  const selectedQuantities = new Set(["mx", "my", "mz"]);
  const labels = await legend.evaluateAll((items) =>
    items.map((item) =>
      item.querySelector(".fm-chart-legend__label")?.textContent?.trim() ?? "",
    ),
  );
  for (const label of labels) {
    const item = legend.filter({
      has: page.locator(".fm-chart-legend__label", { hasText: new RegExp(`^${escapeRegex(label)}$`) }),
    }).first();
    const shouldSelect = selectedQuantities.has(label.toLowerCase());
    const selected = (await item.getAttribute("aria-pressed")) === "true";
    if (selected !== shouldSelect) await item.click();
  }
  for (const quantity of selectedQuantities) {
    const selected = legend.filter({
      has: page.locator(".fm-chart-legend__label", { hasText: new RegExp(`^${quantity}$`, "i") }),
    }).first();
    if ((await selected.getAttribute("aria-pressed")) !== "true") {
      throw new Error(`Analysis could not select ${quantity} for Quick Chart.`);
    }
  }
  const diagnosticsReady = await page.waitForFunction(
    () => typeof window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchDataZoom === "function",
    undefined,
    { timeout },
  );
  await diagnosticsReady.dispose();
  await page.evaluate(() => {
    window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchDataZoom?.(0, 1);
  });
  await page.keyboard.press("Control+Shift+p");
  await page.getByPlaceholder("Search commands").fill("Pin Quick Chart");
  await page.getByText("Pin Quick Chart", { exact: true }).last().click();
  await page.locator(".fm-quick-chart").waitFor({ state: "visible", timeout });
  await page.locator(".fm-footer__tab").filter({ hasText: /^Logs$/ }).click();
  await page.locator(".fm-quick-chart").waitFor({ state: "detached", timeout });
}

async function openQuickChartFooter(page) {
  const tab = page.locator(".fm-footer__tab").filter({ hasText: /^Quick Chart$/ });
  await tab.waitFor({ state: "visible", timeout });
  await tab.click();
  await page.locator(".fm-quick-chart").waitFor({ state: "visible", timeout });
}

async function waitForQuickChart(page, tableRequests, tableResponses, pageErrors) {
  const surface = page.locator(".fm-quick-chart__keyboard-surface");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".fm-quick-chart__keyboard-surface")
        ?.getAttribute("aria-label")
        ?.includes("row "),
    undefined,
    { timeout: 15_000 },
  ).catch(async () => {
    throw new Error(
      `Quick Chart samples did not become ready: key=${await page.locator(".fm-quick-chart [data-chart-model-key]").getAttribute("data-chart-model-key")} requests=${JSON.stringify(tableRequests.slice(-10))} responses=${JSON.stringify(tableResponses.slice(-10))} errors=${JSON.stringify(pageErrors.slice(-10))} ${(await page.locator(".fm-quick-chart").innerText()).slice(0, 1_500)}`,
    );
  });
  await surface.focus();
}

async function verifyExactQuickChartValuesAndUnits(page) {
  const surface = page.locator(".fm-quick-chart__keyboard-surface");
  await surface.press("Home");
  await surface.press("ArrowRight");
  const mx = await surface.getAttribute("aria-label");
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  const my = await surface.getAttribute("aria-label");
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  const mz = await surface.getAttribute("aria-label");
  if (!mx?.includes("0.97982") || !my?.includes("0.10317") || !mz?.includes("0.000004447")) {
    throw new Error(`Quick Chart exact values differ: ${JSON.stringify({ mx, my, mz })}`);
  }

  const downloadPromise = page.waitForEvent("download");
  await page.locator(".fm-quick-chart").getByRole("button", { name: "CSV" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Quick Chart CSV download has no path.");
  const csv = readFileSync(downloadPath, "utf8");
  for (const expected of ["0.97982", "0.10317", "0.000004447"]) {
    if (!csv.includes(expected)) {
      throw new Error(`Quick Chart CSV lacks ${expected}: ${csv}`);
    }
  }
  if (/\bm1\b|\bk1\b/.test(csv)) {
    throw new Error(`Quick Chart dimensionless export acquired an SI prefix: ${csv}`);
  }
  const exportedRows = csv.split("\n").slice(1).filter(Boolean).map((row) => row.split(","));
  if (
    exportedRows.length !== 6 ||
    exportedRows.some((row) => row[4] !== "1" || row[5] !== "1")
  ) {
    throw new Error(`Quick Chart export does not preserve dimensionless units: ${csv}`);
  }
}

async function verifyExactQuickChartRange(page) {
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".fm-quick-chart").getByRole("button", { name: "TSV" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Quick Chart TSV download has no path.");
  const rows = readFileSync(downloadPath, "utf8").trim().split("\n").slice(1);
  const xValues = rows.map((row) => Number(row.split("\t")[2]));
  const range = [Math.min(...xValues), Math.max(...xValues)];
  if (range[0] !== 0 || range[1] !== 1) {
    throw new Error(`Quick Chart exact range differs from [0,1]: ${JSON.stringify(range)}`);
  }
}

async function snapshotQuickChartAndViewport(page, requestLog) {
  return page.evaluate(({ requestCounts }) => {
    const viewport = document.querySelector(".fm-viewport-3d");
    const viewportRect = viewport?.getBoundingClientRect();
    const quick = document.querySelector(".fm-quick-chart");
    const quickRect = quick?.getBoundingClientRect();
    const diagnosticArtifact = window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.();
    const diagnostics = window.__FULLMAG_READ_VIEWPORT_3D_DIAGNOSTICS__?.() ?? {
      dirtyFrames: 0,
      gpuUploads: 0,
    };
    return {
      cameraSignature: viewport
        ? [
            viewport.getAttribute("data-camera-position"),
            viewport.getAttribute("data-camera-target"),
            viewport.getAttribute("data-camera-projection"),
            viewport.getAttribute("data-camera-up"),
          ].join("|")
        : null,
      diagnosticArtifactRecords:
        diagnosticArtifact?.streams?.viewport3d?.length ?? 0,
      dirtyFrames: diagnostics.dirtyFrames,
      fieldRequests: requestCounts.fieldRequests,
      gpuUploads: diagnostics.gpuUploads,
      lifecycle: { ...(window.__FULLMAG_QUICK_CHART_LIFECYCLE__ ?? {}) },
      quickRect: quickRect
        ? { bottom: quickRect.bottom, height: quickRect.height, top: quickRect.top, width: quickRect.width }
        : null,
      topologyRequests: requestCounts.topologyRequests,
      viewportRect: viewportRect
        ? { bottom: viewportRect.bottom, height: viewportRect.height, top: viewportRect.top, width: viewportRect.width }
        : null,
      visualizationRequests: requestCounts.visualizationRequests,
    };
  }, {
    requestCounts: {
      fieldRequests: requestLog.fieldRequests.length,
      topologyRequests: requestLog.topologyRequests.length,
      visualizationRequests: requestLog.visualizationRequests.length,
    },
  });
}

function assertQuickChartDoesNotMutateViewport(before, after) {
  const failures = [];
  if (after.fieldRequests !== before.fieldRequests) failures.push("field requests");
  if (after.topologyRequests !== before.topologyRequests) failures.push("topology requests");
  if (after.visualizationRequests !== before.visualizationRequests) failures.push("visualization/camera requests");
  if (after.cameraSignature !== before.cameraSignature) failures.push("camera signature");
  if (after.dirtyFrames !== before.dirtyFrames) failures.push("3D dirty frames");
  if (after.gpuUploads !== before.gpuUploads) failures.push("unchanged-buffer upload");
  if (!after.quickRect || !after.viewportRect) failures.push("missing layout bounds");
  if (after.quickRect && after.viewportRect && after.quickRect.top < after.viewportRect.bottom - 1) {
    failures.push("Quick Chart obscures 3D viewport");
  }
  if (failures.length > 0) {
    throw new Error(
      `Quick Chart mutated or obscured 3D (${failures.join(", ")}): before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
}

async function exerciseQuickChartLifecycle(page, mountedBaseline) {
  await page.locator(".fm-footer__tab").filter({ hasText: /^Logs$/ }).click();
  await page.locator(".fm-quick-chart").waitFor({ state: "detached", timeout });
  await page.waitForFunction(
    () => window.__FULLMAG_QUICK_CHART_LIFECYCLE__?.activeInstances === 0,
    undefined,
    { timeout },
  );
  const afterClose = await page.evaluate(() => ({
    ...(window.__FULLMAG_QUICK_CHART_LIFECYCLE__ ?? {}),
  }));
  if (
    afterClose.activeInstances !== 0 ||
    afterClose.activeObservers !== 0 ||
    afterClose.listenerCount !== 0 ||
    afterClose.animationFrameCount > (mountedBaseline.animationFrameCount ?? 0) ||
    afterClose.disposedInstances <= (mountedBaseline.disposedInstances ?? 0)
  ) {
    throw new Error(
      `Quick Chart lifecycle did not dispose its ECharts canvas: ${JSON.stringify({ mountedBaseline, afterClose })}`,
    );
  }
}

async function captureQuickChartAcceptanceScreenshots(page) {
  mkdirSync(acceptanceDirectory, { recursive: true });
  const screenshots = [];
  for (const [theme, filename] of [
    ["dark", "quick-chart-3d-mocha.png"],
    ["light", "quick-chart-3d-latte.png"],
  ]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.waitForTimeout(100);
    const target = path.join(acceptanceDirectory, filename);
    await page.screenshot({ path: target });
    screenshots.push(target);
  }
  await page.evaluate(() => {
    document.body.style.zoom = "200%";
  });
  const zoom = path.join(acceptanceDirectory, "quick-chart-3d-zoom-200.png");
  await page.screenshot({ fullPage: true, path: zoom });
  screenshots.push(zoom);
  await page.evaluate(() => {
    document.body.style.zoom = "";
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = path.join(
    acceptanceDirectory,
    "quick-chart-3d-reduced-motion.png",
  );
  await page.screenshot({ path: reduced });
  screenshots.push(reduced);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  return screenshots;
}

async function waitForViewportQuiet(page) {
  let stable = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await page.evaluate(() =>
      window.__FULLMAG_READ_VIEWPORT_3D_DIAGNOSTICS__?.() ?? null,
    );
    if (stable && JSON.stringify(current) === JSON.stringify(stable)) return;
    stable = current;
    await page.waitForTimeout(250);
  }
  throw new Error(`3D viewport did not settle before Quick Chart: ${JSON.stringify(stable)}`);
}

async function waitForHealthyWebGl(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return Boolean(
      gl &&
        !gl.isContextLost() &&
        gl.drawingBufferWidth > 0 &&
        gl.drawingBufferHeight > 0,
    );
  }, undefined, { timeout });
}

async function readWebGlProof(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    const gl = canvas instanceof HTMLCanvasElement
      ? canvas.getContext("webgl2") ?? canvas.getContext("webgl")
      : null;
    return {
      contextLost: gl?.isContextLost() ?? true,
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
    };
  });
}

function viewportTab(page, text) {
  return page
    .locator(".fm-viewport-tabs__trigger")
    .filter({ hasText: new RegExp(`^${text}$`) })
    .first();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function makeRowsFixture(columns, rowCount) {
  const buffer = Buffer.alloc(60 + rowCount * columns.length * 8);
  buffer.write("FMTB", 0, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeBigUInt64LE(1n, 8);
  buffer.writeBigUInt64LE(1n, 16);
  buffer.writeBigUInt64LE(0n, 24);
  buffer.writeBigUInt64LE(BigInt(rowCount), 32);
  buffer.writeBigUInt64LE(BigInt(rowCount), 40);
  buffer.writeBigUInt64LE(BigInt(rowCount), 48);
  buffer.writeUInt32LE(columns.length, 56);
  let offset = 60;
  for (let row = 0; row < rowCount; row += 1) {
    for (const column of columns) {
      const exact = {
        mx: 0.97982,
        my: 0.10317,
        mz: 4.447e-6,
      };
      const value = column === "step"
        ? row
        : column === "t" || column === "pseudo_time_s"
          ? row
          : row === rowCount - 1 && Object.hasOwn(exact, column)
            ? exact[column]
            : row === 0 && Object.hasOwn(exact, column)
              ? 0
              : column === "e_total"
                ? -1e-18 * (1 + row / rowCount)
                : Math.sin(row / 20);
      buffer.writeDoubleLE(value, offset);
      offset += 8;
    }
  }
  return buffer;
}

main().catch((error) => {
  console.error(`Analysis Quick Chart smoke failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
