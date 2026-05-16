/**
 * @module components/plots/chartSampling
 *
 * Utility for extracting sampling cadence information from session
 * metadata. Used by both the Charts header and potentially the
 * Telemetry dock.
 */

import { fmtExp } from "@/lib/format";

// Re-export the helper to avoid a control-room import dependency
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export interface SamplingSummary {
  /** Human-readable label, e.g. "tableautosave(1.00e-11)" */
  cadenceLabel: string;
  /** Number of scalar output entries found in the execution plan */
  scalarOutputCount: number;
  /** Raw cadence in seconds, if available */
  cadenceSeconds: number | null;
}

/**
 * Extract scalar sampling cadence from session metadata.
 *
 * Traverses: `metadata.execution_plan.output_plan.outputs[]`
 * and finds entries with `kind === "scalar"` and `every_seconds`.
 */
export function extractSamplingSummary(
  metadata: unknown,
): SamplingSummary {
  const metaRecord = asRecord(metadata);
  const executionPlan = asRecord(metaRecord?.execution_plan);
  const outputPlan = asRecord(executionPlan?.output_plan);
  const outputs = Array.isArray(outputPlan?.outputs) ? outputPlan.outputs : [];

  const scalarCadences = outputs
    .map((output) => asRecord(output))
    .filter(
      (output): output is Record<string, unknown> =>
        output?.kind === "scalar",
    )
    .map((output) => {
      const everySeconds = output.every_seconds;
      return typeof everySeconds === "number" && Number.isFinite(everySeconds)
        ? everySeconds
        : null;
    })
    .filter(
      (everySeconds): everySeconds is number => everySeconds !== null,
    );

  const uniqueCadences = [...new Set(scalarCadences)];
  const cadenceSeconds = uniqueCadences.length > 0 ? uniqueCadences[0] : null;
  const cadenceLabel =
    cadenceSeconds !== null
      ? `tableautosave(${fmtExp(cadenceSeconds)})`
      : "tableautosave";

  return {
    cadenceLabel,
    scalarOutputCount: scalarCadences.length,
    cadenceSeconds,
  };
}
