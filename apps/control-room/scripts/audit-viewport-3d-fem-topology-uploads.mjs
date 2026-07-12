import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const FEM_PART_COUNTS = [1, 10, 100];
const FEM_NODE_COUNT = 4096;
const FEM_MANIFEST_PATH = "/v2/sessions/current/meshing/meshes/shared-domain/manifest";
const PASS_CONFIGS = [
  { id: "surface", points: false, surface: true, wireframe: false },
  { id: "wireframe", points: false, surface: false, wireframe: true },
  { id: "points", points: true, surface: false, wireframe: false },
  { id: "surface-wireframe-points", points: true, surface: true, wireframe: true },
];
const configuredUrl = process.env.CONTROL_ROOM_URL ?? null;
const requestedAuditPort = Number(process.env.CONTROL_ROOM_AUDIT_PORT ?? 0);
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081";
const auditArtifactsDirectory = path.resolve(
  process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ??
    ".artifacts/viewport-3d-browser-audit",
);

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("FEM topology upload audit requires Playwright or @playwright/test.");
  process.exit(2);
}

const managedRuntime = configuredUrl ? null : await startAuditRuntime();
const url = configuredUrl ?? managedRuntime.url;
const browser = await playwright.chromium.launch();
const measurements = [];

try {
  await mkdir(auditArtifactsDirectory, { recursive: true });
  for (const passConfig of PASS_CONFIGS) {
    for (const partCount of FEM_PART_COUNTS) {
      const measurement = await measureFemTopologyUploads({
        browser,
        partCount,
        passConfig,
        url,
      });
      measurements.push(measurement);
      console.log(
        "FEM topology upload measurement:",
        `${passConfig.id} parts=${partCount}`,
        `array=${formatBytes(measurement.gpu.arrayBufferBytesUploaded)}`,
        `element=${formatBytes(measurement.gpu.elementArrayBufferBytesUploaded)}`,
        `draws=${measurement.gpu.drawCalls}`,
      );
    }
  }

  assertPositionUploadPlateau(measurements);
  await writeFile(
    path.join(auditArtifactsDirectory, "fem-topology-upload-metrics.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
  );
  console.log("FEM topology upload audit passed:", `measurements=${measurements.length}`);
} finally {
  await browser.close();
  await managedRuntime?.stop();
}

async function measureFemTopologyUploads({ browser, partCount, passConfig, url }) {
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const fixture = createFemTopologyFixture({ partCount, passConfig });
  const errors = [];
  await installBrowserAuditInstrumentation(page);
  await installFemFixtureApi(page, fixture);
  await page.addInitScript(({ baseUrl }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
      disableRealtime: true,
      disableViewport3DFieldColorLayers: true,
      disableViewport3DPrimitiveObjectLayer: true,
      disableViewport3DVectorLayers: true,
    };
  }, { baseUrl: apiBase });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const canvas = page.locator(".fm-viewport-3d canvas");
    await canvas.waitFor({ state: "visible", timeout: 20_000 });
    await waitForViewportDiagnostics(page);
    await waitForCondition(
      async () => {
        const manifest = await page.evaluate((resourceKey) =>
          window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource(resourceKey),
          FEM_MANIFEST_PATH,
        );
        return manifest?.status === "ready" && manifest?.data?.mesh_parts?.length === partCount;
      },
      15_000,
      async () => {
        const diagnostics = await readViewportDiagnostics(page);
        const manifest = await page.evaluate((resourceKey) =>
          window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource(resourceKey),
          FEM_MANIFEST_PATH,
        );
        return `FEM ${passConfig.id} fixture did not mount ${partCount} mesh-part geometries: ${diagnostics.raw}; manifest=${JSON.stringify(manifest)}; requests=${fixture.requests.slice(0, 100).join(",")}`;
      },
    );
    const diagnostics = await readViewportDiagnostics(page);
    const gpu = await readBrowserAuditCounters(page);
    if (gpu.drawCalls <= 0) {
      throw new Error(`FEM ${passConfig.id} fixture with ${partCount} parts produced no WebGL draw calls.`);
    }
    if (gpu.arrayBufferBytesUploaded <= 0) {
      throw new Error(`FEM ${passConfig.id} fixture with ${partCount} parts uploaded no ARRAY_BUFFER bytes.`);
    }
    if (gpu.drawCalls < partCount) {
      throw new Error(
        `FEM ${passConfig.id} fixture rendered ${gpu.drawCalls} WebGL draw calls for ${partCount} mesh parts.`,
      );
    }
    if (errors.length > 0) {
      throw new Error(`FEM browser fixture emitted errors:\n${errors.join("\n")}`);
    }
    return {
      expectedPositionBytes: fixture.expectedPositionBytes,
      diagnostics,
      gpu,
      partCount,
      pass: passConfig.id,
    };
  } finally {
    await page.close();
  }
}

