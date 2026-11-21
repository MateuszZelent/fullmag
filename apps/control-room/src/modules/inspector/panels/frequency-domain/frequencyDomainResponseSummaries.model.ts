import type { FrequencyResponsePoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { record, finiteNumber, nonnegativeFiniteNumber } from "./frequencyDomainResultFormatting";

export interface FrequencyResponsePointResidualSummary {
  absoluteL2: number | null;
  relativeL2: number | null;
  reported: number | null;
}

export function countResidualEvidencePoints(
  points: readonly {
    residualAbsoluteL2?: number | null;
    residualNorm: number | null;
    residualRelativeL2?: number | null;
  }[],
): number {
  return points.filter((point) =>
    (typeof point.residualNorm === "number" && Number.isFinite(point.residualNorm)) ||
    nonnegativeFiniteNumber(point.residualAbsoluteL2) != null ||
    nonnegativeFiniteNumber(point.residualRelativeL2) != null,
  ).length;
}

export function buildFrequencyResponsePointResidualSummary(
  payload: unknown,
  point: Pick<
    FrequencyResponsePoint,
    "residualAbsoluteL2" | "residualNorm" | "residualRelativeL2"
  > | null,
): FrequencyResponsePointResidualSummary {
  const resource = record(payload);
  return {
    absoluteL2:
      nonnegativeFiniteNumber(resource?.residual_l2_norm) ??
      nonnegativeFiniteNumber(point?.residualAbsoluteL2),
    relativeL2:
      nonnegativeFiniteNumber(resource?.relative_residual_l2_norm) ??
      nonnegativeFiniteNumber(point?.residualRelativeL2),
    reported:
      finiteNumber(resource?.residual_norm ?? resource?.relative_residual_norm) ??
      finiteNumber(point?.residualNorm),
  };
}
