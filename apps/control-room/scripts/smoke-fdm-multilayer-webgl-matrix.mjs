import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exactVisualizationAdoptionMatches } from "./smoke-fdm-terminal-webgl-gate.mjs";

const apiBase = (process.env.CONTROL_ROOM_API_BASE_URL ?? "http://127.0.0.1:18284").replace(/\/$/, "");
const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3284/workspace";
const artifactDir = process.env.CONTROL_ROOM_FDM_MULTILAYER_MATRIX_ARTIFACT_DIR ??
  "apps/control-room/.artifacts/fdm-multilayer-webgl-matrix";
const evidencePath = process.env.CONTROL_ROOM_FDM_MULTILAYER_MATRIX_EVIDENCE ??
  ".superpowers/sdd/evidence/fdm-multilayer-webgl-matrix.json";
const timeoutMs = Number(process.env.CONTROL_ROOM_FDM_MULTILAYER_MATRIX_TIMEOUT_MS ?? 180_000);
const vectorBudget = Number(process.env.CONTROL_ROOM_FDM_MULTILAYER_MATRIX_VECTOR_BUDGET ?? 256);
const diagnosticReadbackMode = process.env.CONTROL_ROOM_FDM_MULTILAYER_DIAGNOSTIC_READBACK_MODE ?? "per-case";
const diagnosticTracePath = process.env.CONTROL_ROOM_FDM_MULTILAYER_DIAGNOSTIC_TRACE_PATH ?? null;
const selfTestOnly = process.env.CONTROL_ROOM_FDM_MULTILAYER_SELF_TEST_ONLY === "1";
const airboxOnly = process.env.CONTROL_ROOM_FDM_MULTILAYER_AIRBOX_ONLY === "1";
const expectedBuildIdentity = expectedBuildIdentityFromEnvironment();
const expectedSourceSnapshotPath = process.env.CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_SOURCE_SNAPSHOT_PATH ?? null;
const expectedRuntimeBinarySha256 = process.env.CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_RUNTIME_BINARY_SHA256 ?? null;
if (!["per-case", "none", "deferred"].includes(diagnosticReadbackMode)) {
  throw new Error(`Unsupported diagnostic readback mode: ${diagnosticReadbackMode}`);
}
const canvasSelector = ".fm-viewport-3d canvas";
const airboxDebugTarget = {
  debugInspectorOwner: "airbox.visualization.debug",
  debugNodeId: "model:airbox:visualization:debug",
  inspectorOwner: "airbox.visualization",
  nodeId: "model:airbox:visualization",
  parentNodeIds: ["model:airbox"],
  targetId: "airbox",
};
const quantities = ["m", "H_demag"];
const geometries = ["surface", "wireframe", "points"];
const presentations = ["field", "vector"];
const terminalCommandStatuses = new Set(["cancelled", "completed", "failed", "rejected", "skipped"]);
const attemptState = {
  compute_fields: {
    accepted: false,
    attempted: false,
    command_id: null,
    completion_status: null,
    sent: false,
  },
  stage: "startup",
};

async function main() {
  attemptState.stage = "artifact preparation";
  assertLayerFieldRequestMatcherSelfTest();
  assertAirboxFieldRequestMatcherSelfTest();
  assertGeometryOnlyAirboxRequestFilterSelfTest();
  assertAirboxResponseRequestCorrelationSelfTest();
  assertExactListenerMatcherSelfTest();
  assertAirboxIsolationPatchSelfTest();
  assertAirboxSurfaceStyleSelfTest();
  assertAirboxPresentationSequenceSelfTest();
  assertSourceBoundBuildIdentitySelfTest();
  assertDiagnosticQualificationSelfTest();
  if (selfTestOnly) {
    console.log("FDM multilayer WebGL smoke self-tests passed.");
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  attemptState.stage = "active-session preflight";
  const status = await getJson("/v2/sessions/current/status");
  attemptState.session_id = status?.session?.session_id ?? status?.session_id ?? null;
  const layout = await getJson("/v2/sessions/current/data/domain/fdm-multilayer-layout");
  const openapi = await getJson("/v2/platform/openapi.json");
  const buildIdentity = assertSourceBoundBuildIdentity(openapi, expectedBuildIdentity);
  assertRuntimeBinaryReceipt(expectedRuntimeBinarySha256);
  const runtimeProvenance = assertRuntimeProvenance(status);
  const layers = assertMultilayerLayout(status, layout);
  attemptState.stage = "compute_fields";
  const computeFields = await runComputeFields();
  attemptState.stage = "runtime-origin field proof";
  const originProof = await assertRuntimeOriginFields(layers, layout);

  // The native-layer gate must not concurrently upload the target-only Airbox
  // carrier (153600 cells in the qualification scenario). Airbox fidelity is
  // exercised independently by the four dedicated cases below.
  await patchJson(
    "/v2/sessions/current/visualization/state",
    buildAirboxIsolationPatch(false),
  );
  assertAirboxHiddenBeforeNativeGate(
    await getJson("/v2/sessions/current/visualization/state"),
  );

  attemptState.stage = "browser startup";
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error("FDM multilayer WebGL matrix requires Playwright Chromium.");
  }
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  const cdp = diagnosticTracePath ? await page.context().newCDPSession(page) : null;
  const traceEvents = [];
  if (cdp) {
    cdp.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler",
      options: "sampling-frequency=10000",
    });
  }
  const consoleErrors = [];
  const fieldRequests = [];
  const fieldResponses = [];
  const fieldRequestIds = new WeakMap();
  let nextFieldRequestId = 1;
  const geometryRequests = [];
  const networkFailures = [];
  page.on("console", (message) => {
    const value = message.text();
    if (message.type() === "error" && !/favicon\.ico/i.test(value)) consoleErrors.push(value);
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const url = new URL(request.url());
    if (/\/data\/fields\/[^/]+\/samples\/vector$/.test(url.pathname)) {
      const fieldRequest = {
        path: url.pathname,
        request_id: `field-request-${nextFieldRequestId++}`,
        search: url.search,
        timestamp: Date.now(),
      };
      fieldRequestIds.set(request, fieldRequest.request_id);
      fieldRequests.push(fieldRequest);
      console.log(`FDM multilayer browser field request: ${JSON.stringify(fieldRequest)}`);
    }
    if (
      url.pathname.includes("/meshing/meshes/") ||
      url.pathname.endsWith("/data/domain/topology") ||
      url.pathname.endsWith("/data/domain/fdm-multilayer-layout")
    ) {
      geometryRequests.push({ path: url.pathname, search: url.search, timestamp: Date.now() });
    }
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) networkFailures.push({ status, url: response.url() });
    if (
      response.request().method() === "GET" &&
      /\/data\/fields\/[^/]+\/samples\/vector(?:\?|$)/.test(response.url()) &&
      status >= 200 &&
      status < 300
    ) {
      const url = response.url();
      fieldResponses.push({
        field_request_id: fieldRequestIds.get(response.request()) ?? null,
        handle: response,
        query: Object.fromEntries(new URL(url).searchParams),
        response_started_at_ms: Date.now(),
        status,
        url,
      });
    }
  });
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
      enableAuditHooks: true,
    };
  }, apiBase);

  try {
    attemptState.stage = "browser navigation";
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await ensureHealthyCanvas(page);
    await page.waitForFunction(
      () => typeof window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditRuntime === "function",
      undefined,
      { timeout: timeoutMs },
    );
    let nativeTargetSurface = null;
    let dualVisibleBaseline = null;
    const matrix = [];
    const diagnosticReadbacks = [];
    if (!airboxOnly) {
      attemptState.stage = "native target preflight";
      nativeTargetSurface = await assertNativeLayerTargetSurface(page, layers);
      attemptState.stage = "dual-visible native layer gate";
      await cdp?.send("Tracing.recordClockSyncMarker", { syncId: "dual-visible-start" });
      dualVisibleBaseline = await runDualVisibleNativeLayerGate({ fieldRequests, layers, page });
      await cdp?.send("Tracing.recordClockSyncMarker", { syncId: "dual-visible-end" });
      attemptState.stage = "native layer matrix";
    }
    for (const layer of airboxOnly ? [] : layers) {
      // Qualify the selected native carrier at full fidelity without making
      // the other physical layer part of the same render workload.  This is
      // target isolation, not decimation: every cell of the selected layer
      // remains rendered and both layers receive the complete 12-case matrix.
      for (const candidate of layers) {
        await setNativeLayerVisibility(page, candidate, candidate.layer_id === layer.layer_id);
      }
      for (const geometry of geometries) {
        for (const quantity of quantities) {
          for (const presentation of presentations) {
            matrix.push(await runLayerMatrixCase({
              geometry,
              fieldRequests,
              geometryRequests,
              layer,
              layout,
              page,
              presentation,
              quantity,
            }));
          }
        }
      }
      if (diagnosticReadbackMode === "deferred") {
        console.log(`FDM multilayer diagnostic marker: deferred-fidelity-start ${layer.layer_id}`);
        diagnosticReadbacks.push({
          fidelity: await assertCanvasHasFidelity(page),
          layer_id: layer.layer_id,
          screenshot: await captureCanvas(page, `${artifactDir}/${slug(layer.layer_id)}-deferred-fidelity.png`),
        });
        console.log(`FDM multilayer diagnostic marker: deferred-fidelity-end ${layer.layer_id}`);
      }
    }
    attemptState.stage = "Airbox matrix";
    const airbox = [];
    for (const mode of ["wireframe", "points", "vectors", "h_demag"]) {
      airbox.push(await runAirboxCase({
        fieldRequests,
        fieldResponses,
        geometryRequests,
        layout,
        mode,
        page,
      }));
    }
    attemptState.stage = "interaction matrix";
    const interaction = airboxOnly
      ? null
      : await runInteractionCases({ fieldRequests, geometryRequests, layers, layout, page });
    if (consoleErrors.length > 0) throw new Error(`Browser console errors: ${JSON.stringify(consoleErrors)}`);
    if (networkFailures.length > 0) throw new Error(`Browser HTTP failures: ${JSON.stringify(networkFailures)}`);
    assertNoScratchCarrierRequests(fieldRequests, layout);
    const qualification = qualificationEvidenceForReadbackMode(
      diagnosticReadbackMode,
    );
    const diagnosticOnly = qualification.qualification_status === "diagnostic_only";
    const evidence = {
      schema_version: "fdm_multilayer_webgl_matrix.v1",
      ...qualification,
      browser: "playwright-chromium-fallback",
      compute_fields: computeFields,
      console_errors: consoleErrors,
      field_request_count: fieldRequests.length,
      geometry_request_count: geometryRequests.length,
      interaction,
      layout: layoutEvidence(layout, layers),
      matrix,
      diagnostic_readback_mode: diagnosticReadbackMode,
      diagnostic_readbacks: diagnosticReadbacks,
      airbox,
      airbox_only: airboxOnly,
      build_identity: buildIdentity,
      source_snapshot: {
        path: expectedSourceSnapshotPath,
        sha256: buildIdentity.source_snapshot_sha256,
      },
      runtime_binary: {
        sha256: expectedRuntimeBinarySha256,
      },
      network_failures: networkFailures,
      native_target_surface: nativeTargetSurface,
      dual_visible_baseline: dualVisibleBaseline,
      runtime_origin: originProof,
      runtime_provenance: runtimeProvenance,
      session_id: status?.session?.session_id ?? status?.session_id ?? null,
      workspace_url: workspaceUrl,
    };
    attemptState.stage = "evidence write";
    await writeEvidenceAtomically(evidencePath, evidence);
    console.log(`FDM multilayer WebGL matrix ${diagnosticOnly ? "diagnostic-only run completed" : "passed"}: ${JSON.stringify({ airbox: airbox.length, cases: matrix.length, evidencePath })}`);
  } finally {
    if (cdp && diagnosticTracePath) {
      const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.end");
      await complete;
      await writeFile(diagnosticTracePath, JSON.stringify({ traceEvents }));
    }
    await browser.close();
  }
}

