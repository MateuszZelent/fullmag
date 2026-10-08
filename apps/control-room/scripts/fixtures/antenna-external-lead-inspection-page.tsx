"use client";

import { Profiler, useEffect, useMemo, useSyncExternalStore } from "react";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import {
  DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH,
  DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH,
  SESSION_STATUS_PATH, SESSIONS_PATH, SIMULATION_STAGES_EXECUTION_PATH,
} from "@/kernel/api/apiPaths";
import type { AntennaExternalLeadInspectionResource, StageExecutionResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { KernelApi } from "@/kernel/types";
import { AntennaExternalLeadInspectionPanel } from "@/modules/inspector/panels/antenna/AntennaExternalLeadInspectionPanel";

const AUTHORED_STAGE = "authored-antenna-solve";
const RUNTIME_STAGE = "runtime-stage-009";
const SECOND_RUNTIME_STAGE = "duplicate-stage-010";
const API_INSTANCE = "11111111-1111-4111-8111-111111111111";
const DIGEST = `sha256:${"a".repeat(64)}`;
const digestFor = (stageId: string) => stageId === SECOND_RUNTIME_STAGE ? `sha256:${"c".repeat(64)}` : DIGEST;
const SAMPLE_COUNT = 32;
const FULL_BYTES = SAMPLE_COUNT * 3 * 8;
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
const SCENARIOS = ["success", "failed", "cancelled", "mismatch", "multiple", "stale_owner", "stale_metadata", "unavailable", "error"] as const;
type Scenario = typeof SCENARIOS[number];
interface Call { path: string; scope: string | null; range: string | null; digest: string | null; status: number; revision: number; runId: string; }
interface FixtureControl {
  read(): { calls: Call[]; pending: number; renderCommits: number; scenario: string; requestScopeEpoch: string; runId: string; revision: number; unexpected: string[] };
  release(): void;
  setScenario(scenario: Scenario): void;
  refresh(): void;
  nextRun(): void;
  previousRun(): void;
  holdStage(stageId: string): void;
  releaseStage(stageId: string): void;
}
declare global { interface Window { __antennaInspectionFixture?: FixtureControl; } }

function makeFixture() {
  const state = { scenario: "success" as Scenario, revision: 1, incarnation: 1, run: 1, hold: true, renderCommits: 0 };
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const pending = new Map<number, { stageId: string; release(): void; cancel(): void }>();
  const heldStages = new Set<string>();
  let requestSequence = 0;
  const runId = () => state.run === 1 ? "fixture-run" : `fixture-run-${state.run}`;
  const owner = () => ({
    session_id: "session-antenna-fixture", session_epoch: "session-antenna-fixture@17:tombstone:0",
    request_scope_epoch: `${API_INSTANCE}:${state.incarnation}`,
  });
  const headers = () => ({ "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...headers(), "content-type": "application/json" },
  });
  const execution = (): StageExecutionResource => {
    const mapped = {
      stage_id: RUNTIME_STAGE, antenna_solve_stage_id: AUTHORED_STAGE, index: 1,
      status: state.scenario === "failed" || state.scenario === "cancelled" ? state.scenario : "completed",
      converged: false, kind: "study_pipeline_antenna_field_solve", label: "Same visible label", artifact_refs: [],
    };
    const stages = [{ ...mapped, stage_id: "unrelated-stage-000", antenna_solve_stage_id: "different-definition", index: 0 }, mapped];
    if (state.scenario === "unavailable") stages.pop();
    if (state.scenario === "multiple") stages.push({ ...mapped, stage_id: SECOND_RUNTIME_STAGE, index: 2 });
    return {
      ...owner(), run_id: runId(), revision: state.revision, runtime_state: "completed",
      total_stages: stages.length, stages, stage_statuses: stages.map((stage) => stage.status), completed_stage_indexes: [],
      ...(state.scenario === "stale_owner" ? { request_scope_epoch: `${API_INSTANCE}:${state.incarnation - 1}` } : {}),
    };
  };
  const inspection = (runtimeStageId: string): AntennaExternalLeadInspectionResource => {
    const descriptor = (kind: string, unit: string, count = SAMPLE_COUNT * 3) => ({
      path: `antenna/external_lead_solutions/fixture/${runtimeStageId}/${kind}.bin`, sha256: `sha256:${"b".repeat(64)}`,
      value_count: count, byte_count: count * 8, scalar_type: "float64_le", layout: "sample_xyz_interleaved", unit,
    });
    const status = state.scenario === "failed" || state.scenario === "cancelled" ? state.scenario : "inspection_only";
    const stageId = state.scenario === "mismatch" ? "foreign-authored-stage" : AUTHORED_STAGE;
    return {
      ...owner(), run_id: runId(), resource_id: `antenna/external-lead-inspection/${runtimeStageId}`,
      runtime_stage_id: runtimeStageId, stage_revision: state.revision,
      record_content_digest: `sha256:${state.revision.toString(16).padStart(64, "0")}`,
      schema_version: "antenna_external_lead_stage_output.v1", stage_kind: "antenna_field_solve",
      resolved_action: "external_lead_inspection", stage_id: stageId, port_mode_id: "fixture-port", output_id: "fixture-output",
      status, qualification: "NOT VERIFIED", field_scope: "external_electrode_truncation",
      ...(status !== "inspection_only" ? { diagnostic: `Fixture ${status}; native solve not executed.` } : {}),
      ...(state.scenario === "stale_metadata" ? { request_scope_epoch: `${API_INSTANCE}:${state.incarnation - 1}` } : {}),
      outputs: status === "inspection_only" ? [{
        kind: "antenna_external_lead_inspection", manifest_ref: `antenna/external_lead_solutions/fixture/${runtimeStageId}/manifest.v1.json`,
        inspection_ref: { stage_id: stageId, output_id: "fixture-output", content_digest: digestFor(runtimeStageId) },
        payload_units: { V: "V", RT0_coefficients: "A", H: "A/m", positions: "m" }, reused_existing: false,
      }] : [],
      manifest: status === "inspection_only" ? {
        schema_version: "antenna_external_lead_solution.v1", content_digest: digestFor(runtimeStageId),
        source_object_id: "fixture-conductor", current_transport_id: "fixture-transport", drive_id: "fixture-drive",
        closure_revision: "fixture-closure", validation_scope: "manifest_only",
        requested_execution: { backend: "fem", device: "cpu", precision: "double" },
        resolved_execution: { backend: "fem", device: "cpu", precision: "double" }, input_pins: {}, solver_policy: {},
        charge_content_sha256: "fixture-charge", field_content_sha256: "fixture-field", source_content_sha256: "fixture-source",
        sampling_carrier: { domain: { kind: "global" }, carrier_kind: "mesh_nodes", location: "node", sample_count: SAMPLE_COUNT, topology_digest: "fixture-topology" },
        bundle: { ...descriptor("bundle", "1", FULL_BYTES), byte_count: FULL_BYTES, scalar_type: "ordered_binary_v1", layout: "accepted_external_lead_bundle.ordered.v1" },
        sample_positions: descriptor("sample_positions", "m"), magnetic_field: descriptor("magnetic_field", "A/m"),
        device_vertex_ids: { ...descriptor("device_vertex_ids", "1", 4), scalar_type: "uint64_le", layout: "authored_device_vertex_order" },
        device_potential: { ...descriptor("device_potential", "V", 4), layout: "authored_device_vertex_order" },
      } : null,
    };
  };
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const stagePaths = [RUNTIME_STAGE, SECOND_RUNTIME_STAGE].map((stageId) => ({
    stageId,
    metadataPath: DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH.replace("{stage_id}", stageId),
    payloadPrefix: DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH.replace("{stage_id}", stageId).split("{payload_kind}")[0],
  }));
  const api = new ControlRoomApi({
    baseUrl: "http://antenna.fixture.invalid", expectedApiInstance: API_INSTANCE, diagnostics, maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (calls.length >= 200) throw new Error("Fixture request budget exceeded");
      const call: Call = { path: url.pathname, scope: request.headers.get("x-fullmag-session-scope"), range: request.headers.get("range"), digest: url.searchParams.get("content_digest"), status: 200, revision: state.revision, runId: runId() };
      calls.push(call);
      if (request.method !== "GET") { unexpected.push(request.method); throw new Error("Read-only inspection submitted a mutation"); }
      const identity = owner();
      const expectedScope = sessionRequestScopeKey({ sessionId: identity.session_id, sessionEpoch: identity.session_epoch, requestScopeEpoch: identity.request_scope_epoch });
      if (call.scope && call.scope !== expectedScope) {
        call.status = 409;
        return json({ error: "Stale fixture owner", code: "request_context_stale" }, 409);
      }
      if (url.pathname === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: identity.session_id, name: "Antenna fixture", status: "completed", current: true }] });
      // This fixture supplies only the thin status fields consumed by the real
      // identity/revision selectors; it is not a backend or numerical bundle.
      if (url.pathname === SESSION_STATUS_PATH) return json({
        api_contract_version: "1.0.0", runtime_bundle_version: "fixture", session: { ...identity, name: "Antenna fixture", created_at: "fixture", workspace_root: "fixture" },
        resources: { stages_revision: state.revision }, capabilities: {}, lifecycle: { solver: "completed", session_resource: "tombstoned", connectivity: "connected", commandability: "read_only" },
      });
      if (url.pathname === SIMULATION_STAGES_EXECUTION_PATH) return json(execution());
      const route = stagePaths.find((entry) => url.pathname === entry.metadataPath || url.pathname.startsWith(entry.payloadPrefix));
      if (route && url.pathname === route.metadataPath) {
        if (state.scenario === "error") { call.status = 422; return json({ error: "Invalid fixture record", code: "invalid_antenna_inspection" }, 422); }
        const captured = inspection(route.stageId);
        const ignoreAbort = heldStages.has(route.stageId);
        if (!state.hold && !ignoreAbort) return json(captured);
        return new Promise<Response>((resolve, reject) => {
          const sequence = ++requestSequence;
          const onAbort = () => { if (!ignoreAbort) cancel(); };
          const cancel = () => { pending.delete(sequence); request.signal.removeEventListener("abort", onAbort); reject(new DOMException("Aborted", "AbortError")); };
          const release = () => { pending.delete(sequence); request.signal.removeEventListener("abort", onAbort); resolve(json(captured)); };
          pending.set(sequence, { stageId: route.stageId, release, cancel });
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (route && url.pathname.startsWith(route.payloadPrefix)) {
        const kind = url.pathname.slice(route.payloadPrefix.length);
        if (!["sample_positions", "magnetic_field"].includes(kind) || call.range !== "bytes=0-191" || call.digest !== digestFor(route.stageId) || !["success", "multiple"].includes(state.scenario)) {
          unexpected.push(`unbounded/foreign payload: ${kind}`);
          call.status = 422;
          return json({ error: "Unexpected inspection payload", code: "invalid_antenna_inspection" }, 422);
        }
        const bytes = new ArrayBuffer(192);
        const values = new DataView(bytes);
        const fieldOffset = route.stageId === SECOND_RUNTIME_STAGE ? 1000 : 0;
        for (let index = 0; index < 24; index += 1) values.setFloat64(index * 8, kind === "sample_positions" ? index * 1e-9 : index + 1 + fieldOffset, true);
        call.status = 206;
        return new Response(bytes, { status: 206, headers: { ...headers(), "content-type": "application/octet-stream", "content-length": "192", "content-range": `bytes 0-191/${FULL_BYTES}`, etag: `"fixture-${identity.request_scope_epoch}-${runId()}-${route.stageId}-${state.revision}-${kind}"` } });
      }
      unexpected.push(url.pathname);
      throw new Error(`Unexpected fixture GET ${url.pathname}`);
    },
  });
  // Only services consumed by production hooks are injected; none of those
  // hooks, the resource cache or Inspector implementation is substituted.
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder } as unknown as KernelApi;
  const invalidate = () => {
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, state.revision);
    resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, state.revision);
    for (const route of stagePaths) resources.invalidatePrefix(route.metadataPath, state.revision);
  };
  const control: FixtureControl = {
    read: () => ({ calls: calls.map((call) => ({ ...call })), pending: pending.size, renderCommits: state.renderCommits, scenario: state.scenario, requestScopeEpoch: owner().request_scope_epoch, runId: runId(), revision: state.revision, unexpected: [...unexpected] }),
    release: () => { state.hold = false; heldStages.clear(); for (const request of [...pending.values()]) request.release(); },
    setScenario: (scenario) => {
      if (!SCENARIOS.includes(scenario)) throw new Error("Unknown fixed antenna scenario");
      for (const request of [...pending.values()]) request.cancel();
      heldStages.clear();
      state.scenario = scenario; state.hold = false; state.incarnation += 1; state.revision += 1; invalidate();
    },
    refresh: () => { state.hold = true; state.revision += 1; invalidate(); },
    nextRun: () => { state.run += 1; state.revision += 1; invalidate(); },
    previousRun: () => { state.run = Math.max(1, state.run - 1); state.revision += 1; invalidate(); },
    holdStage: (stageId) => {
      if (!stagePaths.some((route) => route.stageId === stageId)) throw new Error("Unknown fixed runtime stage");
      heldStages.add(stageId); state.revision += 1; invalidate();
    },
    releaseStage: (stageId) => {
      heldStages.delete(stageId);
      for (const request of [...pending.values()]) if (request.stageId === stageId) request.release();
    },
  };
  return { kernel, control, onRender: () => { state.renderCommits += 1; } };
}

export default function AntennaInspectionFixturePage() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated);
  useEffect(() => {
    window.__antennaInspectionFixture = fixture.control;
    return () => { delete window.__antennaInspectionFixture; };
  }, [fixture]);
  return (
    <main className="fm-antenna-inspection-fixture" data-antenna-inspection-fixture style={{ padding: 32, maxWidth: 840 }}>
      <h1>Fullmag external-lead inspection fixture</h1>
      <p>Production Inspector and resource hooks; fixture responses only. No backend, native solve, LLG, FFT or numerical qualification.</p>
      {mounted ? <KernelContext.Provider value={fixture.kernel}>
        <label>Persistent focus marker <input data-testid="antenna-fixture-focus" defaultValue="preserve draft and focus" /></label>
        <div data-testid="antenna-fixture-scroll" style={{ maxHeight: 560, overflow: "auto", padding: 16, border: "1px solid var(--fm-border-subtle)" }}>
          <Profiler id="antenna-inspection" onRender={fixture.onRender}>
            <AntennaExternalLeadInspectionPanel authoredStageId={AUTHORED_STAGE} />
          </Profiler>
        </div>
      </KernelContext.Provider> : <p role="status">Loading fixture harness…</p>}
    </main>
  );
}
