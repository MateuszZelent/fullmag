import type { MouseHandlerDataParam } from "recharts/types/synchronisation/types";

import type {
  MeshSizeDistribution,
} from "@/shared/domain/mesh/qualityStatistics";

import type { MeshSizeDistributionHoverBin } from "./MeshQualityChart";

export function resolveActiveHistogramBinIndex(
  state: Pick<MouseHandlerDataParam, "activeTooltipIndex" | "isTooltipActive">,
  histogramBinCount: number,
): number | null {
  if (!state.isTooltipActive || histogramBinCount <= 0) {
    return null;
  }

  const activeIndex = state.activeTooltipIndex;
  const normalizedIndex =
    typeof activeIndex === "number"
      ? activeIndex
      : typeof activeIndex === "string"
        ? Number.parseInt(activeIndex, 10)
        : Number.NaN;

  if (
    !Number.isInteger(normalizedIndex) ||
    normalizedIndex < 0 ||
    normalizedIndex >= histogramBinCount
  ) {
    return null;
  }

  return normalizedIndex;
}

export function buildMeshSizeDistributionHoverBin(
  distribution: MeshSizeDistribution,
  index: number,
): MeshSizeDistributionHoverBin | null {
  const bin = distribution.histogram[index];
  if (!bin) {
    return null;
  }

  return {
    binIndex: index,
    binLabel: bin.label,
    count: bin.count,
    distributionId: distribution.id,
    distributionLabel: distribution.label,
    fraction: bin.fraction,
    hi: bin.hi,
    lo: bin.lo,
  };
}
