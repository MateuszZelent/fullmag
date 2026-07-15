import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const browserApiBase = (
  process.env.CONTROL_ROOM_BROWSER_API_BASE_URL ?? apiBase
).replace(/\/$/, "");
const browserHostResolverIp =
  process.env.CONTROL_ROOM_BROWSER_HOST_RESOLVER_IP?.trim() ?? "";
const browserExecutablePath =
  process.env.CONTROL_ROOM_BROWSER_EXECUTABLE_PATH?.trim() ?? "";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_AIRBOX_FIELD_SMOKE_TIMEOUT_MS ?? 180_000,
);
const objectId = process.env.CONTROL_ROOM_AIRBOX_FIELD_OBJECT_ID ?? "arch_waveguide";
const objectQuantityId =
  process.env.CONTROL_ROOM_AIRBOX_FIELD_OBJECT_QUANTITY_ID ?? "m";
const airboxQuantityId =
  process.env.CONTROL_ROOM_AIRBOX_FIELD_AIRBOX_QUANTITY_ID ?? "h_demag";
let vectorBudget = Number(
  process.env.CONTROL_ROOM_AIRBOX_FIELD_VECTOR_BUDGET ?? 0,
);
const visualizationDebugArtifactDir =
  process.env.CONTROL_ROOM_VISUALIZATION_DEBUG_ARTIFACT_DIR ??
  "/tmp/fullmag-visualization-debug-browser-proof";
const requestedRegionId =
  process.env.CONTROL_ROOM_VISUALIZATION_DEBUG_REGION_ID?.trim() ?? "";
const VIEWPORT_3D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const VIEWPORT_IDLE_SETTLE_MS = 2_000;
const FIELD_VECTOR_PATH_RE =
  /^\/v2\/sessions\/current\/data\/fields\/([^/]+)\/samples\/vector$/;
const FIELD_META_PATH_RE =
  /^\/v2\/sessions\/current\/data\/fields\/([^/]+)\/meta$/;
const TERMINAL_COMMAND_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "rejected",
  "skipped",
]);

