"use client";

/**
 * New API Bridge: maps resource-first LiveStatus → NormalizedSessionState.
 *
 * Resource-first status bridge producing the same normalized store shape
 * that existing components consume.
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

function displayComponentFromStatus(
  display: LiveStatus["display"] | null | undefined,
): "3D" | "x" | "y" | "z" | "magnitude" {
  if (!display) {
    return "3D";
  }
  return display.view_mode === "3d" ? "3D" : display.field_component;
}

// ── LiveStatus → SessionManifest ────────────────────────────────────

function mapSessionManifest(status: LiveStatus): SessionManifest {
  return {
    session_id: status.session.session_id,
    run_id: status.run?.run_id ?? "",
    status: status.solver.state,
    interactive_session_requested: true,
    script_path: "",
    problem_name: status.session.name,
    requested_backend: "auto",
    execution_mode: "interactive",
    precision: "double",
    artifact_dir: status.session.workspace_root,
    started_at_unix_ms: Number(status.session.created_at) || 0,
    finished_at_unix_ms: 0,
  };
}

// ── LiveStatus → RunManifest ────────────────────────────────────────

function mapRunManifest(status: LiveStatus): RunManifest | null {
  if (!status.run) return null;

  const e = status.energies;
  return {
    run_id: status.run.run_id,
    session_id: status.session.session_id,
    status: status.solver.state,
    total_steps: status.run.solver_steps,
    final_time: status.run.solver_time || null,
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
  const e: EnergySummary = status.energies ?? {
    total: null,
    exchange: null,
    zeeman: null,
    demag: null,
    anisotropy: null,
    dmi: null,
  };
  const m: MetricsSummary = status.metrics ?? {
    uptime_seconds: 0,
    total_steps: 0,
    steps_per_second: null,
  };
  const sourceStep = status.run?.solver_steps ?? status.metrics.total_steps;
  const sourceTime = status.run?.solver_time ?? 0;

  return {
    status: status.solver.state,
    updated_at_unix_ms: Date.now(),
    step: sourceStep,
    time: sourceTime,
    dt: status.solver.dt ?? 0,
    e_ex: e.exchange ?? 0,
    e_demag: e.demag ?? 0,
    e_ext: e.zeeman ?? 0,
    e_ani: e.anisotropy ?? 0,
    e_dmi: e.dmi ?? 0,
    e_total: e.total ?? 0,
    max_dm_dt: 0,
    max_h_eff: 0,
    max_h_demag: 0,
    max_torque_Apm: status.solver.max_torque ?? 0,
    wall_time_ns: m.uptime_seconds * 1e9,
    grid: [0, 0, 0],
    preview_grid: null,
    preview_data_points_count: null,
    preview_max_points: null,
    preview_auto_downscaled: false,
    preview_auto_downscale_message: null,
    fem_mesh: null,
    magnetization: null,
    finished:
      status.solver.converged === true ||
      status.solver.state === "finished" ||
      status.solver.state === "error",
  };
}

// ── LiveStatus → PreviewState (partial from display_selection) ──────

function mapPreviewState(status: LiveStatus): PreviewState | null {
  const ds = status.display;
  if (!ds?.active_quantity_id) return null;

  // Build a minimal spatial preview from display selection.
  // Full preview data arrives via the data-plane bridge (useDataPlaneBridge).
  return {
    kind: "spatial",
    display_kind: "vector_field",
    config_revision: status.resources.display_revision,
    source_step: status.run?.solver_steps ?? status.metrics.total_steps,
    source_time: status.run?.solver_time ?? 0,
    spatial_kind: "grid",
    quantity: ds.active_quantity_id,
    unit: "",
    quantity_domain: "magnetic_only",
    component: displayComponentFromStatus(ds),
    layer: ds.slice_layer ?? 0,
    all_layers: ds.slice_mode === "all",
    type: "vector",
    vector_payload_id: null,
    vector_field_values: null,
    scalar_field: [],
    min: ds.contrast_min ?? 0,
    max: ds.contrast_max ?? 1,
    n_comp: 3,
    max_points: ds.max_points ?? 0,
    data_points_count: 0,
    x_possible_sizes: [],
    y_possible_sizes: [],
    x_chosen_size: ds.x_chosen_size ?? 0,
    y_chosen_size: ds.y_chosen_size ?? 0,
    applied_x_chosen_size: 0,
    applied_y_chosen_size: 0,
    applied_layer_stride: 0,
    auto_scale_enabled: ds.auto_contrast,
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
  if (!status.run) return null;

  const ds = status.display;
  const quantityId = ds?.active_quantity_id ?? "m";
  const component = displayComponentFromStatus(ds);

  return {
    sessionId: status.session.session_id,
    runId: status.run.run_id,
    backendEpoch: 0,
    meshGenerationId:
      status.resources.domain_generation_id > 0
        ? String(status.resources.domain_generation_id)
        : null,
    topologyHash: null,
    fieldRevision: status.resources.fields_revision,
    sourceStep: status.run.solver_steps,
    sourceTime: status.run.solver_time,
    quantityId,
    component: component as FieldFrameEnvelope["component"],
    nComp: 3,
    domain: "magnetic_only",
    location: status.capabilities.node_fields ? "node" : "grid_cell",
    dtype: "f64",
    payloadKind: "binary-ref",
    payloadId: null,
    activeMaskId: null,
    stats:
      ds?.contrast_min != null && ds?.contrast_max != null
        ? {
            min: ds.contrast_min,
            max: ds.contrast_max,
            compMin: null,
            compMax: null,
          }
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
  const runtimeStatus = mapSolverStateToRuntimeStatus(status.solver.state);
  const preview = mapPreviewState(status);
  const workspaceStatus = runtimeStatus.code || status.solver.state || "idle";

  return {
    stateVersion: status.resources.fields_revision,
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
    isFemBackend: status.domain.discretization === "fem",
    fieldFrameEnvelope: mapFieldFrameEnvelope(status),
  };
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Bridge hook that syncs the new resource-first API → useSessionRuntimeStore.
 *
 * Mount this once wherever the app owns the live session transport.
 */
export function useNewApiBridge(
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  const { status, error } = useLiveStatus({ enabled });
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
    if (!enabled) {
      return;
    }

    const nextConnection = error
      ? "disconnected"
      : status
        ? "connected"
        : "connecting";

    if (nextConnection !== prevConnectionRef.current || error != null) {
      prevConnectionRef.current = nextConnection;
      setConnection(nextConnection, error?.message ?? null);
    }
  }, [enabled, status, error, setConnection]);

  // Sync normalized state
  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (!status) return;

    // Deduplicate by field_revision (monotonically increasing)
    if (
      prevRevisionRef.current != null &&
      prevRevisionRef.current === status.resources.fields_revision
    ) {
      return;
    }

    const normalized = mapLiveStatusToNormalized(status);
    applyNormalizedState(normalized);
    prevRevisionRef.current = status.resources.fields_revision;
  }, [enabled, status, applyNormalizedState]);
}
