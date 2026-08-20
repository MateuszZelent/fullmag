import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import {
  captureViewportPerformanceSnapshot,
  installViewportPerformanceProbe,
} from "./lib/viewport-performance-proof.mjs";

const FEM_PART_COUNTS = [1, 10, 100];
const FEM_NODE_COUNT = 4096;
const FEM_MANIFEST_PATH = "/v2/sessions/current/meshing/meshes/shared-domain/manifest";
const PICK_SCAN_COLUMNS = 32;
const PICK_SCAN_ROWS = 24;
const PASS_CONFIGS = [
  { id: "surface", points: false, surface: true, wireframe: false },
  { id: "wireframe", points: false, surface: false, wireframe: true },
  { id: "points", points: true, surface: false, wireframe: false },
  { id: "surface-wireframe-points", points: true, surface: true, wireframe: true },
];
const configuredUrl = process.env.CONTROL_ROOM_URL ?? null;
const semanticOnly = process.env.CONTROL_ROOM_AUDIT_SEMANTIC_ONLY === "1";
const preCanvasOnly = process.env.CONTROL_ROOM_AUDIT_PRE_CANVAS_ONLY === "1";
const requestedAuditPort = Number(process.env.CONTROL_ROOM_AUDIT_PORT ?? 0);
const browserExecutablePath =
  process.env.CONTROL_ROOM_BROWSER_EXECUTABLE_PATH?.trim() ?? "";
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
const browser = await playwright.chromium.launch({
  executablePath: browserExecutablePath || undefined,
});
const measurements = [];

try {
  await mkdir(auditArtifactsDirectory, { recursive: true });
  for (const passConfig of semanticOnly || preCanvasOnly ? [] : PASS_CONFIGS) {
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

  if (!semanticOnly && !preCanvasOnly) assertPositionUploadPlateau(measurements);
  const semanticTargetExplorerProof = preCanvasOnly
    ? null
    : await verifySemanticTargetExplorerInvariant({ browser, url });
  const preCanvasErrorBoundaryProof = await verifyViewport3DPreCanvasErrorBoundary({
    browser,
    url,
  });
  await writeFile(
    path.join(auditArtifactsDirectory, "fem-topology-upload-metrics.json"),
    `${JSON.stringify({ measurements, preCanvasErrorBoundaryProof, rawPerformanceTrace: measurements.map((measurement) => measurement.rawPerformanceTrace), semanticTargetExplorerProof }, null, 2)}\n`,
  );
  console.log("FEM topology upload audit passed:", `measurements=${measurements.length}`);
} finally {
  await browser.close();
  await managedRuntime?.stop();
}

async function verifyViewport3DPreCanvasErrorBoundary({ browser, url }) {
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const fixture = createSemanticTargetExplorerFixture();
  await installFemFixtureApi(page, fixture);
  await page.addInitScript(({ baseUrl }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
      diagnosticRecorderScenario: "viewport-3d-pre-canvas-negative-control",
      disableRealtime: true,
      enableAuditHooks: true,
      enableDiagnosticRecorder: true,
      injectViewport3DRenderError: true,
    };
  }, { baseUrl: apiBase });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const alert = page.locator(".fm-viewport-3d__error-boundary");
    await alert.waitFor({ state: "visible", timeout: 20_000 });
    const text = await alert.innerText();
    if (!text.includes("Maximum update depth exceeded")) {
      throw new Error(`Pre-canvas boundary did not expose the injected failure: ${text}`);
    }
    if (await page.locator(".fm-viewport-3d canvas").count()) {
      throw new Error("Pre-canvas negative control unexpectedly mounted a canvas.");
    }
    const records = await page.evaluate(
      () =>
        window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.().streams?.console ?? [],
    );
    const record = records.find(
      (entry) =>
        entry.name === "viewport-3d.render-error" &&
        String(entry.message).includes("Maximum update depth exceeded"),
    );
    if (!record?.detail?.componentStack || !record?.detail?.errorStack) {
      throw new Error(
        `Pre-canvas failure did not publish bounded component/error stacks: ${JSON.stringify(record ?? null)}`,
      );
    }
    await page.screenshot({
      path: path.join(auditArtifactsDirectory, "viewport-3d-pre-canvas-error-boundary.png"),
    });
    return {
      canvasCount: 0,
      componentStackBytes: String(record.detail.componentStack).length,
      errorStackBytes: String(record.detail.errorStack).length,
      message: record.message,
      retryVisible: await alert.getByRole("button", { name: "Retry viewport" }).isVisible(),
    };
  } finally {
    await page.close();
  }
}

