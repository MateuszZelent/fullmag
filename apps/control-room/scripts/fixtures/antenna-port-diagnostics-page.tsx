"use client";

import { Profiler, useEffect, useMemo, useSyncExternalStore } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_SCENE_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
import type { KnownSceneCurrentTransport, SceneResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { buildObjectExplorerNode } from "@/modules/explorer/builders/objectExplorerNodes";
import { AntennaPortPanel } from "@/modules/inspector/panels/antenna/AntennaCompositionPanels";

const API_INSTANCE = "55555555-5555-4555-8555-555555555555";
const sourceId = "antenna-source", returnId = "antenna-return", portId = "antenna-port";
const subscribeHydration = () => () => {};
const hydrated = () => true, serverHydrated = () => false;
type CaseName = "boundaries" | "missing_transport" | "missing_terminal" | "wrong_object"
  | "observations" | "preparation" | "source_precedence" | "missing_drive" | "ambiguous_transport";
const cases: CaseName[] = ["boundaries", "missing_transport", "missing_terminal", "wrong_object",
  "observations", "preparation", "source_precedence", "missing_drive", "ambiguous_transport"];
interface FixtureControl {
  select(name: CaseName): void;
  read(): { name: CaseName; calls: string[]; unexpected: string[]; renders: number };
}
declare global { interface Window { __antennaPortDiagnosticsFixture?: FixtureControl; } }

function makeScene(name: CaseName, revision: number): SceneResource {
  const terminals = [
    { id: "signal-in", object_id: sourceId }, { id: "signal-out", object_id: sourceId },
    { id: "return-in", object_id: returnId }, { id: "return-out", object_id: returnId },
  ];
  const drive = { id: "drive", port_mode_ref: portId, outer_terminal_currents_a: {} };
  const transport: KnownSceneCurrentTransport = {
    name: "transport", kind: "current_transport", model: "ohmic_poisson",
    domain: [sourceId, returnId].map((object_id) => ({ object_id })),
    boundaries: terminals.map(({ id, object_id }) => ({ id, kind: "voltage_electrode",
      potential_V: 0, surfaces: [{ object_id, surface_id: "terminal", orientation: [1, 0, 0] }] })),
  };
  if (name === "missing_terminal") transport.boundaries = transport.boundaries?.slice(1);
  if (name === "wrong_object" && transport.boundaries) {
    transport.boundaries[0] = { ...transport.boundaries[0], surfaces: [{ object_id: returnId, surface_id: "terminal", orientation: [1, 0, 0] }] };
  }
  if (["observations", "source_precedence", "missing_drive"].includes(name)) {
    transport.conservative_current_source = { kind: "external_lead_current",
      schema_version: "conservative_current_source.v1", revision: "fixture",
      terminal_observations: (name === "source_precedence" ? terminals.slice(1) : terminals)
        .map((terminal) => ({ ...terminal, interface_pair_ids: [] })),
      drives: name === "missing_drive" ? [] : [drive],
    };
    // Stale electrical boundaries must never replace the authored observation namespace.
    if (name === "observations") transport.boundaries = [];
  }
  if (["preparation", "source_precedence"].includes(name)) {
    transport.external_lead_preparation = { schema_version: "antenna_external_lead_preparation.v1",
      kind: "isolated_branch_straight_stubs", revision: "fixture",
      extensions: terminals.map(({ id, object_id }) => ({ id: `lead-${id}`, observation_id: id,
        object_id, boundary_markers: [1], length_m: 1e-6, outward_direction_xyz: [1, 0, 0],
        conductivity_spm: 1e7, layers: 2 })), drives: [drive],
    };
    if (name === "preparation") transport.boundaries = [];
  }
  return {
    revision, scene_revision: revision,
    scene: { id: "session-port-fixture", name: "Port references", authoring_schema: "fixture", source_of_truth: "fixture" },
    objects: [{ id: sourceId, name: "Antenna signal", role: "antenna" }, { id: returnId, name: "Return conductor", role: "conductor" }],
    current_transports: name === "missing_transport" ? [] : name === "ambiguous_transport" ? [transport, structuredClone(transport)] : [transport],
    antenna_port_modes: [{ id: portId, schema_version: "antenna_port_mode.v2",
      source_object_id: sourceId, current_transport_id: "transport", normalization_current_a: 1,
      branches: [{ id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out", signed_weight: 1 },
        { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out", signed_weight: -1 }],
    }],
  };
}

function makeFixture() {
  const state = { name: "missing_transport" as CaseName, revision: 1, renders: 0 };
  const calls: string[] = [], unexpected: string[] = [];
  const bus = new EventBus<KernelEventMap>(), resources = new ResourceInvalidationController(bus);
  const diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const identity = { sessionId: "session-port-fixture", sessionEpoch: "session-port-fixture@1", requestScopeEpoch: `${API_INSTANCE}:1` };
  const scope = sessionRequestScopeKey(identity);
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: {
    "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE,
  } });
  const api = new ControlRoomApi({ baseUrl: "http://antenna-port.fixture.invalid", expectedApiInstance: API_INSTANCE,
    diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (calls.length > 60) throw new Error("Port diagnostic fixture request budget exceeded");
      if (request.method === "GET" && path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [
        { session_id: identity.sessionId, name: "Port references", current: true, status: "idle" },
      ] });
      if (request.method === "GET" && path === SESSION_STATUS_PATH) return json({
        session: { session_id: identity.sessionId, session_epoch: identity.sessionEpoch,
          request_scope_epoch: identity.requestScopeEpoch, name: "fixture", created_at: "fixture", workspace_root: "fixture" },
        resources: { scene_revision: state.revision }, capabilities: {},
        lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" },
      });
      if (request.method === "GET" && path === MODEL_SCENE_PATH && request.headers.get("x-fullmag-session-scope") === scope) {
        return json(makeScene(state.name, state.revision));
      }
      unexpected.push(`${request.method} ${path}`);
      throw new Error(`Unexpected diagnostic fixture request: ${request.method} ${path}`);
    } });
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder } as unknown as KernelApi;
  const control: FixtureControl = {
    select(name) {
      if (!cases.includes(name)) throw new Error("Unknown diagnostic fixture case");
      state.name = name; state.revision += 1;
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.revision);
      resources.invalidate(MODEL_SCENE_PATH, state.revision);
    },
    read: () => ({ name: state.name, calls: [...calls], unexpected: [...unexpected], renders: state.renders }),
  };
  return { kernel, control, onRender: () => { state.renders += 1; } };
}