async function main() {
  const sessionStatus = await assertActiveSession();
  const manifest = await getJson(
    "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
  );
  const regions = await getJson("/v2/sessions/current/model/regions");
  const objectPartId = resolveObjectPartId(manifest, objectId);
  const airboxPartId = resolveAirboxPartId(manifest);
  const regionScenario = resolveVisualizationDebugRegionScenario({
    manifest,
    objectId,
    regions,
    requestedRegionId,
  });
  const availableAirOnlyNodeCount = resolveAirOnlyNodeCount(manifest);
  if (!Number.isFinite(vectorBudget) || vectorBudget <= 0) {
    vectorBudget = availableAirOnlyNodeCount;
  }
  const expectedAirboxSampleCount = Math.min(
    Math.floor(vectorBudget),
    availableAirOnlyNodeCount,
  );

  await ensureBinaryVectorEndpointsReady([
    {
      quantityId: objectQuantityId,
      query: {
        component: "full",
        max_samples: vectorBudget,
        scope_id: objectPartId,
        scope_kind: "part",
      },
    },
    {
      quantityId: airboxQuantityId,
      query: {
        component: "full",
        max_samples: vectorBudget,
        scope_id: airboxPartId,
        scope_kind: "airbox",
      },
    },
    {
      quantityId: objectQuantityId,
      query: {
        component: "full",
        max_samples: vectorBudget,
        scope_id: regionScenario.carrierId,
        scope_kind: "part",
      },
    },
  ]);

  const visualizationState = await getJson(
    "/v2/sessions/current/visualization/state",
  );
  const patchedState = await patchJson(
    "/v2/sessions/current/visualization/state",
    buildVisualizationRoutingPatch(visualizationState, regionScenario),
  );
  assertVisualizationRoutingState(patchedState, regionScenario);
  await mkdir(visualizationDebugArtifactDir, { recursive: true });

  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Airbox field routing smoke requires Playwright or @playwright/test in the current environment.",
    );
  }

  const browser = await playwright.chromium.launch({
    ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}),
    ...(browserHostResolverIp
      ? {
          args: [
            `--host-resolver-rules=MAP localhost ${browserHostResolverIp}`,
          ],
        }
      : {}),
  });
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const fieldRequests = [];
  const fieldMetaRequests = [];
  const fieldResponses = [];
  const errors = [];
  const networkFailures = [];
  let navigationCount = 0;

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
    window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrameReasons: {},
      viewportFrames: 0,
    };
  }, browserApiBase);

  page.on("console", (message) => {
    const text = message.text();
    if (
      (message.type() === "error" || /hydration|context lost|decode/i.test(text)) &&
      !isIgnorableConsoleError(text)
    ) {
      errors.push(text);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationCount += 1;
  });
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const parsed = parseFieldVectorUrl(request.url());
    if (parsed) {
      fieldRequests.push({ ...parsed, timestamp: Date.now(), url: request.url() });
      return;
    }
    const fieldMeta = parseFieldMetaUrl(request.url());
    if (fieldMeta) {
      fieldMetaRequests.push({
        ...fieldMeta,
        timestamp: Date.now(),
        url: request.url(),
      });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      networkFailures.push({
        method: response.request().method(),
        status: response.status(),
        url: response.url(),
      });
    }
    if (response.request().method() !== "GET") return;
    const parsed = parseFieldVectorUrl(response.url());
    if (!parsed) return;
    fieldResponses.push({
      ...parsed,
      headers: response.headers(),
      status: response.status(),
      timestamp: Date.now(),
      url: response.url(),
    });
  });

  try {
    await page.goto(workspaceUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await ensureViewport3DActive(page);
    if (navigationCount !== 1) {
      throw new Error(
        `Expected exactly one workspace navigation, observed ${navigationCount}.`,
      );
    }
    const proof = await waitForFieldRoutingProof({
      fieldRequests,
      fieldResponses,
      airboxPartId,
      expectedAirboxSampleCount,
      objectPartId,
    });
    const debugIdleProof = await assertVisualizationDebugIdleBudgets({
      fieldRequests,
      page,
    });
    const accountingProof = await assertAirboxInspectorAccounting({
      airboxPartId,
      availableAirOnlyNodeCount,
      expectedAirboxSampleCount,
      fieldRequests,
      page,
      proof,
    });
    const visualizationDebugProof = await assertVisualizationDebugScenarios({
      airboxPartId,
      errors,
      fieldMetaRequests,
      fieldRequests,
      fieldResponses,
      getNavigationCount: () => navigationCount,
      networkFailures,
      objectPartId,
      page,
      regionScenario,
    });
    if (errors.length > 0) {
      throw new Error("Browser console errors:\n" + errors.join("\n"));
    }
    if (networkFailures.length > 0) {
      throw new Error(
        `Browser network responses failed: ${JSON.stringify(networkFailures)}.`,
      );
    }
    console.log(
      `Airbox field routing proof: ${JSON.stringify({
        ...proof,
        ...debugIdleProof,
        ...accountingProof,
        ...visualizationDebugProof,
        apiBase,
        browserApiBase,
        sessionId: resolveStatusSessionId(sessionStatus),
        workspaceUrl,
      })}`,
    );
    console.log(`Airbox field routing smoke passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

async function assertVisualizationDebugIdleBudgets({ fieldRequests, page }) {
  await waitForVisualizationDebugQuiet({ fieldRequests, page });
  const before = await readVisualizationDebugPerformance(page);
  const requestCountBefore = fieldRequests.length;
  await page.waitForTimeout(750);
  const after = await readVisualizationDebugPerformance(page);
  const debugIdleFieldRequests = fieldRequests.slice(requestCountBefore);
  const debugFieldRequestDelta = fieldRequests.length - requestCountBefore;
  const debugIdleFieldRequestDelta = debugFieldRequestDelta;
  const debugIdleFrameDelta = after.viewportFrames - before.viewportFrames;
  const debugIdleFrameReasons = subtractCounterMaps(
    after.viewportFrameReasons,
    before.viewportFrameReasons,
  );
  const debugIdleScanDelta = after.scans - before.scans;
  const debugIdlePublishDelta = after.publishes - before.publishes;
  const metrics = {
    debugFieldRequestDelta,
    debugIdleFieldRequestDelta,
    debugIdleFrameDelta,
    debugIdlePublishDelta,
    debugIdleScanDelta,
  };
  for (const [name, value] of Object.entries(metrics)) {
    if (value !== 0) {
      throw new Error(
        `Visualization Debug idle budget ${name} must be 0, got ${value}; dirty reasons=${JSON.stringify(debugIdleFrameReasons)}; field requests=${JSON.stringify(debugIdleFieldRequests)}.`,
      );
    }
  }
  if (after.scans !== 0 || after.publishes !== 0) {
    throw new Error(
      `Closed Visualization Debug performed work: scans=${after.scans} publishes=${after.publishes}.`,
    );
  }
  return metrics;
}

async function waitForVisualizationDebugQuiet({ fieldRequests, page }) {
  let previous = null;
  let stableSince = Date.now();
  await poll("Visualization Debug idle settle", async () => {
    const counters = await readVisualizationDebugPerformance(page);
    const current = `${fieldRequests.length}:${counters.viewportFrames}:${counters.scans}:${counters.publishes}`;
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
      return null;
    }
    return Date.now() - stableSince >= VIEWPORT_IDLE_SETTLE_MS ? counters : null;
  });
}

async function readVisualizationDebugPerformance(page) {
  return page.evaluate(() =>
    window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ ?? {
      publishes: 0,
      scans: 0,
      viewportFrameReasons: {},
      viewportFrames: 0,
    },
  );
}

function subtractCounterMaps(after = {}, before = {}) {
  return Object.fromEntries(
    Object.entries(after)
      .map(([key, value]) => [key, value - (before[key] ?? 0)])
      .filter(([, value]) => value > 0),
  );
}

function buildVisualizationRoutingPatch(state, regionScenario) {
  const overrides = (state.overrides ?? []).filter(
    (entry) =>
      !(
        (entry.scope === "airbox" && entry.scope_id === "airbox") ||
        (entry.scope === "object" && entry.scope_id === objectId) ||
        (entry.scope === "part" && entry.scope_id === regionScenario.carrierId)
      ),
  );
  overrides.push({
    display: {
      geometry_scope: "surface",
      surface: { visible: true },
      vectors: { visible: true },
      visible: true,
      wireframe: { visible: true },
    },
    quantity: { active_quantity_id: objectQuantityId },
    scope: "object",
    scope_id: objectId,
    style: {
      vector_budget: vectorBudget,
      vector_color_mode: "orientation",
    },
    visible: true,
  });
  overrides.push({
    display: {
      geometry_scope: "full",
      surface: { visible: true },
      vectors: { visible: true },
      visible: true,
      wireframe: { visible: true },
    },
    quantity: { active_quantity_id: airboxQuantityId },
    scope: "airbox",
    scope_id: "airbox",
    style: {
      vector_budget: vectorBudget,
      vector_color_mode: "orientation",
    },
    visible: true,
  });
  overrides.push({
    display: {
      geometry_scope: "surface",
      surface: { visible: true },
      vectors: { visible: true },
      visible: true,
      wireframe: { visible: true },
    },
    quantity: { active_quantity_id: objectQuantityId },
    scope: "part",
    scope_id: regionScenario.carrierId,
    style: {
      vector_budget: vectorBudget,
      vector_color_mode: "orientation",
    },
    visible: true,
  });

  return {
    active_quantity_id: objectQuantityId,
    layers: {
      surface: { visible: true },
      vectors: {
        density: vectorBudget,
        domain: "auto",
        visible: true,
      },
      airbox: {
        surface: { visible: true },
        vectors: {
          density: vectorBudget,
          domain: "airbox_only",
          visible: true,
        },
        visible: true,
        wireframe: { visible: true },
      },
    },
    overrides,
    quantity: { active_quantity_id: objectQuantityId },
    vector_glyphs: true,
  };
}

function assertVisualizationRoutingState(state, regionScenario) {
  const objectTarget = (state.targets?.objects ?? []).find(
    (target) => target.scope_id === objectId,
  );
  const airboxQuantity =
    state.targets?.airbox?.settings?.active_quantity_id ??
    state.quantity?.active_quantity_id ??
    state.active_quantity_id;
  const regionOverride = (state.overrides ?? []).find(
    (entry) =>
      entry.scope === "part" && entry.scope_id === regionScenario.carrierId,
  );
  if (normalizeQuantityId(state.quantity?.active_quantity_id) !== "m") {
    throw new Error(
      `Global visualization quantity was not patched to m: ${state.quantity?.active_quantity_id}`,
    );
  }
  if (normalizeQuantityId(objectTarget?.settings?.active_quantity_id) !== "m") {
    throw new Error(
      `Object visualization quantity was not patched to m: ${objectTarget?.settings?.active_quantity_id}`,
    );
  }
  if (normalizeQuantityId(airboxQuantity) !== "h_demag") {
    throw new Error(
      `Airbox visualization quantity was not patched to h_demag: ${airboxQuantity}`,
    );
  }
  if (state.layers?.airbox?.vectors?.domain !== "airbox_only") {
    throw new Error(
      `Airbox vectors domain must be airbox_only, got ${state.layers?.airbox?.vectors?.domain}`,
    );
  }
  for (const [label, settings] of [
    ["Airbox", state.targets?.airbox?.settings],
    ["object", objectTarget?.settings],
  ]) {
    if (settings?.surface_visible !== true || settings?.vectors_visible !== true) {
      throw new Error(
        `${label} proof target must have surface and vectors visible: ${JSON.stringify(settings)}.`,
      );
    }
  }
  if (
    regionOverride?.display?.surface?.visible !== true ||
    regionOverride?.display?.vectors?.visible !== true
  ) {
    throw new Error(
      `Region proof override must have surface and vectors visible: ${JSON.stringify(regionOverride)}.`,
    );
  }
}

async function waitForFieldRoutingProof({
  fieldRequests,
  fieldResponses,
  airboxPartId,
  expectedAirboxSampleCount,
  objectPartId,
}) {
  return poll("viewport field routing proof", async () => {
    const objectRequest = fieldRequests.find(
      (entry) =>
        normalizeQuantityId(entry.quantityId) === "m" &&
        (entry.params.scope_kind === "part" ||
          entry.params.scope_kind === "object") &&
        (entry.params.scope_id === objectPartId ||
          entry.params.scope_id === objectId),
    );
    const airboxRequest = fieldRequests.find(
      (entry) =>
        normalizeQuantityId(entry.quantityId) === "h_demag" &&
        entry.params.scope_kind === "airbox" &&
        entry.params.scope_id === airboxPartId &&
        Number(entry.params.max_samples) === expectedAirboxSampleCount,
    );
    const forbiddenHdemagRequests = fieldRequests.filter(
      (entry) =>
        normalizeQuantityId(entry.quantityId) === "h_demag" &&
        (entry.params.scope_kind === "full" ||
          !entry.params.scope_kind ||
          !entry.params.scope_id),
    );
    const failedResponses = fieldResponses.filter((entry) => entry.status >= 400);
    if (failedResponses.length > 0) {
      throw new Error(
        "Field vector requests failed: " +
          failedResponses
            .map((entry) => `${entry.status} ${entry.path}?${entry.search}`)
            .join(", "),
      );
    }
    if (forbiddenHdemagRequests.length > 0) {
      throw new Error(
        "H_demag used full-domain field-vector requests: " +
          forbiddenHdemagRequests
            .map((entry) => `${entry.path}?${entry.search}`)
            .join(", "),
      );
    }
    const objectResponse = objectRequest
      ? matchingResponse(fieldResponses, objectRequest)
      : null;
    const airboxResponse = airboxRequest
      ? matchingResponse(fieldResponses, airboxRequest)
      : null;
    if (!objectRequest || !objectResponse || !airboxRequest || !airboxResponse) {
      return null;
    }
    return {
      airboxRequest: responseSummary(airboxResponse),
      airboxPointCount: responsePointCount(airboxResponse),
      forbiddenHdemagFullDomainRequestCount: forbiddenHdemagRequests.length,
      objectRequest: responseSummary(objectResponse),
      requestCount: fieldRequests.length,
      responseCount: fieldResponses.length,
    };
  });
}

async function assertAirboxInspectorAccounting({
  airboxPartId,
  availableAirOnlyNodeCount,
  expectedAirboxSampleCount,
  fieldRequests,
  page,
  proof,
}) {
  const airboxRow = page.locator(
    '[data-node-id="model:airbox:visualization"]',
  );
  await airboxRow.waitFor({ state: "visible", timeout: timeoutMs });
  await airboxRow.click({ timeout: timeoutMs });

  const accounting = await poll("Airbox Inspector accounting", async () => {
    const available = await readInspectorCount(
      page,
      "Available air-only nodes",
    );
    const decoded = await readInspectorCount(page, "Decoded field samples");
    const adopted = await readInspectorCount(page, "Adopted arrows");
    return available === null || decoded === null || adopted === null
      ? null
      : { adopted, available, decoded };
  });
  if (accounting.available !== availableAirOnlyNodeCount) {
    throw new Error(
      `Inspector available Airbox nodes ${accounting.available} != derived ${availableAirOnlyNodeCount}.`,
    );
  }
  if (accounting.decoded !== proof.airboxPointCount) {
    throw new Error(
      `Inspector decoded samples ${accounting.decoded} != FMVP ${proof.airboxPointCount}.`,
    );
  }
  if (accounting.decoded !== expectedAirboxSampleCount) {
    throw new Error(
      `Inspector decoded samples ${accounting.decoded} != requested full-budget samples ${expectedAirboxSampleCount}.`,
    );
  }
  if (accounting.adopted !== accounting.decoded) {
    throw new Error(
      `Inspector adopted arrows ${accounting.adopted} != decoded samples ${accounting.decoded}.`,
    );
  }
  const allAirboxRequests = fieldRequests.filter(
    (entry) =>
      normalizeQuantityId(entry.quantityId) === "h_demag" &&
      entry.params.scope_kind === "airbox" &&
      entry.params.scope_id === airboxPartId,
  );
  if (allAirboxRequests.length !== 1) {
    throw new Error(
      `Expected one Airbox FMVP request, observed ${allAirboxRequests.length}.`,
    );
  }
  const [matchingRequest] = allAirboxRequests;
  if (Number(matchingRequest.params.max_samples) !== expectedAirboxSampleCount) {
    throw new Error(
      `Airbox FMVP max_samples ${matchingRequest.params.max_samples} != exact budget ${expectedAirboxSampleCount}.`,
    );
  }
  return {
    inspectorAdoptedArrowCount: accounting.adopted,
    inspectorAvailableAirOnlyNodeCount: accounting.available,
    inspectorDecodedSampleCount: accounting.decoded,
    matchingAirboxFieldRequestCount: allAirboxRequests.length,
  };
}

async function assertVisualizationDebugScenarios({
  airboxPartId,
  errors,
  fieldMetaRequests,
  fieldRequests,
  fieldResponses,
  getNavigationCount,
  networkFailures,
  objectPartId,
  page,
  regionScenario,
}) {
  const scenarios = [
    {
      debugNodeId: "model:airbox:visualization:debug",
      expectedCarrierId: airboxPartId,
      expectedScopeId: airboxPartId,
      expectedScopeKind: "airbox",
      expectedSelectionKind: "airbox.visualization.debug",
      expectedTargetId: "airbox",
      expectedTargetKind: "airbox",
      explorerAncestors: ["model:airbox"],
      key: "airbox",
      ordinaryNodeId: "model:airbox:visualization",
      quantityId: airboxQuantityId,
    },
    {
      debugNodeId: `model:object:${objectId}:visualization:debug`,
      expectedCarrierId: objectPartId,
      expectedScopeId: objectPartId,
      expectedScopeKind: "part",
      expectedSelectionKind: "object.visualization.debug",
      expectedTargetId: `object:${objectId}`,
      expectedTargetKind: "object",
      explorerAncestors: ["model:objects", `model:object:${objectId}`],
      key: "object",
      ordinaryNodeId: `model:object:${objectId}:visualization`,
      quantityId: objectQuantityId,
    },
    {
      debugNodeId: regionScenario.debugNodeId,
      expectedCarrierId: regionScenario.carrierId,
      expectedScopeId: regionScenario.carrierId,
      expectedScopeKind: "part",
      expectedSelectionKind: "region.visualization.debug",
      expectedTargetId: regionScenario.targetId,
      expectedTargetKind: "region",
      explorerAncestors: regionScenario.explorerAncestors,
      key: "region",
      ordinaryNodeId: regionScenario.ordinaryNodeId,
      quantityId: objectQuantityId,
    },
  ];
  const results = [];
  for (const scenario of scenarios) {
    results.push(
      await assertVisualizationDebugScenario({
        errors,
        fieldMetaRequests,
        fieldRequests,
        fieldResponses,
        getNavigationCount,
        networkFailures,
        page,
        scenario,
      }),
    );
  }
  return {
    visualizationDebugArtifactDir,
    visualizationDebugScenarios: results,
  };
}

async function assertVisualizationDebugScenario({
  errors,
  fieldMetaRequests,
  fieldRequests,
  fieldResponses,
  getNavigationCount,
  networkFailures,
  page,
  scenario,
}) {
  assertSingleNavigation(getNavigationCount(), `${scenario.key} ordinary`);
  await revealExplorerNode(page, scenario, false);
  await page.locator(`[data-node-id="${scenario.ordinaryNodeId}"]`).click({
    timeout: timeoutMs,
  });
  await pollSelectedExplorerNode(page, scenario.ordinaryNodeId);
  await resetInspectorScroll(page);
  const beforeState = comparableVisualizationState(
    await getJson("/v2/sessions/current/visualization/state"),
  );
  const beforeCanvas = await captureVisualizationDebugCanvas(
    page,
    `${visualizationDebugArtifactDir}/${scenario.key}-before-canvas.png`,
  );
  await page.screenshot({
    path: `${visualizationDebugArtifactDir}/${scenario.key}-before-visualization.png`,
  });

  await revealExplorerNode(page, scenario, true);
  const fieldVectorCountBefore = fieldRequests.length;
  const fieldMetaCountBefore = fieldMetaRequests.length;
  const debugRow = page.locator(`[data-node-id="${scenario.debugNodeId}"]`);
  await debugRow.focus();
  await page.keyboard.press("Enter");
  await pollSelectedExplorerNode(page, scenario.debugNodeId);
  const evidence = await waitForExactVisualizationDebugEvidence({
    fieldRequests,
    fieldResponses,
    page,
    scenario,
  });
  await waitForVisualizationDebugSettled({ fieldMetaRequests, fieldRequests, page });
  const afterState = comparableVisualizationState(
    await getJson("/v2/sessions/current/visualization/state"),
  );
  const afterCanvas = await captureVisualizationDebugCanvas(
    page,
    `${visualizationDebugArtifactDir}/${scenario.key}-after-canvas.png`,
  );
  await resetInspectorScroll(page);
  await page.screenshot({
    path: `${visualizationDebugArtifactDir}/${scenario.key}-after-debug.png`,
  });

  assertSingleNavigation(getNavigationCount(), `${scenario.key} Debug`);
  assertVisualizationStateUnchanged(scenario.key, beforeState, afterState);
  if (beforeCanvas.canvasSha256 !== afterCanvas.canvasSha256) {
    throw new Error(
      `${scenario.key} viewport changed after opening Debug: ${beforeCanvas.canvasSha256} != ${afterCanvas.canvasSha256}.`,
    );
  }
  const fieldVectorRequestDeltaAfterSettle =
    fieldRequests.length - fieldVectorCountBefore;
  const fieldMetaRequestDeltaAfterSettle =
    fieldMetaRequests.length - fieldMetaCountBefore;
  if (fieldVectorRequestDeltaAfterSettle !== 0) {
    throw new Error(
      `${scenario.key} Debug added ${fieldVectorRequestDeltaAfterSettle} FMVP field-vector request(s) after settle.`,
    );
  }
  if (fieldMetaRequestDeltaAfterSettle > 1) {
    throw new Error(
      `${scenario.key} Debug added ${fieldMetaRequestDeltaAfterSettle} field-meta request(s) after settle.`,
    );
  }
  const debugMetaRequestsAfterSettle = fieldMetaRequests.slice(fieldMetaCountBefore);
  if (
    debugMetaRequestsAfterSettle.some(
      (request) =>
        request.params.scope_kind !== scenario.expectedScopeKind ||
        request.params.scope_id !== scenario.expectedScopeId,
    )
  ) {
    throw new Error(
      `${scenario.key} Debug field-meta request was not exact after settle: ${JSON.stringify(debugMetaRequestsAfterSettle)}.`,
    );
  }

  const idleBefore = await readVisualizationDebugPerformance(page);
  const idleRequestCountBefore = fieldRequests.length + fieldMetaRequests.length;
  await page.waitForTimeout(VIEWPORT_IDLE_SETTLE_MS);
  const idleAfter = await readVisualizationDebugPerformance(page);
  const idleRequestDelta =
    fieldRequests.length + fieldMetaRequests.length - idleRequestCountBefore;
  const idleFrameDelta = idleAfter.viewportFrames - idleBefore.viewportFrames;
  const idleScanDelta = idleAfter.scans - idleBefore.scans;
  const idlePublishDelta = idleAfter.publishes - idleBefore.publishes;
  if (
    idleFrameDelta !== 0 ||
    idleScanDelta !== 0 ||
    idlePublishDelta !== 0 ||
    idleRequestDelta !== 0
  ) {
    throw new Error(
      `${scenario.key} Debug idle churn: ${JSON.stringify({ idleFrameDelta, idlePublishDelta, idleRequestDelta, idleScanDelta })}.`,
    );
  }

  const requestCountBeforeKeyboard = fieldRequests.length + fieldMetaRequests.length;
  const keyboard = await assertVisualizationDebugKeyboardOrder(
    page,
    scenario.debugNodeId,
  );
  if (fieldRequests.length + fieldMetaRequests.length !== requestCountBeforeKeyboard) {
    throw new Error(`${scenario.key} keyboard proof added a debug data request.`);
  }
  assertVisualizationDebugStatusText(evidence.dom.statusText, scenario.key);
  assertSingleNavigation(getNavigationCount(), `${scenario.key} keyboard proof`);
  if (errors.length > 0) {
    throw new Error(`${scenario.key} browser errors: ${JSON.stringify(errors)}.`);
  }
  if (networkFailures.length > 0) {
    throw new Error(
      `${scenario.key} network responses >=400: ${JSON.stringify(networkFailures)}.`,
    );
  }

  return {
    afterCanvas,
    beforeCanvas,
    canonicalResourceKey: evidence.resourceKey,
    carrierId: scenario.expectedCarrierId,
    decodedScope: `${scenario.expectedScopeKind}:${scenario.expectedScopeId}`,
    fieldMetaRequestDelta: fieldMetaRequestDeltaAfterSettle,
    fieldMetaRequestDeltaAfterSettle,
    fieldVectorRequestDelta: fieldVectorRequestDeltaAfterSettle,
    fieldVectorRequestDeltaAfterSettle,
    idleFrameDelta,
    idlePublishDelta,
    idleRequestDelta,
    idleScanDelta,
    keyboard,
    memoryGroupTotals: evidence.dom.memoryGroupTotals,
    pointCount: evidence.pointCount,
    screenshots: {
      after: `${visualizationDebugArtifactDir}/${scenario.key}-after-debug.png`,
      before: `${visualizationDebugArtifactDir}/${scenario.key}-before-visualization.png`,
    },
    statisticsRows: evidence.dom.statisticsRows.length - 1,
    targetId: scenario.expectedTargetId,
    valueCount: evidence.valueCount,
  };
}

async function revealExplorerNode(page, scenario, includeDebug) {
  for (const id of scenario.explorerAncestors) {
    await expandExplorerNode(page, id);
  }
  await page.locator(`[data-node-id="${scenario.ordinaryNodeId}"]`).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if (includeDebug) await expandExplorerNode(page, scenario.ordinaryNodeId);
}

async function expandExplorerNode(page, id) {
  const row = page.locator(`[data-node-id="${id}"]`);
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.focus();
    await page.keyboard.press("ArrowRight");
  }
}

async function pollSelectedExplorerNode(page, nodeId) {
  await poll(`Explorer selection ${nodeId}`, async () => {
    const selected = await page
      .locator(`[data-node-id="${nodeId}"]`)
      .getAttribute("aria-selected");
    return selected === "true" ? true : null;
  });
}

async function resetInspectorScroll(page) {
  const inspectorBody = page.locator(".fm-inspector__body");
  if ((await inspectorBody.count()) === 0) return;
  await inspectorBody.evaluate((node) => {
    node.scrollTop = 0;
  });
}

async function waitForExactVisualizationDebugEvidence({
  fieldRequests,
  fieldResponses,
  page,
  scenario,
}) {
  const start = Date.now();
  let lastReason = "no DOM snapshot";
  while (Date.now() - start < timeoutMs) {
    const dom = await readVisualizationDebugDom(page);
    const request = [...fieldRequests].reverse().find(
      (entry) =>
        normalizeQuantityId(entry.quantityId) ===
          normalizeQuantityId(scenario.quantityId) &&
        entry.params.scope_kind === scenario.expectedScopeKind &&
        entry.params.scope_id === scenario.expectedScopeId,
    );
    const response = request ? matchingResponse(fieldResponses, request) : null;
    const resourceKey = request ? `${request.path}?${request.search}` : null;
    const pointCount = Number(response?.headers?.["x-fullmag-point-count"]);
    const valueCount = Number(response?.headers?.["x-fullmag-value-count"]);
    const [domPointCount, domValueCount] = parseInspectorCountPair(
      visualizationDebugFieldValue(dom, "Points / values"),
    );
    const [domNodeIndexCount] = parseInspectorCountPair(
      visualizationDebugFieldValue(dom, "Indexing / node indices"),
    );
    const grid = visualizationDebugFieldValue(dom, "Grid");
    const checks = [
      [dom.header?.includes("Visualization Debug"), "Debug Inspector header"],
      [visualizationDebugFieldValue(dom, "Selection kind") === scenario.expectedSelectionKind, "selection kind"],
      [visualizationDebugFieldValue(dom, "Target kind") === scenario.expectedTargetKind, "target kind"],
      [visualizationDebugFieldValue(dom, "Target ID") === scenario.expectedTargetId, "target ID"],
      [visualizationDebugFieldValue(dom, "Carrier IDs")?.split(", ").includes(scenario.expectedCarrierId), "carrier ID"],
      [visualizationDebugFieldValue(dom, "Canonical resource key") === resourceKey, "canonical resource key"],
      [visualizationDebugFieldValue(dom, "Dtype / FMVP") === "float64 / v3", "FMVP version"],
      [Boolean(grid && grid !== "—" && /^\d[\d,]*( × \d[\d,]*){2}$/.test(grid)), "grid dimensions"],
      [visualizationDebugFieldValue(dom, "nComp") === "3", "component count"],
      [visualizationDebugFieldValue(dom, "Decoded component") === "— (not encoded)", "decoded component provenance"],
      [domPointCount === pointCount && Number.isInteger(pointCount), "point count"],
      [domValueCount === valueCount && Number.isInteger(valueCount), "value count"],
      [
        visualizationDebugFieldValue(dom, "Indexing / node indices")?.startsWith("sampled_node_indices / ") &&
          domNodeIndexCount === pointCount,
        "sampled node indexing",
      ],
      [visualizationDebugFieldValue(dom, "Scope") === `${scenario.expectedScopeKind}:${scenario.expectedScopeId}`, "decoded scope"],
      [response?.status === 200, "field response status"],
      [response?.headers?.["x-fullmag-encoding"] === "FMVP;version=3", "FMVP response header"],
      [dom.statisticsRows.length > 1 && hasVisualizationDebugMinMax(dom.statisticsRows), "min/max statistics"],
      [dom.sampleRows.length > 1, "bounded sample values"],
      [dom.memoryGroupTotals.some((value) => value !== "0 B" && value !== "—"), "memory totals"],
      [dom.statusText.length > 0 && !/loading visualization evidence/i.test(dom.statusText), "status text"],
      [!dom.issueCodes.some((code) => /stale/i.test(code)), "fresh snapshot"],
    ];
    const failed = checks.find(([passed]) => !passed);
    if (!failed) {
      return { dom, pointCount, request, resourceKey, response, valueCount };
    }
    lastReason = failed[1];
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Timed out waiting for ${scenario.key} exact Visualization Debug evidence; last missing check=${lastReason}.`,
  );
}

async function readVisualizationDebugDom(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".fm-visualization-debug-panel");
    const tables = [...(panel?.querySelectorAll("table") ?? [])].map((table) => ({
      label: table.getAttribute("aria-label") ?? "",
      rows: [...table.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("th,td")].map((cell) => cell.textContent?.trim() ?? ""),
      ),
    }));
    const fields = [...(panel?.querySelectorAll(".fm-inspector-field-row") ?? [])].map(
      (row) => ({
        label: row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "",
        value: row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? "",
      }),
    );
    return {
      fields,
      header: document.querySelector(".fm-inspector__header")?.textContent?.trim() ?? "",
      issueCodes: [...(panel?.querySelectorAll(".fm-visualization-debug-issues strong") ?? [])].map(
        (node) => node.textContent?.trim() ?? "",
      ),
      memoryGroupTotals: fields
        .filter((field) => field.label === "Group total")
        .map((field) => field.value),
      sampleRows:
        tables.find((table) => table.label.toLowerCase().includes("sample"))?.rows ?? [],
      statisticsRows:
        tables.find((table) => table.label === "Statistics by evidence source")?.rows ?? [],
      statusText:
        panel?.querySelector('[role="status"]')?.textContent?.trim() ?? "",
    };
  });
}

