import { describe, expect, it } from "vitest";

import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { buildFdmSampledScalarColors } from "../viewport3dFieldMapping";

import {
  buildFdmCuboidInstanceModel,
  buildFdmDenseNativeLayerInstanceModel,
  buildViewport3DFdmCuboid,
  estimateFdmCuboidBuildOutputBytes,
  resolveFdmCuboidMembershipRevision,
  transferablesForFdmCuboidBuildResult,
} from "./fdmCuboidBuildModel";

function allActiveMembership(cellCount: number): Uint32Array {
  return new Uint32Array(cellCount);
}

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
  it("keeps membership revision stable across geometry-only changes", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 3,
      displayCellCount: 3,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [3, 1, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 1,
      totalCells: 3,
    };
    const original = buildFdmDenseNativeLayerInstanceModel(domain);
    const translated = buildFdmDenseNativeLayerInstanceModel({
      ...domain,
      origin: [10, 0, 0],
    });

    expect(original?.matrixContentRevision).not.toBe(
      translated?.matrixContentRevision,
    );
    expect(original?.membershipRevision).toBe(translated?.membershipRevision);
    expect(resolveFdmCuboidMembershipRevision(Uint32Array.from([0, 2, 1]))).not.toBe(
      original?.membershipRevision,
    );
  });

  it("builds a bounded native layer display without accepting an FMRM mask", () => {
    const model = buildFdmDenseNativeLayerInstanceModel({
      bounds: null,
      displayCellBudget: 2,
      displayCellCount: 2,
      kind: "fdm-grid",
      origin: [0, 0, -1],
      shape: [2, 1, 1],
      spacing: [1, 1, 2],
      stride: 1,
      totalCells: 2,
    });

    expect(model?.cellIndices).toEqual(new Uint32Array([0, 1]));
    expect(model?.regionIds).toEqual(new Uint32Array([0, 0]));
  });

  it("builds a dense native carrier through the worker-safe request contract", () => {
    const result = buildViewport3DFdmCuboid({
      cellSelection: "dense",
      domain: {
        bounds: null,
        displayCellBudget: 4096,
        displayCellCount: 4096,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [64, 64, 1],
        spacing: [1, 1, 1],
        stride: 1,
        totalCells: 4096,
      },
      maxVectorGlyphs: 0,
      realizedRegionIds: null,
      vectorAnchorMode: "center",
      vectorScale: 1,
      voxelFillRatio: 0.92,
      voxelMagnitudeThreshold: 0,
      voxelTopography: {
        amplitudeCells: 0,
        component: "magnitude",
        enabled: false,
      },
    });

    expect(result.model?.count).toBe(4096);
    expect(result.model?.centers).toHaveLength(4096 * 3);
    expect(result.model?.matrices).toHaveLength(4096 * 16);
    expect(result.model?.matrices.slice(0, 16)).toEqual(Float32Array.from([
      0.92, 0, 0, 0,
      0, 0.92, 0, 0,
      0, 0, 0.92, 0,
      0.5, 0.5, 0.5, 1,
    ]));
    expect(transferablesForFdmCuboidBuildResult(result)).toContain(
      result.model?.matrices.buffer,
    );
  });

  it("accounts for prepared matrices in the worker output memory estimate", () => {
    const request = {
      cellSelection: "dense" as const,
      domain: {
        bounds: null,
        displayCellBudget: 153_600,
        displayCellCount: 153_600,
        kind: "fdm-grid" as const,
        origin: [0, 0, 0] as [number, number, number],
        shape: [320, 240, 2] as [number, number, number],
        spacing: [1, 1, 1] as [number, number, number],
        stride: 1,
        totalCells: 153_600,
      },
      maxVectorGlyphs: 0,
      realizedRegionIds: null,
      vectorAnchorMode: "center" as const,
      vectorScale: 1,
      voxelFillRatio: 0.92,
      voxelMagnitudeThreshold: 0,
      voxelTopography: {
        amplitudeCells: 0,
        component: "magnitude" as const,
        enabled: false,
      },
    };

    expect(estimateFdmCuboidBuildOutputBytes(request)).toBeGreaterThanOrEqual(
      153_600 * (16 + 3 + 1) * Float32Array.BYTES_PER_ELEMENT,
    );
    expect(estimateFdmCuboidBuildOutputBytes(request)).toBe(
      153_600 *
        (16 * Float32Array.BYTES_PER_ELEMENT +
          3 * Float32Array.BYTES_PER_ELEMENT +
          2 * Uint32Array.BYTES_PER_ELEMENT),
    );
  });

  it("keeps surface vector indices in the same order and scope as worker segments", () => {
    const values = Array.from({ length: 27 }, () => [1, 0, 0]).flat();
    const result = buildViewport3DFdmCuboid({
      cellSelection: "dense",
      domain: {
        bounds: null,
        displayCellBudget: 27,
        displayCellCount: 27,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [3, 3, 3],
        spacing: [1, 1, 1],
        stride: 1,
        totalCells: 27,
      },
      maxVectorGlyphs: 27,
      realizedRegionIds: null,
      vectorAnchorMode: "center",
      vectorField: fieldVector(values),
      vectorGeometryScope: "surface",
      vectorScale: 1,
      voxelFillRatio: 0.92,
      voxelMagnitudeThreshold: 0,
      voxelTopography: {
        amplitudeCells: 0,
        component: "magnitude",
        enabled: false,
      },
    });

    expect(result.vectorCellIndices).toHaveLength(26);
    expect(result.vectorCellIndices).not.toContain(13);
    expect(result.vectorSegments).toHaveLength(26 * 7);
    const colors = buildFdmSampledScalarColors(
      fieldVector(values),
      result.vectorCellIndices,
      27,
    );
    expect(colors?.colors).toHaveLength(26 * 3);
    expect((colors?.colors.length ?? 0) / 3).toBe(
      (result.vectorSegments?.length ?? 0) / 7,
    );
  });

  it("fails closed for an all-cell pass without an exact FMRM mask", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 2,
      displayCellCount: 2,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [2, 1, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 1,
      totalCells: 2,
    };

    const model = Reflect.apply(buildFdmCuboidInstanceModel, undefined, [
      domain,
      { cellSelection: "all" },
    ]);

    expect(model).toBeNull();
  });

  it("fails closed for a missing selection even when membership is exact", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 2,
      displayCellCount: 2,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [2, 1, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 1,
      totalCells: 2,
    };

    const model = Reflect.apply(buildFdmCuboidInstanceModel, undefined, [
      domain,
      { realizedRegionIds: allActiveMembership(2) },
    ]);

    expect(model).toBeNull();
  });

  it("splits a current FMRM membership into active magnetic and inactive Airbox cells", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 4,
      displayCellCount: 4,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [4, 1, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 1,
      totalCells: 4,
    };
    const realizedRegionIds = new Uint32Array([
      FMRM_INACTIVE_REGION_ID,
      7,
      FMRM_INACTIVE_REGION_ID,
      3,
    ]);

    const magnetic = buildFdmCuboidInstanceModel(domain, {
      cellSelection: "active",
      realizedRegionIds,
    });
    const airbox = buildFdmCuboidInstanceModel(domain, {
      cellSelection: "inactive",
      realizedRegionIds,
    });

    expect(magnetic?.cellIndices).toEqual(new Uint32Array([1, 3]));
    expect(magnetic?.regionIds).toEqual(new Uint32Array([7, 3]));
    expect(airbox?.cellIndices).toEqual(new Uint32Array([0, 2]));
    expect(airbox?.regionIds).toEqual(
      new Uint32Array([FMRM_INACTIVE_REGION_ID, FMRM_INACTIVE_REGION_ID]),
    );
  });

  it("fails closed instead of building authored cell cuboids for an unmaterialized selection", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 2,
      displayCellCount: 2,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [2, 1, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 1,
      totalCells: 2,
    };

    expect(
      buildFdmCuboidInstanceModel(domain, {
        cellSelection: "active",
        realizedRegionIds: null,
      }),
    ).toBeNull();
  });

  it("fails closed for a stale or grid-mismatched membership mask", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 2,
      displayCellCount: 2,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [2, 1, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 1,
      totalCells: 2,
    };

    expect(
      buildFdmCuboidInstanceModel(domain, {
        cellSelection: "all",
        realizedRegionIds: null,
      }),
    ).toBeNull();
    expect(
      buildFdmCuboidInstanceModel(domain, {
        cellSelection: "all",
        realizedRegionIds: new Uint32Array([1]),
      }),
    ).toBeNull();
  });

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
        cellSelection: "active",
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

  it("keeps a deterministic sample for a small realized target region", () => {
    const realizedRegionIds = new Uint32Array(100);
    realizedRegionIds.fill(1);
    realizedRegionIds[99] = 2;

    const sampled = buildFdmCuboidInstanceModel(
      {
        bounds: null,
        displayCellBudget: 4,
        displayCellCount: 4,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [100, 1, 1],
        spacing: [1, 1, 1],
        stride: 25,
        totalCells: 100,
      },
      {
        cellSelection: "active",
        realizedRegionIds,
      },
    );

    expect(sampled?.count).toBe(4);
    expect(Array.from(sampled?.cellIndices ?? [])).toContain(99);
    expect(Array.from(sampled?.regionIds ?? [])).toContain(2);
  });

  it("keeps an isolated active region when the uniform sample hits only Airbox", () => {
    const realizedRegionIds = new Uint32Array(100);
    realizedRegionIds.fill(FMRM_INACTIVE_REGION_ID);
    realizedRegionIds[99] = 7;

    const sampled = buildFdmCuboidInstanceModel(
      {
        bounds: null,
        displayCellBudget: 4,
        displayCellCount: 4,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [100, 1, 1],
        spacing: [1, 1, 1],
        stride: 25,
        totalCells: 100,
      },
      { cellSelection: "active", realizedRegionIds },
    );

    expect(sampled?.cellIndices).toEqual(new Uint32Array([99]));
    expect(sampled?.regionIds).toEqual(new Uint32Array([7]));
  });

  it("keeps every SP4 active cell when the global stride skips two columns", () => {
    const [nx, ny, nz] = [128, 32, 30] as const;
    const totalCells = nx * ny * nz;
    const realizedRegionIds = new Uint32Array(totalCells);
    realizedRegionIds.fill(FMRM_INACTIVE_REGION_ID);
    const expectedCellIndices: number[] = [];
    for (let y = 10; y <= 21; y += 1) {
      for (let x = 24; x <= 103; x += 1) {
        const cellIndex = x + nx * y + nx * ny * 14;
        realizedRegionIds[cellIndex] = 0;
        expectedCellIndices.push(cellIndex);
      }
    }

    const model = buildFdmCuboidInstanceModel(
      {
        bounds: null,
        displayCellBudget: 120_000,
        displayCellCount: 120_000,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [nx, ny, nz],
        spacing: [1, 1, 1],
        stride: 2,
        totalCells,
      },
      { cellSelection: "active", realizedRegionIds },
    );

    expect(model?.count).toBe(expectedCellIndices.length);
    expect(Array.from(model?.cellIndices ?? [])).toEqual(expectedCellIndices);
  });

  it("renders all cells only from an exact realized mask", () => {
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
    }, {
      cellSelection: "all",
      realizedRegionIds: allActiveMembership(2),
    });

    expect(model?.regionIds).toEqual(allActiveMembership(2));
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
        cellSelection: "active",
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

  it("keeps deterministic minimum membership within each sampled pass", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 2,
      displayCellCount: 2,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [4, 1, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 2,
      totalCells: 4,
    };
    const realizedRegionIds = new Uint32Array([
      FMRM_INACTIVE_REGION_ID,
      7,
      3,
      FMRM_INACTIVE_REGION_ID,
    ]);

    const magnetic = buildFdmCuboidInstanceModel(domain, {
      cellSelection: "active",
      realizedRegionIds,
    });
    const airbox = buildFdmCuboidInstanceModel(domain, {
      cellSelection: "inactive",
      realizedRegionIds,
    });

    expect(magnetic?.cellIndices).toEqual(new Uint32Array([1, 2]));
    expect(airbox?.cellIndices).toEqual(new Uint32Array([0, 3]));
    expect(magnetic?.count ?? 0).toBeLessThanOrEqual(domain.displayCellCount);
    expect(airbox?.count ?? 0).toBeLessThanOrEqual(domain.displayCellCount);
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
      { cellSelection: "all", realizedRegionIds: null },
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
        cellSelection: "active",
        fieldVector: fieldVector(
          [
            1, 0, 0, // field index 0 is cell ordinal 3
            0.1, 0, 0, // field index 1 is cell ordinal 1
          ],
          "explicit_node_indices",
          [3, 1],
        ),
        realizedRegionIds: allActiveMembership(4),
        voxelMagnitudeThreshold: 0.5,
      },
    );

    expect(model?.cellIndices).toEqual(new Uint32Array([3]));
  });
});
