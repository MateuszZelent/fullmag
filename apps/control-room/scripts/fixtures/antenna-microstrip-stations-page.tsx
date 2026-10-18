"use client";

import { Profiler, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_GEOMETRY_REALIZATION_CURRENT_PATH, MODEL_SCENE_PATH, MODEL_TRANSACTIONS_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest, JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import type { CommandResult } from "@/kernel/commands/commandTypes";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { addAntennaFieldSolveStudyCommand } from "@/kernel/runtime/antennaFieldSolveStudyCommand";
import { AntennaStudyStageComposer } from "@/modules/inspector/panels/antenna/AntennaStudyStageComposer";
import { modelTreeSnapshotFromScene } from "@/modules/explorer/builders/sceneModelTreeAdapter";
import { buildStudyNodes } from "@/modules/explorer/builders/study/studyExplorerNodes";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { KernelApi } from "@/kernel/types";
import { MicrostripGeometryEditor } from "@/modules/inspector/panels/antenna/MicrostripGeometryEditor";
import { AntennaConductorDetails } from "@/modules/inspector/panels/antenna/AntennaCompositionPanels";
import { EMPTY_SELECTION, type Selection } from "@/kernel/selection/selectionTypes";
import { buildObjectExplorerNode } from "@/modules/explorer/builders/objectExplorerNodes";
import { selectionRefFromNode } from "@/modules/explorer/explorerSelection";
import { resolveInspectorRoute } from "@/modules/inspector/inspectorRouteCatalog";

const OBJECT_ID = "fixture-microstrip-conductor";
const API_INSTANCE = "22222222-2222-4222-8222-222222222222";
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;

interface Call { method: string; path: string; scope: string | null; revision: number; body: unknown; }
interface FixtureControl {
  selectGeometry(objectId: string): void;
  selectComposition(objectId: string): void;
  studyNodeRef(stageId: string): unknown;
  readSelection(): Selection;
  subscribeSelection(listener: () => void): () => void;
  read(): { calls: Call[]; pendingWrites: number; pendingSceneReads: number; renderCommits: number; revision: number; scene: SceneResource; unexpected: string[]; invalidations: { resourceKey: string; revision: unknown }[] };
  corruptNextCircuitAck(): void;
  releaseWrite(): void;
  refreshUnrelated(): void;
  releaseScene(): void;
  insertFormerPosition(): void;
  resizeLengthOnServer(lengthM: number): void;
  createAntenna(layout: "microstrip" | "cpw"): Promise<CommandResult>;
}
declare global { interface Window { __antennaStationsFixture?: FixtureControl; } }

function makeFixture() {
  const geometry: JsonObject = {
    geometry_kind: "MicrostripAntennaLayout",
    geometry_params: {
      length_m: 1e-6, thickness_m: 10e-9, conductivity_s_per_m: 5.8e7,
      return_width_m: 500e-9, return_offset_m: 30e-9,
      stations: [{ s: 0, signal_width_m: 40e-9 }, { s: 0.25, signal_width_m: 30e-9 }, { s: 0.75, signal_width_m: 20e-9 }, { s: 1, signal_width_m: 10e-9 }],
      transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] },
      conductors: [{ id: "signal", kind: "signal" }, { id: "return", kind: "return" }],
    },
  };
  if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("layout") === "cpw") {
    geometry.geometry_kind = "CPWAntennaLayout";
    const params = geometry.geometry_params as JsonObject;
    delete params.return_width_m;
    delete params.return_offset_m;
    params.stations = (params.stations as JsonObject[]).map((station, index) => ({ ...station,
      left_gap_m: (10 + index * 2) * 1e-9, right_gap_m: (30 - index * 2) * 1e-9,
      left_ground_width_m: (80 + index * 10) * 1e-9, right_ground_width_m: (150 - index * 10) * 1e-9,
    }));
    params.conductors = [{ id: "trace", kind: "signal" }, { id: "left", kind: "ground_left" }, { id: "right", kind: "ground_right" }];
  }
  const state = { scene: { revision: 1, scene_revision: 1, scene: { id: "restored-authoring-model", name: "Fixture", authoring_schema: "fixture", source_of_truth: "fixture" }, objects: [{ id: OBJECT_ID, name: "Microstrip fixture", role: "antenna", geometry, notes: "initial" }] } as SceneResource, renderCommits: 0, holdScene: false };
  const placementMode = typeof window !== "undefined" && new URL(window.location.href).searchParams.has("placement");
  if (placementMode) {
    state.scene.objects!.push({ id: "placement-target", name: "Explicit magnetic target", magnetization_ref: "authored-magnetization", geometry: { geometry_kind: "Box", geometry_params: {} } });
    if (new URL(window.location.href).searchParams.has("placement_missing_id")) state.scene.scene!.id = "";
  }
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const invalidations: { resourceKey: string; revision: unknown }[] = [];
  let corruptCircuitAck = false;
  const pendingWrites: (() => void)[] = [];
  const pendingSceneReads: (() => void)[] = [];
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  bus.on("resource:invalidated", (event) => invalidations.push({ resourceKey: event.resourceKey, revision: event.revision }));
  const diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const owner = { session_id: "session-antenna-stations-fixture", session_epoch: "session-antenna-stations-fixture@23", request_scope_epoch: `${API_INSTANCE}:1` };
  const expectedScope = sessionRequestScopeKey({ sessionId: owner.session_id, sessionEpoch: owner.session_epoch, requestScopeEpoch: owner.request_scope_epoch });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE } });
  const api = new ControlRoomApi({
    baseUrl: "http://antenna-stations.fixture.invalid", expectedApiInstance: API_INSTANCE, diagnostics, maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body: unknown = request.method === "POST" ? await request.json() : null;
      if (calls.length >= 100) throw new Error("Fixture request budget exceeded");
      const scope = request.headers.get("x-fullmag-session-scope");
      calls.push({ method: request.method, path, scope, revision: Number(state.scene.revision), body });
      if (scope && scope !== expectedScope) { unexpected.push("foreign session scope"); return json({ error: "Stale owner", code: "request_context_stale" }, 409); }
      if ((path === MODEL_SCENE_PATH || path === MODEL_TRANSACTIONS_PATH) && scope !== expectedScope) {
        unexpected.push("missing confirmed session scope");
        return json({ error: "Confirmed fixture owner scope is required", code: "request_context_stale" }, 409);
      }
      if (request.method === "GET" && path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: owner.session_id, name: "Microstrip fixture", current: true, status: "idle" }] });
      // Only thin identity/revision fields consumed by production hooks are supplied.
      if (request.method === "GET" && path === SESSION_STATUS_PATH) return json({ api_contract_version: "1.0.0", runtime_bundle_version: "fixture", session: { ...owner, name: "Microstrip fixture", created_at: "fixture", workspace_root: "fixture" }, resources: { scene_revision: state.scene.revision }, capabilities: {}, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
      if (request.method === "GET" && path === MODEL_SCENE_PATH) {
        const snapshot = structuredClone(state.scene);
        if (!state.holdScene) return json(snapshot);
        return new Promise<Response>((resolve) => pendingSceneReads.push(() => resolve(json(snapshot))));
      }
      if (request.method === "GET" && path === MODEL_GEOMETRY_REALIZATION_CURRENT_PATH) return json({ source_scene_revision: state.scene.revision, bodies: placementMode ? [{ object_id: "placement-target", status: "ready", bounds_min: [-1e-6, -5e-7, -1e-8], bounds_max: [1e-6, 5e-7, 1e-8] }] : [] });
      if (request.method === "POST" && path === MODEL_TRANSACTIONS_PATH) {
        const transaction = body as AuthoringTransactionRequest;
        if (transaction.kind === "merge_patch" && transaction.base_revision === state.scene.revision) {
          return new Promise<Response>((resolve) => pendingWrites.push(() => {
            const revision = Number(state.scene.revision) + 1;
            state.scene = { ...state.scene, ...structuredClone(transaction.merge_patch), revision, scene_revision: revision } as SceneResource;
            const acknowledged = structuredClone(state.scene);
            // Match the real API's skip_serializing_if = Vec::is_empty contract.
            for (const current of acknowledged.current_transports ?? []) {
              if (Array.isArray(current.boundaries) && current.boundaries.length === 0) delete current.boundaries;
            }
            if (corruptCircuitAck) {
              corruptCircuitAck = false;
              acknowledged.antenna_port_modes = acknowledged.antenna_port_modes?.map(port => ({ ...port, normalization: null }));
            }
            resolve(json({ scene_revision: revision, transaction_kind: transaction.kind, committed_scene: acknowledged }));
          }));
        }
        if (transaction.kind === "commit_object_transform" && transaction.object_id === OBJECT_ID && transaction.base_revision === state.scene.revision) {
          return new Promise<Response>((resolve) => pendingWrites.push(() => {
            const revision = Number(state.scene.revision) + 1;
            state.scene = { ...state.scene, revision, scene_revision: revision, objects: state.scene.objects?.map(object => object.id === OBJECT_ID ? { ...object, transform: { ...object.transform, ...structuredClone(transaction.transform) } } : object) };
            resolve(json({ scene_revision: revision, transaction_kind: transaction.kind, committed_scene: structuredClone(state.scene) }));
          }));
        }
        if (transaction.kind !== "patch_object_geometry" || transaction.object_id !== OBJECT_ID || transaction.base_revision !== state.scene.revision) {
          unexpected.push("invalid geometry transaction");
          return json({ error: "Invalid fixed fixture transaction", code: "revision_conflict" }, 409);
        }
        return new Promise<Response>((resolve) => pendingWrites.push(() => {
          const revision = Number(state.scene.revision) + 1;
          state.scene = { ...state.scene, revision, scene_revision: revision, objects: state.scene.objects?.map((object) => object.id === OBJECT_ID ? { ...object, geometry: structuredClone(transaction.geometry) } : object) };
          resolve(json({ scene_revision: revision, transaction_kind: transaction.kind, committed_scene: structuredClone(state.scene) }));
        }));
      }
      unexpected.push(`${request.method} ${path}`);
      throw new Error(`Unexpected fixture transport: ${request.method} ${path}`);
    },
  });
  // Production hooks, shared cache, API facade and editor are not replaced.
  const selection = new SelectionController(bus);
  const inspector = typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("inspector");
  const charge = typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("charge");
  if (inspector === "conductor" && charge !== "none") {
    const parts = (geometry.geometry_params as JsonObject).conductors as JsonObject[];
    state.scene.current_transports = [{ name: "explicit-charge", kind: "current_transport", model: "ohmic_poisson", domain: [{ object_id: OBJECT_ID }],
      materials: charge === "empty" ? [] : parts.map((part, index) => ({ region: { object_id: OBJECT_ID, region_id: String(part.id) }, material: { sigma_Spm: index ? 4.1e7 : 3.2e7 } })) }];
  }
  if (inspector === "geometry" || inspector === "conductor") {
    const object = buildObjectExplorerNode({ id: OBJECT_ID, label: "Antenna", objectRole: "antenna" }, {});
    const node = inspector === "geometry" ? object.children?.find(child => child.kind === "object.antenna.geometry")
      : object.children?.flatMap(child => child.children ?? []).find(child => child.kind === "object.antenna.conductor");
    if (!node) throw new Error("Production antenna route node is missing");
    selection.set({ ...EMPTY_SELECTION, kind: node.kind, objectId: OBJECT_ID, nodeId: node.id, ref: selectionRefFromNode(node) }, "explorer");
  }
  const commands = new CommandRegistry();
  commands.attach(bus);
  commands.attachSessionScopeSource({ getScopeKey: () => expectedScope, subscribe: () => () => {} });
  commands.register(addAntennaFieldSolveStudyCommand);
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder, selection, commands } as unknown as KernelApi;
  const control: FixtureControl = {
    selectGeometry: (objectId) => {
      if (!state.scene.objects?.some(object => object.id === objectId)) throw new Error("Unknown fixture object");
      const node = buildObjectExplorerNode({ id: objectId, label: "Antenna", objectRole: "antenna" }, {}).children?.find(child => child.kind === "object.antenna.geometry");
      if (!node) throw new Error("Production Geometry route is missing");
      selection.set({ ...EMPTY_SELECTION, kind: node.kind, objectId, nodeId: node.id, ref: selectionRefFromNode(node) }, "explorer");
    },
    selectComposition: (objectId) => {
      const snapshot = modelTreeSnapshotFromScene(state.scene).objects?.find(object => object.id === objectId);
      if (!snapshot) throw new Error("Unknown fixture object");
      const node = buildObjectExplorerNode(snapshot, { scene: state.scene }).children?.find(child => child.kind === "object.antenna");
      if (!node || node.selectable === false) throw new Error("Production composition route is unavailable");
      selection.set({ ...EMPTY_SELECTION, kind: node.kind, label: node.label, objectId, nodeId: node.id, ref: selectionRefFromNode(node) }, "explorer");
    },
    studyNodeRef: stageId => {
      const snapshot = modelTreeSnapshotFromScene(state.scene);
      const stages = buildStudyNodes(snapshot.study).children?.find(node => node.kind === "study.stages");
      const node = stages?.children?.find(node => node.stageId === stageId);
      return node ? selectionRefFromNode(node) : null;
    },
    readSelection: () => selection.get(),
    subscribeSelection: listener => selection.subscribe(listener),
    createAntenna: async (layout) => {
      const command = GEOMETRY_LIFECYCLE_COMMANDS.find((entry) => entry.id === `geometry.add-${layout}-antenna`);
      if (!command) throw new Error("Production antenna command is absent");
      return command.run({ source: "ribbon", api, resources, selection, sessionScopeKey: expectedScope, isCurrentSessionScope: () => true });
    },
    read: () => ({ calls: structuredClone(calls), pendingWrites: pendingWrites.length, pendingSceneReads: pendingSceneReads.length, renderCommits: state.renderCommits, revision: Number(state.scene.revision), scene: structuredClone(state.scene), unexpected: [...unexpected], invalidations: [...invalidations] }),
    corruptNextCircuitAck: () => { corruptCircuitAck = true; },
    releaseWrite: () => {
      const release = pendingWrites.shift();
      if (!release) throw new Error("No fixture write is pending");
      release();
    },
    refreshUnrelated: () => {
      const revision = Number(state.scene.revision) + 1;
      state.scene = { ...state.scene, revision, scene_revision: revision, objects: state.scene.objects?.map((object) => ({ ...object, notes: `unrelated revision ${revision}` })) };
      state.holdScene = true;
      resources.invalidate(MODEL_SCENE_PATH, revision);
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
    },
    releaseScene: () => { state.holdScene = false; for (const release of pendingSceneReads.splice(0)) release(); },
    resizeLengthOnServer: (lengthM) => {
      if (!Number.isFinite(lengthM) || lengthM <= 0) throw new Error("Invalid fixture length");
      const revision = Number(state.scene.revision) + 1;
      state.scene = { ...state.scene, revision, scene_revision: revision, objects: state.scene.objects?.map((entry) => {
        if (entry.id !== OBJECT_ID) return entry;
        const geometry = entry.geometry as JsonObject;
        return { ...entry, geometry: { ...geometry, geometry_params: { ...geometry.geometry_params as JsonObject, length_m: lengthM } } };
      }) };
      resources.invalidate(MODEL_SCENE_PATH, revision);
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
    },
    insertFormerPosition: () => {
      const object = state.scene.objects?.find((entry) => entry.id === OBJECT_ID);
      const current = object?.geometry as JsonObject | undefined;
      const params = current?.geometry_params as JsonObject | undefined;
      const stations = params?.stations;
      if (!Array.isArray(stations) || stations.length !== 4) throw new Error("Expected four committed fixture stations");
      const revision = Number(state.scene.revision) + 1;
      const updated = { ...current, geometry_params: { ...params, stations: [stations[0], stations[1], { ...(stations[2] as JsonObject), s: 0.75, signal_width_m: 19e-9 }, stations[2], stations[3]] } };
      state.scene = { ...state.scene, revision, scene_revision: revision, objects: state.scene.objects?.map((entry) => entry.id === OBJECT_ID ? { ...entry, geometry: updated } : entry) };
      resources.invalidate(MODEL_SCENE_PATH, revision);
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
    },
  };
  return { kernel, control, onRender: () => { state.renderCommits += 1; } };
}