function visualizationDebugFieldValue(dom, label) {
  return dom.fields.find((field) => field.label === label)?.value ?? null;
}

function parseInspectorCountPair(value) {
  return (String(value ?? "").match(/[\d,]+/g) ?? [])
    .slice(0, 2)
    .map((entry) => Number(entry.replaceAll(",", "")));
}

function hasVisualizationDebugMinMax(rows) {
  return rows
    .slice(1)
    .some((cells) => cells[2] && cells[2] !== "—" && cells[3] && cells[3] !== "—");
}

function comparableVisualizationState(state) {
  return {
    activeQuantityId: state.active_quantity_id ?? null,
    autoContrast: state.auto_contrast ?? null,
    colormap: state.colormap ?? null,
    contrastMax: state.contrast_max ?? null,
    contrastMin: state.contrast_min ?? null,
    layers: state.layers ?? null,
    maxPoints: state.max_points ?? null,
    overrides: state.overrides ?? null,
    quantity: state.quantity ?? null,
    sampling: state.sampling ?? null,
    targets: state.targets ?? null,
    vectorDensity: state.vector_density ?? null,
    vectorGlyphs: state.vector_glyphs ?? null,
    vectorStyle: state.vector_style ?? null,
    viewMode: state.view_mode ?? null,
  };
}

