"use client";

import { Profiler, useEffect, useMemo, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_SCENE_PATH, MODEL_TRANSACTIONS_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest, SceneResource } from "@/kernel/api/apiTypes";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { KernelApi } from "@/kernel/types";
import { AntennaSolveTargetsEditor } from "@/modules/inspector/panels/antenna/AntennaSolveTargetsEditor";
import { InspectorEditSessionProvider, useInspectorEditSession } from "@/modules/inspector/InspectorEditSession";

const API_INSTANCE = "44444444-4444-4444-8444-444444444444";
const sourceId = "immutable-antenna";
const solveId = "immutable-solve";
const subscribeHydration = () => () => {};
const hydrated = () => true;
const serverHydrated = () => false;
type Call = { method: string; path: string; scope: string | null; body: unknown };
interface FixtureControl {
  read(): { calls: Call[]; pending: number; renders: number; scene: SceneResource; scope: string | null; generation: number; canUndo: boolean; invalidations: number; unexpected: string[] };
  release(): void;
  conflict(): void;
  switchSession(name: "A" | "B"): void;
  resetHistory(): void;
}
declare global { interface Window { __antennaSolveTargetsFixture?: FixtureControl; } }

function makeFixture() {
  const makeScene = (name: string): SceneResource => ({
    revision: 1, scene_revision: 1, scene: { id: `session-${name}`, name: `Fixture ${name}`, authoring_schema: "fixture", source_of_truth: "fixture" },
    objects: [{ id: sourceId, name: "Golden antenna", role: "antenna" }, {
      id: "immutable-waveguide", name: "Guide", role: "magnet", regions: [{ region_id: "core", name: "Core", owner_object: "immutable-waveguide", shape: { kind: "box", center: [0, 0, 0], size: [1, 1, 1] } }],
    }],
    antenna_field_solve_stages: [{ id: solveId, source_object_id: sourceId, current_transport_id: "current-fixed", port_mode_ids: ["port-fixed"],
      conductor_mesh_policy: "inherit_source", solver_policy: "default", model: "quasistatic_conduction_biot_savart3d", oersted_realization: "direct_tetra_quadrature",
      field_sampling_domain: { kind: "global" }, outputs: [{ id: "basis", quantity: "H_ant_basis" }], target_refs: [{ kind: "global" }],
    }], antenna_target_projections: [], solved_antenna_drives: [],
  });
  const state = { name: "A" as "A" | "B", clock: 1, scenes: { A: makeScene("A"), B: makeScene("B") }, renders: 0 };
  const calls: Call[] = [], unexpected: string[] = [], pending: (() => void)[] = [];
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  let invalidations = 0;
  bus.on("resource:invalidated", () => { invalidations += 1; });
  const diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const identity = () => ({ sessionId: `session-${state.name}`, sessionEpoch: `session-${state.name}@1`, requestScopeEpoch: `${API_INSTANCE}:1` });
  const scope = () => sessionRequestScopeKey(identity());
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE } });
  const api = new ControlRoomApi({ baseUrl: "http://antenna-solve-targets.fixture.invalid", expectedApiInstance: API_INSTANCE, diagnostics, maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() as AuthoringTransactionRequest : null;
      const requestScope = request.headers.get("x-fullmag-session-scope");
      calls.push({ method: request.method, path, scope: requestScope, body });
      if (calls.length > 120) throw new Error("Fixture request budget exceeded");
      if (request.method === "GET" && path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: ["A", "B"].map((name) => ({ session_id: `session-${name}`, name, current: name === state.name, status: "idle" })) });
      if (request.method === "GET" && path === SESSION_STATUS_PATH) {
        const owner = identity();
        return json({ session: { session_id: owner.sessionId, session_epoch: owner.sessionEpoch, request_scope_epoch: owner.requestScopeEpoch, name: state.name, created_at: "fixture", workspace_root: "fixture" },
          resources: { scene_revision: state.scenes[state.name].revision, command_completion_revision: state.clock },
          capabilities: {}, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
      }
      if (requestScope !== scope()) {
        unexpected.push("unconfirmed/foreign request scope");
        return json({ error: "Fixture owner changed", code: "request_context_stale" }, 409);
      }
      if (request.method === "GET" && path === MODEL_SCENE_PATH) return json(structuredClone(state.scenes[state.name]));
      if (request.method === "POST" && path === MODEL_TRANSACTIONS_PATH && body?.kind === "merge_patch") {
        const ownName = state.name;
        const before = state.scenes[ownName];
        if (body.base_revision !== before.revision || JSON.stringify(Object.keys(body.merge_patch)) !== JSON.stringify(["antenna_field_solve_stages"])) {
          unexpected.push("invalid target transaction");
          return json({ error: "Scene changed", code: "revision_conflict" }, 409);
        }
        const submitted = structuredClone(body.merge_patch.antenna_field_solve_stages);
        return new Promise<Response>((resolve) => pending.push(() => {
          const revision = (before.revision ?? 0) + 1;
          const after: SceneResource = { ...before, revision, scene_revision: revision, antenna_field_solve_stages: submitted as SceneResource["antenna_field_solve_stages"] };
          state.scenes[ownName] = after;
          resolve(json({ transaction_kind: "merge_patch", scene_revision: revision, committed_scene: after }));
        }));
      }
      unexpected.push(`${request.method} ${path}`);
      throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
    },
  });
  const history = new AuthoringHistoryController(api, resources);
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder, authoringHistory: history, commands: { getSessionScopeKey: scope } } as unknown as KernelApi;
  const refresh = () => { state.clock += 1; resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.clock); resources.invalidate(MODEL_SCENE_PATH, `fixture-${state.clock}`); };
  const control: FixtureControl = {
    read: () => ({ calls: structuredClone(calls), pending: pending.length, renders: state.renders, scene: structuredClone(state.scenes[state.name]), scope: scope(), generation: history.getGeneration(), canUndo: history.canUndo(), invalidations, unexpected: [...unexpected] }),
    release: () => { const release = pending.shift(); if (!release) throw new Error("No pending fixture write"); release(); },
    conflict: () => { const before = state.scenes[state.name]; const revision = (before.revision ?? 0) + 1; state.scenes[state.name] = { ...before, revision, scene_revision: revision }; refresh(); },
    // Identity owners change first; do not invalidate the previous session's scene.
    switchSession: (name) => { state.name = name; state.clock += 1; resources.invalidate(SESSIONS_PATH, `owner-${state.clock}`); resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.clock); },
    resetHistory: () => history.clear(),
  };
  return { kernel, control, onRender: () => { state.renders += 1; } };
}

