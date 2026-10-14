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
import { SolvedAntennaDriveEditor } from "@/modules/inspector/panels/antenna/SolvedAntennaDriveEditor";

const API_INSTANCE = "66666666-6666-4666-8666-666666666666";
const driveId = "drive-a";
const subscribeHydration = () => () => {};
const hydrated = () => true, serverHydrated = () => false;
type Call = { method: string; path: string; scope: string | null; body: unknown };
interface FixtureControl {
  read(): { calls: Call[]; pending: number; renders: number; scene: SceneResource; canUndo: boolean; invalidations: number; unexpected: string[] };
  release(): void;
  rejectNext(): void;
  malformedNext(kind?: "amplitude" | "scene_revision"): void;
  switchSession(name: "A" | "B"): void;
  resetHistory(): void;
  switchDrive(id: "drive-a" | "drive-b"): void;
  subscribeDrive(listener: () => void): () => void;
  readDrive(): string;
}
declare global { interface Window { __antennaDriveEditorFixture?: FixtureControl; } }

function makeScene(name: string): SceneResource {
  const drive: NonNullable<SceneResource["solved_antenna_drives"]>[number] = { id: driveId, name: "Fixture drive", port_mode_id: "fixture-port", projection_ref: "fixture-projection", time_origin: "stage_local", peak_current_a: 1, waveform: { kind: "constant" }, activation: { kind: "all_time_evolution" }, bandwidth_declaration: null };
  return { revision: 1, scene_revision: 1, scene: { id: `session-${name}`, name, authoring_schema: "fixture", source_of_truth: "fixture" },
    objects: [], solved_antenna_drives: [drive, { ...drive, id: "drive-b" }] } as SceneResource;
}

function makeFixture() {
  let activeDrive = driveId;
  const driveListeners = new Set<() => void>();
  const state = { name: "A" as "A" | "B", clock: 1, scenes: { A: makeScene("A"), B: makeScene("B") }, renders: 0, reject: false, malformed: null as "amplitude" | "scene_revision" | null };
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
  const api = new ControlRoomApi({ baseUrl: "http://antenna-drive-editor.fixture.invalid", expectedApiInstance: API_INSTANCE,
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
        if (body.base_revision !== before.revision || JSON.stringify(Object.keys(body.merge_patch)) !== '["solved_antenna_drives"]') {
          unexpected.push("invalid drive transaction"); return json({ error: "Scene changed", code: "revision_conflict" }, 409);
        }
        if (state.reject) { state.reject = false; return json({ error: "Injected drive revision conflict", code: "revision_conflict" }, 409); }
        const drives = structuredClone(body.merge_patch.solved_antenna_drives) as SceneResource["solved_antenna_drives"];
        const malformed = state.malformed; state.malformed = null;
        return new Promise<Response>((resolve) => pending.push(() => {
          if (state.scenes[name].revision !== before.revision) { resolve(json({ error: "Scene changed", code: "revision_conflict" }, 409)); return; }
          const revision = (before.revision ?? 0) + 1;
          const after = { ...before, revision, scene_revision: revision, solved_antenna_drives: drives };
          state.scenes[name] = after;
          const acknowledgement = structuredClone(after);
          if (malformed === "amplitude" && acknowledgement.solved_antenna_drives) acknowledgement.solved_antenna_drives[0].peak_current_a = 2;
          if (malformed === "scene_revision") acknowledgement.revision = revision + 1;
          resolve(json({ transaction_kind: "merge_patch", scene_revision: revision, committed_scene: acknowledgement }));
        }));
      }
      unexpected.push(`${request.method} ${path}`); throw new Error(`Unexpected drive request: ${request.method} ${path}`);
    } });
  const history = new AuthoringHistoryController(api, resources);
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder, authoringHistory: history, commands: { getSessionScopeKey: scope } } as unknown as KernelApi;
  const control: FixtureControl = {
    read: () => ({ calls: structuredClone(calls), pending: pending.length, renders: state.renders, scene: structuredClone(state.scenes[state.name]), canUndo: history.canUndo(), invalidations, unexpected: [...unexpected] }),
    release: () => { const release = pending.shift(); if (!release) throw new Error("No pending drive write"); release(); },
    rejectNext: () => { state.reject = true; },
    malformedNext: (kind = "amplitude") => { state.malformed = kind; },
    switchSession: (name) => { state.name = name; state.clock += 1; resources.invalidate(SESSIONS_PATH, state.clock); resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.clock); },
    resetHistory: () => history.clear(),
    switchDrive: (id) => { activeDrive = id; for (const listener of driveListeners) listener(); },
    subscribeDrive: (listener) => { driveListeners.add(listener); return () => { driveListeners.delete(listener); }; },
    readDrive: () => activeDrive,
  };
  return { kernel, control, onRender: () => { state.renders += 1; } };
}

function EditorOwner({ control }: { control: FixtureControl }) {
  const scene = useSceneResource(), session = useInspectorEditSession();
  const activeDrive = useSyncExternalStore(control.subscribeDrive, control.readDrive, () => driveId);
  return <>
    <output data-testid="drive-owner">{scene.data?.scene?.id}</output>
    <output data-testid="drive-dirty">{String(session?.dirty ?? false)}</output>
    <section data-testid="drive-editor" data-resource-status={scene.status} data-drive-id={activeDrive}><SolvedAntennaDriveEditor driveId={activeDrive} scene={scene.data} status={scene.status} refetch={scene.refetch} /></section>
    <div style={{ height: 550 }} aria-hidden="true" />
  </>;
}

export default function AntennaDriveEditorFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, hydrated, serverHydrated);
  useEffect(() => { window.__antennaDriveEditorFixture = fixture.control; return () => { delete window.__antennaDriveEditorFixture; }; }, [fixture]);
  return <main style={{ padding: 32, maxWidth: 900 }}>
    <h1>Production antenna drive editor</h1><p>Controlled HTTP authoring fixture, not native current closure or field qualification.</p>
    <label>Unrelated draft <input data-testid="drive-unrelated" defaultValue="untouched" /></label>
    {mounted ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider>
      <div data-testid="drive-scroll" style={{ height: 470, overflow: "auto", border: "1px solid var(--fm-border-subtle)" }}>
        <Profiler id="drive-editor" onRender={fixture.onRender}><EditorOwner control={fixture.control} /></Profiler>
      </div>
    </InspectorEditSessionProvider></KernelContext.Provider> : <p role="status">Loading fixture…</p>}
  </main>;
}
