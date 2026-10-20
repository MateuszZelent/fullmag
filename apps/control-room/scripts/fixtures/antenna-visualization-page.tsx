"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useThree } from "@react-three/fiber";
import { BufferGeometry, InstancedMesh, Matrix4, ShaderMaterial, SRGBColorSpace, Vector2, Vector3, WebGLRenderTarget } from "three";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { decodeFieldVector } from "@/kernel/api/codecs/fieldVectorCodec";
import { DataPreviewDialog } from "@/kernel/layout/DataPreviewDialog";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import { DATA_FIELDS_PATH, DATA_FIELD_VECTOR_PATH, SIMULATION_SOLVER_STATUS_PATH } from "@/kernel/api/apiPaths";
import { DATA_ANTENNA_FIELD_SOLUTION_PATH, DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH, DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH, DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH, DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_DISPLAY_PATH, DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH, VISUALIZATION_STATE_PATH, MODEL_SCENE_PATH, SESSIONS_PATH, SESSION_STATUS_PATH, SIMULATION_STAGES_EXECUTION_PATH, DATA_QUANTITIES_PATH } from "@/kernel/api/apiPaths";
import type { VisualizationStateResource, VisualizationStatePatch, AntennaFieldSolutionResource, AntennaExternalLeadInspectionResource, AntennaInspectionDisplayResource, SceneResource, StageExecutionResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { VisualizationRegistrySyncController } from "@/kernel/visualization/VisualizationRegistrySyncController";
import { RIBBON_COMMANDS, RIBBON_VISUALIZATION_PATCH_STATE_COMMAND } from "@/modules/ribbon/ribbonCommands";
import { ClipPlaneLayer } from "@/modules/viewport-3d/layers/ClipPlaneLayer";
import { DEFAULT_CAMERA_REGISTRY_STATE, CameraRegistryController } from "@/kernel/visualization/CameraRegistryController";
import { viewport3dManifest } from "@/modules/viewport-3d/manifest";
import { viewport3dStore } from "@/modules/viewport-3d/viewport3dStore";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { antennaFieldPayloadEtag, antennaInspectionPayloadEtag } from "@/kernel/resources/antennaResources";
import type { KernelApi } from "@/kernel/types";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useAntennaFieldOverlay } from "@/modules/viewport-3d/hooks/useAntennaFieldOverlay";
import { Viewport3DCanvas } from "@/modules/viewport-3d/Viewport3DCanvas";
import { AntennaFieldLayer } from "@/modules/viewport-3d/layers/AntennaFieldLayer";
import { VectorGlyphDerivedBufferCacheProvider } from "@/modules/viewport-3d/layers/vectorGlyphDerivedBufferRuntime";
import { Viewport3DResourceTracker } from "@/modules/viewport-3d/viewport3dDiagnostics";
import { buildObjectExplorerNode } from "@/modules/explorer/builders/objectExplorerNodes";
import { resolveInspectorRoute } from "@/modules/inspector/inspectorRouteCatalog";
import { VisualizationDebugSampleTable } from "@/modules/inspector/panels/visualization-debug/VisualizationDebugSampleTable";
import type { VisualizationDebugPanelModel } from "@/modules/inspector/panels/visualization-debug/VisualizationDebugPanelModel";
import { buildFieldVectorDebugSamples } from "@/modules/viewport-3d/model/scanFieldVectorDebugStatistics";
import { makeClosedLoopBrowserFixture } from "../../scripts/fixtures/closed-loop-inspection-data";

const instance = "55555555-5555-4555-8555-555555555555";
const owner = { session_id: "antenna-viz-fixture", session_epoch: "antenna-viz-fixture@1", request_scope_epoch: `${instance}:1` };
const scope = () => sessionRequestScopeKey({ sessionId: owner.session_id, sessionEpoch: owner.session_epoch, requestScopeEpoch: owner.request_scope_epoch });
const digest = `sha256:${"a".repeat(64)}`;
const subscribe = () => () => {};
const client = () => true;
const server = () => false;
type Call = { method: string; path: string; range: string | null; scope: string | null; port: string | null; component?: string | null; maxSamples?: string | null; decodedQuantityId?: string };
declare global { interface Window { __antennaVisualizationFixture?: { read(): { calls: Call[]; tree: unknown; unexpected: string[] }; selectOther(): void; }; __antennaFieldPixel?: (position: number[]) => number[]; __antennaFieldCanvas?: () => { glyphMeshUuids: string[]; glyphMaterialUuids: string[]; clippingPlanes: number; lost: boolean; width: number; height: number; sampleCount: number; pointCount: number; glyphCount: number; surfaceTriangles: number; wireframeEdges: number; normalization: string; quantity: string; colorMinimum: number; colorMaximum: number; pointColors: number[]; surfaceColors: number[]; glyphColors: number[][]; glyphMatrices: number[][]; glyphPixelBounds: number[][]; glyphDepthTests: boolean[]; glyphDepthWrites: boolean[]; rangeMinimum: number; rangeMaximum: number; shaderMinimum: number; shaderMaximum: number; vectorScale: number; currentVertices: number; currentMaterial: string; currentComponent: number; paletteTextures: number; minimum: number; maximum: number; surfaceUuid: string; wireUuid: string; pointsUuid: string; materialUuid: string; paletteUuid: string; }; } }