const selection: Selection = {
  kind: "object.antenna.port", label: `Port ${portId}`, moduleSource: "explorer",
  nodeId: `object:${sourceId}:antenna:port:${portId}`, objectId: sourceId,
  ref: { kind: "object.antenna.port", nodeId: `object:${sourceId}:antenna:port:${portId}`,
    objectId: sourceId, type: "scene-object", visualizationTargetId: `object:${sourceId}`,
    antennaResourceId: portId, antennaResourceKind: "port" },
};

function PortOwner() {
  const scene = useSceneResource();
  const node = buildObjectExplorerNode({ id: sourceId, label: "Antenna signal", objectRole: "antenna" } as never, { scene: scene.data });
  const port = node.children?.find((item) => item.kind === "object.antenna")?.children?.find((item) => item.kind === "object.antenna.port");
  return <>
    <output data-testid="scene-revision">{scene.data?.revision ?? "loading"}</output>
    <output data-testid="explorer-port-status">{port?.status ?? "loading"}</output>
    <output data-testid="explorer-port-badge">{port?.badge ?? "loading"}</output>
    <section data-testid="port-inspector"><AntennaPortPanel selection={selection} /></section>
  </>;
}

export default function AntennaPortDiagnosticsFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, hydrated, serverHydrated);
  useEffect(() => { window.__antennaPortDiagnosticsFixture = fixture.control; return () => { delete window.__antennaPortDiagnosticsFixture; }; }, [fixture]);
  return <main style={{ padding: 32, maxWidth: 900 }}>
    <h1>Production antenna port reference diagnostics</h1>
    <p>Controlled HTTP fixture. Reference checks only: no native solve, mesh closure, field or physics qualification.</p>
    <label>Unrelated draft <input data-testid="port-unrelated" defaultValue="untouched" /></label>
    {mounted ? <KernelContext.Provider value={fixture.kernel}>
      <Profiler id="port-diagnostics" onRender={fixture.onRender}><PortOwner /></Profiler>
    </KernelContext.Provider> : <p role="status">Loading fixture…</p>}
  </main>;
}