function assertPositionUploadPlateau(measurements) {
  for (const passConfig of PASS_CONFIGS) {
    const samples = measurements
      .filter((measurement) => measurement.pass === passConfig.id)
      .sort((left, right) => left.partCount - right.partCount);
    if (samples.length !== FEM_PART_COUNTS.length) {
      throw new Error(`Missing FEM upload samples for ${passConfig.id}.`);
    }
    const first = samples[0];
    const last = samples.at(-1);
    const allowedPositionBytes =
      first.gpu.arrayBufferBytesUploaded + first.expectedPositionBytes * 2;
    if (last.gpu.arrayBufferBytesUploaded > allowedPositionBytes) {
      throw new Error(
        `Position upload grew with FEM part count for ${passConfig.id}: ` +
          `${first.partCount} parts=${formatBytes(first.gpu.arrayBufferBytesUploaded)}, ` +
          `${last.partCount} parts=${formatBytes(last.gpu.arrayBufferBytesUploaded)}, ` +
          `allowed=${formatBytes(allowedPositionBytes)}.`,
      );
    }
  }
}

function createFemTopologyFixture({ partCount, passConfig }) {
  const topology = makeFemTopologyBuffer(partCount);
  const visualizationState = {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [3.2, 2.8, 2.4],
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
      bounds: { visible: false },
      points: { visible: passConfig.points },
      quantity_overlay: { visible: false },
      surface: { opacity: 0.94, visible: passConfig.surface },
      vectors: { density: 1, domain: "full_domain", visible: false },
      wireframe: { visible: passConfig.wireframe },
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
    targets: {
      airbox: {
        label: "Airbox",
        scope: "airbox",
        scope_id: "airbox",
        settings: femTopologyTargetSettings({ points: false, surface: false, wireframe: false }),
        source: "airbox",
      },
      objects: [],
      parts: Array.from({ length: partCount }, (_, index) => ({
        label: `Part ${index + 1}`,
        scope: "part",
        scope_id: `part-${index}`,
        settings: femTopologyTargetSettings(passConfig),
        source: "mesh_part",
      })),
    },
    trim: { enabled: false, max: [1, 1, 1], min: [0, 0, 0] },
    vector_density: 1,
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
  return {
    expectedPositionBytes: FEM_NODE_COUNT * 3 * Float32Array.BYTES_PER_ELEMENT,
    manifest: {
      domain_mesh_mode: "shared_domain",
      generation_id: "1",
      mesh_id: "fem-topology-upload-mesh",
      mesh_name: "FEM topology upload fixture",
      mesh_parts: Array.from({ length: partCount }, (_, index) => ({
        boundary_face_count: 1,
        boundary_face_indices: [index],
        boundary_face_start: index,
        bounds_max: [1, 1, 1],
        bounds_min: [-1, -1, -1],
        element_count: 1,
        element_start: 0,
        geometry_id: `fem-object-${index}_geom`,
        id: `part-${index}`,
        label: `Part ${index + 1}`,
        material_id: "fem-material",
        node_count: FEM_NODE_COUNT,
        node_indices: [0, 1, 2, 3],
        node_start: 0,
        object_id: `fem-object-${index}`,
        role: "magnetic",
        surface_faces: [[0, 1, 2]],
      })),
      object_segments: [],
      regions: [],
      revision: 1,
      source_scene_revision: 1,
      topology_fingerprint: "fem-topology-upload-fixture-v1",
    },
    scene: {
      objects: Array.from({ length: partCount }, (_, index) => ({
        id: `fem-object-${index}`,
        name: `FEM object ${index + 1}`,
        visible: true,
      })),
      revision: 1,
      schema_version: 1,
    },
    requests: [],
    topology,
    visualizationState,
  };
}

function femTopologyTargetSettings({ points, surface, wireframe }) {
  return {
    active_quantity_id: "m",
    bounds_visible: false,
    geometry_scope: "surface",
    opacity: 1,
    point_color: "#ffffff",
    points_visible: points,
    render_mode: surface ? "surface" : wireframe ? "wireframe" : "points",
    scalar_color_palette: "viridis",
    surface_color_source: "solid",
    surface_mono_color: "#ffffff",
    surface_projection_mode: "raw_nodal",
    surface_visible: surface,
    vector_alpha: 1,
    vector_budget: 0,
    vector_color_mode: "orientation",
    vector_length_scale: 1,
    vector_mono_color: "#ffffff",
    vector_thickness: 1,
    vectors_visible: false,
    viewport_colorbar_visible: false,
    visible: true,
    wireframe_color: "#ffffff",
    wireframe_opacity: 1,
    wireframe_visible: wireframe,
  };
}

function makeFemTopologyBuffer(partCount) {
  const nodeCount = FEM_NODE_COUNT;
  const elementCount = 1;
  const boundaryFaceCount = partCount;
  const markerCount = 1;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, markerCount, true);
  view.setUint32(24, markerCount, true);

  let offset = 32;
  const positions = new Float64Array(buffer, offset, nodeCount * 3);
  positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let node = 4; node < nodeCount; node += 1) {
    const row = node % 64;
    const column = Math.floor(node / 64);
    positions[node * 3] = row / 64;
    positions[node * 3 + 1] = column / 64;
    positions[node * 3 + 2] = 0.25;
  }
  offset += positions.byteLength;
  new Uint32Array(buffer, offset, 4).set([0, 1, 2, 3]);
  offset += 4 * Uint32Array.BYTES_PER_ELEMENT;
  const boundaryFaces = new Uint32Array(buffer, offset, boundaryFaceCount * 3);
  for (let face = 0; face < boundaryFaceCount; face += 1) {
    boundaryFaces.set([0, 1, 2], face * 3);
  }
  offset += boundaryFaces.byteLength;
  new Uint32Array(buffer, offset, 1).set([1]);
  offset += Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([1]);
  return buffer;
}

