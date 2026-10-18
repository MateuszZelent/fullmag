"use client";

import { Profiler, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AntennaVisualizationPanel } from "@/modules/inspector/panels/antenna/AntennaVisualizationPanel";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import { VisualizationRegistrySyncController } from "@/kernel/visualization/VisualizationRegistrySyncController";
import { CameraRegistryController, DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import { VISUALIZATION_TARGET_COMMANDS } from "@/kernel/visualization/visualizationCommandContributions";
import { useThree } from "@react-three/fiber";
import { BufferGeometry, InstancedMesh, LineBasicMaterial, Mesh, MeshBasicMaterial, PointsMaterial, ShaderMaterial, Vector2 } from "three";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { DATA_DOMAIN_TOPOLOGY_PATH, DATA_FIELD_META_PATH, DATA_FIELD_VECTOR_PATH, DATA_FIELDS_PATH, DATA_QUANTITIES_PATH, DATA_FIELD_AVAILABILITY_PATH, MODEL_SCENE_PATH, VISUALIZATION_STATE_PATH, SESSION_STATUS_PATH, SESSIONS_PATH, SIMULATION_STAGES_EXECUTION_PATH } from "@/kernel/api/apiPaths";
import type { QuantityCatalogResource, VisualizationStateResource, VisualizationStatePatch, SceneResource } from "@/kernel/api/apiTypes";
import { decodeTopologyHeader, topologyByteLayout } from "@/kernel/api/codecs/topologyCodec";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { ObjectVisualizationController, resolveGlobalObjectVisualizationSettings, resolveTargetVisualization, mergeVisualizationStateTargetOverride, visualizationTargetKey, type VisualizationTargetPatch } from "@/kernel/visualization/ObjectVisualizationController";
import { artifactInspectorFieldBinding } from "@/kernel/visualization/artifactFieldSelection";
import { useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import { VisualizationSurfaceColoringSection, VisualizationVectorsSection } from "@/modules/inspector/panels/ObjectVisualizationTargetSection";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { buildViewport3DFieldRenderModel, type Viewport3DTopologyRenderModel, type Viewport3DFieldVector } from "@/modules/viewport-3d/viewport3dRenderModel";
import { hasViewport3DQuantityData } from "@/modules/viewport-3d/model/viewport3DQuantityData";
import { Viewport3DFieldLabel } from "@/modules/viewport-3d/Viewport3DFieldLabel";
import { useArtifactFieldOverlay } from "@/modules/viewport-3d/hooks/useArtifactFieldOverlay";
import { artifactRenderedSurfaceRanges } from "@/modules/viewport-3d/model/artifactFieldOverlayModel";
import { viewport3dStore } from "@/modules/viewport-3d/viewport3dStore";
import { resolveArtifactFieldColorbars, Viewport3DColorbar } from "@/modules/viewport-3d/Viewport3DModule";
import { ArtifactFieldLayer } from "@/modules/viewport-3d/layers/ArtifactFieldLayer";
import { VectorGlyphDerivedBufferCacheProvider } from "@/modules/viewport-3d/layers/vectorGlyphDerivedBufferRuntime";
import { Viewport3DCanvas } from "@/modules/viewport-3d/Viewport3DCanvas";
import { Viewport3DResourceTracker } from "@/modules/viewport-3d/viewport3dDiagnostics";
import { createViewport3DRenderAdoptionRegistry } from "@/modules/viewport-3d/model/viewport3DRenderAdoptionRegistry";

const hudTopology: Viewport3DTopologyRenderModel = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), nodeCount: 4,
  fallbackSurfaceIndices: new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]),
  fallbackSurfaceNodeIndices: new Uint32Array([0, 1, 2, 3]), fallbackSurfaceEdgeIndices: null,
  fallbackVolumeEdgeIndices: new Uint32Array(), magneticParts: [], airboxParts: [],
  meshGenerationId: null, meshRevision: null, meshTopologyHash: null,
};
const hudVector: Viewport3DFieldVector = {
  dtype: "float64", grid: [4, 1, 1], nComp: 3, pointCount: 4, quantityId: "m", valueCount: 12,
  values: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]),
};
const hudVectorsOnlyModel = buildViewport3DFieldRenderModel(hudTopology, hudVector, .1, { scalarColorsVisible: false });
const hudIntentOnlyModel = buildViewport3DFieldRenderModel(hudTopology, hudVector, .1, { scalarColorsVisible: false, analysisFieldIntentActive: true, analysisOverlayActive: true });

