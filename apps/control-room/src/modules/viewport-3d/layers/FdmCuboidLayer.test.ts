import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import {
  FDM_CUBOID_UPLOAD_BATCH_SIZE,
  buildFdmCuboidInstanceModel,
  buildFdmCuboidUploadBatches,
  buildFdmVectorSegments,
  resolveFdmVectorGlyphScale,
} from "./FdmCuboidLayer";

function domainFixture(
  overrides: Partial<FdmGridRenderDomain> = {},
): FdmGridRenderDomain {
  return {
    bounds: {
      center: [2e-9, 2e-9, 1.5e-9],
      radius: 3e-9,
      size: [4e-9, 4e-9, 3e-9],
    },
    displayCellBudget: 4,
    displayCellCount: 4,
    kind: "fdm-grid",
    origin: [0, 0, 0],
    shape: [4, 2, 1],
    spacing: [1e-9, 2e-9, 3e-9],
    stride: 2,
    totalCells: 8,
    ...overrides,
  };
}

function vectorField(values: number[]): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [values.length / 3, 1, 1],
    nComp: 3,
    pointCount: values.length / 3,
    quantityId: "m",
    valueCount: values.length,
    values: new Float64Array(values),
  };
}

describe("FdmCuboidLayer model", () => {
  it("samples FDM cells from grid shape, origin and spacing", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());

    expect(model?.count).toBe(4);
    expect(model?.cellSize[0]).toBeCloseTo(0.92e-9);
    expect(model?.cellSize[1]).toBeCloseTo(1.84e-9);
    expect(model?.cellSize[2]).toBeCloseTo(2.76e-9);
    expect(Array.from(model?.cellIndices ?? [])).toEqual([0, 2, 4, 6]);
    expect(Array.from(model?.centers ?? [])).toEqual([
      expect.closeTo(0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(0.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
    ]);
  });

  it("uses the requested voxel fill ratio for visible cell gaps", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      voxelFillRatio: 0.5,
    });

    expect(model?.cellSize[0]).toBeCloseTo(0.5e-9);
    expect(model?.cellSize[1]).toBeCloseTo(1e-9);
    expect(model?.cellSize[2]).toBeCloseTo(1.5e-9);
  });

  it("filters sampled cells by field magnitude threshold", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      fieldVector: vectorField([
        0.1, 0, 0,
        1, 0, 0,
        0.6, 0, 0,
        1, 0, 0,
        0.2, 0, 0,
        1, 0, 0,
        0.8, 0, 0,
        1, 0, 0,
      ]),
      voxelMagnitudeThreshold: 0.5,
    });

    expect(model?.count).toBe(2);
    expect(Array.from(model?.cellIndices ?? [])).toEqual([2, 6]);
  });

  it("applies stylized topography displacement from the selected field component", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      fieldVector: vectorField([
        0, 0, 0.5,
        0, 0, 0,
        0, 0, -0.25,
        0, 0, 0,
        0, 0, 0.75,
        0, 0, 0,
        0, 0, -0.5,
        0, 0, 0,
      ]),
      voxelTopography: {
        amplitudeCells: 2,
        component: "z",
        enabled: true,
      },
    });

    expect(Array.from(model?.centers ?? [])).toEqual([
      expect.closeTo(0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(4.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(0),
      expect.closeTo(0.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(6e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(-1.5e-9),
    ]);
  });

  it("returns no model when the FDM display budget resolves to zero cells", () => {
    expect(
      buildFdmCuboidInstanceModel(
        domainFixture({ displayCellCount: 0, totalCells: 0 }),
      ),
    ).toBeNull();
  });

  it("builds vector glyph segments from sampled FDM cell indices", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const segments = buildFdmVectorSegments(
      model,
      vectorField([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 1,
        0, 1, 0,
        0, 0, 1,
        -1, 0, 0,
        0, 0, 1,
      ]),
      2e-9,
      4,
    );

    expect(Array.from(segments ?? [])).toEqual([
      expect.closeTo(-0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      1,
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(0.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(2.5e-9),
      1,
      expect.closeTo(0.5e-9),
      expect.closeTo(2e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(0.5e-9),
      expect.closeTo(4e-9),
      expect.closeTo(1.5e-9),
      1,
      expect.closeTo(3.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
      1,
    ]);
  });

  it("can anchor FDM vector glyph segments by their tail", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const segments = buildFdmVectorSegments(
      model,
      vectorField([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 1,
        0, 1, 0,
        0, 0, 1,
        -1, 0, 0,
        0, 0, 1,
      ]),
      2e-9,
      1,
      { anchorMode: "tail" },
    );

    expect(Array.from(segments ?? [])).toEqual([
      expect.closeTo(0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      1,
    ]);
  });

  it("splits large FDM instanced uploads into bounded batches", () => {
    expect(buildFdmCuboidUploadBatches(0)).toEqual([]);
    expect(buildFdmCuboidUploadBatches(5, 2)).toEqual([
      { end: 2, start: 0 },
      { end: 4, start: 2 },
      { end: 5, start: 4 },
    ]);
    expect(FDM_CUBOID_UPLOAD_BATCH_SIZE).toBeLessThanOrEqual(4096);
  });

  it("caps rendered FDM vector glyph scale to the local voxel size", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      voxelFillRatio: 0.5,
    });

    expect(resolveFdmVectorGlyphScale(model, 100e-9)).toBeCloseTo(1.125e-9);
    expect(resolveFdmVectorGlyphScale(model, 0.25e-9)).toBeCloseTo(0.25e-9);
  });
});
