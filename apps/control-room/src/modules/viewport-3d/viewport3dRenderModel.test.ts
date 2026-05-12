import { describe, expect, it } from "vitest";

import type { DecodedFieldVector, DecodedTopology } from "@/kernel/api/codecs";

import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  buildPartSurfaceIndices,
  buildTetraSurfaceIndices,
  buildVectorLineSegments,
  buildVectorLineSegmentsForNodeSelection,
  distributeVectorGlyphBudget,
  resolveNodeSelectionCount,
  resolveTopologyBounds,
  resolveViewport3DMaxVectorGlyphs,
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

  it("builds sampled normalized vector line segments", () => {
    const segments = buildVectorLineSegments(
      topologyFixture(),
      fieldVectorFixture(),
      0.5,
      2,
    );

    expect(Array.from(segments ?? [])).toEqual([
      0, 0, 0, 0.5, 0, 0,
      0, 1, 0, 0, 1, 0.5,
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
      1, 0, 0, 1, 0.5, 0,
      0, 1, 0, 0, 1, 0.5,
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
