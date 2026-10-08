"use client";

import { Profiler, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { DATA_FIELDS_PATH, DATA_QUANTITIES_PATH, MODEL_GEOMETRY_VALIDATION_PATH, MODEL_SCENE_PATH, SESSION_STATUS_PATH, SESSIONS_PATH, SIMULATION_OBJECT_METRICS_PATH, VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource, VisualizationStatePatch, VisualizationStateResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { CameraRegistryController, DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";
import { ObjectVisualizationController, resolveTargetVisualization } from "@/kernel/visualization/ObjectVisualizationController";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import { VisualizationRegistrySyncController } from "@/kernel/visualization/VisualizationRegistrySyncController";
import { VISUALIZATION_TARGET_COMMANDS } from "@/kernel/visualization/visualizationCommandContributions";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import { ObjectGeneralPanel } from "@/modules/inspector/panels/ObjectGeneralPanel";
import { ObjectVisualizationPanel } from "@/modules/inspector/panels/ObjectVisualizationPanel";
import { Button } from "@/shared/ui/Button";

const API_INSTANCE = "55555555-5555-4555-8555-555555555555";
const OBJECT_ID = "immutable-antenna";
const scope = () => sessionRequestScopeKey({ sessionId: "primitive-fixture", sessionEpoch: "primitive-fixture@1", requestScopeEpoch: `${API_INSTANCE}:1` });
const subscribeHydration = () => () => {};
const objectSelection: Selection = { kind: "object.root", objectId: OBJECT_ID, nodeId: `model:object:${OBJECT_ID}`, label: "Golden antenna", moduleSource: "fixture", ref: null };
const airboxSelection: Selection = { kind: "airbox.visualization", objectId: null, nodeId: "model:airbox:visualization", label: "Airbox", moduleSource: "fixture", ref: { type: "airbox", kind: "airbox.visualization", nodeId: "model:airbox:visualization", visualizationTargetId: "airbox" } };
type Call = { method: string; path: string; scope: string | null; body?: VisualizationStatePatch };
interface FixtureControl {
  read(): { calls: Call[]; renders: number; pending: number; pendingWrites: number; unexpected: string[]; settings: ReturnType<typeof resolveTargetVisualization>["settings"]; airboxSettings: ReturnType<typeof resolveTargetVisualization>["settings"] };
  invalidate(): void;
  release(): void;
  releaseWrites(): void;
  solid(enabled: boolean): void;
}
declare global { interface Window { __primitiveColorFixture?: FixtureControl; } }

function makeFixture() {
  const calls: Call[] = [], unexpected: string[] = [], pending: (() => void)[] = [];
  const pendingWrites: (() => void)[] = [];
  const state = { renders: 0, revision: 1, hold: false };
  const scene: SceneResource = { revision: 1, scene_revision: 1, scene: { id: "primitive-fixture", name: "Primitive fixture", authoring_schema: "fixture", source_of_truth: "fixture" }, objects: [{ id: OBJECT_ID, name: "Golden antenna", role: "antenna", geometry: { kind: "Box", size: [1, 1, 1], center: [0, 0, 0] } }] };
  let remote = { revision: 1, overrides: [], camera: DEFAULT_CAMERA_REGISTRY_STATE, layers: { airbox: { visible: true, surface: { visible: true, opacity: 0.2 }, wireframe: { visible: true }, points: { visible: false }, vectors: { visible: false } } } } as unknown as VisualizationStateResource;
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const diagnostics = new RequestDiagnosticsController();
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE } });
  const api = new ControlRoomApi({ baseUrl: "http://primitive-color.fixture.invalid", expectedApiInstance: API_INSTANCE, diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    const body = request.method === "PATCH" ? await request.json() as VisualizationStatePatch : undefined;
    calls.push({ method: request.method, path, scope: request.headers.get("x-fullmag-session-scope"), ...(body ? { body } : {}) });
    if (calls.length > 80) throw new Error("Fixture request budget exceeded");
    if (request.method === "PATCH" && path === VISUALIZATION_STATE_PATH && body && request.headers.get("x-fullmag-session-scope") === scope()) {
      if (Object.keys(body).some(key => key !== "overrides" && key !== "layers")) throw new Error("Unexpected visualization patch field");
      return new Promise<Response>(resolve => pendingWrites.push(() => {
        remote = { ...remote, ...(body.overrides ? { overrides: body.overrides } : {}), ...(body.layers ? { layers: { ...remote.layers, ...body.layers } } : {}), revision: ++state.revision } as VisualizationStateResource;
        resolve(json(remote));
      }));
    }
    if (request.method !== "GET") { unexpected.push(`${request.method} ${path}`); throw new Error("Unexpected fixture mutation"); }
    if (path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: "primitive-fixture", name: "Primitive fixture", current: true, status: "idle" }] });
    if (path === SESSION_STATUS_PATH) return json({ session: { session_id: "primitive-fixture", session_epoch: "primitive-fixture@1", request_scope_epoch: `${API_INSTANCE}:1`, name: "Primitive fixture", created_at: "fixture", workspace_root: "fixture" }, domain: { discretization: "fem" }, capabilities: { explicit_topology: false }, resources: { scene_revision: 1, visualization_revision: remote.revision }, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
    if (request.headers.get("x-fullmag-session-scope") !== scope()) { unexpected.push("unconfirmed scope"); return json({ error: "Unconfirmed fixture scope" }, 409); }
    if (path === MODEL_SCENE_PATH) return json(scene);
    if (path === MODEL_GEOMETRY_VALIDATION_PATH) return json({ revision: 1, issues: [], valid: true });
    if (path === VISUALIZATION_STATE_PATH) {
      if (state.hold) return new Promise<Response>((resolve) => pending.push(() => resolve(json(remote))));
      return json(remote);
    }
    if (path === DATA_FIELDS_PATH) return json({ revision: 1, fields: [] });
    if (path === DATA_QUANTITIES_PATH) return json({ revision: 1, quantities: [] });
    const metricsPrefix = SIMULATION_OBJECT_METRICS_PATH.split("{")[0];
    if (path.startsWith(metricsPrefix)) return json({ error: "No solver sample in controlled fixture" }, 404);
    unexpected.push(`${request.method} ${path}`); throw new Error(`Unexpected fixture request: ${path}`);
  } });
  const visualization = new ObjectVisualizationController();
  const commands = new CommandRegistry(); commands.attach(bus); commands.attachSessionScopeSource({ getScopeKey: scope, subscribe: () => () => {} });
  for (const command of VISUALIZATION_TARGET_COMMANDS) commands.register(command);
  const visualizationSync = new VisualizationRegistrySyncController({ api: api.visualization, resourceCacheScope: api.resourceCacheScope, resources });
  const cameraRegistry = new CameraRegistryController({ api: api.visualization, getSessionScopeKey: scope, idleFlushMs: null });
  const layout = new LayoutController(bus); layout.setActiveTab("geometry");
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder: new DiagnosticRecorderController({ diagnostics }), commands, visualization, visualizationSync, cameraRegistry, layout, selection: new SelectionController(bus), visualizationDebug: new VisualizationDebugController(), authoringHistory: new AuthoringHistoryController(api, resources) } as unknown as KernelApi;
  const target = { kind: "object" as const, id: OBJECT_ID, label: "Golden antenna" };
  const control: FixtureControl = {
    read: () => ({ calls: [...calls], renders: state.renders, pending: pending.length, pendingWrites: pendingWrites.length, unexpected: [...unexpected], settings: resolveTargetVisualization({ snapshot: visualization.getSnapshot(), target, visualizationState: remote }).settings, airboxSettings: resolveTargetVisualization({ snapshot: visualization.getSnapshot(), target: { kind: "airbox", id: "airbox", label: "Airbox" }, visualizationState: remote }).settings }),
    invalidate: () => { state.hold = true; remote = { ...remote, revision: ++state.revision }; resources.invalidate(VISUALIZATION_STATE_PATH, state.revision); },
    release: () => { state.hold = false; if (!pending.length) throw new Error("No pending visualization refetch"); for (const release of pending.splice(0)) release(); },
    releaseWrites: () => { if (!pendingWrites.length) throw new Error("No pending visualization write"); for (const release of pendingWrites.splice(0)) release(); },
    solid: (enabled) => { remote = { ...remote, revision: ++state.revision, overrides: enabled ? [{ scope: "object", scope_id: OBJECT_ID, style: { surface_color_source: "solid", surface_mono_color: "#bbaadd" } }] : [] }; resources.invalidate(VISUALIZATION_STATE_PATH, state.revision); },
  };
  return { kernel, control, onRender: () => { state.renders++; }, airboxColor: () => commands.execute("visualization.target.set-wireframe-color", createCommandContext("inspector", kernel, { visualizationTarget: { kind: "airbox", id: "airbox", label: "Airbox" }, resourceData: { [VISUALIZATION_STATE_PATH]: remote } }), "#abcdef") };
}

export default function PrimitiveColorInspectorFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const [lane, setLane] = useState<"object" | "airbox">("object");
  useEffect(() => { window.__primitiveColorFixture = fixture.control; fixture.kernel.visualizationSync.start(); return () => { fixture.kernel.visualizationSync.stop(); delete window.__primitiveColorFixture; }; }, [fixture]);
  return <main style={{ padding: 24, maxWidth: 750 }}>
    <h1>Production primitive-color Inspector fixture</h1>
    <p>Controlled typed HTTP. No solver, physical field or WebGL qualification.</p>
    <Button onClick={() => setLane("object")}>Object fixture</Button><Button onClick={() => setLane("airbox")}>Airbox fixture</Button>
    <Button data-testid="airbox-local-command" onClick={() => void fixture.airboxColor()}>Canonical Airbox frame-color command</Button>
    {mounted ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider>
      <div data-testid="primitive-scroll" style={{ height: 500, overflow: "auto", border: "1px solid var(--fm-border-subtle)" }}>
        <div data-testid="primitive-inspector" data-lane={lane}>
          <label>Persistent unrelated draft <input data-testid="primitive-unrelated" defaultValue="untouched" /></label>
          <Profiler id="primitive-color" onRender={fixture.onRender}>{lane === "object" ? <ObjectGeneralPanel selection={objectSelection} /> : <ObjectVisualizationPanel selection={airboxSelection} />}</Profiler>
          <div style={{ height: 600 }} aria-hidden="true" />
        </div>
      </div>
    </InspectorEditSessionProvider></KernelContext.Provider> : <p role="status">Loading fixture…</p>}
  </main>;
}
