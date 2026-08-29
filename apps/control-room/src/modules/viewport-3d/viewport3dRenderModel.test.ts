import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DecodedFieldVector, DecodedTopology } from "@/kernel/api/codecs";
import {
  canonicalFieldVectorQuery,
  serializeCanonicalFieldVectorResourceKey,
} from "@/kernel/api/fieldQueryIdentity";

import {
  buildViewport3DTargetRenderPlan,
  type Viewport3DTargetRenderPlan,
} from "./model/viewport3DFieldDataPlan";
import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES,
  buildPartSurfaceIndices,
  buildPartVolumeEdgeIndices,
  buildTetraSurfaceIndices,
  buildTetraVolumeEdgeIndices,
  buildVectorLineSegments,
  buildVectorLineSegmentsForNodeSelection,
  combineViewport3DBounds,
  distributeVectorGlyphBudget,
  evictViewport3DRenderCacheEntriesForTests,
  getViewport3DRenderCacheStats,
  resolveNodeSelectionCount,
  resolveTopologyBounds,
  resolveUniverseBounds,
  resolveViewport3DMaxVectorGlyphs,
  resolveViewport3DVectorSegmentScale,
  viewport3DFieldRenderOptionsNeedFieldData,
} from "./viewport3dRenderModel";
import {
  buildViewport3DTargetFieldBuffer as buildViewport3DTargetFieldBufferWithResourceKey,
} from "./model/viewport3DTargetFieldBuffer";
import { buildViewport3DTopologyIndexBundle } from "./viewport3dTopologyIndexModel";
import { magnitudeColorRgb } from "./viewport3dVectorColoring";

type TargetFieldBufferOptions = Parameters<
  typeof buildViewport3DTargetFieldBufferWithResourceKey
>[0];

function buildViewport3DTargetFieldBuffer(
  options: Omit<TargetFieldBufferOptions, "resourceKey">,
) {
  return buildViewport3DTargetFieldBufferWithResourceKey({
    ...options,
    sessionIdentity:
      "sessionIdentity" in options
        ? options.sessionIdentity
        : { sessionEpoch: "test-session@1000", sessionId: "test-session" },
    resourceKey: serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery(options.fieldVector.quantityId, options.query),
    ),
  });
}

const viewport3dRenderModelSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/viewport3dRenderModel.ts"),
  "utf8",
);
const viewport3dTopologyIndexModelSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/viewport3dTopologyIndexModel.ts"),
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

function inwardSurfaceNormalFieldVectorFixture(): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [4, 1, 1],
    nComp: 3,
    pointCount: 4,
    quantityId: "m",
    valueCount: 12,
    values: new Float64Array([
      0, 0, -1,
      0, 0, -1,
      0, 0, -1,
      0, 0, -1,
    ]),
  };
}

function targetRenderPlanFixture(
  overrides: Partial<{
    quantityId: string;
    shaderVisible: boolean;
    surfaceColorSource:
      | "component_x"
      | "component_y"
      | "component_z"
      | "magnitude"
      | "orientation"
      | "solid";
    surfaceProjectionMode: "raw_nodal" | "surface_faces" | "thickness_average_z";
    targetId: string;
    vectorBudget: number;
    vectorsVisible: boolean;
    visible: boolean;
  }> = {},
): Viewport3DTargetRenderPlan {
  return buildViewport3DTargetRenderPlan({
    label: overrides.targetId ?? "part-a",
    quantityId: overrides.quantityId ?? "m",
    settings: {
      geometryScope: "full",
      scalarColorPalette: "plasma",
      shaderMonoColor: "#ffffff",
      shaderVisible: overrides.shaderVisible ?? true,
      surfaceColorSource: overrides.surfaceColorSource ?? "component_x",
      surfaceProjectionMode: overrides.surfaceProjectionMode ?? "raw_nodal",
      vectorBudget: overrides.vectorBudget ?? 4,
      vectorCenteringEnabled: true,
      vectorColorMode: "magnitude",
      vectorLengthScale: 1,
      vectorSurfaceOffsetEnabled: false,
      vectorSurfaceOffsetScale: 0,
      vectorsVisible: overrides.vectorsVisible ?? true,
      viewportColorbarVisible: false,
      visible: overrides.visible ?? true,
    },
    targetId: overrides.targetId ?? "part-a",
    targetKind: "part",
  });
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

  it("measures lazy topology index builds where first access can block the viewport", () => {
    expect(viewport3dRenderModelSource).toContain(
      "fullmag.viewport3d.buildTopologySurfaceIndices",
    );
    expect(viewport3dRenderModelSource).toContain(
      "fullmag.viewport3d.buildTopologyVolumeEdgeIndices",
    );
    expect(viewport3dRenderModelSource).toContain(
      "fullmag.viewport3d.buildPartSurfaceIndices",
    );
    expect(viewport3dRenderModelSource).toContain(
      "fullmag.viewport3d.buildPartVolumeEdgeIndices",
    );
    expect(viewport3dRenderModelSource).toContain(
      "fullmag.viewport3d.buildPartSurfaceEdgeIndices",
    );
  });
});