async function runDualVisibleNativeLayerGate({ fieldRequests, layers, page }) {
  const fieldRequestCountBefore = fieldRequests.length;
  const targetSettings = [];
  for (const layer of layers) {
    targetSettings.push(await setNativeLayerPresentation(page, layer, "surface", "field", "m"));
  }
  await patchJson("/v2/sessions/current/visualization/state", buildGlobalQuantityPatch("m"));
  const requestProofs = [];
  for (const layer of layers) {
    requestProofs.push(await waitForLayerRequest(fieldRequests, fieldRequestCountBefore, layer, "m"));
  }
  const runtime = await poll("dual-visible native layer listeners", async () => {
    const snapshot = await pageAuditSnapshot(page);
    return layers.every((layer) => exactLayerListenerCount(snapshot, layer, "m") > 0)
      ? snapshot
      : null;
  });
  const canvas = await ensureHealthyCanvas(page);
  return {
    canvas,
    field_request_count_after: fieldRequests.length,
    field_request_count_before: fieldRequestCountBefore,
    listener_counts: Object.fromEntries(layers.map((layer) => [
      layer.layer_id,
      exactLayerListenerCount(runtime, layer, "m"),
    ])),
    request_proofs: requestProofs,
    target_settings: targetSettings,
  };
}

function exactLayerListenerCount(runtime, layer, quantity) {
  return Object.entries(runtime.listenerCounts ?? {})
    .filter(([key]) => resourceKeyHasExactFieldScope(
      key,
      quantity,
      "layer",
      layer.layer_id,
    ))
    .reduce((sum, [, count]) => sum + Number(count), 0);
}

async function assertNativeLayerTargetSurface(page, layers) {
  const rows = [];
  for (const layer of layers) {
    await selectNativeLayerTarget(page, layer);
    const nodeId = nativeLayerNodeId(layer.layer_id);
    const inspector = page.locator(".fm-inspector");
    const inspectorText = await inspector.innerText();
    const controls = {
      quantity: await inspector.locator('select[aria-label="Quantity Source"]').count(),
      render_mode: await inspector.locator('[role="radiogroup"][aria-label="Render mode"]').count(),
      target_visibility: await inspector.getByRole("button", { name: "Toggle target visibility", exact: true }).count(),
    };
    if (
      !inspectorText.includes("Native Grid") ||
      controls.quantity === 0 ||
      controls.render_mode === 0 ||
      controls.target_visibility === 0
    ) {
      throw new Error(`Native FDM layer target-local visualization controls are unavailable for ${layer.layer_id}; refusing object-override fallback: ${JSON.stringify({ controls, node_id: nodeId, inspector: inspectorText.slice(0, 800) })}`);
    }
    rows.push({ controls, layer_id: layer.layer_id, node_id: nodeId });
  }
  return rows;
}

async function selectNativeLayerTarget(page, layer) {
  const nodeId = nativeLayerNodeId(layer.layer_id);
  await ensureExplorerPathExpanded(page);
  const row = page.locator(`[data-node-id="${cssEscape(nodeId)}"]`);
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await poll(`native layer selection ${layer.layer_id}`, async () =>
    (await row.getAttribute("aria-selected")) === "true" ? true : null,
  );
  return row;
}

async function setNativeLayerPresentation(page, layer, geometry, presentation, quantity) {
  await selectNativeLayerTarget(page, layer);
  const inspector = page.locator(".fm-inspector");
  const visible = inspector.getByRole("button", { name: "Toggle target visibility", exact: true });
  if ((await visible.getAttribute("aria-pressed")) !== "true") await visible.click();
  const modeLabel = geometry === "surface" ? "Shaded" : geometry === "wireframe" ? "Wireframe" : "Points";
  const mode = inspector.locator('[role="radiogroup"][aria-label="Render mode"]').getByRole("radio", { name: modeLabel, exact: true });
  if ((await mode.getAttribute("aria-checked")) !== "true") await mode.click();
  const vectors = inspector.getByRole("button", { name: "Toggle vector field arrows", exact: true });
  const vectorsExpected = presentation === "vector";
  if ((await vectors.getAttribute("aria-pressed")) !== String(vectorsExpected)) await vectors.click();
  const quantitySelect = inspector.locator('select[aria-label="Quantity Source"]');
  await quantitySelect.selectOption(quantity);
  return poll(`native layer presentation ${layer.layer_id}`, async () => {
    const settings = await readNativeLayerSettings(inspector);
    return settings.geometry === modeLabel &&
      settings.quantity?.toLowerCase() === quantity.toLowerCase() &&
      settings.vectors === vectorsExpected &&
      settings.visible === true
      ? settings
      : null;
  });
}

async function setNativeLayerVisibility(page, layer, visibleExpected) {
  await selectNativeLayerTarget(page, layer);
  const inspector = page.locator(".fm-inspector");
  const visible = inspector.getByRole("button", { name: "Toggle target visibility", exact: true });
  if ((await visible.getAttribute("aria-pressed")) !== String(visibleExpected)) await visible.click();
  return poll(`native layer visibility ${layer.layer_id}`, async () => {
    const settings = await readNativeLayerSettings(inspector);
    return settings.visible === visibleExpected ? settings : null;
  });
}

async function readNativeLayerSettings(inspector) {
  const mode = inspector.locator('[role="radiogroup"][aria-label="Render mode"] [role="radio"][aria-checked="true"]');
  const quantity = inspector.locator('select[aria-label="Quantity Source"]');
  const visibility = inspector.getByRole("button", { name: "Toggle target visibility", exact: true });
  const vectors = inspector.getByRole("button", { name: "Toggle vector field arrows", exact: true });
  return {
    geometry: await mode.getAttribute("aria-label"),
    quantity: await quantity.inputValue(),
    vectors: (await vectors.getAttribute("aria-pressed")) === "true",
    visible: (await visibility.getAttribute("aria-pressed")) === "true",
  };
}

function assertNativeLayerPresentation(settings, layer, geometry, presentation, quantity) {
  const expectedGeometry = geometry === "surface" ? "Shaded" : geometry === "wireframe" ? "Wireframe" : "Points";
  if (
    settings.geometry !== expectedGeometry ||
    normalizeToken(settings.quantity) !== normalizeToken(quantity) ||
    settings.vectors !== (presentation === "vector") ||
    settings.visible !== true
  ) {
    throw new Error(`Native layer target presentation was not adopted for ${layer.layer_id}: ${JSON.stringify({ expected: { geometry: expectedGeometry, quantity, vectors: presentation === "vector", visible: true }, settings })}`);
  }
}

function assertNativeLayerVisibility(settings, layer, expectedVisible, label) {
  if (settings.visible !== expectedVisible) {
    throw new Error(`${label} did not resolve native target visibility for ${layer.layer_id}: ${JSON.stringify(settings)}`);
  }
}

async function ensureExplorerPathExpanded(page) {
  for (const nodeId of ["model:mesh", "model:mesh:shared-domain", "model:mesh:shared-domain:native-layers"]) {
    const node = page.locator(`[data-node-id="${cssEscape(nodeId)}"]`);
    await node.waitFor({ state: "visible", timeout: timeoutMs });
    if ((await node.getAttribute("aria-expanded")) === "false") {
      await node.dblclick();
      await poll(`Explorer expansion ${nodeId}`, async () => (await node.getAttribute("aria-expanded")) === "true" ? true : null);
    }
  }
}

function nativeLayerNodeId(layerId) {
  return `model:mesh:shared-domain:native-layers:${encodeURIComponent(layerId)}`;
}

async function runLayerMatrixCase({ fieldRequests, geometry, geometryRequests, layer, layout, page, presentation, quantity }) {
  const caseId = `${slug(layer.layer_id)}-${geometry}-${slug(quantity)}-${presentation}`;
  const geometryRequestCountBefore = geometryRequests.length;
  const fieldRequestCountBefore = fieldRequests.length;
  const targetSettings = await setNativeLayerPresentation(page, layer, geometry, presentation, quantity);
  await patchJson("/v2/sessions/current/visualization/state", buildGlobalQuantityPatch(quantity));
  const fieldRequestProof = await waitForLayerRequest(
    fieldRequests,
    fieldRequestCountBefore,
    layer,
    quantity,
  );
  assertNativeLayerPresentation(targetSettings, layer, geometry, presentation, quantity);
  const canvas = await ensureHealthyCanvas(page);
  const runtime = await pageAuditSnapshot(page);
  assertNoGeometryRequestsAfterSwitch(geometryRequests, geometryRequestCountBefore, caseId);
  console.log(`FDM multilayer diagnostic marker: case-controls-healthy ${caseId}`);
  const fidelity = diagnosticReadbackMode === "per-case" ? await assertCanvasHasFidelity(page) : null;
  if (diagnosticReadbackMode === "per-case") console.log(`FDM multilayer diagnostic marker: case-fidelity-complete ${caseId}`);
  const screenshot = diagnosticReadbackMode === "per-case"
    ? await captureCanvas(page, `${artifactDir}/${caseId}.png`)
    : null;
  return {
    case_id: caseId,
    canvas,
    carrier_fingerprint: layer.native_grid_fingerprint,
    field_request_count_after: fieldRequests.length,
    field_request_count_before: fieldRequestCountBefore,
    field_request_proof: fieldRequestProof,
    fidelity,
    fingerprint: layout.layout_fingerprint,
    geometry,
    geometry_request_count_after: geometryRequests.length,
    geometry_request_count_before: geometryRequestCountBefore,
    layer_id: layer.layer_id,
    presentation,
    quantity,
    runtime,
    screenshot,
    target_settings: targetSettings,
  };
}

