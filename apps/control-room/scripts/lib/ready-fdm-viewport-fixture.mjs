import { createHash } from "node:crypto";

export const FIELD_GRID = [24, 16, 2];
export const FDM_PARTIAL_LAYER_ID = "layer:partial";
export const FDM_DENSE_LAYER_ID = "layer:dense";
export const FDM_MULTILAYER_LAYOUT_REVISION = 7;
export const FDM_MULTILAYER_GRID_FINGERPRINT = "a1".repeat(32);
export const FDM_PARTIAL_INACTIVE_CELL_INDICES = [0, 23, 384, 767];
export const FDM_PARTIAL_ACTIVE_MASK = createPartialActiveMask();

// Keep aligned with src/shared/domain/mesh/fdmDisplaySampling.ts. The smoke
// fixture is plain Node JavaScript and cannot import that TypeScript module.
const FDM_DISPLAY_CELL_BUDGET = 150_000;
const FDM_NATIVE_LAYER_IDS = new Set([
  FDM_DENSE_LAYER_ID,
  FDM_PARTIAL_LAYER_ID,
]);

const FDM_PARTIAL_PACKED_MASK = packActiveMask(FDM_PARTIAL_ACTIVE_MASK);
const FDM_PARTIAL_MASK_HASH = createHash("sha256")
  .update(FDM_PARTIAL_PACKED_MASK)
  .digest("hex");
const FIELD_QUANTITIES = ["m", "H_eff", "H_demag", "H_ex"];
const FIELD_VECTOR_PATH_PATTERN =
  /^\/v2\/sessions\/current\/data\/fields\/(m|H_eff|H_demag|H_ex)\/samples\/vector$/;
const FDM_PARTIAL_ACTIVE_MASK_PATH =
  `/v2/sessions/current/data/domain/fdm-multilayer-layers/${encodeURIComponent(FDM_PARTIAL_LAYER_ID)}/active-mask`;
const EXACT_FIXTURE_PATHS = new Set([
  "/v2/sessions",
  "/v2/platform/health",
  "/v2/platform/capabilities",
  "/v2/platform/development-backend",
  "/v2/workspace/items",
  "/v2/workspace/settings/telemetry.enabled",
  "/v2/workspace/settings/update.available",
  "/v2/sessions/current/status",
  "/v2/sessions/current/visualization/state",
  "/v2/sessions/current/visualization/client-acks",
  "/v2/sessions/current/visualization/mode-compositions/active",
  "/v2/sessions/current/data/domain/meta",
  "/v2/sessions/current/data/domain/fdm-multilayer-layout",
  "/v2/sessions/current/data/fdm-region-memberships",
  "/v2/sessions/current/data/quantities",
  "/v2/sessions/current/data/scalars",
  FDM_PARTIAL_ACTIVE_MASK_PATH,
  "/v2/sessions/current/data/fields",
  "/v2/sessions/current/data/domain/topology",
  "/v2/sessions/current/model/scene",
  "/v2/sessions/current/model/universe",
  "/v2/sessions/current/model/current-transports",
  "/v2/sessions/current/model/couplings",
  "/v2/sessions/current/model/frozen-spins",
  "/v2/sessions/current/model/geometry/capabilities",
  "/v2/sessions/current/model/geometry/validation",
  "/v2/sessions/current/model/material-fields",
  "/v2/sessions/current/model/physics-graph",
  "/v2/sessions/current/model/planar-monitors",
  "/v2/sessions/current/model/readiness",
  "/v2/sessions/current/model/regions",
  "/v2/sessions/current/meshing/capabilities",
  "/v2/sessions/current/meshing/semantics",
  "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
  "/v2/sessions/current/persistence/checkpoints",
  "/v2/sessions/current/simulation/solver/status",
  "/v2/sessions/current/simulation/stages/execution",
]);

export function createFdmFixture({ trackFieldResponses = false } = {}) {
  const visualizationState = fdmVisualizationStateFixture();
  const fixture = {
    fieldRevision: 1,
    fieldVectorResponses: [],
    clientAcks: [],
    clientAckRevision: 0,
    sceneRevision: 0,
    hasExecutionPlan: false,
    hasPersistedRegionMembershipDescriptor: false,
    hasStageExecution: false,
    multilayerEnabled: false,
    patchCount: 0,
    status: null,
    trackFieldResponses,
    visualizationState,
  };
  fixture.status = fdmStatusFixture(fixture);
  return fixture;
}

export function updateFdmFixtureFieldRevision(fixture, revision) {
  if (!Number.isSafeInteger(revision) || revision <= fixture.fieldRevision) {
    throw new Error(
      `Field fixture revision must increase monotonically: current=${fixture.fieldRevision}, requested=${revision}.`,
    );
  }
  fixture.fieldRevision = revision;
  fixture.status.resources.field_catalog_revision = revision;
  fixture.status.resources.field_revision = revision;
  fixture.status.resources.fields_revision = revision;
}