describe("viewport3dRenderModel", () => {
  it("carries mesh identity metadata through the topology render model", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
      undefined,
      {
        meshGenerationId: "gen-7",
        meshRevision: 42,
        meshTopologyHash: "hash-7",
      },
    );

    expect(topologyModel).toMatchObject({
      meshGenerationId: "gen-7",
      meshRevision: 42,
      meshTopologyHash: "hash-7",
    });
  });

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
    expect(viewport3dTopologyIndexModelSource).toContain(
      "function resolveNumericEdgeKeyBase",
    );
    expect(viewport3dTopologyIndexModelSource).toContain(
      "appendTetraEdgeByNumericKey",
    );
    expect(viewport3dTopologyIndexModelSource).toContain(
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

  it("does not clone topology positions that are already Float32Array", () => {
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    const topology = {
      ...topologyFixture(),
      positions: positions as unknown as Float64Array,
    };

    const model = buildViewport3DTopologyRenderModel(topology, [], []);

    expect(model?.positions).toBe(positions);
  });

  it("reuses fallback topology index buffers for repeated model builds", () => {
    const topology = topologyFixture();

    const first = buildViewport3DTopologyRenderModel(topology, [], []);
    const second = buildViewport3DTopologyRenderModel(topology, [], []);

    expect(first?.fallbackSurfaceEdgeIndices).toBe(
      second?.fallbackSurfaceEdgeIndices,
    );
    expect(first?.fallbackSurfaceIndices).toBe(second?.fallbackSurfaceIndices);
    expect(first?.fallbackSurfaceNodeIndices).toBe(
      second?.fallbackSurfaceNodeIndices,
    );
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
    expect(firstPart?.surfaceNodeIndices).toBe(secondPart?.surfaceNodeIndices);
    expect(firstPart?.volumeEdgeIndices).toBe(secondPart?.volumeEdgeIndices);
  });

  it("does not synchronously derive topology indices while worker build is pending", () => {
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
      undefined,
      {},
      { topologyIndexState: "pending" },
    );

    expect(topologyModel?.fallbackSurfaceIndices).toBe(
      EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES,
    );
    expect(topologyModel?.fallbackSurfaceEdgeIndices).toBeNull();
    expect(topologyModel?.fallbackSurfaceNodeIndices).toBe(
      EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES,
    );
    expect(topologyModel?.fallbackVolumeEdgeIndices).toBe(
      EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES,
    );
    expect(topologyModel?.magneticParts[0]?.surfaceIndices).toBeNull();
    expect(topologyModel?.magneticParts[0]?.edgeIndices).toBeNull();
    expect(topologyModel?.magneticParts[0]?.surfaceNodeIndices).toBeNull();
    expect(topologyModel?.magneticParts[0]?.volumeEdgeIndices).toBeNull();
  });

  it("propagates aligned surface cell identity buffers into part render models", () => {
    const part = {
      boundary_face_count: 1,
      boundary_face_start: 0,
      id: "part-a",
      label: "Part A",
    };
    const surfaceTriangleCellTypes = new Uint32Array([2]);
    const surfaceTriangleGlobalCellOrdinals = new BigUint64Array([
      BigInt("9007199254740993"),
    ]);
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [part],
      [],
      undefined,
      {},
      {
        topologyIndexBundle: {
          airboxPartsById: new Map(),
          fallbackSurfaceEdgeIndices: null,
          fallbackSurfaceIndices: new Uint32Array(),
          fallbackSurfaceNodeIndices: new Uint32Array(),
          fallbackVolumeEdgeIndices: new Uint32Array(),
          magneticPartsById: new Map([[part.id, {
            edgeIndices: null,
            surfaceIndices: new Uint32Array([0, 1, 2]),
            surfaceNodeIndices: new Uint32Array([0, 1, 2]),
            surfaceNodeSelection: { nodeIndices: [0, 1, 2] },
            surfaceTriangleCellTypes,
            surfaceTriangleFacetIndices: new Uint32Array([0]),
            surfaceTriangleGlobalCellOrdinals,
            volumeEdgeIndices: null,
          }]]),
        },
        topologyIndexState: "ready",
      },
    );

    expect(topologyModel?.magneticParts[0]?.surfaceTriangleCellTypes).toBe(
      surfaceTriangleCellTypes,
    );
    expect(
      topologyModel?.magneticParts[0]?.surfaceTriangleGlobalCellOrdinals,
    ).toBe(surfaceTriangleGlobalCellOrdinals);
  });

  it("uses canonical surface membership while topology indices are pending", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part:__air__",
          node_indices: [0, 1, 2, 3],
          role: "air",
          surface_node_indices: [0, 1, 2],
        },
      ],
      undefined,
      {},
      { topologyIndexState: "pending" },
    );

    expect(
      topologyModel?.airboxParts[0]?.surfaceNodeSelection?.nodeIndices,
    ).toEqual([0, 1, 2]);
    expect(topologyModel?.airboxParts[0]?.surfaceNodeIndices).toEqual(
      new Uint32Array([0, 1, 2]),
    );
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

  it("compacts zero-magnitude samples out of the logical glyph buffer", () => {
    const field = fieldVectorFixture();
    field.values = new Float64Array([
      1, 0, 0,
      0, 0, 0,
      0, 0, 1,
      0, 0, 0,
    ]);
    const segments = buildVectorLineSegmentsForNodeSelection(
      topologyFixture(),
      field,
      { nodeIndices: [0, 1, 2, 3] },
      0.5,
      4,
    );

    expect(segments?.length).toBe(14);
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
      { surfaceOffsetEnabled: true, surfaceOffsetScale: 0.1 },
    );

    expect(Array.from(segments ?? [])).toEqual([
      -0.25, 0, expect.closeTo(0.3), 0.25, 0, expect.closeTo(0.3), 1,
    ]);
  });

  it("keeps centered surface-normal arrows above the surface with zero extra gap", () => {
    const segments = buildVectorLineSegmentsForNodeSelection(
      topologyFixture(),
      inwardSurfaceNormalFieldVectorFixture(),
      { nodeIndices: [0] },
      0.5,
      1,
      { surfaceOffsetEnabled: true, surfaceOffsetScale: 0 },
    );

    expect(Array.from(segments ?? [])).toEqual([
      0, 0, expect.closeTo(0.5), 0, 0, expect.closeTo(0), 1,
    ]);
  });

  it("keeps tail-anchored inward surface-normal arrows above the surface", () => {
    const segments = buildVectorLineSegmentsForNodeSelection(
      topologyFixture(),
      inwardSurfaceNormalFieldVectorFixture(),
      { nodeIndices: [0] },
      0.5,
      1,
      {
        anchorMode: "tail",
        surfaceOffsetEnabled: true,
        surfaceOffsetScale: 0,
      },
    );

    expect(Array.from(segments ?? [])).toEqual([
      0, 0, expect.closeTo(0.5), 0, 0, expect.closeTo(0), 1,
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

  it("merges air-magnetic interface faces into the owning magnetic part surface", () => {
    const topology = topologyFixture();
    const magneticPart = {
      boundary_face_count: 1,
      boundary_face_start: 0,
      id: "part-magnet",
    };
    const interfacePart = {
      boundary_face_count: 1,
      boundary_face_indices: [1],
      boundary_face_start: 1,
      id: "part-interface",
      surface_faces: [[3, 2, 1]],
    };
    const topologyModel = buildViewport3DTopologyRenderModel(
      topology,
      [magneticPart],
      [],
      new Map([["part-magnet", [interfacePart]]]),
    );

    expect(Array.from(topologyModel?.magneticParts[0]?.surfaceIndices ?? []))
      .toEqual([
        0, 1, 2,
        3, 2, 1,
      ]);
    expect(Array.from(topologyModel?.magneticParts[0]?.edgeIndices ?? []))
      .toEqual([
        0, 1,
        1, 2,
        0, 2,
        2, 3,
        1, 3,
      ]);
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

  it("builds semantic vector glyph job metadata from topology and field revisions", () => {
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
        buildDomainId: "shared-domain",
        buildSessionId: "current",
        fieldRevision: "field-41",
        fullVectorBudget: 4,
        partVectorBudgets: new Map([["part-a", 2]]),
        targetVisualizationRevision: "viz-9",
        topologyRevision: "mesh-7",
        vectorColorMode: "x",
      },
    );

    expect(fieldModel?.fullVectorBuild?.buildKey).toContain("vector-glyph");
    expect(fieldModel?.fullVectorBuild?.buildKey).toContain("field-41");
    expect(fieldModel?.fullVectorBuild?.buildKey).toContain("mesh-7");
    expect(fieldModel?.fullVectorBuild?.groupKey).toBe(
      "vector-glyph:current:shared-domain:m:full:full",
    );
    expect(fieldModel?.fullVectorBuild).toMatchObject({
      fieldRevision: "field-41",
      targetRevision: "field=field-41",
      topologyRevision: "mesh-7",
    });
    expect(fieldModel?.partVectorBuilds.get("part-a")?.buildKey).toContain(
      "part-a",
    );
    expect(fieldModel?.partVectorBuilds.get("part-a")?.groupKey).toBe(
      "vector-glyph:current:shared-domain:m:full:part-a",
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

  it("keeps recently used scalar color cache entries when applying the per-owner cap", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
    );
    const fieldVector = fieldVectorFixture();
    const buildXColors = (palette: string) =>
      buildViewport3DFieldRenderModel(
        topologyModel,
        fieldVector,
        0.5,
        {
          scalarColorModes: new Set(["x"]),
          scalarColorPalette: palette,
          vectorColorMode: "x",
        },
      )?.scalarColorsByMode.get("x") ?? null;

    const palette0First = buildXColors("palette-0");
    const palette1First = buildXColors("palette-1");
    for (let index = 2; index < 8; index += 1) {
      buildXColors(`palette-${index}`);
    }

    expect(buildXColors("palette-0")).toBe(palette0First);
    buildXColors("palette-8");

    expect(buildXColors("palette-0")).toBe(palette0First);
    expect(buildXColors("palette-1")).not.toBe(palette1First);
  });

  it("keys scalar color cache entries by scalar range", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
    );
    const fieldVector = fieldVectorFixture();
    const buildXColors = (range: { max: number; min: number }) =>
      buildViewport3DFieldRenderModel(
        topologyModel,
        fieldVector,
        0.5,
        {
          scalarColorModes: new Set(["x"]),
          scalarColorPalette: "viridis",
          scalarRangesByMode: new Map([["x", range]]),
          vectorColorMode: "x",
        },
      )?.scalarColorsByMode.get("x") ?? null;

    const autoLikeRange = buildXColors({ max: 1, min: -1 });
    const narrowedRange = buildXColors({ max: 0.5, min: -0.5 });

    expect(narrowedRange).not.toBe(autoLikeRange);
    expect(buildXColors({ max: 1, min: -1 })).toBe(autoLikeRange);
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

  it("carries analysis overlay visualization phase as render state", () => {
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
        complexFieldVector: {
          componentCount: 3,
          dtype: "complex128",
          grid: [4, 1, 1],
          pointCount: 4,
          quantityId: "analysis:eigen:sample-0000:mode-0002",
          valueCount: 24,
          values: new Float64Array(24),
        },
        scalarColorModes: new Set(["magnitude"]),
        modeOverlay: {
          phasorAmplitudeMax: 2.5,
          representation: "phase_rotated_real",
        },
        visualizationPhaseRad: 1.25,
      },
    );

    expect(model?.complexFieldVector).toMatchObject({
      componentCount: 3,
      dtype: "complex128",
      quantityId: "analysis:eigen:sample-0000:mode-0002",
    });
    expect(model?.visualizationPhaseRad).toBe(1.25);
    expect(model?.modeOverlay).toEqual({
      phasorAmplitudeMax: 2.5,
      phasorPhaseRad: 1.25,
      representation: "phase_rotated_real",
    });
  });

  it("keeps the analysis handoff active while the binary mode payload is loading", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
    );

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      null,
      0.5,
      { analysisOverlayActive: true },
    );

    expect(model?.analysisOverlayActive).toBe(true);
    expect(model?.modeOverlay).toBeNull();
  });

  it("projects complex analysis fields locally using visualization phase", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
    );
    const complexFieldVector = {
      componentCount: 3,
      dtype: "complex128" as const,
      grid: [4, 1, 1] as [number, number, number],
      pointCount: 4,
      quantityId: "analysis:eigen:sample-0000:mode-0002",
      valueCount: 24,
      values: new Float64Array([
        1, 2, 0, 0, 0, 0,
        3, 4, 0, 0, 0, 0,
        5, 6, 0, 0, 0, 0,
        7, 8, 0, 0, 0, 0,
      ]),
    };

    const phaseZero = buildViewport3DFieldRenderModel(topologyModel, null, 0.5, {
      complexFieldVector,
      scalarColorModes: new Set(["x"]),
      visualizationPhaseRad: 0,
    });
    const phaseQuarter = buildViewport3DFieldRenderModel(
      topologyModel,
      null,
      0.5,
      {
        complexFieldVector,
        scalarColorModes: new Set(["x"]),
        visualizationPhaseRad: Math.PI / 2,
      },
    );

    expect(
      Array.from(phaseZero?.scalarColorsByMode.get("x")?.scalarValues ?? []),
    ).toEqual([1, 3, 5, 7]);
    expect(
      Array.from(phaseQuarter?.scalarColorsByMode.get("x")?.scalarValues ?? []),
    ).toEqual([-2, -4, -6, -8]);
    expect(
      Array.from(
        phaseQuarter?.scalarColorsByMode.get("x")?.complexRealValues ?? [],
      ),
    ).toEqual([
      1, 0, 0,
      3, 0, 0,
      5, 0, 0,
      7, 0, 0,
    ]);
    expect(
      Array.from(
        phaseQuarter?.scalarColorsByMode.get("x")?.complexImagValues ?? [],
      ),
    ).toEqual([
      2, 0, 0,
      4, 0, 0,
      6, 0, 0,
      8, 0, 0,
    ]);
    expect(phaseQuarter?.scalarColorsByMode.get("x")?.complexPhaseRad).toBe(
      Math.PI / 2,
    );
    expect(phaseQuarter?.derivedWorkItems).toContainEqual(
      expect.objectContaining({
        lane: "field-color",
        outputKind: "complex-phase-projection",
        passId: "complex-field:phase-projection",
        status: "ready",
        targetId: "complex-field",
      }),
    );
  });

  it("bounds complex phase projection cache entries during phase animation", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [],
      [],
    );
    const complexFieldVector = {
      componentCount: 3,
      dtype: "complex128" as const,
      grid: [4, 1, 1] as [number, number, number],
      pointCount: 4,
      quantityId: "analysis:eigen:mode",
      valueCount: 24,
      values: new Float64Array(24).fill(1),
    };
    const before =
      getViewport3DRenderCacheStats().find(
        (entry) => entry.id === "viewport3d.render.complexPhaseProjectionCache",
      )?.entryCount ?? 0;

    for (let index = 0; index < 20; index += 1) {
      buildViewport3DFieldRenderModel(topologyModel, null, 0.5, {
        complexFieldVector,
        fullVectorBudget: 0,
        scalarColorsVisible: true,
        visualizationPhaseRad: index / 20,
      });
    }

    const after =
      getViewport3DRenderCacheStats().find(
        (entry) => entry.id === "viewport3d.render.complexPhaseProjectionCache",
      )?.entryCount ?? 0;

    expect(after - before).toBeLessThanOrEqual(8);
  });

  it("evicts render buffers by byte budget before the count limit", () => {
    const entries = new Map<string, unknown>([
      ["oldest", new Float32Array(4)],
      ["newest", new Float32Array(4)],
    ]);

    evictViewport3DRenderCacheEntriesForTests(entries, 8, 16);

    expect([...entries.keys()]).toEqual(["newest"]);
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

  it("does not build orientation buffers from component-only field payloads", () => {
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
    const componentFieldVector: DecodedFieldVector = {
      ...fieldVectorFixture(),
      nComp: 1,
      valueCount: 4,
      values: new Float64Array([-1, -0.25, 0.25, 1]),
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      componentFieldVector,
      0.5,
      {
        scalarColorModes: new Set(["orientation", "x"]),
        scalarColorsVisible: true,
        vectorColorMode: "orientation",
      },
    );

    expect(model?.scalarColorsByMode.get("orientation")).toBeNull();
    expect(model?.scalarColorsByMode.get("x")?.colorMode).toBe("x");
    expect(model?.scalarColorsByMode.get("x")?.range).toEqual({
      max: 1,
      min: -1,
    });
    expect(model?.scalarColors).toBeNull();
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
      nodeIndices: new Uint32Array([2, 4, 6, 7]),
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

  it("rejects compressed magnetic-only FEM fields without explicit node indices", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        ...topologyFixture(),
        nodeCount: 5,
        positions: new Float64Array([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
          10, 10, 10,
        ]),
      },
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          node_indices: [0, 1, 2, 3],
        },
      ],
      [],
    );
    const compressedMagneticField: DecodedFieldVector = {
      ...fieldVectorFixture(),
      grid: [4, 1, 1],
      pointCount: 4,
      valueCount: 12,
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      compressedMagneticField,
      0.5,
      {
        partVectorBudgets: new Map([["part-a", 4]]),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
    );

    expect(model?.scalarColorsByMode.get("x")).toBeNull();
    expect(model?.partVectorSegments.get("part-a")).toBeNull();
  });

  it("rejects FEM field vectors whose topology hash does not match the render topology", () => {
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
      undefined,
      {
        meshRevision: "mesh-1",
        meshTopologyHash: "topology-hash",
      },
    );
    const fieldVector: DecodedFieldVector = {
      ...fieldVectorFixture(),
      formatVersion: 3,
      indexing: "full_domain",
      meshTopologyHash: "field-hash",
      meshTopologyRevision: "mesh-1",
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVector,
      0.5,
      {
        partVectorBudgets: new Map([["part-a", 4]]),
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
    );

    expect(model?.scalarColorsByMode.get("x")).toBeNull();
    expect(model?.partVectorSegments.get("part-a")).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "generation-8"],
  ] as const)(
    "rejects %s FMVP v3 part fields before scalar and vector rendering",
    (_kind, domainGenerationId) => {
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
        undefined,
        {
          meshGenerationId: "generation-7",
          meshRevision: "mesh-1",
          meshTopologyHash: "topology-hash",
        },
      );
      const model = buildViewport3DFieldRenderModel(topologyModel, null, 0.5, {
        partFieldVectors: new Map([
          [
            "part-a",
            {
              ...fieldVectorFixture(),
              domainGenerationId,
              formatVersion: 3,
              indexing: "full_domain",
              meshTopologyHash: "topology-hash",
              meshTopologyRevision: "mesh-1",
            },
          ],
        ]),
        partScalarColorModes: new Map([["part-a", "x"]]),
        partVectorBudgets: new Map([["part-a", 4]]),
        scalarColorsVisible: true,
      });

      expect(model?.scalarColorsByPartAndMode.get("part-a")?.get("x")).toBeNull();
      expect(model?.partVectorSegments.get("part-a")).toBeNull();
    },
  );

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
    expect(model?.targetPasses.get("part-a")?.fieldBufferState).toBe(
      "legacy-implicit",
    );
  });

  it("rejects sampled target field buffers for per-vertex surface colors", () => {
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
    const fieldVector = fieldVectorFixture();
    const sampledBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector,
      query: {
        component: "full",
        max_samples: 4,
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partFieldVectors: new Map([["part-a", fieldVector]]),
        partScalarColorModes: new Map([["part-a", "x"]]),
        partTargetFieldBuffers: new Map([["part-a", sampledBuffer]]),
        partVectorBudgets: new Map([["part-a", 4]]),
        scalarColorsVisible: true,
      },
    );

    expect(model?.scalarColorsByPartAndMode.get("part-a")?.get("x")).toBeNull();
    expect(model?.partVectorSegments.get("part-a")?.length).toBeGreaterThan(0);
    expect(model?.targetPasses.get("part-a")?.fieldBuffer).toMatchObject({
      bufferId: sampledBuffer.bufferId,
      capability: "full-vector-sampled",
      component: "full",
      requestId: sampledBuffer.requestId,
      scopeId: "part-a",
      scopeKind: "part",
    });
    expect(model?.targetPasses.get("part-a")?.surface).toMatchObject({
      degradation: "sampled-buffer-not-surface-capable",
      passId: "part-a:surface",
      scalarColorMode: "x",
      scalarColors: null,
    });
    expect(model?.targetPasses.get("part-a")?.vectors).toMatchObject({
      degradation: null,
      passId: "part-a:vector-glyph",
    });
    expect(
      model?.derivedWorkItems.find((item) => item.passId === "part-a:surface"),
    ).toMatchObject({
      blockedReason: "sampled-buffer-not-surface-capable",
      inputBufferId: sampledBuffer.bufferId,
      status: "blocked",
      targetId: "part-a",
    });
    expect(
      model?.derivedWorkItems.find(
        (item) => item.passId === "part-a:vector-glyph",
      ),
    ).toMatchObject({
      blockedReason: null,
      inputBufferId: sampledBuffer.bufferId,
      status: "ready",
      targetId: "part-a",
    });
    expect(model?.targetDiagnostics).toContainEqual({
      buffers: [
        `${sampledBuffer.bufferId} full-vector-sampled quantity=m component=full scope=part:part-a points=4 ncomp=3 indexing=legacy_count_only nodeIndices=none topologyHash=none sampled=true state=target-buffer`,
      ],
      degradation: [
        "surface:sampled-buffer-not-surface-capable",
        `surface-rejected buffer=${sampledBuffer.bufferId} capability=full-vector-sampled reason=sampled-buffer-not-surface-capable`,
        "field-color:sampled-buffer-not-surface-capable",
      ],
      demand: "surface:x vector-glyph",
      derivedWork: [
        "field-color:surface-vertex-colors:blocked:blocked:part-a:surface items=0 input=0B output=0B",
        "vector-glyph:vector-glyphs:ready:runtime-worker:part-a:vector-glyph items=4 input=112B output=112B",
        "vector-glyph:vector-segments:ready:runtime-worker:part-a:vector-glyph items=4 input=96B output=112B",
      ],
      passes: ["surface", "vector-glyph"],
      requests: [sampledBuffer.requestId],
      retained: [],
      targetId: "part-a",
    });
  });

  it.each(["surface_faces", "thickness_average_z"] as const)(
    "renders %s surface coloring from a mapped sampled prism payload",
    (surfaceProjectionMode) => {
      const topologyModel = buildViewport3DTopologyRenderModel(
        topologyFixture(),
        [
          {
            boundary_face_count: 1,
            boundary_face_start: 0,
            element_count: 1,
            element_start: 0,
            id: "part-a",
            label: "Prism",
          },
        ],
        [],
        undefined,
        { meshTopologyHash: "hash-1" },
      );
      const fieldVector: DecodedFieldVector = {
        ...fieldVectorFixture(),
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 1, 2, 3]),
      };
      const sampledBuffer = buildViewport3DTargetFieldBuffer({
        fieldVector,
        query: {
          component: "full",
          max_samples: 4,
          scope_id: "part-a",
          scope_kind: "part",
        },
        targetIds: ["part-a"],
      });

      const model = buildViewport3DFieldRenderModel(
        topologyModel,
        null,
        0.5,
        {
          partTargetFieldBuffers: new Map([["part-a", sampledBuffer]]),
          scalarColorsVisible: true,
          targetRenderPlans: new Map([
            [
              "part-a",
              targetRenderPlanFixture({ surfaceProjectionMode }),
            ],
          ]),
        },
      );

      const surface = model?.targetPasses.get("part-a")?.surface;
      expect(surface?.projectionMode).toBe(surfaceProjectionMode);
      expect(surface?.scalarColors?.projectionMode).toBe(surfaceProjectionMode);
      expect(surface?.scalarColors?.geometryRole).toBe("face_expanded_surface");
      expect(surface?.degradation).toBeNull();
    },
  );

  it.each(["surface_faces", "thickness_average_z"] as const)(
    "renders %s when a prism manifest omits surface metadata",
    (surfaceProjectionMode) => {
      const topology: DecodedTopology = {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        cellCount: 1,
        cellMarkers: new Uint32Array([1]),
        cellNodes: new Uint32Array([0, 1, 2, 3, 4, 5]),
        cellOffsets: new Uint32Array([0, 6]),
        cellTypes: new Uint32Array([2]),
        elementCount: 1,
        elementMarkers: new Uint32Array([1]),
        facetCount: 0,
        facetMarkers: new Uint32Array(),
        facetNodes: new Uint32Array(),
        facetOffsets: new Uint32Array([0]),
        facetRoles: new Uint32Array(),
        facetTypes: new Uint32Array(),
        formatVersion: 2,
        indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
        nodeCount: 6,
        positions: new Float64Array([
          0, 0, -1,
          1, 0, -1,
          0, 1, -1,
          0, 0, 1,
          1, 0, 1,
          0, 1, 1,
        ]),
      };
      const prismPart = {
        boundary_face_count: 0,
        boundary_face_start: 0,
        element_count: 1,
        element_start: 0,
        id: "prism",
        label: "Prism",
      };
      const topologyIndexBundle = buildViewport3DTopologyIndexBundle({
        airboxParts: [],
        magneticParts: [prismPart],
        topology,
      });
      const topologyModel = buildViewport3DTopologyRenderModel(
        topology,
        [prismPart],
        [],
        undefined,
        { meshTopologyHash: "hash-1" },
        { topologyIndexBundle, topologyIndexState: "ready" },
      );
      const fieldVector: DecodedFieldVector = {
        ...fieldVectorFixture(),
        grid: [6, 1, 1],
        pointCount: 6,
        valueCount: 18,
        values: new Float64Array([
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, -1,
          0, 0, -1,
          0, 0, -1,
        ]),
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      };
      const fieldBuffer = buildViewport3DTargetFieldBuffer({
        fieldVector,
        query: {
          component: "full",
          max_samples: 6,
          scope_id: "prism",
          scope_kind: "part",
        },
        targetIds: ["prism"],
      });

      const model = buildViewport3DFieldRenderModel(
        topologyModel,
        null,
        0.5,
        {
          partTargetFieldBuffers: new Map([["prism", fieldBuffer]]),
          scalarColorsVisible: true,
          targetRenderPlans: new Map([
            ["prism", targetRenderPlanFixture({ surfaceProjectionMode })],
          ]),
        },
      );

      const surface = model?.targetPasses.get("prism")?.surface;
      expect(surface?.projectionMode).toBe(surfaceProjectionMode);
      expect(surface?.scalarColors?.projectionMode).toBe(surfaceProjectionMode);
      expect(surface?.scalarColors?.degradedFaceCount).toBe(0);
      expect(surface?.degradation).toBeNull();
    },
  );

  it.each(["surface_faces", "thickness_average_z"] as const)(
    "maps legacy scoped prism fields for %s projection",
    (surfaceProjectionMode) => {
      const topology: DecodedTopology = {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        cellCount: 1,
        cellMarkers: new Uint32Array([1]),
        cellNodes: new Uint32Array([3, 4, 5, 6, 7, 8]),
        cellOffsets: new Uint32Array([0, 6]),
        cellTypes: new Uint32Array([2]),
        elementCount: 1,
        elementMarkers: new Uint32Array([1]),
        facetCount: 0,
        facetMarkers: new Uint32Array(),
        facetNodes: new Uint32Array(),
        facetOffsets: new Uint32Array([0]),
        facetRoles: new Uint32Array(),
        facetTypes: new Uint32Array(),
        formatVersion: 2,
        indices: new Uint32Array([3, 4, 5, 6, 7, 8]),
        nodeCount: 9,
        positions: new Float64Array([
          -1, -1, 0,
          -1, 2, 0,
          2, -1, 0,
          0, 0, -1,
          1, 0, -1,
          0, 1, -1,
          0, 0, 1,
          1, 0, 1,
          0, 1, 1,
        ]),
      };
      const prismPart = {
        boundary_face_count: 0,
        boundary_face_start: 0,
        element_count: 1,
        element_start: 0,
        id: "prism",
        label: "Prism",
        node_count: 6,
        node_start: 3,
      };
      const topologyIndexBundle = buildViewport3DTopologyIndexBundle({
        airboxParts: [],
        magneticParts: [prismPart],
        topology,
      });
      const topologyModel = buildViewport3DTopologyRenderModel(
        topology,
        [prismPart],
        [],
        undefined,
        { meshTopologyHash: "hash-1" },
        { topologyIndexBundle, topologyIndexState: "ready" },
      );
      const fieldVector: DecodedFieldVector = {
        ...fieldVectorFixture(),
        grid: [6, 1, 1],
        pointCount: 6,
        valueCount: 18,
        values: new Float64Array([
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, -1,
          0, 0, -1,
          0, 0, -1,
        ]),
      };

      const model = buildViewport3DFieldRenderModel(
        topologyModel,
        null,
        0.5,
        {
          partFieldVectors: new Map([["prism", fieldVector]]),
          scalarColorsVisible: true,
          targetRenderPlans: new Map([
            ["prism", targetRenderPlanFixture({ surfaceProjectionMode })],
          ]),
        },
      );

      const surface = model?.targetPasses.get("prism")?.surface;
      expect(surface?.projectionMode).toBe(surfaceProjectionMode);
      expect(surface?.scalarColors?.projectionMode).toBe(surfaceProjectionMode);
      expect(surface?.scalarColors?.degradedFaceCount).toBe(0);
      expect(surface?.degradation).toBeNull();
    },
  );

  it("uses target render plans as authoritative part pass semantics", () => {
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
    const fieldVector = fieldVectorFixture();
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      fieldRevision: "field-1",
      fieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVector,
      0.5,
      {
        partScalarColorModes: new Map([["part-a", "y"]]),
        partTargetFieldBuffers: new Map([["part-a", targetBuffer]]),
        partVectorBudgets: new Map([["part-a", 0]]),
        fieldRevision: "field-1",
        scalarColorsVisible: true,
        targetVisualizationRevision: "viz-1",
        targetRenderPlans: new Map([
          [
            "part-a",
            targetRenderPlanFixture({
              surfaceColorSource: "component_x",
              surfaceProjectionMode: "surface_faces",
            }),
          ],
        ]),
        topologyRevision: "topology-1",
      },
    );

    const targetPass = model?.targetPasses.get("part-a");
    expect(targetPass?.fieldBuffer).toMatchObject({
      requestId: targetBuffer.requestId,
      resourceKey: targetBuffer.resourceKey,
    });
    expect(targetPass?.surface.scalarColorMode).toBe("x");
    expect(targetPass?.surface.projectionMode).toBe("surface_faces");
    expect(targetPass?.surface.scalarColors).toMatchObject({
      colors: expect.objectContaining({ length: 9 }),
      geometryRole: "face_expanded_surface",
      projectionMode: "surface_faces",
      sourceFieldBufferId: targetBuffer.bufferId,
      sourceResourceKey: targetBuffer.resourceKey,
    });
    expect(targetPass?.vectors.segments?.length).toBeGreaterThan(0);
    expect(targetPass?.vectors.buildReference).toMatchObject({
      fieldBufferId: targetBuffer.bufferId,
      resourceKey: targetBuffer.resourceKey,
      revisionSummary: expect.stringContaining("scope=full:part-a"),
    });
    expect(model?.targetDiagnostics).toContainEqual(
      expect.objectContaining({
        demand: "surface:x vector-glyph",
        targetId: "part-a",
      }),
    );
  });

  it("preserves the exact decoded FMVP payload on target render-pass field sources", () => {
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
    const nodeIndices = new Uint32Array([0, 1, 2, 3]);
    const values = new Float64Array(12);
    const decodedFieldVector: DecodedFieldVector = {
      domainGenerationId: "decoded-domain",
      dtype: "float64",
      formatVersion: 3,
      grid: [4, 1, 1],
      indexing: "explicit_node_indices",
      meshTopologyHash: "decoded-topology-hash",
      meshTopologyRevision: "decoded-topology-revision",
      nComp: 3,
      nodeIndices,
      pointCount: 4,
      quantityId: "H_demag",
      scopeId: "part-a",
      scopeKind: "part",
      valueCount: 12,
      values,
    };
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: decodedFieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      null,
      0.5,
      {
        partTargetFieldBuffers: new Map([["part-a", targetBuffer]]),
        partVectorBudgets: new Map([["part-a", 0]]),
        scalarColorsVisible: false,
      },
    );

    const source = model?.targetPasses.get("part-a")?.fieldBuffer;
    expect(source?.decodedFieldVector).toBe(decodedFieldVector);
    expect(source?.decodedFieldVector?.nodeIndices).toBe(nodeIndices);
    expect(source?.decodedFieldVector?.values).toBe(values);
  });

  it("does not expose synthetic render vectors as decoded FMVP payloads", () => {
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
    const syntheticVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [4, 1, 1],
      nComp: 3,
      pointCount: 4,
      quantityId: "synthetic_airbox",
      valueCount: 12,
      values: new Float64Array(12),
    };
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: syntheticVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "airbox",
      },
      synthetic: true,
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(topologyModel, null, 0.5, {
      partTargetFieldBuffers: new Map([["part-a", targetBuffer]]),
      partVectorBudgets: new Map([["part-a", 0]]),
      scalarColorsVisible: false,
    });

    expect(model?.targetPasses.get("part-a")?.fieldBuffer?.decodedFieldVector).toBeNull();
  });

  it("builds face-expanded scalar colors for surface face projection plans", () => {
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
      undefined,
      {
        meshTopologyHash: "hash-1",
      },
    );

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      {
        ...fieldVectorFixture(),
        values: new Float64Array([
          0, 0, 0,
          3, 0, 0,
          6, 0, 0,
          100, 0, 0,
        ]),
      },
      0.5,
      {
        fieldRevision: "field-1",
        scalarColorsVisible: true,
        targetRenderPlans: new Map([
          [
            "part-a",
            targetRenderPlanFixture({
              surfaceColorSource: "component_x",
              surfaceProjectionMode: "surface_faces",
            }),
          ],
        ]),
        topologyRevision: "topology-1",
      },
    );

    const surface = model?.targetPasses.get("part-a")?.surface;
    expect(surface?.projectionMode).toBe("surface_faces");
    expect(surface?.scalarColors).toMatchObject({
      faceCount: 1,
      geometryRole: "face_expanded_surface",
      projectionMode: "surface_faces",
      rangeSource: "face_values",
    });
    expect(Array.from(surface?.scalarColors?.scalarValues ?? [])).toEqual([
      3, 3, 3,
    ]);
  });

  it("builds projected scalar colors for thickness-average-z projection plans", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        boundaryFaceCount: 1,
        boundaryFaces: new Uint32Array([0, 1, 2]),
        boundaryMarkers: new Uint32Array(),
        elementCount: 0,
        elementMarkers: new Uint32Array(),
        indices: new Uint32Array(),
        nodeCount: 6,
        positions: new Float64Array([
          0, 0, 1,
          1, 0, 1,
          0, 1, 1,
          0, 0, -1,
          1, 0, -1,
          0, 1, -1,
        ]),
      },
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          nodeCount: 6,
          nodeStart: 0,
        },
      ],
      [],
      undefined,
      {
        meshTopologyHash: "hash-1",
      },
    );

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      {
        dtype: "float64",
        grid: [6, 1, 1],
        nComp: 3,
        pointCount: 6,
        quantityId: "m",
        valueCount: 18,
        values: new Float64Array([
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, -1,
          0, 0, -1,
          0, 0, -1,
        ]),
      },
      0.5,
      {
        fieldRevision: "field-1",
        scalarColorsVisible: true,
        targetRenderPlans: new Map([
          [
            "part-a",
            targetRenderPlanFixture({
              surfaceColorSource: "orientation",
              surfaceProjectionMode: "thickness_average_z",
            }),
          ],
        ]),
        topologyRevision: "topology-1",
      },
    );

    const surface = model?.targetPasses.get("part-a")?.surface;
    expect(surface?.projectionMode).toBe("thickness_average_z");
    expect(surface?.scalarColors).toMatchObject({
      faceCount: 1,
      geometryRole: "face_expanded_surface",
      lowNormFaceCount: 1,
      projectionMode: "thickness_average_z",
      rangeSource: "projected_values",
    });
    expect(Array.from(surface?.scalarColors?.vectorValues ?? [])).toEqual([
      0, 0, 0,
      0, 0, 0,
      0, 0, 0,
    ]);
  });

  it("does not resurrect disabled target passes from legacy option maps", () => {
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
    const fieldVector = fieldVectorFixture();
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVector,
      0.5,
      {
        partScalarColorModes: new Map([["part-a", "x"]]),
        partTargetFieldBuffers: new Map([["part-a", targetBuffer]]),
        partVectorBudgets: new Map([["part-a", 4]]),
        scalarColorsVisible: true,
        targetRenderPlans: new Map([
          [
            "part-a",
            targetRenderPlanFixture({
              shaderVisible: false,
              vectorsVisible: false,
            }),
          ],
        ]),
      },
    );

    const targetPass = model?.targetPasses.get("part-a");
    expect(targetPass?.surface.scalarColorMode).toBeNull();
    expect(targetPass?.surface.scalarColors).toBeNull();
    expect(targetPass?.vectors.segments).toBeNull();
    expect(targetPass?.vectors.buildReference).toBeNull();
    expect(model?.targetDiagnostics).toContainEqual(
      expect.objectContaining({
        demand: null,
        targetId: "part-a",
      }),
    );
  });

  it("exposes full-domain surface and vector passes through the target-pass contract", () => {
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
        fullScalarColorMode: "x",
        fullVectorBudget: 4,
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
    );

    const fullPass = model?.targetPasses.get("full");
    const scalarColors = model?.scalarColorsByMode.get("x");

    expect(fullPass?.fieldBufferState).toBe("derived-global");
    expect(fullPass?.surface).toMatchObject({
      degradation: null,
      passId: "full:surface",
      scalarColorMode: "x",
      scalarColors,
    });
    expect(fullPass?.vectors).toMatchObject({
      degradation: null,
      passId: "full:vector-glyph",
      segments: model?.fullVectorSegments,
    });
    expect(fullPass?.vectors.buildReference).toBe(model?.fullVectorBuild);
    expect(
      model?.derivedWorkItems.find((item) => item.passId === "full:surface"),
    ).toMatchObject({
      blockedReason: null,
      status: "ready",
      targetId: "full",
    });
  });

  it("rejects scalar-only target field buffers for vector glyphs", () => {
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
    const scalarFieldVector: DecodedFieldVector = {
      ...fieldVectorFixture(),
      nComp: 1,
      valueCount: 4,
      values: new Float64Array([1, 0, -1, 0.5]),
    };
    const scalarBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: scalarFieldVector,
      query: {
        component: "x",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partFieldVectors: new Map([["part-a", scalarFieldVector]]),
        partScalarColorModes: new Map([["part-a", "x"]]),
        partTargetFieldBuffers: new Map([["part-a", scalarBuffer]]),
        partVectorBudgets: new Map([["part-a", 4]]),
        scalarColorsVisible: true,
      },
    );

    expect(
      model?.scalarColorsByPartAndMode.get("part-a")?.get("x")?.colors.length,
    ).toBe(12);
    expect(model?.partVectorSegments.get("part-a")).toBeNull();
    expect(model?.targetPasses.get("part-a")?.surface.degradation).toBeNull();
    expect(model?.targetPasses.get("part-a")?.vectors).toMatchObject({
      buildReference: null,
      degradation: "scalar-buffer-not-vector-capable",
      segments: null,
    });
    expect(
      model?.derivedWorkItems.find(
        (item) => item.passId === "part-a:vector-glyph",
      ),
    ).toMatchObject({
      blockedReason: "scalar-buffer-not-vector-capable",
      inputBufferId: scalarBuffer.bufferId,
      status: "blocked",
      targetId: "part-a",
    });
    expect(model?.targetDiagnostics).toContainEqual({
      buffers: [
        `${scalarBuffer.bufferId} scalar-complete quantity=m component=x scope=part:part-a points=4 ncomp=1 indexing=legacy_count_only nodeIndices=none topologyHash=none sampled=false state=target-buffer`,
      ],
      degradation: [
        "vector-glyph:scalar-buffer-not-vector-capable",
        `vector-glyph-rejected buffer=${scalarBuffer.bufferId} capability=scalar-complete reason=scalar-buffer-not-vector-capable`,
      ],
      demand: "surface:x vector-glyph",
      derivedWork: [
        "field-color:surface-vertex-colors:ready:render-model-sync:part-a:surface items=4 input=16B output=48B",
        "vector-glyph:vector-glyphs:blocked:blocked:part-a:vector-glyph items=0 input=0B output=0B",
        "vector-glyph:vector-segments:blocked:blocked:part-a:vector-glyph items=0 input=32B output=0B",
      ],
      passes: ["surface", "vector-glyph"],
      requests: [scalarBuffer.requestId],
      retained: [],
      targetId: "part-a",
    });
  });

  it("rejects scalar target field buffers for a different surface component", () => {
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
    const scalarXFieldVector: DecodedFieldVector = {
      ...fieldVectorFixture(),
      nComp: 1,
      valueCount: 4,
      values: new Float64Array([1, 0, -1, 0.5]),
    };
    const scalarXBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: scalarXFieldVector,
      query: {
        component: "x",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partFieldVectors: new Map([["part-a", scalarXFieldVector]]),
        partScalarColorModes: new Map([["part-a", "y"]]),
        partTargetFieldBuffers: new Map([["part-a", scalarXBuffer]]),
        scalarColorsVisible: true,
      },
    );

    expect(model?.scalarColorsByPartAndMode.get("part-a")?.get("y")).toBeNull();
    expect(model?.targetPasses.get("part-a")?.surface).toMatchObject({
      degradation: "buffer-not-surface-capable",
      scalarColorMode: "y",
      scalarColors: null,
    });
  });

  it("rejects target field buffers from another active target quantity", () => {
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
    const scalarFieldVector: DecodedFieldVector = {
      ...fieldVectorFixture(),
      nComp: 1,
      quantityId: "m",
      valueCount: 4,
      values: new Float64Array([1, 0, -1, 0.5]),
    };
    const scalarBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: scalarFieldVector,
      query: {
        component: "x",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partQuantityIds: new Map([["part-a", "H_eff"]]),
        partScalarColorModes: new Map([["part-a", "x"]]),
        partTargetFieldBuffers: new Map([["part-a", scalarBuffer]]),
        partVectorBudgets: new Map([["part-a", 4]]),
        scalarColorsVisible: true,
      },
    );

    expect(model?.scalarColorsByPartAndMode.get("part-a")?.get("x")).toBeNull();
    expect(model?.partVectorSegments.get("part-a")).toBeNull();
    expect(model?.targetPasses.get("part-a")?.surface).toMatchObject({
      degradation: "buffer-quantity-mismatch",
      scalarColors: null,
    });
    expect(model?.targetPasses.get("part-a")?.vectors).toMatchObject({
      degradation: "buffer-quantity-mismatch",
      segments: null,
    });
    expect(model?.targetDiagnostics).toContainEqual({
      buffers: [
        `${scalarBuffer.bufferId} scalar-complete quantity=m component=x scope=part:part-a points=4 ncomp=1 indexing=legacy_count_only nodeIndices=none topologyHash=none sampled=false state=target-buffer`,
      ],
      degradation: [
        "surface:buffer-quantity-mismatch",
        `surface-rejected buffer=${scalarBuffer.bufferId} capability=scalar-complete reason=buffer-quantity-mismatch`,
        "vector-glyph:buffer-quantity-mismatch",
        `vector-glyph-rejected buffer=${scalarBuffer.bufferId} capability=scalar-complete reason=buffer-quantity-mismatch`,
        "field-color:buffer-quantity-mismatch",
      ],
      demand: "surface:x vector-glyph",
      derivedWork: [
        "field-color:surface-vertex-colors:blocked:blocked:part-a:surface items=0 input=0B output=0B",
        "vector-glyph:vector-glyphs:blocked:blocked:part-a:vector-glyph items=0 input=0B output=0B",
        "vector-glyph:vector-segments:blocked:blocked:part-a:vector-glyph items=0 input=32B output=0B",
      ],
      passes: ["surface", "vector-glyph"],
      requests: [scalarBuffer.requestId],
      retained: [],
      targetId: "part-a",
    });
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
      nodeIndices: new Uint32Array([2, 4]),
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
    expect(Array.from(colors!.slice(6, 9))).toEqual(
      Array.from(Float32Array.from(magnitudeColorRgb(0))),
    );
    expect(Array.from(colors!.slice(9, 12))).toEqual([0, 0, 0]);
    expect(Array.from(colors!.slice(12, 15))).toEqual(
      Array.from(Float32Array.from(magnitudeColorRgb(1))),
    );
  });

  it("maps full-size explicit node-index vectors before building per-part scalar colors", () => {
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
      undefined,
      {
        meshTopologyHash: "hash-1",
      },
    );
    const reorderedFieldVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [4, 1, 1],
      indexing: "explicit_node_indices",
      meshTopologyHash: "hash-1",
      nComp: 3,
      nodeIndices: new Uint32Array([3, 2, 1, 0]),
      pointCount: 4,
      quantityId: "h_ex",
      valueCount: 12,
      values: new Float64Array([
        -1, 0, 0,
        -0.5, 0, 0,
        0.5, 0, 0,
        1, 0, 0,
      ]),
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partFieldVectors: new Map([["part-a", reorderedFieldVector]]),
        partScalarColorModes: new Map([["part-a", "x"]]),
        scalarColorsVisible: true,
      },
    );

    expect(
      Array.from(
        model?.scalarColorsByPartAndMode.get("part-a")?.get("x")?.scalarValues ??
          [],
      ),
    ).toEqual([1, 0.5, -0.5, -1]);
  });

  it("rejects scoped per-part scalar colors without explicit node indices", () => {
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

    expect(
      model?.scalarColorsByPartAndMode.get("part-a")?.get("x"),
    ).toBeNull();
  });

  it("builds per-part scalar colors for shared field vectors when palette differs", () => {
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
          boundary_face_start: 1,
          id: "part-b",
          label: "Part B",
          nodeCount: 2,
          nodeStart: 2,
        },
      ],
      [],
    );

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partScalarColorModes: new Map([["part-a", "x"]]),
        partScalarColorPalettes: new Map([["part-a", "inferno"]]),
        scalarColorModes: new Set(["orientation", "x"]),
        scalarColorPalette: "viridis",
        scalarColorsVisible: true,
      },
    );

    const partColors =
      model?.scalarColorsByPartAndMode.get("part-a")?.get("x");
    const globalColors = model?.scalarColorsByMode.get("x");
    expect(partColors?.colorPalette).toBe("inferno");
    expect(globalColors?.colorPalette).toBe("viridis");
    expect(partColors?.colors).not.toBe(globalColors?.colors);
    expect(
      model?.derivedWorkItems.find((item) => item.passId === "part-a:surface"),
    ).toMatchObject({
      blockedReason: null,
      lane: "field-color",
      outputKind: "surface-vertex-colors",
      status: "ready",
      targetId: "part-a",
    });
    expect(model?.targetDiagnostics).toContainEqual({
      buffers: ["state=derived-global"],
      degradation: [],
      demand: "surface:x vector-glyph",
      derivedWork: [
        "field-color:surface-vertex-colors:ready:render-model-sync:part-a:surface items=4 input=16B output=48B",
        "vector-glyph:vector-glyphs:ready:runtime-worker:part-a:vector-glyph items=2 input=56B output=56B",
        "vector-glyph:vector-segments:ready:runtime-worker:part-a:vector-glyph items=2 input=0B output=56B",
      ],
      passes: ["surface", "vector-glyph"],
      requests: [],
      retained: [],
      targetId: "part-a",
    });
  });

  it("uses the part field vector range for per-part colors from another quantity", () => {
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
    const effectiveField = {
      ...fieldVectorFixture(),
      quantityId: "H_eff",
      values: new Float64Array([
        0, 10, 0,
        0, 20, 0,
        0, 30, 0,
        0, 40, 0,
      ]),
    };

    const model = buildViewport3DFieldRenderModel(
      topologyModel,
      fieldVectorFixture(),
      0.5,
      {
        partFieldVectors: new Map([["part-a", effectiveField]]),
        partScalarColorModes: new Map([["part-a", "y"]]),
        scalarColorModes: new Set(["y"]),
        scalarColorPalette: "viridis",
        scalarRangesByMode: new Map([["y", { max: 1, min: -1 }]]),
        scalarColorsVisible: true,
      },
    );

    const partColors =
      model?.scalarColorsByPartAndMode.get("part-a")?.get("y");
    const globalColors = model?.scalarColorsByMode.get("y");
    expect(globalColors?.quantityId).toBe("m");
    expect(globalColors?.range).toEqual({ max: 1, min: -1 });
    expect(partColors?.quantityId).toBe("H_eff");
    expect(partColors?.range).toEqual({ max: 40, min: 10 });
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

  it("bounds per-owner render vector cache entries when vector scale changes", () => {
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
    const fieldVector = fieldVectorFixture();
    const before =
      getViewport3DRenderCacheStats().find(
        (entry) => entry.id === "viewport3d.render.partVectorSegmentCache",
      )?.entryCount ?? 0;

    for (let index = 0; index < 20; index += 1) {
      buildViewport3DFieldRenderModel(topologyModel, null, 1, {
        partFieldVectors: new Map([["part-a", fieldVector]]),
        partVectorBudgets: new Map([["part-a", 4]]),
        partVectorScales: new Map([["part-a", index + 1]]),
        scalarColorsVisible: false,
      });
    }

    const after =
      getViewport3DRenderCacheStats().find(
        (entry) => entry.id === "viewport3d.render.partVectorSegmentCache",
      )?.entryCount ?? 0;

    expect(after - before).toBeLessThanOrEqual(8);
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
    expect(
      viewport3DFieldRenderOptionsNeedFieldData({
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorsVisible: false,
        targetRenderPlans: new Map([
          [
            "part-a",
            targetRenderPlanFixture({
              shaderVisible: false,
              vectorsVisible: false,
            }),
          ],
        ]),
      }),
    ).toBe(false);
    expect(
      viewport3DFieldRenderOptionsNeedFieldData({
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorsVisible: false,
        targetRenderPlans: new Map([
          ["part-a", targetRenderPlanFixture({ surfaceColorSource: "component_x" })],
        ]),
      }),
    ).toBe(true);
  });

  it("uses explicit per-part scalar ranges for scoped color buffers", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          id: "part-a",
          label: "Part A",
          node_count: 4,
          node_start: 0,
        },
      ],
      [],
    );
    const fieldVector = fieldVectorFixture();
    const model = buildViewport3DFieldRenderModel(topologyModel, fieldVector, 1, {
      partFieldVectors: new Map([["part-a", fieldVector]]),
      partScalarColorModes: new Map([["part-a", "x"]]),
      partScalarColorPalettes: new Map([["part-a", "inferno"]]),
      partScalarRangesByMode: new Map([
        ["part-a", new Map([["x", { max: 12, min: -3 }]])],
      ]),
      scalarColorModes: new Set(["x"]),
      scalarColorsVisible: true,
    });

    expect(model?.scalarColorsByPartAndMode.get("part-a")?.get("x")?.range)
      .toEqual({ max: 12, min: -3 });
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

  it("does not draw airbox vector glyphs on magnetic interface nodes", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array([0, 1, 2, 0, 1, 4]),
        boundaryMarkers: new Uint32Array(),
        elementCount: 2,
        elementMarkers: new Uint32Array([1, 0]),
        indices: new Uint32Array([
          0, 1, 2, 3,
          0, 1, 2, 4,
        ]),
        nodeCount: 5,
        positions: new Float64Array([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
          0, 0, -1,
        ]),
      },
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "magnetic-part",
          label: "Magnetic Part",
          node_indices: [0, 1, 2, 3],
        },
      ],
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "airbox",
          label: "Airbox",
          node_indices: [0, 1, 2, 4],
          role: "air",
        },
      ],
    );

    expect(
      topologyModel?.airboxParts[0]?.fullNodeSelection.nodeIndices,
    ).toEqual([4]);

    const fieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      null,
      0.5,
      {
        partFieldVectors: new Map([
          [
            "airbox",
            {
              dtype: "float64",
              grid: [4, 1, 1],
              nComp: 3,
              nodeIndices: new Uint32Array([0, 1, 2, 4]),
              pointCount: 4,
              quantityId: "H_demag",
              valueCount: 12,
              values: new Float64Array([
                0, 1, 0,
                0, 0, 1,
                -1, 0, 0,
                1, 0, 0,
              ]),
            },
          ],
        ]),
        partVectorBudgets: new Map([["airbox", 4]]),
        scalarColorsVisible: false,
      },
    );

    expect(fieldModel?.partVectorSegments.get("airbox")).toBeNull();
  });

  it("rejects a scoped payload larger than the active air-only surface carrier", () => {
    const topologyModel = buildViewport3DTopologyRenderModel(
      topologyFixture(),
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "magnetic-part",
          node_indices: [0],
        },
      ],
      [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          id: "airbox",
          node_indices: [0, 1, 2, 3],
          role: "air",
        },
      ],
    );
    const field = {
      ...fieldVectorFixture(),
      grid: [3, 1, 1] as [number, number, number],
      nodeIndices: new Uint32Array([1, 2, 3]),
      pointCount: 3,
      valueCount: 9,
      values: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    };

    const fieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      null,
      0.5,
      {
        partFieldVectors: new Map([["airbox", field]]),
        partVectorBudgets: new Map([["airbox", 3]]),
        partVectorScopes: new Map([["airbox", "surface"]]),
        scalarColorsVisible: false,
      },
    );

    expect(topologyModel?.airboxParts[0]?.fullNodeSelection.nodeIndices).toEqual([
      1, 2, 3,
    ]);
    expect(
      topologyModel?.airboxParts[0]?.surfaceNodeSelection?.nodeIndices,
    ).toEqual([1, 2]);
    expect(fieldModel?.partVectorSegments.get("airbox")).toBeNull();
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
              nodeIndices: new Uint32Array([4, 5, 6, 7]),
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

  it("builds sampled scoped vector glyphs at the matching global topology positions", () => {
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
      null,
      0.5,
      {
        partFieldVectors: new Map([
          [
            "airbox",
            {
              dtype: "float64",
              grid: [2, 1, 1],
              nComp: 3,
              nodeIndices: new Uint32Array([4, 6]),
              pointCount: 2,
              quantityId: "H_demag",
              valueCount: 6,
              values: new Float64Array([
                1, 0, 0,
                0, 0, 1,
              ]),
            },
          ],
        ]),
        partVectorBudgets: new Map([["airbox", 2]]),
        scalarColorsVisible: false,
      },
    );

    const segments = fieldModel?.partVectorSegments.get("airbox");
    expect(segments?.length).toBe(14);
    expect(segments?.[0]).toBeCloseTo(9.75);
    expect(segments?.[3]).toBeCloseTo(10.25);
    expect(segments?.[7]).toBeCloseTo(10);
    expect(segments?.[8]).toBeCloseTo(1);
    expect(segments?.[9]).toBeCloseTo(-0.25);
    expect(segments?.[12]).toBeCloseTo(0.25);
  });

  it("draws sampled airbox vectors after excluding magnetic nodes", () => {
    const positions: number[] = [];
    for (let node = 0; node < 15; node += 1) {
      positions.push(node, 0, 0);
    }
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        elementCount: 0,
        elementMarkers: new Uint32Array(),
        indices: new Uint32Array(),
        nodeCount: 15,
        positions: new Float64Array(positions),
      },
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          id: "magnetic-part",
          label: "Magnetic Part",
          node_indices: [0, 1, 2, 3, 4, 5],
        },
      ],
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          id: "airbox",
          label: "Airbox",
          node_indices: Array.from({ length: 15 }, (_, index) => index),
          role: "air",
        },
      ],
    );

    const fieldModel = buildViewport3DFieldRenderModel(topologyModel, null, 1, {
      partFieldVectors: new Map([
        [
          "airbox",
          {
            dtype: "float64",
            grid: [5, 1, 1],
            nComp: 3,
            nodeIndices: new Uint32Array([6, 7, 8, 9, 10]),
            pointCount: 5,
            quantityId: "H_eff",
            valueCount: 15,
            values: new Float64Array([
              1, 0, 0,
              1, 0, 0,
              1, 0, 0,
              1, 0, 0,
              1, 0, 0,
            ]),
          },
        ],
      ]),
      partVectorBudgets: new Map([["airbox", 5]]),
      scalarColorsVisible: false,
    });

    const segments = fieldModel?.partVectorSegments.get("airbox");
    expect(segments?.length).toBe(35);
    expect(segments?.[0]).toBeCloseTo(5.5);
    expect(segments?.[3]).toBeCloseTo(6.5);
    expect(segments?.[7]).toBeCloseTo(6.5);
    expect(segments?.[10]).toBeCloseTo(7.5);
    expect(segments?.[14]).toBeCloseTo(7.5);
    expect(segments?.[17]).toBeCloseTo(8.5);
  });

  it("keeps sampled airbox vectors visible when backend samples exclude magnetic nodes first", () => {
    const positions: number[] = [];
    for (let node = 0; node < 12; node += 1) {
      positions.push(node, 0, 0);
    }
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        elementCount: 0,
        elementMarkers: new Uint32Array(),
        indices: new Uint32Array(),
        nodeCount: 12,
        positions: new Float64Array(positions),
      },
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          id: "magnetic-part",
          label: "Magnetic Part",
          node_indices: [0, 1, 2, 3, 4, 5],
        },
      ],
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          id: "airbox",
          label: "Airbox",
          node_indices: Array.from({ length: 12 }, (_, index) => index),
          role: "air",
        },
      ],
    );

    const fieldModel = buildViewport3DFieldRenderModel(topologyModel, null, 1, {
      partFieldVectors: new Map([
        [
          "airbox",
          {
            dtype: "float64",
            grid: [2, 1, 1],
            nComp: 3,
            nodeIndices: new Uint32Array([6, 9]),
            pointCount: 2,
            quantityId: "H_demag",
            valueCount: 6,
            values: new Float64Array([
              1, 0, 0,
              1, 0, 0,
            ]),
          },
        ],
      ]),
      partVectorBudgets: new Map([["airbox", 2]]),
      scalarColorsVisible: false,
    });

    const segments = fieldModel?.partVectorSegments.get("airbox");
    expect(segments?.length).toBe(14);
    expect(segments?.[0]).toBeCloseTo(5.5);
    expect(segments?.[3]).toBeCloseTo(6.5);
    expect(segments?.[7]).toBeCloseTo(8.5);
    expect(segments?.[10]).toBeCloseTo(9.5);
  });

  it("renders sampled airbox vectors from the canonical target field buffer", () => {
    const positions: number[] = [];
    for (let node = 0; node < 12; node += 1) {
      positions.push(node, 0, 0);
    }
    const topologyModel = buildViewport3DTopologyRenderModel(
      {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        elementCount: 0,
        elementMarkers: new Uint32Array(),
        indices: new Uint32Array(),
        nodeCount: 12,
        positions: new Float64Array(positions),
      },
      [],
      [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          id: "airbox",
          label: "Airbox",
          node_indices: Array.from({ length: 12 }, (_, index) => index),
          role: "air",
        },
      ],
      undefined,
      {
        meshGenerationId: "generation-1",
        meshRevision: 7,
        meshTopologyHash: "topology-hash-1",
      },
    );
    const fieldVector: DecodedFieldVector = {
      domainGenerationId: "generation-1",
      dtype: "float64",
      grid: [2, 1, 1],
      indexing: "sampled_node_indices",
      meshTopologyHash: "topology-hash-1",
      nComp: 3,
      nodeIndices: new Uint32Array([6, 9]),
      pointCount: 2,
      quantityId: "H_demag",
      valueCount: 6,
      values: new Float64Array([1, 0, 0, 1, 0, 0]),
    };
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      domain: {
        domainGenerationId: "generation-1",
        meshTopologyHash: "topology-hash-1",
        meshTopologyRevision: "7",
        pointCount: 12,
      },
      fieldRevision: "H_demag-37",
      fieldVector,
      query: {
        component: "full",
        max_samples: 2,
        scope_id: "part:__air__",
        scope_kind: "airbox",
      },
      targetIds: ["airbox"],
      topologyRevision: "7",
    });

    const fieldModel = buildViewport3DFieldRenderModel(topologyModel, null, 1, {
      fieldRevision: "m-332",
      partQuantityIds: new Map([["airbox", "H_demag"]]),
      partTargetFieldBuffers: new Map([["airbox", targetBuffer]]),
      partVectorBudgets: new Map([["airbox", 2]]),
      scalarColorsVisible: false,
      topologyRevision: "7",
    });

    expect(targetBuffer.capability).toBe("full-vector-sampled");
    expect(fieldModel?.partVectorSegments.get("airbox")?.length).toBe(14);
    expect(fieldModel?.targetPasses.get("airbox")?.vectors.degradation).toBeNull();
    expect(
      fieldModel?.targetPasses.get("airbox")?.vectors.buildReference,
    ).toMatchObject({ fieldRevision: "H_demag-37" });
    expect(
      fieldModel?.targetPasses.get("airbox")?.vectors.buildReference?.buildKey,
    ).toContain("H_demag-37");
    expect(
      fieldModel?.targetPasses.get("airbox")?.vectors.buildReference?.buildKey,
    ).not.toContain("m-332");
  });

  it("builds sampled magnetic part vectors at matching global topology positions", () => {
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
      [
        {
          boundary_face_count: 2,
          boundary_face_start: 0,
          id: "part-a",
          label: "Part A",
          nodeCount: 4,
          nodeStart: 4,
        },
      ],
      [],
    );

    const fieldModel = buildViewport3DFieldRenderModel(
      topologyModel,
      null,
      0.5,
      {
        partFieldVectors: new Map([
          [
            "part-a",
            {
              dtype: "float64",
              grid: [2, 1, 1],
              nComp: 3,
              nodeIndices: new Uint32Array([4, 6]),
              pointCount: 2,
              quantityId: "m",
              valueCount: 6,
              values: new Float64Array([
                1, 0, 0,
                0, 0, 1,
              ]),
            },
          ],
        ]),
        partVectorBudgets: new Map([["part-a", 2]]),
        scalarColorsVisible: false,
      },
    );

    const segments = fieldModel?.partVectorSegments.get("part-a");
    expect(segments?.length).toBe(14);
    expect(segments?.[0]).toBeCloseTo(9.75);
    expect(segments?.[3]).toBeCloseTo(10.25);
    expect(segments?.[7]).toBeCloseTo(10);
    expect(segments?.[8]).toBeCloseTo(1);
    expect(segments?.[9]).toBeCloseTo(-0.25);
    expect(segments?.[12]).toBeCloseTo(0.25);
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
    expect(
      resolveNodeSelectionCount(
        { node_indices: [] },
        { nodeCount: 10 },
      ),
    ).toBe(0);
  });
});