function makeFixture() {
  const scenario = new URL(window.location.href).searchParams.get("scenario") ?? "ready";
  const sampleCount = scenario === "glyph-count-7" ? 7 : scenario === "glyph-count-14" ? 14 : 10;
  const isInspection = scenario.startsWith("inspection");
  const cancellation = scenario === "inspection-closed-current-cancellation" ? "current"
    : scenario === "inspection-closed-magnetic-cancellation" ? "magnetic" : undefined;
  const closedFixture = scenario.startsWith("inspection-closed") ? makeClosedLoopBrowserFixture(owner, cancellation) : null;
  const isCurrent = scenario.startsWith("inspection-current");
  const scene = {
    revision: 1, objects: [{ id: "antenna", name: "Antenna", role: "antenna" }],
    antenna_field_solve_stages: scenario === "empty" ? [] : [{ id: "solve", source_object_id: "antenna", current_transport_id: "transport", port_mode_ids: ["port"], model: "quasistatic_conduction_biot_savart3d", oersted_realization: "direct_tetra_quadrature", conductor_mesh_policy: "inherit_source", solver_policy: "default", field_sampling_domain: { kind: "global" }, target_refs: [{ kind: "global" }], outputs: [{ id: "solution", quantity: "H_ant_basis" }] }],
    antenna_port_modes: [{ id: "port", schema_version: "antenna_port_mode.v2", source_object_id: "antenna", current_transport_id: "transport", normalization_current_a: 1, branches: [{ id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out", signed_weight: 1 }, { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out", signed_weight: -1 }] }],
    // Synthetic fixture-only contract; never submitted to a solver.
    current_transports: [{ name: "transport", kind: "current_transport", model: "ohmic_poisson",
      domain: [{ object_id: "antenna" }],
      boundaries: ["signal-in", "signal-out", "return-in", "return-out"].map((id) => ({
        id, kind: "voltage_electrode", potential_V: 0, surfaces: [{ object_id: "antenna", surface_id: id }],
      })),
      conservative_current_view: { stable_vertex_ids: [1], boundary_faces: [{}], identity: {}, pins: {}, closure: {} },
    }],
  } as unknown as SceneResource;
  const ref = (layout: string, unit: string, value_count: number) => ({ layout, unit, value_count, scalar_type: "float64_le", sha256: "a".repeat(64), path: "fixture-only" });
  const solution: AntennaFieldSolutionResource = {
    ...owner, solution_id: "solution", stage_id: "solve", status: "ready", quantity: "H_ant_basis", asset_id: "fixture-asset", content_digest: digest,
    source_object_id: scenario === "foreign" ? "foreign-antenna" : "antenna", current_transport_id: "transport", geometry_revision: "historical-geometry", material_revision: "historical-material", mesh_digest: "historical-mesh",
    schema_version: "fixture-only", resource_id: "fixture-only", assumptions: ["Synthetic UI fixture; not a solver result"], component: "vector_basis", gauge_policy: "fixture-only", requested_execution: {}, resolved_execution: {}, solver_policy: {}, signatures: { current_solution_signature: "fixture-current", field_solution_signature: "fixture-field", target_projection_signatures: {} },
    conductor_positions: ref("node_xyz_interleaved", "m", sampleCount * 3), sample_positions: ref("sample_xyz_interleaved", "m", sampleCount * 3),
    sample_carrier: { domain: { kind: "global" }, carrier_kind: "mesh_nodes", location: "node", topology_digest: "field-topology" },
    bases: [{ port_mode_id: "port", normalization_current_a: 1, measured_positive_terminal_current_a: 1, normalization_scale: 1, current_balance_certificate_digest: "fixture-only", quadrature_diagnostics: {}, electric_potential_per_ampere: ref("node_scalar", "V/A", sampleCount), current_density_per_ampere: ref("sample_xyz_interleaved", "A/m^2/A", sampleCount * 3), magnetic_field_per_ampere: ref(scenario === "malformed" ? "wrong_layout" : "sample_xyz_interleaved", "A/m/A", sampleCount * 3) }],
  };
  if (scenario === "cardinality") solution.bases[0].magnetic_field_per_ampere.value_count = 27;
  if (scenario === "basis-duplicate-port") solution.bases.push({ ...solution.bases[0] });
  if (scenario === "multiport") solution.bases.push({ ...solution.bases[0], port_mode_id: "port-two" });
  const inspection: AntennaExternalLeadInspectionResource = {
    ...owner, schema_version: "antenna_external_lead_stage_output.v1", resource_id: "fixture-inspection", run_id: "fixture-run", runtime_stage_id: "runtime-solve-001", stage_revision: 1,
    record_content_digest: digest, stage_id: "solve", stage_kind: "antenna_external_lead_inspection", output_id: "inspection", port_mode_id: "port",
    status: "inspection_only", field_scope: "external_electrode_truncation", qualification: "NOT VERIFIED", resolved_action: "inspection_only",
    outputs: [{ kind: "inspection_only", manifest_ref: "fixture-only", payload_units: {}, reused_existing: false, inspection_ref: { content_digest: digest, output_id: "inspection", stage_id: "solve" } }],
    manifest: {
      schema_version: "antenna_external_lead_solution.v1", content_digest: digest, source_object_id: "antenna", current_transport_id: "transport", drive_id: "fixture-drive", closure_revision: "fixture-closure",
      validation_scope: "inspection_only", requested_execution: {}, resolved_execution: {}, input_pins: {}, solver_policy: {}, charge_content_sha256: "a".repeat(64), source_content_sha256: "a".repeat(64), field_content_sha256: "a".repeat(64),
      sampling_carrier: { carrier_kind: "mesh_nodes", location: "node", domain: { kind: "global" }, sample_count: 10, topology_digest: "fixture-samples" },
      sample_positions: { ...ref("sample_xyz_interleaved", "m", 30), byte_count: 240 },
      magnetic_field: { ...ref("sample_xyz_interleaved", "A/m", 30), byte_count: 240 },
      device_vertex_ids: { ...ref("stable_vertex_ids", "1", 10), scalar_type: "uint64_le", byte_count: 80 },
      device_potential: { ...ref("authored_device_vertex_order", "V", 10), byte_count: 80 },
      bundle: { ...ref("bundle", "1", 0), scalar_type: "bytes", byte_count: 0 },
    },
  };
  const executionStages: StageExecutionResource["stages"] = isInspection ? [{
    stage_id: inspection.runtime_stage_id, antenna_solve_stage_id: inspection.stage_id,
    index: 0, status: "completed", converged: false,
    kind: "study_pipeline_antenna_field_solve", label: "Synthetic inspection execution", artifact_refs: [],
  }] : [];
  const execution: StageExecutionResource = {
    ...owner, run_id: inspection.run_id, revision: 1, runtime_state: "completed",
    total_stages: executionStages.length, stages: executionStages,
    stage_statuses: executionStages.map((stage) => stage.status), completed_stage_indexes: isInspection ? [0] : [],
  };
  const f64 = (values: number[]) => { const data = new ArrayBuffer(values.length * 8), view = new DataView(data); values.forEach((value, index) => view.setFloat64(index * 8, value, true)); return data; };
  const deviceCoordinates = Array.from({ length: 10 }, (_, node) => {
    const shift = Math.floor(node / 5) * 4e-7;
    const coordinates = [[-2e-7, -1e-7, 0], [-1e-7, -1e-7, 0], [-2e-7, 1e-7, 0], [-2e-7, -1e-7, 1e-7], [-2e-7, -1e-7, -1e-7]][node % 5];
    return [coordinates[0] + shift, coordinates[1], coordinates[2]];
  }).flat();
  if (scenario === "inspection-degenerate") deviceCoordinates[11] = 0;
  const cellIndices = [0, 1, 2, 3, 0, 1, 2, 4, 5, 6, 7, 8, 5, 6, 7, 9];
  if (scenario === "inspection-index") cellIndices[3] = 10;
  if (scenario === "inspection-duplicate-cell") cellIndices.splice(4, 4, 0, 1, 2, 3);
  const topology = new ArrayBuffer(cellIndices.length * 4), topologyView = new DataView(topology);
  cellIndices.forEach((value, index) => topologyView.setUint32(index * 4, value, true));
  // Controlled affine vectors with different cell-local traces, not a transport solution.
  const traceCoordinates = cellIndices.flatMap((node) => deviceCoordinates.slice(node * 3, node * 3 + 3));
  const traceCurrent = cellIndices.flatMap((node, local) => [0, 1, 2].map((axis) =>
    scenario === "inspection-current-cancellation"
      // Affine RT0-shaped vectors cancel at the visible face's barycenter.
      ? (deviceCoordinates[node * 3 + axis] - ([-5e-7 / 3 + Math.floor(node / 5) * 4e-7, -1e-7 / 3, 1e-7 / 3][axis])) * 1e15
      : (Math.floor(local / 4) % 2 ? -1 : 1) * (axis + 1) * 1e8 + deviceCoordinates[node * 3 + axis] * 1e14));
  const centers = Array.from({ length: 4 }, (_, cell) => [0, 1, 2].map((axis) =>
    [0, 1, 2, 3].reduce((sum, local) => sum + traceCoordinates[(cell * 4 + local) * 3 + axis] / 4, 0))).flat();
  const centerCurrent = Array.from({ length: 4 }, (_, cell) => [0, 1, 2].map((axis) =>
    [0, 1, 2, 3].reduce((sum, local) => sum + traceCurrent[(cell * 4 + local) * 3 + axis] / 4, 0))).flat();
  if (scenario === "inspection-current-position") traceCoordinates[0] += 1e-8;
  if (scenario === "inspection-current-nonfinite") traceCurrent[0] = NaN;
  const rawPayloads = {
    device_positions: f64(deviceCoordinates), device_topology: topology,
    device_potential: f64(Array.from({ length: 10 }, (_, node) => scenario === "inspection-extreme" ? node < 5 ? -1e308 : 1e308 : scenario === "inspection-nonfinite" && node === 2 ? NaN : node - 4.5)),
    sample_positions: f64(Array.from({ length: 30 }, (_, index) => { const node = Math.floor(index / 3), axis = index % 3; return axis === 0 ? (node % 5 - 2) * 1e-7 : axis === 1 ? (Math.floor(node / 5) - 0.5) * 2e-7 : 0; })),
    magnetic_field: f64(Array.from({ length: 30 }, (_, index) => index + 1)),
    current_center_positions: f64(centers), current_center_density: f64(centerCurrent),
    current_trace_positions: f64(traceCoordinates), current_trace_density: f64(traceCurrent),
  };
  let displayPromise: Promise<AntennaInspectionDisplayResource> | null = null;
  const displayMetadata = () => displayPromise ??= (async () => {
    const descriptor = async (kind: keyof typeof rawPayloads, layout: string, unit: string, scalar_type = "float64_le") => {
      const data = rawPayloads[kind], hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      return { layout, unit, scalar_type, value_count: data.byteLength / (scalar_type === "uint32_le" ? 4 : 8), byte_count: data.byteLength, sha256: [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join(""), path: `fixture-only/${kind}.bin` };
    };
    const display: AntennaInspectionDisplayResource = {
      ...owner, schema_version: "antenna_inspection_display.v1", resource_id: "fixture-display", run_id: inspection.run_id, runtime_stage_id: "runtime-solve-001", stage_revision: 1,
      record_content_digest: digest, content_digest: digest, source_object_id: "antenna", status: "inspection_only", qualification: "NOT VERIFIED", field_scope: "external_electrode_truncation", normalization: "raw_authored_current",
      capabilities: { display: true, per_ampere_basis: false, llg_drive: false, source_fft: false, current_density: false }, device_node_count: 10, device_cell_count: 4,
      sampling_carrier: inspection.manifest!.sampling_carrier,
      device_positions: await descriptor("device_positions", "node_xyz_interleaved", "m"), device_topology: await descriptor("device_topology", "tet4_connectivity", "1", "uint32_le"),
      device_potential: await descriptor("device_potential", "authored_device_vertex_order", "V"), sample_positions: await descriptor("sample_positions", "sample_xyz_interleaved", "m"), magnetic_field: await descriptor("magnetic_field", "sample_xyz_interleaved", "A/m"),
    };
    inspection.manifest!.device_potential = display.device_potential;
    inspection.manifest!.sample_positions = display.sample_positions;
    inspection.manifest!.magnetic_field = display.magnetic_field;
    if (isCurrent) {
      inspection.schema_version = "antenna_external_lead_stage_output.v2";
      inspection.manifest!.schema_version = "antenna_external_lead_solution.v2";
      display.schema_version = "antenna_inspection_display.v2";
      display.capabilities.current_density = true;
      const snapshot = { ...ref("accepted_external_lead_current_display.ordered.v1", "A/m^2", 1), scalar_type: "ordered_binary_v1", byte_count: 1, path: "current_display.v1.bin" };
      const receipt = {
        schema_version: "accepted_external_lead_current_display.ordered.v1", operator_version: "fem_accepted_external_lead_current_display.v1",
        current_evaluator_version: "fem_generic_affine_rt0.v1", sampling_policy: "cell_center_and_cell_local_vertices.v1",
        center_policy: "vertex_quarter_sum.long_double.v1", normalization: "raw_authored_current", coordinate_unit: "m", current_density_unit: "A/m^2", cell_count: 4, payload: snapshot,
      };
      const currentDescriptor = async (kind: keyof typeof rawPayloads, layout: string, unit: string) => ({ ...await descriptor(kind, layout, unit), path: `display/${kind}.bin` });
      display.device_current = {
        receipt, ordered_snapshot: snapshot,
        center_positions: await currentDescriptor("current_center_positions", "cell_xyz_interleaved", "m"),
        center_current_density: await currentDescriptor("current_center_density", "cell_vector_xyz_interleaved", "A/m^2"),
        trace_positions: await currentDescriptor("current_trace_positions", "cell_local_vertex_xyz_interleaved", "m"),
        trace_current_density: await currentDescriptor("current_trace_density", "cell_local_vertex_vector_xyz_interleaved", "A/m^2"),
      };
      inspection.manifest!.current_display = structuredClone(receipt);
      if (scenario === "inspection-current-unit") display.device_current.trace_current_density.unit = "A/m";
      if (scenario === "inspection-current-generation") inspection.manifest!.schema_version = "antenna_external_lead_solution.v1";
    }
    if (scenario === "inspection-foreign") display.source_object_id = "foreign-antenna";
    if (scenario === "inspection-digest") display.content_digest = `sha256:${"b".repeat(64)}`;
    if (scenario === "inspection-layout") display.device_potential.layout = "node_scalar";
    if (scenario === "inspection-size") { display.device_positions.value_count = 300003; display.device_positions.byte_count = 2400024; display.device_node_count = 100001; display.device_potential.value_count = 100001; display.device_potential.byte_count = 800008; }
    return display;
  })();
  const tree = buildObjectExplorerNode({ id: "antenna", label: "Antenna", objectRole: "antenna" }, { scene });
  const calls: Call[] = [], unexpected: string[] = [];
  let remote = { revision: 1, overrides: [], layers: {}, camera: DEFAULT_CAMERA_REGISTRY_STATE, clip: { enabled: false, axis: "z", position_percent: 50, flipped: false } } as unknown as VisualizationStateResource;
  let holdClip = false;
  const pendingClip: (() => void)[] = [];
  const bus = new EventBus<KernelEventMap>(), resources = new ResourceInvalidationController(bus), diagnostics = new RequestDiagnosticsController();
  const selection = new SelectionController(bus), visualization = new ObjectVisualizationController();
  const layout = new LayoutController(bus); layout.setActiveTab("geometry"); layout.setActiveViewportMainModule("viewport-3d");
  const visualizationDebug = new VisualizationDebugController();
  const commands = new CommandRegistry();
  for (const command of viewport3dManifest.contributes?.commands ?? []) {
    if (scenario !== "camera-unavailable" && ["viewport-3d.fit", "viewport-3d.reset-camera", "viewport-3d.open-camera-dialog"].includes(command.id)) commands.register(command);
  }
  const clipCommand = RIBBON_COMMANDS.find(command => command.id === RIBBON_VISUALIZATION_PATCH_STATE_COMMAND)!;
  if (scenario !== "clip-unavailable") commands.register(clipCommand);
  commands.attachSessionScopeSource({ getScopeKey: () => scope(), subscribe: () => () => {} });
  selection.set({ kind: "object.antenna.visualization", objectId: "antenna" }, "inspector");
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const headers = { "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": instance };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { ...headers, "content-type": "application/json" } });
  const path = (template: string, key: string, value: string) => template.replace(`{${key}}`, value);
  const metadataPath = path(DATA_ANTENNA_FIELD_SOLUTION_PATH, "solution_id", "solution");
  const catalogPath = path(DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH, "stage_id", "solve");
  const payloadPrefix = path(DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH, "solution_id", "solution").split("{payload_kind}")[0];
  const api = new ControlRoomApi({ baseUrl: "http://antenna-visualization.fixture.invalid", expectedApiInstance: instance, diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const call: Call = { method: request.method, path: url.pathname, range: request.headers.get("range"), scope: request.headers.get("x-fullmag-session-scope"), port: url.searchParams.get("port_mode_id") };
    calls.push(call);
    if (calls.length > 100) throw new Error("Fixture request budget exceeded");
    if (url.pathname === VISUALIZATION_STATE_PATH) {
      if (request.headers.get("x-fullmag-session-scope") !== scope()) throw new Error("Unconfirmed section scope");
      if (scenario === "clip-unavailable") return new Response("{}", { status: 404, headers });
      if (request.method === "PATCH") {
        const patch = await request.json() as VisualizationStatePatch;
        if (Object.keys(patch).some(key => key !== "clip") || !patch.clip) throw new Error("Unexpected section patch");
        if (scenario === "clip-reject") return new Response(JSON.stringify({ error: "Section rejected by fixture" }), { status: 409, headers });
        if (holdClip) await new Promise<void>(resolve => pendingClip.push(resolve));
        remote = { ...remote, revision: remote.revision + 1, clip: {
          axis: patch.clip.axis ?? remote.clip.axis, enabled: patch.clip.enabled ?? remote.clip.enabled,
          flipped: patch.clip.flipped ?? remote.clip.flipped, position_percent: patch.clip.position_percent ?? remote.clip.position_percent,
        } };
      } else if (request.method !== "GET") throw new Error("Unexpected section method");
      return json(remote);
    }
    if (request.method !== "GET") throw new Error("Fixture method violation");
    if (scenario === "tensor-data-preview") {
      if (url.pathname === SIMULATION_SOLVER_STATUS_PATH) return json({ revision: 1, step_index: 3, sim_time_seconds: 0, runtime_state: "idle" });
      if (url.pathname === DATA_FIELDS_PATH) return json({ revision: 1, quantities: [{ quantity_id: "m" }, { quantity_id: "spin_current_tensor" }] });
      const vectorPrefix = DATA_FIELD_VECTOR_PATH.split("{quantity_id}")[0];
      if (url.pathname.startsWith(vectorPrefix) && url.pathname.endsWith("/samples/vector")) {
        const quantityId = decodeURIComponent(url.pathname.slice(vectorPrefix.length).split("/")[0]);
        const component = url.searchParams.get("component"), maxSamples = url.searchParams.get("max_samples");
        Object.assign(call, { component, maxSamples });
        if (request.headers.get("x-fullmag-session-scope") !== scope() || maxSamples !== "17" ||
            !(quantityId === "spin_current_tensor" && component === "full" || quantityId === "m" && (component === "full" || component === "x"))) throw new Error("Unexpected Data Preview field query");
        const tensor = quantityId === "spin_current_tensor";
        const values = tensor ? [1, -2, 3, -4, 5, -6, 7, -8, 9, -10, 11, -12, 13, -14, 15, -16, 17, -18] : component === "x" ? [2, -5] : [2, 3, 4, -5, 6, 7];
        const nComp = tensor ? 9 : component === "x" ? 1 : 3;
        const body = previewFieldBuffer(quantityId, nComp, values);
        call.decodedQuantityId = decodeFieldVector(body).quantityId;
        if (call.decodedQuantityId !== quantityId) throw new Error("Data Preview fixture lost full decoded quantity identity");
        return new Response(body, { headers: { ...headers, "content-type": "application/octet-stream", "x-fullmag-encoding": "FMVP;version=5", "x-fullmag-quantity-id": quantityId, etag: `"preview-${quantityId}-${component}"` } });
      }
    }
    if (url.pathname === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: owner.session_id, name: "Fixture", current: true, status: "idle" }] });
    if (url.pathname === SESSION_STATUS_PATH) return json({ session: { ...owner, name: "Fixture", created_at: "fixture", workspace_root: "fixture" }, run: { run_id: execution.run_id }, resources: { scene_revision: 1 }, capabilities: {}, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
    if (url.pathname === DATA_QUANTITIES_PATH && (scenario === "tensor-table" || scenario === "tensor-data-preview")) return json({ schema_version: "tensor-fixture.v1", quantities: [{ id: "spin_current_tensor", tensor: { rank: 2, shape: [3, 3], layout: "flow_major", axes: ["flow", "spin"], component_labels: ["Q_xx", "Q_xy", "Q_xz", "Q_yx", "Q_yy", "Q_yz", "Q_zx", "Q_zy", "Q_zz"] } }] });
    // This fixture has no canonical raw artifact carriers; their public path has a separate fixture.
    if (url.pathname === DATA_FIELDS_PATH) return json({ revision: 1, quantities: [] });
    if (url.pathname === DATA_QUANTITIES_PATH) return json({ schema_version: "basis-fixture.v1", quantities: [] });
    if (url.pathname === MODEL_SCENE_PATH) return json(scene);
    if (url.pathname === SIMULATION_STAGES_EXECUTION_PATH) return json(execution);
    if (url.pathname === metadataPath) return isInspection ? new Response("{}", { status: 404, headers }) : json(solution);
    if (url.pathname === catalogPath) {
      const output = { output_id: "solution", solution_ref: { output_id: scenario === "basis-output-ref" ? "other" : "solution", asset_id: solution.asset_id, content_digest: digest, stage_id: "solve" } };
      return json({ ...owner, stage_id: "solve", status: "ready", outputs: scenario === "basis-duplicate-output" ? [output, { ...output }] : [output] });
    }
    if (url.pathname === path(DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH, "stage_id", "runtime-solve-001")) { if (closedFixture) { const closed = await closedFixture; if (scenario === "inspection-closed-foreign") closed.inspection.run_id = "foreign-run"; return json(closed.inspection); } if (isInspection) await displayMetadata(); return isInspection ? json(inspection) : new Response("{}", { status: 404, headers }); }
    if (url.pathname === path(DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_DISPLAY_PATH, "stage_id", "runtime-solve-001")) {
      if (!isInspection || url.searchParams.get("content_digest") !== digest) throw new Error("Unexpected display metadata contract");
      if (closedFixture) return json((await closedFixture).display);
      return json(await displayMetadata());
    }
    const inspectionPrefix = path(DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH, "stage_id", "runtime-solve-001").split("{payload_kind}")[0];
    if (url.pathname.startsWith(inspectionPrefix)) {
      const kind = url.pathname.slice(inspectionPrefix.length) as keyof typeof rawPayloads;
      if (closedFixture) {
        const closed = await closedFixture;
        const selected = kind as keyof typeof closed.payloads;
        const data = closed.payloads[selected], descriptor = closed.inspection.closed_loop_manifest.payloads[selected];
        if (!data || !descriptor || request.headers.get("range") !== `bytes=0-${data.byteLength - 1}` || url.searchParams.get("content_digest") !== digest) throw new Error("Closed-loop fixture payload identity/range differs");
        return new Response(data, { status: 206, headers: { ...headers, "content-type": "application/octet-stream", etag: await antennaInspectionPayloadEtag(closed.inspection as unknown as AntennaExternalLeadInspectionResource, selected, descriptor.sha256), "content-range": `bytes 0-${data.byteLength - 1}/${data.byteLength}` } });
      }
      if (!isInspection || !Object.hasOwn(rawPayloads, kind) || url.searchParams.get("content_digest") !== digest) throw new Error("Unexpected inspection payload contract");
      const metadata = await displayMetadata();
      const currentDescriptors = {
        current_center_positions: metadata.device_current?.center_positions, current_center_density: metadata.device_current?.center_current_density,
        current_trace_positions: metadata.device_current?.trace_positions, current_trace_density: metadata.device_current?.trace_current_density,
      };
      const data = rawPayloads[kind], descriptor = kind in currentDescriptors ? currentDescriptors[kind as keyof typeof currentDescriptors] : metadata[kind as "device_potential" | "device_positions" | "device_topology" | "sample_positions" | "magnetic_field"];
      if (!descriptor || request.headers.get("range") !== null && request.headers.get("range") !== `bytes=0-${data.byteLength - 1}`) throw new Error("Unexpected inspection payload range");
      let body = data;
      if (kind === "device_potential" && scenario === "inspection-corrupt") { body = data.slice(0); new DataView(body).setFloat64(0, 999, true); }
      if (kind === "device_potential" && scenario === "inspection-short") body = data.slice(0, data.byteLength - 8);
      return new Response(body, { status: 206, headers: { ...headers, "content-type": "application/octet-stream", etag: scenario === "inspection-etag" && kind === "device_potential" ? '"wrong-revision"' : await antennaInspectionPayloadEtag(inspection, kind, descriptor.sha256), "content-range": `bytes 0-${data.byteLength - 1}/${data.byteLength}`, "x-fullmag-scalar-type": descriptor.scalar_type } });
    }
    if (url.pathname.startsWith(payloadPrefix)) {
      const kind = url.pathname.slice(payloadPrefix.length) as Parameters<typeof antennaFieldPayloadEtag>[1];
      const port = url.searchParams.get("port_mode_id") ?? undefined;
      const range = request.headers.get("range")?.match(/^bytes=0-(\d+)$/);
      if (!range) throw new Error("Unbounded fixture payload request");
      const bytes = Number(range[1]) + 1, data = new ArrayBuffer(bytes), view = new DataView(data);
      for (let index = 0; index < bytes / 8; index += 1) {
        const node = Math.floor(index / 3), axis = index % 3;
        const value = kind.endsWith("positions") ? axis === 0 ? (node % 5 - 2) * 1e-7 : axis === 1 ? (Math.floor(node / 5) - 0.5) * 2e-7 : 0 : index + 0.25;
        view.setFloat64(index * 8, scenario === "nonfinite" && index === 9 && !kind.endsWith("positions") ? NaN : value, true);
      }
      const etag = scenario === "etag" ? '"wrong-revision"' : antennaFieldPayloadEtag(solution, kind, port);
      return new Response(scenario === "short" ? data.slice(0, Math.max(0, bytes - 8)) : data, { status: 206, headers: { ...headers, "content-type": "application/octet-stream", etag, "content-range": `bytes 0-${bytes - 1}/${kind === "electric_potential_per_ampere" ? sampleCount * 8 : sampleCount * 24}`, "x-fullmag-scalar-type": "float64_le" } });
    }
    unexpected.push(url.pathname); throw new Error(`Unexpected fixture request: ${url.pathname}`);
  } });
  const visualizationSync = new VisualizationRegistrySyncController({ api: api.visualization, resourceCacheScope: api.resourceCacheScope, resources });
  const cameraRegistry = new CameraRegistryController({ api: api.visualization, idleFlushMs: null, windowTarget: null, documentTarget: null });
  cameraRegistry.patchCamera({ position: [7e-7, 2e-7, 5e-7] });
  return { kernel: { api, bus, resources, diagnostics, diagnosticRecorder, layout, visualizationDebug, analysisFieldOverlay: new AnalysisFieldOverlayController(), authoringHistory: new AuthoringHistoryController(api, resources), selection, visualization, commands, cameraRegistry, visualizationSync } as unknown as KernelApi, control: { read: () => ({ calls, tree, unexpected, camera: cameraRegistry.getSnapshot(), viewport: viewport3dStore.getSnapshot(), clip: remote.clip, clipPending: pendingClip.length }), holdClip: () => { holdClip = true; }, releaseClip: () => { holdClip = false; for (const resolve of pendingClip.splice(0)) resolve(); }, selectOther: () => selection.set({ objectId: "other", ref: null }, "inspector") } };
}

