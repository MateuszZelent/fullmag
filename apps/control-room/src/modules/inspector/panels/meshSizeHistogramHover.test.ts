import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";

import { emitMeshSizeHistogramHover } from "./meshSizeHistogramHover";

function kernelWithBus(emit: ReturnType<typeof vi.fn>): KernelApi {
  return {
    bus: { emit },
  } as unknown as KernelApi;
}

describe("emitMeshSizeHistogramHover", () => {
  it("publishes airbox histogram bins with API selection coordinates", () => {
    const emit = vi.fn();

    emitMeshSizeHistogramHover({
      bin: {
        binIndex: 12,
        binLabel: "4 nm to 8 nm",
        count: 20,
        distributionId: "tetra_size",
        distributionLabel: "Tetra size",
        fraction: 0.4,
        hi: 8e-9,
        lo: 4e-9,
      },
      kernel: kernelWithBus(emit),
      scope: { kind: "airbox" },
    });

    expect(emit).toHaveBeenCalledWith("viewport:mesh-size-bin-hovered", {
      highlight: expect.objectContaining({
        resource: {
          binIndex: 12,
          meshId: "study_domain",
          metric: "characteristic_size",
          partId: "airbox",
        },
      }),
      source: "inspector",
    });
  });

  it("clears histogram hover selection on mouse leave", () => {
    const emit = vi.fn();

    emitMeshSizeHistogramHover({
      bin: null,
      kernel: kernelWithBus(emit),
      scope: { kind: "airbox" },
    });

    expect(emit).toHaveBeenCalledWith("viewport:mesh-size-bin-hovered", {
      highlight: null,
      source: "inspector",
    });
  });
});
