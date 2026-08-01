import { describe, expect, it } from "vitest";
import type { components } from "@/kernel/api/generated/openapi-v2-types";

import {
  buildRegionMeshOverlayModels,
  buildRegionOverlayModels,
  resolveRegionOverlayColor,
  resolveRegionOverlayStyle,
} from "./regionOverlayModel";

describe("regionOverlayModel", () => {
  it("normalizes authored box, cylinder, and sphere region shapes", () => {
    const models = buildRegionOverlayModels([
      {
        enabled: true,
        name: "Core box",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:box",
        shape: {
          center: [1, 2, 3],
          kind: "box",
          size: [4, 5, 6],
        },
      },
      {
        enabled: true,
        name: "Core cylinder",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:cylinder",
        shape: {
          axis: [0, 0, 1],
          center: [0, 0, 0],
          height: 2,
          kind: "cylinder",
          radius: 0.5,
        },
      },
      {
        enabled: true,
        name: "Core sphere",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:sphere",
        shape: {
          center: [-1, -2, -3],
          kind: "sphere",
          radius: 7,
        },
      },
    ]);

    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      center: [1, 2, 3],
      kind: "box",
      objectId: "film",
      regionId: "film:box",
      size: [4, 5, 6],
    });
    expect(models[1]).toMatchObject({
      axis: [0, 0, 1],
      center: [0, 0, 0],
      height: 2,
      kind: "cylinder",
      radius: 0.5,
      selected: false,
      style: {
        wireframeOpacity: 0.72,
        wireframeScale: 1.004,
        wireframeVisible: true,
      },
    });
    expect(models[2]).toMatchObject({
      center: [-1, -2, -3],
      kind: "sphere",
      radius: 7,
    });
  });

  it("assigns Catppuccin colors by descending priority slot", () => {
    const models = buildRegionOverlayModels(
      [
        {
          enabled: true,
          name: "Later",
          owner_object_id: "film",
          priority: 20,
          region_id: "film:later",
          shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
        },
        {
          enabled: true,
          name: "Earlier",
          owner_object_id: "film",
          priority: 10,
          region_id: "film:earlier",
          shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
        },
      ],
      { theme: "mocha" },
    );

    expect(models.map((model) => model.regionId)).toEqual([
      "film:later",
      "film:earlier",
    ]);
    expect(models.map((model) => model.color)).toEqual([
      "var(--fm-region-overlay-0)",
      "var(--fm-region-overlay-1)",
    ]);
    expect(resolveRegionOverlayColor(7, "latte")).toBe(
      "var(--fm-region-overlay-7)",
    );
    expect(resolveRegionOverlayColor(8, "mocha")).toBe(
      "var(--fm-region-overlay-0)",
    );
  });

  it("scopes overlays to the selected owner object when one is selected", () => {
    const regions = [
      {
        enabled: true,
        name: "Film core",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:core",
        shape: { center: [0, 0, 0], kind: "sphere" as const, radius: 1 },
      },
      {
        enabled: true,
        name: "Reference core",
        owner_object_id: "reference",
        priority: 0,
        region_id: "reference:core",
        shape: { center: [0, 0, 0], kind: "sphere" as const, radius: 1 },
      },
    ];

    expect(
      buildRegionOverlayModels(regions, { selectedObjectId: "film" }).map(
        (model) => model.regionId,
      ),
    ).toEqual(["film:core"]);
    expect(buildRegionOverlayModels(regions).map((model) => model.regionId)).toEqual([
      "film:core",
      "reference:core",
    ]);
  });

  it("preserves owner transform for object-frame authored regions", () => {
    const [model] = buildRegionOverlayModels([
      {
        enabled: true,
        name: "Translated core",
        owner_object_id: "film",
        owner_transform: {
          rotation_quat: [0, 0, 0.70710678118, 0.70710678118],
          scale: [2, 3, 4],
          translation: [10, -4, 2],
        },
        priority: 0,
        region_id: "film:core",
        shape: {
          center: [1, 2, 3],
          kind: "box",
          size: [4, 5, 6],
        },
      },
    ]);

    expect(model).toMatchObject({
      center: [1, 2, 3],
      kind: "box",
      objectId: "film",
      regionId: "film:core",
      transform: {
        position: [10, -4, 2],
        quaternion: [0, 0, 0.70710678118, 0.70710678118],
        scale: [2, 3, 4],
      },
    });
  });

  it("does not inherit owner transform for world-frame regions", () => {
    const [model] = buildRegionOverlayModels([
      {
        enabled: true,
        frame: "world",
        name: "World core",
        owner_object_id: "film",
        owner_transform: {
          scale: [2, 3, 4],
          translation: [10, -4, 2],
        },
        priority: 0,
        region_id: "film:world",
        shape: {
          center: [1, 2, 3],
          kind: "box",
          size: [4, 5, 6],
        },
      },
    ]);

    expect(model).toMatchObject({
      center: [1, 2, 3],
      transform: {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    });
  });

  it("keeps authored and realized diagnostics outline-only", () => {
    expect(resolveRegionOverlayStyle({ enabled: true, selected: false })).toMatchObject({
      wireframeColor: null,
      wireframeOpacity: 0.72,
      wireframeScale: 1.004,
      wireframeVisible: true,
    });
    expect(resolveRegionOverlayStyle({ enabled: true, selected: true })).toMatchObject({
      wireframeOpacity: 1,
      wireframeScale: 1.008,
      wireframeVisible: true,
    });
    expect(resolveRegionOverlayStyle({ enabled: false, selected: true })).toMatchObject({
      wireframeOpacity: 0,
      wireframeScale: 1.008,
      wireframeVisible: false,
    });
  });

  it("drops invalid or unsupported authored shapes", () => {
    const models = buildRegionOverlayModels([
      {
        enabled: true,
        name: "Bad box",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:bad-box",
        shape: { center: [0, 0, 0], kind: "box", size: [1, 0, 1] },
      },
      {
        enabled: true,
        name: "Bad shape",
        owner_object_id: "film",
        priority: 1,
        region_id: "film:bad-shape",
        shape: { center: [0, 0, 0], kind: "torus", radius: 1 } as unknown as components["schemas"]["SceneRegionShape"],
      },
    ]);

    expect(models).toEqual([]);
  });

  it("builds mesh-backed overlay indices from current owner topology", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 2,
      elementMarkers: Uint32Array.from([1, 1]),
      indices: Uint32Array.from([0, 1, 2, 3, 1, 2, 3, 4]),
      nodeCount: 5,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        10, 0, 0,
      ]),
    };

    const models = buildRegionMeshOverlayModels(
      [
        {
          enabled: true,
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
          shape: { center: [0.25, 0.25, 0.25], kind: "sphere", radius: 0.5 },
        },
      ],
      topology,
      [{ element_count: 2, element_start: 0, object_id: "film" }],
    );

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      objectId: "film",
      regionId: "film:core",
      style: {
        wireframeVisible: true,
      },
    });
    expect(Array.from(models[0].surfaceIndices ?? [])).toHaveLength(12);
    expect(Array.from(models[0].edgeIndices ?? [])).toEqual([
      0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3,
    ]);
  });

  it("builds a prism region overlay from canonical CSR when legacy indices are empty", () => {
    const topology = {
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
      indices: new Uint32Array(),
      nodeCount: 6,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        1, 0, 1,
        0, 1, 1,
      ]),
    };

    const [model] = buildRegionMeshOverlayModels(
      [{
        enabled: true,
        mesh_part_ids: ["part:film:prism"],
        name: "Prism",
        owner_object_id: "film",
        region_id: "film:prism",
      }],
      topology,
      [{
        element_count: 1,
        element_start: 0,
        id: "part:film:prism",
        object_id: "film",
      }],
    );

    expect(model?.edgeIndices).toHaveLength(18);
    expect(model?.surfaceIndices).toHaveLength(24);
    const surfaceEdges = Array.from(model?.surfaceEdgeIndices ?? []);
    const surfaceEdgeKeys = new Set(
      Array.from({ length: surfaceEdges.length / 2 }, (_unused, index) =>
        [surfaceEdges[index * 2], surfaceEdges[index * 2 + 1]]
          .toSorted((left, right) => (left ?? 0) - (right ?? 0))
          .join(":"),
      ),
    );
    expect(surfaceEdgeKeys.has("0:4")).toBe(false);
  });

  it("uses realized mesh part ids instead of primitive centroid fallback", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 2,
      elementMarkers: Uint32Array.from([1, 1]),
      indices: Uint32Array.from([0, 1, 2, 3, 1, 2, 3, 4]),
      nodeCount: 5,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        1, 1, 1,
      ]),
    };

    const models = buildRegionMeshOverlayModels(
      [
        {
          enabled: true,
          mesh_part_ids: ["part:film:core"],
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
          shape: { center: [0.5, 0.5, 0.5], kind: "sphere", radius: 2 },
        },
      ],
      topology,
      [
        { element_count: 1, element_start: 0, id: "part:film:core", object_id: "film" },
        { element_count: 1, element_start: 1, id: "film", object_id: "film" },
      ],
    );

    expect(models).toHaveLength(1);
    expect(Array.from(models[0].edgeIndices ?? [])).toEqual([
      0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3,
    ]);
  });

  it("uses mesh-part surface faces for realized region overlay surfaces", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 2,
      elementMarkers: Uint32Array.from([1, 1]),
      indices: Uint32Array.from([0, 1, 2, 3, 1, 2, 3, 4]),
      nodeCount: 5,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        1, 1, 1,
      ]),
    };

    const models = buildRegionMeshOverlayModels(
      [
        {
          enabled: true,
          mesh_part_ids: ["part:film:core"],
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
        },
      ],
      topology,
      [
        {
          element_count: 1,
          element_start: 0,
          id: "part:film:core",
          object_id: "film",
          surface_faces: [[0, 1, 2]],
        },
      ],
    );

    expect(models).toHaveLength(1);
    expect(Array.from(models[0].surfaceIndices ?? [])).toEqual([0, 1, 2]);
  });

  it("keeps rendered mesh-backed region surfaces from drawing a second color overlay", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 1,
      elementMarkers: Uint32Array.from([1]),
      indices: Uint32Array.from([0, 1, 2, 3]),
      nodeCount: 4,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]),
    };

    const [meshBacked] = buildRegionMeshOverlayModels(
      [
        {
          enabled: true,
          mesh_part_ids: ["part:film:core"],
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
        },
      ],
      topology,
      [
        {
          element_count: 1,
          element_start: 0,
          id: "part:film:core",
          object_id: "film",
          surface_faces: [[0, 1, 2]],
        },
      ],
    );

    const [membershipFallback] = buildRegionMeshOverlayModels(
      [
        {
          enabled: true,
          mesh_part_ids: ["membership:film%3Acore"],
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
        },
      ],
      topology,
      [
        {
          element_count: 1,
          element_start: 0,
          id: "membership:film%3Acore",
          object_id: "film",
          surface_faces: [[0, 1, 2]],
        },
      ],
    );

    expect(meshBacked?.style).toMatchObject({
      wireframeVisible: true,
    });
    expect(membershipFallback?.style).toMatchObject({
      wireframeVisible: true,
    });
  });

  it("shares converted topology positions across mesh-backed region overlays", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 2,
      elementMarkers: Uint32Array.from([1, 1]),
      indices: Uint32Array.from([0, 1, 2, 3, 1, 2, 3, 4]),
      nodeCount: 5,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        1, 1, 1,
      ]),
    };

    const regions = [
      {
        enabled: true,
        mesh_part_ids: ["part:film:core"],
        name: "Core",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:core",
      },
      {
        enabled: true,
        mesh_part_ids: ["part:film:edge"],
        name: "Edge",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:edge",
      },
    ];
    const parts = [
      {
        element_count: 1,
        element_start: 0,
        id: "part:film:core",
        object_id: "film",
        surface_faces: [[0, 1, 2]],
      },
      {
        element_count: 1,
        element_start: 1,
        id: "part:film:edge",
        object_id: "film",
        surface_faces: [[1, 2, 4]],
      },
    ];

    const firstModels = buildRegionMeshOverlayModels(regions, topology, parts);
    const secondModels = buildRegionMeshOverlayModels(regions, topology, parts, {
      selectedRegionId: "film:edge",
    });

    expect(firstModels).toHaveLength(2);
    expect(firstModels[0].positions).toBe(firstModels[1].positions);
    expect(secondModels[0].positions).toBe(firstModels[0].positions);
  });

  it("reuses mesh-backed overlay geometry buffers for unchanged topology and regions", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 2,
      elementMarkers: Uint32Array.from([1, 1]),
      indices: Uint32Array.from([0, 1, 2, 3, 1, 2, 3, 4]),
      nodeCount: 5,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        1, 1, 1,
      ]),
    };
    const regions = [
      {
        enabled: true,
        mesh_part_ids: ["part:film:core"],
        name: "Core",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:core",
      },
    ];
    const parts = [
      {
        element_count: 1,
        element_start: 0,
        id: "part:film:core",
        object_id: "film",
        surface_faces: [[0, 1, 2]],
      },
    ];

    const firstModels = buildRegionMeshOverlayModels(regions, topology, parts);
    const secondModels = buildRegionMeshOverlayModels(regions, topology, parts);

    expect(secondModels[0].surfaceIndices).toBe(firstModels[0].surfaceIndices);
    expect(secondModels[0].edgeIndices).toBe(firstModels[0].edgeIndices);
    expect(secondModels[0].surfaceEdgeIndices).toBe(
      firstModels[0].surfaceEdgeIndices,
    );
  });

  it("evicts old mesh-backed overlay geometry cache entries", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 1,
      elementMarkers: Uint32Array.from([1]),
      indices: Uint32Array.from([0, 1, 2, 3]),
      nodeCount: 4,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]),
    };
    const part = {
      element_count: 1,
      element_start: 0,
      id: "part:film:core",
      object_id: "film",
      surface_faces: [[0, 1, 2]],
    };
    const regionFor = (index: number) => ({
      enabled: true,
      mesh_part_ids: ["part:film:core"],
      name: `Core ${index}`,
      owner_object_id: "film",
      priority: index,
      region_id: `film:core:${index}`,
    });

    const first = buildRegionMeshOverlayModels([regionFor(0)], topology, [part]);
    const firstSurfaceIndices = first[0].surfaceIndices;

    for (let index = 1; index <= 20; index += 1) {
      buildRegionMeshOverlayModels([regionFor(index)], topology, [part]);
    }

    const rebuilt = buildRegionMeshOverlayModels([regionFor(0)], topology, [part]);

    expect(rebuilt[0].surfaceIndices).not.toBe(firstSurfaceIndices);
    expect(Array.from(rebuilt[0].surfaceIndices ?? [])).toEqual(
      Array.from(firstSurfaceIndices ?? []),
    );
  });

  it("keeps mesh-backed overlays scoped to the owner object and region settings", () => {
    const topology = {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 2,
      elementMarkers: Uint32Array.from([1, 1]),
      indices: Uint32Array.from([0, 1, 2, 3, 1, 2, 3, 4]),
      nodeCount: 5,
      positions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        10, 0, 0,
      ]),
    };

    const models = buildRegionMeshOverlayModels(
      [
        {
          enabled: true,
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
          shape: { center: [0.25, 0.25, 0.25], kind: "sphere", radius: 0.5 },
        },
      ],
      topology,
      [{ element_count: 2, element_start: 0, object_id: "other-film" }],
    );

    expect(models).toEqual([]);

    const [surfaceOnly] = buildRegionMeshOverlayModels(
      [
        {
          enabled: true,
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
          shape: { center: [0.25, 0.25, 0.25], kind: "sphere", radius: 0.5 },
        },
      ],
      topology,
      [{ element_count: 2, element_start: 0, object_id: "film" }],
    );

    expect(surfaceOnly?.style).toMatchObject({
      wireframeVisible: true,
    });
  });
});