function assertVisualizationStateUnchanged(key, before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `${key} visualization quality/range/visibility/vector-density changed after opening Debug.`,
    );
  }
}

async function captureVisualizationDebugCanvas(page, path) {
  const canvas = page.locator(VIEWPORT_3D_CANVAS_SELECTOR);
  const state = await canvas.evaluate((element) => {
    const gl =
      element.getContext("webgl2") ??
      element.getContext("webgl") ??
      element.getContext("experimental-webgl");
    const rect = element.getBoundingClientRect();
    return {
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      height: rect.height,
      isContextLost: gl ? gl.isContextLost() : null,
      visible: rect.width > 0 && rect.height > 0,
      width: rect.width,
    };
  });
  if (
    !state.visible ||
    state.width <= 0 ||
    state.height <= 0 ||
    state.isContextLost !== false ||
    state.drawingBufferWidth <= 0 ||
    state.drawingBufferHeight <= 0
  ) {
    throw new Error(`Viewport canvas is not renderable: ${JSON.stringify(state)}.`);
  }
  const png = await canvas.screenshot({ path });
  return {
    ...state,
    canvasSha256: createHash("sha256").update(png).digest("hex"),
  };
}

async function waitForVisualizationDebugSettled({
  fieldMetaRequests,
  fieldRequests,
  page,
}) {
  let previous = null;
  let stableSince = Date.now();
  await poll("open Visualization Debug settle", async () => {
    const counters = await readVisualizationDebugPerformance(page);
    const current = JSON.stringify({
      frames: counters.viewportFrames,
      publishes: counters.publishes,
      requests: fieldRequests.length + fieldMetaRequests.length,
      scans: counters.scans,
    });
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
      return null;
    }
    return Date.now() - stableSince >= VIEWPORT_IDLE_SETTLE_MS ? counters : null;
  });
}