function FieldCanvasProbe({ tracker }: { tracker: Viewport3DResourceTracker }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    // One bounded diagnostic render/readback, fixture-only; no production render loop.
    window.__antennaFieldPixel = (position) => {
      const size = gl.getDrawingBufferSize(new Vector2());
      const target = new WebGLRenderTarget(size.x * 2, size.y * 2);
      target.texture.colorSpace = SRGBColorSpace;
      const previous = gl.getRenderTarget(), pixel = new Uint8Array(4);
      const field = scene.getObjectByName("antenna-scientific-field");
      const decorations = scene.children.filter(child => child !== field && !child.getObjectByName("antenna-scientific-field"))
        .map(object => ({ object, visible: object.visible }));
      for (const { object } of decorations) object.visible = false;
      try {
        gl.setRenderTarget(target); gl.render(scene, camera);
        const projected = new Vector3(position[0], position[1], position[2]).project(camera);
        gl.readRenderTargetPixels(target, Math.floor((projected.x + 1) / 2 * target.width), Math.floor((projected.y + 1) / 2 * target.height), 1, 1, pixel);
        return Array.from(pixel);
      } finally { gl.setRenderTarget(previous); target.dispose(); for (const { object, visible } of decorations) object.visible = visible; }
    };
    window.__antennaFieldCanvas = () => {
      const size = gl.getDrawingBufferSize(new Vector2());
      let glyphCount = 0;
      const glyphColors: number[][] = [], glyphMatrices: number[][] = [];
      const glyphMeshUuids: string[] = [], glyphMaterialUuids: string[] = [];
      const glyphDepthTests: boolean[] = [], glyphDepthWrites: boolean[] = [];
      const glyphPixelBounds: number[][] = [];
      scene.traverse((object) => { if (object instanceof InstancedMesh) {
        glyphCount = Math.max(glyphCount, object.count);
        glyphMeshUuids.push(object.uuid);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          glyphMaterialUuids.push(material.uuid);
          glyphDepthTests.push(material.depthTest); glyphDepthWrites.push(material.depthWrite);
        }
        glyphColors.push(Array.from(object.instanceColor?.array.slice(0, object.count * 3) ?? []));
        glyphMatrices.push(Array.from(object.instanceMatrix.array.slice(0, object.count * 16)));
        object.geometry.computeBoundingBox();
        const bounds = object.geometry.boundingBox!;
        for (let index = 0; index < object.count; index++) {
          const matrix = new Matrix4(); object.getMatrixAt(index, matrix);
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
            const point = new Vector3(x, y, z).applyMatrix4(matrix).applyMatrix4(object.matrixWorld).project(camera);
            minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
          }
          glyphPixelBounds.push([(maxX - minX) * size.x / 2, (maxY - minY) * size.y / 2]);
        }
      } });
      const field = scene.getObjectByName("antenna-scientific-field");
      const points = scene.getObjectByName("antenna-field-samples");
      const surface = scene.getObjectByName("antenna-field-surface"), wireframe = scene.getObjectByName("antenna-field-wireframe");
      const geometry = surface && "geometry" in surface ? surface.geometry : points && "geometry" in points ? points.geometry : null;
      let colorMinimum = Infinity, colorMaximum = -Infinity;
      if (geometry instanceof BufferGeometry) {
        const attribute = geometry.getAttribute("color");
        if (attribute) for (let index = 0; index < attribute.array.length; index += 1) { colorMinimum = Math.min(colorMinimum, attribute.array[index]); colorMaximum = Math.max(colorMaximum, attribute.array[index]); }
      }
      const indices = (object: typeof surface) => object && "geometry" in object && object.geometry instanceof BufferGeometry ? object.geometry.index?.count ?? 0 : 0;
      const currentMaterial = surface && "material" in surface && surface.material instanceof ShaderMaterial ? surface.material : null;
      return { glyphMeshUuids, glyphMaterialUuids, clippingPlanes: gl.clippingPlanes.length, lost: gl.getContext().isContextLost(), width: size.x, height: size.y, sampleCount: field?.userData.sampleCount ?? 0, pointCount: points ? field?.userData.sampleCount ?? 0 : 0, glyphCount, surfaceTriangles: indices(surface) / 3, wireframeEdges: indices(wireframe) / 2, quantity: field?.userData.quantity ?? "", normalization: field?.userData.normalization ?? "", colorMinimum, colorMaximum,
        pointColors: points && "geometry" in points && points.geometry instanceof BufferGeometry ? Array.from(points.geometry.getAttribute("color")?.array ?? []) : [], glyphColors, glyphMatrices, glyphPixelBounds, glyphDepthTests, glyphDepthWrites,
        surfaceColors: surface && "geometry" in surface && surface.geometry instanceof BufferGeometry ? Array.from(surface.geometry.getAttribute("color")?.array ?? []) : [],
        rangeMinimum: field?.userData.colorRange?.minimum ?? 0, rangeMaximum: field?.userData.colorRange?.maximum ?? 0,
        shaderMinimum: currentMaterial?.uniforms.fmAntennaMinimum.value ?? 0, shaderMaximum: currentMaterial?.uniforms.fmAntennaMaximum.value ?? 0,
        vectorScale: field?.userData.surfaceVectorScale ?? 1,
        currentVertices: geometry instanceof BufferGeometry ? geometry.getAttribute("fmAntennaCurrentVector")?.count ?? 0 : 0,
        currentMaterial: currentMaterial?.name ?? "", currentComponent: currentMaterial?.uniforms.fmAntennaComponent.value ?? -1,
        paletteTextures: tracker.getSnapshot().textures, minimum: field?.userData.minimum ?? 0, maximum: field?.userData.maximum ?? 0,
        surfaceUuid: surface && "geometry" in surface && surface.geometry instanceof BufferGeometry ? surface.geometry.uuid : "",
        wireUuid: wireframe && "geometry" in wireframe && wireframe.geometry instanceof BufferGeometry ? wireframe.geometry.uuid : "",
        pointsUuid: points && "geometry" in points && points.geometry instanceof BufferGeometry ? points.geometry.uuid : "",
        materialUuid: currentMaterial?.uuid ?? "", paletteUuid: currentMaterial?.uniforms.fmAntennaPalette.value.uuid ?? "" };
    };
    return () => { delete window.__antennaFieldCanvas; delete window.__antennaFieldPixel; };
  }, [gl, scene, camera, tracker]);
  return null;
}