function EditorHarness({ control }: { control: FixtureControl }) {
  const selected = useSyncExternalStore(control.subscribeSelection, control.readSelection, () => EMPTY_SELECTION);
  const resource = useSceneResource();
  const [foreignScope, setForeignScope] = useState(false);
  const created = resource.data?.objects?.findLast((object) => object.id !== OBJECT_ID && object.role === "antenna");
  const routedInspector = new URL(window.location.href).searchParams.has("inspector");
  const studyMode = new URL(window.location.href).searchParams.has("study");
  const ownerId = selected.ref?.type === "scene-object" ? selected.ref.objectId : null;
  const solves = resource.data?.antenna_field_solve_stages?.filter(stage => stage.source_object_id === ownerId) ?? [];
  const Panel = selected.kind?.startsWith("object.antenna") ? resolveInspectorRoute(selected.kind)?.component : undefined;
  return <div data-testid="antenna-stations-editor" data-resource-status={resource.status} data-scene-revision={resource.data?.revision}>
    {routedInspector && Panel ? <Panel selection={selected} /> : <MicrostripGeometryEditor objectId={OBJECT_ID} scene={resource.data} status={resource.status} refetch={resource.refetch} />}
    {studyMode ? <label><input type="checkbox" aria-label="Use previous-session scene scope" checked={foreignScope} onChange={event => setForeignScope(event.currentTarget.checked)} />Use previous-session scene scope</label> : null}
    {studyMode && ownerId && solves.length === 1 ? <AntennaStudyStageComposer objectId={ownerId} stageId={solves[0].id} scene={resource.data} sceneScopeKey={foreignScope ? "previous-session-scope" : resource.sessionScopeKey} status={resource.status} /> : null}
    {created ? <div data-testid="antenna-created-details" data-object-id={created.id} style={{ width: 320, maxWidth: "100%" }}>
      <AntennaConductorDetails objectId={created.id} scene={resource.data} />
    </div> : null}
  </div>;
}

export default function AntennaMicrostripStationsFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated);
  useEffect(() => { window.__antennaStationsFixture = fixture.control; return () => { delete window.__antennaStationsFixture; }; }, [fixture]);
  return <main className="fm-antenna-stations-fixture" style={{ padding: 32, maxWidth: 820 }}>
    <h1>Fullmag microstrip station authoring fixture</h1>
    <p>Production Inspector, typed transactions and resource hooks; controlled responses only. No backend, mesh/current solve or physics qualification.</p>
    {mounted ? <KernelContext.Provider value={fixture.kernel}>
      <label>Persistent unrelated control <input data-testid="antenna-stations-unrelated" defaultValue="stable unrelated draft" /></label>
      <div data-testid="antenna-stations-scroll" style={{ height: 480, overflow: "auto", padding: 16, border: "1px solid var(--fm-border-subtle)" }}>
        <Profiler id="antenna-stations" onRender={fixture.onRender}><EditorHarness control={fixture.control} /></Profiler>
      </div>
    </KernelContext.Provider> : <p role="status">Loading fixture harness…</p>}
  </main>;
}
