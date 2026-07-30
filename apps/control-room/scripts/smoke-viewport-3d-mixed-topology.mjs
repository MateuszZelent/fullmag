const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  new URL(workspaceUrl).origin
).replace(/\/$/, "");
const timeoutMs = Number(
  process.env.CONTROL_ROOM_MIXED_TOPOLOGY_SMOKE_TIMEOUT_MS ?? 180_000,
);
const VIEWPORT_3D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const SHARED_TOPOLOGY_PATH = "/v2/sessions/current/meshing/meshes/shared-domain/topology";

async function main() {
  await assertActiveSession();
  const manifest = await waitForStrictMixedTopologyManifest();
  assertStrictMixedTopologyManifest(manifest);
  const capabilities = await getJson("/v2/sessions/current/meshing/capabilities");
  assertStrictMixedTopologyCapabilities(capabilities);

  const initialState = await getJson("/v2/sessions/current/visualization/state");
  await patchJson(
    "/v2/sessions/current/visualization/state",
    buildMixedTopologyVisualizationPatch(initialState, "component_x"),
  );

  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error("Viewport 3D mixed-topology smoke requires Playwright or @playwright/test.");
  }
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const topologyRequests = [];
  const errors = [];
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
      diagnosticRecorderProfile: "forensic",
      diagnosticRecorderScenario: "viewport-3d-mixed-topology",
      enableAuditHooks: true,
      enableDiagnosticRecorder: true,
    };
  }, apiBase);
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("/favicon.ico")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === SHARED_TOPOLOGY_PATH
    ) {
      topologyRequests.push(request.url());
    }
  });

  try {
    await page.goto(workspaceUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await ensureViewport3DActive(page);
    await assertCanvasHealthy(page);
    await waitForMeshCellAuditHook(page);
    await assertCanonicalMixedSelections(page);
    await waitForViewport3DBuildQuiescence(page);
    const baseline = await snapshotTopologyEvidence(page, topologyRequests);
    await assertAirboxFullWireframeBuildEvidence(page, resolveAirboxPartId(manifest));

    const switchedX = await patchJson(
      "/v2/sessions/current/visualization/state",
      buildMixedTopologyVisualizationPatch(initialState, "component_x"),
    );
    await patchJson(
      "/v2/sessions/current/visualization/state",
      buildMixedTopologyVisualizationPatch(switchedX, "component_y"),
    );
    await assertNoTopologyRebuildAfterFieldSwitch(page, baseline, topologyRequests);
    if (errors.length > 0) throw new Error(`Browser console errors:\n${errors.join("\n")}`);
    console.log(`Viewport 3D mixed-topology smoke passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

function assertStrictMixedTopologyManifest(manifest) {
  if (manifest.topology_schema_version !== 2) {
    throw new Error(`Expected topology_schema_version=2; received=${manifest.topology_schema_version}`);
  }
  const counts = manifest.element_counts_by_type;
  for (const family of ["prism6", "pyramid5", "tet4"]) {
    if (typeof counts?.[family] !== "number" || counts[family] <= 0) {
      throw new Error(`Mixed topology requires positive ${family}; received=${JSON.stringify(counts)}`);
    }
  }
  if (!Array.isArray(manifest.fallbacks_triggered) || manifest.fallbacks_triggered.length !== 0) {
    throw new Error(`Strict mixed topology requires published empty fallbacks; received=${JSON.stringify(manifest.fallbacks_triggered)}`);
  }
  const certificate = manifest.mixed_layer_topology_certificate;
  if (
    !certificate ||
    certificate.schema_version !== "mixed_layer_topology_certificate.v1" ||
    certificate.certificate_status !== "accepted" ||
    typeof certificate.topology_fingerprint !== "string" ||
    certificate.topology_fingerprint.length === 0 ||
    certificate.requested_layer_count !== 1 ||
    certificate.realized_layer_count !== 1 ||
    certificate.actual_node_plane_count !== 2 ||
    typeof certificate.gmsh_version !== "string" ||
    certificate.gmsh_version.length === 0 ||
    certificate.rejection_reason != null
  ) {
    throw new Error(`Invalid accepted mixed-layer certificate: ${JSON.stringify(certificate)}`);
  }
  for (const policyName of ["requested_layered_policy", "resolved_layered_policy"]) {
    const policy = manifest[policyName];
    if (
      !policy ||
      policy.topology !== "mixed_p1" ||
      policy.layers !== 1 ||
      policy.node_planes !== 2 ||
      policy.transition_policy !== "pyramid_to_tetrahedra" ||
      policy.exact_layer_count !== true
    ) {
      throw new Error(`Invalid ${policyName}: ${JSON.stringify(policy)}`);
    }
  }
  const provenance = manifest.mixed_topology_provenance;
  if (
    !provenance ||
    provenance.requested_topology !== "mixed_p1" ||
    provenance.resolved_topology !== "mixed_p1" ||
    provenance.requested_device !== "gpu" ||
    provenance.precision !== "double" ||
    provenance.capability_status !== "implemented" ||
    provenance.accepted_certificate_fingerprint !== certificate.topology_fingerprint
  ) {
    throw new Error(`Invalid mixed topology provenance: ${JSON.stringify(provenance)}`);
  }
}

function assertStrictMixedTopologyCapabilities(resource) {
  const capabilities = resource.mesh_capabilities;
  for (const key of [
    "mesh.topology.mixed_p1",
    "mesh.swept.prism",
    "mesh.transition.pyramid_tet",
    "mesh.exact_layer_count",
  ]) {
    const capability = capabilities?.[key];
    if (
      capability?.status !== "implemented" ||
      !Array.isArray(capability.supported_layer_counts) ||
      !capability.supported_layer_counts.includes(1)
    ) {
      throw new Error(`Missing mixed-topology capability ${key}: ${JSON.stringify(capability)}`);
    }
  }
}

function buildMixedTopologyVisualizationPatch(state, source) {
  const overrides = (state.overrides ?? []).filter(
    (entry) => entry.scope !== "airbox" && !(entry.scope === "object" && entry.scope_id === "film"),
  );
  overrides.push(
    {
      scope: "object",
      scope_id: "film",
      visible: true,
      display: {
        geometry_scope: "full",
        surface: { visible: true },
        vectors: { visible: false },
        wireframe: { visible: false },
      },
      quantity: { active_quantity_id: "m" },
      style: { surface_color_source: source, viewport_colorbar_visible: true },
    },
    {
      scope: "airbox",
      scope_id: "airbox",
      visible: true,
      display: {
        geometry_scope: "full",
        surface: { visible: true },
        vectors: { domain: "airbox_only", visible: false },
        wireframe: { visible: true },
      },
      quantity: { active_quantity_id: "H_eff" },
      style: { surface_color_source: "solid", viewport_colorbar_visible: false },
    },
  );
  return {
    active_quantity_id: "m",
    layers: { airbox: { surface: { visible: true }, wireframe: { visible: true } } },
    overrides,
    quantity: { active_quantity_id: "m" },
  };
}

async function assertCanonicalMixedSelections(page) {
  const candidates = await page.evaluate(
    () => window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__?.() ?? [],
  );
  for (const request of [
    findCandidate(candidates, { carrier: "magnetic", elementFamily: "prism6" }),
    findCandidate(candidates, { carrier: "airbox", elementFamily: "pyramid5" }),
    findCandidate(candidates, { carrier: "airbox", elementFamily: "tet4" }),
  ]) {
    const selected = await page.evaluate((value) =>
      window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__?.(value), request);
    if (!selected || selected.carrier !== request.carrier || selected.carrierPartId.length === 0) {
      throw new Error(`Audit selection did not resolve canonical carrier: ${JSON.stringify({ request, selected })}`);
    }
    await poll(`Inspector identity ${request.elementFamily}`, async () => {
      const metadata = await readInspectorMetadata(page);
      if (
        metadata["Element family"] !== request.elementFamily ||
        metadata["Global cell ordinal"] !== request.globalCellOrdinal ||
        !/^\d+$/.test(metadata["Global cell ordinal"] ?? "") ||
        metadata.Kind !== (request.carrier === "airbox" ? "airbox.root" : "object.root")
      ) {
        return null;
      }
      return true;
    });
  }
}

function findCandidate(candidates, expected) {
  const candidate = candidates.find(
    (value) => value.carrier === expected.carrier && value.elementFamily === expected.elementFamily,
  );
  if (!candidate || typeof candidate.globalCellOrdinal !== "string" || !/^\d+$/.test(candidate.globalCellOrdinal)) {
    throw new Error(`Missing decimal ${expected.carrier}/${expected.elementFamily} selection candidate: ${JSON.stringify(candidates)}`);
  }
  return candidate;
}

async function readInspectorMetadata(page) {
  return page.locator(".fm-inspector__metadata-item").evaluateAll((nodes) =>
    Object.fromEntries(nodes.map((node) => [
      node.querySelector("dt")?.textContent?.trim() ?? "",
      node.querySelector("dd")?.textContent?.trim() ?? "",
    ])),
  );
}

async function assertCanvasHealthy(page) {
  const result = await page.locator(VIEWPORT_3D_CANVAS_SELECTOR).evaluate((canvas) => {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
    const rect = canvas.getBoundingClientRect();
    return {
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      isContextLost: gl ? gl.isContextLost() : null,
      visible: rect.width > 0 && rect.height > 0,
    };
  });
  if (!result.visible || result.isContextLost !== false || result.drawingBufferWidth <= 0 || result.drawingBufferHeight <= 0) {
    throw new Error(`3D viewport canvas is unhealthy: ${JSON.stringify(result)}`);
  }
}

async function snapshotTopologyEvidence(page, topologyRequests) {
  const records = await readViewport3DBuildDiagnostics(page);
  return {
    buildCount: records.filter((record) => (record.buildLane ?? record.detail?.buildLane) === "topology-index").length,
    requestCount: topologyRequests.length,
  };
}

async function assertNoTopologyRebuildAfterFieldSwitch(page, baseline, topologyRequests) {
  await waitForViewport3DBuildQuiescence(page);
  const after = await snapshotTopologyEvidence(page, topologyRequests);
  if (after.buildCount !== baseline.buildCount || after.requestCount !== baseline.requestCount) {
    throw new Error(`Quantity/component switch rebuilt topology: before=${JSON.stringify(baseline)} after=${JSON.stringify(after)}`);
  }
}

async function assertAirboxFullWireframeBuildEvidence(page, airboxPartId) {
  const found = (await readViewport3DBuildDiagnostics(page)).some((record) => {
    const key = record.buildKey ?? record.detail?.buildKey ?? "";
    return (record.buildLane ?? record.detail?.buildLane) === "topology-index" &&
      (record.buildState ?? record.detail?.state) === "ready" &&
      key.includes(`airbox-wireframe:${airboxPartId}:scope=full`) &&
      key.includes("edge-source=volumeEdges") &&
      key.includes("render-semantic=hiddenEdges");
  });
  if (!found) throw new Error("Missing full-airbox volumeEdges/hiddenEdges topology telemetry.");
}

async function readViewport3DBuildDiagnostics(page) {
  return page.evaluate(() => window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.().streams?.viewport3dBuild ?? []);
}

async function waitForMeshCellAuditHook(page) {
  await page.waitForFunction(
    () => typeof window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__ === "function" &&
      typeof window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__ === "function",
    { timeout: timeoutMs },
  );
}

async function ensureViewport3DActive(page) {
  const viewportTab = page.getByRole("tab", { name: "3D Viewport" }).first();
  if ((await viewportTab.count()) > 0) await viewportTab.click({ timeout: timeoutMs });
  await page.locator(VIEWPORT_3D_CANVAS_SELECTOR).waitFor({ state: "visible", timeout: timeoutMs });
}

async function waitForStrictMixedTopologyManifest() {
  return poll("strict mixed topology manifest", async () => {
    const manifest = await getJsonOrNull("/v2/sessions/current/meshing/meshes/shared-domain/manifest");
    try {
      if (manifest) assertStrictMixedTopologyManifest(manifest);
      return manifest;
    } catch {
      return null;
    }
  });
}

function resolveAirboxPartId(manifest) {
  const part = (manifest.mesh_parts ?? []).find((value) => ["air", "airbox"].includes(String(value.role ?? "").toLowerCase()));
  if (!part?.id) throw new Error("Could not resolve airbox mesh part.");
  return part.id;
}

async function waitForViewport3DBuildQuiescence(page) {
  let stableCount = null;
  let stableSince = 0;
  await poll("viewport 3D build quiescence", async () => {
    const records = await readViewport3DBuildDiagnostics(page);
    const active = records.some((record) => ["queued", "running", "transferring", "uploading"].includes(record.buildState ?? record.detail?.state));
    const now = Date.now();
    if (active || stableCount !== records.length) {
      stableCount = records.length;
      stableSince = now;
      return null;
    }
    return now - stableSince >= 750 ? true : null;
  });
}

async function assertActiveSession() {
  const status = await getJson("/v2/sessions/current/status");
  if (!(status?.session?.session_id ?? status?.session_id)) throw new Error("Active session status is unavailable.");
}

async function getJson(path) {
  const response = await fetch(apiBase + path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getJsonOrNull(path) {
  const response = await fetch(apiBase + path, { headers: { accept: "application/json" } });
  if ([204, 404, 409].includes(response.status)) return null;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function patchJson(path, body) {
  const response = await fetch(apiBase + path, {
    body: JSON.stringify(body),
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function poll(label, read) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await read();
    if (value) return value;
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