function FieldViewport() {
  const model = useAntennaFieldOverlay();
  const section = useVisualizationStateResource();
  const positions = model?.wirePositions ?? model?.positions;
  const bounds = useMemo(() => {
    if (!positions?.length) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index++) { const axis = index % 3; min[axis] = Math.min(min[axis], positions[index]); max[axis] = Math.max(max[axis], positions[index]); }
    const size = max.map((value, axis) => value - min[axis]) as [number, number, number];
    return { center: min.map((value, axis) => value + size[axis] / 2) as [number, number, number], size, radius: Math.hypot(...size) / 2 };
  }, [positions]);
  const owner = useSessionResourceIdentity();
  const tracker = useMemo(() => new Viewport3DResourceTracker(), []);
  useEffect(() => () => tracker.disposeAll(), [tracker]);
  return <div style={{ height: 350, width: "100%" }} data-antenna-field-viewport>
    <Viewport3DCanvas camera={{ position: [0, 0, 1e-6], near: 1e-9, far: 1e-4 }} frameloop="demand">
      <VectorGlyphDerivedBufferCacheProvider tracker={tracker}>
        <color attach="background" args={["black"]} />
        <FieldCanvasProbe tracker={tracker} />
        {section.optimisticData?.clip.enabled ? <ClipPlaneLayer bounds={bounds} clip={section.optimisticData.clip} frameRotationDegrees={0} intersectionMarkers={null}
          colors={{ accent: "white", background: "black", field: "white", mesh: "white", wire: "white" }} tracker={tracker} /> : null}
        <AntennaFieldLayer model={model} colors={{ accent: "white", background: "black", field: "white", mesh: "white", wire: "white" }} tracker={tracker} sessionIdentity={owner} />
      </VectorGlyphDerivedBufferCacheProvider>
    </Viewport3DCanvas>
  </div>;
}