const instance = "66666666-6666-4666-8666-666666666666";
const owner = { session_id: "artifact-overlay-fixture", session_epoch: "artifact-overlay-fixture@1", request_scope_epoch: `${instance}:1` };
const identity = { sessionId: owner.session_id, sessionEpoch: owner.session_epoch, requestScopeEpoch: owner.request_scope_epoch };
const runId = "run-artifact-overlay", runtimeStageId = "execution-inspect", authoredStageId = "inspect";
const secondStageId = "execution-inspect-second";
const definitions = [{ id: authoredStageId, source_object_id: "antenna" }, { id: "inspect-second", source_object_id: "antenna" }];
const sourceDigest = `sha256:${"d".repeat(64)}`, contentDigest = `sha256:${"e".repeat(64)}`;
const physical = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];
const local = [0, 1, 2, 3, 0, 2, 1, 4];
const stable = physical.map((_, i) => BigInt("9007199254740993") + BigInt(i));
const subscribe = () => () => {};
const fixtureTarget = { id: "antenna", kind: "object" as const };
type Quantity = "H_ant" | "J_charge" | "V_electric";
const inspectorSelection: Selection = { kind: "object.antenna.visualization", objectId: "antenna", nodeId: "model:object:antenna:visualization", label: "Fixture antenna", moduleSource: "fixture", ref: { type: "scene-object", kind: "object.antenna.visualization", objectId: "antenna", nodeId: "model:object:antenna:visualization", visualizationTargetId: "object:antenna", objectRole: "antenna" } };
declare global { interface Window { __artifactDedicatedFixture?: { holdWrites(): void; releaseWrites(): void; enableSecondExecution(): void; setCatalogMode(mode: "valid" | "wrong-stage" | "wrong-run"): void; read(): { pending: boolean; pendingWrites: number; writes: number; renders: number; revision: number; legacyIntent: unknown } }; } }
type FixtureRead = { quantity: Quantity; unit: string | null; model: boolean; count: number; triangles: number; minimum: number | null; maximum: number | null; values: number[]; glyphCount: number; pointCount: number; availableGlyphCount: number; surfaceOffsetDistance: number; scope: string; calls: { path: string; binary: boolean; carrier: string | null; component: string | null; stage: string | null; revision: string | null }[]; unexpected: string[]; historical: boolean; error: string | null; resources: ReturnType<Viewport3DResourceTracker["getSnapshot"]> };
declare global { interface Window { __artifactOverlayFixture?: { read(): FixtureRead; replaceSurfaceRangeOwner(mode: "foreign" | "live" | "restore"): void }; __artifactOverlayCanvas?: () => { lost: boolean; width: number; height: number; groups: number; surfaceTriangles: number; geometryIds: string[]; materialIds: string[]; paletteIds: string[]; surfaceOpacity: number; paletteName: string; surfacePresentation: Array<{ mode: string; color: string }>; surfaceVertexCounts: number[]; scalarSurface: { normalized: number[]; opacity: number; paletteId: number; materialId: string } | null; auxiliaryMaterials: Array<{ id: string; version: number; opacity: number; transparent: boolean }>; frame: number; pointCounts: number[]; pointBufferIds: string[]; glyphCounts: number[]; glyphMatrices: number[][]; glyphColors: number[][]; glyphInstances: number }; } }

