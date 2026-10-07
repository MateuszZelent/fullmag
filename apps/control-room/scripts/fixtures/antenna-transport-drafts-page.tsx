"use client";

import { Profiler, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_CURRENT_TRANSPORTS_PATH, MODEL_SCENE_PATH, MODEL_TRANSPORT_VALIDATION_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
import type { CurrentTransportMutationRequest, KnownSceneCurrentTransport, SceneResource, TransportValidationRequest, TransportValidationResponse } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { CURRENT_TRANSPORTS_RESOURCE_KEY } from "@/kernel/resources/spinAuthoringResources";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { KernelApi } from "@/kernel/types";
import { isKnownCurrentTransport } from "@/shared/domain/physics/transportRecognition";
import { TransportAuthoringInspector } from "@/modules/inspector/panels/TransportAuthoringInspector";
import { InspectorEditSessionProvider, useInspectorEditSession } from "@/modules/inspector/InspectorEditSession";

const TRANSPORT_ID = "fixture-current";
const API_INSTANCE = "33333333-3333-4333-8333-333333333333";
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
const clientCreateMode = () => new URLSearchParams(window.location.search).get("mode") === "create";
const clientDeleteMode = () => new URLSearchParams(window.location.search).get("mode") === "delete";
const clientLocalMode = () => new URLSearchParams(window.location.search).get("selection") === "local";

interface Call { method: string; path: string; scope: string | null; revision: number; body: unknown; }
interface FixtureControl {
  read(): { calls: Call[]; pendingWrites: number; pendingReads: number; renderCommits: number; revision: number; exists: boolean; resource: KnownSceneCurrentTransport; unexpected: string[]; invalidations: { resourceKey: string; revision: unknown }[] };
  releaseWrite(): void;
  refreshUnrelated(): void;
  refreshConflict(): void;
  rejectNextWrite(): void;
  releaseRead(): void;
  advanceNextHistoryRead(): void;
  restoreTransport(): void;
}
declare global { interface Window { __antennaTransportFixture?: FixtureControl; } }

function makeFixture(createMode: boolean, deleteMode: boolean) {
  const initial: KnownSceneCurrentTransport = {
    kind: "current_transport", name: TRANSPORT_ID, model: "ohmic_poisson", coupling: "one_way",
    domain: [{ object_id: "fixture-conductor" }],
    materials: [{ region: { object_id: "fixture-conductor" }, material: { sigma_Spm: 5.8e7 } }],
    boundaries: [], gauge: "zero_mean",
    solver: { engine: "cg", linear: { absolute_tolerance: 1e-14, relative_tolerance: 1e-10, max_iterations: 1000 }, operator_version: "fv_charge_harmonic_source_cut_v1", physical_residual_version: "charge_balance_integrated_l2.v1" },
    structured_current_closure: {
      closure_id: "fixture-closed-geometry", kind: "closed_geometry", schema_version: "structured_current_closure.v1",
      source_cuts: [1, 2, 3].map((ordinal) => ({
        source_cut_id: `source-cut-${ordinal}`, circuit_id: `circuit-${ordinal}`,
        region: { object_id: "fixture-conductor" },
        plane: { axis: "x" as const, normal: "positive_axis" as const, offset_m: ordinal * 1e-7 },
        drive: { kind: "impressed_potential_jump" as const, schema_version: "impressed_potential_jump.v1", drive_id: `drive-${ordinal}`, potential_jump_V: ordinal / 10 },
      })),
    },
  };
  const state = { resource: initial, exists: !createMode, revision: 1, renderCommits: 0, holdReads: false, rejectWrite: false, advanceHistoryRead: false };
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const invalidations: { resourceKey: string; revision: unknown }[] = [];
  const pendingWrites: (() => void)[] = [];
  const pendingReads: (() => void)[] = [];
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  bus.on("resource:invalidated", (event) => invalidations.push({ resourceKey: event.resourceKey, revision: event.revision }));
  const diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const owner = { session_id: "session-antenna-transport-fixture", session_epoch: "session-antenna-transport-fixture@31", request_scope_epoch: `${API_INSTANCE}:1` };
  const expectedScope = sessionRequestScopeKey({ sessionId: owner.session_id, sessionEpoch: owner.session_epoch, requestScopeEpoch: owner.request_scope_epoch });
  const scene = (): SceneResource => ({ revision: state.revision, scene_revision: state.revision, objects: [{ id: "fixture-conductor", name: "Fixture conductor" }], current_transports: state.exists ? [structuredClone(state.resource)] : [] });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE } });
  const capability = { authoring_allowed: true, reason: "Controlled authoring fixture; runtime and science are not qualified.", status: "semantic_only" };
  const unsupported = { authoring_allowed: false, reason: "This fixed fixture covers only one-way steady authoring.", status: "unsupported" };
  const api = new ControlRoomApi({
    baseUrl: "http://antenna-transport.fixture.invalid", expectedApiInstance: API_INSTANCE, diagnostics, maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body: unknown = ["POST", "PATCH", "DELETE"].includes(request.method) ? await request.json() : null;
      if (calls.length >= 150) throw new Error("Fixture request budget exceeded");
      const scope = request.headers.get("x-fullmag-session-scope");
      calls.push({ method: request.method, path, scope, revision: state.revision, body });
      const isModel = path === MODEL_SCENE_PATH || path === MODEL_CURRENT_TRANSPORTS_PATH || path === MODEL_TRANSPORT_VALIDATION_PATH || path === `${MODEL_CURRENT_TRANSPORTS_PATH}/${state.resource.name}`;
      if (scope && scope !== expectedScope || isModel && scope !== expectedScope) {
        unexpected.push("missing or foreign confirmed session scope");
        return json({ error: "Confirmed fixture owner scope is required", code: "request_context_stale" }, 409);
      }
      if (request.method === "GET" && path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: owner.session_id, name: "Transport fixture", current: true, status: "idle" }] });
      if (request.method === "GET" && path === SESSION_STATUS_PATH) return json({ api_contract_version: "1.0.0", runtime_bundle_version: "fixture", session: { ...owner, name: "Transport fixture", created_at: "fixture", workspace_root: "fixture" }, resources: { scene_revision: state.revision }, capabilities: { transport_authoring: { contract_version: "transport-authoring-capabilities.v1", gpu: unsupported, hybrid: unsupported, m1_one_way_steady: capability, m2_reciprocal: unsupported, m3_transient: unsupported, single_precision: unsupported } }, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
      if (request.method === "GET" && path === MODEL_SCENE_PATH && deleteMode) {
        if (state.advanceHistoryRead) {
          state.advanceHistoryRead = false;
          if (!state.resource.solver) throw new Error("Fixture solver is absent");
          state.revision += 1;
          state.resource = { ...state.resource, solver: { ...state.resource.solver,
            linear: { ...state.resource.solver.linear, max_iterations: 1600 } } };
          state.holdReads = true;
        }
        return json(scene());
      }
      if (request.method === "GET" && path === MODEL_CURRENT_TRANSPORTS_PATH) {
        const snapshot = { items: state.exists ? [structuredClone(state.resource)] : [], scene_revision: state.revision };
        if (!state.holdReads) return json(snapshot);
        return new Promise<Response>((resolve) => pendingReads.push(() => resolve(json(snapshot))));
      }
      if (request.method === "POST" && path === MODEL_TRANSPORT_VALIDATION_PATH) {
        const validation = body as TransportValidationRequest;
        const candidate = validation.candidate;
        const validAddress = candidate.kind === "current_transport" && (candidate.operation === "create"
          ? (candidate.path_id ?? null) === null
          : candidate.operation === "replace" && state.exists && candidate.path_id === state.resource.name);
        if (validation.validation_version !== "transport-authoring-validation.v1" || validation.candidate.kind !== "current_transport" || !validAddress) {
          unexpected.push("invalid clone-only validation envelope");
          return json({ error: "Invalid fixed fixture validation", code: "invalid_request" }, 422);
        }
        const response: TransportValidationResponse = {
          validation_version: validation.validation_version, scene_revision: state.revision,
          semantic: { valid: true, issues: [] },
          execution: { authoring_allowed: true, qualification: "semantic_only", status: "semantic_only", reason: "Fixture response only: no native execution, current solve or physical validation." },
        };
        return json(response);
      }
      if (request.method === "DELETE" && path === `${MODEL_CURRENT_TRANSPORTS_PATH}/${state.resource.name}`) {
        const transaction = body as { base_revision: number };
        if (state.rejectWrite) {
          state.rejectWrite = false;
          state.revision += 1;
          state.holdReads = true;
          return json({ error: "Scene changed during transport delete", code: "revision_conflict" }, 409);
        }
        if (!state.exists || transaction.base_revision !== state.revision
          || Object.keys(transaction).length !== 1) {
          unexpected.push("invalid transport delete");
          return json({ error: "Invalid fixed fixture delete", code: "revision_conflict" }, 409);
        }
        return new Promise<Response>((resolve) => pendingWrites.push(() => {
          state.revision += 1;
          state.exists = false;
          state.holdReads = true;
          resolve(json({ resource: structuredClone(state.resource), scene_revision: state.revision, committed_scene: scene() }));
        }));
      }
      const creating = request.method === "POST" && path === MODEL_CURRENT_TRANSPORTS_PATH;
      if (creating || request.method === "PATCH" && path === `${MODEL_CURRENT_TRANSPORTS_PATH}/${state.resource.name}`) {
        const transaction = body as CurrentTransportMutationRequest;
        if (state.rejectWrite) {
          state.rejectWrite = false;
          if (!state.resource.solver) throw new Error("Fixture solver is absent");
          state.revision += 1;
          state.resource = { ...state.resource, solver: { ...state.resource.solver,
            linear: { ...state.resource.solver.linear, max_iterations: 1500 } } };
          state.holdReads = true;
          return json({ error: "Scene changed during transport commit", code: "revision_conflict" }, 409);
        }
        if (!isKnownCurrentTransport(transaction.resource) || transaction.base_revision !== state.revision
          || creating === state.exists || !transaction.resource.name
          || !creating && transaction.resource.name !== state.resource.name
          || transaction.resource.model !== "ohmic_poisson" || transaction.resource.coupling !== "one_way" || transaction.resource.solver?.engine !== "cg") {
          unexpected.push("invalid transport transaction");
          return json({ error: "Invalid fixed fixture transaction", code: "revision_conflict" }, 409);
        }
        const submitted = structuredClone(transaction.resource) as KnownSceneCurrentTransport;
        return new Promise<Response>((resolve) => pendingWrites.push(() => {
          state.revision += 1;
          state.resource = submitted;
          state.exists = true;
          if (creating) state.holdReads = true;
          resolve(json({ resource: structuredClone(submitted), scene_revision: state.revision, committed_scene: scene() }));
        }));
      }
      unexpected.push(`${request.method} ${path}`);
      throw new Error(`Unexpected fixture transport: ${request.method} ${path}`);
    },
  });
  // Only immutable services are injected; production hooks own their resources.
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder,
    ...(deleteMode ? { authoringHistory: new AuthoringHistoryController(api, resources) } : {}),
    commands: { getSessionScopeKey: () => expectedScope } } as unknown as KernelApi;
  const refresh = (conflict: boolean) => {
    if (!state.resource.solver) throw new Error("Fixture solver is absent");
    state.revision += 1;
    state.resource = { ...state.resource, solver: { ...state.resource.solver, linear: { ...state.resource.solver.linear, ...(conflict ? { relative_tolerance: 1e-8 } : { max_iterations: 1400 }) } } };
    state.holdReads = true;
    resources.invalidate(CURRENT_TRANSPORTS_RESOURCE_KEY, state.revision);
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.revision);
  };
  const control: FixtureControl = {
    read: () => ({ calls: structuredClone(calls), pendingWrites: pendingWrites.length, pendingReads: pendingReads.length, renderCommits: state.renderCommits, revision: state.revision, exists: state.exists, resource: structuredClone(state.resource), unexpected: [...unexpected], invalidations: [...invalidations] }),
    releaseWrite: () => { const release = pendingWrites.shift(); if (!release) throw new Error("No fixture write is pending"); release(); },
    refreshUnrelated: () => refresh(false),
    refreshConflict: () => refresh(true),
    rejectNextWrite: () => { state.rejectWrite = true; },
    releaseRead: () => { state.holdReads = false; for (const release of pendingReads.splice(0)) release(); },
    advanceNextHistoryRead: () => { state.advanceHistoryRead = true; },
    restoreTransport: () => {
      if (state.exists || !state.resource.solver) throw new Error("Fixture transport is not deleted");
      state.exists = true;
      state.revision += 1;
      state.resource = { ...state.resource, solver: { ...state.resource.solver,
        linear: { ...state.resource.solver.linear, max_iterations: 1700 } } };
      state.holdReads = true;
      resources.invalidate(CURRENT_TRANSPORTS_RESOURCE_KEY, state.revision);
      resources.invalidate(MODEL_SCENE_PATH, state.revision);
    },
  };
  return { kernel, control, onRender: () => { state.renderCommits += 1; } };
}

