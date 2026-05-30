import type {
  MeshHistogramMetric,
  MeshSizeHistogramHighlightScope,
} from "@/kernel/events/eventTypes";
import type { KernelApi } from "@/kernel/types";

import type { MeshSizeDistributionHoverBin } from "./MeshQualityChart";

export function emitMeshSizeHistogramHover({
  bin,
  kernel,
  scope,
}: {
  bin: MeshSizeDistributionHoverBin | null;
  kernel: KernelApi;
  scope: MeshSizeHistogramHighlightScope;
}): void {
  kernel.bus.emit("viewport:mesh-size-bin-hovered", {
    source: "inspector",
    highlight: bin
      ? {
          binLabel: bin.binLabel,
          count: bin.count,
          distributionId: bin.distributionId,
          distributionLabel: bin.distributionLabel,
          hi: bin.hi,
          lo: bin.lo,
          resource: resolveMeshHistogramHoverResource(bin, scope),
          scope,
        }
      : null,
  });
}

function resolveMeshHistogramHoverResource(
  bin: MeshSizeDistributionHoverBin,
  scope: MeshSizeHistogramHighlightScope,
): {
  binIndex: number;
  meshId: string;
  metric: MeshHistogramMetric;
  partId: string;
} | null {
  if (scope.kind !== "airbox") return null;
  const metric = meshHistogramMetricForDistribution(bin.distributionId);
  if (!metric) return null;
  return {
    binIndex: bin.binIndex,
    meshId: "study_domain",
    metric,
    partId: "airbox",
  };
}

function meshHistogramMetricForDistribution(
  distributionId: MeshSizeDistributionHoverBin["distributionId"],
): MeshHistogramMetric | null {
  switch (distributionId) {
    case "edge_length":
      return "edge_length";
    case "tetra_size":
      return "characteristic_size";
    case "volume":
      return "volume";
    default:
      return null;
  }
}