async function verifySemanticTargetExplorerInvariant({ browser, url }) {
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const fixture = createSemanticTargetExplorerFixture();
  const expectedNodeIds = new Set([
    "model:airbox",
    "model:object:semantic-magnet",
    "model:mesh:unassigned:semantic-orphan",
  ]);
  const selectedNodeIds = new Set();
  const errors = [];
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
    if (message.type() === "error") {
      const location = message.location();
      errors.push(`${message.text()} @ ${location.url || "unknown"}:${location.lineNumber ?? "?"}`);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const canvas = page.locator(".fm-viewport-3d canvas");
    await canvas.waitFor({ state: "visible", timeout: 20_000 });
    await waitForViewportDiagnostics(page);
    const webgl = await canvas.evaluate((element) => {
      const gl =
        element.getContext("webgl2") ??
        element.getContext("webgl") ??
        element.getContext("experimental-webgl");
      return {
        drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
        drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
        isContextLost: gl ? gl.isContextLost() : true,
      };
    });
    if (
      webgl.isContextLost ||
      webgl.drawingBufferWidth <= 0 ||
      webgl.drawingBufferHeight <= 0
    ) {
      throw new Error(`Semantic target fixture WebGL is not renderable: ${JSON.stringify(webgl)}`);
    }

    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("Semantic target fixture canvas has no bounds.");
    for (let row = 5; row < 20 && selectedNodeIds.size < expectedNodeIds.size; row += 1) {
      for (let column = 4; column < 26 && selectedNodeIds.size < expectedNodeIds.size; column += 1) {
        const offsetX = (canvasBox.width * column) / PICK_SCAN_COLUMNS;
        const offsetY = (canvasBox.height * row) / PICK_SCAN_ROWS;
        if (offsetX >= canvasBox.width - 240 && offsetY <= 240) continue;
        await page.mouse.click(
          canvasBox.x + offsetX,
          canvasBox.y + offsetY,
        );
        const selected = await page
          .locator('[data-node-id][aria-selected="true"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-node-id")).filter(Boolean),
          );
        for (const nodeId of selected) {
          if (expectedNodeIds.has(nodeId)) selectedNodeIds.add(nodeId);
        }
      }
    }

    for (const nodeId of expectedNodeIds) {
      if (!selectedNodeIds.has(nodeId)) {
        await page.screenshot({
          path: path.join(auditArtifactsDirectory, "semantic-target-selection-failure.png"),
        });
        const diagnostics = await readViewportDiagnostics(page);
        const selectedRows = await page
          .locator('[data-node-id][aria-selected="true"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-node-id")).filter(Boolean),
          );
        throw new Error(
          `Canvas picking did not reveal ${nodeId}; selected=${[...selectedNodeIds].join(",") || "none"}; active=${selectedRows.join(",") || "none"}; diagnostics=${diagnostics.raw}.`,
        );
      }
      const row = page.locator(`[data-node-id="${nodeId}"]`);
      await row.waitFor({ state: "visible", timeout: 5_000 });
    }
    const boundaryFacesRow = page.locator('[data-node-id="model:boundary-faces"]');
    await boundaryFacesRow.waitFor({ state: "visible", timeout: 5_000 });
    const boundaryFacesStatus = await boundaryFacesRow.getAttribute("data-status");
    if (boundaryFacesStatus !== "mesh-ready") {
      throw new Error(
        `Boundary Faces Explorer row is not mesh-ready: ${boundaryFacesStatus ?? "missing"}`,
      );
    }
    const leakedOuterBoundary = page.locator(
      '[data-node-id="model:mesh:unassigned:semantic-outer-boundary"]',
    );
    if (await leakedOuterBoundary.count()) {
      throw new Error("Outer boundary leaked into Unassigned mesh.");
    }
    const leakedAirboxSegment = page.locator(
      '[data-node-id="model:mesh:unassigned:segment%3A__air__%3A0"]',
    );
    if (await leakedAirboxSegment.count()) {
      throw new Error("The production __air__ object segment leaked into Unassigned mesh.");
    }
    const airboxRows = page.locator('[data-node-id="model:airbox"]');
    if ((await airboxRows.count()) !== 1) {
      throw new Error(
        `Expected one canonical Airbox Explorer row, found ${await airboxRows.count()}.`,
      );
    }
    await boundaryFacesRow.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-node-id="model:boundary-faces"]')
          ?.getAttribute("aria-selected") === "true",
      undefined,
      { timeout: 5_000 },
    );
    const boundaryFacesInspector = page.locator(".fm-inspector-panel", {
      hasText: "Boundary Faces Overview",
    });
    await boundaryFacesInspector.waitFor({ state: "visible", timeout: 5_000 });
    const boundaryFacesInspectorText = await boundaryFacesInspector.innerText();
    if (!boundaryFacesInspectorText.includes("not an Airbox or unassigned mesh target")) {
      throw new Error(
        `Boundary Faces Inspector did not expose its Universe scope: ${boundaryFacesInspectorText}`,
      );
    }
    const boundaryFacesFields = Object.fromEntries(
      await boundaryFacesInspector
        .locator(".fm-inspector-field-row")
        .evaluateAll((rows) =>
          rows.map((row) => [
            row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "",
            row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? "",
          ]),
        ),
    );
    const expectedBoundaryFacesFields = {
      "Boundary faces": "4",
      "Manifest state": "ready",
      "Realized carriers": "1",
    };
    for (const [label, expectedValue] of Object.entries(expectedBoundaryFacesFields)) {
      if (boundaryFacesFields[label] !== expectedValue) {
        throw new Error(
          `Boundary Faces Inspector field ${label}=${JSON.stringify(boundaryFacesFields[label])}; expected ${expectedValue}.`,
        );
      }
    }
    const postInteractionWebgl = await canvas.evaluate((element) => {
      const gl =
        element.getContext("webgl2") ??
        element.getContext("webgl") ??
        element.getContext("experimental-webgl");
      return {
        drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
        drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
        isContextLost: gl ? gl.isContextLost() : true,
      };
    });
    if (
      postInteractionWebgl.isContextLost ||
      postInteractionWebgl.drawingBufferWidth <= 0 ||
      postInteractionWebgl.drawingBufferHeight <= 0
    ) {
      throw new Error(
        `Boundary Faces interaction left WebGL unrenderable: ${JSON.stringify(postInteractionWebgl)}`,
      );
    }
    await page.screenshot({
      path: path.join(
        auditArtifactsDirectory,
        "semantic-target-boundary-faces-success.png",
      ),
    });
    const diagnostics = await readViewportDiagnostics(page);
    if (diagnostics.raw.includes("unaddressable-render-target:")) {
      throw new Error(`Addressable fixture emitted rejection: ${diagnostics.raw}`);
    }
    if (errors.length > 0) {
      throw new Error(`Semantic target fixture emitted errors:\n${errors.join("\n")}`);
    }
    console.log(
      "Semantic target Explorer invariant passed:",
      [...selectedNodeIds].sort().join(","),
    );
    return {
      boundaryFacesExplorerNodeId: "model:boundary-faces",
      boundaryFacesFields,
      boundaryFacesInspectorVisible: true,
      canonicalAirboxExplorerNodeCount: 1,
      leakedAirboxSegmentNodeCount: 0,
      outerBoundaryUnassignedNodeCount: 0,
      selectedNodeIds: [...selectedNodeIds].sort(),
      webgl: postInteractionWebgl,
    };
  } finally {
    await page.close();
  }
}

