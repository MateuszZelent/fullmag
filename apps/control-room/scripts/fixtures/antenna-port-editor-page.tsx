"use client";

import { Profiler, useEffect, useMemo, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_SCENE_PATH, MODEL_TRANSACTIONS_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest, SceneResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { KernelApi } from "@/kernel/types";
import { InspectorEditSessionProvider, useInspectorEditSession } from "@/modules/inspector/InspectorEditSession";
import { AntennaConductorAuthoring } from "@/modules/inspector/panels/antenna/AntennaConductorAuthoring";
import { AntennaCompositionPanel } from "@/modules/inspector/panels/antenna/AntennaCompositionPanels";
import { AntennaPortEditor } from "@/modules/inspector/panels/antenna/AntennaPortEditor";

const API_INSTANCE = "66666666-6666-4666-8666-666666666666";
const sourceId = "antenna-source", returnId = "antenna-return", portId = "antenna-port";
const subscribeHydration = () => () => {};
const hydrated = () => true, serverHydrated = () => false;
type Call = { method: string; path: string; scope: string | null; body: unknown };
interface FixtureControl {
  read(): { calls: Call[]; pending: number; renders: number; scene: SceneResource; canUndo: boolean; invalidations: number; unexpected: string[] };
  release(): void;
  conflict(renameFirstBranch?: string): void;
  rejectNext(): void;
  malformedNext(kind?: "normalization" | "scene_revision" | "scene_id"): void;
  switchSession(name: "A" | "B"): void;
  resetHistory(): void;
}
declare global { interface Window { __antennaPortEditorFixture?: FixtureControl; } }

function makeScene(name: string): SceneResource {
  const terminals = ["signal-in", "signal-out", "return-in", "return-out", "return2-in", "return2-out"];
  const port = { id: portId, schema_version: "antenna_port_mode.v2", source_object_id: sourceId,
    current_transport_id: "transport", normalization_current_a: 1,
    branches: [{ id: "signal", inlet_terminal_ref: terminals[0], outlet_terminal_ref: terminals[1], signed_weight: 1 },
      { id: "return", inlet_terminal_ref: terminals[2], outlet_terminal_ref: terminals[3], signed_weight: -1 }],
  };
  const scene: SceneResource = { revision: 1, scene_revision: 1,
    scene: { id: `restored-model-${name}`, name, authoring_schema: "fixture", source_of_truth: "fixture" },
    objects: [{ id: sourceId, name: "Antenna signal", role: "antenna" }, { id: returnId, name: "Return", role: "conductor" }],
    current_transports: ["transport", "alternative"].map((name) => ({ name, kind: "current_transport", model: "ohmic_poisson",
      domain: [{ object_id: sourceId }, { object_id: returnId }],
      boundaries: terminals.map((id) => ({ id, kind: "voltage_electrode", potential_V: 0,
        surfaces: [{ object_id: id.startsWith("signal") ? sourceId : returnId, surface_id: id, orientation: [1, 0, 0] }] })),
    })), antenna_port_modes: [port, { ...structuredClone(port), id: "unrelated-port" }],
  };
  const scenario = typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("scenario");
  if (scenario === "composed-port-dependent") scene.antenna_field_solve_stages = [{
    id: "dependent-solve", source_object_id: sourceId, current_transport_id: "transport", port_mode_ids: [portId],
    conductor_mesh_policy: "inherit_source", solver_policy: "default", model: "quasistatic_conduction_biot_savart3d",
    oersted_realization: "direct_tetra_quadrature", field_sampling_domain: { kind: "object", object_id: returnId },
    target_refs: [{ kind: "object", object_id: returnId }],
    outputs: [{ id: "basis", quantity: "H_ant_basis" }],
  }];
  if (scenario === "malformed-source") Object.assign(scene.current_transports![0], { conservative_current_source: {} });
  if (scenario === "structured-v3") {
    Object.assign(scene.antenna_port_modes![0], { schema_version: "antenna_port_mode.v3",
      normalization: { kind: "source_cut_rt0", source_cut_ref: "cut", orientation: "minus_outward" } });
    Object.assign(scene.current_transports![0], { structured_current_closure: { schema_version: "structured_current_closure.v2", kind: "closed_geometry",
      source_cuts: [{ source_cut_id: "cut", region: { object_id: sourceId } }] } });
  }
  if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("creator") === "1") {
    Object.assign(scene.objects![0], { geometry: { geometry_kind: "MicrostripAntennaLayout", geometry_params: {
      conductivity_s_per_m: 58000000, conductors: [{ id: "signal" }, { id: "return" }],
    } } });
    scene.current_transports = [scene.current_transports![0]];
    Object.assign(scene.current_transports[0], { coupling: "one_way", domain: [{ object_id: sourceId }],
      materials: [{ region: { object_id: sourceId }, material: { kind: "ohmic", sigma_Spm: 58000000 } }] });
    const boundaries = scene.current_transports[0].boundaries;
    for (const boundary of Array.isArray(boundaries) ? boundaries : []) Object.assign(boundary, { surfaces: [{ object_id: sourceId, surface_id: boundary.id, orientation: [1, 0, 0] }] });
  }
  return scene;
}

