"use client";

/**
 * New API Bridge: maps resource-first LiveStatus → NormalizedSessionState.
 *
 * Drop-in replacement for useSessionRuntimeBridge when USE_NEW_API is enabled.
 * The mapping produces EXACTLY the same store shape that existing components
 * consume — no store changes required.
 */

import { useEffect, useRef } from "react";
import { useSessionRuntimeStore } from "../store/useSessionRuntimeStore";
import { useLiveStatus } from "@/src/hooks/resources/useLiveStatus";
import type { NormalizedSessionState } from "../model/deriveSessionReadModel";
import type { LiveStatus, EnergySummary, MetricsSummary } from "@/src/api/types";
import type {
  SessionManifest,
  RunManifest,
  ScalarRow,
  RuntimeStatusState,
  RuntimeStatusKind,
} from "@/lib/session/types";
import type { LiveState, PreviewState } from "@/lib/useSessionStream";
import type { FieldFrameEnvelope } from "@/lib/fieldFrame/types";

// Stable empty arrays to prevent unnecessary re-renders
const EMPTY_SCALAR_ROWS: ScalarRow[] = [];
const EMPTY_ENGINE_LOG: never[] = [];
const EMPTY_QUANTITIES: never[] = [];
const EMPTY_ARTIFACTS: never[] = [];

// ── Solver-state → RuntimeStatusKind mapping ────────────────────────

const SOLVER_STATE_TO_STATUS_KIND: Record<string, RuntimeStatusKind> = {
  idle: "awaiting_command",
  initializing: "bootstrapping",
  running: "running",
  paused: "paused",
  converged: "completed",
  stopped: "completed",
  error: "failed",
};

function mapSolverStateToRuntimeStatus(
  solverState: string,
): RuntimeStatusState {
  const kind =
    SOLVER_STATE_TO_STATUS_KIND[solverState] ?? ("unknown" as RuntimeStatusKind);
  const isBusy = solverState === "running" || solverState === "initializing";
  const canAccept =
    solverState === "idle" ||
    solverState === "paused" ||
    solverState === "converged" ||
    solverState === "stopped";

  return {
    kind,
    code: solverState,
    is_busy: isBusy,
    can_accept_commands: canAccept,
  };
}

// ── LiveStatus → SessionManifest ────────────────────────────────────

function mapSessionManifest(status: LiveStatus): SessionManifest {
  return {
    session_id: status.session_id,
    run_id: status.run_id ?? "",
    status: status.solver_state,
    interactive_session_requested: true,
    script_path: "",
    problem_name: "",
    requested_backend: "auto",
    execution_mode: "interactive",
    precision: "double",
    artifact_dir: "",
    started_at_unix_ms: 0,
    finished_at_unix_ms: 0,
  };
}

// ── LiveStatus → RunManifest ────────────────────────────────────────

function mapRunManifest(status: LiveStatus): RunManifest | null {
  if (!status.run_id) return null;

  const e = status.energy_summary;
  return {
    run_id: status.run_id,
    session_id: status.session_id,
    status: status.solver_state,
    total_steps: status.iteration,
    final_time: status.sim_time || null,
    final_e_ex: e?.exchange ?? null,
    final_e_demag: e?.demag ?? null,
    final_e_ext: e?.zeeman ?? null,
    final_e_ani: e?.anisotropy ?? null,
    final_e_dmi: null,
    final_e_total: e?.total ?? null,
    artifact_dir: "",
  };
}

// ── LiveStatus → LiveState (partial) ────────────────────────────────

function mapLiveState(status: LiveStatus): LiveState {
  const e: EnergySummary = status.energy_summary ?? {
    total: 0,
    exchange: 0,
    zeeman: 0,
    demag: 0,
    anisotropy: 0,
  };
  const m: MetricsSummary = status.metrics_summary ?? {
    dt: 0,
    max_torque: 0,
    max_dm_dt: 0,
  };

  return {
    status: status.solver_state,
    updated_at_unix_ms: Date.now(),
    step: status.iteration,
    time: status.sim_time,
    dt: m.dt,
    e_ex: e.exchange,
    e_demag: e.demag,
    e_ext: e.zeeman,
    e_ani: e.anisotropy,
    e_dmi: 0,
    e_total: e.total,
    max_dm_dt: m.max_dm_dt,
    max_h_eff: 0,
    max_h_demag: 0,
    max_torque_Apm: m.max_torque,
    wall_time_ns: status.wall_time_s * 1e9,
    grid: [0, 0, 0],
    preview_grid: null,
    preview_data_points_count: null,
    preview_max_points: null,
    preview_auto_downscaled: false,
    preview_auto_downscale_message: null,
    fem_mesh: null,
    magnetization: null,
    finished:
      status.solver_state === "converged" ||
      status.solver_state === "stopped" ||
      status.solver_state === "error",
  };
}

// ── LiveStatus → PreviewState (partial from display_selection) ──────

