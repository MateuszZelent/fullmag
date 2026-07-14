import { describe, expect, it } from "vitest";

import { buildFdmCuboidInstanceModel } from "./fdmCuboidBuildModel";

describe("FDM cuboid realized membership", () => {
  it("renders only cells present in the authoritative realized mask", () => {
    const model = buildFdmCuboidInstanceModel(
      {
        bounds: null,
        displayCellBudget: 4,
        displayCellCount: 4,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [4, 1, 1],
        spacing: [1, 1, 1],
        stride: 1,
        totalCells: 4,
      },
      { realizedRegionIds: new Uint32Array([0, 2, 0, 1]) },
    );

    expect(model?.cellIndices).toEqual(new Uint32Array([1, 3]));
    expect(model?.regionIds).toEqual(new Uint32Array([2, 1]));
    expect(model?.count).toBe(2);
  });

  it("keeps authored grid sampling distinguishable when no realized mask exists", () => {
    const model = buildFdmCuboidInstanceModel({
      bounds: null,
      displayCellBudget: 2,
      displayCellCount: 2,
      kind: "fdm-grid",
      origin: [0, 0, 0],
      shape: [2, 1, 1],
      spacing: [1, 1, 1],
      stride: 1,
      totalCells: 2,
    });

    expect(model?.regionIds).toBeNull();
    expect(model?.cellIndices).toEqual(new Uint32Array([0, 1]));
  });
});
