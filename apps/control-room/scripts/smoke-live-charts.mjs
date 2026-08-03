import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const timeoutMs = numericEnv("CONTROL_ROOM_LIVE_CHARTS_TIMEOUT_MS", 120_000);
const artifactRoot = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_LIVE_CHARTS_ARTIFACT_DIR ??
    `.fullmag/reports/live-charts-analysis-acceptance/live-charts-${safeTimestamp()}`,
);
const useFixture = process.env.CONTROL_ROOM_LIVE_CHARTS_FIXTURE !== "0";

const EXACT_VALUES = Object.freeze({
  mx: 0.97982,
  my: 0.10317,
  mz: 4.447e-6,
});
const SERIES_IDS = Object.freeze(["mx", "my", "mz"]);
const VISIBILITY_COMBINATIONS = 2 ** 3;
const REVISION_STRESS_COUNT = 100;
const LIFECYCLE_SWITCH_COUNT = 100;
const TABLE_ROWS_PATTERN = /^\/v2\/sessions\/current\/data\/tables\/default\/rows\.bin(?:\?|$)/;
const LIVE_CHARTS_OWNED_RESOURCE_PATTERNS = Object.freeze([
  /^\/v2\/sessions\/current\/data\/tables(?:\/|\?|$)/,
  /^\/v2\/sessions\/current\/data\/scalars(?:\?|$)/,
  /^\/v2\/sessions\/current\/simulation\/solver\/energies\//,
]);
const TABLE_ROWS_RESOURCE = "/v2/sessions/current/data/tables/default/rows";
const IRRELEVANT_RESOURCE = "/v2/sessions/current/diagnostics/gpu";

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error("Live Charts smoke requires Playwright or @playwright/test.");
  }
  await mkdir(artifactRoot, { recursive: true });

  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({
    acceptDownloads: true,
    colorScheme: "dark",
    viewport: { height: 1000, width: 1440 },
  });
  const page = await context.newPage();
  const evidence = createEvidence();
  const fixture = createFixtureState();

  try {
    await installBrowserInstrumentation(page, "dark");
    if (useFixture) await installLiveChartsFixtureRoutes(page, fixture, evidence);
    attachPageEvidence(page, evidence);
    await page.goto(workspaceUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await openLiveCharts(page);
    await waitForReadyLiveChart(page);
    await verifyNoVisibleErrorNotifications(page);

    const initialRequests = resourceRequestSnapshot(evidence);
    await verifyOneVisibleCanvas(page);
    await verifyExactScientificValues(page);
    await verifyTooltipValues(page);
    await verifyVisibilityMatrix(page, evidence);
    await verifyCanonicalCsvExport(page);
    await verifyKeyboardInteractions(page, evidence);
    await runRevisionStress(page, fixture, evidence);
    await verifyIrrelevantRevisionBudget(page, fixture, evidence);
    await keyboardPauseAndFollow(page, fixture, evidence);
    const lifecycleBaseline = await runLifecycleStress(page);
    await verifyLifecycleCounters(page, lifecycleBaseline);
    await verifyNoVisibleErrorNotifications(page);
    await captureVisualVariants(page);
    await captureZoomScreenshot(browser);

    const proof = await collectProof(page, evidence, initialRequests);
    const failures = validateProof(proof, evidence);
    if (failures.length > 0) {
      throw new Error(`Live Charts smoke failed:\n${failures.join("\n")}`);
    }
    console.log(`Live Charts proof: ${JSON.stringify(proof)}`);
    console.log(`Live Charts screenshots: ${artifactRoot}`);
    console.log(`Live Charts smoke passed at ${workspaceUrl}.`);
  } finally {
    await context.close();
    await browser.close();
  }
}

function createEvidence() {
  return {
    consoleErrors: [],
    failedResponses: [],
    failedRowsResponses: [],
    requests: [],
  };
}

function createFixtureState() {
  return { revision: 1, rowCount: 256 };
}

