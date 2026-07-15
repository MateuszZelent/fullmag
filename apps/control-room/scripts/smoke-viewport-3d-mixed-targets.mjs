const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  new URL(workspaceUrl).origin
).replace(/\/$/, "");
const timeoutMs = Number(
  process.env.CONTROL_ROOM_MIXED_TARGET_SMOKE_TIMEOUT_MS ?? 180_000,
);
const targetAId =
  process.env.CONTROL_ROOM_MIXED_TARGET_A_ID ?? "permalloy_layer";
const targetBId =
  process.env.CONTROL_ROOM_MIXED_TARGET_B_ID ?? "cofeb_top_ring";
let targetCId =
  process.env.CONTROL_ROOM_MIXED_TARGET_C_ID ?? "cofeb_bottom_ring";
const airboxQuantityId =
  process.env.CONTROL_ROOM_MIXED_TARGET_AIRBOX_QUANTITY_ID ?? "H_eff";
const vectorBudget = Number(
  process.env.CONTROL_ROOM_MIXED_TARGET_VECTOR_BUDGET ?? 192,
);
const TARGET_B_INITIAL_SURFACE_SOURCE = "component_x";
const VIEWPORT_3D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const FIELD_VECTOR_PATH_RE =
  /^\/v2\/sessions\/current\/data\/fields\/([^/]+)\/samples\/vector$/;
const TERMINAL_COMMAND_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "rejected",
  "skipped",
]);

