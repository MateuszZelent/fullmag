import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DecodedFieldVector, DecodedTopology } from "@/kernel/api/codecs";

import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  buildPartSurfaceIndices,
  buildPartVolumeEdgeIndices,
  buildTetraSurfaceIndices,
  buildTetraVolumeEdgeIndices,
  buildVectorLineSegments,
  buildVectorLineSegmentsForNodeSelection,
  combineViewport3DBounds,
  distributeVectorGlyphBudget,
  resolveNodeSelectionCount,
  resolveTopologyBounds,
  resolveUniverseBounds,
  resolveViewport3DMaxVectorGlyphs,
  resolveViewport3DVectorSegmentScale,
  viewport3DFieldRenderOptionsNeedFieldData,
} from "./viewport3dRenderModel";

const viewport3dRenderModelSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/viewport3dRenderModel.ts"),
  "utf8",
);

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

describe("viewport3dRenderModel performance contracts", () => {
  it("caches averaged surface normals used by vector surface offsets", () => {
    expect(viewport3dRenderModelSource).toContain(
      "const surfaceNodeNormalCache = new WeakMap",
    );
    expect(viewport3dRenderModelSource).toContain(
      "function cachedAveragedSurfaceNodeNormals",
    );
    expect(viewport3dRenderModelSource).toContain(
      "surfaceNodeNormalCache.get(topology)",
    );
    expect(viewport3dRenderModelSource).not.toContain(
      "? buildAveragedSurfaceNodeNormals(",
    );
  });
});

