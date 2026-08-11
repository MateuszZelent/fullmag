import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
if (!["per-case", "none", "deferred"].includes(diagnosticReadbackMode)) {
  throw new Error(`Unsupported diagnostic readback mode: ${diagnosticReadbackMode}`);
}
const canvasSelector = ".fm-viewport-3d canvas";
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
  assertExactListenerMatcherSelfTest();
  assertAirboxIsolationPatchSelfTest();
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
      const fieldRequest = { path: url.pathname, search: url.search, timestamp: Date.now() };
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
    if (response.status() >= 400) networkFailures.push({ status: response.status(), url: response.url() });
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
    attemptState.stage = "native target preflight";
    const nativeTargetSurface = await assertNativeLayerTargetSurface(page, layers);
    attemptState.stage = "dual-visible native layer gate";
    await cdp?.send("Tracing.recordClockSyncMarker", { syncId: "dual-visible-start" });
    const dualVisibleBaseline = await runDualVisibleNativeLayerGate({ fieldRequests, layers, page });
    await cdp?.send("Tracing.recordClockSyncMarker", { syncId: "dual-visible-end" });
    attemptState.stage = "native layer matrix";
    const matrix = [];
    const diagnosticReadbacks = [];
    for (const layer of layers) {
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
      airbox.push(await runAirboxCase({ fieldRequests, geometryRequests, layout, mode, page }));
    }
    attemptState.stage = "interaction matrix";
    const interaction = await runInteractionCases({ fieldRequests, geometryRequests, layers, layout, page });
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

async function runAirboxCase({ fieldRequests, geometryRequests, layout, mode, page }) {
  const display = airboxDisplayForMode(mode);
  const geometryRequestCountBefore = geometryRequests.length;
  const fieldRequestCountBefore = fieldRequests.length;
  await patchJson("/v2/sessions/current/visualization/state", {
    active_quantity_id: "H_demag",
    layers: {
      airbox: {
        points: { visible: display.points },
        surface: { visible: display.surface },
        vectors: { density: vectorBudget, domain: "airbox_only", visible: display.vectors },
        visible: true,
        wireframe: { visible: display.wireframe },
      },
    },
    overrides: [{
      display: {
        geometry_scope: "full",
        points: { visible: display.points },
        surface: { visible: display.surface },
        vectors: { visible: display.vectors },
        visible: true,
        wireframe: { visible: display.wireframe },
      },
      quantity: { active_quantity_id: "H_demag" },
      scope: "airbox",
      scope_id: "airbox",
      style: { vector_budget: vectorBudget },
      visible: true,
    }],
    quantity: { active_quantity_id: "H_demag" },
  });
  const fieldRequestProof = await waitForAirboxRequest(
    fieldRequests,
    fieldRequestCountBefore,
  );
  const state = await getJson("/v2/sessions/current/visualization/state");
  const settings = state.targets?.airbox?.settings;
  assertAirboxPresentation(settings, mode, display);
  const canvas = await ensureHealthyCanvas(page);
  const runtime = await pageAuditSnapshot(page);
  const listenerCount = exactAirboxListenerCount(runtime);
  if (!fieldRequestProof.observed_after_case_start && listenerCount <= 0) {
    throw new Error(`Cached Airbox H_demag request has no positive current listener proof: ${JSON.stringify(fieldRequestProof)}`);
  }
  assertNoGeometryRequestsAfterSwitch(geometryRequests, geometryRequestCountBefore, `airbox-${mode}`);
  const fidelity = await assertCanvasHasFidelity(page);
  return {
    canvas,
    case_id: `airbox-${mode}`,
    carrier_fingerprint: layout.airbox.carrier_fingerprint,
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
    screenshot: await captureCanvas(page, `${artifactDir}/airbox-${mode}.png`),
  };
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
}

function assertAirboxHiddenBeforeNativeGate(state) {
  const settings = state?.targets?.airbox?.settings;
  if (!settings || settings.visible !== false) {
    throw new Error(`Airbox isolation was not adopted before the native-layer gate: ${JSON.stringify(settings ?? null)}`);
  }
}

function findAirboxFieldRequest(fieldRequests, countBefore) {
  const index = fieldRequests.findIndex((request) => {
    const params = new URLSearchParams(request.search);
    return request.path.includes("/data/fields/H_demag/samples/vector") &&
      params.get("scope_kind") === "airbox" &&
      params.get("scope_id") === "airbox";
  });
  if (index < 0) return null;
  return {
    observed_after_case_start: index >= countBefore,
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
    cached?.observed_after_case_start !== false ||
    fresh?.observed_after_case_start !== true ||
    findAirboxFieldRequest(requests.slice(1), 0) !== null
  ) {
    throw new Error("Airbox field request matcher self-test failed.");
  }
}

async function waitForAirboxRequest(fieldRequests, countBefore) {
  return poll(
    "Airbox H_demag field request",
    () => findAirboxFieldRequest(fieldRequests, countBefore),
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