function mapPreviewState(status: LiveStatus): PreviewState | null {
  const ds = status.display_selection;
  if (!ds?.quantity_id) return null;

  // Build a minimal spatial preview from display selection.
  // Full preview data arrives via the data-plane bridge (useDataPlaneBridge).
  return {
    kind: "spatial",
    display_kind: "vector_field",
    config_revision: status.field_revision,
    source_step: status.iteration,
    source_time: status.sim_time,
    spatial_kind: "grid",
    quantity: ds.quantity_id,
    unit: "",
    quantity_domain: "magnetic_only",
    component: ds.component ?? "3D",
    layer: 0,
    all_layers: true,
    type: "vector",
    vector_payload_id: null,
    vector_field_values: null,
    scalar_field: [],
    min: ds.range_min ?? 0,
    max: ds.range_max ?? 1,
    n_comp: 3,
    max_points: 0,
    data_points_count: 0,
    x_possible_sizes: [],
    y_possible_sizes: [],
    x_chosen_size: 0,
    y_chosen_size: 0,
    applied_x_chosen_size: 0,
    applied_y_chosen_size: 0,
    applied_layer_stride: 0,
    auto_scale_enabled: true,
    auto_downscaled: false,
    auto_downscale_message: null,
    preview_grid: [0, 0, 0],
    fem_mesh: null,
    original_node_count: null,
    original_face_count: null,
    active_mask: null,
  };
}

// ── LiveStatus → FieldFrameEnvelope ─────────────────────────────────

function mapFieldFrameEnvelope(
  status: LiveStatus,
): FieldFrameEnvelope | null {
  if (!status.run_id) return null;

  const ds = status.display_selection;
  const quantityId = ds?.quantity_id ?? "m";
  const component = ds?.component ?? "3D";

  return {
    sessionId: status.session_id,
    runId: status.run_id,
    backendEpoch: 0,
    meshGenerationId: String(status.domain_generation_id),
    topologyHash: null,
    fieldRevision: status.field_revision,
    sourceStep: status.iteration,
    sourceTime: status.sim_time,
    quantityId,
    component: component as FieldFrameEnvelope["component"],
    nComp: 3,
    domain: "magnetic_only",
    location: "grid_cell",
    dtype: "f64",
    payloadKind: "binary-ref",
    payloadId: null,
    activeMaskId: null,
    stats:
      ds?.range_min != null && ds?.range_max != null
        ? { min: ds.range_min, max: ds.range_max, compMin: null, compMax: null }
        : null,
  };
}

// ── Main mapping: LiveStatus → NormalizedSessionState ───────────────

function mapLiveStatusToNormalized(
  status: LiveStatus,
): NormalizedSessionState {
  const session = mapSessionManifest(status);
  const run = mapRunManifest(status);
  const liveState = mapLiveState(status);
  const runtimeStatus = mapSolverStateToRuntimeStatus(status.solver_state);
  const preview = mapPreviewState(status);
  const workspaceStatus = runtimeStatus.code || status.solver_state || "idle";

  return {
    stateVersion: status.field_revision,
    session,
    run,
    metadata: null,
    liveState,
    scalarRows: EMPTY_SCALAR_ROWS,
    engineLog: EMPTY_ENGINE_LOG,
    quantities: EMPTY_QUANTITIES,
    artifacts: EMPTY_ARTIFACTS,
    femMesh: null,
    preview,
    scriptBuilder: null,
    runtimeStatus,
    commandStatus: null,
    meshWorkspace: null,
    stepUpdateV2: null,
    workspaceStatus,
    isFemBackend: false,
    fieldFrameEnvelope: mapFieldFrameEnvelope(status),
  };
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Bridge hook that syncs the new resource-first API → useSessionRuntimeStore.
 *
 * Mount this once (via useSessionRuntimeBridgeRouter) when USE_NEW_API is
 * enabled. It replaces the legacy useSessionRuntimeBridge.
 */
export function useNewApiBridge(): void {
  const { status, error } = useLiveStatus();
  const applyNormalizedState = useSessionRuntimeStore(
    (s) => s.applyNormalizedState,
  );
  const setConnection = useSessionRuntimeStore((s) => s.setConnection);

  const prevRevisionRef = useRef<number | null>(null);
  const prevConnectionRef = useRef<"connecting" | "connected" | "disconnected">(
    "connecting",
  );

  // Sync connection state
  useEffect(() => {
    const nextConnection = error
      ? "disconnected"
      : status
        ? "connected"
        : "connecting";

    if (nextConnection !== prevConnectionRef.current || error != null) {
      prevConnectionRef.current = nextConnection;
      setConnection(nextConnection, error?.message ?? null);
    }
  }, [status, error, setConnection]);

  // Sync normalized state
  useEffect(() => {
    if (!status) return;

    // Deduplicate by field_revision (monotonically increasing)
    if (
      prevRevisionRef.current != null &&
      prevRevisionRef.current === status.field_revision
    ) {
      return;
    }

    const normalized = mapLiveStatusToNormalized(status);
    applyNormalizedState(normalized);
    prevRevisionRef.current = status.field_revision;
  }, [status, applyNormalizedState]);
}