function EditorOwner() {
  const scene = useSceneResource();
  const session = useInspectorEditSession();
  return <>
    <output data-testid="solve-owner">{scene.data?.scene?.id}</output>
    <output data-testid="solve-dirty">{String(session?.dirty ?? false)}</output>
    <div data-testid="solve-editor"><AntennaSolveTargetsEditor objectId={sourceId} stageId={solveId} scene={scene.data} status={scene.status} refetch={scene.refetch} /></div>
    <div style={{ height: 550 }} aria-hidden="true" />
  </>;
}

export default function AntennaSolveTargetsFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, hydrated, serverHydrated);
  useEffect(() => { window.__antennaSolveTargetsFixture = fixture.control; return () => { delete window.__antennaSolveTargetsFixture; }; }, [fixture]);
  return <main style={{ padding: 32, maxWidth: 900 }}>
    <h1>Production antenna solve-target transaction fixture</h1>
    <p>Controlled responses only; no backend solver or production session.</p>
    <label>Persistent unrelated draft <input data-testid="solve-unrelated" defaultValue="untouched" /></label>
    {mounted ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider>
      <div data-testid="solve-scroll" style={{ height: 470, overflow: "auto", border: "1px solid var(--fm-border-subtle)" }}>
        <Profiler id="solve-targets" onRender={fixture.onRender}><EditorOwner /></Profiler>
      </div>
    </InspectorEditSessionProvider></KernelContext.Provider> : <p role="status">Loading fixture…</p>}
  </main>;
}
