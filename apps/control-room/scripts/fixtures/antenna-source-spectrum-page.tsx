"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { DATA_ANTENNA_SOURCE_SPECTRUM_PATH, DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH, DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH, MODEL_SCENE_PATH, SESSION_STATUS_PATH, SESSIONS_PATH } from "@/kernel/api/apiPaths";
import type { AntennaSourceSpectrumResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import { resourceRuntimeKeyForClientScope } from "@/kernel/resources/resourceClientScope";
import { antennaSpectrumPayloadEtag } from "@/kernel/resources/antennaResources";
import { sessionRequestScopeKey, sessionScopedResourceKey } from "@/kernel/resources/sessionResourceIdentity";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { AntennaCompositionPanel } from "@/modules/inspector/panels/antenna/AntennaCompositionPanels";

const SCENARIOS = ["ready", "ready-vector", "ready-unitary", "foreign-digest", "foreign-request", "foreign-catalog", "missing-catalog", "invalid-authoring", "wrong-layout", "wrong-unit", "wrong-scalar", "wrong-count", "wrong-summary-count", "unsafe-grid", "wrong-sha", "truncated-payload", "nonfinite-payload", "inconsistent-power", "wrong-etag", "oversized-body", "oversized-stream"] as const;
const subscribe = () => () => {};
type RefreshKind = "metadata" | "catalog" | "power";
interface Evidence { scenario: string; calls: { path: string; scope: string | null }[]; unexpected: string[]; pending: number; streamCancelled: boolean; snapshots: Record<RefreshKind, { status: string; hasData: boolean; error: string | null }>; }
declare global { interface Window { __antennaSpectrumFixture?: { read(): Evidence; refresh(kind: RefreshKind): void; release(fail?: boolean): void; }; } }

function makeFixture() {
  const scenario = new URL(window.location.href).searchParams.get("scenario") ?? "ready";
  if (!SCENARIOS.includes(scenario as typeof SCENARIOS[number])) throw new Error("Unknown fixed spectrum scenario");
  const calls: Evidence["calls"] = [], unexpected: string[] = [];
  const owner = { session_id: "spectrum-fixture", session_epoch: "spectrum-fixture@1:tombstone:0", request_scope_epoch: "11111111-1111-4111-8111-111111111111:1" };
  const vector = scenario === "ready-vector";
  const normalization = scenario === "ready-unitary" ? "unitary_discrete" : "integral_si";
  const amplitudeUnit = normalization === "integral_si" ? "A*m/A" : "A/m/A";
  const plane = { origin_m: [0, 0, 0], axis_u: [1, 0, 0], axis_v: [0, 1, 0], extent_u_m: 1e-6, extent_v_m: 1e-6, sample_count_u: 2, sample_count_v: 2, interpolation: "fem_element", outside_policy: "error" as const };
  const ref = { kind: "stage_output", stage_id: "solve", output_id: "basis" };
  const scene = { revision: 1, objects: [], antenna_port_modes: [{ id: "port" }], antenna_field_solve_stages: [{ id: "solve", port_mode_ids: ["port"], outputs: [{ id: "basis", quantity: "H_ant_basis" }] }], antenna_spectrum_requests: [{ id: "request", output_id: "fft", solution_ref: ref, target: { kind: "global" }, component: scenario === "invalid-authoring" ? "transverse" : vector ? "vector_power" : "x", transform: "spatial_fft", window: "rectangular", normalization, port_mode_id: "port", sampling_plane: plane, nonuniform_k_grid: null }] };
  const componentAmplitudes = [1, 0, 2, 0, 3, 0, 4, 0];
  const payloadValues = { k_u_rad_per_m: [-1, 1], k_v_rad_per_m: [-1, 1], amplitudes_re_im: vector ? [...componentAmplitudes, ...componentAmplitudes, ...componentAmplitudes] : componentAmplitudes, power: [1, 4, 9, 16].map((value) => value * (vector ? 3 : 1)) };
  type PayloadKind = keyof typeof payloadValues;
  const layouts = { k_u_rad_per_m: "axis_u_1d", k_v_rad_per_m: "axis_v_1d", amplitudes_re_im: "component_kv_ku_complex_re_im", power: "kv_ku_power" };
  const descriptor = (kind: PayloadKind) => ({ path: `antenna/source_spectra/fft/${kind}.f64le`, sha256: `sha256:${"b".repeat(64)}`, value_count: payloadValues[kind].length, scalar_type: "float64_le", layout: layouts[kind], unit: kind.startsWith("k_") ? "rad/m" : kind === "power" ? `(${amplitudeUnit})^2` : amplitudeUnit });
  const spectrum: AntennaSourceSpectrumResource = {
    ...owner, schema_version: "antenna_source_spectrum_artifact.v2", resource_id: "fixture", output_id: "fft", request_id: scenario === "foreign-request" ? "foreign" : "request", solution_id: "basis", solution_content_digest: scenario === "foreign-digest" ? "foreign-digest" : "basis-digest", content_digest: "fft-digest", source_object_id: "antenna", port_mode_id: "port", quantity: "H_ant_source_spectrum", component: vector ? "vector_power" : "x", component_labels: vector ? ["x", "y", "z"] : ["x"], amplitude_unit: amplitudeUnit, wave_vector_unit: "rad/m", normalization, coherent_gain: 1, equivalent_noise_bandwidth_bins: 1, field_signature: "fixture", k_u_count: 2, k_v_count: 2, amplitude_count: vector ? 12 : 4, power_count: 4,
    payload: { content_type: "application/octet-stream", format: "fixture", path: "fixture" },
    payloads: { k_u_rad_per_m: descriptor("k_u_rad_per_m"), k_v_rad_per_m: descriptor("k_v_rad_per_m"), amplitudes_re_im: descriptor("amplitudes_re_im"), power: descriptor("power") },
    sampling: { ...plane, schema_version: "fixture", target: { kind: "global" }, solution_id: "basis", source_object_id: "antenna", port_mode_id: "port", source_sample_count: 4, realization: "fixture", mapping_digest: "fixture", outside_count: 0, fourier_origin_uv_m: [0, 0], fourier_phase_convention: "fixture" },
  };
  if (scenario === "wrong-layout") spectrum.payloads!.power.layout = "ku_kv_power";
  if (scenario === "wrong-unit") spectrum.payloads!.power.unit = "W";
  if (scenario === "wrong-scalar") spectrum.payloads!.power.scalar_type = "float32_le";
  if (scenario === "wrong-count") spectrum.payloads!.power.value_count = 3;
  if (scenario === "wrong-summary-count") spectrum.power_count = 3;
  if (scenario === "unsafe-grid") spectrum.k_u_count = Number.MAX_SAFE_INTEGER;
  if (scenario === "wrong-sha") spectrum.payloads!.power.sha256 = "b".repeat(64);
  const catalog = { ...owner, ...(scenario === "foreign-catalog" ? { session_epoch: "foreign" } : {}), schema_version: "fixture", resource_id: "fixture", stage_id: "solve", stage_revision: 1, status: "ready", port_mode_id: "port", content_digest: "catalog", outputs: scenario === "missing-catalog" ? [] : [{ output_id: "basis", quantity_ids: ["H_ant_basis"], solution_ref: { kind: "resolved_asset", stage_id: "solve", output_id: "basis", asset_id: "asset", content_digest: "basis-digest" }, reused_existing: false, manifest_ref: "fixture" }] };
  const bus = new EventBus<KernelEventMap>(), resources = new ResourceInvalidationController(bus), diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const metadataPath = DATA_ANTENNA_SOURCE_SPECTRUM_PATH.replace("{output_id}", "fft");
  const catalogPath = DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH.replace("{stage_id}", "solve");
  const powerPath = DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH.replace("{output_id}", "fft").replace("{payload_kind}", "power");
  const powerKey = `${powerPath}#${antennaSpectrumPayloadEtag(spectrum, "power")}`;
  let heldPath: string | null = null, refreshRevision = 1;
  let pending: { release(fail: boolean): void } | null = null;
  let streamCancelled = false;
  const payloadPrefix = DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH.replace("{output_id}", "fft").split("{payload_kind}")[0];
  const headers = { "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": "11111111-1111-4111-8111-111111111111" };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, "content-type": "application/json" } });
  const api = new ControlRoomApi({ baseUrl: "http://spectrum.fixture.invalid", expectedApiInstance: headers["x-fullmag-api-instance"], diagnostics, maxGetRetries: 0, fetchImpl: async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    const scope = request.headers.get("x-fullmag-session-scope");
    calls.push({ path, scope });
    if (calls.length > 30 || request.method !== "GET") throw new Error("Spectrum fixture request budget/method violated");
    if (scope && scope !== sessionRequestScopeKey({ sessionId: owner.session_id, sessionEpoch: owner.session_epoch, requestScopeEpoch: owner.request_scope_epoch })) throw new Error("Foreign request owner");
    if (path === heldPath) {
      const failed = await new Promise<boolean>((resolve, reject) => {
        const onAbort = () => { pending = null; reject(new DOMException("Aborted", "AbortError")); };
        pending = { release: (fail) => {
          request.signal.removeEventListener("abort", onAbort);
          pending = null; heldPath = null;
          resolve(fail);
        } };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
      if (failed) return json({ error: "Fixture refresh rejected", code: "invalid_antenna_spectrum" }, 422);
    }
    if (path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: owner.session_id, name: "Fixture", status: "completed", current: true }] });
    if (path === SESSION_STATUS_PATH) return json({ api_contract_version: "1.0.0", runtime_bundle_version: "fixture", session: { ...owner, name: "Fixture", created_at: "fixture", workspace_root: "fixture" }, resources: { scene_revision: 1 }, capabilities: {}, lifecycle: { solver: "completed", session_resource: "tombstoned", connectivity: "connected", commandability: "read_only" } });
    if (path === MODEL_SCENE_PATH) return json(scene);
    if (path === metadataPath) return json(spectrum);
    if (path === catalogPath) return json(catalog);
    if (path.startsWith(payloadPrefix)) {
      const kind = path.slice(payloadPrefix.length) as PayloadKind;
      if (!(kind in payloadValues)) throw new Error("Unknown spectrum carrier");
      let values = [...payloadValues[kind]];
      if (kind === "power" && scenario === "truncated-payload") values = values.slice(0, 3);
      if (kind === "amplitudes_re_im" && scenario === "nonfinite-payload") values[0] = Number.NaN;
      if (kind === "power" && scenario === "inconsistent-power") values[0] = 2;
      if (kind === "power" && ["oversized-body", "oversized-stream"].includes(scenario)) values.push(25);
      const bytes = new ArrayBuffer(values.length * 8), view = new DataView(bytes);
      values.forEach((value, index) => view.setFloat64(index * 8, value, true));
      const binaryHeaders = { ...headers, "content-type": "application/octet-stream", etag: kind === "power" && scenario === "wrong-etag" ? '"foreign"' : antennaSpectrumPayloadEtag(spectrum, kind), "x-fullmag-scalar-type": "float64_le" };
      if (kind === "power" && scenario === "oversized-stream") {
        let offset = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.byteLength) { controller.close(); return; }
            const end = Math.min(offset + 20, bytes.byteLength);
            controller.enqueue(new Uint8Array(bytes.slice(offset, end))); offset = end;
          },
          cancel() { streamCancelled = true; },
        }, { highWaterMark: 0 }), { headers: binaryHeaders });
      }
      return new Response(bytes, { headers: { ...binaryHeaders, "content-length": String(bytes.byteLength) } });
    }
    unexpected.push(path); throw new Error(`Unexpected spectrum GET ${path}`);
  } });
  const snapshot = (kind: RefreshKind) => {
    const path = kind === "metadata" ? metadataPath : kind === "catalog" ? catalogPath : powerKey;
    const key = sessionScopedResourceKey({ sessionId: owner.session_id, sessionEpoch: owner.session_epoch, requestScopeEpoch: owner.request_scope_epoch }, path);
    const value = sharedResourceRuntimeStore.getSnapshot(resourceRuntimeKeyForClientScope(key, api.resourceCacheScope));
    return { status: value.status, hasData: value.data !== null, error: value.error?.message ?? value.refreshError?.message ?? null };
  };
  return { kernel: { api, bus, resources, diagnostics, diagnosticRecorder } as unknown as KernelApi, control: {
    read: () => ({ scenario, calls: [...calls], unexpected: [...unexpected], pending: pending ? 1 : 0, streamCancelled, snapshots: { metadata: snapshot("metadata"), catalog: snapshot("catalog"), power: snapshot("power") } }),
    refresh: (kind: RefreshKind) => {
      if (kind !== "metadata" && kind !== "catalog" && kind !== "power") throw new Error("Unknown fixed refresh resource");
      if (pending || heldPath) throw new Error("A refresh is already pending");
      heldPath = kind === "metadata" ? metadataPath : kind === "catalog" ? catalogPath : powerPath;
      resources.invalidate(kind === "power" ? powerKey : heldPath, ++refreshRevision);
    },
    release: (fail = false) => { if (!pending) throw new Error("No held refresh to release"); pending.release(fail); },
  } };
}

function MountedFixture() {
  const fixture = useMemo(() => makeFixture(), []);
  useEffect(() => { window.__antennaSpectrumFixture = fixture.control; return () => { delete window.__antennaSpectrumFixture; }; }, [fixture]);
  return <KernelContext.Provider value={fixture.kernel}><AntennaCompositionPanel kind="spectrum" selection={{ ...EMPTY_SELECTION, kind: "object.antenna.spectrum", objectId: "antenna", ref: { type: "scene-object", kind: "object.antenna.spectrum", objectId: "antenna", nodeId: "fixture-spectrum", visualizationTargetId: "object:antenna", antennaResourceId: "request", antennaResourceKind: "spectrum" } }} /></KernelContext.Provider>;
}

export default function SpectrumFixturePage() {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <main className="fm-spectrum-fixture" style={{ padding: 24, maxWidth: 600 }}><h1>Source spectrum ownership regression</h1><p>Controlled GET responses. No solver, FFT computation, backend or scientific qualification.</p>{mounted ? <MountedFixture /> : <p>Loading fixture…</p>}</main>;
}
