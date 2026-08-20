import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { buildFdmSampledScalarColors } from "../viewport3dFieldMapping";

import {
  buildFdmCuboidInstanceModel,
  buildFdmDenseNativeLayerInstanceModel,
  buildFdmMaskedNativeLayerInstanceModel,
  buildViewport3DFdmCuboid,
  buildFdmVectorSegmentsFromAnchors,
  createFdmVectorOnlyBuildInput,
  estimateFdmCuboidBuildOutputBytes,
  resolveFdmCuboidMembershipRevision,
  transferablesForFdmCuboidBuildResult,
} from "./fdmCuboidBuildModel";

const fdmCuboidBuildModelSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts"),
  "utf8",
);

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
  it("derives vectors-only anchors from sampled field ordinals instead of the full grid", () => {
    const input = createFdmVectorOnlyBuildInput({
      cellSelection: "inactive",
      domain: {
        bounds: null,
        displayCellBudget: 8,
        displayCellCount: 8,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [8, 1, 1],
        spacing: [1, 1, 1],
        stride: 1,
        totalCells: 8,
      },
      fieldVector: {
        indexing: "sampled_node_indices",
        nodeIndices: new Uint32Array([1, 7]),
        pointCount: 2,
      },
      maxSamples: 2,
      realizedRegionIds: new Uint32Array([
        0,
        FMRM_INACTIVE_REGION_ID,
        FMRM_INACTIVE_REGION_ID,
        0,
        0,
        0,
        0,
        FMRM_INACTIVE_REGION_ID,
      ]),
    });

    expect(input?.cellIndices).toEqual(new Uint32Array([1, 7]));
    expect(input?.anchors).toEqual(new Float32Array([1.5, 0.5, 0.5, 7.5, 0.5, 0.5]));
  });

  it.each(["active", "inactive"] as const)(
    "fails closed for vectors-only %s selection without exact membership",
    (cellSelection) => {
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

      expect(createFdmVectorOnlyBuildInput({
        cellSelection,
        domain,
        maxSamples: 2,
        realizedRegionIds: null,
      })).toBeNull();
      expect(createFdmVectorOnlyBuildInput({
        cellSelection,
        domain,
        maxSamples: 2,
        realizedRegionIds: new Uint32Array([FMRM_INACTIVE_REGION_ID]),
      })).toBeNull();
    },
  );

  it("builds a bounded sampled vector stream from anchors without a cuboid model", () => {
    const result = buildFdmVectorSegmentsFromAnchors({
      anchorMode: "center",
      anchors: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      cellSize: [2, 1, 1],
      cellIndices: new Uint32Array([0, 1, 2]),
      fieldVector: fieldVector([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      gridShape: [3, 1, 1],
      maxVectors: 2,
      scale: 100,
    });

    expect(result?.cellIndices.length).toBe(2);
    expect(Math.hypot(
      (result?.segments?.[3] ?? 0) - (result?.segments?.[0] ?? 0),
      (result?.segments?.[4] ?? 0) - (result?.segments?.[1] ?? 0),
      (result?.segments?.[5] ?? 0) - (result?.segments?.[2] ?? 0),
    )).toBeCloseTo(1.5 * Math.cbrt(3 / 2));
    expect(result?.segments.length).toBe(2 * 7);
  });

  it("spreads full-grid vector glyphs across distinct 3D bins", () => {
    const gridShape: [number, number, number] = [4, 4, 4];
    const cellIndices = Uint32Array.from({ length: 64 }, (_, index) => index);
    const anchors = new Float32Array(64 * 3);
    for (let cellIndex = 0; cellIndex < cellIndices.length; cellIndex += 1) {
      const x = cellIndex % 4;
      const y = Math.floor(cellIndex / 4) % 4;
      const z = Math.floor(cellIndex / 16);
      const offset = cellIndex * 3;
      anchors[offset] = x;
      anchors[offset + 1] = y;
      anchors[offset + 2] = z;
    }
    const result = buildFdmVectorSegmentsFromAnchors({
      anchorMode: "center",
      anchors,
      cellIndices,
      fieldVector: fieldVector(
        Array.from({ length: 64 * 3 }, (_, component) =>
          component % 3 === 0 ? 1 : 0,
        ),
      ),
      gridShape,
      maxVectors: 8,
      scale: 1,
    });
    const selected = result?.cellIndices;
    expect(selected).not.toBeNull();
    const bins = new Set(
      Array.from(selected ?? [], (cellIndex) => [
        Math.floor((cellIndex % 4) / 2),
        Math.floor((Math.floor(cellIndex / 4) % 4) / 2),
        Math.floor(Math.floor(cellIndex / 16) / 2),
      ].join(":")),
    );
    expect(selected?.length).toBe(8);
    expect(bins.size).toBe(8);
  });

  it("does not scan a copied selected set for every matching cell after the budget is full", () => {
    expect(fdmCuboidBuildModelSource).not.toContain(
      "const inactiveReplacement = [...selected]",
    );
  });

  it("builds a native layer model from only active FMBM cells", () => {
    const domain = {
      bounds: null,
      displayCellBudget: 8,
      displayCellCount: 8,
      kind: "fdm-grid" as const,
      origin: [0, 0, 0] as [number, number, number],
      shape: [4, 2, 1] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      stride: 1,
      totalCells: 8,
    };
    const model = buildFdmMaskedNativeLayerInstanceModel(
      domain,
      new Uint8Array([1, 0, 1, 0, 0, 1, 0, 1]),
    );

    expect(model?.count).toBe(4);
    expect([...model!.cellIndices]).toEqual([0, 2, 5, 7]);
    expect([...model!.regionIds]).toEqual([0, 0, 0, 0]);
  });

  it("fails closed when a native layer mask does not match its grid", () => {
    expect(
      buildFdmMaskedNativeLayerInstanceModel(
        {
          bounds: null,
          displayCellBudget: 8,
          displayCellCount: 8,
          kind: "fdm-grid",
          origin: [0, 0, 0],
          shape: [4, 2, 1],
          spacing: [1, 1, 1],
          stride: 1,
          totalCells: 8,
        },
        new Uint8Array([1, 0]),
      ),
    ).toBeNull();
  });

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

  it("uses the authoritative target mask when filtering sampled Surface anchors", () => {
    const realizedRegionIds = new Uint32Array(27);
    realizedRegionIds.fill(FMRM_INACTIVE_REGION_ID);
    const result = buildViewport3DFdmCuboid({
      cellSelection: "inactive",
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
      maxVectorGlyphs: 3,
      realizedRegionIds,
      vectorAnchorMode: "center",
      vectorField: fieldVector(
        Array.from({ length: 27 }, () => [1, 0, 0]).flat(),
      ),
      vectorGeometryScope: "surface",
      vectorOnly: {
        anchors: new Float32Array([
          0.5, 0.5, 0.5,
          1.5, 1.5, 1.5,
          2.5, 2.5, 2.5,
        ]),
        cellIndices: new Uint32Array([0, 13, 26]),
        gridShape: [3, 3, 3],
      },
      vectorScale: 1,
      voxelFillRatio: 0.92,
      voxelMagnitudeThreshold: 0,
      voxelTopography: {
        amplitudeCells: 0,
        component: "magnitude",
        enabled: false,
      },
    });

    expect(result.vectorCellIndices).toEqual(new Uint32Array([0, 26]));
  });

  it("lifts Surface vector segments along the target normal when enabled", () => {
    const realizedRegionIds = new Uint32Array(27);
    realizedRegionIds.fill(FMRM_INACTIVE_REGION_ID);
    const result = buildFdmVectorSegmentsFromAnchors({
      anchorMode: "center",
      anchors: new Float32Array([0.5, 0.5, 0.5]),
      cellIndices: new Uint32Array([0]),
      fieldVector: fieldVector(
        Array.from({ length: 27 }, () => [1, 0, 0]).flat(),
      ),
      geometryScope: "surface",
      gridShape: [3, 3, 3],
      maxVectors: 1,
      realizedRegionIds,
      scale: 1,
      cellSelection: "inactive",
      surfaceOffsetEnabled: true,
      surfaceOffsetScale: 0.25,
    } as Parameters<typeof buildFdmVectorSegmentsFromAnchors>[0]);

    const normalComponent = 1 / Math.sqrt(3);
    const offsetDistance = 0.5 + 0.25;
    const shiftedAnchor = 0.5 - normalComponent * offsetDistance;
    expect(result?.segments[0]).toBeCloseTo(shiftedAnchor - 0.5);
    expect(result?.segments[1]).toBeCloseTo(shiftedAnchor);
    expect(result?.segments[2]).toBeCloseTo(shiftedAnchor);
    expect(result?.segments[3]).toBeCloseTo(shiftedAnchor + 0.5);
    expect(result?.segments[4]).toBeCloseTo(shiftedAnchor);
    expect(result?.segments[5]).toBeCloseTo(shiftedAnchor);
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
  it("caps built vector segment length at the realized cell scale", () => {
    const result = buildViewport3DFdmCuboid({
      cellSelection: "dense",
      domain: {
        bounds: null,
        displayCellBudget: 1,
        displayCellCount: 1,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [1, 1, 1],
        spacing: [2, 1, 1],
        stride: 1,
        totalCells: 1,
      },
      maxVectorGlyphs: 1,
      realizedRegionIds: null,
      vectorAnchorMode: "center",
      vectorField: fieldVector([1, 0, 0]),
      vectorScale: 100,
      voxelFillRatio: 1,
      voxelMagnitudeThreshold: 0,
      voxelTopography: {
        amplitudeCells: 0,
        component: "magnitude",
        enabled: false,
      },
    });

    const segments = result.vectorSegments;
    expect(segments).not.toBeNull();
    expect(Math.hypot(
      (segments?.[3] ?? 0) - (segments?.[0] ?? 0),
      (segments?.[4] ?? 0) - (segments?.[1] ?? 0),
      (segments?.[5] ?? 0) - (segments?.[2] ?? 0),
    )).toBeCloseTo(1.5);
  });
});
