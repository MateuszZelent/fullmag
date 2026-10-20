export interface RuntimeStateSource {
  detailedRuntimeState?: unknown;
  sessionSolverState?: unknown;
}

export function resolveEffectiveRuntimeState({
  detailedRuntimeState,
  sessionSolverState,
}: RuntimeStateSource): string | null {
  return normalizeRuntimeState(detailedRuntimeState) ?? normalizeRuntimeState(sessionSolverState);
}

export function formatRuntimeStateLabel(
  value: unknown,
  fallback = "unknown",
): string {
  const token = normalizeRuntimeState(value);
  if (!token) return fallback;
  const label = token.replaceAll(/[-_]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function isRuntimeStateActive(value: unknown): boolean {
  return normalizeRuntimeState(value) === "running";
}

export function isRuntimeStateWaitingForCompute(value: unknown): boolean {
  return normalizeRuntimeState(value) === "waiting_for_compute";
}

export function readDetailedRuntimeState(resource: unknown): string | null {
  if (!resource || typeof resource !== "object") return null;
  return normalizeRuntimeState(
    (resource as { runtime_state?: unknown }).runtime_state,
  );
}

function normalizeRuntimeState(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

/**
 * User-visible phase between model materialization and an explicit Compute.
 *
 * `awaiting_user_solve`: the runtime holds a materialized model and waits for
 * the user to invoke Compute. The backend publishes it either as
 * `waiting_for_compute`, or as session `awaiting_command` paired with a run in
 * `waiting_for_solve` (accepted-study projection maps the latter to the
 * former for the session view). `awaiting_command` alone is NOT enough: the
 * same session state follows a completed stage.
 *
 * `preparing_model`: the backend reported `accepted_preparation_pending`; the
 * Compute gate stays held until preparation is published.
 */
export type RuntimeUserSolvePhase = "awaiting_user_solve" | "preparing_model";

export const AWAITING_USER_SOLVE_LABEL = "Model ready — waiting for Compute";
export const PREPARING_MODEL_LABEL = "Preparing model";

export interface RuntimeUserSolvePhaseSource {
  /** Detailed solver-status `runtime_state`. */
  detailedRuntimeState?: unknown;
  /** Thin session status `solver.state` (public session status). */
  sessionSolverState?: unknown;
  /** Current-run `status`. */
  runStatus?: unknown;
  /** Current-run `status_reason`, when published. */
  runStatusReason?: unknown;
}

const PREPARATION_PENDING_TOKEN = "accepted_preparation_pending";
const SESSION_STATES_COMPATIBLE_WITH_WAITING_RUN = new Set([
  "awaiting_command",
  "waiting_for_solve",
  "waiting_for_compute",
]);

export function resolveRuntimeUserSolvePhase({
  detailedRuntimeState,
  sessionSolverState,
  runStatus,
  runStatusReason,
}: RuntimeUserSolvePhaseSource): RuntimeUserSolvePhase | null {
  const runtimeState = normalizeRuntimeState(detailedRuntimeState);
  const sessionState = normalizeRuntimeState(sessionSolverState);
  const run = normalizeRuntimeState(runStatus);
  const reason = normalizeRuntimeState(runStatusReason);
  const effective = runtimeState ?? sessionState;

  if (
    effective === PREPARATION_PENDING_TOKEN ||
    run === PREPARATION_PENDING_TOKEN ||
    reason === PREPARATION_PENDING_TOKEN
  ) {
    return "preparing_model";
  }
  if (effective === "waiting_for_compute" || effective === "waiting_for_solve") {
    return "awaiting_user_solve";
  }
  if (
    (run === "waiting_for_solve" || run === "waiting_for_compute") &&
    (effective === null || SESSION_STATES_COMPATIBLE_WITH_WAITING_RUN.has(effective))
  ) {
    return "awaiting_user_solve";
  }
  return null;
}

export function isRuntimeAwaitingUserSolve(
  source: RuntimeUserSolvePhaseSource,
): boolean {
  return resolveRuntimeUserSolvePhase(source) === "awaiting_user_solve";
}

export function formatRuntimeUserSolvePhaseLabel(
  phase: RuntimeUserSolvePhase,
): string {
  return phase === "preparing_model"
    ? PREPARING_MODEL_LABEL
    : AWAITING_USER_SOLVE_LABEL;
}
