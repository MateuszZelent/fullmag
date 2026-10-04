import type { LiveStatusResource } from "../api/apiTypes";

export type RunOutcomeStatus = "ready" | "failed" | "cancelled";

/** Mirrors the host's `RunOutcomeRecord`; field names are the wire names. */
export interface RunOutcomeRecord {
  readonly run_id: string;
  /** RFC 3339. */
  readonly started_at: string;
  readonly status: RunOutcomeStatus;
  readonly finished_at?: string;
  readonly device?: string;
  readonly backend?: string;
  readonly error?: string;
  readonly duration_seconds?: number;
  readonly frames?: number;
  readonly output_bytes?: number;
}

export interface RunOutcomePreview {
  readonly png_base64: string;
  readonly colouring: string;
}

export type RunStatePhase = "active" | RunOutcomeStatus | "other";

export interface RunLifecycleObservation {
  readonly sessionKey: string;
  readonly solverState: string;
  readonly run: {
    readonly runId: string;
    readonly startedAt: string;
    readonly resolvedDevice: string;
  } | null;
  readonly discretization: string | null;
}

export interface ActiveRunObservation {
  readonly observation: RunLifecycleObservation;
  readonly sinceMs: number;
}

export interface RunOutcomeTracker {
  readonly active: ActiveRunObservation | null;
}

export const INITIAL_RUN_OUTCOME_TRACKER: RunOutcomeTracker = { active: null };

const ACTIVE_STATES: ReadonlySet<string> = new Set(["running", "paused", "breaking"]);
const READY_STATES: ReadonlySet<string> = new Set(["completed", "finished"]);
const FAILED_STATES: ReadonlySet<string> = new Set(["failed", "error"]);

/**
 * Classifies the effective solver state. `lifecycle.solver` carries the
 * runtime status code (`running`, `paused`, `breaking`, `completed`, `failed`,
 * `cancelled`, ...); the thin `solver.state` uses `finished` and `error` for the
 * same terminal outcomes and is only a fallback.
 */
export function classifySolverState(state: string): RunStatePhase {
  const normalized = state.trim().toLowerCase();
  if (ACTIVE_STATES.has(normalized)) return "active";
  if (READY_STATES.has(normalized)) return "ready";
  if (FAILED_STATES.has(normalized)) return "failed";
  if (normalized === "cancelled") return "cancelled";
  return "other";
}

export function observeRunLifecycle(
  status: LiveStatusResource | null | undefined,
): RunLifecycleObservation | null {
  if (!status) return null;
  const sessionId = status.session?.session_id?.trim();
  const sessionEpoch = status.session?.session_epoch?.trim();
  if (!sessionId || !sessionEpoch) return null;
  const solverState = status.lifecycle?.solver || status.solver?.state || "";
  const run = status.run
    ? {
        resolvedDevice: status.run.resolved_device,
        runId: status.run.run_id,
        startedAt: status.run.started_at,
      }
    : null;
  return {
    discretization: status.domain?.discretization ?? null,
    run,
    sessionKey: `${sessionId}\u0000${sessionEpoch}`,
    solverState,
  };
}

export function runLifecycleObservationsEqual(
  left: RunLifecycleObservation | null,
  right: RunLifecycleObservation | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.sessionKey === right.sessionKey &&
    left.solverState === right.solverState &&
    left.discretization === right.discretization &&
    left.run?.runId === right.run?.runId &&
    left.run?.startedAt === right.run?.startedAt &&
    left.run?.resolvedDevice === right.run?.resolvedDevice
  );
}

function runStartMs(startedAt: string): number | null {
  const text = startedAt.trim();
  if (/^\d+$/.test(text)) {
    const ms = Number(text);
    return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Returns a record exactly when a run leaves an active state for a terminal
 * one inside the same session. `activeSinceMs` is when the caller first saw
 * the run active; the status only carries the session start, which is the
 * fallback.
 */
export function runOutcomeFromStatusTransition(
  prev: RunLifecycleObservation | null,
  next: RunLifecycleObservation | null,
  options: { readonly nowMs?: number; readonly activeSinceMs?: number | null } = {},
): RunOutcomeRecord | null {
  if (!prev || !next || !prev.run) return null;
  if (prev.sessionKey !== next.sessionKey) return null;
  if (classifySolverState(prev.solverState) !== "active") return null;
  const phase = classifySolverState(next.solverState);
  if (phase === "active" || phase === "other") return null;
  if (next.run && next.run.runId !== prev.run.runId) return null;

  const run = next.run ?? prev.run;
  const nowMs = options.nowMs ?? Date.now();
  const startMs = options.activeSinceMs ?? runStartMs(run.startedAt) ?? nowMs;
  const durationSeconds = Math.max(0, Math.round(((nowMs - startMs) / 1000) * 10) / 10);
  const device = run.resolvedDevice.trim();
  const backend = (next.discretization ?? prev.discretization)?.trim().toUpperCase();
  return {
    run_id: run.runId,
    started_at: new Date(startMs).toISOString(),
    status: phase,
    finished_at: new Date(nowMs).toISOString(),
    duration_seconds: durationSeconds,
    ...(device ? { device } : {}),
    ...(backend ? { backend } : {}),
  };
}

/**
 * Folds one status observation into the tracker. The tracker remembers the
 * last active observation so a terminal state is attributed to its run even if
 * a status refresh skipped the intermediate states; it is reset on a session change and
 * after an outcome, so a repeated terminal status never records twice.
 */
export function advanceRunOutcomeTracker(
  tracker: RunOutcomeTracker,
  observation: RunLifecycleObservation | null,
  nowMs: number,
): { readonly tracker: RunOutcomeTracker; readonly outcome: RunOutcomeRecord | null } {
  if (!observation) return { tracker: INITIAL_RUN_OUTCOME_TRACKER, outcome: null };
  const active = tracker.active;
  const sameSession = active?.observation.sessionKey === observation.sessionKey;
  const phase = classifySolverState(observation.solverState);

  if (phase === "active") {
    if (observation.run === null) return { tracker: INITIAL_RUN_OUTCOME_TRACKER, outcome: null };
    if (active && sameSession && active.observation.run?.runId === observation.run.runId) {
      return { tracker: { active: { observation, sinceMs: active.sinceMs } }, outcome: null };
    }
    return { tracker: { active: { observation, sinceMs: nowMs } }, outcome: null };
  }

  if (!active || !sameSession) return { tracker: INITIAL_RUN_OUTCOME_TRACKER, outcome: null };
  const outcome = runOutcomeFromStatusTransition(active.observation, observation, {
    activeSinceMs: active.sinceMs,
    nowMs,
  });
  return { tracker: INITIAL_RUN_OUTCOME_TRACKER, outcome };
}
