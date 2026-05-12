/**
 * @module lib/fieldFrame/useFrameStaleness
 *
 * React hook that computes viewport field staleness relative
 * to the solver's current step.
 *
 * See: FE-001, FE-005 in fullmag-fem-regression-p6-frontend-hardening.mdx
 */

import { useMemo } from "react";
import { computeFrameStaleness, type FrameStalenessInfo } from "./frameGuard";
import type { FieldFrameEnvelope } from "./types";

/**
 * Compute staleness info from the currently applied field frame
 * envelope and the live solver step.
 *
 * Returns a stable reference when inputs haven't changed.
 */
export function useFrameStaleness(
  appliedEnvelope: FieldFrameEnvelope | null,
  currentSolverStep: number,
): FrameStalenessInfo {
  return useMemo(
    () => computeFrameStaleness(appliedEnvelope, currentSolverStep),
    [
      appliedEnvelope?.sessionId,
      appliedEnvelope?.runId,
      appliedEnvelope?.fieldRevision,
      appliedEnvelope?.sourceStep,
      currentSolverStep,
    ],
  );
}