async function assertVisualizationDebugKeyboardOrder(page, debugNodeId) {
  const debugRow = page.locator(`[data-node-id="${debugNodeId}"]`);
  await debugRow.focus();
  await page.keyboard.press("Enter");
  const plan = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const elements = [
      ...document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.disabled && isVisible(element));
    const signature = (element) =>
      element.getAttribute("aria-label") ??
      element.textContent?.trim().replace(/\s+/g, " ") ??
      "";
    const labels = [
      "Copy snapshot",
      "Copy resource key",
      "Export JSON",
      "Raw bounded JSON",
    ];
    return {
      activeIndex: elements.indexOf(document.activeElement),
      labels,
      targetIndexes: labels.map((label) =>
        elements.findIndex((element) => signature(element).includes(label)),
      ),
    };
  });
  if (
    plan.activeIndex < 0 ||
    plan.targetIndexes.some((index) => index <= plan.activeIndex) ||
    plan.targetIndexes.some(
      (index, position) => position > 0 && index <= plan.targetIndexes[position - 1],
    )
  ) {
    throw new Error(`Visualization Debug keyboard order is not linear: ${JSON.stringify(plan)}.`);
  }
  const visited = [];
  let currentIndex = plan.activeIndex;
  for (let position = 0; position < plan.labels.length; position += 1) {
    const steps = plan.targetIndexes[position] - currentIndex;
    for (let step = 0; step < steps; step += 1) {
      await page.keyboard.press("Tab");
    }
    const focused = await page.evaluate(() => ({
      ariaLabel: document.activeElement?.getAttribute("aria-label") ?? "",
      text: document.activeElement?.textContent?.trim().replace(/\s+/g, " ") ?? "",
    }));
    const actual = focused.ariaLabel || focused.text;
    if (!actual.includes(plan.labels[position])) {
      throw new Error(
        `Expected keyboard focus on ${plan.labels[position]}, got ${actual}.`,
      );
    }
    visited.push(plan.labels[position]);
    currentIndex = plan.targetIndexes[position];
  }
  return { tabStops: visited };
}