describe("viewport3dRenderModel", () => {
  it("expands tetrahedral element indices into drawable triangle faces", () => {
    expect(Array.from(buildTetraSurfaceIndices(new Uint32Array([0, 1, 2, 3]))))
      .toEqual([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  });

  it("deduplicates tetrahedral volume edges into line segments", () => {
    expect(
      Array.from(
        buildTetraVolumeEdgeIndices(
          new Uint32Array([
            0, 1, 2, 3,
            0, 1, 2, 4,
          ]),
        ),
      ),
    ).toEqual([
      0, 1,
      0, 2,
      0, 3,
      1, 2,
      1, 3,
      2, 3,
      0, 4,
      1, 4,
      2, 4,
    ]);
  });

  it("deduplicates large tetrahedral volume edge ids without numeric pairing collisions", () => {
    const largeNodeId = 94_906_266;

    expect(
      Array.from(
        buildTetraVolumeEdgeIndices(
          new Uint32Array([0, largeNodeId, 1, 2]),
        ),
      ),
    ).toEqual([
      0, largeNodeId,
      0, 1,
      0, 2,
      1, largeNodeId,
      2, largeNodeId,
      1, 2,
    ]);
  });

  it("deduplicates tetrahedral volume edges without string churn on safe node ranges", () => {
    expect(viewport3dRenderModelSource).toContain(
      "function resolveNumericEdgeKeyBase",
    );
    expect(viewport3dRenderModelSource).toContain(
      "appendTetraEdgeByNumericKey",
    );
    expect(viewport3dRenderModelSource).toContain(
      "appendTetraEdgeByStringKey",
    );
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

  it("reuses converted topology positions for repeated model builds", () => {
    const topology = topologyFixture();

    const first = buildViewport3DTopologyRenderModel(topology, [], []);
    const second = buildViewport3DTopologyRenderModel(topology, [], []);

    expect(first?.positions).toBe(second?.positions);
  });

  it("reuses fallback topology index buffers for repeated model builds", () => {
    const topology = topologyFixture();

    const first = buildViewport3DTopologyRenderModel(topology, [], []);
    const second = buildViewport3DTopologyRenderModel(topology, [], []);

    expect(first?.fallbackSurfaceIndices).toBe(second?.fallbackSurfaceIndices);
    expect(first?.fallbackVolumeEdgeIndices).toBe(
      second?.fallbackVolumeEdgeIndices,
    );
  });

  it("does not require global tetra indices when building a surface-only part model", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 1,
      elementMarkers: new Uint32Array(),
      get indices(): Uint32Array {
        throw new Error("global tetra indices should not be read eagerly");
      },
      nodeCount: 3,
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    };
    const part = {
      boundary_face_count: 1,
      boundary_face_start: 0,
      id: "surface-part",
      surface_faces: [[0, 1, 2]],
    };

    const model = buildViewport3DTopologyRenderModel(
      topology as never,
      [part],
      [],
    );

    expect(model?.nodeCount).toBe(3);
    expect(model?.magneticParts[0]?.surfaceIndices).toEqual(
      new Uint32Array([0, 1, 2]),
    );
  });

  it("reuses per-part topology index buffers for repeated model builds", () => {
    const topology = {
      ...topologyFixture(),
      boundaryFaceCount: 2,
      boundaryFaces: new Uint32Array([
        0, 1, 2,
        0, 2, 3,
      ]),
      elementCount: 2,
      indices: new Uint32Array([
        0, 1, 2, 3,
        0, 1, 2, 4,
      ]),
      nodeCount: 5,
    };
    const part = {
      boundary_face_count: 1,
      boundary_face_indices: [1],
      boundary_face_start: 0,
      element_count: 1,
      element_start: 1,
      id: "part-a",
    };

    const first = buildViewport3DTopologyRenderModel(topology, [part], []);
    const second = buildViewport3DTopologyRenderModel(topology, [part], []);

    const firstPart = first?.magneticParts[0];
    const secondPart = second?.magneticParts[0];
    expect(firstPart?.surfaceIndices).toBe(secondPart?.surfaceIndices);
    expect(firstPart?.edgeIndices).toBe(secondPart?.edgeIndices);
    expect(firstPart?.volumeEdgeIndices).toBe(secondPart?.volumeEdgeIndices);
  });

  it("builds sampled normalized vector line segments", () => {
    const segments = buildVectorLineSegments(
      topologyFixture(),
      fieldVectorFixture(),
      0.5,
      2,
    );

    expect(Array.from(segments ?? [])).toEqual([
      -0.25, 0, 0, 0.25, 0, 0, 1,
      0, 1, -0.25, 0, 1, 0.25, 1,
    ]);
  });

  it("can anchor vector line segments by their tail for comparison with centered arrows", () => {
    const segments = buildVectorLineSegments(
      topologyFixture(),
      fieldVectorFixture(),
      0.5,
      2,
      { anchorMode: "tail" },
    );

    expect(Array.from(segments ?? [])).toEqual([
      0, 0, 0, 0.5, 0, 0, 1,
      0, 1, 0, 0, 1, 0.5, 1,
    ]);
  });

  it("can lift selected surface vector anchors along averaged boundary normals", () => {
    const segments = buildVectorLineSegmentsForNodeSelection(
      topologyFixture(),
      fieldVectorFixture(),
      { nodeIndices: [0] },
      0.5,
      1,
      { surfaceOffsetScale: 0.1 },
    );

    expect(Array.from(segments ?? [])).toEqual([
      -0.25, 0, expect.closeTo(0.05), 0.25, 0, expect.closeTo(0.05), 1,
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

  it("triangulates non-triangle manifest surface faces", () => {
    expect(
      Array.from(
        buildPartSurfaceIndices(
          {
            boundary_face_count: 0,
            boundary_face_start: 0,
            surface_faces: [[0, 1, 2, 3], [4, 5, 6, 7, 8]],
          },
          topologyFixture(),
        ) ?? [],
      ),
    ).toEqual([
      0, 1, 2,
      0, 2, 3,
      4, 5, 6,
      4, 6, 7,
      4, 7, 8,
    ]);
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

  it("builds part volume edges from the part element range", () => {
    expect(
      Array.from(
        buildPartVolumeEdgeIndices(
          {
            boundary_face_count: 0,
            boundary_face_start: 0,
            element_count: 1,
            element_start: 1,
          },
          {
            ...topologyFixture(),
            elementCount: 2,
            indices: new Uint32Array([
              0, 1, 2, 3,
              0, 1, 2, 4,
            ]),
            nodeCount: 5,
          },
        ) ?? [],
      ),
    ).toEqual([
      0, 1,
      0, 2,
      0, 4,
      1, 2,
      1, 4,
      2, 4,
    ]);
  });

  it("derives part volume edges from explicit node indices when element range is missing", () => {
    expect(
      Array.from(
        buildPartVolumeEdgeIndices(
          {
            boundary_face_count: 0,
            boundary_face_start: 0,
            element_count: 0,
            element_start: 0,
            node_indices: [0, 1, 2, 4],
          },
          {
            ...topologyFixture(),
            elementCount: 2,
            indices: new Uint32Array([
              0, 1, 2, 3,
              0, 1, 2, 4,
            ]),
            nodeCount: 5,
          },
        ) ?? [],
      ),
    ).toEqual([
      0, 1,
      0, 2,
      0, 4,
      1, 2,
      1, 4,
      2, 4,
    ]);
  });

  it("derives part volume edges from contiguous node ranges when element range is missing", () => {
    expect(
      Array.from(
        buildPartVolumeEdgeIndices(
          {
            boundary_face_count: 0,
            boundary_face_start: 0,
            element_count: 0,
            element_start: 0,
            node_count: 4,
            node_start: 1,
          },
          {
            ...topologyFixture(),
            elementCount: 2,
            indices: new Uint32Array([
              0, 1, 2, 3,
              1, 2, 3, 4,
            ]),
            nodeCount: 5,
          },
        ) ?? [],
      ),
    ).toEqual([
      1, 2,
      1, 3,
      1, 4,
      2, 3,
      2, 4,
      3, 4,
    ]);
  });

  it("infers a part node range from node_start when node_count is absent", () => {
    expect(
      Array.from(
        buildPartVolumeEdgeIndices(
          {
            boundary_face_count: 0,
            boundary_face_start: 0,
            element_count: 0,
            element_start: 0,
            node_start: 1,
          },
          {
            ...topologyFixture(),
            elementCount: 2,
            indices: new Uint32Array([
              0, 1, 2, 3,
              1, 2, 3, 4,
            ]),
            nodeCount: 5,
          },
        ) ?? [],
      ),
    ).toEqual([
      1, 2,
      1, 3,
      1, 4,
      2, 3,
      2, 4,
      3, 4,
    ]);
  });

  it("infers a part node range from positive node_start when node_count is zero", () => {
    expect(
      Array.from(
        buildPartVolumeEdgeIndices(
          {
            boundary_face_count: 0,
            boundary_face_start: 0,
            element_count: 0,
            element_start: 0,
            node_count: 0,
            node_start: 1,
          },
          {
            ...topologyFixture(),
            elementCount: 2,
            indices: new Uint32Array([
              0, 1, 2, 3,
              1, 2, 3, 4,
            ]),
            nodeCount: 5,
          },
        ) ?? [],
      ),
    ).toEqual([
      1, 2,
      1, 3,
      1, 4,
      2, 3,
      2, 4,
      3, 4,
    ]);
  });

  it("uses unclaimed tetrahedra for full airbox wireframe when the airbox range is missing", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        ...topologyFixture(),
        elementCount: 2,
        indices: new Uint32Array([
          0, 1, 2, 3,
          4, 5, 6, 7,
        ]),
        nodeCount: 8,
        positions: new Float64Array(8 * 3),
      },
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          id: "part:body",
        },
      ],
      [
        {
          boundary_face_count: 1,
          boundary_face_indices: [0],
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part:air",
          node_indices: [4, 5, 6],
        },
      ],
    );

    expect(
      Array.from(topologyModel?.airboxParts[0]?.volumeEdgeIndices ?? []),
    ).toEqual([
      4, 5,
      4, 6,
      4, 7,
      5, 6,
      5, 7,
      6, 7,
    ]);
  });

  it("falls back to shared-domain volume edges for full airbox when part ownership is unavailable", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        ...topologyFixture(),
        elementCount: 2,
        indices: new Uint32Array([
          0, 1, 2, 3,
          4, 5, 6, 7,
        ]),
        nodeCount: 8,
        positions: new Float64Array(8 * 3),
      },
      [
        {
          boundary_face_count: 1,
          boundary_face_indices: [0],
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part:body",
          node_count: 0,
          node_start: 0,
        },
      ],
      [
        {
          boundary_face_count: 1,
          boundary_face_indices: [1],
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part:air",
          node_count: 0,
          node_start: 0,
        },
      ],
    );

    expect(
      Array.from(topologyModel?.airboxParts[0]?.volumeEdgeIndices ?? []),
    ).toEqual([
      0, 1,
      0, 2,
      0, 3,
      1, 2,
      1, 3,
      2, 3,
      4, 5,
      4, 6,
      4, 7,
      5, 6,
      5, 7,
      6, 7,
    ]);
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
      1, -0.25, 0, 1, 0.25, 0, 1,
      0, 1, -0.25, 0, 1, 0.25, 1,
    ]);
  });

  it("caps selected vector glyph scale by local sampled node spacing", () => {
    const positions = new Float64Array(1000 * 3);
    for (let index = 0; index < 1000; index += 1) {
      const target = index * 3;
      positions[target] = (index % 10) / 9;
      positions[target + 1] = (Math.floor(index / 10) % 10) / 9;
      positions[target + 2] = Math.floor(index / 100) / 9;
    }

    const scale = resolveViewport3DVectorSegmentScale(
      { nodeCount: 1000, positions },
      10,
      { nodeCount: 1000, nodeStart: 0 },
    );

    expect(scale).toBeCloseTo(0.09);
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

  it("builds scalar color buffers for every requested target shader mode from any active quantity", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
    );

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      {
        ...fieldVectorFixture(),
        quantityId: "h_demag",
      },
      0.5,
      {
        scalarColorModes: new Set([
          "orientation",
          "x",
          "y",
          "z",
          "magnitude",
          "monochrome",
        ]),
      },
    );

    expect(model?.scalarColorsByMode.get("orientation")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.get("x")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.get("y")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.get("z")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.get("magnitude")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.has("monochrome")).toBe(false);
  });

  it("rejects full-domain field buffers that do not match the active topology node count", () => {
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
    const mismatchedFieldVector: DecodedFieldVector = {
      ...fieldVectorFixture(),
      pointCount: 3,
      valueCount: 9,
      values: new Float64Array([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]),
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      mismatchedFieldVector,
      0.5,
      {
        partVectorBudgets: new Map([["part-a", 2]]),
        scalarColorModes: new Set(["magnitude"]),
        scalarColorsVisible: true,
      },
    );

    expect(model?.scalarColors).toBeNull();
    expect(model?.scalarColorsByMode.get("magnitude")).toBeNull();
    expect(model?.fullVectorSegments).toBeNull();
    expect(model?.partVectorSegments.get("part-a")).toBeNull();
  });

  it("maps magnetic-only FEM fields onto magnetic mesh nodes when the topology includes airbox nodes", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        boundaryFaceCount: 2,
        boundaryFaces: new Uint32Array([
          2, 4, 6,
          0, 1, 3,
        ]),
        boundaryMarkers: new Uint32Array([1, 0]),
        elementCount: 2,
        elementMarkers: new Uint32Array([1, 0]),
        indices: new Uint32Array([
          2, 4, 6, 7,
          0, 1, 3, 5,
        ]),
        nodeCount: 8,
        positions: new Float64Array([
          0, 0, 0,
          1, 0, 0,
          10, 0, 0,
          0, 1, 0,
          11, 0, 0,
          0, 0, 1,
          10, 1, 0,
          10, 0, 1,
        ]),
      },
      [
        {
          boundary_face_count: 1,
          boundary_face_indices: [0],
          boundary_face_start: 0,
          id: "magnetic-part",
          label: "Magnetic Part",
          node_indices: [2, 4, 6, 7],
        },
      ],
      [
        {
          boundary_face_count: 1,
          boundary_face_indices: [1],
          boundary_face_start: 0,
          id: "airbox",
          label: "Airbox",
          node_indices: [0, 1, 3, 5],
        },
      ],
    );
    const magneticOnlyField: DecodedFieldVector = {
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

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      magneticOnlyField,
      0.5,
      {
        partVectorBudgets: new Map([["magnetic-part", 4]]),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
    );

    const colors = model?.scalarColorsByMode.get("x")?.colors;
    expect(colors?.length).toBe(24);
    expect(Array.from(colors!.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(colors!.slice(6, 9))).not.toEqual([0, 0, 0]);
    expect(model?.partVectorSegments.get("magnetic-part")?.length).toBe(28);
    expect(model?.partVectorSegments.get("airbox")).toBeNull();
  });

  it("builds per-part scalar colors from target-specific quantity vectors", () => {
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
    const targetQuantityVector = {
      ...fieldVectorFixture(),
      quantityId: "h_eff",
      values: new Float64Array([
        2, 0, 0,
        0, 2, 0,
        0, 0, 2,
        2, 2, 0,
      ]),
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      {
        ...fieldVectorFixture(),
        quantityId: "m",
      },
      0.5,
      {
        partFieldVectors: new Map([["part-a", targetQuantityVector]]),
        scalarColorModes: new Set(["magnitude"]),
        scalarColorsVisible: true,
      },
    );

    expect(
      model?.scalarColorsByPartAndMode.get("part-a")?.get("magnitude")?.colors
        .length,
    ).toBe(12);
  });

  it("maps scoped per-part scalar colors onto global topology node indices", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        ...topologyFixture(),
        indices: new Uint32Array([
          0, 1, 2, 3,
          1, 2, 3, 4,
        ]),
        nodeCount: 5,
        positions: new Float64Array([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
          1, 1, 0,
        ]),
      },
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          node_indices: [2, 4],
        },
      ],
      [],
    );
    const scopedTargetVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [2, 1, 1],
      nComp: 3,
      pointCount: 2,
      quantityId: "h_eff",
      valueCount: 6,
      values: new Float64Array([
        -1, 0, 0,
        1, 0, 0,
      ]),
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      {
        ...fieldVectorFixture(),
        pointCount: 5,
        valueCount: 15,
        values: new Float64Array(15),
      },
      0.5,
      {
        partFieldVectors: new Map([["part-a", scopedTargetVector]]),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
    );

    const colors =
      model?.scalarColorsByPartAndMode.get("part-a")?.get("x")?.colors;
    expect(colors).toBeDefined();
    expect(Array.from(colors!.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(colors![6]).toBe(0);
    expect(colors![7]).toBeCloseTo(0.38);
    expect(colors![8]).toBe(1);
    expect(Array.from(colors!.slice(9, 12))).toEqual([0, 0, 0]);
    expect(colors![12]).toBe(1);
    expect(colors![13]).toBeCloseTo(0.38);
    expect(colors![14]).toBe(0);
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

  it("builds airbox vector glyphs from full-domain field data", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "airbox",
          label: "Airbox",
          nodeCount: 4,
          nodeStart: 0,
          role: "air",
        },
      ],
    );

    const fieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partVectorBudgets: new Map([["airbox", 4]]),
        scalarColorsVisible: false,
      },
    );

    expect(fieldModel?.partVectorSegments.get("airbox")?.length).toBe(28);
  });

  it("builds airbox vector glyphs from scoped field data at global topology positions", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array([4, 5, 6, 5, 6, 7]),
        boundaryMarkers: new Uint32Array(),
        elementCount: 2,
        elementMarkers: new Uint32Array([1, 0]),
        indices: new Uint32Array([
          0, 1, 2, 3,
          4, 5, 6, 7,
        ]),
        nodeCount: 8,
        positions: new Float64Array([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
          10, 0, 0,
          11, 0, 0,
          10, 1, 0,
          10, 0, 1,
        ]),
      },
      [],
      [
        {
          boundary_face_count: 2,
          boundary_face_start: 0,
          id: "airbox",
          label: "Airbox",
          nodeCount: 4,
          nodeStart: 4,
          role: "air",
        },
      ],
    );

    const fieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      {
        ...fieldVectorFixture(),
        pointCount: 4,
        values: new Float64Array(12),
      },
      0.5,
      {
        partFieldVectors: new Map([
          [
            "airbox",
            {
              dtype: "float64",
              grid: [4, 1, 1],
              nComp: 3,
              pointCount: 4,
              quantityId: "H_demag",
              valueCount: 12,
              values: new Float64Array([
                1, 0, 0,
                0, 1, 0,
                0, 0, 1,
                -1, 0, 0,
              ]),
            },
          ],
        ]),
        partVectorBudgets: new Map([["airbox", 4]]),
        scalarColorsVisible: false,
      },
    );

    const segments = fieldModel?.partVectorSegments.get("airbox");
    expect(segments?.length).toBe(28);
    expect(segments?.[0]).toBeCloseTo(9.75);
    expect(segments?.[3]).toBeCloseTo(10.25);
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
    expect(resolveViewport3DMaxVectorGlyphs({}, 700)).toBe(700);
    expect(
      resolveViewport3DMaxVectorGlyphs(
        {
          sampling: { max_glyphs: 384 },
        },
        700,
      ),
    ).toBe(384);
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
    expect(
      resolveNodeSelectionCount(
        { node_count: 12, node_start: 4 },
        { nodeCount: 10 },
      ),
    ).toBe(6);
    expect(
      resolveNodeSelectionCount(
        { node_start: 4 },
        { nodeCount: 10 },
      ),
    ).toBe(6);
  });
});