function carrier(q: Quantity, stage = runtimeStageId) {
  const digest = (stage === secondStageId ? q === "V_electric" ? "1" : q === "H_ant" ? "2" : "3" : q === "V_electric" ? "a" : q === "H_ant" ? "b" : "c").repeat(64);
  const hash = Uint8Array.from(digest.match(/../g)!, pair => parseInt(pair, 16));
  const revision = new DataView(hash.buffer).getBigUint64(0, true).toString();
  const indexing = q === "V_electric" ? "source_nodes" : q === "H_ant" ? "sample_nodes" : "tet4_cell_local_nodes";
  return { carrier_id: `artifact:${digest}:${indexing}`, carrier_digest: digest, carrier_revision: revision,
    carrier_scope_kind: "object", carrier_scope_id: "antenna", indexing, sample_count: q === "J_charge" ? 8 : q === "H_ant" ? 5 : 4,
    coordinate_frame: "world", coordinate_unit: "m", topology_binary_schema: "FMMT.v2",
    owner: { ...owner, run_id: runId, runtime_stage_id: stage, authored_stage_id: stage === secondStageId ? "inspect-second" : authoredStageId,
      module_id: "transport", object_id: "antenna", output_id: "inspection", source_digest: sourceDigest,
      content_digest: stage === secondStageId ? `sha256:${"f".repeat(64)}` : contentDigest, native_mesh_identity: "source-mesh", native_topology_identity: "source-topology", historical_inspection: true } };
}
function values(q: Quantity) { return q === "V_electric" ? [-2, 0, 1, 4] : q === "H_ant" ? [1, 0, 0, 0, 2, 0, 0, 0, 3, -4, 0, 0, 0, 0, 2] : [1, 0, 0, 0, 2, 0, 0, 0, 3, -4, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30, -40, 0, 0]; }
function positions(q: Quantity) { return q === "H_ant" ? [...physical.slice(0, 4).flat(), .2, .2, .2] : (q === "J_charge" ? local : [0, 1, 2, 3]).flatMap(i => physical[i]); }
function executionValues(q: Quantity, stage: string) { return values(q).map(value => stage === secondStageId ? value * 7 : value); }
function capability(q: Quantity, live = false, stage = runtimeStageId) {
  const c = carrier(q, stage);
  return { quantity_id: q, lane: live ? "fdm_cpu" : "artifact_inspection_read_only", provider: "available", request: "field_vector", render: "renderable", publication: "interactive", materialization: "materialized", reason_code: "historical_inspection_read_only",
    carriers: [{ carrier_id: c.carrier_id, carrier_fingerprint: c.carrier_digest, scope_kind: "object", scope_id: "antenna", payload_state: live ? "current" : "historical", payload_version: "FMVP.v6", components: q === "V_electric" ? 1 : 3, indexing: c.indexing }] };
}
function catalog(live: boolean, stage = runtimeStageId): QuantityCatalogResource {
  return { schema_version: "fixture", quantities: (["H_ant", "J_charge", "V_electric"] as const).map(q => ({ id: q, label: q, unit: q === "V_electric" ? "V" : q === "H_ant" ? "A/m" : "A/m^2", n_comp: q === "V_electric" ? 1 : 3, resolved_capability: capability(q, live, stage) })) } as unknown as QuantityCatalogResource;
}
function vectorBytes(q: Quantity, stage = runtimeStageId) {
  const c = carrier(q, stage), code = q === "V_electric" ? 4 : q === "H_ant" ? 5 : 7, stride = code === 7 ? 24 : 8;
  const strings = ["object", "antenna", c.carrier_digest, "artifact_inspection", sourceDigest, c.owner.content_digest].map(s => new TextEncoder().encode(s));
  const metadataLength = Math.ceil((88 + strings.reduce((n, s) => n + s.length, 0) + c.sample_count * stride) / 8) * 8;
  const buffer = new ArrayBuffer(48 + metadataLength + c.sample_count * (q === "V_electric" ? 8 : 24)), view = new DataView(buffer);
  const put = (offset: number, s: string) => new Uint8Array(buffer, offset, s.length).set(new TextEncoder().encode(s));
  put(0, "FMVP"); view.setUint8(4, 6); view.setUint8(5, 1); view.setUint8(6, q === "V_electric" ? 1 : 3);
  view.setUint32(8, metadataLength, true); view.setUint32(12, c.sample_count * (q === "V_electric" ? 1 : 3), true); view.setUint32(16, c.sample_count, true); view.setUint32(20, 1, true); view.setUint32(24, 1, true); put(28, q);
  const start = 48; put(start, "FMMI"); view.setUint16(start + 4, 4, true); view.setBigUint64(start + 16, BigInt(c.carrier_revision), true);
  new Uint8Array(buffer, start + 24, 32).set(Uint8Array.from(c.carrier_digest.match(/../g)!, pair => parseInt(pair, 16)));
  view.setUint32(start + 56, code, true); view.setUint32(start + 60, c.sample_count, true); view.setBigUint64(start + 68, BigInt(1), true); view.setUint32(start + 76, stride, true); view.setUint32(start + 80, code, true);
  let offset = start + 88;
  [64, 66, 8, 10, 12, 14].forEach((at, i) => { view.setUint16(start + at, strings[i].length, true); new Uint8Array(buffer, offset, strings[i].length).set(strings[i]); offset += strings[i].length; });
  for (let i = 0; i < c.sample_count; i++) {
    const at = offset + i * stride;
    view.setBigUint64(at, code === 4 ? stable[i] : code === 5 ? BigInt(i) : BigInt(100 + Math.floor(i / 4)), true);
    if (code === 7) { view.setUint8(at + 8, i % 4); view.setBigUint64(at + 16, stable[local[i]], true); }
  }
  executionValues(q, stage).forEach((v, i) => view.setFloat64(48 + metadataLength + i * 8, v, true));
  return buffer;
}
function topologyBytes(q: Quantity, stage = runtimeStageId) {
  const n = carrier(q, stage).sample_count, cells = q === "J_charge" ? 2 : q === "H_ant" ? 4 : 1;
  const header = new ArrayBuffer(64), view = new DataView(header);
  new Uint8Array(header, 0, 4).set(new TextEncoder().encode("FMMT")); view.setUint8(4, 2); view.setUint8(5, 1);
  view.setUint32(8, n, true); view.setUint32(12, cells, true); view.setUint32(20, cells * 4, true); view.setUint32(36, 64, true);
  const layout = topologyByteLayout(decodeTopologyHeader(header)), buffer = new ArrayBuffer(layout.expectedByteLength);
  new Uint8Array(buffer, 0, 64).set(new Uint8Array(header));
  const data = new DataView(buffer);
  positions(q).forEach((v, i) => data.setFloat64(layout.positions.start + i * 8, v, true));
  for (let i = 0; i < cells; i++) data.setUint32(layout.cellTypes!.start + i * 4, 1, true);
  for (let i = 0; i <= cells; i++) data.setUint32(layout.cellOffsets!.start + i * 4, i * 4, true);
  const cellNodes = q === "H_ant" ? [0, 1, 2, 4, 0, 1, 4, 3, 0, 4, 2, 3, 4, 1, 2, 3] : Array.from({ length: cells * 4 }, (_, i) => i);
  cellNodes.forEach((value, i) => data.setUint32(layout.cellNodes.start + i * 4, value, true));
  return buffer;
}
function makeFixture() {
  const calls: FixtureRead["calls"] = [], unexpected: string[] = [];
  const bus = new EventBus<KernelEventMap>(), resources = new ResourceInvalidationController(bus), diagnostics = new RequestDiagnosticsController(), visualization = new ObjectVisualizationController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const visualizationDebug = new VisualizationDebugController();
  const scope = () => sessionRequestScopeKey(identity);
  const pendingWrites: (() => void)[] = [];
  const fullState = { hold: false, writes: 0, renders: 0 };
  let secondExecution = false;
  let liveCatalog = false, catalogMode: "valid" | "wrong-stage" | "wrong-run" = "valid", catalogRevision = 1;
  const invalidateCatalogs = () => { for (const path of [DATA_FIELDS_PATH, DATA_QUANTITIES_PATH]) resources.invalidate(`${path}?stage_id=${runtimeStageId}:run=${encodeURIComponent(runId)}`, ++catalogRevision); };
  const scene = { revision: 1, scene_revision: 1, scene: { id: "artifact-fixture", name: "Artifact fixture", authoring_schema: "fixture", source_of_truth: "fixture" }, objects: [{ id: "antenna", name: "Fixture antenna", role: "antenna", geometry: { kind: "Box", size: [1, 1, 1], center: [0, 0, 0] } }], antenna_field_solve_stages: definitions } as unknown as SceneResource;
  let remote = { revision: 1, overrides: mergeVisualizationStateTargetOverride([], fixtureTarget, { visible: true, activeQuantityId: "H_ant", shaderVisible: true, pointsVisible: true, wireframeVisible: true, vectorsVisible: false, surfaceColorSource: "component_x", surfaceProjectionMode: "raw_nodal", viewportColorbarVisible: true, vectorBudget: 100, shaderMonoColor: "#12ab34" }), camera: DEFAULT_CAMERA_REGISTRY_STATE, layers: { airbox: { visible: false, surface: { visible: false, opacity: .2 }, wireframe: { visible: false }, points: { visible: false }, vectors: { visible: false } } } } as unknown as VisualizationStateResource;
  let rangeMode: "valid" | "foreign" | "malformed" = "valid", rangeRevision = 1;
  const common = { "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": instance };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { ...common, "content-type": "application/json" } });
  const api = new ControlRoomApi({ baseUrl: "http://artifact-overlay.fixture.invalid", expectedApiInstance: instance, diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), binary = url.pathname.includes("/samples/vector") || url.pathname === DATA_DOMAIN_TOPOLOGY_PATH;
    calls.push({ path: url.pathname, binary, carrier: url.searchParams.get("carrier_id"), component: url.searchParams.get("component"), stage: url.searchParams.get("stage_id"), revision: url.searchParams.get("expected_carrier_revision") });
    if (calls.length > 220) throw new Error("Fixture request budget exceeded");
    if (url.pathname === VISUALIZATION_STATE_PATH && request.method === "PATCH") {
      if (request.headers.get("x-fullmag-session-scope") !== scope()) throw new Error("Unconfirmed visualization mutation");
      const patch = await request.json() as VisualizationStatePatch;
      if (Object.keys(patch).some(key => key !== "overrides")) throw new Error("Unexpected dedicated Inspector patch");
      fullState.writes++;
      if (fullState.hold) await new Promise<void>(resolve => pendingWrites.push(resolve));
      remote = { ...remote, ...(patch.overrides ? { overrides: patch.overrides } : {}), revision: remote.revision + 1 };
      return json(remote);
    }
    if (request.method !== "GET") { unexpected.push(`${request.method} ${url.pathname}`); throw new Error("Unexpected fixture mutation"); }
    if (url.pathname === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: owner.session_id, name: "Fixture", current: true, status: "idle" }] });
    if (url.pathname === SESSION_STATUS_PATH) return json({ session: { ...owner, name: "Fixture", created_at: "fixture", workspace_root: "fixture" }, run: { run_id: runId }, resources: { scene_revision: 1 }, capabilities: {}, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
    if (url.pathname === SIMULATION_STAGES_EXECUTION_PATH) {
      const stages = [{ stage_id: runtimeStageId, antenna_solve_stage_id: authoredStageId, status: "completed", stage_index: 0 }, ...(secondExecution ? [{ stage_id: secondStageId, antenna_solve_stage_id: "inspect-second", status: "completed", stage_index: 1 }] : [])];
      return json({ ...owner, run_id: runId, revision: secondExecution ? 2 : 1, runtime_state: "completed", total_stages: stages.length, stage_statuses: stages.map(() => "completed"), completed_stage_indexes: stages.map((_, index) => index), stages });
    }
    const q: Quantity = url.pathname.includes("V_electric") || url.searchParams.get("carrier_id")?.includes(":source_nodes") ? "V_electric" : url.pathname.includes("J_charge") || url.searchParams.get("carrier_id")?.includes(":tet4_cell_local_nodes") ? "J_charge" : "H_ant";
    const executionStage = url.searchParams.get("stage_id") ?? runtimeStageId;
    if (executionStage !== runtimeStageId && !(secondExecution && executionStage === secondStageId)) throw new Error("Unknown execution stage");
    const c = carrier(q, executionStage), scoped = request.headers.get("x-fullmag-session-scope");
    if (scoped !== sessionRequestScopeKey(identity)) throw new Error("Unconfirmed fixture session scope");
    if (url.pathname === VISUALIZATION_STATE_PATH) return json(remote);
    if (url.pathname === MODEL_SCENE_PATH) return json(scene);
    if (url.pathname === DATA_QUANTITIES_PATH) {
      const stage = url.searchParams.get("stage_id");
      if (stage !== null && stage !== runtimeStageId && !(secondExecution && stage === secondStageId)) throw new Error("Unknown scoped quantity catalog execution");
      return json(catalog(stage === null || liveCatalog, executionStage));
    }
    if (url.pathname === DATA_FIELDS_PATH) {
      const stage = url.searchParams.get("stage_id");
      if (stage !== null && stage !== runtimeStageId && !(secondExecution && stage === secondStageId)) throw new Error("Unknown scoped field catalog execution");
      const historical = stage !== null && !liveCatalog;
      return json({ domain_generation_id: "fixture", quantities: (["H_ant", "J_charge", "V_electric"] as const).map(quantity => ({ quantity_id: quantity, label: quantity, unit: quantity === "V_electric" ? "V" : quantity === "H_ant" ? "A/m" : "A/m^2", components: quantity === "V_electric" ? 1 : 3, ui_exposed: true, spatial: true, kind: quantity === "V_electric" ? "scalar" : "vector", domain: "spatial", available: true, state: "stale_complete", location: carrier(quantity, executionStage).indexing, artifact_field_locator: historical ? { ...carrier(quantity, executionStage), owner: { ...carrier(quantity, executionStage).owner, runtime_stage_id: catalogMode === "wrong-stage" ? "execution-foreign" : executionStage, run_id: catalogMode === "wrong-run" ? "run-foreign" : runId } } : undefined, resolved_capability: capability(quantity, !historical, executionStage), field_revision: 1, domain_generation_id: carrier(quantity, executionStage).carrier_digest })) });
    }
    if (url.pathname === DATA_FIELD_AVAILABILITY_PATH.replace("{quantity_id}", q)) {
      if (url.searchParams.get("carrier_id") !== c.carrier_id || url.searchParams.get("stage_id") !== executionStage || url.searchParams.get("expected_carrier_revision") !== c.carrier_revision) throw new Error("Unpinned dedicated Inspector availability");
      return json({ quantity_id: q, target_id: "antenna", scope_kind: "object", scope_id: "antenna", supported: true, materialized: true, pending: false, state: "stale", carrier_id: c.carrier_id, generation: c.carrier_digest, revision: 1, reason_code: "historical_inspection_read_only" });
    }
    const metaPath = DATA_FIELD_META_PATH.replace("{quantity_id}", q), vectorPath = DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", q);
    if (url.pathname === metaPath) {
      const pin = url.searchParams.get("carrier_id"); if (pin && pin !== c.carrier_id) throw new Error("Stale carrier leaked across quantities");
      const component = url.searchParams.get("component");
      const isRange = component !== "full";
      if (isRange && (pin !== c.carrier_id || url.searchParams.get("stage_id") !== executionStage || url.searchParams.get("expected_carrier_revision") !== c.carrier_revision)) throw new Error("Inspector range request has no exact result pins");
      const samples = executionValues(q, executionStage), projected = q === "V_electric" ? samples : component === "magnitude" ? Array.from({ length: c.sample_count }, (_, i) => Math.hypot(...samples.slice(i * 3, i * 3 + 3))) : samples.filter((_, i) => i % 3 === (component === "y" ? 1 : component === "z" ? 2 : 0));
      const locator = isRange && rangeMode === "malformed" ? {} : isRange && rangeMode === "foreign" ? { ...c, owner: { ...c.owner, run_id: "foreign-run" } } : c;
      return json({ quantity_id: q, unit: q === "V_electric" ? "V" : q === "H_ant" ? "A/m" : "A/m^2", components: q === "V_electric" ? 1 : 3, state: "stale_complete", materialization_reason_code: "historical_inspection_read_only", resolved_capability: capability(q, false, executionStage), artifact_field_locator: locator, stats: { min: component === "magnitude" ? 0 : Math.min(...projected), max: Math.max(...projected) } });
    }
    if (url.pathname === vectorPath || url.pathname === DATA_DOMAIN_TOPOLOGY_PATH) {
      if (url.searchParams.get("carrier_id") !== c.carrier_id || url.searchParams.get("expected_carrier_revision") !== c.carrier_revision || url.searchParams.get("stage_id") !== executionStage) throw new Error("Unpinned artifact binary request");
      const headers = { ...common, "content-type": "application/octet-stream", etag: `"${executionStage}-${q}-${url.pathname === vectorPath ? "values" : "geometry"}"`,
        "x-fullmag-carrier-id": c.carrier_id, "x-fullmag-carrier-digest": c.carrier_digest, "x-fullmag-carrier-revision": c.carrier_revision,
        "x-fullmag-mesh-topology-hash": c.carrier_digest, "x-fullmag-coordinate-frame": "world", "x-fullmag-coordinate-unit": "m",
        "x-fullmag-component": "full", "x-fullmag-quantity-id": q, "x-fullmag-n-comp": q === "V_electric" ? "1" : "3", "x-fullmag-point-count": String(c.sample_count), "x-fullmag-value-count": String(c.sample_count * (q === "V_electric" ? 1 : 3)),
        "x-fullmag-source-kind": "artifact_inspection", "x-fullmag-source-id": sourceDigest, "x-fullmag-source-revision": "1", "x-fullmag-field-generation-id": c.owner.content_digest,
        "x-fullmag-domain-generation-id": c.carrier_digest, "x-fullmag-field-indexing": c.indexing, "x-fullmag-scope-kind": "object", "x-fullmag-scope-id": "antenna" };
      return new Response(url.pathname === vectorPath ? vectorBytes(q, executionStage) : topologyBytes(q, executionStage), { headers });
    }
    unexpected.push(url.pathname); throw new Error(`Unexpected artifact fixture request: ${url.pathname}`);
  } });
  const visualizationSync = new VisualizationRegistrySyncController({ api: api.visualization, resourceCacheScope: api.resourceCacheScope, resources });
  const commands = new CommandRegistry(); commands.attach(bus); commands.attachSessionScopeSource({ getScopeKey: scope, subscribe: () => () => {} });
  for (const command of VISUALIZATION_TARGET_COMMANDS) commands.register(command);
  const layout = new LayoutController(bus); layout.setActiveTab("geometry"); layout.setActiveViewportMainModule("viewport-3d");
  const selection = new SelectionController(bus); selection.set(inspectorSelection, "inspector");
  const cameraRegistry = new CameraRegistryController({ api: api.visualization, getSessionScopeKey: scope, idleFlushMs: null });
  return { kernel: { api, resources, bus, diagnostics, diagnosticRecorder, visualization, visualizationDebug, visualizationSync, commands, layout, selection, cameraRegistry, analysisFieldOverlay: new AnalysisFieldOverlayController(), authoringHistory: new AuthoringHistoryController(api, resources) } as unknown as KernelApi, calls, unexpected, visualization, recordRender: () => { fullState.renders++; },
    enterDedicated() { visualization.clearTarget(fixtureTarget); },
    setLiveCatalog(value: boolean) { liveCatalog = value; invalidateCatalogs(); },
    dedicated: { enableSecondExecution() { secondExecution = true; resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, 2); }, setCatalogMode(mode: typeof catalogMode) { catalogMode = mode; invalidateCatalogs(); }, holdWrites() { fullState.hold = true; }, releaseWrites() { fullState.hold = false; if (!pendingWrites.length) throw new Error("No pending dedicated Inspector PATCH"); for (const release of pendingWrites.splice(0)) release(); }, read: () => ({ pending: Boolean(visualizationSync.getSnapshot().pendingPatch || visualizationSync.getSnapshot().inflightPatch), pendingWrites: pendingWrites.length, writes: fullState.writes, renders: fullState.renders, revision: remote.revision, legacyIntent: visualization.getSnapshot().antennaFieldIntent }) },
    setRangeMode(mode: typeof rangeMode) { rangeMode = mode; resources.invalidateMatching(key => key.includes("/meta") && !key.includes("component=full"), ++rangeRevision); } };
}
function Probe() {
  const { gl, scene } = useThree();
  useEffect(() => {
    window.__artifactOverlayCanvas = () => {
      const size = gl.getDrawingBufferSize(new Vector2()), geometryIds: string[] = [], materialIds: string[] = [], paletteIds: string[] = [], glyphCounts: number[] = []; let groups = 0, surfaceTriangles = 0, glyphInstances = 0, surfaceOpacity = 1, paletteName = "";
      let scalarSurface: { normalized: number[]; opacity: number; paletteId: number; materialId: string } | null = null;
      const auxiliaryMaterials: Array<{ id: string; version: number; opacity: number; transparent: boolean }> = [];
      scene.traverse(object => { if ("material" in object && (object.material instanceof PointsMaterial || object.material instanceof LineBasicMaterial)) { const m = object.material; auxiliaryMaterials.push({ id: m.uuid, version: m.version, opacity: m.opacity, transparent: m.transparent }); } if (object.name.startsWith("artifact-historical-")) groups++; if (object instanceof InstancedMesh) { glyphInstances += object.count; glyphCounts.push(object.count); } if (object.type === "Mesh" && "geometry" in object && object.geometry instanceof BufferGeometry && (object.geometry.getAttribute("fmAntennaCurrentVector") || object.geometry.getAttribute("fmScalarValue"))) { surfaceTriangles += (object.geometry.index?.count ?? 0) / 3; geometryIds.push(object.geometry.uuid); const material = (object as unknown as { material: { uuid: string; uniforms: { fmAntennaOpacity: { value: number }; fmAntennaPalette: { value: { uuid: string; userData: { antennaPalette: string } } } } } }).material; materialIds.push(material.uuid); if (object.geometry.getAttribute("fmScalarValue")) { const m = (object as unknown as { material: { uuid: string; uniforms?: { fmOpacity: { value: number }; fmPaletteId: { value: number } } } }).material; if (m.uniforms) scalarSurface = { normalized: Array.from(object.geometry.getAttribute("fmScalarValue").array), opacity: m.uniforms.fmOpacity.value, paletteId: m.uniforms.fmPaletteId.value, materialId: m.uuid }; } if (object.geometry.getAttribute("fmAntennaCurrentVector")) { paletteIds.push(material.uniforms.fmAntennaPalette.value.uuid); surfaceOpacity = material.uniforms.fmAntennaOpacity.value; paletteName = material.uniforms.fmAntennaPalette.value.userData.antennaPalette; } } });
      const glyphMatrices: number[][] = [], glyphColors: number[][] = [];
      scene.traverse(object => { if (object instanceof InstancedMesh) { glyphMatrices.push(Array.from(object.instanceMatrix.array.slice(0, object.count * 16))); glyphColors.push(Array.from(object.instanceColor?.array.slice(0, object.count * 3) ?? [])); } });
      const surfaceVertexCounts: number[] = [];
      const surfacePresentation: Array<{ mode: string; color: string }> = [];
      const pointCounts: number[] = [], pointBufferIds: string[] = [];
      scene.traverse(object => { if (object.type === "Points" && "geometry" in object && object.geometry instanceof BufferGeometry) { pointCounts.push(object.geometry.drawRange.count); pointBufferIds.push(String(object.geometry.index?.id)); } });
      scene.traverse(object => {
        if (!(object instanceof Mesh) || (!object.geometry.getAttribute("fmAntennaCurrentVector") && !object.geometry.getAttribute("fmScalarValue"))) return;
        surfaceVertexCounts.push(object.geometry.getAttribute("position").count);
        const material = object.material;
        if (material instanceof MeshBasicMaterial) surfacePresentation.push({ mode: "solid", color: material.color.getHexString() });
        else if (material instanceof ShaderMaterial && material.uniforms.fmAntennaColorMode) surfacePresentation.push({ mode: material.uniforms.fmAntennaColorMode.value === 2 ? "solid" : "field", color: material.uniforms.fmAntennaMonoColor.value.getHexString() });
        else surfacePresentation.push({ mode: "field", color: "" });
      });
      return { lost: gl.getContext().isContextLost(), width: size.x, height: size.y, groups, surfaceTriangles, geometryIds, materialIds, paletteIds, surfaceOpacity, paletteName, surfacePresentation, surfaceVertexCounts, scalarSurface, auxiliaryMaterials, pointCounts, pointBufferIds, glyphInstances, glyphCounts, glyphMatrices, glyphColors, frame: gl.info.render.frame };
    };
    return () => { delete window.__artifactOverlayCanvas; };
  }, [gl, scene]);
  return null;
}
function View({ fixture, dedicated = false }: { fixture: ReturnType<typeof makeFixture>; dedicated?: boolean }) {
  const [fixtureQuantity, setQuantity] = useState<Quantity>("H_ant"), [live, setLive] = useState(false), [vectors, setVectors] = useState(false), [presentation, setPresentation] = useState(false), [solid, setSolid] = useState(false);
  const canonical = useVisualizationStateResource({ enabled: dedicated });
  const canonicalSnapshot = useObjectVisualizationSelector(snapshot => snapshot);
  const tracker = useMemo(() => new Viewport3DResourceTracker(), []), session = useSessionResourceIdentity();
  const adoptionRegistry = useMemo(() => createViewport3DRenderAdoptionRegistry(), []);
  adoptionRegistry.setSessionIdentity(session);
  const preferences = useObjectVisualizationSelector(snapshot => snapshot.overrides[visualizationTargetKey(fixtureTarget)]);
  const patch = async (value: VisualizationTargetPatch) => { fixture.visualization.patchTarget(fixtureTarget, value); };
  const sharedSettings = useMemo(() => ({ ...resolveGlobalObjectVisualizationSettings(null), visible: true, viewportColorbarVisible: true, geometryScope: "full" as const, shaderVisible: true, wireframeVisible: true, pointsVisible: true, vectorsVisible: vectors, activeQuantityId: fixtureQuantity, surfaceColorSource: solid ? "solid" as const : fixtureQuantity === "V_electric" ? "colormap" as const : "component_x" as const, scalarColorPalette: presentation ? "magma" : "viridis", surfaceOpacityPercent: presentation ? 45 : 100, pointOpacityPercent: presentation ? 45 : 100, wireframeOpacityPercent: presentation ? 45 : 100, vectorColorMode: "magnitude" as const, shaderColorMode: "x" as const, shaderMonoColor: "#12ab34", ...preferences }), [vectors, presentation, solid, fixtureQuantity, preferences]);
  const settings = dedicated ? resolveTargetVisualization({ snapshot: canonicalSnapshot, target: fixtureTarget, visualizationState: canonical.optimisticData ?? canonical.data }).settings : sharedSettings;
  const quantity = (dedicated ? settings.activeQuantityId : fixtureQuantity) as Quantity;
  const quantities = useMemo(() => catalog(live), [live]);
  const result = useArtifactFieldOverlay(quantity, "antenna", settings, false, definitions);
  const selected = useObjectVisualizationSelector(snapshot => snapshot.artifactFieldSelection ?? null);
  const binding = artifactInspectorFieldBinding({ catalog: quantities, quantityId: quantity, selection: selected, sessionIdentity: session, targetScope: { scopeKind: "object", scopeId: "antenna" } });
  const target = fixtureTarget;
  const controls = { artifactFieldBinding: binding, fieldCatalog: { data: null, status: "ready" }, fieldCatalogLoading: false, fieldMetaTarget: target,
    patch, patchColor: (field: string, value: string) => { void patch({ [field]: value }); }, patchNumber: (field: string, value: number) => { void patch({ [field]: value }); }, isFieldPending: () => false, sectionDisabled: () => false, settings, target };
  useEffect(() => { viewport3dStore.setRenderedScalarRanges(artifactRenderedSurfaceRanges(result.model)); return () => viewport3dStore.setRenderedScalarRanges([]); }, [result.model]);
  useEffect(() => {
    window.__artifactOverlayFixture = { read: () => ({ quantity, unit: result.model?.unit ?? null, model: Boolean(result.model), count: result.model?.count ?? 0, triangles: (result.model?.surfaceTriangles?.length ?? 0) / 3,
      minimum: result.model?.minimum ?? null, maximum: result.model?.maximum ?? null, values: Array.from(result.model?.scalarValues ?? []), glyphCount: result.model?.glyphCount ?? 0, pointCount: result.model?.pointSampleIndices.length ?? 0, availableGlyphCount: result.model?.availableGlyphCount ?? 0, surfaceOffsetDistance: result.model?.surfaceOffsetDistance ?? 0, scope: settings.geometryScope, calls: fixture.calls, unexpected: fixture.unexpected, historical: result.historical, error: result.error, resources: { ...tracker.getSnapshot() } }), replaceSurfaceRangeOwner: mode => {
      const ranges = artifactRenderedSurfaceRanges(result.model);
      viewport3dStore.setRenderedScalarRanges(mode === "restore" ? ranges : ranges.map(row => ({ ...row, inspectionKey: mode === "live" ? undefined : "foreign-owner", range: { min: -9999, max: 9999 } })));
    } };
  }, [quantity, result, fixture, tracker, settings.geometryScope]);
  useEffect(() => () => { tracker.disposeAll(); delete window.__artifactOverlayFixture; }, [tracker]);
  return <main><h1>Artifact field overlay · controlled transport</h1>{!dedicated ? <><label>Quantity<select aria-label="Fixture quantity" value={quantity} onChange={e => setQuantity(e.target.value as Quantity)}><option>H_ant</option><option>J_charge</option><option>V_electric</option></select></label>
    <label><input aria-label="Fixture live lane" type="checkbox" checked={live} onChange={e => { fixture.setLiveCatalog(e.target.checked); setLive(e.target.checked); }} /> Live solver lane</label>
    <button onClick={() => fixture.visualization.setArtifactFieldSelection({ identity, runId: "foreign-run", runtimeStageId, authoredStageId, sourceObjectId: "antenna" })}>Select foreign owner</button>
    <button onClick={() => fixture.visualization.setArtifactFieldSelection(null)}>Clear owner selection</button>
    <button aria-pressed={vectors} onClick={() => setVectors(value => !value)}>Toggle fixture vectors</button>
    <button aria-pressed={presentation} onClick={() => setPresentation(value => !value)}>Toggle fixture presentation</button>
    <button aria-pressed={solid} onClick={() => setSolid(value => !value)}>Toggle fixture solid surface</button>
    <label>Geometry scope<select aria-label="Fixture geometry scope" value={settings.geometryScope} onChange={event => { void patch({ geometryScope: event.target.value as "full" | "surface" }); }}><option value="full">Full</option><option value="surface">Surface</option></select></label>
    <label>Glyph budget<input aria-label="Fixture glyph budget" type="number" min={0} value={settings.vectorBudget} onChange={event => { void patch({ vectorBudget: Number(event.target.value) }); }} /></label></> : null}
    <p role="status">{result.error ?? (result.model ? `${quantity}: historical inspection · ${result.model.count} samples` : "No historical model")}</p>
    <div data-artifact-field-hud><Viewport3DFieldLabel quantityId="m" label="m" historical={result.historical} model={result.model} error={result.error} /></div>
    <div data-quantity-data-probes>
      <div data-probe="vectors-only"><Viewport3DFieldLabel quantityId="m" label="m" historical={false} model={null} error={null} liveDataAvailable={hasViewport3DQuantityData("m", { fieldModel: hudVectorsOnlyModel })} /></div>
      <div data-probe="intent-only"><Viewport3DFieldLabel quantityId="m" label="m" historical={false} model={null} error={null} liveDataAvailable={hasViewport3DQuantityData("m", { fieldModel: hudIntentOnlyModel })} /></div>
      <div data-probe="payload"><Viewport3DFieldLabel quantityId={quantity} label={quantity} historical={false} model={null} error={null} liveDataAvailable={hasViewport3DQuantityData(quantity, { fieldVectors: [result.model?.geometry.field] })} /></div>
      <div data-probe="different-quantity"><Viewport3DFieldLabel quantityId="m" label="m" historical={false} model={null} error={null} liveDataAvailable={hasViewport3DQuantityData("m", { fieldVectors: [result.model?.geometry.field] })} /></div>
      <div data-probe="absent"><Viewport3DFieldLabel quantityId={quantity} label={quantity} historical={false} model={null} error={null} liveDataAvailable={hasViewport3DQuantityData(quantity, {})} /></div>
    </div>
    <div data-artifact-field-viewport style={{ height: 480, width: "100%", position: "relative" }}><Viewport3DCanvas camera={{ position: [2.4, 1.7, 1.3], fov: 45, near: .01, far: 100 }} frameloop="demand">
      <VectorGlyphDerivedBufferCacheProvider tracker={tracker}><Probe /><ArtifactFieldLayer model={result.model} tracker={tracker} sessionIdentity={session} adoptionRegistry={adoptionRegistry} colors={{ accent: "white", background: "black", field: "white", mesh: "white", wire: "white" }} /></VectorGlyphDerivedBufferCacheProvider>
    </Viewport3DCanvas><div className="fm-viewport-3d__colorbar-stack">{resolveArtifactFieldColorbars(result.model).map(({ key, legend }) => <Viewport3DColorbar key={key} legend={legend} />)}</div></div>
    {dedicated ? <aside aria-label="Dedicated antenna Inspector" data-testid="dedicated-inspector-scroll" style={{ height: 600, overflow: "auto" }}>
      <label>Persistent unrelated draft<input aria-label="Dedicated unrelated draft" defaultValue="untouched" /></label>
      <Profiler id="dedicated-antenna-inspector" onRender={fixture.recordRender}><AntennaVisualizationPanel selection={inspectorSelection} /></Profiler>
      <div style={{ height: 500 }} aria-hidden="true" />
    </aside> : !live ? <aside aria-label="Shared inspection controls" className="fm-inspector-panel">
      <VisualizationSurfaceColoringSection {...controls} onFieldCatalogRequest={() => {}} />
      {quantity !== "V_electric" ? <VisualizationVectorsSection {...controls} targetKind="object" vectorBudgetRange={{ availableNodeCount: carrier(quantity).sample_count, max: carrier(quantity).sample_count, min: 0, step: 1, exact: true }} vectorCapacity={null} sceneCap={100000} visualizationRevision={1} vectorTopologyHash={carrier(quantity).carrier_digest} /> : null}
      <button onClick={() => fixture.setRangeMode("foreign")}>Return foreign range owner</button>
      <button onClick={() => fixture.setRangeMode("malformed")}>Return malformed range owner</button>
      <button onClick={() => fixture.setRangeMode("valid")}>Restore valid range owner</button>
    </aside> : null}</main>;
}
export default function Page() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const fixture = useMemo(() => hydrated ? makeFixture() : null, [hydrated]);
  const [dedicated, setDedicated] = useState(false);
  useEffect(() => {
    if (!fixture) return;
    fixture.kernel.visualizationSync.start();
    window.__artifactDedicatedFixture = fixture.dedicated;
    return () => { fixture.kernel.visualizationSync.stop(); delete window.__artifactDedicatedFixture; };
  }, [fixture]);
  return fixture ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider>
    {!dedicated ? <button onClick={() => { fixture.enterDedicated(); setDedicated(true); }}>Mount dedicated antenna Inspector</button> : null}
    <View key={dedicated ? "dedicated" : "shared"} fixture={fixture} dedicated={dedicated} />
  </InspectorEditSessionProvider></KernelContext.Provider> : <p>Loading controlled fixture…</p>;
}
