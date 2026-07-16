import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import type { FdmCuboidInstanceModel } from "./layers/FdmCuboidLayer";
import {
  buildViewport3DFdmInspectSample,
  formatViewport3DInspectComponents,
} from "./viewport3dInspect";

function vectorField(values: number[], quantityId = "m"): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [values.length / 3, 1, 1],
    nComp: 3,
    pointCount: values.length / 3,
    quantityId,
    valueCount: values.length,
    values: new Float64Array(values),
  };
}

function fdmModel(cellIndices: number[]): FdmCuboidInstanceModel {
  return {
    cellIndices: Uint32Array.from(cellIndices),
    cellSize: [1, 1, 1],
    centers: new Float32Array(cellIndices.length * 3),
    count: cellIndices.length,
    gridShape: [cellIndices.length, 1, 1],
    regionIds: null,
  };
}

describe("viewport3dInspect", () => {
  it("samples the displayed FDM field from the hovered cuboid instance", () => {
    const sample = buildViewport3DFdmInspectSample({
      fieldVector: vectorField([
        0.1, 0.2, 0.3,
        -0.5, 0.25, 0.75,
      ]),
      instanceId: 1,
      model: fdmModel([0, 1]),
      quantityId: "m",
      worldPosition: [2, 3, 4],
    });

    expect(sample).toEqual({
      components: [
        { label: "mx", value: -0.5 },
        { label: "my", value: 0.25 },
        { label: "mz", value: 0.75 },
        { label: "|m|", value: expect.closeTo(0.9354143467) },
      ],
      pointIndex: 1,
      quantityId: "m",
      status: "ready",
      targetLabel: "Cell 1",
      unit: null,
      worldPosition: [2, 3, 4],
    });
  });

  it("formats vector quantities with physical component labels and units", () => {
    const sample = buildViewport3DFdmInspectSample({
      fieldVector: vectorField([1, 2, 2], "H_demag"),
      instanceId: 0,
      model: fdmModel([0]),
      quantityId: "H_demag",
      worldPosition: [0, 0, 0],
    });

    expect(formatViewport3DInspectComponents(sample)).toEqual([
      "Hx 1 A/m",
      "Hy 2 A/m",
      "Hz 2 A/m",
      "|H| 3 A/m",
    ]);
  });

  it("does not fabricate a value when the hovered instance has no loaded field sample", () => {
    const sample = buildViewport3DFdmInspectSample({
      fieldVector: vectorField([1, 0, 0]),
      instanceId: 1,
      model: fdmModel([0, 3]),
      quantityId: "m",
      worldPosition: [0, 0, 0],
    });

    expect(sample).toEqual({
      message: "Field sample is not loaded for this cell.",
      quantityId: "m",
      status: "unavailable",
      targetLabel: "Cell 3",
      worldPosition: [0, 0, 0],
    });
  });
});