export async function installFdmFixtureApi(page, fixture, requests = []) {
  await page.route(
    (url) => {
      const pathname = new URL(url).pathname;
      return (
        EXACT_FIXTURE_PATHS.has(pathname) ||
        isSupportedFullFieldVectorUrl(new URL(url)) ||
        isSupportedLayerFieldVectorUrl(new URL(url))
      );
    },
    async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const path = requestUrl.pathname;
      requests.push(`${request.method()} ${path}`);

      if (request.method() === "OPTIONS") {
        await fulfillEmpty(route, 204);
        return;
      }

      if (request.method() === "GET" && path === "/v2/sessions") {
        await fulfillJson(route, {
          schema_version: "session-list.v1",
          sessions: [
            {
              current: true,
              name: "FDM ready viewport fixture",
              session_id: "fdm-memory-churn-fixture",
              status: "running",
            },
          ],
        });
        return;
      }
      if (request.method() === "GET" && path === "/v2/platform/health") {
        await fulfillJson(route, {
          active_session: true,
          api_contract_version: "1.0.0",
          status: "ok",
          uptime_seconds: 1,
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/platform/capabilities"
      ) {
        await fulfillJson(route, { engines: [], profile_version: "fixture.v1" });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/platform/development-backend"
      ) {
        await fulfillJson(route, {
          schema_version: "1.0.0",
          configured: false,
          revision: 0,
          state: "disabled",
          current_build: null,
          ready_build: null,
          build_available: false,
          build_request_id: null,
          workspace_identity: null,
          restart_available: false,
          reason: "disabled",
        });
        return;
      }
      if (request.method() === "GET" && path === "/v2/workspace/items") {
        await fulfillJson(route, { items: [], outcome: { state: "ready" } });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/workspace/settings/telemetry.enabled"
      ) {
        await fulfillJson(route, {
          key: "telemetry.enabled",
          value: false,
          is_default: true,
          writable: true,
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/workspace/settings/update.available"
      ) {
        await fulfillJson(route, {
          key: "update.available",
          value: null,
          is_default: true,
          writable: false,
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/status"
      ) {
        await fulfillJson(route, fdmStatusFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/geometry/validation"
      ) {
        await fulfillJson(route, fdmGeometryValidationFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/readiness"
      ) {
        await fulfillJson(route, fdmModelReadinessFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/simulation/solver/status"
      ) {
        await fulfillJson(route, fdmSolverStatusFixture());
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/geometry/capabilities"
      ) {
        await fulfillJson(route, fdmGeometryCapabilitiesFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/meshing/capabilities"
      ) {
        await fulfillJson(route, fdmMeshCapabilitiesFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/meshing/semantics"
      ) {
        await fulfillJson(route, fdmMeshSemanticsFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/persistence/checkpoints"
      ) {
        await fulfillJson(route, { checkpoints: [] });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/planar-monitors"
      ) {
        await fulfillJson(route, {
          scene_revision: fixture.sceneRevision,
          count: 0,
          monitors: [],
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/frozen-spins"
      ) {
        await fulfillJson(route, {
          revision: fixture.sceneRevision,
          count: 0,
          definitions: [],
          runtime_application: null,
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/regions"
      ) {
        await fulfillJson(route, {
          scene_revision: fixture.sceneRevision,
          geometry_realization_revision: fixture.sceneRevision,
          region_topology_revision: fixture.sceneRevision,
          region_membership_revision: fixture.sceneRevision,
          region_coefficients_revision: fixture.sceneRevision,
          region_initial_state_revision: fixture.sceneRevision,
          regions: [],
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/material-fields"
      ) {
        await fulfillJson(route, {
          scene_revision: fixture.sceneRevision,
          region_coefficients_revision: fixture.sceneRevision,
          fields: [],
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/couplings"
      ) {
        await fulfillJson(route, {
          scene_revision: fixture.sceneRevision,
          couplings: [],
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/physics-graph"
      ) {
        await fulfillJson(route, {
          scene_revision: fixture.sceneRevision,
          schema_version: "physics_graph.v1",
          objects: [],
          modules: [],
          edges: [],
          provenance: { normalizer: "physics_graph.v1" },
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/current-transports"
      ) {
        await fulfillJson(route, {
          scene_revision: fixture.sceneRevision,
          items: [],
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/data/quantities"
      ) {
        await fulfillJson(route, fdmQuantityCatalogFixture());
        return;
      }
      if (
        path === "/v2/sessions/current/visualization/client-acks" &&
        request.method() === "GET"
      ) {
        await fulfillJson(route, {
          revision: fixture.clientAckRevision,
          entries: fixture.clientAcks,
        });
        return;
      }
      if (
        path === "/v2/sessions/current/visualization/client-acks" &&
        request.method() === "POST"
      ) {
        const acknowledgement = parseVisualizationClientAck(request);
        if (acknowledgement === null) {
          await route.fallback();
          return;
        }
        const entry = {
          ...acknowledgement,
          received_at_unix_ms: Date.now(),
        };
        const existingIndex = fixture.clientAcks.findIndex(
          (candidate) =>
            candidate.client_id === entry.client_id &&
            (candidate.viewport_id ?? null) === (entry.viewport_id ?? null),
        );
        if (existingIndex === -1) {
          fixture.clientAcks.push(entry);
        } else {
          fixture.clientAcks[existingIndex] = entry;
        }
        fixture.clientAckRevision += 1;
        await fulfillJson(route, entry);
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/visualization/mode-compositions/active"
      ) {
        await fulfillJson(route, fdmModeCompositionFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/data/scalars"
      ) {
        if (Array.from(requestUrl.searchParams.entries()).length !== 3) {
          await route.fallback();
          return;
        }
        if (
          requestUrl.searchParams.get("columns") !==
            "step,time,mx,my,mz,e_total" ||
          requestUrl.searchParams.get("limit") !== "1" ||
          requestUrl.searchParams.get("tail") !== "true"
        ) {
          await route.fallback();
          return;
        }
        const columns = ["step", "time", "mx", "my", "mz", "e_total"];
        await fulfillJson(route, {
          revision: fixture.status.resources.scalars_revision,
          total_rows: 0,
          returned_rows: 0,
          columns,
          rows: [],
          observation_frames: [],
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/data/fdm-region-memberships"
      ) {
        if (
          fixture.status.domain.discretization === "fdm" &&
          fixture.status.run === null &&
          !fixture.hasExecutionPlan &&
          !fixture.hasPersistedRegionMembershipDescriptor
        ) {
          await fulfillEmpty(route, 204);
        } else {
          await route.fallback();
        }
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/simulation/stages/execution"
      ) {
        if (
          fixture.status.run === null &&
          fixture.status.resources.stages_revision === 0 &&
          !fixture.hasStageExecution
        ) {
          await fulfillEmpty(route, 204);
        } else {
          await route.fallback();
        }
        return;
      }
      if (path === "/v2/sessions/current/visualization/state") {
        if (request.method() === "PATCH") {
          const patch = parsePatchBody(request);
          fixture.visualizationState = applyPatch(
            fixture.visualizationState,
            patch,
          );
          fixture.visualizationState.revision += 1;
          fixture.patchCount += 1;
          fixture.status.resources.visualization_state_revision =
            fixture.visualizationState.revision;
        } else if (request.method() !== "GET") {
          await route.fallback();
          return;
        }
        await fulfillJson(route, fixture.visualizationState);
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/data/domain/meta"
      ) {
        await fulfillJson(route, fdmDomainMetaFixture());
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/data/domain/fdm-multilayer-layout"
      ) {
        if (fixture.multilayerEnabled) {
          await fulfillJson(route, fdmMultilayerLayoutFixture());
        } else {
          await fulfillJson(route, fdmUnavailableMultilayerLayoutFixture(fixture));
        }
        return;
      }
      if (
        request.method() === "GET" &&
        path === FDM_PARTIAL_ACTIVE_MASK_PATH
      ) {
        if (fixture.multilayerEnabled) {
          await fulfillBinary(route, makeFdmMultilayerActiveMaskBuffer());
        } else {
          await fulfillEmpty(route, 404);
        }
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/data/fields"
      ) {
        await fulfillJson(route, fdmFieldCatalogFixture(fixture));
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/data/domain/topology"
      ) {
        await fulfillEmpty(route, 204);
        return;
      }
      if (request.method() === "GET" && FIELD_VECTOR_PATH_PATTERN.test(path)) {
        const match = FIELD_VECTOR_PATH_PATTERN.exec(path);
        const quantityId = decodeURIComponent(match?.[1] ?? "m");
        const revision = fixture.fieldRevision;
        const query = Object.fromEntries(requestUrl.searchParams.entries());
        const scope = {
          id: query.scope_id ?? null,
          kind: query.scope_kind,
        };
        const etag =
          revision === 1
            ? `"fdm-memory-${quantityId}"`
            : `"fdm-memory-${quantityId}-r${revision}"`;
        const requestEtag = request.headers()["if-none-match"] ?? null;
        if (requestEtag === etag) {
          if (fixture.trackFieldResponses) {
            fixture.fieldVectorResponses.push({
              etag,
              fieldRevision: revision,
              ifNoneMatch: requestEtag,
              method: request.method(),
              payloadHash: null,
              quantityId,
              query,
              scope,
              status: 304,
            });
          }
          await fulfillEmpty(route, 304, { etag });
          return;
        }
        const payload = makeFdmFieldVectorBuffer(quantityId, revision);
        const payloadHash = fixture.trackFieldResponses
          ? createHash("sha256").update(Buffer.from(payload)).digest("hex")
          : null;
        if (fixture.trackFieldResponses) {
          fixture.fieldVectorResponses.push({
            etag,
            fieldRevision: revision,
            ifNoneMatch: requestEtag,
            method: request.method(),
            payloadHash,
            quantityId,
            query,
            scope,
            status: 200,
          });
        }
        await fulfillBinary(route, payload, 200, { etag });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/scene"
      ) {
        await fulfillJson(route, {
          objects: [],
          revision: fixture.sceneRevision,
          schema_version: 1,
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path === "/v2/sessions/current/model/universe"
      ) {
        await fulfillJson(route, {
          mesh_dirty: false,
          object_bounds_max: [6e-7, 4e-7, 1e-7],
          object_bounds_min: [-6e-7, -4e-7, -1e-7],
          scene_revision: 0,
          study_universe_mesh: null,
          universe: null,
        });
        return;
      }
      if (
        request.method() === "GET" &&
        path ===
          "/v2/sessions/current/meshing/meshes/shared-domain/manifest"
      ) {
        await fulfillEmpty(route, 204);
        return;
      }

      await route.fallback();
    },
  );
}

export function fdmDefaultFieldVectorResourceKey(quantityId) {
  const encodedQuantity = encodeURIComponent(quantityId);
  return (
    `/v2/sessions/current/data/fields/${encodedQuantity}/samples/vector` +
    "?component=full&scope_kind=full"
  );
}

export function fdmMultilayerActiveMaskPath(layerId) {
  return `/v2/sessions/current/data/domain/fdm-multilayer-layers/${encodeURIComponent(layerId)}/active-mask`;
}

function isSupportedFullFieldVectorUrl(url) {
  if (!FIELD_VECTOR_PATH_PATTERN.test(url.pathname)) return false;
  const entries = Array.from(url.searchParams.entries());
  return (
    entries.length === 2 &&
    url.searchParams.get("component") === "full" &&
    url.searchParams.get("scope_kind") === "full"
  );
}

function isSupportedLayerFieldVectorUrl(url) {
  if (!FIELD_VECTOR_PATH_PATTERN.test(url.pathname)) return false;
  const entries = Array.from(url.searchParams.entries());
  const queryKeys = new Set(entries.map(([key]) => key));
  return (
    entries.length === 4 &&
    queryKeys.size === 4 &&
    url.searchParams.get("component") === "full" &&
    url.searchParams.get("max_samples") === String(FDM_DISPLAY_CELL_BUDGET) &&
    FDM_NATIVE_LAYER_IDS.has(url.searchParams.get("scope_id")) &&
    url.searchParams.get("scope_kind") === "layer"
  );
}

export function currentFixtureQuantity(fixture) {
  return (
    fixture.visualizationState?.quantity?.active_quantity_id ??
    fixture.visualizationState?.active_quantity_id ??
    "m"
  );
}

export function applyPatch(state, patch) {
  if (!isPlainObject(patch)) return state;
  const next = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    next[key] =
      isPlainObject(value) && isPlainObject(state[key])
        ? applyPatch(state[key], value)
        : value;
  }
  return next;
}

export function fulfillJson(route, body, status = 200) {
  return route.fulfill({
    body: JSON.stringify(body),
    headers: fixtureHeaders({ "content-type": "application/json" }),
    status,
  });
}

export function fulfillBinary(route, arrayBuffer, status = 200, extra = {}) {
  return route.fulfill({
    body: Buffer.from(arrayBuffer),
    headers: fixtureHeaders({
      "content-type": "application/octet-stream",
      ...extra,
    }),
    status,
  });
}

export function fulfillEmpty(route, status = 204, extra = {}) {
  return route.fulfill({
    body: "",
    headers: fixtureHeaders(extra),
    status,
  });
}

function parsePatchBody(request) {
  try {
    const value = request.postDataJSON();
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function fixtureHeaders(extra = {}) {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
    ...extra,
  };
}

function fdmStatusFixture(fixture) {
  const revision = fixture.visualizationState?.revision ?? 1;
  const quantityId =
    fixture.visualizationState?.quantity?.active_quantity_id ??
    fixture.visualizationState?.active_quantity_id ??
    "m";
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
      scalar_history: false,
      structured_grid: true,
    },
    display: {
      active_quantity_id: quantityId,
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 120000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 2,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2],
      discretization: "fdm",
      generation_id: 1,
    },
    energies: {},
    metrics: {
      steps_per_second: null,
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: revision,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: fixture.fieldRevision,
      field_revision: fixture.fieldRevision,
      fields_revision: fixture.fieldRevision,
      mesh_build_revision: 0,
      mesh_revision: 0,
      scalars_revision: 0,
      scene_revision: 0,
      slice_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: revision,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "memory-churn-fixture",
    session: {
      created_at: "0",
      name: "fdm-memory-churn-fixture",
      request_scope_epoch: "fdm-memory-churn-fixture-scope@0",
      session_epoch: "fdm-memory-churn-fixture@0",
      session_id: "fdm-memory-churn-fixture",
      workspace_root: "/tmp/fullmag-fdm-memory-fixture",
    },
    solver: {
      state: "idle",
    },
  };
}

function fdmDomainMetaFixture() {
  return {
    bounds: {
      max: [6e-7, 4e-7, 1e-7],
      min: [-6e-7, -4e-7, -1e-7],
    },
    coordinate_system: "cartesian",
    counts: { cells: FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2] },
    dimension: 3,
    discretization: "fdm",
    domain_id: "fdm-memory-churn-domain",
    generation_id: 1,
    grid: {
      origin: [-6e-7, -4e-7, -1e-7],
      shape: FIELD_GRID,
      spacing: [1.25e-8, 1.25e-8, 5e-8],
    },
    units: { length: "m" },
  };
}

function fdmMultilayerLayoutFixture() {
  const totalCells = FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2];
  const nativeCellSize = [1.25e-8, 1.25e-8, 5e-8];
  const nativeGridFingerprint = `sha256:${FDM_MULTILAYER_GRID_FINGERPRINT}`;
  return {
    airbox: {
      carrier_available: false,
      h_demag_available: false,
      h_eff_available: false,
    },
    available: true,
    backend: "fdm_multilayer",
    common_transform_layout: {
      cell_size: nativeCellSize,
      fft_shape: [48, 32, 4],
      is_physical_mesh: false,
      origin: [-6e-7, -4e-7, -1e-7],
      provenance: "audit-fixture;fft-scratch-only",
      shape: FIELD_GRID,
    },
    domain_generation_id: "1",
    execution_revision: 1,
    layers: [
      {
        active_cell_count: totalCells,
        active_mask_present: false,
        convolution_cell_size: nativeCellSize,
        convolution_grid: [48, 32, 4],
        inactive_cell_count: 0,
        layer_id: FDM_DENSE_LAYER_ID,
        magnet_name: "dense",
        native_cell_size: nativeCellSize,
        native_grid: FIELD_GRID,
        native_grid_fingerprint: nativeGridFingerprint,
        native_origin: [-6e-7, -4e-7, -1.5e-7],
        object_id: "object:dense",
        transfer_kind: "push_pull",
      },
      {
        active_cell_count: totalCells - FDM_PARTIAL_INACTIVE_CELL_INDICES.length,
        active_mask_hash: `sha256:${FDM_PARTIAL_MASK_HASH}`,
        active_mask_present: true,
        convolution_cell_size: nativeCellSize,
        convolution_grid: [48, 32, 4],
        inactive_cell_count: FDM_PARTIAL_INACTIVE_CELL_INDICES.length,
        layer_id: FDM_PARTIAL_LAYER_ID,
        magnet_name: "partial",
        mask_provenance: "execution_plan.layers.native_active_mask",
        mask_ref: fdmMultilayerActiveMaskPath(FDM_PARTIAL_LAYER_ID),
        native_cell_size: nativeCellSize,
        native_grid: FIELD_GRID,
        native_grid_fingerprint: nativeGridFingerprint,
        native_origin: [-6e-7, -4e-7, 5e-8],
        object_id: "object:partial",
        transfer_kind: "push_pull",
      },
    ],
    layout_fingerprint: "sha256:fdm-memory-churn-multilayer-layout",
    layout_revision: FDM_MULTILAYER_LAYOUT_REVISION,
    observation_revision: 1,
    requested_mode: "auto",
    resolved_mode: "three_d",
    schema_version: "fdm-multilayer-layout.v1",
    strategy: "multilayer_convolution",
  };
}

function fdmUnavailableMultilayerLayoutFixture(fixture) {
  return {
    schema_version: "fdm-multilayer-layout.v1",
    domain_generation_id: String(fixture.status.domain.generation_id),
    available: false,
    unavailable_reason: "not_fdm_multilayer",
    backend: "fdm",
    layout_revision: fixture.status.resources.domain_generation_id,
    observation_revision: fixture.fieldRevision,
    execution_revision: fixture.status.resources.stages_revision,
    layout_fingerprint: null,
    strategy: null,
    requested_mode: null,
    resolved_mode: null,
    requested_common_cell_size: null,
    common_transform_layout: null,
    layers: [],
    airbox: {
      carrier_available: false,
      h_demag_available: false,
      h_eff_available: false,
      unavailable_reason: "not_fdm_multilayer",
      h_eff_unavailable_reason: "fdm_multilayer_airbox_h_eff_unavailable.v1",
      cells: null,
      origin_m: null,
      cell_size_m: null,
      carrier_fingerprint: null,
      sample_count: null,
      value_count: null,
      carrier_revision: null,
      source_policy: null,
      target_only: null,
      source_grid_fingerprints: null,
      source_runtime_identity: null,
    },
  };
}

function fdmGeometryValidationFixture(fixture) {
  return {
    scene_revision: fixture.sceneRevision,
    backend_target: "fem",
    status: "ready",
    dirty: false,
    diagnostics: [],
  };
}

function fdmModelReadinessFixture(fixture) {
  const checks = [
    {
      id: "method",
      state: "blocked",
      label: "Simulation method",
      target_resource: "model/study",
      reason: "Choose FEM or FDM in Study settings.",
    },
    {
      id: "domain",
      state: "complete",
      label: "Domain policy",
      target_resource: "meshing/policies/universe",
      reason:
        "Automatic bounds will be derived after geometry is added. You can configure manual dimensions now or later.",
    },
    {
      id: "geometry",
      state: "blocked",
      label: "Geometry",
      target_resource: "model/scene",
      reason: "Add at least one magnetic object.",
    },
    {
      id: "material",
      state: "blocked",
      label: "Material",
      target_resource: "model/materials",
      reason: "Assign a material to every magnetic object.",
    },
    {
      id: "texture",
      state: "blocked",
      label: "Initial magnetization",
      target_resource: "model/magnetization-assets",
      reason: "Assign initial magnetization to every magnetic object.",
    },
    {
      id: "interactions",
      state: "blocked",
      label: "Interactions",
      target_resource: "model/objects/interactions",
      reason: "Enable at least one interaction for every magnetic object.",
    },
    {
      id: "discretization",
      state: "blocked",
      label: "Discretization",
      target_resource: "model/study",
      reason: "Choose FDM or FEM discretization.",
    },
    {
      id: "study",
      state: "blocked",
      label: "Study",
      target_resource: "model/study",
      reason: "Add at least one study stage.",
    },
    {
      id: "execution",
      state: "complete",
      label: "Execution request",
      target_resource: "model/study",
      reason:
        "The requested device is configured; engine availability is checked during preparation for each run.",
    },
  ];
  const blockers = checks
    .filter((check) => check.state !== "complete")
    .map((check) => check.reason);
  return {
    scene_revision: fixture.sceneRevision,
    ready_to_run: false,
    ready_to_export: false,
    checks,
    blockers,
    capabilities: {
      move: { available: true, reason: null },
      rotate: {
        available: false,
        reason:
          "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.",
      },
      scale: {
        available: false,
        reason:
          "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.",
      },
    },
  };
}

function fdmSolverStatusFixture() {
  return {
    revision: 0,
    runtime_state: "idle",
    runtime_status_kind: "idle",
    runtime_status_code: "idle",
    session_status: "running",
    is_busy: false,
    can_accept_commands: true,
    run_id: null,
    stage_kind: null,
    warnings: [],
  };
}

function fdmGeometryCapabilitiesFixture(fixture) {
  const primitiveCapabilities = [
    ["box", "Box", "core", true, true, true, true, "production"],
    ["cylinder", "Cylinder", "core", true, true, true, true, "production"],
    ["sphere", "Sphere", "mumax", false, false, false, true, "preview"],
    ["ellipsoid", "Ellipsoid", "mumax", false, false, false, true, "preview"],
    ["disk", "Disk", "core", true, true, true, true, "production"],
    ["thin_film", "Thin Film", "mumax", true, true, true, true, "production"],
    ["pillar", "Pillar", "mumax", true, true, true, true, "production"],
    ["nanowire", "Nanowire", "mumax", true, true, true, true, "production"],
    ["ring", "Ring", "mumax", true, true, true, true, "production"],
    ["arch_waveguide", "Arch Waveguide", "core", true, true, true, false, "production"],
    ["microstrip_antenna_layout", "Microstrip Antenna Layout", "antenna", true, false, true, false, "preview"],
    ["cpw_antenna_layout", "CPW Antenna Layout", "antenna", true, false, true, false, "preview"],
    ["triangular_prism", "Triangular Prism", "core", false, false, false, true, "preview"],
    ["cone", "Cone", "dcc", false, false, false, true, "preview"],
    ["capsule", "Capsule", "dcc", false, false, false, true, "preview"],
    ["tube", "Tube", "dcc", false, false, false, true, "preview"],
    ["wedge", "Wedge", "dcc", false, false, false, true, "preview"],
    ["polygon_prism", "Polygon Prism", "dcc", false, false, false, true, "preview"],
  ].map(([id, label, category, fem, fdm, dsl, boolean, status]) => ({
    id,
    label,
    category,
    fem,
    fdm,
    dsl,
    boolean,
    status,
  }));
  return {
    revision: fixture.sceneRevision,
    primitive_capabilities: primitiveCapabilities,
    csg_capabilities: [
      {
        op: "union",
        fem: false,
        fdm: false,
        dsl: false,
        status: "unsupported",
        notes:
          "Union is represented in SceneDocument but not yet realized by the production mesh pipeline.",
      },
      {
        op: "subtract",
        fem: true,
        fdm: true,
        dsl: true,
        status: "production",
        notes:
          "Difference is supported for Box/Cylinder inputs, including Cylinder minus Cylinder rings.",
      },
      {
        op: "intersect",
        fem: false,
        fdm: false,
        dsl: false,
        status: "unsupported",
        notes:
          "Intersection is represented in SceneDocument but not yet realized by the production mesh pipeline.",
      },
    ],
  };
}

function fdmMeshCapabilitiesFixture(fixture) {
  return {
    revision: fixture.status.resources.mesh_revision,
    mesh_capabilities: null,
    mesh_adaptivity_state: null,
  };
}

function fdmMeshSemanticsFixture(fixture) {
  return {
    revision: fixture.status.resources.mesh_revision,
    universe_config: null,
    shared_domain_config: {
      algorithm_2d: 6,
      algorithm_3d: 1,
      size_mode: "predefined",
      hmax: "",
      hmin: "",
      maximum_element_size: "",
      minimum_element_size: "",
      calibrate_for: "general_physics",
      size_preset: "normal",
      size_factor: 1,
      size_from_curvature: 0,
      curvature_factor: "",
      growth_rate: "",
      maximum_element_growth_rate: "",
      narrow_regions: 0,
      narrow_region_resolution: "",
      smoothing_steps: 1,
      optimize: "",
      optimize_iterations: 1,
      compute_quality: true,
      per_element_quality: true,
      adaptive_enabled: false,
      adaptive_policy: "manual",
      adaptive_indicator: "geometric_only",
      adaptive_target_quantity: "auto",
      adaptive_convergence_metric: "energy_delta",
      adaptive_theta: 0.3,
      adaptive_h_min: "",
      adaptive_h_max: "",
      adaptive_max_passes: 5,
      adaptive_error_tolerance: "",
    },
    object_configs: [],
    solver_mesh: null,
    mesh_build_diagnostics: null,
    render_only_controls_do_not_change_solver_domain: true,
  };
}

function fdmQuantityCatalogFixture() {
  const quantities = [
    {
      id: "m",
      label: "Magnetization",
      description: "Reduced magnetization vector (|m|=1)",
      shape: "vector_field",
      unit: "dimensionless",
      location: "node",
      domain: "magnetic_only",
      n_comp: 3,
      normalization_hint: "unit_vector",
      quick_access_label: "M",
    },
    {
      id: "H_ex",
      label: "Exchange Field",
      description: "Exchange effective field contribution",
      shape: "vector_field",
      unit: "A/m",
      location: "node",
      domain: "magnetic_only",
      n_comp: 3,
      normalization_hint: "max_abs",
      quick_access_label: "H_ex",
    },
    {
      id: "H_demag",
      label: "Demagnetization Field",
      description: "Demagnetizing (stray) field",
      shape: "vector_field",
      unit: "A/m",
      location: "node",
      domain: "full_domain",
      n_comp: 3,
      normalization_hint: "max_abs",
      quick_access_label: "H_demag",
    },
    {
      id: "H_eff",
      label: "Effective Field",
      description: "Total effective magnetic field",
      shape: "vector_field",
      unit: "A/m",
      location: "node",
      domain: "full_domain",
      n_comp: 3,
      normalization_hint: "max_abs",
      quick_access_label: "H_eff",
    },
  ].map((quantity) => ({
    ...quantity,
    interactive_preview: true,
    supports_preview_2d: true,
    supports_preview_3d: true,
    supports_history: false,
    supports_export: true,
    capability_state: "supported",
    solver_capability: "supported",
    requestable: true,
    renderable: true,
    publication_state: "interactive",
    materializable: true,
    materialization_state: "complete",
  }));
  return { schema_version: "1.0.0", quantities };
}

function fdmModeCompositionFixture(fixture) {
  return {
    schema_version: "mode-composition.v1",
    revision: 0,
    composition_id: "",
    lifecycle: {
      session_id: "fdm-memory-churn-fixture",
      run_id: null,
      artifact_revision: 0,
      mesh_revision: fixture.status.resources.mesh_revision,
    },
    run_id: "",
    stage_id: "",
    artifact_revision: "",
    phase_clock: { synchronized: true, master_rate_hz: 1 },
    layers: [],
  };
}

function parseVisualizationClientAck(request) {
  let body;
  try {
    body = request.postDataJSON();
  } catch {
    return null;
  }
  if (
    !isPlainObject(body) ||
    typeof body.client_id !== "string" ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0 ||
    !["applied", "rendered", "failed"].includes(body.status)
  ) {
    return null;
  }
  const acknowledgement = {
    client_id: body.client_id,
    revision: body.revision,
    status: body.status,
  };
  for (const key of [
    "client_label",
    "viewport_id",
    "effective_render_mode",
    "error",
  ]) {
    if (typeof body[key] === "string") {
      acknowledgement[key] = body[key];
    }
  }
  return acknowledgement;
}

function makeFdmMultilayerActiveMaskBuffer() {
  const buffer = new ArrayBuffer(104 + FDM_PARTIAL_PACKED_MASK.byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMBM"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, FIELD_GRID[0], true);
  view.setUint32(12, FIELD_GRID[1], true);
  view.setUint32(16, FIELD_GRID[2], true);
  view.setUint32(20, FDM_PARTIAL_ACTIVE_MASK.length, true);
  view.setUint32(24, FDM_PARTIAL_PACKED_MASK.byteLength, true);
  view.setBigUint64(28, BigInt(FDM_MULTILAYER_LAYOUT_REVISION), true);
  writeHexBytes(view, 36, FDM_MULTILAYER_GRID_FINGERPRINT);
  writeHexBytes(view, 68, FDM_PARTIAL_MASK_HASH);
  new Uint8Array(buffer, 104).set(FDM_PARTIAL_PACKED_MASK);
  return buffer;
}

function createPartialActiveMask() {
  const activeMask = new Uint8Array(FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2]);
  activeMask.fill(1);
  for (const cellIndex of FDM_PARTIAL_INACTIVE_CELL_INDICES) {
    activeMask[cellIndex] = 0;
  }
  return activeMask;
}

function packActiveMask(activeMask) {
  const packed = new Uint8Array(Math.ceil(activeMask.length / 8));
  for (let cellIndex = 0; cellIndex < activeMask.length; cellIndex += 1) {
    packed[cellIndex >> 3] |= (activeMask[cellIndex] ?? 0) << (cellIndex & 7);
  }
  return packed;
}

function writeHexBytes(view, offset, hex) {
  for (let index = 0; index < hex.length / 2; index += 1) {
    view.setUint8(
      offset + index,
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    );
  }
}

function fdmFieldCatalogFixture(fixture) {
  const revision = fixture.fieldRevision;
  return {
    domain_generation_id: "1",
    revision,
    quantities: FIELD_QUANTITIES.map((quantityId) => ({
      available: true,
      components: 3,
      domain_generation_id: "1",
      field_revision: revision,
      kind: "vector",
      label: quantityId,
      location: "cell",
      materialization_wall_time_ns: 0,
      materialized_at_unix_ms: 0,
      quantity_id: quantityId,
      source_revision: revision,
      source_step: 0,
      stale_by_steps: 0,
      state: "complete",
      unit: "A/m",
    })),
  };
}

function fdmVisualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [1.4e-6, 1.0e-6, 8e-7],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: {
      enabled: false,
      normal_axis: "z",
      offset: 0,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: {
      active_scope_id: null,
      active_scope_kind: "domain",
    },
    fdm: {
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    fem: {
      topology_mode: "surface",
      volume_edges_budget: 0,
    },
    field_component: "magnitude",
    layers: {
      bounds: { visible: true },
      points: { visible: false },
      quantity_overlay: { visible: true },
      surface: { opacity: 0.94, visible: true },
      vectors: { density: 2, domain: "full_domain", visible: true },
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
    sampling: {
      max_glyphs: 192,
      max_points: 120000,
    },
    schema_version: 1,
    slice: {
      layer: 0,
      mode: "xy",
    },
    slice_layer: 0,
    slice_mode: "xy",
    trim: {
      enabled: false,
      max: [1, 1, 1],
      min: [0, 0, 0],
    },
    vector_density: 2,
    vector_glyphs: true,
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

function makeFdmFieldVectorBuffer(quantityId, fieldRevision = 1) {
  const pointCount = FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2];
  const valueCount = pointCount * 3;
  const buffer = new ArrayBuffer(
    48 + valueCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, FIELD_GRID[0], true);
  view.setUint32(20, FIELD_GRID[1], true);
  view.setUint32(24, FIELD_GRID[2], true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));

  const values = new Float64Array(buffer, 48);
  const phase = quantityPhase(quantityId);
  let offset = 0;
  for (let z = 0; z < FIELD_GRID[2]; z += 1) {
    for (let y = 0; y < FIELD_GRID[1]; y += 1) {
      for (let x = 0; x < FIELD_GRID[0]; x += 1) {
        const centeredX = (x - (FIELD_GRID[0] - 1) / 2) / ((FIELD_GRID[0] - 1) / 2);
        const centeredY = (y - (FIELD_GRID[1] - 1) / 2) / ((FIELD_GRID[1] - 1) / 2);
        const centeredZ = (z - (FIELD_GRID[2] - 1) / 2) / ((FIELD_GRID[2] - 1) / 2);
        const vx = Math.sin(centeredX * Math.PI + phase);
        const vy = Math.cos(centeredY * Math.PI - phase);
        const vz = Math.sin(centeredZ * Math.PI * 0.5 + phase * 0.5);
        const length = Math.hypot(vx, vy, vz) || 1;
        const amplitude =
          fieldRevision === 1 ? 1 : 0.45 + 0.55 * (x / (FIELD_GRID[0] - 1));
        values[offset++] = (vx / length) * amplitude;
        values[offset++] = (vy / length) * amplitude;
        values[offset++] = (vz / length) * amplitude;
      }
    }
  }

  return buffer;
}

function quantityPhase(quantityId) {
  if (quantityId === "H_eff") return 0.7;
  if (quantityId === "H_demag") return 1.4;
  if (quantityId === "H_ex") return 2.1;
  return 0.0;
}