async function runAirboxCase({
  fieldRequests,
  fieldResponses,
  geometryRequests,
  layout,
  mode,
  page,
}) {
  const display = airboxDisplayForMode(mode);
  const fieldRequired = display.vectors || display.surface;
  const applyDisplay = async (nextDisplay) => patchJson(
    "/v2/sessions/current/visualization/state",
    {
      active_quantity_id: "H_demag",
      layers: {
        airbox: {
          points: { visible: nextDisplay.points },
          surface: { visible: nextDisplay.surface },
          vectors: { density: vectorBudget, domain: "airbox_only", visible: nextDisplay.vectors },
          visible: true,
          wireframe: { visible: nextDisplay.wireframe },
        },
      },
      overrides: [{
        display: {
          geometry_scope: "full",
          points: { visible: nextDisplay.points },
          surface: { visible: nextDisplay.surface },
          vectors: { visible: nextDisplay.vectors },
          visible: true,
          wireframe: { visible: nextDisplay.wireframe },
        },
        quantity: { active_quantity_id: "H_demag" },
        scope: "airbox",
        scope_id: "airbox",
        style: buildAirboxOverrideStyle(nextDisplay),
        visible: true,
      }],
      quantity: { active_quantity_id: "H_demag" },
    },
  );
  const fieldOffDisplay = {
    points: false,
    surface: false,
    vectors: false,
    wireframe: false,
  };
  if (fieldRequired) {
    await applyDisplay(fieldOffDisplay);
    await poll("Airbox field passes disabled before reload", async () => {
      const state = await getJson("/v2/sessions/current/visualization/state");
      const settings = state.targets?.airbox?.settings;
      return settings?.surface_visible === false &&
        settings?.vectors_visible === false &&
        settings?.wireframe_visible === false
        ? settings
        : null;
    });
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await ensureHealthyCanvas(page);
    await page.waitForFunction(
      () => typeof window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditRuntime === "function",
      undefined,
      { timeout: timeoutMs },
    );
  }
  const geometryRequestCountBefore = geometryRequests.length;
  const fieldRequestCountBefore = fieldRequests.length;
  const fieldResponseCountBefore = fieldResponses.length;
  let disabledPresentation = null;
  let preSwitchAdoptions = new Map();
  let switchStartedAtMs = null;
  let visualizationRevision = null;
  let wireframePresentation = null;
  if (mode === "vectors") {
    const wireframeStartedAtMs = Date.now();
    const wireframeResponse = await applyDisplay({ ...fieldOffDisplay, wireframe: true });
    const wireframeRevision = responseRevision(wireframeResponse);
    wireframePresentation = await waitForAirboxCommittedPresentation({
      afterFrameCommitId: null,
      expectedVisualizationRevision: wireframeRevision,
      page,
      switchStartedAtMs: wireframeStartedAtMs,
      vectorsVisible: false,
      wireframeVisible: true,
    });
    const disableStartedAtMs = Date.now();
    const disableResponse = await applyDisplay(fieldOffDisplay);
    const disableRevision = responseRevision(disableResponse);
    disabledPresentation = await waitForAirboxCommittedPresentation({
      afterFrameCommitId: wireframePresentation.frame_commit_id,
      expectedVisualizationRevision: disableRevision,
      page,
      switchStartedAtMs: disableStartedAtMs,
      vectorsVisible: false,
      wireframeVisible: false,
    });
    preSwitchAdoptions = await captureLatestExactAirboxAdoptions(page);
    switchStartedAtMs = Date.now();
    visualizationRevision = responseRevision(await applyDisplay(display));
  } else {
    if (fieldRequired) {
      preSwitchAdoptions = await captureLatestExactAirboxAdoptions(page);
      switchStartedAtMs = Date.now();
    }
    const displayResponse = await applyDisplay(display);
    if (fieldRequired) visualizationRevision = responseRevision(displayResponse);
  }
  // A wireframe/points-only presentation is geometry-only by contract.  It
  // must not force a field request merely because the target's selected
  // quantity is H_demag.  Field-backed presentations (vectors and scalar
  // surface) must prove the canonical Airbox request.
  const fieldRequestProof = fieldRequired
    ? await waitForAirboxRequest(fieldRequests, fieldRequestCountBefore, switchStartedAtMs)
    : {
        observed_after_case_start: false,
        request: null,
        request_index: null,
      };
  const completedFieldResponse = fieldRequired
    ? await waitForCompletedAirboxFieldResponse(
        fieldResponses,
        fieldResponseCountBefore,
        switchStartedAtMs,
        fieldRequestProof.request?.request_id ?? null,
      )
    : null;
  const state = await getJson("/v2/sessions/current/visualization/state");
  const settings = state.targets?.airbox?.settings;
  assertAirboxPresentation(settings, mode, display);
  const canvas = await ensureHealthyCanvas(page);
  let lastDomEvidence = null;
  let domEvidence;
  try {
    domEvidence = await poll(
      `Airbox ${mode} prepared scene data`,
      async () => {
        const viewport = page.locator(".fm-viewport-3d");
        const evidence = await viewport.evaluate((element) => ({
          build_error: element.getAttribute("data-fdm-airbox-build-error"),
          build_status: element.getAttribute("data-fdm-airbox-build-status"),
          domain_cell_count: Number(element.getAttribute("data-fdm-airbox-domain-cell-count") ?? 0),
          model_count: Number(element.getAttribute("data-fdm-airbox-model-count") ?? 0),
          target: element.getAttribute("data-fdm-airbox-target"),
          vector_segment_count: Number(element.getAttribute("data-fdm-airbox-vector-segment-count") ?? 0),
          vectors_visible: element.getAttribute("data-fdm-airbox-vectors-visible") === "true",
          view_present: element.getAttribute("data-fdm-airbox-view-present") === "true",
          wireframe_visible: element.getAttribute("data-fdm-airbox-wireframe-visible") === "true",
        }));
        lastDomEvidence = evidence;
        if (
          evidence.target !== "airbox" ||
          !evidence.view_present ||
          evidence.domain_cell_count <= 0 ||
          evidence.model_count <= 0 ||
          evidence.build_status !== "ready" ||
          evidence.build_error
        ) {
          return null;
        }
        if (mode === "vectors") {
          if (evidence.wireframe_visible || !evidence.vectors_visible || evidence.vector_segment_count <= 0) return null;
        } else if (mode === "wireframe" && !evidence.wireframe_visible) {
          return null;
        }
        return evidence;
      },
    );
  } catch (error) {
    throw new Error(`${error.message}; last_dom_evidence=${JSON.stringify(lastDomEvidence)}`);
  }
  const webglAdoption = completedFieldResponse
    ? await waitForExactAirboxVisualizationAdoption({
        page,
        preSwitchAdoptionSequence:
          preSwitchAdoptions.get(completedFieldResponse.resource_key)?.[
            mode === "h_demag" ? "surface" : "vector"
          ] ?? null,
        renderPass: mode === "h_demag" ? "surface" : "vector-glyph",
        response: completedFieldResponse,
        switchStartedAtMs,
        expectedVisualizationRevision: visualizationRevision,
        expectedVectorsVisible: mode === "vectors",
        expectedWireframeVisible: false,
      })
    : null;
  const runtime = await pageAuditSnapshot(page);
  const listenerCount = exactAirboxListenerCount(runtime);
  if (fieldRequired && listenerCount <= 0) {
    throw new Error(
      `Airbox H_demag has no positive exact current listener: ${JSON.stringify({
        completedFieldResponse,
        fieldRequestProof,
      })}`,
    );
  }
  if (fieldRequired && !fieldRequestProof.observed_after_case_start) {
    throw new Error(
      `Airbox H_demag request was not fresh for ${mode}: ${JSON.stringify(fieldRequestProof)}`,
    );
  }
  const unexpectedAirboxFieldRequests = fieldRequired
    ? []
    : exactAirboxFieldRequestsAfter(fieldRequests, fieldRequestCountBefore);
  if (unexpectedAirboxFieldRequests.length > 0) {
    throw new Error(
      `Geometry-only Airbox ${mode} unexpectedly requested field data: ${JSON.stringify(
        unexpectedAirboxFieldRequests,
      )}`,
    );
  }
  assertNoGeometryRequestsAfterSwitch(geometryRequests, geometryRequestCountBefore, `airbox-${mode}`);
  const fidelity = await assertCanvasHasFidelity(page);
  const presentationSequence = mode === "vectors"
    ? [
        { phase: "wireframe_on", ...wireframePresentation },
        { phase: "wireframe_off", ...disabledPresentation },
        { phase: "vectors_on", ...webglAdoption },
      ]
    : null;
  if (presentationSequence) assertAirboxVectorPresentationSequence(presentationSequence);
  return {
    canvas,
    case_id: `airbox-${mode}`,
    carrier_fingerprint: layout.airbox.carrier_fingerprint,
    completed_field_response: completedFieldResponse,
    disabled_presentation: disabledPresentation,
    presentation_sequence: presentationSequence,
    prepared_dom_evidence: domEvidence,
    field_request_count_after: fieldRequests.length,
    field_request_count_before: fieldRequestCountBefore,
    field_request_proof: fieldRequestProof,
    fidelity,
    fingerprint: layout.layout_fingerprint,
    geometry_request_count_after: geometryRequests.length,
    geometry_request_count_before: geometryRequestCountBefore,
    mode,
    runtime,
    listener_count: listenerCount,
    webgl_adoption: webglAdoption,
    screenshot: await captureCanvas(page, `${artifactDir}/airbox-${mode}.png`),
  };
}

