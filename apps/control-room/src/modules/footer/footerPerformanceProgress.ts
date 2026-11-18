import type { RunPerformanceResource } from "@/kernel/api/apiTypes";

const OBSERVED_PERFORMANCE_STATES = new Set([
  "running", "completed", "cancelled", "error", "finalizing",
]);

/** This reports runner progress, independently of field/scalar sample clocks. */
export function resolveFooterPerformanceStep(
  currentRunId: string | null | undefined,
  performance: RunPerformanceResource | null | undefined,
): number | null {
  if (!currentRunId || !performance || performance.run_id !== currentRunId ||
      !OBSERVED_PERFORMANCE_STATES.has(performance.state)) return null;
  const step = performance.step_index;
  return typeof step === "number" && Number.isSafeInteger(step) && step >= 0
    ? step : null;
}