function FixtureDiscardDraft() {
  const session = useInspectorEditSession();
  return <button data-testid="antenna-transport-discard" disabled={!session || session.applying || !session.dirty} onClick={() => void session?.reset()}>Discard fixture draft</button>;
}

function FixtureSceneWitness() {
  const scene = useSceneResource();
  return <output data-testid="antenna-transport-scene-witness">{JSON.stringify({ revision: scene.data?.scene_revision, count: scene.data?.current_transports?.length })}</output>;
}

export default function AntennaTransportDraftsFixturePage() {
  const createMode = useSyncExternalStore(subscribeHydration, clientCreateMode, serverHydrated);
  const deleteMode = useSyncExternalStore(subscribeHydration, clientDeleteMode, serverHydrated);
  const localMode = useSyncExternalStore(subscribeHydration, clientLocalMode, serverHydrated);
  const selectable = createMode || localMode;
  const fixture = useMemo(() => makeFixture(createMode, deleteMode), [createMode, deleteMode]);
  const [objectId, setObjectId] = useState("fixture-conductor");
  const [resourceIndex, setResourceIndex] = useState(0);
  const createScope = useMemo(() => ({ objectId }), [objectId]);
  const mounted = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated);
  useEffect(() => { window.__antennaTransportFixture = fixture.control; return () => { delete window.__antennaTransportFixture; }; }, [fixture]);
  return <main className="fm-antenna-transport-fixture" style={{ padding: 32, maxWidth: 940 }}>
    <h1>Fullmag structured current authoring fixture</h1>
    <p>Production transport Inspector, typed API and resource hooks; controlled responses only. No backend, mesh/current solve or scientific qualification.</p>
    {mounted ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider>
      {deleteMode ? <FixtureSceneWitness /> : null}
      {selectable ? <button data-testid="antenna-transport-switch-scope" onClick={() => setObjectId((current) => current === "fixture-conductor" ? "fixture-other" : "fixture-conductor")}>Switch fixture object scope ({objectId})</button> : null}
      {!selectable ? <button data-testid="antenna-transport-change-index" onClick={() => setResourceIndex((current) => current + 1)}>Change fixture address index</button> : <FixtureDiscardDraft />}
      <label>Persistent unrelated control <input data-testid="antenna-transport-unrelated" defaultValue="stable unrelated draft" /></label>
      <div data-testid="antenna-transport-scroll" style={{ height: 650, overflow: "auto", padding: 16, border: "1px solid var(--fm-border-subtle)" }}>
        <div data-testid="antenna-transport-editor"><Profiler id="antenna-transport" onRender={fixture.onRender}><TransportAuthoringInspector family="current_transport" resourceId={selectable ? undefined : TRANSPORT_ID} resourceIndex={selectable ? undefined : resourceIndex} initialScope={selectable ? createScope : null} /></Profiler></div>
      </div>
    </InspectorEditSessionProvider></KernelContext.Provider> : <p role="status">Loading fixture harness…</p>}
  </main>;
}
