import { describe, expect, it } from "vitest";

import { downsampleVectorFieldSpatialBins } from "../femFieldDownsample";

describe("downsampleVectorFieldSpatialBins", () => {
  it("averages vectors in spatial bins instead of selecting every nth node", () => {
    const nodes = new Float64Array([
      0, 0, 0,
      0.1, 0, 0,
      10, 0, 0,
      10.1, 0, 0,
    ]);
    const fieldData = {
      x: new Float64Array([1, 3, 10, 14]),
      y: new Float64Array([0, 0, 0, 0]),
      z: new Float64Array([0, 0, 0, 0]),
    };

    const downsampled = downsampleVectorFieldSpatialBins({
      nodes,
      nNodes: 4,
      fieldData,
      targetBins: 2,
    });

    expect(Array.from(downsampled?.x ?? [])).toEqual([2, 2, 12, 12]);
  });
});