async function installFemFixtureApi(page, fixture) {
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const requestPath = requestUrl.pathname;
    fixture.requests.push(requestPath);
    if (request.method() === "OPTIONS") return fulfillEmpty(route, 204);
    if (requestPath === "/v2/sessions/current/status") return fulfillJson(route, femStatusFixture());
    if (requestPath === "/v2/sessions/current/visualization/state") return fulfillJson(route, fixture.visualizationState);
    if (requestPath === "/v2/sessions/current/data/domain/meta") return fulfillJson(route, femDomainMetaFixture());
    if (requestPath === "/v2/sessions/current/data/domain/topology") return fulfillBinary(route, fixture.topology);
    if (requestPath === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") return fulfillJson(route, fixture.manifest);
    if (requestPath === "/v2/sessions/current/model/scene") {
      return fulfillJson(route, fixture.scene);
    }
    if (requestPath === "/v2/sessions/current/model/universe") {
      return fulfillJson(route, { mesh_dirty: false, object_bounds_max: [1, 1, 1], object_bounds_min: [-1, -1, -1], scene_revision: 1, study_universe_mesh: null, universe: null });
    }
    return fulfillEmpty(route, 204);
  });
}

function femStatusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: { algorithms_available: [], binary_fields: true, cell_fields: true, eigen_modes: false, explicit_topology: true, gpu_telemetry: false, node_fields: true, preview_2d: false, preview_3d: true, scalar_history: false, structured_grid: false },
    display: { active_quantity_id: "m", auto_contrast: true, colormap: "viridis", contrast_max: null, contrast_min: null, field_component: "magnitude", max_points: 120000, slice_layer: 0, slice_mode: "xy", vector_density: 1, vector_glyphs: false, view_mode: "3d", x_chosen_size: 1, y_chosen_size: 1 },
    domain: { cell_count: 1, discretization: "fem", generation_id: 1 },
    energies: {},
    metrics: { steps_per_second: null, total_steps: 0, uptime_seconds: 0 },
    resources: { artifact_revision: 0, artifacts_revision: 0, command_completion_revision: 0, commands_revision: 0, display_revision: 1, domain_generation_id: 1, engine_log_revision: 0, field_catalog_revision: 1, field_revision: 1, fields_revision: 1, mesh_build_revision: 1, mesh_revision: 1, scalars_revision: 0, scene_revision: 1, slice_revision: 0, stages_revision: 0, topology_revision: 1, visualization_state_revision: 1, workspace_revision: 0 },
    run: null,
    runtime_bundle_version: "fem-topology-upload-fixture",
    session: { created_at: "0", name: "FEM topology upload fixture", session_id: "fem-topology-upload-fixture", workspace_root: "/tmp/fullmag-fem-topology-upload-fixture" },
    solver: { state: "idle" },
  };
}

