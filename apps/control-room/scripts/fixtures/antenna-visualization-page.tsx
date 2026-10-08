"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { DATA_ANTENNA_FIELD_SOLUTION_PATH, DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH, DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH, MODEL_SCENE_PATH, SESSIONS_PATH, SESSION_STATUS_PATH } from "@/kernel/api/apiPaths";
import type { AntennaFieldSolutionResource, SceneResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { antennaFieldPayloadEtag } from "@/kernel/resources/antennaResources";
import type { KernelApi } from "@/kernel/types";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import { buildObjectExplorerNode } from "@/modules/explorer/builders/objectExplorerNodes";
import { resolveInspectorRoute } from "@/modules/inspector/inspectorRouteCatalog";

const instance = "55555555-5555-4555-8555-555555555555";
const owner = { session_id: "antenna-viz-fixture", session_epoch: "antenna-viz-fixture@1", request_scope_epoch: `${instance}:1` };
const digest = `sha256:${"a".repeat(64)}`;
const subscribe = () => () => {};
const client = () => true;
const server = () => false;
type Call = { path: string; range: string | null; scope: string | null };
declare global { interface Window { __antennaVisualizationFixture?: { read(): { calls: Call[]; tree: unknown; unexpected: string[] } }; } }

function makeFixture() {
  const scenario = new URL(window.location.href).searchParams.get("scenario") ?? "ready";
  const scene = {
    revision: 1, objects: [{ id: "antenna", name: "Antenna", role: "antenna" }],
    antenna_field_solve_stages: scenario === "empty" ? [] : [{ id: "solve", source_object_id: "antenna", current_transport_id: "transport", port_mode_ids: ["port"], model: "quasistatic_conduction_biot_savart3d", oersted_realization: "direct_tetra_quadrature", conductor_mesh_policy: "inherit_source", solver_policy: "default", field_sampling_domain: { kind: "global" }, target_refs: [{ kind: "global" }], outputs: [{ id: "solution", quantity: "H_ant_basis" }] }],
    antenna_port_modes: [{ id: "port", schema_version: "antenna_port_mode.v2", source_object_id: "antenna", current_transport_id: "transport", normalization_current_a: 1, branches: [{ id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out", signed_weight: 1 }, { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out", signed_weight: -1 }] }],
    // Synthetic fixture-only contract; never submitted to a solver.
    current_transports: [{ name: "transport", conservative_current_view: { stable_vertex_ids: [1], boundary_faces: [{}], identity: {}, pins: {}, closure: {} } }],
  } as unknown as SceneResource;
  const ref = (layout: string, unit: string, value_count: number) => ({ layout, unit, value_count, scalar_type: "float64_le", sha256: digest, path: "fixture-only" });
  const solution: AntennaFieldSolutionResource = {
    ...owner, solution_id: "solution", stage_id: "solve", status: "ready", quantity: "H_ant_basis", asset_id: "fixture-asset", content_digest: digest,
    source_object_id: scenario === "foreign" ? "foreign-antenna" : "antenna", current_transport_id: "transport", geometry_revision: "historical-geometry", material_revision: "historical-material", mesh_digest: "historical-mesh",
    schema_version: "fixture-only", resource_id: "fixture-only", assumptions: ["Synthetic UI fixture; not a solver result"], component: "vector_basis", gauge_policy: "fixture-only", requested_execution: {}, resolved_execution: {}, solver_policy: {}, signatures: { current_solution_signature: "fixture-current", field_solution_signature: "fixture-field", target_projection_signatures: {} },
    conductor_positions: ref("node_xyz_interleaved", "m", 30), sample_positions: ref("sample_xyz_interleaved", "m", 30),
    sample_carrier: { domain: { kind: "global" }, carrier_kind: "mesh_nodes", location: "node", topology_digest: "field-topology" },
    bases: [{ port_mode_id: "port", normalization_current_a: 1, measured_positive_terminal_current_a: 1, normalization_scale: 1, current_balance_certificate_digest: "fixture-only", quadrature_diagnostics: {}, electric_potential_per_ampere: ref("node_scalar", "V/A", 10), current_density_per_ampere: ref("sample_xyz_interleaved", "A/m^2/A", 30), magnetic_field_per_ampere: ref(scenario === "malformed" ? "wrong_layout" : "sample_xyz_interleaved", "A/m/A", 30) }],
  };
  const tree = buildObjectExplorerNode({ id: "antenna", label: "Antenna", objectRole: "antenna" }, { scene });
  const calls: Call[] = [], unexpected: string[] = [];
  const bus = new EventBus<KernelEventMap>(), resources = new ResourceInvalidationController(bus), diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const headers = { "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": instance };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { ...headers, "content-type": "application/json" } });
  const path = (template: string, key: string, value: string) => template.replace(`{${key}}`, value);
  const metadataPath = path(DATA_ANTENNA_FIELD_SOLUTION_PATH, "solution_id", "solution");
  const catalogPath = path(DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH, "stage_id", "solve");
  const payloadPrefix = path(DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH, "solution_id", "solution").split("{payload_kind}")[0];
  const api = new ControlRoomApi({ baseUrl: "http://antenna-visualization.fixture.invalid", expectedApiInstance: instance, diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    calls.push({ path: url.pathname, range: request.headers.get("range"), scope: request.headers.get("x-fullmag-session-scope") });
    if (calls.length > 80 || request.method !== "GET") throw new Error("Fixture budget/method violation");
    if (url.pathname === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: owner.session_id, name: "Fixture", current: true, status: "idle" }] });
    if (url.pathname === SESSION_STATUS_PATH) return json({ session: { ...owner, name: "Fixture", created_at: "fixture", workspace_root: "fixture" }, resources: { scene_revision: 1 }, capabilities: {}, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
    if (url.pathname === MODEL_SCENE_PATH) return json(scene);
    if (url.pathname === metadataPath) return json(solution);
    if (url.pathname === catalogPath) return json({ ...owner, stage_id: "solve", status: "ready", outputs: [{ output_id: "solution", solution_ref: { asset_id: solution.asset_id, content_digest: digest, stage_id: "solve" } }] });
    if (url.pathname.startsWith(payloadPrefix)) {
      const kind = url.pathname.slice(payloadPrefix.length) as Parameters<typeof antennaFieldPayloadEtag>[1];
      const port = url.searchParams.get("port_mode_id") ?? undefined;
      const range = request.headers.get("range")?.match(/^bytes=0-(\d+)$/);
      if (!range) throw new Error("Unbounded fixture payload request");
      const bytes = Number(range[1]) + 1, data = new ArrayBuffer(bytes), view = new DataView(data);
      for (let index = 0; index < bytes / 8; index += 1) view.setFloat64(index * 8, index + 0.25, true);
      return new Response(data, { status: 206, headers: { ...headers, "content-type": "application/octet-stream", etag: antennaFieldPayloadEtag(solution, kind, port), "content-range": `bytes 0-${bytes - 1}/${kind === "electric_potential_per_ampere" ? 80 : 240}`, "x-fullmag-scalar-type": "float64_le" } });
    }
    unexpected.push(url.pathname); throw new Error(`Unexpected fixture request: ${url.pathname}`);
  } });
  return { kernel: { api, bus, resources, diagnostics, diagnosticRecorder } as unknown as KernelApi, control: { read: () => ({ calls, tree, unexpected }) } };
}

function MountedFixture() {
  const fixture = useMemo(() => makeFixture(), []);
  useEffect(() => { window.__antennaVisualizationFixture = fixture.control; return () => { delete window.__antennaVisualizationFixture; }; }, [fixture]);
  const legacy = new URL(window.location.href).searchParams.has("legacy");
  const kind = legacy ? "object.visualization" : "object.antenna.visualization";
  const Panel = resolveInspectorRoute(kind)!.component;
  return <KernelContext.Provider value={fixture.kernel}><Panel selection={{ ...EMPTY_SELECTION, kind, objectId: "antenna", ref: { type: "scene-object", kind, nodeId: "model:object:antenna:visualization", objectId: "antenna", visualizationTargetId: "object:antenna" } }} /></KernelContext.Provider>;
}

export default function AntennaVisualizationFixturePage() {
  const mounted = useSyncExternalStore(subscribe, client, server);
  return <main style={{ padding: 24, maxWidth: 600 }}><h1>Antenna visualization regression</h1><p>Production Explorer, Inspector routes and binary resource hooks. Controlled responses; not solver qualification.</p>{mounted ? <MountedFixture /> : <p>Loading fixture…</p>}</main>;
}