function makeFixture() {
  const state = { name: "A" as "A" | "B", clock: 1, scenes: { A: makeScene("A"), B: makeScene("B") }, renders: 0, reject: false, malformed: null as "normalization" | "scene_revision" | "scene_id" | null };
  const calls: Call[] = [], unexpected: string[] = [], pending: (() => void)[] = [];
  const bus = new EventBus<KernelEventMap>(), resources = new ResourceInvalidationController(bus);
  let invalidations = 0;
  bus.on("resource:invalidated", () => { invalidations += 1; });
  const diagnostics = new RequestDiagnosticsController(), diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const identity = () => ({ sessionId: `session-${state.name}`, sessionEpoch: `session-${state.name}@1`, requestScopeEpoch: `${API_INSTANCE}:1` });
  const scope = () => sessionRequestScopeKey(identity());
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE,
  } });
  const api = new ControlRoomApi({ baseUrl: "http://antenna-port-editor.fixture.invalid", expectedApiInstance: API_INSTANCE,
    diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() as AuthoringTransactionRequest : null;
      const requestScope = request.headers.get("x-fullmag-session-scope");
      calls.push({ method: request.method, path, scope: requestScope, body });
      if (calls.length > 100) throw new Error("Port editor request budget exceeded");
      if (request.method === "GET" && path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: ["A", "B"].map((name) => ({ session_id: `session-${name}`, name, current: name === state.name, status: "idle" })) });
      if (request.method === "GET" && path === SESSION_STATUS_PATH) {
        const owner = identity();
        return json({ session: { session_id: owner.sessionId, session_epoch: owner.sessionEpoch, request_scope_epoch: owner.requestScopeEpoch, name: state.name, created_at: "fixture", workspace_root: "fixture" },
          resources: { scene_revision: state.scenes[state.name].revision, command_completion_revision: state.clock }, capabilities: {},
          lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
      }
      if (requestScope !== scope()) { unexpected.push("foreign scope"); return json({ error: "Owner changed", code: "request_context_stale" }, 409); }
      if (request.method === "GET" && path === MODEL_SCENE_PATH) return json(structuredClone(state.scenes[state.name]));
      if (request.method === "POST" && path === MODEL_TRANSACTIONS_PATH && body?.kind === "merge_patch") {
        const name = state.name, before = state.scenes[name];
        if (body.base_revision !== before.revision || JSON.stringify(Object.keys(body.merge_patch)) !== '["antenna_port_modes"]') {
          unexpected.push("invalid port transaction"); return json({ error: "Scene changed", code: "revision_conflict" }, 409);
        }
        if (state.reject) { state.reject = false; return json({ error: "Injected port revision conflict", code: "revision_conflict" }, 409); }
        const ports = structuredClone(body.merge_patch.antenna_port_modes) as SceneResource["antenna_port_modes"];
        const malformed = state.malformed; state.malformed = null;
        return new Promise<Response>((resolve) => pending.push(() => {
          if (state.scenes[name].revision !== before.revision) { resolve(json({ error: "Scene changed", code: "revision_conflict" }, 409)); return; }
          const revision = (before.revision ?? 0) + 1;
          const after = { ...before, revision, scene_revision: revision, antenna_port_modes: ports };
          state.scenes[name] = after;
          const acknowledgement = structuredClone(after);
          if (malformed === "normalization" && acknowledgement.antenna_port_modes) acknowledgement.antenna_port_modes[0].normalization_current_a = 2;
          if (malformed === "scene_revision") acknowledgement.scene_revision = revision + 1;
          if (malformed === "scene_id" && acknowledgement.scene) acknowledgement.scene.id = "foreign-model";
          resolve(json({ transaction_kind: "merge_patch", scene_revision: revision, committed_scene: acknowledgement }));
        }));
      }
      unexpected.push(`${request.method} ${path}`); throw new Error(`Unexpected port request: ${request.method} ${path}`);
    } });
  const history = new AuthoringHistoryController(api, resources);
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder, authoringHistory: history, commands: { getSessionScopeKey: scope } } as unknown as KernelApi;
  const control: FixtureControl = {
    read: () => ({ calls: structuredClone(calls), pending: pending.length, renders: state.renders, scene: structuredClone(state.scenes[state.name]), canUndo: history.canUndo(), invalidations, unexpected: [...unexpected] }),
    release: () => { const release = pending.shift(); if (!release) throw new Error("No pending port write"); release(); },
    rejectNext: () => { state.reject = true; },
    malformedNext: (kind = "normalization") => { state.malformed = kind; },
    conflict: (renameFirstBranch) => { const scene = structuredClone(state.scenes[state.name]), revision = (scene.revision ?? 0) + 1;
      if (renameFirstBranch && scene.antenna_port_modes) scene.antenna_port_modes[0].branches[0].id = renameFirstBranch;
      state.scenes[state.name] = { ...scene, revision, scene_revision: revision }; state.clock += 1;
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.clock); resources.invalidate(MODEL_SCENE_PATH, state.clock); },
    switchSession: (name) => { state.name = name; state.clock += 1; resources.invalidate(SESSIONS_PATH, state.clock); resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.clock); },
    resetHistory: () => history.clear(),
  };
  return { kernel, control, onRender: () => { state.renders += 1; } };
}

