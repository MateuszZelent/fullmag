"use client";

import { Profiler, useEffect, useMemo, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_SCENE_PATH, MODEL_TRANSACTIONS_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest, JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { KernelApi } from "@/kernel/types";
import { MicrostripGeometryEditor } from "@/modules/inspector/panels/antenna/MicrostripGeometryEditor";

const OBJECT_ID = "fixture-microstrip-conductor";
const API_INSTANCE = "22222222-2222-4222-8222-222222222222";
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;

interface Call { method: string; path: string; scope: string | null; revision: number; body: unknown; }
interface FixtureControl {
  read(): { calls: Call[]; pendingWrites: number; pendingSceneReads: number; renderCommits: number; revision: number; scene: SceneResource; unexpected: string[]; invalidations: { resourceKey: string; revision: unknown }[] };
  releaseWrite(): void;
  refreshUnrelated(): void;
  releaseScene(): void;
  insertFormerPosition(): void;
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
  const state = { scene: { revision: 1, scene_revision: 1, objects: [{ id: OBJECT_ID, name: "Microstrip fixture", geometry, notes: "initial" }] } as SceneResource, renderCommits: 0, holdScene: false };
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const invalidations: { resourceKey: string; revision: unknown }[] = [];
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
      if (request.method === "POST" && path === MODEL_TRANSACTIONS_PATH) {
        const transaction = body as AuthoringTransactionRequest;
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
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder } as unknown as KernelApi;
  const control: FixtureControl = {
    read: () => ({ calls: structuredClone(calls), pendingWrites: pendingWrites.length, pendingSceneReads: pendingSceneReads.length, renderCommits: state.renderCommits, revision: Number(state.scene.revision), scene: structuredClone(state.scene), unexpected: [...unexpected], invalidations: [...invalidations] }),
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

function EditorHarness() {
  const resource = useSceneResource();
  return <div data-testid="antenna-stations-editor" data-resource-status={resource.status} data-scene-revision={resource.data?.revision}>
    <MicrostripGeometryEditor objectId={OBJECT_ID} scene={resource.data} status={resource.status} refetch={resource.refetch} />
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
        <Profiler id="antenna-stations" onRender={fixture.onRender}><EditorHarness /></Profiler>
      </div>
    </KernelContext.Provider> : <p role="status">Loading fixture harness…</p>}
  </main>;
}