// FMVP v5 retains the complete quantity ID after the fixed 16-byte legacy prefix.
function previewFieldBuffer(quantityId: string, nComp: number, values: number[]) {
  const encoder = new TextEncoder(), quantity = encoder.encode(quantityId), domain = encoder.encode("preview-domain"), scopeKind = encoder.encode("full");
  const metadataLength = (88 + scopeKind.length + domain.length + quantity.length + 7) & ~7;
  const buffer = new ArrayBuffer(48 + metadataLength + values.length * 8), header = new DataView(buffer);
  new Uint8Array(buffer, 0, 4).set(encoder.encode("FMVP"));
  header.setUint8(4, 5); header.setUint8(5, 1); header.setUint8(6, nComp);
  header.setUint32(8, metadataLength, true); header.setUint32(12, values.length, true);
  header.setUint32(16, 2, true); header.setUint32(20, 1, true); header.setUint32(24, 1, true);
  new Uint8Array(buffer, 28, 16).set(quantity.subarray(0, 16));
  const metadata = new DataView(buffer, 48, metadataLength);
  new Uint8Array(buffer, 48, 4).set(encoder.encode("FMMI"));
  metadata.setUint16(4, 4, true); metadata.setUint16(8, domain.length, true);
  metadata.setUint16(64, scopeKind.length, true); metadata.setUint16(80, quantity.length, true);
  let offset = 48 + 88;
  for (const bytes of [scopeKind, domain, quantity]) { new Uint8Array(buffer, offset, bytes.length).set(bytes); offset += bytes.length; }
  new Float64Array(buffer, 48 + metadataLength).set(values);
  return buffer;
}