async function measureFemTopologyUploads({ browser, partCount, passConfig, url }) {
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const fixture = createFemTopologyFixture({ partCount, passConfig });
  const errors = [];
  await installBrowserAuditInstrumentation(page);
  await installViewportPerformanceProbe(page);
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
    const rawPerformanceTrace = [
      await captureViewportPerformanceSnapshot(page, `${passConfig.id}:parts=${partCount}`),
    ];
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
      rawPerformanceTrace,
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

function createSemanticTargetExplorerFixture() {
  const passConfig = { points: false, surface: true, wireframe: true };
  const targetSettings = femTopologyTargetSettings(passConfig);
  const meshParts = [
    semanticFixturePart({
      faceIndex: 0,
      id: "part:__air__",
      label: "Airbox",
      nodeStart: 0,
      role: "air",
    }),
    semanticFixturePart({
      faceIndex: 1,
      id: "semantic-magnetic-part",
      label: "Semantic magnet",
      nodeStart: 4,
      objectId: "semantic-magnet",
      role: "magnetic",
    }),
    semanticFixturePart({
      faceIndex: 2,
      id: "semantic-orphan",
      label: "Semantic orphan",
      nodeStart: 8,
      objectId: "deleted-semantic-object",
      role: "magnetic",
    }),
    semanticFixturePart({
      faceIndex: 2,
      id: "semantic-outer-boundary",
      label: "Outer Boundary",
      nodeStart: 8,
      role: "outer_boundary",
    }),
  ];
  return {
    domainMeta: {
      ...femDomainMetaFixture(),
      bounds: { max: [4, 2, 1], min: [-4, -2, -1] },
      counts: { cells: 0, nodes: 12 },
      generation_id: "semantic-target-fixture-v1",
    },
    expectedPositionBytes: 12 * 3 * Float32Array.BYTES_PER_ELEMENT,
    manifest: {
      domain_mesh_mode: "shared_domain",
      generation_id: "semantic-target-fixture-v1",
      mesh_id: "semantic-target-fixture",
      mesh_name: "Semantic target Explorer fixture",
      mesh_parts: meshParts,
      object_segments: [
        {
          boundary_face_count: meshParts[0].boundary_face_count,
          boundary_face_start: meshParts[0].boundary_face_start,
          element_count: meshParts[0].element_count,
          element_start: meshParts[0].element_start,
          geometry_id: null,
          node_count: meshParts[0].node_count,
          node_start: meshParts[0].node_start,
          object_id: "__air__",
        },
      ],
      regions: [],
      revision: 1,
      source_scene_revision: 1,
      topology_fingerprint: "semantic-target-fixture-v1",
    },
    requests: [],
    scene: {
      objects: [
        { id: "semantic-magnet", name: "Semantic magnet", visible: true },
        { id: "__air__", name: "Synthetic air", role: "air", visible: true },
      ],
      revision: 1,
      schema_version: 1,
    },
    topology: makeSemanticTargetTopologyBuffer(),
    visualizationState: {
      ...createFemTopologyFixture({ partCount: 1, passConfig }).visualizationState,
      camera: {
        position: [0, 0, 10],
        projection: "perspective",
        target: [0, 0, 0],
        up: [0, 1, 0],
      },
      layers: {
        ...createFemTopologyFixture({ partCount: 1, passConfig }).visualizationState.layers,
        airbox: {
          points: { visible: false },
          surface: { opacity: 0.35, visible: true },
          vectors: { density: 0, domain: "airbox_only", visible: false },
          visible: true,
          wireframe: { visible: true },
        },
      },
      targets: {
        airbox: {
          label: "Airbox",
          scope: "airbox",
          scope_id: "airbox",
          settings: targetSettings,
          source: "airbox",
        },
        objects: [
          {
            label: "Semantic magnet",
            scope: "object",
            scope_id: "semantic-magnet",
            settings: targetSettings,
            source: "scene_object",
          },
        ],
        parts: [
          {
            label: "Semantic orphan",
            scope: "part",
            scope_id: "semantic-orphan",
            settings: targetSettings,
            source: "mesh_part",
          },
        ],
      },
    },
  };
}

function semanticFixturePart({ faceIndex, id, label, nodeStart, objectId = null, role }) {
  const surfaceFaces = tetraSurfaceFaces(nodeStart);
  const boundaryFaceStart = faceIndex * surfaceFaces.length;
  return {
    boundary_face_count: surfaceFaces.length,
    boundary_face_indices: surfaceFaces.map((_, index) => boundaryFaceStart + index),
    boundary_face_start: boundaryFaceStart,
    bounds_max: [4, 1, 0.5],
    bounds_min: [-4, -1, -0.5],
    element_count: 0,
    element_start: 0,
    geometry_id: objectId,
    id,
    label,
    material_id: role === "air" ? null : "semantic-material",
    node_count: 4,
    node_indices: [nodeStart, nodeStart + 1, nodeStart + 2, nodeStart + 3],
    node_start: nodeStart,
    object_id: objectId,
    role,
    surface_faces: surfaceFaces,
  };
}

function tetraSurfaceFaces(nodeStart) {
  return [
    [nodeStart, nodeStart + 2, nodeStart + 1],
    [nodeStart, nodeStart + 1, nodeStart + 3],
    [nodeStart + 1, nodeStart + 2, nodeStart + 3],
    [nodeStart + 2, nodeStart, nodeStart + 3],
  ];
}

function makeSemanticTargetTopologyBuffer() {
  const positions = [
    -2.7, -2.7, -1.6, -1.3, -2.7, -1.6, -2, -1.3, -1.6, -2, -2, -0.2,
    1.3, -2.7, -1.6, 2.7, -2.7, -1.6, 2, -1.3, -1.6, 2, -2, -0.2,
    -0.7, 1.3, 0.4, 0.7, 1.3, 0.4, 0, 2.7, 0.4, 0, 2, 1.8,
  ];
  const surfaceFaces = [
    ...tetraSurfaceFaces(0),
    ...tetraSurfaceFaces(4),
    ...tetraSurfaceFaces(8),
  ];
  const nodeCount = 12;
  const elementCount = 0;
  const boundaryFaceCount = surfaceFaces.length;
  const markerCount = boundaryFaceCount;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT * 2;
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
  view.setUint32(24, markerCount, true);
  let offset = 32;
  new Float64Array(buffer, offset, positions.length).set(positions);
  offset += positions.length * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount * 3).set(surfaceFaces.flat());
  offset += boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, markerCount).fill(1);
  offset += markerCount * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, markerCount).fill(1);
  return buffer;
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
    if (requestPath === "/v2/sessions/current/data/domain/meta") return fulfillJson(route, fixture.domainMeta ?? femDomainMetaFixture());
    if (requestPath === "/v2/sessions/current/data/domain/topology") return fulfillTopology(route, fixture.topology);
    if (requestPath === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") return fulfillJson(route, fixture.manifest);
    if (requestPath === "/v2/sessions/current/model/scene") {
      return fulfillJson(route, fixture.scene);
    }
    if (requestPath === "/v2/sessions/current/model/universe") {
      const bounds = fixture.domainMeta?.bounds ?? femDomainMetaFixture().bounds;
      return fulfillJson(route, { mesh_dirty: false, object_bounds_max: bounds.max, object_bounds_min: bounds.min, scene_revision: 1, study_universe_mesh: null, universe: null });
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

async function fulfillTopology(route, topology) {
  const range = route.request().headers().range;
  const etag = '"fem-topology-upload-fixture"';
  if (!range) {
    return fulfillBinary(route, topology, 200, { etag });
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) {
    return route.fulfill({
      body: "",
      headers: fixtureHeaders({ "content-range": `bytes */${topology.byteLength}`, etag }),
      status: 416,
    });
  }
  const start = Number(match[1]);
  const requestedEnd = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= topology.byteLength) {
    return route.fulfill({
      body: "",
      headers: fixtureHeaders({ "content-range": `bytes */${topology.byteLength}`, etag }),
      status: 416,
    });
  }
  const end = Math.min(requestedEnd, topology.byteLength - 1);
  return fulfillBinary(route, topology.slice(start, end + 1), 206, {
    "content-range": `bytes ${start}-${end}/${topology.byteLength}`,
    etag,
  });
}

async function fulfillBinary(route, arrayBuffer, status = 200, extraHeaders = {}) {
  await route.fulfill({ body: Buffer.from(arrayBuffer), headers: fixtureHeaders({ "content-type": "application/octet-stream", ...extraHeaders }), status });
}

async function fulfillEmpty(route, status = 204) {
  await route.fulfill({ body: "", headers: fixtureHeaders(), status });
}

function fixtureHeaders(extra = {}) {
  return { "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-allow-origin": "*", "access-control-expose-headers": "content-range,etag,x-api-contract-version,x-request-id", "x-api-contract-version": "1.0.0", ...extra };
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