function femDomainMetaFixture() {
  return {
    bounds: { max: [1, 1, 1], min: [-1, -1, -1] },
    coordinate_system: "cartesian",
    counts: { cells: 1, nodes: FEM_NODE_COUNT },
    dimension: 3,
    discretization: "fem",
    domain_id: "fem-topology-upload-domain",
    generation_id: 1,
    units: { length: "m" },
  };
}

async function installBrowserAuditInstrumentation(page) {
  await page.addInitScript(() => {
    const counters = { arrayBufferBytesUploaded: 0, bufferBytesUploaded: 0, buffersCreated: 0, drawCalls: 0, elementArrayBufferBytesUploaded: 0 };
    window.__FM_VIEWPORT_BROWSER_AUDIT__ = counters;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = originalGetContext.apply(this, args);
      if (!context || !["webgl", "webgl2", "experimental-webgl"].includes(String(args[0]))) return context;
      const gl = context;
      if (gl.__fullmagFemTopologyAuditWrapped) return gl;
      gl.__fullmagFemTopologyAuditWrapped = true;
      for (const name of ["createBuffer", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          if (name === "createBuffer") counters.buffersCreated += 1;
          if (name.startsWith("draw")) counters.drawCalls += 1;
          return original.apply(this, methodArgs);
        };
      }
      for (const name of ["bufferData", "bufferSubData"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          const target = methodArgs[0];
          const data = methodArgs[1];
          const byteLength = typeof data === "number" ? data : Number(data?.byteLength ?? 0);
          counters.bufferBytesUploaded += byteLength;
          if (target === gl.ARRAY_BUFFER) counters.arrayBufferBytesUploaded += byteLength;
          if (target === gl.ELEMENT_ARRAY_BUFFER) counters.elementArrayBufferBytesUploaded += byteLength;
          return original.apply(this, methodArgs);
        };
      }
      return gl;
    };
  });
}

async function waitForViewportDiagnostics(page) {
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".fm-viewport-3d__hud span")).some((node) => node.textContent?.includes("geo:")), undefined, { timeout: 20_000 });
}

async function readBrowserAuditCounters(page) {
  return page.evaluate(() => ({ ...(window.__FM_VIEWPORT_BROWSER_AUDIT__ ?? {}) }));
}

async function readViewportDiagnostics(page) {
  const raw = await page.locator(".fm-viewport-3d__hud span").evaluateAll((nodes) =>
    nodes.find((node) => node.textContent?.includes("geo:"))?.textContent ?? "",
  );
  const match = raw.match(/(?:^|\s)geo:(\d+)/);
  return { geo: Number(match?.[1] ?? 0), raw };
}

async function waitForCondition(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(typeof message === "function" ? await message() : message);
}

function formatBytes(value) {
  const bytes = Math.max(0, Math.round(Number(value)));
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), headers: fixtureHeaders({ "content-type": "application/json" }), status });
}

async function fulfillBinary(route, arrayBuffer, status = 200) {
  await route.fulfill({ body: Buffer.from(arrayBuffer), headers: fixtureHeaders({ "content-type": "application/octet-stream" }), status });
}

async function fulfillEmpty(route, status = 204) {
  await route.fulfill({ body: "", headers: fixtureHeaders(), status });
}

function fixtureHeaders(extra = {}) {
  return { "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-allow-origin": "*", "access-control-expose-headers": "x-api-contract-version,etag,x-request-id", "x-api-contract-version": "1.0.0", ...extra };
}

async function loadPlaywright() {
  try { return await import("playwright"); } catch {
    try { return await import("@playwright/test"); } catch { return null; }
  }
}

async function startAuditRuntime() {
  await runPnpm(["run", "build:audit:webpack"], { NEXT_PUBLIC_AUDIT_BUILD: "1" });
  const port = await reserveAuditPort(requestedAuditPort);
  const child = spawn("pnpm", ["exec", "next", "start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, NEXT_PUBLIC_AUDIT_BUILD: "1" }, stdio: "pipe" });
  const serverUrl = `http://localhost:${port}/workspace`;
  try { await waitForHttp(serverUrl, 30_000, child); } catch (error) { child.kill("SIGTERM"); throw error; }
  return { url: serverUrl, async stop() { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } } };
}

function reserveAuditPort(requestedPort) {
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

function runPnpm(args, extraEnvironment) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, { cwd: process.cwd(), env: { ...process.env, ...extraEnvironment }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(`pnpm ${args.join(" ")} exited with ${code ?? "signal"}.`)));
  });
}

async function waitForHttp(targetUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) throw new Error(`Audit server exited with ${child.exitCode}.`);
    try { if ((await fetch(targetUrl, { redirect: "manual" })).status < 500) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${targetUrl}.`);
}
