"use client";

import { Profiler, useEffect, useMemo, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_SCENE_PATH, MODEL_TRANSACTIONS_PATH, MODEL_MATERIAL_PATH, MODEL_OBJECT_PATH, MODEL_OBJECT_INTERACTION_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
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
import { ObjectMaterialPanel } from "@/modules/inspector/panels/ObjectMaterialPanel";

const API_INSTANCE = "66666666-6666-4666-8666-666666666666";
const objectId = "object-a";
const subscribeHydration = () => () => {};
const hydrated = () => true, serverHydrated = () => false;
type Call = { method: string; path: string; scope: string | null; body: unknown };
interface FixtureControl {
  read(): { calls: Call[]; pending: number; renders: number; scene: SceneResource; canUndo: boolean; invalidations: number; unexpected: string[] };
  release(): void;
  switchSession(name: "A" | "B"): void;
  resetHistory(): void;
  switchObject(id: "object-a" | "object-b"): void;
  subscribeObject(listener: () => void): () => void;
  readObject(): string;
  switchKind(kind: "object.material" | "object.magnetic-parameters"): void;
  readKind(): string;
}
declare global { interface Window { __objectMaterialEditorFixture?: FixtureControl; } }

function makeScene(name: string): SceneResource {
  return { revision: 1, scene_revision: 1, scene: { id: `session-${name}`, name, authoring_schema: "fixture", source_of_truth: "fixture" },
    materials: [{ id: "mat:base", name: "Base", properties: { Ms: 800000, Aex: 1.3e-11, alpha: 0.01, Dind: null, Dbulk: null } }],
    objects: ["object-a", "object-b"].map(id => ({ id, name: id, material_ref: "mat:base", geometry: { kind: "Box" } })) };
}

function makeFixture() {
  let activeObject = objectId;
  let activeKind = "object.magnetic-parameters";
  const objectListeners = new Set<() => void>();
  const state = { name: "A" as "A" | "B", clock: 1, scenes: { A: makeScene("A"), B: makeScene("B") }, renders: 0 };
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
  const api = new ControlRoomApi({ baseUrl: "http://object-material-editor.fixture.invalid", expectedApiInstance: API_INSTANCE,
    diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      const body = ["POST", "PATCH"].includes(request.method) ? await request.json() as AuthoringTransactionRequest : null;
      const requestScope = request.headers.get("x-fullmag-session-scope");
      calls.push({ method: request.method, path, scope: requestScope, body });
      if (calls.length > 100) throw new Error("Material editor request budget exceeded");
      if (request.method === "GET" && path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: ["A", "B"].map((name) => ({ session_id: `session-${name}`, name, current: name === state.name, status: "idle" })) });
      if (request.method === "GET" && path === SESSION_STATUS_PATH) {
        const owner = identity();
        return json({ session: { session_id: owner.sessionId, session_epoch: owner.sessionEpoch, request_scope_epoch: owner.requestScopeEpoch, name: state.name, created_at: "fixture", workspace_root: "fixture" },
          resources: { scene_revision: state.scenes[state.name].revision, command_completion_revision: state.clock }, capabilities: {},
          lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
      }
      if (requestScope !== scope()) { unexpected.push("foreign scope"); return json({ error: "Owner changed", code: "request_context_stale" }, 409); }
      if (request.method === "GET" && path === MODEL_SCENE_PATH) return json(structuredClone(state.scenes[state.name]));
      const materialPrefix = MODEL_MATERIAL_PATH.split("{material_id}")[0];
      const objectPrefix = MODEL_OBJECT_PATH.split("{object_id}")[0];
      if (request.method === "GET" && path.startsWith(materialPrefix)) {
        const id = decodeURIComponent(path.slice(materialPrefix.length));
        const found = state.scenes[state.name].materials?.find(material => material.id === id);
        if (!found) return json({ error: "No material", code: "not_found" }, 404);
        return json({ ...found, scene_revision: state.scenes[state.name].revision });
      }
      if (request.method === "GET" && ["object-a", "object-b"].some(id => path === MODEL_OBJECT_INTERACTION_PATH.replace("{object_id}", id).replace("{interaction_kind}", "uniaxial_anisotropy"))) {
        return json({ object_id: path.slice(objectPrefix.length).split("/")[0], interaction_kind: "uniaxial_anisotropy", present: false, enabled: false, params: {}, scene_revision: state.scenes[state.name].revision });
      }
      if (request.method === "POST" && path === MODEL_TRANSACTIONS_PATH && body?.kind === "create_material") {
        const name = state.name, before = state.scenes[name];
        if (body.base_revision !== before.revision || before.materials?.some(material => material.id === body.material_id)) return json({ error: "Invalid create", code: "revision_conflict" }, 409);
        return new Promise<Response>(resolve => pending.push(() => {
          if (state.scenes[name].revision !== before.revision) { resolve(json({ error: "Scene changed", code: "revision_conflict" }, 409)); return; }
          const revision = (before.revision ?? 0) + 1;
          const after = { ...before, revision, scene_revision: revision, materials: [...(before.materials ?? []), { id: body.material_id, name: body.name, properties: body.properties }] };
          state.scenes[name] = after;
          resolve(json({ transaction_kind: "create_material", scene_revision: revision, committed_scene: structuredClone(after) }));
        }));
      }
      if (request.method === "PATCH" && ["object-a", "object-b"].some(id => path === MODEL_OBJECT_PATH.replace("{object_id}", id))) {
        const patch = body as unknown as { base_revision: number; material_ref: string };
        const name = state.name, before = state.scenes[name], id = path.slice(objectPrefix.length);
        if (patch.base_revision !== before.revision || !before.materials?.some(material => material.id === patch.material_ref)) return json({ error: "Invalid assign", code: "revision_conflict" }, 409);
        return new Promise<Response>(resolve => pending.push(() => {
          if (state.scenes[name].revision !== before.revision) { resolve(json({ error: "Scene changed", code: "revision_conflict" }, 409)); return; }
          const revision = (before.revision ?? 0) + 1;
          const after = { ...before, revision, scene_revision: revision, objects: before.objects?.map(object => object.id === id ? { ...object, material_ref: patch.material_ref } : object) };
          state.scenes[name] = after;
          resolve(json(structuredClone(after)));
        }));
      }
      unexpected.push(`${request.method} ${path}`); throw new Error(`Unexpected material request: ${request.method} ${path}`);
    } });
  const history = new AuthoringHistoryController(api, resources);
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder, authoringHistory: history, commands: { getSessionScopeKey: scope } } as unknown as KernelApi;
  const control: FixtureControl = {
    read: () => ({ calls: structuredClone(calls), pending: pending.length, renders: state.renders, scene: structuredClone(state.scenes[state.name]), canUndo: history.canUndo(), invalidations, unexpected: [...unexpected] }),
    release: () => { const release = pending.shift(); if (!release) throw new Error("No pending material write"); release(); },
    switchSession: (name) => { state.name = name; state.clock += 1; resources.invalidate(SESSIONS_PATH, state.clock); resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.clock); },
    resetHistory: () => history.clear(),
    switchObject: (id) => { activeObject = id; for (const listener of objectListeners) listener(); },
    subscribeObject: (listener) => { objectListeners.add(listener); return () => { objectListeners.delete(listener); }; },
    readObject: () => activeObject,
    switchKind: (kind) => { activeKind = kind; for (const listener of objectListeners) listener(); },
    readKind: () => activeKind,
  };
  return { kernel, control, onRender: () => { state.renders += 1; } };
}