async function waitForCompletedAirboxFieldResponse(
  responses,
  start,
  startedAtMs = null,
  fieldRequestId = null,
) {
  const entry = await poll("fresh completed Airbox H_demag response", () =>
    responses.slice(start).find((candidate) =>
      matchesAirboxFieldResponse(candidate, startedAtMs, fieldRequestId)) ?? null,
  );
  const responseBodyStartedAtMs = Date.now();
  const headers = await entry.handle.allHeaders();
  const bodyError = await entry.handle.finished();
  if (bodyError) {
    throw new Error(
      `Airbox H_demag response body did not finish for ${entry.url}: ${bodyError.message}`,
    );
  }
  const url = new URL(entry.url);
  return {
    domain_generation_id: normalizedResponseHeader(
      headers,
      "x-fullmag-domain-generation-id",
    ),
    etag: normalizedResponseHeader(headers, "etag"),
    field_revision: normalizedResponseHeader(headers, "x-fullmag-field-revision"),
    mesh_topology_hash: normalizedResponseHeader(
      headers,
      "x-fullmag-mesh-topology-hash",
    ),
    field_request_id: entry.field_request_id,
    query: entry.query,
    resource_key: `${url.pathname}${url.search}`,
    response_body_started_at_ms: responseBodyStartedAtMs,
    response_finished_at_ms: Date.now(),
    response_started_at_ms: entry.response_started_at_ms,
    status: entry.status,
    url: entry.url,
  };
}

function matchesAirboxFieldResponse(candidate, startedAtMs, fieldRequestId) {
  const url = new URL(candidate.url);
  return candidate.status >= 200 &&
    candidate.status < 300 &&
    (startedAtMs === null || candidate.response_started_at_ms >= startedAtMs) &&
    candidate.field_request_id === fieldRequestId &&
    url.pathname === "/v2/sessions/current/data/fields/H_demag/samples/vector" &&
    url.searchParams.get("scope_kind") === "airbox" &&
    url.searchParams.get("scope_id") === "airbox";
}

