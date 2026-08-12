import { chartSeriesObservableIdentityKey } from "@/shared/domain/analysis/chartSeries";

import type { ChartSeries } from "./chartTableModel";

export const ANALYSIS_COMPARISON_UNAVAILABLE_REASON =
  "Comparison requires two revisioned datasets with complete typed owner identities; the current table contract does not publish them.";

export interface AnalysisComparisonIdentity {
  boundaryContext: string | null;
  equilibriumId: string | null;
  geometryId: string | null;
  kContext: string | null;
  meshId: string | null;
  observableId: string | null;
  runId: string | null;
  stageId: string | null;
}

export type AnalysisComparisonVerdict =
  | { reasons: []; status: "compatible" }
  | { reasons: string[]; status: "cannot-compare" };

const COMPARISON_IDENTITY_FIELDS = [
  ["runId", "run"],
  ["stageId", "stage"],
  ["equilibriumId", "equilibrium"],
  ["geometryId", "geometry"],
  ["meshId", "mesh"],
  ["boundaryContext", "boundary context"],
  ["kContext", "k context"],
  ["observableId", "observable"],
] as const;

/** Pure helper for future revisioned Comparison inputs; it is not a production availability path. */
export function comparisonSeriesKey(
  series: Parameters<typeof chartSeriesObservableIdentityKey>[0] & Partial<Pick<ChartSeries, "columnId">>,
): string | null {
  return chartSeriesObservableIdentityKey(series);
}

export function analysisComparisonVerdict(
  primary: AnalysisComparisonIdentity | null | undefined,
  secondary: AnalysisComparisonIdentity | null | undefined,
  seriesContext?: {
    hasCompatibleSeries: boolean;
    primaryXAxis: { column_id: string; unit: string } | null;
    secondaryXAxis: { column_id: string; unit: string } | null;
  },
): AnalysisComparisonVerdict {
  const reasons: string[] = [];
  for (const [field, label] of COMPARISON_IDENTITY_FIELDS) {
    const left = primary?.[field];
    const right = secondary?.[field];
    if (!left || !right) reasons.push(`${label} identity unavailable`);
    else if (left !== right) reasons.push(`${label} mismatch: ${left} ≠ ${right}`);
  }
  if (seriesContext) {
    const leftAxis = seriesContext.primaryXAxis;
    const rightAxis = seriesContext.secondaryXAxis;
    if (!leftAxis || !rightAxis) reasons.push("axis identity and SI unit unavailable");
    else if (leftAxis.column_id !== rightAxis.column_id || leftAxis.unit !== rightAxis.unit) {
      reasons.push(`axis mismatch: ${leftAxis.column_id} [${leftAxis.unit}] ≠ ${rightAxis.column_id} [${rightAxis.unit}]`);
    }
    if (!seriesContext.hasCompatibleSeries) {
      reasons.push("observable quantity and SI unit mismatch or unavailable");
    }
  }
  return reasons.length > 0
    ? { reasons: [...new Set(reasons)], status: "cannot-compare" }
    : { reasons: [], status: "compatible" };
}