async function main() {
  await assertActiveSession();
  const { manifest, scene } = await waitForMixedTargetSceneReady();
  assertMagneticTargetsAvailable(scene, [targetAId, targetBId]);
  targetCId = magneticTargetExists(scene, targetCId) ? targetCId : null;
  const airboxPartId = resolveAirboxPartId(manifest);
  const targetPartIds = {
    [targetAId]: resolveTargetPartIds(manifest, targetAId),
    [targetBId]: resolveTargetPartIds(manifest, targetBId),
    ...(targetCId
      ? { [targetCId]: resolveTargetPartIds(manifest, targetCId) }
      : {}),
  };
  await ensureComputeFieldsReady();
  await waitForBinaryVectorEndpointReady("m", {
    component: "full",
    max_samples: vectorBudget,
    scope_kind: "object",
    scope_id: targetAId,
  });
  await waitForBinaryVectorEndpointReady("m", {
    component: "x",
    scope_kind: "object",
    scope_id: targetBId,
  });
  await waitForBinaryVectorEndpointReady(airboxQuantityId, {
    component: "full",
    max_samples: vectorBudget,
    scope_kind: "airbox",
  });

  const initialState = await getJson("/v2/sessions/current/visualization/state");
  const patchedState = await patchJson(
    "/v2/sessions/current/visualization/state",
    buildMixedTargetVisualizationPatch(initialState, TARGET_B_INITIAL_SURFACE_SOURCE),
  );
  assertMixedTargetVisualizationState(patchedState, TARGET_B_INITIAL_SURFACE_SOURCE);

  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Viewport 3D mixed-target smoke requires Playwright or @playwright/test.",
    );
  }

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const fieldRequests = [];
  const fieldResponses = [];
  const buildDiagnostics = [];
  const errors = [];

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
      diagnosticRecorderProfile: "forensic",
      diagnosticRecorderScenario: "viewport-3d-mixed-targets",
      enableDiagnosticRecorder: true,
    };
    window.__FULLMAG_MIXED_TARGET_LONG_TASKS__ = [];
    if (typeof PerformanceObserver === "function") {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__FULLMAG_MIXED_TARGET_LONG_TASKS__.push({
            duration: entry.duration,
            startTime: entry.startTime,
          });
        }
      });
      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch {}
    }
  }, apiBase);

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!isIgnorableConsoleError(text)) errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const parsed = parseFieldVectorUrl(request.url());
    if (!parsed) return;
    fieldRequests.push({ ...parsed, timestamp: Date.now(), url: request.url() });
  });
  page.on("response", (response) => {
    if (response.request().method() !== "GET") return;
    const parsed = parseFieldVectorUrl(response.url());
    if (!parsed) return;
    fieldResponses.push({
      ...parsed,
      status: response.status(),
      timestamp: Date.now(),
      url: response.url(),
    });
  });

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await ensureViewport3DActive(page);
    await assertCanvasNonBlank(page);
    await waitForMixedTargetProof({ fieldRequests, fieldResponses, targetPartIds });
    await assertNoDuplicateEquivalentFieldRequests(fieldRequests);
    await assertNoAirOrInterfaceColorbar(page);
    await waitForRequiredViewport3DBuildLanes(page);
    await waitForViewport3DBuildQuiescence(page);
    await resetLongTaskMeasurements(page);
    await assertColorbarRemainsMountedAcrossModeSwitch(page, "component_y");
    await assertColorbarRangeUpdateDoesNotRemount(page);
    await assertNoBlockingFieldSwitchTask(page);
    await collectViewport3DBuildDiagnostics(page, buildDiagnostics);
    assertRequiredViewport3DBuildLanes(buildDiagnostics);
    assertSemanticTargetBuildEvidence(buildDiagnostics, {
      airboxPartId,
      targetAPartIds: targetPartIds[targetAId],
      targetBPartIds: targetPartIds[targetBId],
    });
    if (errors.length > 0) {
      throw new Error("Browser console errors:\n" + errors.join("\n"));
    }
    console.log(
      `Viewport 3D mixed-target proof: ${JSON.stringify({
        apiBase,
        buildDiagnosticCount: buildDiagnostics.length,
        colorbarCount: await colorbarCount(page),
        fieldRequestCount: fieldRequests.length,
        fieldResponseCount: fieldResponses.length,
        targetAId,
        targetBId,
        targetCId,
        workspaceUrl,
      })}`,
    );
    console.log(`Viewport 3D mixed-target smoke passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

function buildMixedTargetVisualizationPatch(state, targetBSource) {
  const overrides = (state.overrides ?? []).filter(
    (entry) =>
      !(
        (entry.scope === "object" &&
          [targetAId, targetBId, targetCId].includes(entry.scope_id)) ||
        (entry.scope === "airbox" && entry.scope_id === "airbox")
      ),
  );
  overrides.push({
    "scope": "object",
    "scope_id": targetAId,
    "visible": true,
    "display": {
      "geometry_scope": "full",
      "surface": { "visible": true },
      "vectors": { "visible": true },
      "visible": true,
      "wireframe": { "visible": false },
    },
    "quantity": { "active_quantity_id": "m" },
    "style": {
      "scalar_color_palette": "viridis",
      "surface_color_source": "orientation",
      "vector_budget": vectorBudget,
      "vector_color_mode": "orientation",
      "viewport_colorbar_visible": false,
    },
  });
  overrides.push({
    "scope": "object",
    "scope_id": targetBId,
    "visible": true,
    "display": {
      "geometry_scope": "full",
      "surface": { "visible": true },
      "vectors": { "visible": false },
      "visible": true,
      "wireframe": { "visible": false },
    },
    "quantity": { "active_quantity_id": "m" },
    "style": {
      "scalar_color_palette": "magma",
      "surface_color_source": targetBSource,
      "vector_budget": 0,
      "viewport_colorbar_visible": true,
    },
  });
  if (targetCId) overrides.push({
    "scope": "object",
    "scope_id": targetCId,
    "visible": true,
    "display": {
      "geometry_scope": "full",
      "surface": { "visible": true },
      "vectors": { "visible": true },
      "visible": true,
      "wireframe": { "visible": false },
    },
    "quantity": { "active_quantity_id": "m" },
    "style": {
      "surface_color_source": "solid",
      "surface_mono_color": "#7c6f64",
      "vector_budget": vectorBudget,
      "vector_color_mode": "orientation",
      "viewport_colorbar_visible": false,
    },
  });
  overrides.push({
    "scope": "airbox",
    "scope_id": "airbox",
    "visible": true,
    "display": {
      "geometry_scope": "full",
      "surface": { "visible": false },
      "vectors": { "domain": "airbox_only", "visible": true },
      "visible": true,
      "wireframe": { "visible": false },
    },
    "quantity": { "active_quantity_id": airboxQuantityId },
    "style": {
      "surface_color_source": "solid",
      "vector_budget": vectorBudget,
      "vector_color_mode": "orientation",
      "viewport_colorbar_visible": false,
    },
  });

  return {
    active_quantity_id: "m",
    layers: {
      airbox: {
        surface: { visible: false },
        vectors: {
          density: vectorBudget,
          domain: "airbox_only",
          visible: true,
        },
        visible: true,
        wireframe: { visible: false },
      },
      surface: { visible: true },
      vectors: {
        density: vectorBudget,
        domain: "auto",
        visible: true,
      },
    },
    overrides,
    quantity: { active_quantity_id: "m" },
    vector_glyphs: true,
  };
}

function assertMixedTargetVisualizationState(state, targetBSource) {
  const targets = new Map(
    (state.targets?.objects ?? []).map((target) => [target.scope_id, target]),
  );
  const targetA = targets.get(targetAId)?.settings;
  const targetB = targets.get(targetBId)?.settings;
  const targetC = targetCId ? targets.get(targetCId)?.settings : null;
  const airbox = state.targets?.airbox?.settings;
  if (targetA?.surface_color_source !== "orientation" || !targetA.vectors_visible) {
    throw new Error(
      `Target A was not patched to orientation+vectors: ${targetAId}; ` +
        `resolved=${JSON.stringify(targetA ?? null)} ` +
        `available=${JSON.stringify([...targets.keys()])}`,
    );
  }
  if (
    targetB?.surface_color_source !== targetBSource ||
    targetB.vectors_visible ||
    !targetB.viewport_colorbar_visible
  ) {
    throw new Error(`Target B was not patched to component colorbar mode: ${targetBId}`);
  }
  if (
    targetCId &&
    (targetC?.surface_color_source !== "solid" || !targetC.vectors_visible)
  ) {
    throw new Error(`Target C was not patched to solid+vectors: ${targetCId}`);
  }
  if (!airbox?.vectors_visible || airbox.viewport_colorbar_visible) {
    throw new Error("Airbox was not patched to vector-only without viewport colorbar.");
  }
}

async function waitForMixedTargetSceneReady() {
  let lastState = "no response received";
  return poll("mixed-target scene and shared-domain manifest", async () => {
    const manifest = await getJsonOrNull(
      "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
    );
    const scene = await getJsonOrNull("/v2/sessions/current/model/scene");
    if (!manifest || !scene) {
      lastState = `manifest=${manifest ? "ready" : "missing"} scene=${scene ? "ready" : "missing"} api=${apiBase}`;
      return null;
    }
    try {
      assertMagneticTargetsAvailable(scene, [targetAId, targetBId]);
      resolveAirboxPartId(manifest);
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
      return null;
    }
    return { manifest, scene };
  }).catch((error) => {
    error.message = `${error.message} Last observed state: ${lastState}`;
    throw error;
  });
}

async function waitForMixedTargetProof({
  fieldRequests,
  fieldResponses,
  targetPartIds,
}) {
  try {
    return await poll("mixed-target field requests", async () => {
      const failedResponses = fieldResponses.filter((entry) => entry.status >= 400);
      if (failedResponses.length > 0) {
        throw new Error(
          "Field vector requests failed: " +
            failedResponses
              .map((entry) => `${entry.status} ${entry.path}?${entry.search}`)
              .join(", "),
        );
      }
      const targetARequest = fieldRequests.find(
        (entry) =>
          entry.quantityId === "m" &&
          entry.params.component === "full" &&
          requestTargetsObject(entry, targetAId, targetPartIds[targetAId]),
      );
      const targetBRequest = fieldRequests.find(
        (entry) =>
          entry.quantityId === "m" &&
          entry.params.component === "x" &&
          requestTargetsObject(entry, targetBId, targetPartIds[targetBId]),
      );
      const targetCRequest = targetCId ? fieldRequests.find(
        (entry) =>
          entry.quantityId === "m" &&
          entry.params.component === "full" &&
          entry.params.max_samples &&
          requestTargetsObject(entry, targetCId, targetPartIds[targetCId]),
      ) : true;
      const airboxRequest = fieldRequests.find(
        (entry) =>
          quantityIdMatches(entry.quantityId, airboxQuantityId) &&
          entry.params.component === "full" &&
          entry.params.scope_kind === "airbox",
      );
      if (!targetARequest || !targetBRequest || !targetCRequest || !airboxRequest) {
        return null;
      }
      return {
        airboxRequest,
        targetARequest,
        targetBRequest,
        targetCRequest,
      };
    });
  } catch (error) {
    const observedRequests = fieldRequests
      .map((entry) => `${entry.quantityId}?${entry.search}`)
      .slice(-20);
    const observedResponses = fieldResponses
      .map((entry) => `${entry.status} ${entry.quantityId}?${entry.search}`)
      .slice(-20);
    const detail =
      `Observed field requests (${fieldRequests.length}): ${
        observedRequests.join("; ") || "none"
      }\n` +
      `Observed field responses (${fieldResponses.length}): ${
        observedResponses.join("; ") || "none"
      }`;
    error.message = `${error.message}\n${detail}`;
    throw error;
  }
}

function requestTargetsObject(entry, objectId, partIds) {
  if (entry.params.scope_kind === "object") {
    return entry.params.scope_id === objectId;
  }
  if (entry.params.scope_kind !== "part") return false;
  return partIds.includes(entry.params.scope_id);
}

function quantityIdMatches(actual, expected) {
  return actual.toLowerCase() === expected.toLowerCase();
}

async function assertNoDuplicateEquivalentFieldRequests(fieldRequests) {
  const seen = new Map();
  for (const request of fieldRequests) {
    const key = normalizedFieldRequestKey(request);
    const existing = seen.get(key);
    if (existing) {
      throw new Error(
        `Duplicate equivalent field request: ${existing.url} and ${request.url}`,
      );
    }
    seen.set(key, request);
  }
}

async function assertNoAirOrInterfaceColorbar(page) {
  const labels = await page
    .locator(".fm-viewport-3d__colorbar")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.textContent ?? "").filter(Boolean),
    );
  const forbidden = labels.filter((label) =>
    /air|interface|outer boundary|permalloy geom/i.test(label),
  );
  if (forbidden.length > 0) {
    throw new Error(`Unexpected air/interface viewport colorbar: ${forbidden.join("; ")}`);
  }
}

async function assertColorbarRemainsMountedAcrossModeSwitch(page, nextMode) {
  await page.locator(".fm-viewport-3d__colorbar").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const beforeCount = await colorbarCount(page);
  const beforeHandle = await firstColorbarHandle(page);
  await patchJson(
    "/v2/sessions/current/visualization/state",
    buildMixedTargetVisualizationPatch(
      await getJson("/v2/sessions/current/visualization/state"),
      nextMode,
    ),
  );
  await poll("component mode colorbar after switch", async () => {
    const count = await colorbarCount(page);
    if (count !== beforeCount) return null;
    const text = await page
      .locator(".fm-viewport-3d__colorbar")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "").join("\n"));
    return /y|component/i.test(text) ? text : null;
  });
  await assertColorbarHandleStillMounted(beforeHandle, "component mode switch");
  await beforeHandle.dispose();
  await assertNoAirOrInterfaceColorbar(page);
}

async function assertColorbarRangeUpdateDoesNotRemount(page) {
  await page.locator(".fm-viewport-3d__colorbar").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const beforeHandle = await firstColorbarHandle(page);
  const beforeCount = await colorbarCount(page);
  await patchJson(
    "/v2/sessions/current/visualization/state",
    buildMixedTargetVisualizationPatch(
      await getJson("/v2/sessions/current/visualization/state"),
      "component_y",
    ),
  );
  await poll("range-only colorbar node retention", async () => {
    const count = await colorbarCount(page);
    if (count !== beforeCount) return null;
    return (await colorbarHandleStillMounted(beforeHandle)) ? true : null;
  });
  await assertColorbarHandleStillMounted(beforeHandle, "range-only update");
  await beforeHandle.dispose();
  await assertNoAirOrInterfaceColorbar(page);
}

async function assertCanvasNonBlank(page) {
  const result = await page.locator(VIEWPORT_3D_CANVAS_SELECTOR).evaluate((canvas) => {
    const context = canvas.getContext("2d");
    if (context) return { nonBlank: true };
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    return {
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      nonBlank: Boolean(gl && !gl.isContextLost()),
    };
  });
  if (!result.nonBlank || result.drawingBufferWidth <= 0 || result.drawingBufferHeight <= 0) {
    throw new Error(`3D viewport canvas is blank or unavailable: ${JSON.stringify(result)}`);
  }
}

async function collectViewport3DBuildDiagnostics(page, buildDiagnostics) {
  const records = await page.evaluate(() => {
    const artifact = window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.();
    if (artifact?.streams?.viewport3dBuild) {
      return artifact.streams.viewport3dBuild;
    }
    const source =
      window.__FULLMAG_DIAGNOSTIC_RECORDER__ ??
      window.__fullmagDiagnosticRecorder ??
      null;
    const entries =
      typeof source?.records === "function"
        ? source.records()
        : Array.isArray(source?.records)
          ? source.records
          : [];
    return entries.filter((record) =>
      String(record?.name ?? "").startsWith("fullmag.viewport3d.build-engine"),
    );
  });
  buildDiagnostics.push(...records);
  if (buildDiagnostics.length === 0) {
    throw new Error("Viewport 3D build diagnostics were not recorded.");
  }
}

function assertRequiredViewport3DBuildLanes(records) {
  const lanes = new Set(
    records.map(
      (record) => record.buildLane ?? record.detail?.buildLane ?? null,
    ),
  );
  for (const lane of [
    "field-color",
    "topology-index",
    "vector-glyph",
    "vector-glyph-upload",
  ]) {
    if (!lanes.has(lane)) {
      throw new Error(
        `Missing viewport 3D build lane ${lane}. Observed: ${[...lanes].join(", ")}`,
      );
    }
  }
}

function assertSemanticTargetBuildEvidence(
  records,
  { airboxPartId, targetAPartIds, targetBPartIds },
) {
  const readyRecords = records.filter(
    (record) => (record.buildState ?? record.detail?.state) === "ready",
  );
  const hasEvidence = (lane, partIds) =>
    readyRecords.some((record) => {
      const recordLane = record.buildLane ?? record.detail?.buildLane;
      const serialized = JSON.stringify(record);
      return recordLane === lane && partIds.some((partId) => serialized.includes(partId));
    });
  for (const [label, lane, partIds] of [
    ["magnetic surface shader", "field-color", targetBPartIds],
    ["magnetic vectors", "vector-glyph", targetAPartIds],
    ["airbox vectors", "vector-glyph", [airboxPartId]],
  ]) {
    if (!hasEvidence(lane, partIds)) {
      throw new Error(
        `Missing ${label} build evidence for ${partIds.join(", ")}.`,
      );
    }
  }
}

async function waitForRequiredViewport3DBuildLanes(page) {
  await poll("required viewport 3D build lanes", async () => {
    const records = await page.evaluate(
      () =>
        window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.().streams
          ?.viewport3dBuild ?? [],
    );
    const readyLanes = new Set(
      records
        .filter(
          (record) =>
            (record.buildState ?? record.detail?.state) === "ready",
        )
        .map(
          (record) => record.buildLane ?? record.detail?.buildLane ?? null,
        ),
    );
    return [
      "field-color",
      "topology-index",
      "vector-glyph",
      "vector-glyph-upload",
    ].every((lane) => readyLanes.has(lane))
      ? true
      : null;
  });
  await page.waitForTimeout(500);
}

async function waitForViewport3DBuildQuiescence(page) {
  let stableRecordCount = null;
  let stableSince = 0;
  await poll("viewport 3D build quiescence", async () => {
    const records = await page.evaluate(
      () =>
        window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.().streams
          ?.viewport3dBuild ?? [],
    );
    const latestStateByKey = new Map();
    for (const record of records) {
      const key = record.buildKey ?? record.detail?.buildKey;
      const state = record.buildState ?? record.detail?.state;
      if (key) latestStateByKey.set(key, state);
    }
    const active = [...latestStateByKey.values()].some((state) =>
      ["queued", "running", "transferring", "uploading"].includes(state),
    );
    const now = Date.now();
    if (active || stableRecordCount !== records.length) {
      stableRecordCount = records.length;
      stableSince = now;
      return null;
    }
    return now - stableSince >= 750 ? true : null;
  });
}

async function resetLongTaskMeasurements(page) {
  await page.evaluate(() => {
    window.__FULLMAG_MIXED_TARGET_LONG_TASKS__ = [];
  });
}

async function assertNoBlockingFieldSwitchTask(page) {
  await page.waitForTimeout(250);
  const tasks = await page.evaluate(
    () => window.__FULLMAG_MIXED_TARGET_LONG_TASKS__ ?? [],
  );
  const blocking = tasks.filter((entry) => entry.duration > 200);
  if (blocking.length > 0) {
    const windowStart = Math.min(...blocking.map((entry) => entry.startTime)) - 2_000;
    const windowEnd = Math.max(
      ...blocking.map((entry) => entry.startTime + entry.duration),
    ) + 2_000;
    const related = await page.evaluate(
      ({ end, start }) => {
        const artifact = window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.();
        return [
          ...(artifact?.streams?.viewport3dBuild ?? []),
          ...(artifact?.streams?.performance ?? []),
        ]
          .filter((record) => {
            const recordStart = record.startTimeMs ?? 0;
            return recordStart >= start && recordStart <= end;
          })
          .map((record) => ({
            durationMs: record.durationMs ?? null,
            inputBytes: record.inputBytes ?? record.detail?.inputBytes ?? null,
            lane: record.buildLane ?? record.detail?.buildLane ?? record.lane,
            mainUploadMs:
              record.mainUploadMs ?? record.detail?.mainUploadMs ?? null,
            name: record.name,
            startTimeMs: record.startTimeMs ?? null,
            state: record.buildState ?? record.detail?.state ?? null,
          }));
      },
      { end: windowEnd, start: windowStart },
    );
    throw new Error(
      `Field visualization switch produced main-thread tasks over 200 ms: ${JSON.stringify(blocking)}; related=${JSON.stringify(related)}`,
    );
  }
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
}

function assertMagneticTargetsAvailable(scene, ids) {
  const magneticIds = new Set(
    (scene.objects ?? [])
      .filter((object) => object.role === "magnet")
      .map((object) => object.id),
  );
  for (const id of ids) {
    if (!magneticIds.has(id)) {
      throw new Error(`Missing magnetic target ${id}. Available: ${Array.from(magneticIds).join(", ")}`);
    }
  }
}

function magneticTargetExists(scene, id) {
  return Boolean(
    id &&
      (scene.objects ?? []).some(
        (object) => object.role === "magnet" && object.id === id,
      ),
  );
}

function resolveAirboxPartId(manifest) {
  const match = (manifest.mesh_parts ?? []).find(
    (part) => part.id === "part:__air__" || part.role === "air",
  );
  if (!match?.id) {
    throw new Error("Could not resolve airbox mesh part.");
  }
  return match.id;
}

function resolveTargetPartIds(manifest, objectId) {
  const partIds = (manifest.mesh_parts ?? [])
    .filter(
      (part) =>
        part.object_id === objectId &&
        typeof part.id === "string" &&
        part.role !== "air" &&
        part.role !== "outer_boundary",
    )
    .map((part) => part.id);
  if (partIds.length === 0) {
    throw new Error(`Could not resolve mesh parts for object ${objectId}.`);
  }
  return partIds;
}

async function waitForBinaryVectorEndpointReady(quantityId, query) {
  return poll(`binary vector endpoint ${quantityId}`, async () => {
    return (await readBinaryVectorEndpoint(quantityId, query)) ? true : null;
  });
}

async function readBinaryVectorEndpoint(quantityId, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const path =
    `/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}` +
    `/samples/vector?${params.toString()}`;
  const response = await fetch(apiBase + path);
  if (response.status === 204 || response.status === 404 || response.status === 409) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
  await response.arrayBuffer();
  return true;
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

async function waitForCommandSettled(commandId) {
  return poll(`command ${commandId} settled`, async () => {
    const detail = await getJsonOrNull(
      `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`,
    );
    if (!detail) return null;
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

async function colorbarCount(page) {
  return page.locator(".fm-viewport-3d__colorbar").count();
}

async function firstColorbarHandle(page) {
  const handle = await page
    .locator(".fm-viewport-3d__colorbar")
    .first()
    .elementHandle({ timeout: timeoutMs });
  if (!handle) {
    throw new Error("Viewport colorbar node was unavailable.");
  }
  return handle;
}

async function assertColorbarHandleStillMounted(handle, label) {
  if (!(await colorbarHandleStillMounted(handle))) {
    throw new Error(`Viewport colorbar remounted during ${label}.`);
  }
}

async function colorbarHandleStillMounted(handle) {
  return handle.evaluate((node) =>
    node.isSameNode(document.querySelector(".fm-viewport-3d__colorbar")),
  );
}

function parseFieldVectorUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(FIELD_VECTOR_PATH_RE);
  if (!match) return null;
  return {
    params: Object.fromEntries(url.searchParams.entries()),
    path: url.pathname,
    quantityId: decodeURIComponent(match[1] ?? ""),
    search: url.searchParams.toString(),
  };
}

function normalizedFieldRequestKey(request) {
  const params = new URLSearchParams();
  for (const key of Object.keys(request.params).sort()) {
    params.set(key, request.params[key]);
  }
  return `${request.quantityId}?${params.toString()}`;
}

async function assertActiveSession() {
  const status = await getJson("/v2/sessions/current/status");
  if (!(status?.session?.session_id ?? status?.session_id)) {
    throw new Error("Active session status is unavailable.");
  }
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

async function getJsonOrNull(path) {
  const response = await fetch(apiBase + path, {
    headers: { accept: "application/json" },
  });
  if (response.status === 204 || response.status === 404 || response.status === 409) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
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

async function poll(label, read) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}.`);
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
