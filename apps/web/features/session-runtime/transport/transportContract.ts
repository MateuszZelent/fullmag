/**
 * Transport Contract v2 — Layer 10
 *
 * Canonical wire-level message and command envelope types for the
 * transport between the control-room frontend and the
 * Rust control-plane API (currently HTTP polling, historically WebSocket).
 *
 * These types unify all command/response paths so that every action
 * from ribbon, inspector, command palette, and context menu maps to
 * one `RuntimeCommandEnvelope`, and every backend push maps to one
 * `RuntimeWsMessage`.
 *
 * State classification:
 *   - Message types         → runtime_telemetry (inbound from backend)
 *   - Command envelopes     → study (outbound mutations hitting solver state)
 *   - Bootstrap payload     → mixed: study (document) + runtime_telemetry (runtime snapshot)
 */

// ── Workspace bootstrap ──────────────────────────────────────

/**
 * Payload returned on HTTP bootstrap (or initial handshake).
 * Contains everything the frontend needs to hydrate.
 */
export interface WorkspaceBootstrapResponse {
  /** Full serialised workspace document (model graph, study, materials, etc.) */
  document: Record<string, unknown>;
  /** Current runtime snapshot (solver status, session/run IDs, etc.) */
  runtime: RuntimeSnapshot;
  /** Commands that were issued but not yet completed when the client connected. */
  pendingCommands: RuntimeCommandEnvelope[];
}

export interface RuntimeSnapshot {
  sessionId: string | null;
  runId: string | null;
  solverStatus: SolverStatus;
  currentStep: number;
  currentTime: number;
  wallClockElapsed: number;
  meshBuildPhase: MeshBuildPhase | null;
}

export type SolverStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "completed"
  | "failed";

export type MeshBuildPhase =
  | "queued"
  | "generating"
  | "partitioning"
  | "uploading"
  | "ready"
  | "failed";

// ── Inbound messages ─────────────────────────────────────────

/** Discriminated‐union message pushed from backend → frontend. */
export type RuntimeWsMessage =
  | { type: "workspace.patch";             payload: WorkspacePatchPayload }
  | { type: "command.accepted";            payload: CommandStatusPayload }
  | { type: "command.progress";            payload: CommandProgressPayload }
  | { type: "command.completed";           payload: CommandStatusPayload }
  | { type: "command.failed";              payload: CommandFailedPayload }
  | { type: "mesh.build.phase";            payload: MeshBuildPhasePayload }
  | { type: "mesh.build.summary";          payload: MeshBuildSummaryPayload }
  | { type: "results.dataset.ready";       payload: DatasetReadyPayload }
  | { type: "python.sync.diff_ready";      payload: PythonSyncDiffPayload }
  | { type: "diagnostics.issue";           payload: DiagnosticsIssuePayload };

/** Extract the type literal of a message. */
export type RuntimeWsMessageType = RuntimeWsMessage["type"];

// ── Message payloads ─────────────────────────────────────────

export interface WorkspacePatchPayload {
  /** JSON Patch (RFC 6902) operations against the workspace document. */
  ops: readonly JsonPatchOp[];
  /** Monotonically increasing version counter. */
  version: number;
}

export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

export interface CommandStatusPayload {
  commandId: string;
  commandKind: RuntimeCommandKind;
}

export interface CommandProgressPayload {
  commandId: string;
  commandKind: RuntimeCommandKind;
  progress: number;         // 0..1
  message: string | null;
}

export interface CommandFailedPayload {
  commandId: string;
  commandKind: RuntimeCommandKind;
  error: string;
  details: Record<string, unknown> | null;
}

export interface MeshBuildPhasePayload {
  phase: MeshBuildPhase;
  objectId: string | null;
  message: string | null;
}

export interface MeshBuildSummaryPayload {
  totalNodes: number;
  totalElements: number;
  domainCount: number;
  wallTimeMs: number;
}

export interface DatasetReadyPayload {
  datasetId: string;
  label: string;
  stepRange: [number, number];
  timeRange: [number, number];
  quantities: string[];
}

export interface PythonSyncDiffPayload {
  /** Unified diff of the canonical Python script. */
  diff: string;
  /** Hash of the new script content. */
  contentHash: string;
}

export interface DiagnosticsIssuePayload {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  source: string;
  path: string | null;
}

// ── Outbound command envelopes ───────────────────────────────

/**
 * Typed command sent from the frontend to the backend.
 * All ribbon, inspector, command-palette, and context-menu actions
 * funnel through this envelope.
 */
export interface RuntimeCommandEnvelope<TPayload = unknown> {
  /** Client-generated unique ID for correlation. */
  id: string;
  /** Discriminator for the backend handler. */
  commandKind: RuntimeCommandKind;
  /** Kind-specific payload. */
  payload: TPayload;
  /** Client-side wall-clock timestamp (ms since epoch). */
  issuedAtUnixMs: number;
}

/** Union of all recognised command kinds. */
export type RuntimeCommandKind =
  | "solver.run"
  | "solver.pause"
  | "solver.resume"
  | "solver.stop"
  | "study.insert_stage"
  | "study.remove_stage"
  | "study.duplicate_stage"
  | "study.reorder_stages"
  | "study.update_stage"
  | "mesh.build_selected"
  | "mesh.build_all"
  | "mesh.refine_region"
  | "results.export"
  | "results.add_dataset"
  | "results.remove_dataset"
  | "python.sync"
  | "python.emit_script"
  | "workspace.apply_preset"
  | "workspace.save"
  | "workspace.undo"
  | "workspace.redo";

// ── Command status lifecycle ─────────────────────────────────

/**
 * Client-side tracking of a command through its lifecycle.
 * The store maintains a map of `commandId → CommandLifecycle`.
 */
export type CommandLifecyclePhase =
  | "pending"     // sent, not yet acknowledged
  | "accepted"    // backend acknowledged receipt
  | "in_progress" // backend reported progress
  | "completed"   // successfully finished
  | "failed";     // failed with error

export interface CommandLifecycle {
  id: string;
  kind: RuntimeCommandKind;
  phase: CommandLifecyclePhase;
  progress: number;         // 0..1
  message: string | null;
  error: string | null;
  issuedAt: number;
  resolvedAt: number | null;
}

// ── Factory helpers ──────────────────────────────────────────

let _cmdSeq = 0;

/** Create a fresh command envelope with a unique ID. */
export function createCommandEnvelope<T>(
  kind: RuntimeCommandKind,
  payload: T,
): RuntimeCommandEnvelope<T> {
  return {
    id: `cmd-${Date.now()}-${++_cmdSeq}`,
    commandKind: kind,
    payload,
    issuedAtUnixMs: Date.now(),
  };
}

/** Create the initial lifecycle entry for a command. */
export function createCommandLifecycle(
  envelope: RuntimeCommandEnvelope,
): CommandLifecycle {
  return {
    id: envelope.id,
    kind: envelope.commandKind,
    phase: "pending",
    progress: 0,
    message: null,
    error: null,
    issuedAt: envelope.issuedAtUnixMs,
    resolvedAt: null,
  };
}

/** Advance a lifecycle to the next phase. */
export function advanceLifecycle(
  lc: CommandLifecycle,
  phase: CommandLifecyclePhase,
  extra?: { progress?: number; message?: string | null; error?: string | null },
): CommandLifecycle {
  return {
    ...lc,
    phase,
    progress: extra?.progress ?? lc.progress,
    message: extra?.message ?? lc.message,
    error: extra?.error ?? lc.error,
    resolvedAt: phase === "completed" || phase === "failed" ? Date.now() : lc.resolvedAt,
  };
}