function EditorOwner() {
  const scene = useSceneResource(), session = useInspectorEditSession();
  const creator = new URL(window.location.href).searchParams.get("creator") === "1";
  const composed = new URL(window.location.href).searchParams.get("scenario")?.startsWith("composed-port");
  const nodeId = `model:object:${sourceId}:antenna:port:${portId}`;
  return <>
    <output data-testid="port-owner">{scene.data?.scene?.id}</output>
    <output data-testid="port-dirty">{String(session?.dirty ?? false)}</output>
    <output data-testid="port-global-valid">{String(session?.valid ?? false)}</output>
    <output data-testid="port-global-reason">{session?.applyBlockReason}</output>
    {creator || composed ? <>
      <button data-testid="port-global-apply" type="button" disabled={!session?.dirty || !session?.valid || session?.applying} onClick={() => { void session?.apply(); }}>{creator ? "Apply conductor changes" : "Apply port changes"}</button>
      <button data-testid="port-global-discard" type="button" disabled={!session?.dirty || session?.applying} onClick={() => { void session?.reset(); }}>{creator ? "Discard conductor changes" : "Discard port changes"}</button>
    </> : null}
    <section data-testid="port-editor">{creator ? <AntennaConductorAuthoring objectId={sourceId} scene={scene.data} sceneScopeKey={scene.sessionScopeKey} status={scene.status} refetch={scene.refetch} /> : composed ? <AntennaCompositionPanel kind="port" selection={{ kind: "object.antenna.port", objectId: sourceId, nodeId, label: "Port", moduleSource: null, ref: { type: "scene-object", kind: "object.antenna.port", objectId: sourceId, nodeId, visualizationTargetId: `object:${sourceId}`, antennaResourceKind: "port", antennaResourceId: portId } }} /> : <AntennaPortEditor objectId={sourceId} portId={portId} scene={scene.data} sceneScopeKey={scene.sessionScopeKey} status={scene.status} refetch={scene.refetch} />}</section>
    <div style={{ height: 550 }} aria-hidden="true" />
  </>;
}

export default function AntennaPortEditorFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, hydrated, serverHydrated);
  useEffect(() => { window.__antennaPortEditorFixture = fixture.control; return () => { delete window.__antennaPortEditorFixture; }; }, [fixture]);
  return <main style={{ padding: 32, maxWidth: 900 }}>
    <h1>Production antenna port editor</h1><p>Controlled HTTP authoring fixture, not native current closure or field qualification.</p>
    <label>Unrelated draft <input data-testid="port-unrelated" defaultValue="untouched" /></label>
    {mounted ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider>
      <div data-testid="port-scroll" style={{ height: 470, overflow: "auto", border: "1px solid var(--fm-border-subtle)" }}>
        <Profiler id="port-editor" onRender={fixture.onRender}><EditorOwner /></Profiler>
      </div>
    </InspectorEditSessionProvider></KernelContext.Provider> : <p role="status">Loading fixture…</p>}
  </main>;
}
