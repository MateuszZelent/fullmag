/**
 * @module lib/fieldFrame/frameGuard
 *
 * Monotonic frame guard — rejects stale or out-of-order field frames.
 *
 * See: FEM-DP-001 in fullmag-fem-regression-p2-data-plane.mdx
 */

import type { FieldFrameEnvelope } from "./types";

/**
 * Determine whether a new frame should replace the currently applied frame.
 *
 * Rules:
 * 1. Different session → always accept (new experiment).
 * 2. Different run → always accept (re-run).
 * 3. Higher backend epoch → accept (backend restart).
 * 4. Different mesh generation → accept (remesh).
 * 5. Higher field revision → accept (normal solver tick).
 * 6. Everything else → reject (stale / duplicate / out-of-order).
 */
export function shouldAcceptFrame(
  prev: FieldFrameEnvelope | null,
  next: FieldFrameEnvelope,
): boolean {
  if (!prev) return true;
  if (prev.sessionId !== next.sessionId) return true;
  if (prev.runId !== next.runId) return true;
  if (next.backendEpoch > prev.backendEpoch) return true;
  if (next.backendEpoch < prev.backendEpoch) return false;
  if (
    prev.meshGenerationId !== null &&
    next.meshGenerationId !== null &&
    prev.meshGenerationId !== next.meshGenerationId
  ) {
    return true;
  }
  return next.fieldRevision > prev.fieldRevision;
}

/**
 * Staleness info for UI display.
 */
export interface FrameStalenessInfo {
  /** True if the viewport is showing data older than the solver's current step. */
  isStale: boolean;
  /** Number of solver steps the viewport is behind. */
  staleSteps: number;
  /** Currently applied field revision. */
  appliedFieldRevision: number;
  /** Currently applied source step. */
  appliedSourceStep: number;
  /** Current solver step (from live state). */
  currentSolverStep: number;
}

/**
 * Compute staleness from the applied frame and the solver's current step.
 */
export function computeFrameStaleness(
  appliedEnvelope: FieldFrameEnvelope | null,
  currentSolverStep: number,
): FrameStalenessInfo {
  if (!appliedEnvelope) {
    return {
      isStale: currentSolverStep > 0,
      staleSteps: currentSolverStep,
      appliedFieldRevision: 0,
      appliedSourceStep: 0,
      currentSolverStep,
    };
  }
  const staleSteps = Math.max(0, currentSolverStep - appliedEnvelope.sourceStep);
  return {
    isStale: staleSteps > 0,
    staleSteps,
    appliedFieldRevision: appliedEnvelope.fieldRevision,
    appliedSourceStep: appliedEnvelope.sourceStep,
    currentSolverStep,
  };
}

/**
 * Log diagnostic info when a frame is accepted or rejected.
 * Only active when diagnostic flags are enabled.
 */
export function logFrameDecision(
  decision: "accepted" | "rejected",
  prev: FieldFrameEnvelope | null,
  next: FieldFrameEnvelope,
  enableDiagnostics: boolean,
): void {
  if (!enableDiagnostics) return;
  const tag = decision === "accepted" ? "✓ FRAME ACCEPTED" : "✗ FRAME REJECTED";
  const prevInfo = prev
    ? `prev(rev=${prev.fieldRevision}, step=${prev.sourceStep}, q=${prev.quantityId})`
    : "prev(none)";
  const nextInfo = `next(rev=${next.fieldRevision}, step=${next.sourceStep}, q=${next.quantityId}, mesh=${next.meshGenerationId ?? "n/a"})`;
  console.debug(`[FieldFrame] ${tag}: ${prevInfo} → ${nextInfo}`);
}