function assertVisualizationDebugStatusText(statusText, key) {
  if (!statusText.trim() || /loading visualization evidence/i.test(statusText)) {
    throw new Error(`${key} Visualization Debug status is not textually settled.`);
  }
}

function assertSingleNavigation(navigationCount, label) {
  if (navigationCount !== 1) {
    throw new Error(
      `${label} expected navigationCount !== 1 to be false; observed ${navigationCount} (HMR/reload).`,
    );
  }
}

async function readInspectorCount(page, label) {
  const row = page
    .locator(".fm-inspector-field-row")
    .filter({ hasText: label })
    .first();
  if ((await row.count()) === 0) return null;
  const value = await row.locator(".fm-inspector-field-row__value").textContent();
  if (!value || value.trim().toLowerCase() === "waiting") return null;
  const parsed = Number(value.replace(/[^0-9-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function matchingResponse(responses, request) {
  return responses.find(
    (response) =>
      response.quantityId === request.quantityId &&
      response.path === request.path &&
      response.search === request.search,
  );
}

function responseSummary(response) {
  return {
    path: response.path,
    quantityId: response.quantityId,
    scopeId: response.params.scope_id ?? null,
    scopeKind: response.params.scope_kind ?? null,
    status: response.status,
  };
}

function responsePointCount(response) {
  const value = Number(response.headers?.["x-fullmag-point-count"]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Airbox FMVP response did not publish x-fullmag-point-count.");
  }
  return value;
}

async function ensureViewport3DActive(page) {
  const viewportTab = page.getByRole("tab", { name: "3D Viewport" }).first();
  if ((await viewportTab.count()) > 0) {
    await viewportTab.click({ timeout: timeoutMs });
  }
  await page.locator(VIEWPORT_3D_CANVAS_SELECTOR).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const contextState = await page.locator(VIEWPORT_3D_CANVAS_SELECTOR).evaluate(
    (canvas) => {
      const gl =
        canvas.getContext("webgl2") ??
        canvas.getContext("webgl") ??
        canvas.getContext("experimental-webgl");
      return {
        drawingBuffer: gl
          ? { height: gl.drawingBufferHeight, width: gl.drawingBufferWidth }
          : { height: 0, width: 0 },
        hasContext: Boolean(gl && !gl.isContextLost()),
      };
    },
  );
  if (
    !contextState.hasContext ||
    contextState.drawingBuffer.width <= 0 ||
    contextState.drawingBuffer.height <= 0
  ) {
    throw new Error(
      `3D viewport canvas is not renderable: context=${contextState.hasContext} drawingBuffer=${contextState.drawingBuffer.width}x${contextState.drawingBuffer.height}.`,
    );
  }
}

function resolveObjectPartId(manifest, id) {
  const parts = manifest.mesh_parts ?? [];
  const match =
    parts.find((part) => part.object_id === id) ??
    parts.find((part) => part.id === id || part.id === `part:${id}`) ??
    parts.find((part) => String(part.id ?? "").includes(id));
  if (!match?.id) {
    throw new Error(`Could not resolve magnetic mesh part for object ${id}.`);
  }
  return match.id;
}

function resolveVisualizationDebugRegionScenario({
  manifest,
  objectId,
  regions,
  requestedRegionId,
}) {
  const candidates = (regions.regions ?? []).filter(
    (region) => region.owner_object_id === objectId && region.enabled !== false,
  );
  const region = requestedRegionId
    ? candidates.find((entry) => entry.region_id === requestedRegionId)
    : candidates[0];
  if (!region?.region_id) {
    throw new Error(
      `Visualization Debug browser proof requires a real enabled region owned by ${objectId}; available=${JSON.stringify(candidates.map((entry) => entry.region_id))}.`,
    );
  }
  const expectedCarrierId = `part:${region.region_id}`;
  const carrier = (manifest.mesh_parts ?? []).find(
    (part) => part.id === expectedCarrierId,
  );
  if (!carrier) {
    throw new Error(
      `Region ${region.region_id} has no exact mesh carrier ${expectedCarrierId}.`,
    );
  }
  const explorerBase = `model:object:${objectId}:regions:${region.region_id}`;
  return {
    carrierId: carrier.id,
    debugNodeId: `${explorerBase}:visualization:debug`,
    explorerAncestors: [
      "model:objects",
      `model:object:${objectId}`,
      `model:object:${objectId}:regions`,
      explorerBase,
    ],
    label: region.name ?? region.region_id,
    ordinaryNodeId: `${explorerBase}:visualization`,
    regionId: region.region_id,
    targetId: `region:${objectId}:${encodeURIComponent(region.region_id)}`,
  };
}

function isAirboxMeshPart(part) {
  const role = String(part?.role ?? "").trim().toLowerCase();
  if (role === "air" || role === "airbox") return true;
  let id = String(part?.id ?? "").trim().toLowerCase();
  while (id.startsWith("part:") || id.startsWith("object:")) {
    id = id.slice(id.indexOf(":") + 1);
  }
  return id === "airbox" || id === "__air__" || id === "__airbox__";
}

function resolveAirboxPartId(manifest) {
  const parts = manifest.mesh_parts ?? [];
  const match = parts.find(isAirboxMeshPart);
  if (!match?.id) {
    throw new Error("Could not resolve airbox mesh part.");
  }
  return match.id;
}

function resolveAirOnlyNodeCount(manifest) {
  const airNodes = new Set();
  const magneticNodes = new Set();
  for (const part of manifest.mesh_parts ?? []) {
    const destination = isAirboxMeshPart(part)
      ? airNodes
      : isMagneticMeshPart(part)
        ? magneticNodes
        : null;
    if (!destination) continue;
    for (const nodeIndex of meshPartNodeIndices(part)) {
      destination.add(nodeIndex);
    }
  }
  for (const nodeIndex of magneticNodes) airNodes.delete(nodeIndex);
  if (airNodes.size === 0) {
    throw new Error("Could not derive a non-empty air-only node carrier.");
  }
  return airNodes.size;
}

function isMagneticMeshPart(part) {
  const role = String(part?.role ?? "").trim().toLowerCase();
  return (
    !isAirboxMeshPart(part) &&
    role !== "interface" &&
    role !== "outer_boundary" &&
    Boolean(part?.object_id)
  );
}

function meshPartNodeIndices(part) {
  if (Array.isArray(part?.node_indices) && part.node_indices.length > 0) {
    return part.node_indices;
  }
  const start = Number(part?.node_start ?? 0);
  const count = Number(part?.node_count ?? 0);
  return Array.from({ length: count }, (_, index) => start + index);
}

async function ensureComputeFieldsReady() {
  const response = await postJson("/v2/sessions/current/simulation/commands", {
    kind: "compute_fields",
  });
  if (!response.accepted || typeof response.command_id !== "string") {
    throw new Error(
      `compute_fields was rejected: ${response.error ?? "missing command_id"}`,
    );
  }
  const detail = await waitForCommandSettled(response.command_id);
  if (commandStatus(detail) !== "completed") {
    throw new Error(
      `compute_fields did not complete: ${commandStatus(detail)} ${
        detail.error ?? detail.completion_reason ?? ""
      }`,
    );
  }
}

async function ensureBinaryVectorEndpointsReady(requests) {
  try {
    for (const request of requests) {
      await assertBinaryVectorEndpointReady(request.quantityId, request.query);
    }
    return;
  } catch {
    await ensureComputeFieldsReady();
  }
  for (const request of requests) {
    await assertBinaryVectorEndpointReady(request.quantityId, request.query);
  }
}

async function waitForCommandSettled(commandId) {
  return poll(`command ${commandId} settled`, async () => {
    const detail = await getJson(
      `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`,
    );
    const status = commandStatus(detail);
    if (!TERMINAL_COMMAND_STATUSES.has(status)) return null;
    if (status === "failed" || status === "rejected") {
      throw new Error(
        `Command ${commandId} ${status}: ${
          detail.error ?? detail.completion_reason ?? "unknown error"
        }`,
      );
    }
    return detail;
  });
}

function commandStatus(detail) {
  return (
    detail.completion_status ??
    detail.status ??
    detail.command?.completion_status ??
    detail.command?.status ??
    "unknown"
  );
}

async function assertBinaryVectorEndpointReady(quantityId, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const path =
    `/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}` +
    `/samples/vector?${params.toString()}`;
  const response = await fetch(apiBase + path);
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${await response.text()}`,
    );
  }
  await response.arrayBuffer();
}

async function assertActiveSession() {
  const status = await getJson("/v2/sessions/current/status");
  if (!resolveStatusSessionId(status)) {
    throw new Error("Active session status is unavailable.");
  }
  return status;
}

function resolveStatusSessionId(status) {
  return status?.session?.session_id ?? status?.session_id ?? null;
}

function parseFieldVectorUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(FIELD_VECTOR_PATH_RE);
  if (!match) return null;
  const params = Object.fromEntries(url.searchParams.entries());
  return {
    params,
    path: url.pathname,
    quantityId: decodeURIComponent(match[1] ?? ""),
    search: url.searchParams.toString(),
  };
}

function parseFieldMetaUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(FIELD_META_PATH_RE);
  if (!match) return null;
  return {
    params: Object.fromEntries(url.searchParams.entries()),
    path: url.pathname,
    quantityId: decodeURIComponent(match[1] ?? ""),
    search: url.searchParams.toString(),
  };
}

async function getJson(path) {
  const response = await fetch(apiBase + path, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(apiBase + path, {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function patchJson(path, body) {
  const response = await fetch(apiBase + path, {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "PATCH",
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function poll(label, read) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await read();
      if (result) return result;
    } catch (error) {
      lastError = error;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${label}` +
      (lastError ? `: ${lastError.message}` : ""),
  );
}

async function loadPlaywright() {
  try {
    return await import("@playwright/test");
  } catch {
    try {
      return await import("playwright");
    } catch {
      return null;
    }
  }
}

function normalizeQuantityId(quantityId) {
  const value = String(quantityId ?? "").trim().toLowerCase();
  return value === "h_demag" ? "h_demag" : value;
}

function isIgnorableConsoleError(text) {
  return (
    text.includes("Failed to load resource: the server responded with a status of 404") &&
    text.includes("/favicon.ico")
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
