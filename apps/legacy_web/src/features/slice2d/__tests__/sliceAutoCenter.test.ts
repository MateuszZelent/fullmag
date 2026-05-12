import { describe, expect, it } from "vitest";

import { computeSliceAutoCenter } from "../sliceAutoCenter";

describe("slice2d auto center", () => {
  it("centers on visible magnetic extent along the requested normal axis", () => {
    const nodes = new Float64Array([
      0, 0, 0,
      4, 0, 0,
      0, 4, 0,
      0, 0, 4,
      20, 0, 0,
      30, 0, 0,
      20, 5, 0,
      20, 0, 6,
    ]);
    const elements = new Int32Array([
      0, 1, 2, 3,
      4, 5, 6, 7,
    ]);
    const visibleElements = new Uint8Array([0, 1]);
    expect(
      computeSliceAutoCenter({
        meshNodes: nodes,
        nNodes: 8,
        normalAxisIndex: 0,
        visibleElements,
        elements,
      }),
    ).toEqual({
      centerWorld: 25,
      magneticMin: 20,
      magneticMax: 30,
    });
  });

  it("falls back to full bounds when no visible magnetic extent exists", () => {
    const nodes = new Float64Array([
      -2, 0, 0,
      6, 0, 0,
      0, 3, 0,
      0, 0, 5,
    ]);
    expect(
      computeSliceAutoCenter({
        meshNodes: nodes,
        nNodes: 4,
        normalAxisIndex: 0,
        visibleElements: new Uint8Array([0]),
        elements: new Int32Array([0, 1, 2, 3]),
      }),
    ).toEqual({
      centerWorld: 2,
      magneticMin: -2,
      magneticMax: 6,
    });
  });
});
