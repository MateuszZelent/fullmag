import { describe, expect, it } from "vitest";

import type { DecodedFieldVector, DecodedTopology } from "@/kernel/api/codecs";

import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  buildPartSurfaceIndices,
  buildTetraSurfaceIndices,
  buildVectorLineSegments,
  buildVectorLineSegmentsForNodeSelection,
  combineViewport3DBounds,
  distributeVectorGlyphBudget,
  resolveNodeSelectionCount,
  resolveTopologyBounds,
  resolveUniverseBounds,
  resolveViewport3DMaxVectorGlyphs,
  viewport3DFieldRenderOptionsNeedFieldData,
} from "./viewport3dRenderModel";

function topologyFixture(): DecodedTopology {
  return {
    boundaryFaceCount: 0,
    boundaryFaces: new Uint32Array([0, 1, 2, 1, 2, 3]),
    boundaryMarkers: new Uint32Array(),
    elementCount: 1,
    elementMarkers: new Uint32Array([1]),
    indices: new Uint32Array([0, 1, 2, 3]),
    nodeCount: 4,
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
  };
}

function fieldVectorFixture(): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [4, 1, 1],
    nComp: 3,
    pointCount: 4,
    quantityId: "m",
    valueCount: 12,
    values: new Float64Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      -1, 0, 0,
    ]),
  };
}

