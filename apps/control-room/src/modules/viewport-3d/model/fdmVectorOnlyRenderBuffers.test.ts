import { describe, expect, it } from "vitest";

import type { FdmCuboidBuildResult } from "../layers/fdmCuboidBuildModel";

import { resolveFdmVectorOnlyRenderBuffers } from "./fdmVectorOnlyRenderBuffers";

const vectorSegments = new Float32Array([
  0, 0, 0, 1, 0, 0, 0.5,
  1, 0, 0, 0, 1, 0, 1,
]);
const vectorCellIndices = Uint32Array.from([2, 0]);
const vectorOnlyBuildResult: FdmCuboidBuildResult = {
  model: null,
  vectorCellIndices,
  vectorSegments,
};
const visibleVectorInput = {
  buildResult: vectorOnlyBuildResult,
  fieldAvailable: true,
  layerVisible: true,
  vectorsEnabled: true,
};

describe("FDM vector-only render buffers", () => {
  it("keeps ready glyphs and sampled cell indices when the cell model is null", () => {
    const resolved = resolveFdmVectorOnlyRenderBuffers(visibleVectorInput);

    expect(resolved.vectorsVisible).toBe(true);
    expect(resolved.vectorSegments).toBe(vectorSegments);
    expect(resolved.vectorCellIndices).toBe(vectorCellIndices);
  });

  it.each([
    {
      fieldAvailable: false,
      layerVisible: true,
      vectorsEnabled: true,
      reason: "the target field is unavailable",
    },
    {
      fieldAvailable: true,
      layerVisible: false,
      vectorsEnabled: true,
      reason: "the target is hidden",
    },
    {
      fieldAvailable: true,
      layerVisible: true,
      vectorsEnabled: false,
      reason: "vectors are disabled",
    },
  ])("keeps vector buffers gated when $reason", ({
    fieldAvailable,
    layerVisible,
    vectorsEnabled,
  }) => {
    const resolved = resolveFdmVectorOnlyRenderBuffers({
      ...visibleVectorInput,
      fieldAvailable,
      layerVisible,
      vectorsEnabled,
    });

    expect(resolved).toEqual({
      vectorCellIndices: null,
      vectorSegments: null,
      vectorsVisible: false,
    });
  });

  it("has no segments while the vector-only build is pending", () => {
    const resolved = resolveFdmVectorOnlyRenderBuffers({
      ...visibleVectorInput,
      buildResult: null,
    });

    expect(resolved).toEqual({
      vectorCellIndices: null,
      vectorSegments: null,
      vectorsVisible: true,
    });
  });
});