async function installBrowserInstrumentation(page, preferredTheme) {
  await page.addInitScript(({ baseUrl, preferredTheme: theme }) => {
    localStorage.setItem("fullmag.control-room.theme", theme);
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
      disableRealtime: false,
    };
    window.__FULLMAG_ENABLE_CHART_DIAGNOSTICS__ = true;
    window.__FULLMAG_CHART_DIAGNOSTICS__ = {
      activeInstances: 0,
      createdInstances: 0,
      disposedInstances: 0,
      modelBuilds: 0,
      plannedPoints: 0,
      renderedPoints: 0,
      resizeCalls: 0,
      setOptionCalls: 0,
    };

    const counters = {
      activeAnimationFrames: 0,
      activeLiveChartListeners: 0,
      activeObjectUrls: 0,
      activeWorkers: 0,
      chartInstances: 0,
      createdChartInstances: 0,
      disposedChartInstances: 0,
      liveResizeObservers: 0,
      resizeObservers: 0,
    };
    const sockets = [];
    const downloads = [];
    const objectUrls = new Map();
    const trackedChartNodes = new WeakSet();
    const liveListenerRegistrations = new WeakMap();

    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    const activeFrames = new Set();
    window.requestAnimationFrame = (callback) => {
      let frame = 0;
      frame = nativeRequestAnimationFrame((time) => {
        activeFrames.delete(frame);
        counters.activeAnimationFrames = activeFrames.size;
        callback(time);
      });
      activeFrames.add(frame);
      counters.activeAnimationFrames = activeFrames.size;
      return frame;
    };
    window.cancelAnimationFrame = (frame) => {
      activeFrames.delete(frame);
      counters.activeAnimationFrames = activeFrames.size;
      nativeCancelAnimationFrame(frame);
    };

    const NativeResizeObserver = window.ResizeObserver;
    if (NativeResizeObserver) {
      window.ResizeObserver = class FullmagSmokeResizeObserver {
        constructor(callback) {
          this.live = false;
          this.disconnected = false;
          this.native = new NativeResizeObserver(callback);
          counters.resizeObservers += 1;
        }
        disconnect() {
          if (!this.disconnected) {
            this.disconnected = true;
            counters.resizeObservers = Math.max(0, counters.resizeObservers - 1);
            if (this.live) counters.liveResizeObservers = Math.max(0, counters.liveResizeObservers - 1);
          }
          this.native.disconnect();
        }
        observe(target, options) {
          if (!this.live && target instanceof Element && target.closest(".fm-live-charts")) {
            this.live = true;
            counters.liveResizeObservers += 1;
          }
          this.native.observe(target, options);
        }
        unobserve(target) { this.native.unobserve(target); }
      };
    }

    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      const isLiveTarget = this instanceof Element && Boolean(this.closest(".fm-live-charts"));
      if (isLiveTarget && listener) {
        let registrations = liveListenerRegistrations.get(this);
        if (!registrations) {
          registrations = new Map();
          liveListenerRegistrations.set(this, registrations);
        }
        const key = `${type}:${Boolean(options && typeof options === "object" && options.capture)}`;
        const listeners = registrations.get(key) ?? new Set();
        if (!listeners.has(listener)) {
          listeners.add(listener);
          registrations.set(key, listeners);
          counters.activeLiveChartListeners += 1;
        }
      }
      return nativeAddEventListener.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      const registrations = liveListenerRegistrations.get(this);
      const key = `${type}:${Boolean(options && typeof options === "object" && options.capture)}`;
      const listeners = registrations?.get(key);
      if (listener && listeners?.delete(listener)) {
        counters.activeLiveChartListeners = Math.max(0, counters.activeLiveChartListeners - 1);
      }
      return nativeRemoveEventListener.call(this, type, listener, options);
    };

    const NativeWorker = window.Worker;
    if (NativeWorker) {
      window.Worker = class FullmagSmokeWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.__fullmagTerminated = false;
          counters.activeWorkers += 1;
        }
        terminate() {
          if (!this.__fullmagTerminated) {
            this.__fullmagTerminated = true;
            counters.activeWorkers = Math.max(0, counters.activeWorkers - 1);
          }
          return super.terminate();
        }
      };
    }

    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = nativeCreateObjectURL(object);
      objectUrls.set(url, object);
      counters.activeObjectUrls = objectUrls.size;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      objectUrls.delete(url);
      counters.activeObjectUrls = objectUrls.size;
      nativeRevokeObjectURL(url);
    };
    const nativeAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const blob = objectUrls.get(this.href);
      if (blob) {
        const entry = { content: null, filename: this.download, mimeType: blob.type };
        downloads.push(entry);
        void blob.text().then((content) => { entry.content = content; });
        return;
      }
      return nativeAnchorClick.call(this);
    };

    class FixtureWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url, protocols) {
        super();
        this.binaryType = "blob";
        this.bufferedAmount = 0;
        this.extensions = "";
        this.protocol = Array.isArray(protocols) ? protocols[0] ?? "" : protocols ?? "";
        this.readyState = FixtureWebSocket.CONNECTING;
        this.url = String(url);
        sockets.push(this);
        queueMicrotask(() => {
          this.readyState = FixtureWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        });
      }
      close() {
        if (this.readyState === FixtureWebSocket.CLOSED) return;
        this.readyState = FixtureWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code: 1000, wasClean: true }));
      }
      send() {}
      emit(payload) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }
    window.WebSocket = FixtureWebSocket;

    function visitChartNodes(root, removed) {
      const nodes = [];
      if (root instanceof HTMLCanvasElement) nodes.push(root);
      if (root instanceof Element) nodes.push(...root.querySelectorAll("canvas"));
      for (const node of nodes) {
        if (!removed && !trackedChartNodes.has(node) && node.closest(".fm-live-charts")) {
          trackedChartNodes.add(node);
          counters.chartInstances += 1;
          counters.createdChartInstances += 1;
          window.__FULLMAG_CHART_DIAGNOSTICS__.activeInstances = counters.chartInstances;
          window.__FULLMAG_CHART_DIAGNOSTICS__.createdInstances = counters.createdChartInstances;
        } else if (removed && trackedChartNodes.has(node)) {
          counters.chartInstances = Math.max(0, counters.chartInstances - 1);
          counters.disposedChartInstances += 1;
          window.__FULLMAG_CHART_DIAGNOSTICS__.activeInstances = counters.chartInstances;
          window.__FULLMAG_CHART_DIAGNOSTICS__.disposedInstances = counters.disposedChartInstances;
        }
      }
    }
    function releaseRemovedLiveListeners(root) {
      const nodes = [];
      if (root instanceof Element) nodes.push(root, ...root.querySelectorAll("*"));
      for (const node of nodes) {
        const registrations = liveListenerRegistrations.get(node);
        if (!registrations) continue;
        let count = 0;
        for (const listeners of registrations.values()) count += listeners.size;
        counters.activeLiveChartListeners = Math.max(0, counters.activeLiveChartListeners - count);
        liveListenerRegistrations.delete(node);
      }
    }
    nativeAddEventListener.call(document, "DOMContentLoaded", () => {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes") visitChartNodes(mutation.target, false);
          for (const node of mutation.addedNodes) visitChartNodes(node, false);
          for (const node of mutation.removedNodes) {
            visitChartNodes(node, true);
            releaseRemovedLiveListeners(node);
          }
        }
      });
      observer.observe(document.documentElement, {
        attributeFilter: ["_echarts_instance_"],
        attributes: true,
        childList: true,
        subtree: true,
      });
    }, { once: true });

    window.__FULLMAG_LIVE_CHARTS_SMOKE__ = {
      counters,
      downloads,
      emitResourceRevision(resourceKey, revision) {
        const event = {
          payload: {
            changes: [{
              recommended_fetch: resourceKey,
              resource: resourceKey.includes("tables") ? "table_rows" : "diagnostics",
              resource_id: resourceKey,
              revision,
            }],
          },
          seq: revision,
          type: "resource.batch_changed",
        };
        for (const socket of sockets) socket.emit(event);
      },
      sockets: () => sockets.length,
    };
  }, { baseUrl: apiBase, preferredTheme });
}