function EditorOwner({ control }: { control: FixtureControl }) {
  const scene = useSceneResource(), session = useInspectorEditSession();
  const activeObject = useSyncExternalStore(control.subscribeObject, control.readObject, () => objectId);
  const activeKind = useSyncExternalStore(control.subscribeObject, control.readKind, () => "object.magnetic-parameters");
  return <>
    <output data-testid="material-owner">{scene.data?.scene?.id}</output>
    <output data-testid="material-dirty">{String(session?.dirty ?? false)}</output>
    <section data-testid="material-editor" data-resource-status={scene.status} data-object-id={activeObject} data-kind={activeKind}><ObjectMaterialPanel selection={{ objectId: activeObject, kind: activeKind, nodeId: `${activeObject}:${activeKind}`, label: activeObject, ref: null, moduleSource: "inspector" }} /></section>
    <div style={{ height: 550 }} aria-hidden="true" />
  </>;
}

export default function ObjectMaterialEditorFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, hydrated, serverHydrated);
  useEffect(() => { window.__objectMaterialEditorFixture = fixture.control; return () => { delete window.__objectMaterialEditorFixture; }; }, [fixture]);
  return <main style={{ padding: 32, maxWidth: 900 }}>
    <h1>Production Object material editor</h1><p>Controlled HTTP authoring fixture, not native current closure or field qualification.</p>
    <label>Unrelated draft <input data-testid="material-unrelated" defaultValue="untouched" /></label>
    {mounted ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider>
      <div data-testid="material-scroll" style={{ height: 470, overflow: "auto", border: "1px solid var(--fm-border-subtle)" }}>
        <Profiler id="material-editor" onRender={fixture.onRender}><EditorOwner control={fixture.control} /></Profiler>
      </div>
    </InspectorEditSessionProvider></KernelContext.Provider> : <p role="status">Loading fixture…</p>}
  </main>;
}
