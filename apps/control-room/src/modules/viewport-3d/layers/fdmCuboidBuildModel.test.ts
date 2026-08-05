import { describe, expect, it } from "vitest";

import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";
import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildFdmCuboidInstanceModel } from "./fdmCuboidBuildModel";

function fieldVector(
  values: number[],
  indexing?: DecodedFieldVector["indexing"],
  nodeIndices?: readonly number[] | null,
): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [values.length / 3, 1, 1],
    indexing,
    nComp: 3,
    nodeIndices,
    pointCount: values.length / 3,
    quantityId: "m",
    valueCount: values.length,
    values: new Float64Array(values),
  };
}

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
      {
        realizedRegionIds: new Uint32Array([
          FMRM_INACTIVE_REGION_ID,
          2,
          FMRM_INACTIVE_REGION_ID,
          1,
        ]),
      },
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

  it("keeps active unassigned cells and excludes the FMRM inactive sentinel", () => {
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
      {
        realizedRegionIds: new Uint32Array([
          FMRM_INACTIVE_REGION_ID,
          0,
          2,
          1,
        ]),
      },
    );

    expect(model?.cellIndices).toEqual(new Uint32Array([1, 2, 3]));
    expect(model?.regionIds).toEqual(new Uint32Array([0, 2, 1]));
    expect(model?.count).toBe(3);
  });

  it("does not render an authored fallback when realized membership is unavailable", () => {
    const model = buildFdmCuboidInstanceModel(
      {
        bounds: null,
        displayCellBudget: 2,
        displayCellCount: 2,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [2, 1, 1],
        spacing: [1, 1, 1],
        stride: 1,
        totalCells: 2,
      },
      { realizedRegionIds: null },
    );

    expect(model).toBeNull();
  });

  it("uses explicit FDM cell indices for magnitude thresholding", () => {
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
      {
        fieldVector: fieldVector(
          [
            1, 0, 0, // field index 0 is cell ordinal 3
            0.1, 0, 0, // field index 1 is cell ordinal 1
          ],
          "explicit_node_indices",
          [3, 1],
        ),
        voxelMagnitudeThreshold: 0.5,
      },
    );

    expect(model?.cellIndices).toEqual(new Uint32Array([3]));
  });
});