describe("viewport3dRenderModel", () => {
  it("expands tetrahedral element indices into drawable triangle faces", () => {
    expect(Array.from(buildTetraSurfaceIndices(new Uint32Array([0, 1, 2, 3]))))
      .toEqual([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  });

  it("resolves center and radius from decoded topology positions", () => {
    const bounds = resolveTopologyBounds(topologyFixture());

    expect(bounds?.center).toEqual([0.5, 0.5, 0.5]);
    expect(bounds?.size).toEqual([1, 1, 1]);
    expect(bounds?.radius).toBeCloseTo(Math.sqrt(3) / 2);
  });

  it("resolves nanoscale authoring universe bounds from size and center", () => {
    const bounds = resolveUniverseBounds({
      mesh_dirty: false,
      object_bounds_max: null,
      object_bounds_min: null,
      scene_revision: 7,
      study_universe_mesh: null,
      universe: {
        center: [1e-7, 2e-7, 0],
        mode: "box",
        size: [2e-7, 4e-7, 1e-8],
      } as never,
    });

    expect(bounds?.center).toEqual([1e-7, 2e-7, 0]);
    expect(bounds?.size).toEqual([2e-7, 4e-7, 1e-8]);
    expect(bounds?.radius).toBeCloseTo(
      Math.hypot(2e-7, 4e-7, 1e-8) / 2,
    );
  });

  it("falls back to realized object bounds when universe size is absent", () => {
    const bounds = resolveUniverseBounds({
      mesh_dirty: false,
      object_bounds_max: [3e-7, 4e-7, 5e-8],
      object_bounds_min: [-1e-7, -2e-7, -5e-8],
      scene_revision: 8,
      study_universe_mesh: null,
      universe: null,
    });

    expect(bounds?.center).toEqual([1e-7, 1e-7, 0]);
    expect(bounds?.size).toEqual([4e-7, 6e-7, 1e-7]);
  });

  it("combines primitive and domain bounds without assuming meter scale", () => {
    const bounds = combineViewport3DBounds([
      { center: [0, 0, 0], radius: 5e-8, size: [1e-7, 1e-7, 1e-8] },
      { center: [2e-7, 0, 0], radius: 5e-8, size: [1e-7, 1e-7, 1e-8] },
    ]);

    expect(bounds?.center).toEqual([1e-7, 0, 0]);
    expect(bounds?.size).toEqual([3e-7, 1e-7, 1e-8]);
  });

  it("builds sampled normalized vector line segments", () => {
    const segments = buildVectorLineSegments(
      topologyFixture(),
      fieldVectorFixture(),
      0.5,
      2,
    );

    expect(Array.from(segments ?? [])).toEqual([
      0, 0, 0, 0.5, 0, 0, 1,
      0, 1, 0, 0, 1, 0.5, 1,
    ]);
  });

  it("builds part surface indices from manifest surface faces", () => {
    expect(
      Array.from(
        buildPartSurfaceIndices(
          {
            boundary_face_count: 0,
            boundary_face_start: 0,
            surface_faces: [[3, 2, 1]],
          },
          topologyFixture(),
        ) ?? [],
      ),
    ).toEqual([3, 2, 1]);
  });

  it("builds part surface indices from topology boundary faces", () => {
    expect(
      Array.from(
        buildPartSurfaceIndices(
          {
            boundary_face_count: 1,
            boundary_face_indices: [1],
            boundary_face_start: 0,
          },
          topologyFixture(),
        ) ?? [],
      ),
    ).toEqual([1, 2, 3]);
  });

  it("builds vector segments for a selected object node range", () => {
    const segments = buildVectorLineSegmentsForNodeSelection(
      topologyFixture(),
      fieldVectorFixture(),
      { nodeCount: 2, nodeStart: 1 },
      0.5,
      2,
    );

    expect(Array.from(segments ?? [])).toEqual([
      1, 0, 0, 1, 0.5, 0, 1,
      0, 1, 0, 0, 1, 0.5, 1,
    ]);
  });

  it("keeps topology render buffers separate from field render buffers", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
        },
      ],
      [],
    );
    const firstFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
    );
    const positions = topologyModel?.positions;
    const surfaceIndices = topologyModel?.magneticParts[0]?.surfaceIndices;
    const secondFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      {
        ...fieldVectorFixture(),
        values: new Float64Array([
          0, 1, 0,
          1, 0, 0,
          0, 0, 1,
          0, -1, 0,
        ]),
      },
      0.5,
    );

    expect(topologyModel?.positions).toBe(positions);
    expect(topologyModel?.magneticParts[0]?.surfaceIndices).toBe(
      surfaceIndices,
    );
    expect(firstFieldModel?.scalarColors).not.toBe(secondFieldModel?.scalarColors);
    expect(firstFieldModel?.fullVectorSegments).not.toBe(
      secondFieldModel?.fullVectorSegments,
    );
  });

  it("skips hidden field-derived buffers before allocating vector glyph data", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          nodeCount: 2,
          nodeStart: 0,
        },
      ],
      [],
    );

    const fieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorsVisible: false,
      },
    );

    expect(fieldModel?.scalarColors).toBeNull();
    expect(fieldModel?.fullVectorSegments).toBeNull();
    expect(fieldModel?.partVectorSegments.get("part-a")).toBeNull();
  });

  it("reuses scalar color buffers when only per-part vector budgets change", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          nodeCount: 2,
          nodeStart: 0,
        },
      ],
      [],
    );
    const fieldVector = fieldVectorFixture();
    const firstFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVector,
      0.5,
      {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part-a", 2]]),
        scalarColorsVisible: true,
      },
    );
    const secondFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVector,
      0.5,
      {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorsVisible: true,
      },
    );

    expect(secondFieldModel?.scalarColors).toBe(firstFieldModel?.scalarColors);
  });

  it("builds scalar color buffers for every requested target shader mode", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
    );

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        scalarColorModes: new Set([
          "orientation",
          "magnitude",
          "monochrome",
        ]),
      },
    );

    expect(model?.scalarColorsByMode.get("orientation")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.get("magnitude")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.has("monochrome")).toBe(false);
  });

  it("reuses unchanged part vector buffers when another part changes", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          nodeCount: 2,
          nodeStart: 0,
        },
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-b",
          label: "Part B",
          nodeCount: 2,
          nodeStart: 2,
        },
      ],
      [],
    );
    const fieldVector = fieldVectorFixture();
    const firstFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVector,
      0.5,
      {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([
          ["part-a", 2],
          ["part-b", 2],
        ]),
        scalarColorsVisible: false,
      },
    );
    const secondFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVector,
      0.5,
      {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([
          ["part-a", 2],
          ["part-b", 0],
        ]),
        scalarColorsVisible: false,
      },
    );

    expect(secondFieldModel?.partVectorSegments.get("part-a")).toBe(
      firstFieldModel?.partVectorSegments.get("part-a"),
    );
    expect(secondFieldModel?.partVectorSegments.get("part-b")).toBeNull();
  });

  it("detects when field-vector data is not needed by render options", () => {
    expect(
      viewport3DFieldRenderOptionsNeedFieldData({
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorsVisible: false,
      }),
    ).toBe(false);
    expect(
      viewport3DFieldRenderOptionsNeedFieldData({
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorsVisible: true,
      }),
    ).toBe(true);
    expect(
      viewport3DFieldRenderOptionsNeedFieldData({
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part-a", 1]]),
        scalarColorsVisible: false,
      }),
    ).toBe(true);
  });

  it("can restrict per-part vector glyphs to boundary surface nodes", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          nodeCount: 4,
          nodeStart: 0,
        },
      ],
      [],
    );

    const surfaceFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partVectorBudgets: new Map([["part-a", 4]]),
        partVectorScopes: new Map([["part-a", "surface"]]),
      },
    );
    const fullFieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partVectorBudgets: new Map([["part-a", 4]]),
        partVectorScopes: new Map([["part-a", "full"]]),
      },
    );

    expect(surfaceFieldModel?.partVectorSegments.get("part-a")?.length).toBe(
      21,
    );
    expect(fullFieldModel?.partVectorSegments.get("part-a")?.length).toBe(28);
  });

  it("uses an explicit global vector budget instead of per-part fixed budgets", () => {
    const budgets = distributeVectorGlyphBudget(
      [
        { id: "part-a", nodeCount: 90, visible: true },
        { id: "part-b", nodeCount: 10, visible: true },
        { id: "part-hidden", nodeCount: 10_000, visible: false },
      ],
      10,
    );

    expect(budgets.get("part-a")).toBe(9);
    expect(budgets.get("part-b")).toBe(1);
    expect(budgets.has("part-hidden")).toBe(false);
    expect(Array.from(budgets.values()).reduce((sum, value) => sum + value, 0))
      .toBeLessThanOrEqual(10);
  });

  it("resolves vector glyph budgets from canonical visualization state", () => {
    expect(
      resolveViewport3DMaxVectorGlyphs({
        sampling: { max_glyphs: 384 },
      }),
    ).toBe(384);
    expect(
      resolveViewport3DMaxVectorGlyphs({
        layers: { vectors: { density: 256 } },
      }),
    ).toBe(256);
    expect(resolveViewport3DMaxVectorGlyphs({})).toBe(2048);
  });

  it("counts node selections for budget weighting without expanding indices", () => {
    expect(
      resolveNodeSelectionCount(
        { node_indices: [3, 5, 7] },
        { nodeCount: 10 },
      ),
    ).toBe(3);
    expect(
      resolveNodeSelectionCount(
        { node_count: 12 },
        { nodeCount: 10 },
      ),
    ).toBe(10);
  });
});
