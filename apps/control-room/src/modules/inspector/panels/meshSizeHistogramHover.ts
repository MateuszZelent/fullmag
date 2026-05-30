import type {
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
          scope,
        }
      : null,
  });
}