function TensorSampleTableFixture() {
  const samples = buildFieldVectorDebugSamples({ nComp: 9, pointCount: 2, nodeIndices: new Uint32Array([7, 19]), values: Float64Array.from([1, -2, 3, -4, 5, -6, 7, -8, 9, -10, 11, -12, 13, -14, 15, -16, 17, -18]) }).samples;
  const model = { viewports: [{ carriers: [{ carrierId: "tensor-fixture", observations: [{ query: { quantityId: "spin_current_tensor", component: "full" }, backendMeta: { unit: "fixture-unit" }, carrier: { samples } }] }] }] } as unknown as VisualizationDebugPanelModel;
  return <section aria-label="Synthetic tensor table fixture"><h2>Tensor sample table · controlled data</h2><VisualizationDebugSampleTable model={model} /></section>;
}

function MountedFixture() {
  const fixture = useMemo(() => makeFixture(), []);
  useEffect(() => { window.__antennaVisualizationFixture = fixture.control; fixture.kernel.visualizationSync.start(); return () => { fixture.kernel.visualizationSync.stop(); delete window.__antennaVisualizationFixture; }; }, [fixture]);
  const legacy = new URL(window.location.href).searchParams.has("legacy");
  const kind = legacy ? "object.visualization" : "object.antenna.visualization";
  const Panel = resolveInspectorRoute(kind)!.component;
  const tensorTable = new URL(window.location.href).searchParams.get("scenario") === "tensor-table";
  const dataPreview = new URL(window.location.href).searchParams.get("scenario") === "tensor-data-preview";
  return <KernelContext.Provider value={fixture.kernel}><FieldViewport /><Panel selection={{ ...EMPTY_SELECTION, kind, objectId: "antenna", ref: { type: "scene-object", kind, nodeId: "model:object:antenna:visualization", objectId: "antenna", visualizationTargetId: "object:antenna" } }} />{tensorTable ? <TensorSampleTableFixture /> : null}{dataPreview ? <DataPreviewDialog open={true} onOpenChange={() => {}} /> : null}</KernelContext.Provider>;
}

export default function AntennaVisualizationFixturePage() {
  const mounted = useSyncExternalStore(subscribe, client, server);
  return <main style={{ padding: 24, maxWidth: 600 }}><h1>Antenna visualization regression</h1><p>Production Explorer, Inspector routes and binary resource hooks. Controlled responses; not solver qualification.</p>{mounted ? <MountedFixture /> : <p>Loading fixture…</p>}</main>;
}