function attachPageEvidence(page, evidence) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.startsWith("Failed to load resource:")) return;
    evidence.consoleErrors.push(text);
  });
  page.on("pageerror", (error) => evidence.consoleErrors.push(error.message));
  page.on("request", (request) => {
    const path = currentSessionPath(request.url());
    if (path) evidence.requests.push({ method: request.method(), path, timestamp: Date.now() });
  });
  page.on("response", (response) => {
    const path = currentSessionPath(response.url());
    if (path && response.status() >= 400) {
      evidence.failedResponses.push({ path, status: response.status() });
    }
    if (path && TABLE_ROWS_PATTERN.test(path) && response.status() >= 400) {
      evidence.failedRowsResponses.push({ path, status: response.status() });
    }
  });
}

async function installLiveChartsFixtureRoutes(page, fixture, evidence) {
  const columns = [
    { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
    { column_id: "mx", component: "x", dimension: "dimensionless", label: "mx", quantity_id: "mx", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "my", component: "y", dimension: "dimensionless", label: "my", quantity_id: "my", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "mz", component: "z", dimension: "dimensionless", label: "mz", quantity_id: "mz", reduction: "mean", unit: "1", value_type: "float" },
  ];
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-api-contract-version",
      "x-api-contract-version": "1.0.0",
    };
    if (request.method() !== "GET") {
      await route.fulfill({ body: "", headers: cors, status: 204 });
      return;
    }
    const table = {
      binary_rows_href: "/v2/sessions/current/data/tables/default/rows.bin",
      columns: [],
      columns_href: "/v2/sessions/current/data/tables/default/columns",
      revision: fixture.revision,
      rows_href: TABLE_ROWS_RESOURCE,
      schema_revision: 1,
      table_id: "default",
      total_rows: fixture.rowCount,
    };
    if (url.pathname === "/v2/sessions/current/status") {
      await route.fulfill({
        body: JSON.stringify(liveChartsStatusFixture()),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables") {
      await route.fulfill({ body: JSON.stringify({ revision: fixture.revision, tables: [table] }), contentType: "application/json", headers: cors, status: 200 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables/default") {
      await route.fulfill({ body: JSON.stringify(table), contentType: "application/json", headers: cors, status: 200 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables/default/columns") {
      await route.fulfill({ body: JSON.stringify(columns), contentType: "application/json", headers: cors, status: 200 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables/default/rows.bin") {
      const requestedColumns = (url.searchParams.get("columns") ?? "").split(",").filter(Boolean);
      if (requestedColumns.length === 0) {
        evidence.failedRowsResponses.push({ path: `${url.pathname}${url.search}`, status: 422 });
        await route.fulfill({ body: "columns required", headers: cors, status: 422 });
        return;
      }
      await route.fulfill({
        body: makeRowsFixture(requestedColumns, fixture.rowCount, fixture.revision),
        contentType: "application/vnd.fullmag.table-rows.v1+octet-stream",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/visualization/state") {
      await route.fulfill({
        body: JSON.stringify(liveChartsVisualizationStateFixture()),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/domain/meta") {
      await route.fulfill({
        body: JSON.stringify(liveChartsDomainMetaFixture()),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/model/universe") {
      await route.fulfill({
        body: JSON.stringify(liveChartsUniverseFixture()),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (isLiveChartsOwnedPath(url.pathname)) {
      await route.fulfill({
        body: JSON.stringify({ error: "owned Live Charts fixture resource is not implemented" }),
        contentType: "application/json",
        headers: cors,
        status: 501,
      });
      return;
    }
    await route.fulfill({ body: "", headers: cors, status: 204 });
  });
}

function isLiveChartsOwnedPath(pathname) {
  return LIVE_CHARTS_OWNED_RESOURCE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function liveChartsStatusFixture() {
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
    runtime_bundle_version: "live-charts-fixture",
    session: {
      created_at: "0",
      name: "live-charts-fixture",
      session_id: "live-charts-fixture",
      workspace_root: "/tmp/fullmag-live-charts-fixture",
    },
    solver: { state: "idle" },
  };
}

function liveChartsVisualizationStateFixture() {
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

function liveChartsDomainMetaFixture() {
  return {
    bounds: { max: [1, 1, 0.25], min: [-1, -1, -0.25] },
    coordinate_system: "cartesian",
    counts: { cells: 4 },
    dimension: 3,
    discretization: "fdm",
    domain_id: "live-charts-domain",
    generation_id: 1,
    grid: {
      origin: [-1, -1, -0.25],
      shape: [2, 2, 1],
      spacing: [1, 1, 0.5],
    },
    units: { length: "m" },
  };
}

function liveChartsUniverseFixture() {
  return {
    mesh_dirty: false,
    object_bounds_max: [1, 1, 0.25],
    object_bounds_min: [-1, -1, -0.25],
    scene_revision: 0,
    study_universe_mesh: null,
    universe: null,
  };
}

function makeRowsFixture(columns, rowCount, revision) {
  const buffer = Buffer.alloc(60 + rowCount * columns.length * 8);
  buffer.write("FMTB", 0, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(1, 6);
  buffer.writeBigUInt64LE(BigInt(revision), 8);
  buffer.writeBigUInt64LE(1n, 16);
  buffer.writeBigUInt64LE(1n, 24);
  buffer.writeBigUInt64LE(BigInt(rowCount), 32);
  buffer.writeBigUInt64LE(BigInt(rowCount), 40);
  buffer.writeBigUInt64LE(BigInt(rowCount), 48);
  buffer.writeUInt32LE(columns.length, 56);
  let offset = 60;
  for (let row = 0; row < rowCount; row += 1) {
    const progress = rowCount <= 1 ? 1 : row / (rowCount - 1);
    for (const column of columns) {
      const value = column === "step"
        ? row
        : column === "mx"
          ? row === rowCount - 1 ? EXACT_VALUES.mx : 0.85 + (EXACT_VALUES.mx - 0.85) * progress
          : column === "my"
            ? row === rowCount - 1 ? EXACT_VALUES.my : -0.15 + (EXACT_VALUES.my + 0.15) * progress
            : column === "mz"
              ? row === rowCount - 1 ? EXACT_VALUES.mz : -2e-6 + (EXACT_VALUES.mz + 2e-6) * progress
              : row;
      buffer.writeDoubleLE(value, offset);
      offset += 8;
    }
  }
  return buffer;
}

async function openLiveCharts(page) {
  const tab = viewportTab(page, "Live Charts");
  await tab.waitFor({ state: "visible", timeout: timeoutMs });
  await tab.click();
  await page.locator("[data-slot-id='viewport-main'][data-active-module-id='live-charts']").waitFor({ state: "attached", timeout: timeoutMs });
  await page.locator(".fm-live-charts").waitFor({ state: "visible", timeout: timeoutMs });
}

async function waitForReadyLiveChart(page) {
  await page.waitForFunction(() => {
    const root = document.querySelector(".fm-live-charts");
    const canvas = root?.querySelector(".fm-analysis-chart-surface canvas");
    const readings = root?.querySelectorAll(".fm-chart-legend__latest") ?? [];
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0 && readings.length === 3;
  }, undefined, { timeout: timeoutMs });
  await waitForQuietFrames(page);
}

async function verifyOneVisibleCanvas(page) {
  const proof = await page.locator(".fm-live-charts").evaluate((root) => {
    const canvases = Array.from(root.querySelectorAll(".fm-analysis-chart-surface canvas"));
    const visible = canvases.filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return {
      canvasCount: canvases.length,
      visibleCanvasCount: visible.length,
      dimensions: visible.map((canvas) => ({ height: canvas.height, width: canvas.width })),
    };
  });
  if (proof.canvasCount !== 1 || proof.visibleCanvasCount !== 1 || proof.dimensions.some((item) => item.width <= 0 || item.height <= 0)) {
    throw new Error(`Live Charts must retain one visible canvas: ${JSON.stringify(proof)}`);
  }
}

async function verifyExactScientificValues(page) {
  const readings = await legendReadings(page);
  for (const [quantity, expected] of Object.entries(EXACT_VALUES)) {
    const reading = readings.find((entry) => entry.label === quantity);
    if (!reading) throw new Error(`Missing ${quantity} legend reading.`);
    const actual = Number(reading.value);
    if (!numbersEqual(actual, expected)) {
      throw new Error(`${quantity} legend value differs: ${actual} != ${expected}`);
    }
    if (reading.unit !== "1") {
      throw new Error(`${quantity} is not labelled dimensionless: ${reading.unit}`);
    }
  }
  const rootText = await page.locator(".fm-live-charts").innerText();
  if (/\bm1\b|\[[yzafpnumkMGT]1\]|\b[yzafpnumkMGT]1\b/.test(rootText)) {
    throw new Error(`forbidden prefixed dimensionless label: ${rootText.slice(0, 1_500)}`);
  }
  await keyboardInspectPoint(page);
}

async function verifyTooltipValues(page) {
  const host = page.locator(".fm-live-charts .fm-analysis-plots__echarts").first();
  const box = await host.boundingBox();
  if (!box) throw new Error("Live Charts ECharts host has no bounds.");
  let tooltip = "";
  for (const xInset of [18, 28, 40, 55, 72, 96, 120]) {
    for (const yFraction of [0.25, 0.5, 0.75]) {
      await page.mouse.move(box.x + box.width - xInset, box.y + box.height * yFraction);
      await page.waitForTimeout(30);
      tooltip = await host.evaluate((element) =>
        Array.from(element.querySelectorAll("div"))
          .map((node) => node.textContent?.trim() ?? "")
          .find((text) => text.includes("row id:")) ?? "",
      );
      if (tooltip.includes("mx") && tooltip.includes("my") && tooltip.includes("mz")) break;
    }
    if (tooltip.includes("mx") && tooltip.includes("my") && tooltip.includes("mz")) break;
  }
  if (!tooltip.includes("mx") || !tooltip.includes("my") || !tooltip.includes("mz")) {
    throw new Error(`Live Charts tooltip could not be inspected: ${tooltip}`);
  }
  for (const expected of ["0.97982", "0.10317", "4.4470e-6"]) {
    if (!tooltip.includes(expected)) throw new Error(`Live Charts tooltip is missing ${expected}: ${tooltip}`);
  }
  for (const forbidden of ["m1", "k1", "µ1"]) {
    if (tooltip.includes(forbidden)) throw new Error(`forbidden prefixed dimensionless label in tooltip: ${tooltip}`);
  }
}

async function verifyVisibilityMatrix(page, evidence) {
  for (let mask = 0; mask < VISIBILITY_COMBINATIONS; mask += 1) {
    const requestStart = evidence.requests.length;
    for (let index = 0; index < SERIES_IDS.length; index += 1) {
      const button = legendButton(page, SERIES_IDS[index]);
      const desired = Boolean(mask & (1 << index));
      const selected = (await button.getAttribute("aria-pressed")) === "true";
      if (selected !== desired) {
        await button.focus();
        await page.keyboard.press("Enter");
      }
    }
    await page.waitForFunction(({ expected }) => {
      const root = document.querySelector(".fm-live-charts");
      const selected = root?.querySelectorAll(".fm-chart-legend__item[aria-pressed='true']").length ?? 0;
      const summary = root?.querySelector(".fm-visually-hidden")?.textContent ?? "";
      const empty = root?.querySelector(".fm-live-charts__empty")?.textContent ?? "";
      return selected === expected && (expected === 0 ? empty.includes("Select at least one signal") : summary.includes(`${expected} series`));
    }, { expected: popCount(mask) }, { timeout: timeoutMs });
    assertNoRequestsSince(evidence, requestStart, `visibility mask ${mask}`);
  }
  await showAllSignals(page);
  await verifyOneVisibleCanvas(page);
}

async function verifyCanonicalCsvExport(page) {
  await keyboardExport(page);
  await page.waitForFunction(() =>
    window.__FULLMAG_LIVE_CHARTS_SMOKE__?.downloads?.some((entry) => entry.filename.endsWith(".csv") && typeof entry.content === "string"),
    undefined,
    { timeout: timeoutMs },
  );
  const csv = await page.evaluate(() =>
    window.__FULLMAG_LIVE_CHARTS_SMOKE__.downloads.find((entry) => entry.filename.endsWith(".csv") && typeof entry.content === "string")?.content ?? "",
  );
  const rows = csv.split(/\r?\n/).filter(Boolean).map((row) => row.split(","));
  const header = rows[0] ?? [];
  if (header.join(",") !== "series_id,row_id,x,y,x_unit,y_unit,data_revision,decimation") {
    throw new Error(`Canonical CSV header differs: ${header.join(",")}`);
  }
  for (const [quantity, expected] of Object.entries(EXACT_VALUES)) {
    const matches = rows.filter((row) => row[0]?.endsWith(`:${quantity}`));
    const final = matches.at(-1);
    if (!final || !numbersEqual(Number(final[3]), expected) || final[5] !== "1") {
      throw new Error(`Canonical CSV ${quantity} differs: ${JSON.stringify(final)}`);
    }
  }
}

async function verifyKeyboardInteractions(page, evidence) {
  const requestStart = evidence.requests.length;
  await keyboardSelectSignal(page);
  await keyboardHideSignal(page);
  await keyboardShowSignal(page);
  await keyboardSoloSignal(page);
  await showAllSignals(page);
  await keyboardResetRange(page);
  await keyboardInspectPoint(page);
  await keyboardExport(page);
  assertNoRequestsSince(evidence, requestStart, "keyboard local interactions");
}

async function keyboardSelectSignal(page) {
  const button = legendButton(page, "mx");
  await button.focus();
  if ((await button.getAttribute("aria-pressed")) === "true") await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  if ((await button.getAttribute("aria-pressed")) !== "true") throw new Error("Keyboard failed to select mx.");
}

async function keyboardHideSignal(page) {
  const button = legendButton(page, "mx");
  if ((await button.getAttribute("aria-pressed")) !== "true") await keyboardSelectSignal(page);
  await button.focus();
  await page.keyboard.press("Space");
  if ((await button.getAttribute("aria-pressed")) !== "false") throw new Error("Keyboard failed to hide mx.");
}

async function keyboardShowSignal(page) {
  const button = legendButton(page, "mx");
  if ((await button.getAttribute("aria-pressed")) !== "false") await keyboardHideSignal(page);
  await button.focus();
  await page.keyboard.press("Enter");
  if ((await button.getAttribute("aria-pressed")) !== "true") throw new Error("Keyboard failed to show mx.");
}

async function keyboardSoloSignal(page) {
  await showAllSignals(page);
  const button = legendButton(page, "my");
  await button.focus();
  await page.keyboard.press("Shift+Enter");
  const selected = await page.locator(".fm-live-charts .fm-chart-legend__item[aria-pressed='true']").count();
  if (selected !== 1 || (await button.getAttribute("aria-pressed")) !== "true") {
    throw new Error("Keyboard failed to solo my.");
  }
}

async function keyboardResetRange(page) {
  const fit = page.getByRole("button", { name: "Fit", exact: true });
  await fit.focus();
  await page.keyboard.press("Enter");
}

async function keyboardInspectPoint(page) {
  const button = page.locator(".fm-live-charts .fm-analysis-chart-export").getByRole("button", { name: "Data Table", exact: true }).first();
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: timeoutMs });
  const text = await dialog.innerText();
  for (const [quantity, expected] of Object.entries(EXACT_VALUES)) {
    if (!text.includes(quantity)) throw new Error(`Point inspector table is missing ${quantity}.`);
    const expectedDisplay = quantity === "mz" ? "4.4470e-6" : String(expected);
    if (!text.includes(expectedDisplay)) throw new Error(`Point inspector table is missing ${quantity}=${expectedDisplay}.`);
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: timeoutMs });
}

async function keyboardExport(page) {
  const button = page.locator(".fm-live-charts .fm-analysis-chart-export").getByRole("button", { name: "CSV", exact: true }).first();
  await button.focus();
  await page.keyboard.press("Enter");
}

async function runRevisionStress(page, fixture, evidence) {
  await showAllSignals(page);
  const baseline = await liveChartGeometry(page);
  await beginLiveRevisionObservation(page);
  const requestStart = evidence.requests.length;
  await page.evaluate(({ count, resource, startRevision }) => {
    const smoke = window.__FULLMAG_LIVE_CHARTS_SMOKE__;
    for (let index = 1; index <= count; index += 1) {
      smoke.emitResourceRevision(resource, startRevision + index);
    }
  }, { count: REVISION_STRESS_COUNT, resource: TABLE_ROWS_RESOURCE, startRevision: fixture.revision });
  fixture.revision += REVISION_STRESS_COUNT;
  await page.waitForFunction((revision) =>
    Array.from(document.querySelectorAll(".fm-live-charts .fm-chart-section__revision")).some((node) => node.textContent?.includes(String(revision))),
    fixture.revision,
    { timeout: timeoutMs },
  );
  await waitForQuietFrames(page);
  const observation = await endLiveRevisionObservation(page);
  const requests = rowsRequestsSince(evidence, requestStart);
  if (requests.length > 1) {
    throw new Error(`coalesced table fetch budget exceeded: ${requests.length}/1`);
  }
  await verifyOneVisibleCanvas(page);
  const after = await liveChartGeometry(page);
  if (after.loadingOverlay || observation.blockingLoadingSeen) throw new Error("blocking loading state appeared after initial payload");
  if (observation.canvasDisconnected) throw new Error("Live Charts replaced its canvas during background revision refresh.");
  if (observation.maximumLayoutShift > 1 || Math.abs(after.width - baseline.width) > 1 || Math.abs(after.height - baseline.height) > 1) {
    throw new Error(`layout shift exceeded budget: ${JSON.stringify({ after, baseline })}`);
  }
  if (!after.retained) throw new Error("Live Charts canvas was not marked data-retained during refresh.");
}

async function verifyIrrelevantRevisionBudget(page, fixture, evidence) {
  const requestStart = evidence.requests.length;
  await page.evaluate(({ resource, revision }) => {
    window.__FULLMAG_LIVE_CHARTS_SMOKE__.emitResourceRevision(resource, revision);
  }, { resource: IRRELEVANT_RESOURCE, revision: fixture.revision + 1 });
  await page.waitForTimeout(750);
  if (rowsRequestsSince(evidence, requestStart).length !== 0) {
    throw new Error("Irrelevant revision issued a Live Charts payload request.");
  }
}

async function keyboardPauseAndFollow(page, fixture, evidence) {
  const liveCharts = page.locator(".fm-live-charts");
  const pauseButton = liveCharts.getByRole("button", { name: "Pause", exact: true });
  await pauseButton.focus();
  await page.keyboard.press("Enter");
  await liveCharts.getByRole("button", { name: "Follow", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
  const pauseRequestStart = evidence.requests.length;
  fixture.revision += 1;
  await page.evaluate(({ resource, revision }) => {
    window.__FULLMAG_LIVE_CHARTS_SMOKE__.emitResourceRevision(resource, revision);
  }, { resource: TABLE_ROWS_RESOURCE, revision: fixture.revision });
  await page.waitForTimeout(750);
  if (rowsRequestsSince(evidence, pauseRequestStart).length !== 0) {
    throw new Error("pause issued a payload request");
  }
  const resumeRequestStart = evidence.requests.length;
  const followButton = liveCharts.getByRole("button", { name: "Follow", exact: true });
  await followButton.focus();
  await page.keyboard.press("Enter");
  await liveCharts.getByRole("button", { name: "Pause", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction((revision) =>
    Array.from(document.querySelectorAll(".fm-live-charts .fm-chart-section__revision")).some((node) => node.textContent?.includes(String(revision))),
    fixture.revision,
    { timeout: timeoutMs },
  );
  await waitForRowsRequestCount(page, evidence, resumeRequestStart, 1);
  const resumeRequests = rowsRequestsSince(evidence, resumeRequestStart);
  if (resumeRequests.length !== 1) {
    throw new Error(`resume did not issue exactly one latest payload request: ${resumeRequests.length}`);
  }
}

async function runLifecycleStress(page) {
  const analysis = viewportTab(page, "Analysis");
  const live = viewportTab(page, "Live Charts");
  await analysis.click();
  await page.locator("[data-active-module-id='analysis-plots']").waitFor({ state: "attached", timeout: timeoutMs });
  await waitForQuietFrames(page);
  const baseline = await page.evaluate(() => ({ ...window.__FULLMAG_LIVE_CHARTS_SMOKE__.counters }));
  for (let index = 0; index < LIFECYCLE_SWITCH_COUNT; index += 1) {
    await live.click();
    await page.locator("[data-active-module-id='live-charts']").waitFor({ state: "attached", timeout: timeoutMs });
    await page.locator(".fm-live-charts .fm-analysis-chart-surface canvas").waitFor({ state: "visible", timeout: timeoutMs });
    await analysis.click();
    await page.locator("[data-active-module-id='analysis-plots']").waitFor({ state: "attached", timeout: timeoutMs });
  }
  await waitForQuietFrames(page);
  return baseline;
}

async function beginLiveRevisionObservation(page) {
  await page.evaluate(() => {
    const root = document.querySelector(".fm-live-charts");
    const surface = root?.querySelector(".fm-analysis-chart-surface");
    const canvas = root?.querySelector(".fm-analysis-chart-surface canvas");
    if (!(root instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Cannot observe Live Charts revision lifecycle without a mounted canvas.");
    }
    const baseline = surface.getBoundingClientRect();
    const state = {
      blockingLoadingSeen: false,
      canvasDisconnected: false,
      maximumLayoutShift: 0,
      observer: null,
    };
    const sample = () => {
      const rect = surface.getBoundingClientRect();
      state.maximumLayoutShift = Math.max(
        state.maximumLayoutShift,
        Math.abs(rect.width - baseline.width),
        Math.abs(rect.height - baseline.height),
      );
      state.canvasDisconnected ||= !canvas.isConnected;
      state.blockingLoadingSeen ||= Array.from(root.querySelectorAll(".fm-analysis-plots__chart-empty"))
        .some((node) => /loading/i.test(node.textContent ?? ""));
    };
    state.observer = new MutationObserver(sample);
    state.observer.observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
    window.__FULLMAG_LIVE_CHARTS_REVISION_OBSERVER__ = state;
  });
}

async function endLiveRevisionObservation(page) {
  return page.evaluate(() => {
    const state = window.__FULLMAG_LIVE_CHARTS_REVISION_OBSERVER__;
    if (!state) throw new Error("Live Charts revision observer is missing.");
    state.observer?.disconnect();
    const result = {
      blockingLoadingSeen: state.blockingLoadingSeen,
      canvasDisconnected: state.canvasDisconnected,
      maximumLayoutShift: state.maximumLayoutShift,
    };
    delete window.__FULLMAG_LIVE_CHARTS_REVISION_OBSERVER__;
    return result;
  });
}

async function verifyLifecycleCounters(page, baseline) {
  const counters = await page.evaluate(() => window.__FULLMAG_LIVE_CHARTS_SMOKE__.counters);
  const failures = [];
  if (counters.chartInstances !== 0) failures.push(`active ECharts owners=${counters.chartInstances}`);
  if (counters.liveResizeObservers !== 0) failures.push(`live ResizeObserver owners=${counters.liveResizeObservers}`);
  if (counters.activeLiveChartListeners !== 0) failures.push(`live listeners=${counters.activeLiveChartListeners}`);
  if (counters.activeWorkers !== baseline.activeWorkers) failures.push(`workers=${counters.activeWorkers}, baseline=${baseline.activeWorkers}`);
  if (counters.activeObjectUrls !== baseline.activeObjectUrls) failures.push(`object URLs=${counters.activeObjectUrls}, baseline=${baseline.activeObjectUrls}`);
  if (counters.activeAnimationFrames !== baseline.activeAnimationFrames) failures.push(`animation frames=${counters.activeAnimationFrames}, baseline=${baseline.activeAnimationFrames}`);
  if (counters.resizeObservers !== baseline.resizeObservers) failures.push(`ResizeObservers=${counters.resizeObservers}, baseline=${baseline.resizeObservers}`);
  const createdDelta = counters.createdChartInstances - baseline.createdChartInstances;
  const disposedDelta = counters.disposedChartInstances - baseline.disposedChartInstances;
  if (createdDelta !== LIFECYCLE_SWITCH_COUNT || disposedDelta !== LIFECYCLE_SWITCH_COUNT) {
    failures.push(`ECharts lifecycle delta ${createdDelta} created / ${disposedDelta} disposed, expected ${LIFECYCLE_SWITCH_COUNT}`);
  }
  if (failures.length > 0) throw new Error(`Live Charts lifecycle did not return to baseline: ${failures.join(", ")}`);
  await openLiveCharts(page);
  await waitForReadyLiveChart(page);
}

async function captureVisualVariants(page) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  await setTheme(page, "dark");
  await verifyNoVisibleErrorNotifications(page);
  await page.screenshot({ fullPage: true, path: resolve(artifactRoot, "live-charts-mocha.png") });

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await setTheme(page, "light");
  await verifyNoVisibleErrorNotifications(page);
  await page.screenshot({ fullPage: true, path: resolve(artifactRoot, "live-charts-latte.png") });

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await setTheme(page, "dark");
  await verifyNoVisibleErrorNotifications(page);
  await page.screenshot({ fullPage: true, path: resolve(artifactRoot, "live-charts-reduced-motion.png") });
}

async function captureZoomScreenshot(browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    viewport: { height: 1000, width: 1440 },
  });
  const page = await context.newPage();
  const fixture = createFixtureState();
  const evidence = createEvidence();
  try {
    await installBrowserInstrumentation(page, "dark");
    if (useFixture) await installLiveChartsFixtureRoutes(page, fixture, evidence);
    attachPageEvidence(page, evidence);
    await page.goto(workspaceUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await openLiveCharts(page);
    await waitForReadyLiveChart(page);
    await verifyOneVisibleCanvas(page);
    await verifyNoVisibleErrorNotifications(page);
    if (evidence.failedResponses.length > 0) {
      throw new Error(`Zoom fixture responses failed: ${JSON.stringify(evidence.failedResponses)}`);
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    const canvas = page.locator(".fm-live-charts .fm-analysis-chart-surface canvas");
    await canvas.scrollIntoViewIfNeeded();
    await waitForQuietFrames(page);
    const zoomMetrics = await verifyZoomChartViewport(page, canvas);
    console.log(`Live Charts zoom proof: ${JSON.stringify(zoomMetrics)}`);
    await page.screenshot({ path: resolve(artifactRoot, "live-charts-zoom-200.png") });
  } finally {
    await context.close();
  }
}

async function verifyZoomChartViewport(page, canvas) {
  const metrics = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });
  const tolerance = 1;
  const fullyVisible = metrics.width > 0 && metrics.height > 0 &&
    metrics.left >= -tolerance && metrics.top >= -tolerance &&
    metrics.right <= metrics.viewportWidth + tolerance &&
    metrics.bottom <= metrics.viewportHeight + tolerance;
  if (!fullyVisible) {
    throw new Error(`zoom chart axes are clipped: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function verifyNoVisibleErrorNotifications(page) {
  const visibleErrors = page.locator(
    ".fm-notifications__toast[data-kind='error']:visible, .fm-toast[data-variant='error']:visible",
  );
  const count = await visibleErrors.count();
  if (count > 0) {
    throw new Error(`Visible error notification obscures Live Charts: ${(await visibleErrors.allTextContents()).join(" | ")}`);
  }
}

async function setTheme(page, theme) {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current === theme) return;
  const button = page.getByRole("button", { name: `Switch to ${theme} theme` });
  await button.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme, { timeout: timeoutMs });
  await waitForQuietFrames(page);
}

async function collectProof(page, evidence, initialRequests) {
  const geometry = await liveChartGeometry(page);
  const counters = await page.evaluate(() => window.__FULLMAG_LIVE_CHARTS_SMOKE__.counters);
  const readings = await legendReadings(page);
  return {
    apiBase,
    artifactRoot,
    canvas: geometry,
    counters,
    exactValues: EXACT_VALUES,
    failedResponses: evidence.failedResponses.length,
    failedRowsResponses: evidence.failedRowsResponses.length,
    initialRequests,
    readings,
    totalRequests: resourceRequestSnapshot(evidence),
    visibilityCombinations: VISIBILITY_COMBINATIONS,
    workspaceUrl,
  };
}

function validateProof(proof, evidence) {
  const failures = [];
  if (proof.canvas.width <= 0 || proof.canvas.height <= 0) failures.push("Final Live Charts canvas has zero bounds.");
  if (proof.canvas.loadingOverlay) failures.push("Final Live Charts surface has a blocking loading overlay.");
  if (proof.failedResponses > 0) failures.push(`failed responses=${proof.failedResponses}`);
  if (proof.failedRowsResponses > 0) failures.push(`rows.bin failures=${proof.failedRowsResponses}`);
  if (evidence.consoleErrors.length > 0) failures.push(`Browser errors: ${evidence.consoleErrors.join(" | ")}`);
  if (proof.counters.chartInstances !== 1) failures.push(`final ECharts owners=${proof.counters.chartInstances}`);
  if (proof.visibilityCombinations !== 8) failures.push("Visibility matrix did not cover all eight combinations.");
  return failures;
}

async function legendReadings(page) {
  return page.locator(".fm-live-charts .fm-chart-legend__item").evaluateAll((buttons) => buttons.map((button) => ({
    label: button.querySelector(".fm-chart-legend__label")?.textContent?.trim() ?? "",
    unit: button.querySelector(".fm-chart-legend__unit")?.textContent?.trim() ?? "",
    value: button.querySelector(".fm-chart-legend__latest")?.textContent?.trim() ?? "",
  })));
}

function legendButton(page, quantity) {
  return page.locator(".fm-live-charts .fm-chart-legend__item").filter({ has: page.locator(".fm-chart-legend__label", { hasText: new RegExp(`^${quantity}$`) }) }).first();
}

async function showAllSignals(page) {
  for (const quantity of SERIES_IDS) {
    const button = legendButton(page, quantity);
    if ((await button.getAttribute("aria-pressed")) !== "true") {
      await button.focus();
      await page.keyboard.press("Enter");
    }
  }
}

async function liveChartGeometry(page) {
  return page.locator(".fm-live-charts").evaluate((root) => {
    const canvas = root.querySelector(".fm-analysis-chart-surface canvas");
    const surface = root.querySelector(".fm-analysis-chart-surface");
    const retainedHost = root.querySelector("[data-retained='true']");
    const rect = surface?.getBoundingClientRect();
    const loadingOverlay = Array.from(root.querySelectorAll(".fm-analysis-plots__chart-empty")).some((node) => /loading/i.test(node.textContent ?? ""));
    return {
      canvasHeight: canvas instanceof HTMLCanvasElement ? canvas.height : 0,
      canvasWidth: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
      height: rect?.height ?? 0,
      loadingOverlay,
      retained: Boolean(retainedHost),
      width: rect?.width ?? 0,
    };
  });
}

async function waitForQuietFrames(page) {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => window.__FULLMAG_LIVE_CHARTS_SMOKE__?.counters.activeAnimationFrames === 0, undefined, { timeout: timeoutMs });
}

function resourceRequestSnapshot(evidence) {
  const families = {};
  for (const request of evidence.requests) {
    const family = request.path.replace(/\?.*$/, "").replace(/\/rows\.bin$/, "/rows.bin");
    families[family] = (families[family] ?? 0) + 1;
  }
  return families;
}

function rowsRequestsSince(evidence, index) {
  return evidence.requests.slice(index).filter((request) => TABLE_ROWS_PATTERN.test(request.path));
}

async function waitForRowsRequestCount(page, evidence, index, expected) {
  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  while (rowsRequestsSince(evidence, index).length < expected && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(750);
  return rowsRequestsSince(evidence, index).length;
}

function liveChartsOwnedRequestsSince(evidence, index) {
  return evidence.requests.slice(index).filter((request) =>
    LIVE_CHARTS_OWNED_RESOURCE_PATTERNS.some((pattern) => pattern.test(request.path)),
  );
}

function assertNoRequestsSince(evidence, index, action) {
  const requests = liveChartsOwnedRequestsSince(evidence, index);
  if (requests.length > 0) {
    throw new Error(`local interaction issued a resource request (${action}): ${JSON.stringify(requests)}`);
  }
}

function viewportTab(page, label) {
  return page.locator(".fm-viewport-tabs__trigger").filter({ hasText: new RegExp(`^${label}$`) }).first();
}

function currentSessionPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith("/v2/sessions/current/") ? `${parsed.pathname}${parsed.search}` : null;
  } catch {
    return null;
  }
}

function popCount(value) {
  let count = 0;
  for (let current = value; current > 0; current >>= 1) count += current & 1;
  return count;
}

function numbersEqual(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1e-15, Math.abs(expected) * 1e-12);
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

function numericEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

main().catch((error) => {
  console.error(`Live Charts smoke failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
