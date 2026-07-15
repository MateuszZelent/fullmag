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
const timeoutMs = Number(
  process.env.CONTROL_ROOM_AIRBOX_FIELD_SMOKE_TIMEOUT_MS ?? 180_000,
);
const objectId = process.env.CONTROL_ROOM_AIRBOX_FIELD_OBJECT_ID ?? "arch_waveguide";
const objectQuantityId =
  process.env.CONTROL_ROOM_AIRBOX_FIELD_OBJECT_QUANTITY_ID ?? "m";
const airboxQuantityId =
  process.env.CONTROL_ROOM_AIRBOX_FIELD_AIRBOX_QUANTITY_ID ?? "h_demag";
const vectorBudget = Number(
  process.env.CONTROL_ROOM_AIRBOX_FIELD_VECTOR_BUDGET ?? 192,
);
const VIEWPORT_3D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const VIEWPORT_IDLE_SETTLE_MS = 2_000;
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
  const manifest = await getJson(
    "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
  );
  const objectPartId = resolveObjectPartId(manifest, objectId);
  const airboxPartId = resolveAirboxPartId(manifest);
  const availableAirOnlyNodeCount = resolveAirOnlyNodeCount(manifest);

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
  ]);

  const visualizationState = await getJson(
    "/v2/sessions/current/visualization/state",
  );
  const patchedState = await patchJson(
    "/v2/sessions/current/visualization/state",
    buildVisualizationRoutingPatch(visualizationState),
  );
  assertVisualizationRoutingState(patchedState);

  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Airbox field routing smoke requires Playwright or @playwright/test in the current environment.",
    );
  }

  const browser = await playwright.chromium.launch(
    browserHostResolverIp
      ? {
          args: [
            `--host-resolver-rules=MAP localhost ${browserHostResolverIp}`,
          ],
        }
      : undefined,
  );
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const fieldRequests = [];
  const fieldResponses = [];
  const errors = [];

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
    if (message.type() !== "error") return;
    const text = message.text();
    if (!isIgnorableConsoleError(text)) {
      errors.push(text);
    }
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
    const proof = await waitForFieldRoutingProof({
      fieldRequests,
      fieldResponses,
      airboxPartId,
      objectPartId,
    });
    const debugIdleProof = await assertVisualizationDebugIdleBudgets({
      fieldRequests,
      page,
    });
    const accountingProof = await assertAirboxInspectorAccounting({
      airboxPartId,
      availableAirOnlyNodeCount,
      fieldRequests,
      page,
      proof,
    });
    if (errors.length > 0) {
      throw new Error("Browser console errors:\n" + errors.join("\n"));
    }
    console.log(
      `Airbox field routing proof: ${JSON.stringify({
        ...proof,
        ...debugIdleProof,
        ...accountingProof,
        apiBase,
        browserApiBase,
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

function buildVisualizationRoutingPatch(state) {
  const overrides = (state.overrides ?? []).filter(
    (entry) =>
      !(
        (entry.scope === "airbox" && entry.scope_id === "airbox") ||
        (entry.scope === "object" && entry.scope_id === objectId)
      ),
  );
  overrides.push({
    display: {
      geometry_scope: "surface",
      surface: { visible: false },
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
      surface: { visible: false },
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

  return {
    active_quantity_id: objectQuantityId,
    layers: {
      surface: { visible: false },
      vectors: {
        density: vectorBudget,
        domain: "auto",
        visible: true,
      },
      airbox: {
        surface: { visible: false },
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

function assertVisualizationRoutingState(state) {
  const objectTarget = (state.targets?.objects ?? []).find(
    (target) => target.scope_id === objectId,
  );
  const airboxQuantity =
    state.targets?.airbox?.settings?.active_quantity_id ??
    state.quantity?.active_quantity_id ??
    state.active_quantity_id;
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
}

async function waitForFieldRoutingProof({
  fieldRequests,
  fieldResponses,
  airboxPartId,
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
        entry.params.scope_id === airboxPartId,
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
  if (accounting.adopted !== accounting.decoded) {
    throw new Error(
      `Inspector adopted arrows ${accounting.adopted} != decoded samples ${accounting.decoded}.`,
    );
  }
  const matchingRequests = fieldRequests.filter(
    (entry) =>
      normalizeQuantityId(entry.quantityId) === "h_demag" &&
      entry.params.scope_kind === "airbox" &&
      entry.params.scope_id === airboxPartId,
  );
  if (matchingRequests.length !== 1) {
    throw new Error(
      `Expected one exact Airbox FMVP request, observed ${matchingRequests.length}.`,
    );
  }
  return {
    inspectorAdoptedArrowCount: accounting.adopted,
    inspectorAvailableAirOnlyNodeCount: accounting.available,
    inspectorDecodedSampleCount: accounting.decoded,
    matchingAirboxFieldRequestCount: matchingRequests.length,
  };
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