function normalizedResponseHeader(headers, name) {
  const value = headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function explorerTreeItem(page, nodeId) {
  return page.locator(
    `[role="treeitem"][data-node-id=${JSON.stringify(nodeId)}]`,
  );
}

async function selectAirboxVisualizationDebug(page) {
  const modelTab = page.getByRole("tab", { name: "Model", exact: true });
  await modelTab.waitFor({ state: "visible", timeout: timeoutMs });
  if (await modelTab.getAttribute("aria-selected") !== "true") {
    await modelTab.click({ timeout: timeoutMs });
  }
  for (const nodeId of [
    airboxDebugTarget.parentNodeIds[0],
    airboxDebugTarget.nodeId,
  ]) {
    const node = explorerTreeItem(page, nodeId);
    await node.waitFor({ state: "visible", timeout: timeoutMs });
    if (await node.getAttribute("aria-expanded") === "false") {
      await node.focus();
      await page.keyboard.press("ArrowRight");
    }
  }
  const row = explorerTreeItem(page, airboxDebugTarget.debugNodeId);
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  await row.click({ timeout: timeoutMs });
  await poll("Airbox Visualization Debug selection", async () =>
    await row.getAttribute("aria-selected") === "true" ? true : null,
  );
  const inspector = page.locator(
    `.fm-inspector-panel[data-inspector-owner="${airboxDebugTarget.debugInspectorOwner}"]`,
  );
  await inspector.waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.locator(".fm-visualization-debug-panel").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const rawJson = inspector.getByRole("button", {
    name: "Raw bounded JSON",
    exact: true,
  });
  await rawJson.waitFor({ state: "visible", timeout: timeoutMs });
  if (await rawJson.getAttribute("aria-expanded") === "false") {
    await rawJson.click({ timeout: timeoutMs });
  }
  return inspector;
}

async function readAirboxVisualizationDebugDocument(inspector) {
  return poll("Airbox Visualization Debug raw JSON", async () => {
    const text = await inspector
      .locator(".fm-visualization-debug-json code")
      .textContent();
    return text ? JSON.parse(text) : null;
  });
}

function latestAirboxVisualizationObservation(document) {
  if (document?.model?.target?.id !== airboxDebugTarget.targetId) return null;
  let latest = null;
  for (const viewport of document.model.viewports ?? []) {
    for (const carrierGroup of viewport?.carriers ?? []) {
      for (const observation of carrierGroup?.observations ?? []) {
        if (observation?.carrier?.carrierId !== airboxDebugTarget.targetId) {
          continue;
        }
        if (
          Number.isFinite(observation?.snapshot?.capturedAtMs) &&
          (latest === null ||
            observation.snapshot.capturedAtMs >= latest.snapshot.capturedAtMs)
        ) {
          latest = observation;
        }
      }
    }
  }
  return latest;
}

async function waitForAirboxCommittedPresentation({
  afterFrameCommitId,
  expectedVisualizationRevision,
  page,
  switchStartedAtMs,
  vectorsVisible,
  wireframeVisible,
}) {
  const inspector = await selectAirboxVisualizationDebug(page);
  return poll("committed Airbox presentation frame", async () => {
    const prepared = await page.locator(".fm-viewport-3d").evaluate((element) => ({
      target: element.getAttribute("data-fdm-airbox-target"),
      vectors_visible:
        element.getAttribute("data-fdm-airbox-vectors-visible") === "true",
      wireframe_visible:
        element.getAttribute("data-fdm-airbox-wireframe-visible") === "true",
    }));
    if (
      prepared.target !== airboxDebugTarget.targetId ||
      prepared.vectors_visible !== vectorsVisible ||
      prepared.wireframe_visible !== wireframeVisible
    ) {
      return null;
    }
    const observation = latestAirboxVisualizationObservation(
      await readAirboxVisualizationDebugDocument(inspector),
    );
    const frameCommitId = observation?.snapshot?.viewport?.frameCommitId;
    const viewportId = observation?.snapshot?.viewport?.viewportId;
    const capturedAtMs = observation?.snapshot?.capturedAtMs;
    const observedVisualizationRevision =
      observation?.carrier?.revisions?.visualizationRevision;
    const frameWireframeVisible = observation?.snapshot?.viewport?.airboxWireframeVisible;
    const frameVectorsVisible = observation?.snapshot?.viewport?.airboxVectorsVisible;
    return frameCommitId &&
      frameCommitId !== afterFrameCommitId &&
      viewportId &&
      frameCommitId === `${viewportId}:${expectedVisualizationRevision}` &&
      observedVisualizationRevision === String(expectedVisualizationRevision) &&
      frameWireframeVisible === wireframeVisible &&
      frameVectorsVisible === vectorsVisible &&
      Number.isFinite(capturedAtMs) &&
      capturedAtMs >= switchStartedAtMs
      ? {
          captured_at_ms: capturedAtMs,
          frame_commit_id: frameCommitId,
          visualization_revision: Number.parseInt(observedVisualizationRevision, 10),
          vectors_visible: frameVectorsVisible,
          wireframe_visible: frameWireframeVisible,
        }
      : null;
  });
}

async function captureLatestExactAirboxAdoptions(page) {
  const inspector = await selectAirboxVisualizationDebug(page);
  const document = await readAirboxVisualizationDebugDocument(inspector);
  const adoptions = new Map();
  for (const viewport of document?.model?.viewports ?? []) {
    for (const carrierGroup of viewport?.carriers ?? []) {
      for (const observation of carrierGroup?.observations ?? []) {
        if (observation?.carrier?.carrierId !== airboxDebugTarget.targetId) {
          continue;
        }
        const resourceKey = observation?.carrier?.request?.resourceKey;
        const adoption = observation?.carrier?.render?.adoption;
        if (!resourceKey || !adoption) continue;
        const current = adoptions.get(resourceKey) ?? {
          surface: null,
          vector: null,
        };
        for (const pass of ["surface", "vector"]) {
          const sequence = adoption[pass]?.adoptionSequence;
          if (
            Number.isSafeInteger(sequence) &&
            (current[pass] === null || sequence > current[pass])
          ) {
            current[pass] = sequence;
          }
        }
        adoptions.set(resourceKey, current);
      }
    }
  }
  return adoptions;
}

function findExactAirboxVisualizationObservation(
  document,
  resourceKey,
  adoptionKind,
) {
  if (document?.model?.target?.id !== airboxDebugTarget.targetId) return null;
  let latest = null;
  for (const viewport of document.model.viewports ?? []) {
    for (const carrierGroup of viewport?.carriers ?? []) {
      for (const observation of carrierGroup?.observations ?? []) {
        const passAdoption =
          observation?.carrier?.render?.adoption?.[adoptionKind];
        const latestAdoption =
          latest?.carrier?.render?.adoption?.[adoptionKind];
        if (
          observation?.carrier?.carrierId === airboxDebugTarget.targetId &&
          observation?.carrier?.request?.resourceKey === resourceKey &&
          Number.isSafeInteger(passAdoption?.adoptionSequence) &&
          (latest === null ||
            passAdoption.adoptionSequence > latestAdoption.adoptionSequence)
        ) {
          latest = observation;
        }
      }
    }
  }
  return latest;
}

async function waitForExactAirboxVisualizationAdoption({
  expectedVisualizationRevision,
  expectedVectorsVisible,
  expectedWireframeVisible,
  page,
  preSwitchAdoptionSequence,
  renderPass,
  response,
  switchStartedAtMs,
}) {
  const inspector = await selectAirboxVisualizationDebug(page);
  const adoptionKind = renderPass === "surface" ? "surface" : "vector";
  return poll(`exact Airbox ${renderPass} WebGL adoption`, async () => {
    const observation = findExactAirboxVisualizationObservation(
      await readAirboxVisualizationDebugDocument(inspector),
      response.resource_key,
      adoptionKind,
    );
    if (
      !observation ||
      !exactVisualizationAdoptionMatches({
        observation,
        preSwitchAdoptionSequence,
        quantityId: "H_demag",
        renderPass,
        response,
        switchStartedAtMs,
      })
    ) {
      return null;
    }
    const carrier = observation.carrier;
    const viewport = observation.snapshot.viewport;
    if (
      !viewport.viewportId ||
      viewport.frameCommitId !==
        `${viewport.viewportId}:${expectedVisualizationRevision}` ||
      viewport.airboxVectorsVisible !== expectedVectorsVisible ||
      viewport.airboxWireframeVisible !== expectedWireframeVisible ||
      carrier.revisions?.visualizationRevision !==
        String(expectedVisualizationRevision)
    ) {
      return null;
    }
    const passAdoption = carrier.render.adoption[adoptionKind];
    if (
      response.response_finished_at_ms < response.response_started_at_ms ||
      observation.snapshot.capturedAtMs < passAdoption.adoptedAtMs ||
      carrier.render.fieldBufferState !== "target-buffer" ||
      carrier.render.requestedFieldBufferId !==
        passAdoption.adoptedFieldBufferId
    ) {
      return null;
    }
    if (renderPass === "surface") {
      if (
        !(carrier.render.surface.scalarByteLength > 0) ||
        !carrier.render.surface.bufferKey ||
        carrier.render.surface.bufferKey !==
          passAdoption.adoptedScalarBufferKey
      ) {
        return null;
      }
    } else if (
      !(carrier.render.vectors.segmentCount > 0) ||
      !(passAdoption.adoptedVectorItemCount > 0) ||
      !carrier.render.vectors.buildKey ||
      carrier.render.vectors.buildKey !==
        passAdoption.adoptedVectorBuildKey
    ) {
      return null;
    }
    return {
      adopted_at_ms: passAdoption.adoptedAtMs,
      adopted_field_buffer_id: passAdoption.adoptedFieldBufferId,
      adopted_resource_key: passAdoption.adoptedResourceKey,
      adoption_sequence: passAdoption.adoptionSequence,
      frame_commit_id: observation.snapshot.viewport.frameCommitId,
      captured_at_ms: observation.snapshot.capturedAtMs,
      render_pass: renderPass,
      response_finished_at_ms: response.response_finished_at_ms,
      snapshot_captured_at_ms: observation.snapshot.capturedAtMs,
      vectors_visible: viewport.airboxVectorsVisible,
      visualization_revision: Number.parseInt(
        carrier.revisions.visualizationRevision,
        10,
      ),
      wireframe_visible: viewport.airboxWireframeVisible,
    };
  });
}

function airboxDisplayForMode(mode) {
  const display = {
    points: false,
    surface: false,
    vectors: false,
    wireframe: false,
  };
  if (mode === "wireframe") display.wireframe = true;
  else if (mode === "points") display.points = true;
  else if (mode === "vectors") display.vectors = true;
  else if (mode === "h_demag") display.surface = true;
  else throw new Error(`Unknown Airbox display mode: ${mode}`);
  return display;
}

function buildAirboxOverrideStyle(nextDisplay) {
  return {
    ...(nextDisplay.surface
      ? { surface_color_source: "magnitude" }
      : {}),
    ...(nextDisplay.vectors
      ? {
          vector_alpha: 1,
          vector_color_mode: "monochrome",
          vector_length_scale: 1,
          vector_mono_color: "#11111b",
          vector_thickness: 2,
        }
      : {}),
    vector_budget: vectorBudget,
  };
}

function assertAirboxSurfaceStyleSelfTest() {
  const surfaceStyle = buildAirboxOverrideStyle(
    airboxDisplayForMode("h_demag"),
  );
  if (surfaceStyle.surface_color_source !== "magnitude") {
    throw new Error(
      "Airbox H_demag surface self-test requires a field-derived surface color source.",
    );
  }
  if (
    Object.hasOwn(
      buildAirboxOverrideStyle(airboxDisplayForMode("vectors")),
      "surface_color_source",
    )
  ) {
    throw new Error(
      "Airbox vector self-test must not fabricate a surface color source.",
    );
  }
  const vectorStyle = buildAirboxOverrideStyle(
    airboxDisplayForMode("vectors"),
  );
  if (
    vectorStyle.vector_length_scale !== 1 ||
    vectorStyle.vector_thickness !== 2 ||
    vectorStyle.vector_alpha !== 1 ||
    vectorStyle.vector_color_mode !== "monochrome" ||
    vectorStyle.vector_mono_color !== "#11111b"
  ) {
    throw new Error(
      "Airbox vector self-test requires an opaque, readable vector presentation.",
    );
  }
}

function assertAirboxPresentation(settings, mode, display) {
  const actualQuantity = String(settings?.active_quantity_id ?? "").toLowerCase();
  if (
    !settings?.visible ||
    actualQuantity !== "h_demag" ||
    settings.points_visible !== display.points ||
    settings.surface_visible !== display.surface ||
    settings.vectors_visible !== display.vectors ||
    settings.wireframe_visible !== display.wireframe
  ) {
    throw new Error(`Airbox ${mode} state was not adopted: ${JSON.stringify(settings)}`);
  }
  if (mode === "vectors" && (display.wireframe || !display.vectors)) {
    throw new Error("Airbox vectors case must disable wireframe before enabling vectors.");
  }
}

async function runInteractionCases({ fieldRequests, geometryRequests, layers, layout, page }) {
  const [visible, hidden] = layers;
  const hideGeometryRequestCountBefore = geometryRequests.length;
  const hideFieldRequestCountBefore = fieldRequests.length;
  await setNativeLayerPresentation(page, visible, "surface", "vector", "m");
  const hiddenSettings = await setNativeLayerPresentation(page, hidden, "surface", "vector", "m");
  const hiddenAfter = await setNativeLayerVisibility(page, hidden, false);
  const visibleAfterHide = await setNativeLayerVisibility(page, visible, true);
  assertNativeLayerVisibility(visibleAfterHide, visible, true, "hide visible target");
  assertNativeLayerVisibility(hiddenSettings, hidden, true, "hide baseline");
  assertNativeLayerVisibility(hiddenAfter, hidden, false, "hide");
  await patchJson("/v2/sessions/current/visualization/state", buildGlobalQuantityPatch("m"));
  await waitForLayerRequest(fieldRequests, hideFieldRequestCountBefore, visible, "m");
  const hiddenRuntime = await pageAuditSnapshot(page);
  assertHiddenLayerHasNoListener(hiddenRuntime, hidden);
  assertNoGeometryRequestsAfterSwitch(geometryRequests, hideGeometryRequestCountBefore, "hide");

  const isolateGeometryRequestCountBefore = geometryRequests.length;
  const isolateFieldRequestCountBefore = fieldRequests.length;
  const isolatedVisible = await setNativeLayerVisibility(page, visible, false);
  const isolatedHidden = await setNativeLayerVisibility(page, hidden, true);
  assertNativeLayerVisibility(isolatedVisible, visible, false, "isolate");
  assertNativeLayerVisibility(isolatedHidden, hidden, true, "isolate");
  await patchJson("/v2/sessions/current/visualization/state", buildGlobalQuantityPatch("m"));
  await waitForLayerRequest(fieldRequests, isolateFieldRequestCountBefore, hidden, "m");
  const isolateRuntime = await pageAuditSnapshot(page);
  assertHiddenLayerHasNoListener(isolateRuntime, visible);
  assertNoGeometryRequestsAfterSwitch(geometryRequests, isolateGeometryRequestCountBefore, "isolate");

  const picking = await runCanvasPicking(page, layers);
  return {
    canvas_picking: picking,
    hidden_layer: hidden.layer_id,
    hidden_listener_counts: hiddenRuntime.listenerCounts,
    visible_after_hide: visibleAfterHide,
    hide_field_request_count_after: fieldRequests.length,
    hide_field_request_count_before: hideFieldRequestCountBefore,
    isolate_field_request_count_after: fieldRequests.length,
    isolate_field_request_count_before: isolateFieldRequestCountBefore,
    isolated_layer: hidden.layer_id,
    scratch_overlay_non_physical: layout.common_transform_layout?.is_physical_mesh === false,
  };
}

function buildGlobalQuantityPatch(quantity) {
  return {
    active_quantity_id: quantity,
    quantity: { active_quantity_id: quantity },
  };
}

async function runCanvasPicking(page, layers) {
  const canvas = page.locator(canvasSelector);
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("Canvas picking requires a measurable WebGL canvas.");
  const expected = new Set(layers.flatMap((layer) => [nativeLayerNodeId(layer.layer_id), `model:object:${layer.object_id}`]));
  await selectNativeLayerTarget(page, layers[0]);
  const baseline = new Set(await selectedNodeIds(page));
  const rows = 14;
  const columns = 20;
  for (let row = 2; row < rows - 2; row += 1) {
    for (let column = 2; column < columns - 2; column += 1) {
      await page.mouse.click(
        box.x + (box.width * column) / columns,
        box.y + (box.height * row) / rows,
      );
      const selected = await selectedNodeIds(page);
      const changed = selected.some((nodeId) => !baseline.has(nodeId));
      const recognized = selected.some((nodeId) => expected.has(nodeId) || nodeId === "model:mesh:grid" || nodeId === "model:airbox" || nodeId === "model:airbox:visualization");
      if (changed && recognized) {
        return { selected_node_ids: selected, scan: { columns, rows, x: column, y: row } };
      }
    }
  }
  throw new Error(`Canvas picking did not change a canonical FDM selection: ${JSON.stringify({ baseline: [...baseline], selected: await selectedNodeIds(page) })}`);
}

async function selectedNodeIds(page) {
  return page.locator('[data-node-id][aria-selected="true"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-node-id")).filter(Boolean),
  );
}

function assertRuntimeProvenance(status) {
  const lane = status?.capabilities?.active_lane;
  const authored = lane?.authored;
  const requested = lane?.requested;
  const resolved = lane?.resolved;
  const source = lane?.source;
  const backend = normalizeToken(requested?.backend ?? authored?.backend);
  const discretization = normalizeToken(requested?.discretization ?? status?.domain?.discretization);
  const requestedPrecision = normalizePrecision(requested?.precision ?? authored?.precision ?? status?.run?.requested_precision);
  const resolvedBackend = normalizeToken(resolved?.backend ?? status?.run?.resolved_backend);
  const resolvedDiscretization = normalizeToken(resolved?.discretization);
  const resolvedPrecision = normalizePrecision(resolved?.precision ?? status?.run?.resolved_precision);
  const resolvedDevice = normalizeToken(resolved?.device ?? status?.run?.resolved_device);
  if (
    backend !== "fdm" ||
    discretization !== "fdm" ||
    requestedPrecision !== "double" ||
    !resolved ||
    resolvedBackend !== "fdm" ||
    resolvedDiscretization !== "fdm" ||
    resolvedPrecision !== "double" ||
    !["cpu", "cpu_reference", "host"].includes(resolvedDevice) ||
    !source ||
    !normalizeToken(source.kind) ||
    !normalizeToken(source.engine_id)
  ) {
    throw new Error(`Expected resolved FDM CPU FP64 runtime provenance, received ${JSON.stringify({ authored, requested, resolved, source, run: status?.run ?? null })}.`);
  }
  return {
    authored,
    requested,
    resolved,
    source,
    run: status?.run ?? null,
  };
}

function expectedBuildIdentityFromEnvironment() {
  const values = {
    git_commit: process.env.CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_GIT_COMMIT ?? null,
    worktree_state: process.env.CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_WORKTREE_STATE ?? null,
    source_snapshot_sha256: process.env.CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_SOURCE_SNAPSHOT_SHA256 ?? null,
  };
  const present = Object.values(values).filter((value) => value !== null);
  if (present.length === 0) return null;
  if (present.length !== Object.keys(values).length) {
    throw new Error(`Source-bound WebGL gate requires all expected build identity fields: ${JSON.stringify(values)}`);
  }
  return values;
}

function assertSourceBoundBuildIdentity(openapi, expected) {
  if (!expected) {
    throw new Error("Source-bound WebGL gate requires an immutable expected build identity from the managed recipe.");
  }
  const actual = openapi?.["x-fullmag-build-identity"];
  if (!actual || typeof actual !== "object") {
    throw new Error(`Serving API did not expose x-fullmag-build-identity: ${JSON.stringify(actual ?? null)}`);
  }
  const required = {
    built_at_utc: actual.built_at_utc,
    git_commit: actual.git_commit,
    worktree_state: actual.worktree_state,
    source_snapshot_sha256: actual.source_snapshot_sha256,
  };
  if (
    typeof required.built_at_utc !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(required.built_at_utc) ||
    required.git_commit !== expected.git_commit ||
    required.worktree_state !== expected.worktree_state ||
    required.source_snapshot_sha256 !== expected.source_snapshot_sha256 ||
    required.git_commit === "unknown" ||
    required.source_snapshot_sha256 === "unknown"
  ) {
    throw new Error(`Serving API build identity does not match the immutable managed source receipt: ${JSON.stringify({ actual: required, expected })}`);
  }
  return required;
}

function assertSourceBoundBuildIdentitySelfTest() {
  const expected = {
    git_commit: "a".repeat(40),
    worktree_state: "dirty",
    source_snapshot_sha256: "b".repeat(64),
  };
  const actual = {
    "x-fullmag-build-identity": {
      built_at_utc: "2026-08-14T00:00:00Z",
      ...expected,
    },
  };
  const identity = assertSourceBoundBuildIdentity(actual, expected);
  if (identity.source_snapshot_sha256 !== expected.source_snapshot_sha256) {
    throw new Error("Source-bound build identity self-test did not preserve the expected snapshot.");
  }
  for (const invalid of [
    { ...actual, "x-fullmag-build-identity": { ...actual["x-fullmag-build-identity"], source_snapshot_sha256: "c".repeat(64) } },
    { ...actual, "x-fullmag-build-identity": { ...actual["x-fullmag-build-identity"], git_commit: "unknown" } },
    {},
  ]) {
    let rejected = false;
    try {
      assertSourceBoundBuildIdentity(invalid, expected);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Source-bound build identity self-test accepted an invalid receipt.");
  }
}

function assertRuntimeBinaryReceipt(sha256) {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Source-bound WebGL gate requires the managed runtime binary SHA-256 receipt: ${JSON.stringify(sha256)}`);
  }
}

function assertMultilayerLayout(status, layout) {
  const discretization = String(status?.domain?.discretization ?? status?.capabilities?.active_lane?.discretization ?? "").toLowerCase();
  if (discretization !== "fdm" || layout?.schema_version !== "fdm-multilayer-layout.v1" || layout?.available !== true || !layout?.layout_fingerprint) {
    throw new Error(`Expected active FDM multilayer session, received ${JSON.stringify({ discretization, schema: layout?.schema_version })}.`);
  }
  if (!layout?.common_transform_layout || layout.common_transform_layout.is_physical_mesh !== false) {
    throw new Error(`Common transform layout must be present and explicitly non-physical: ${JSON.stringify(layout?.common_transform_layout)}.`);
  }
  if (!layout?.airbox?.carrier_available || !layout.airbox.h_demag_available || !layout.airbox.carrier_fingerprint) {
    throw new Error(`Airbox carrier and H_demag must be available with a fingerprint: ${JSON.stringify(layout?.airbox)}.`);
  }
  const layers = (layout.layers ?? []).filter((layer) => layer?.layer_id && layer?.magnet_name && layer?.object_id && layer?.native_grid_fingerprint);
  if (layers.length !== 2 || new Set(layers.map((layer) => layer.layer_id)).size !== 2) {
    throw new Error(`Expected exactly two native layers, received ${JSON.stringify(layers)}.`);
  }
  return layers;
}

async function runComputeFields() {
  attemptState.compute_fields.attempted = true;
  const accepted = await postJson("/v2/sessions/current/simulation/commands", { kind: "compute_fields" });
  if (!accepted?.accepted || typeof accepted.command_id !== "string") throw new Error(`compute_fields rejected: ${JSON.stringify(accepted)}`);
  attemptState.compute_fields.accepted = true;
  attemptState.compute_fields.command_id = accepted.command_id;
  attemptState.compute_fields.sent = true;
  const detail = await poll(`compute_fields ${accepted.command_id}`, async () => {
    const current = await getJson(`/v2/sessions/current/simulation/commands/${encodeURIComponent(accepted.command_id)}`);
    const state = current.completion_status ?? current.status ?? current.command?.completion_status ?? current.command?.status;
    if (!terminalCommandStatuses.has(state)) return null;
    attemptState.compute_fields.completion_status = state;
    if (state !== "completed") throw new Error(`compute_fields ended ${state}: ${JSON.stringify(current)}`);
    return current;
  });
  return { command_id: accepted.command_id, status: detail.completion_status ?? detail.status ?? "completed" };
}

async function assertRuntimeOriginFields(layers, layout) {
  const proof = [];
  for (const layer of layers) {
    for (const quantity of quantities) {
      const response = await fetchBinaryField(quantity, { component: "full", max_samples: vectorBudget, scope_id: layer.layer_id, scope_kind: "layer" });
      const layoutResponseFingerprint = response.headers.get("x-fullmag-layout-fingerprint") ?? response.headers.get("x-fullmag-domain-fingerprint");
      if (layoutResponseFingerprint && layoutResponseFingerprint !== layout.layout_fingerprint) throw new Error(`Field ${quantity}/${layer.layer_id} layout fingerprint mismatch: ${layoutResponseFingerprint} != ${layout.layout_fingerprint}`);
      const carrierFingerprint = readRequiredCarrierFingerprint(response, layer.native_grid_fingerprint, `${quantity}/${layer.layer_id}`);
      proof.push({ bytes: response.bytes, carrier_fingerprint: carrierFingerprint, fingerprint: layoutResponseFingerprint, layer_id: layer.layer_id, quantity, status: response.status });
    }
  }
  const airbox = await fetchBinaryField("H_demag", { component: "full", max_samples: vectorBudget, scope_id: "airbox", scope_kind: "airbox" });
  proof.push({ bytes: airbox.bytes, carrier_fingerprint: readRequiredCarrierFingerprint(airbox, layout.airbox.carrier_fingerprint, "H_demag/airbox"), layer_id: "airbox", quantity: "H_demag", status: airbox.status });
  return proof;
}

function readRequiredCarrierFingerprint(response, expected, label) {
  const actual = response.headers.get("x-fullmag-mesh-topology-hash");
  if (!actual || actual !== expected) {
    throw new Error(`Runtime field ${label} carrier fingerprint mismatch: expected=${expected ?? "missing"} actual=${actual ?? "missing"}.`);
  }
  return actual;
}

async function waitForLayerRequest(fieldRequests, countBefore, layer, quantity) {
  // The viewport resource cache may have issued the exact scoped request
  // during startup or an earlier presentation case.  Requiring a duplicate
  // GET after every geometry-only switch would reject correct cache reuse.
  // Keep the guard strict on canonical layer identity and quantity while
  // accepting a request observed anywhere in this browser run.
  return poll(
    `layer field request ${layer.layer_id}/${quantity}`,
    () => findLayerFieldRequest(fieldRequests, countBefore, layer.layer_id, quantity),
  );
}

function findLayerFieldRequest(fieldRequests, countBefore, layerId, quantity) {
  const index = fieldRequests.findIndex((request) => {
    const params = new URLSearchParams(request.search);
    return request.path.includes(`/data/fields/${encodeURIComponent(quantity)}/samples/vector`) &&
      params.get("scope_kind") === "layer" &&
      params.get("scope_id") === layerId;
  });
  if (index < 0) return null;
  return {
    observed_after_case_start: index >= countBefore,
    request: fieldRequests[index],
    request_index: index,
  };
}

function assertLayerFieldRequestMatcherSelfTest() {
  const requests = [
    { path: "/v2/sessions/current/data/fields/m/samples/vector", search: "?scope_kind=layer&scope_id=layer%3Abottom" },
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=layer&scope_id=layer%3Atop" },
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=layer&scope_id=layer%3Atop-shell" },
  ];
  const cached = findLayerFieldRequest(requests, 1, "layer:bottom", "m");
  const fresh = findLayerFieldRequest(requests, 1, "layer:top", "H_demag");
  const wrongLayer = findLayerFieldRequest(requests, 0, "layer:top", "m");
  if (
    cached?.observed_after_case_start !== false ||
    fresh?.observed_after_case_start !== true ||
    wrongLayer !== null ||
    findLayerFieldRequest(requests.slice(2), 0, "layer:top", "H_demag") !== null
  ) {
    throw new Error("Layer field request matcher self-test failed.");
  }
}

function buildAirboxIsolationPatch(visible) {
  return {
    overrides: [{
      display: { visible },
      quantity: { active_quantity_id: "H_demag" },
      scope: "airbox",
      scope_id: "airbox",
      visible,
    }],
  };
}

function assertAirboxIsolationPatchSelfTest() {
  const hidden = buildAirboxIsolationPatch(false);
  const shown = buildAirboxIsolationPatch(true);
  if (
    hidden.overrides.length !== 1 ||
    hidden.overrides[0]?.scope !== "airbox" ||
    hidden.overrides[0]?.scope_id !== "airbox" ||
    hidden.overrides[0]?.visible !== false ||
    hidden.overrides[0]?.display?.visible !== false ||
    shown.overrides[0]?.visible !== true
  ) {
    throw new Error("Airbox isolation patch self-test failed.");
  }
}

function assertAirboxVectorPresentationSequence(sequence) {
  const expected = [
    ["wireframe_on", true, false],
    ["wireframe_off", false, false],
    ["vectors_on", false, true],
  ];
  if (!Array.isArray(sequence) || sequence.length !== expected.length) {
    throw new Error(`Airbox vector presentation sequence must contain three committed frames: ${JSON.stringify(sequence)}`);
  }
  let previousRevision = 0;
  let previousFrameId = null;
  let previousCapturedAtMs = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const [phase, wireframeVisible, vectorsVisible] = expected[index];
    const receipt = sequence[index];
    if (
      receipt?.phase !== phase ||
      receipt.wireframe_visible !== wireframeVisible ||
      receipt.vectors_visible !== vectorsVisible ||
      !Number.isSafeInteger(receipt.visualization_revision) ||
      receipt.visualization_revision <= previousRevision ||
      !receipt.frame_commit_id ||
      receipt.frame_commit_id === previousFrameId ||
      !Number.isSafeInteger(receipt.captured_at_ms) ||
      receipt.captured_at_ms <= previousCapturedAtMs ||
      Number.parseInt(String(receipt.frame_commit_id).match(/:(\d+)$/)?.[1] ?? "", 10) !==
        receipt.visualization_revision
    ) {
      throw new Error(`Airbox vector presentation sequence is not monotonic or frame-bound: ${JSON.stringify(sequence)}`);
    }
    previousRevision = receipt.visualization_revision;
    previousFrameId = receipt.frame_commit_id;
    previousCapturedAtMs = receipt.captured_at_ms;
  }
}

function assertAirboxPresentationSequenceSelfTest() {
  assertAirboxVectorPresentationSequence([
    { captured_at_ms: 11, frame_commit_id: "viewport:11", phase: "wireframe_on", vectors_visible: false, visualization_revision: 11, wireframe_visible: true },
    { captured_at_ms: 12, frame_commit_id: "viewport:12", phase: "wireframe_off", vectors_visible: false, visualization_revision: 12, wireframe_visible: false },
    { captured_at_ms: 13, frame_commit_id: "viewport:13", phase: "vectors_on", vectors_visible: true, visualization_revision: 13, wireframe_visible: false },
  ]);
  for (const invalid of [
    [
      { captured_at_ms: 11, frame_commit_id: "viewport:11", phase: "wireframe_on", vectors_visible: false, visualization_revision: 11, wireframe_visible: true },
      { captured_at_ms: 12, frame_commit_id: "viewport:13", phase: "wireframe_off", vectors_visible: false, visualization_revision: 12, wireframe_visible: false },
      { captured_at_ms: 13, frame_commit_id: "viewport:14", phase: "vectors_on", vectors_visible: true, visualization_revision: 13, wireframe_visible: false },
    ],
    [
      { captured_at_ms: 11, frame_commit_id: "viewport:11", phase: "wireframe_on", vectors_visible: false, visualization_revision: 11, wireframe_visible: true },
      { captured_at_ms: 10, frame_commit_id: "viewport:12", phase: "wireframe_off", vectors_visible: false, visualization_revision: 12, wireframe_visible: false },
      { captured_at_ms: 13, frame_commit_id: "viewport:13", phase: "vectors_on", vectors_visible: true, visualization_revision: 13, wireframe_visible: false },
    ],
    [
      { captured_at_ms: 11, frame_commit_id: "viewport:11", phase: "wireframe_on", vectors_visible: false, visualization_revision: 11, wireframe_visible: true },
      { captured_at_ms: 12, frame_commit_id: "viewport:12", phase: "wireframe_off", vectors_visible: false, visualization_revision: 12, wireframe_visible: false },
      { captured_at_ms: 13, frame_commit_id: "viewport:13", phase: "vectors_on", vectors_visible: true, visualization_revision: 13, wireframe_visible: true },
    ],
    [
      { captured_at_ms: 11, frame_commit_id: "viewport:11", phase: "wireframe_on", vectors_visible: false, visualization_revision: 11, wireframe_visible: true },
      { captured_at_ms: 13, frame_commit_id: "viewport:13", phase: "vectors_on", vectors_visible: true, visualization_revision: 13, wireframe_visible: false },
    ],
    [
      { captured_at_ms: 11, frame_commit_id: "viewport:11", phase: "wireframe_on", vectors_visible: false, visualization_revision: 11, wireframe_visible: true },
      { captured_at_ms: 12, frame_commit_id: "viewport:12", phase: "wireframe_off", vectors_visible: true, visualization_revision: 12, wireframe_visible: false },
      { captured_at_ms: 13, frame_commit_id: "viewport:13", phase: "vectors_on", vectors_visible: true, visualization_revision: 13, wireframe_visible: false },
    ],
    [
      { captured_at_ms: 11, frame_commit_id: "viewport:11", phase: "wireframe_on", vectors_visible: false, visualization_revision: 11, wireframe_visible: true },
      { captured_at_ms: 12, frame_commit_id: "viewport:12", phase: "vectors_on", vectors_visible: true, visualization_revision: 12, wireframe_visible: false },
      { captured_at_ms: 13, frame_commit_id: "viewport:13", phase: "wireframe_off", vectors_visible: false, visualization_revision: 13, wireframe_visible: false },
    ],
  ]) {
    let rejected = false;
    try {
      assertAirboxVectorPresentationSequence(invalid);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Airbox sequence self-test accepted an invalid frame-bound receipt.");
  }
}

function qualificationEvidenceForReadbackMode(mode) {
  return mode === "per-case"
    ? {
        qualification_claim: "cpu_fp64_browser_fallback",
        qualification_status: "passed_cpu_fp64_browser_fallback",
      }
    : {
        diagnostic_only: true,
        qualification_claim: null,
        qualification_status: "diagnostic_only",
      };
}

function assertDiagnosticQualificationSelfTest() {
  for (const mode of ["none", "deferred"]) {
    const evidence = qualificationEvidenceForReadbackMode(mode);
    if (
      evidence.diagnostic_only !== true ||
      evidence.qualification_claim !== null ||
      evidence.qualification_status !== "diagnostic_only"
    ) {
      throw new Error(`Diagnostic readback mode ${mode} can emit a qualification claim.`);
    }
  }
  if (
    qualificationEvidenceForReadbackMode("per-case").qualification_status !==
    "passed_cpu_fp64_browser_fallback"
  ) {
    throw new Error("Formal per-case qualification status was weakened.");
  }
  assertRuntimeBinaryReceipt("c".repeat(64));
  let rejectedBinaryReceipt = false;
  try {
    assertRuntimeBinaryReceipt("unknown");
  } catch {
    rejectedBinaryReceipt = true;
  }
  if (!rejectedBinaryReceipt) throw new Error("Runtime binary receipt self-test accepted an invalid SHA-256.");
}

function assertAirboxHiddenBeforeNativeGate(state) {
  const settings = state?.targets?.airbox?.settings;
  if (!settings || settings.visible !== false) {
    throw new Error(`Airbox isolation was not adopted before the native-layer gate: ${JSON.stringify(settings ?? null)}`);
  }
}

function findAirboxFieldRequest(fieldRequests, countBefore, startedAtMs = null) {
  const relativeIndex = fieldRequests.slice(countBefore).findIndex((request) => {
    const params = new URLSearchParams(request.search);
    return request.path.includes("/data/fields/H_demag/samples/vector") &&
      params.get("scope_kind") === "airbox" &&
      params.get("scope_id") === "airbox" &&
      (startedAtMs === null || request.timestamp >= startedAtMs);
  });
  if (relativeIndex < 0) return null;
  const index = countBefore + relativeIndex;
  return {
    observed_after_case_start: true,
    request: fieldRequests[index],
    request_index: index,
  };
}

function assertAirboxFieldRequestMatcherSelfTest() {
  const requests = [
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=airbox&scope_id=airbox" },
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=layer&scope_id=layer%3Atop" },
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=airbox&scope_id=airbox-shell" },
  ];
  const cached = findAirboxFieldRequest(requests, 1);
  const fresh = findAirboxFieldRequest(requests, 0);
  if (
    cached !== null ||
    fresh?.observed_after_case_start !== true ||
    findAirboxFieldRequest(requests.slice(1), 0) !== null
  ) {
    throw new Error("Airbox field request matcher self-test failed.");
  }
}

function exactAirboxFieldRequestsAfter(fieldRequests, countBefore) {
  return fieldRequests.slice(countBefore).filter((request) =>
    resourceKeyHasExactFieldScope(
      `${request.path}${request.search}`,
      "H_demag",
      "airbox",
      "airbox",
    ));
}

function assertGeometryOnlyAirboxRequestFilterSelfTest() {
  const requests = [
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=airbox&scope_id=airbox" },
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=layer&scope_id=layer%3Abottom" },
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=airbox&scope_id=airbox-shell" },
    { path: "/v2/sessions/current/data/fields/H_eff/samples/vector", search: "?scope_kind=airbox&scope_id=airbox" },
    { path: "/v2/sessions/current/data/fields/H_demag/samples/vector", search: "?scope_kind=airbox&scope_id=airbox" },
  ];
  const exactAfterStart = exactAirboxFieldRequestsAfter(requests, 1);
  const exactFromBeginning = exactAirboxFieldRequestsAfter(requests, 0);
  if (
    exactAfterStart.length !== 1 ||
    exactAfterStart[0] !== requests[4] ||
    exactFromBeginning.length !== 2 ||
    exactFromBeginning[0] !== requests[0] ||
    exactFromBeginning[1] !== requests[4]
  ) {
    throw new Error("Geometry-only Airbox field-request filter self-test failed.");
  }
}

function assertAirboxResponseRequestCorrelationSelfTest() {
  const response = {
    field_request_id: "field-request-2",
    response_started_at_ms: 25,
    status: 200,
    url: `${apiBase}/v2/sessions/current/data/fields/H_demag/samples/vector?scope_kind=airbox&scope_id=airbox`,
  };
  if (
    matchesAirboxFieldResponse(response, 20, "field-request-1") ||
    matchesAirboxFieldResponse(response, 30, "field-request-2") ||
    !matchesAirboxFieldResponse(response, 20, "field-request-2")
  ) {
    throw new Error("Airbox response/request correlation self-test failed.");
  }
}

async function waitForAirboxRequest(fieldRequests, countBefore, startedAtMs = null) {
  return poll(
    "Airbox H_demag field request",
    () => findAirboxFieldRequest(fieldRequests, countBefore, startedAtMs),
  );
}

function exactAirboxListenerCount(runtime) {
  return Object.entries(runtime.listenerCounts ?? {})
    .filter(([key]) => resourceKeyHasExactFieldScope(
      key,
      "H_demag",
      "airbox",
      "airbox",
    ))
    .reduce((sum, [, count]) => sum + Number(count), 0);
}

function resourceKeyHasExactFieldScope(key, quantity, scopeKind, scopeId) {
  return String(key).split("|").some((entry) => {
    const queryIndex = entry.indexOf("?");
    if (queryIndex < 0) return false;
    const path = entry.slice(0, queryIndex);
    const params = new URLSearchParams(entry.slice(queryIndex + 1));
    return path.includes(`/data/fields/${encodeURIComponent(quantity)}/samples/vector`) &&
      params.get("scope_kind") === scopeKind &&
      params.get("scope_id") === scopeId;
  });
}

function resourceKeyHasExactScope(key, scopeKind, scopeId) {
  return String(key).split("|").some((entry) => {
    const queryIndex = entry.indexOf("?");
    if (queryIndex < 0) return false;
    const path = entry.slice(0, queryIndex);
    const params = new URLSearchParams(entry.slice(queryIndex + 1));
    return /\/data\/fields\/[^/]+\/samples\/vector$/.test(path) &&
      params.get("scope_kind") === scopeKind &&
      params.get("scope_id") === scopeId;
  });
}

function assertExactListenerMatcherSelfTest() {
  const exactAirbox = "/v2/sessions/current/data/fields/H_demag/samples/vector?scope_kind=airbox&scope_id=airbox";
  const airboxShell = "/v2/sessions/current/data/fields/H_demag/samples/vector?scope_kind=airbox&scope_id=airbox-shell";
  const exactLayer = "/v2/sessions/current/data/fields/m/samples/vector?scope_kind=layer&scope_id=layer%3Atop";
  const layerShell = "/v2/sessions/current/data/fields/m/samples/vector?scope_kind=layer&scope_id=layer%3Atop-shell";
  if (
    !resourceKeyHasExactFieldScope(`${airboxShell}|${exactAirbox}`, "H_demag", "airbox", "airbox") ||
    resourceKeyHasExactFieldScope(airboxShell, "H_demag", "airbox", "airbox") ||
    !resourceKeyHasExactFieldScope(exactLayer, "m", "layer", "layer:top") ||
    resourceKeyHasExactFieldScope(layerShell, "m", "layer", "layer:top") ||
    !resourceKeyHasExactScope(exactLayer, "layer", "layer:top") ||
    resourceKeyHasExactScope(layerShell, "layer", "layer:top")
  ) {
    throw new Error("Exact listener scope matcher self-test failed.");
  }
}

async function ensureHealthyCanvas(page) {
  await page.locator(canvasSelector).waitFor({ state: "visible", timeout: timeoutMs });
  const value = await page.locator(canvasSelector).evaluate((canvas) => {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
    const rect = canvas.getBoundingClientRect();
    return { drawing_buffer: [gl?.drawingBufferWidth ?? 0, gl?.drawingBufferHeight ?? 0], is_context_lost: gl?.isContextLost() ?? true, visible: rect.width > 0 && rect.height > 0 };
  });
  if (!value.visible || value.is_context_lost || value.drawing_buffer.some((dimension) => dimension <= 0)) throw new Error(`WebGL canvas unhealthy: ${JSON.stringify(value)}`);
  return value;
}

async function pageAuditSnapshot(page) {
  const runtime = await page.evaluate(() => window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditRuntime?.() ?? null);
  if (!runtime || !runtime.listenerCounts) throw new Error("Audit runtime hook is missing; cannot prove listener or geometry lifecycle.");
  return runtime;
}

function assertNoGeometryRequestsAfterSwitch(requests, countBefore, label) {
  const countAfter = requests.length;
  if (countAfter !== countBefore) {
    throw new Error(`${label} issued a geometry/topology request during a quantity/presentation switch: ${JSON.stringify(requests.slice(countBefore))}`);
  }
}

function assertHiddenLayerHasNoListener(runtime, layer) {
  const leaked = Object.entries(runtime.listenerCounts ?? {}).filter(
    ([key, count]) =>
      resourceKeyHasExactScope(key, "layer", layer.layer_id) &&
      Number(count) > 0,
  );
  if (leaked.length > 0) throw new Error(`Hidden native layer retained field listener: ${JSON.stringify(leaked)}`);
}

function assertNoScratchCarrierRequests(requests, layout) {
  const scratchTerms = [layout.common_transform_layout?.provenance, "scratch"].filter(Boolean).map((value) => String(value).toLowerCase());
  const leaked = requests.filter((request) => scratchTerms.some((term) => `${request.path}${request.search}`.toLowerCase().includes(term)));
  if (leaked.length > 0) throw new Error(`Common scratch grid was requested as a physical field carrier: ${JSON.stringify(leaked)}`);
}

async function assertCanvasHasFidelity(page) {
  const canvas = page.locator(canvasSelector);
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("Viewport fidelity gate could not measure the WebGL canvas.");
  await canvas.evaluate(() => {
    const style = document.createElement("style");
    style.dataset.viewportAuditIsolation = "true";
    style.textContent = ".fm-viewport-3d *:not(canvas) { visibility: hidden !important; } .fm-viewport-3d canvas { visibility: visible !important; }";
    document.head.append(style);
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  let screenshot;
  try {
    screenshot = await page.screenshot({ clip: box });
  } finally {
    await canvas.evaluate(() => document.querySelector('[data-viewport-audit-isolation="true"]')?.remove());
  }
  const sample = await page.evaluate(async (encodedPng) => {
    const response = await fetch(`data:image/png;base64,${encodedPng}`);
    const bitmap = await createImageBitmap(await response.blob());
    const target = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = target.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
    const reference = [pixels[0], pixels[1], pixels[2]];
    let signature = 2166136261;
    let varied = 0;
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
  if (!sample || sample.varied === 0) throw new Error("Viewport fidelity gate detected a blank or uniform WebGL drawing buffer.");
  return sample;
}

async function captureCanvas(page, path) {
  const png = await page.locator(canvasSelector).screenshot({ path });
  return { path, sha256: createHash("sha256").update(png).digest("hex") };
}

async function writeEvidenceAtomically(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function blockedReasonCodes(error) {
  const message = [error?.message, error?.cause?.message, error].filter(Boolean).map(String).join(" ");
  const reasons = [];
  if (/sandboxCwd|sandbox-state-meta|browser bridge/i.test(message)) reasons.push("browser_bridge_unavailable");
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|ECONNRESET/i.test(message)) reasons.push("api_unreachable");
  if (attemptState.stage === "active-session preflight") reasons.push("active_session_preflight_failed");
  if (attemptState.compute_fields.attempted && !attemptState.compute_fields.completion_status) reasons.push("compute_fields_incomplete");
  if (attemptState.stage.startsWith("browser") || attemptState.stage === "native target preflight") reasons.push("browser_runtime_or_target_preflight_failed");
  if (attemptState.stage === "runtime-origin field proof") reasons.push("runtime_origin_field_proof_failed");
  if (reasons.length === 0) reasons.push("qualification_assertion_failed");
  return [...new Set(reasons)];
}

function blockedEvidence(error) {
  return {
    schema_version: "fdm_multilayer_webgl_matrix_blocked.v2",
    evidence_kind: "blocked_attempt",
    immutable: true,
    qualification_status: "blocked",
    qualification_claim: null,
    generated_at: new Date().toISOString(),
    reason_codes: blockedReasonCodes(error),
    failure: {
      cause: error?.cause ? { code: error.cause.code ?? null, message: error.cause.message ?? String(error.cause), name: error.cause.name ?? null } : null,
      message: String(error?.message ?? error ?? "unknown failure"),
      name: error?.name ?? "Error",
      stage: attemptState.stage,
    },
    attempt: {
      compute_fields: { ...attemptState.compute_fields },
      compute_fields_sent: attemptState.compute_fields.sent,
      session_id: attemptState.session_id ?? null,
      stage: attemptState.stage,
    },
    browser: "playwright-chromium-fallback",
    evidence_path: evidencePath,
    workspace_url: workspaceUrl,
  };
}

async function fetchBinaryField(quantity, query) {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const response = await fetch(`${apiBase}/v2/sessions/current/data/fields/${encodeURIComponent(quantity)}/samples/vector?${params}`);
  if (!response.ok) throw new Error(`Runtime-origin field ${quantity} failed ${response.status}: ${await response.text()}`);
  const body = await response.arrayBuffer();
  if (body.byteLength <= 0) throw new Error(`Runtime-origin field ${quantity} is empty.`);
  return { bytes: body.byteLength, headers: response.headers, status: response.status };
}

async function loadPlaywright() {
  try { return await import("playwright"); } catch { return await import("@playwright/test"); }
}

async function getJson(path) {
  const response = await fetch(apiBase + path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(apiBase + path, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function patchJson(path, body) {
  const response = await fetch(apiBase + path, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "PATCH" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function responseRevision(response) {
  const revision = Number(response?.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error(`Visualization PATCH did not return a positive safe revision: ${JSON.stringify(response)}`);
  }
  return revision;
}

async function poll(label, read) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out after ${timeoutMs} ms.`);
}

function layoutEvidence(layout, layers) {
  return {
    airbox: {
      carrier_available: layout.airbox?.carrier_available ?? false,
      carrier_fingerprint: layout.airbox?.carrier_fingerprint ?? null,
      h_demag_available: layout.airbox?.h_demag_available ?? false,
    },
    common_transform_layout: layout.common_transform_layout,
    fingerprint: layout.layout_fingerprint,
    layers: layers.map((layer) => ({
      layer_id: layer.layer_id,
      magnet_name: layer.magnet_name,
      native_grid: layer.native_grid ?? null,
      native_grid_fingerprint: layer.native_grid_fingerprint ?? null,
      object_id: layer.object_id,
    })),
  };
}

function normalizeToken(value) { return String(value ?? "").trim().toLowerCase(); }
function normalizePrecision(value) {
  const token = normalizeToken(value);
  return token === "fp64" || token === "float64" ? "double" : token;
}

function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function cssEscape(value) { return String(value).replace(/(["\\])/g, "\\$1"); }

try {
  await main();
} catch (error) {
  try {
    await writeEvidenceAtomically(evidencePath, blockedEvidence(error));
  } catch (writeError) {
    console.error(`Unable to persist blocked evidence: ${writeError?.stack ?? writeError}`);
  }
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
