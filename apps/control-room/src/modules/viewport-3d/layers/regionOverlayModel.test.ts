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
        fillOpacity: 0.14,
        fillVisible: true,
        wireframeOpacity: 0,
        wireframeScale: 1.004,
        wireframeVisible: false,
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

  it("uses selected and disabled opacity states", () => {
    expect(resolveRegionOverlayStyle({ enabled: true, selected: false })).toMatchObject({
      fillOpacity: 0.14,
      fillVisible: true,
      wireframeOpacity: 0,
      wireframeScale: 1.004,
      wireframeVisible: false,
    });
    expect(resolveRegionOverlayStyle({ enabled: true, selected: true })).toMatchObject({
      fillOpacity: 1,
      fillVisible: true,
      wireframeOpacity: 0,
      wireframeScale: 1.008,
      wireframeVisible: false,
    });
    expect(resolveRegionOverlayStyle({ enabled: false, selected: true })).toMatchObject({
      fillOpacity: 0,
      fillVisible: false,
      wireframeOpacity: 0,
      wireframeScale: 1.008,
      wireframeVisible: false,
    });
  });

  it("uses opaque fill defaults for realized mesh-backed region surfaces", () => {
    expect(
      resolveRegionOverlayStyle({
        enabled: true,
        realizedSurface: true,
        selected: false,
      }),
    ).toMatchObject({
      fillOpacity: 1,
      fillVisible: true,
      wireframeOpacity: 0,
      wireframeVisible: false,
    });
    expect(
      resolveRegionOverlayStyle({
        enabled: true,
        realizedSurface: true,
        selected: false,
        settings: {
          opacityPercent: 40,
          shaderVisible: true,
          visible: true,
        } as never,
      }),
    ).toMatchObject({
      fillOpacity: 0.4,
      fillVisible: true,
    });
  });

  it("uses solid mono color only when the region surface source is solid", () => {
    expect(
      resolveRegionOverlayStyle({
        enabled: true,
        selected: false,
        settings: {
          shaderMonoColor: "#123456",
          surfaceColorSource: "orientation",
        } as never,
      }),
    ).toMatchObject({ surfaceColor: null });
    expect(
      resolveRegionOverlayStyle({
        enabled: true,
        selected: false,
        settings: {
          shaderMonoColor: "#123456",
          surfaceColorSource: "solid",
        } as never,
      }),
    ).toMatchObject({ surfaceColor: "#123456" });
  });

  it("applies per-region visualization target settings to authored overlays", () => {
    const [surfaceOnly] = buildRegionOverlayModels(
      [
        {
          enabled: true,
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
          shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
        },
      ],
      {
        resolveSettings: () =>
          ({
            opacityPercent: 50,
            shaderMonoColor: "#123456",
            shaderVisible: true,
            surfaceColorSource: "solid",
            visible: true,
            wireframeColor: "#abcdef",
            wireframeOpacityPercent: 80,
            wireframeVisible: false,
          }) as never,
      },
    );

    expect(surfaceOnly).toMatchObject({
      style: {
        fillOpacity: 0.07,
        fillVisible: true,
        surfaceColor: "#123456",
        wireframeOpacity: 0,
        wireframeVisible: false,
        wireframeColor: "#abcdef",
      },
    });
    expect(
      resolveRegionOverlayStyle({
        enabled: true,
        selected: true,
        settings: {
          opacityPercent: 40,
          shaderVisible: true,
          visible: true,
          wireframeVisible: true,
        } as never,
      }),
    ).toMatchObject({
      fillOpacity: 1,
      fillVisible: true,
    });
    expect(
      resolveRegionOverlayStyle({
        enabled: true,
        selected: false,
        settings: {
          shaderVisible: false,
          visible: true,
          wireframeVisible: true,
        } as never,
      }),
    ).toMatchObject({
      fillOpacity: 0,
      fillVisible: false,
      wireframeOpacity: 0.72,
      wireframeVisible: true,
    });

    expect(
      buildRegionOverlayModels(
        [
          {
            enabled: true,
            name: "Core",
            owner_object_id: "film",
            priority: 0,
            region_id: "film:core",
            shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
          },
        ],
        {
          resolveSettings: () =>
            ({
              shaderVisible: true,
              visible: false,
              wireframeVisible: true,
            }) as never,
        },
      ),
    ).toEqual([]);
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
        fillVisible: true,
        wireframeVisible: false,
      },
    });
    expect(Array.from(models[0].surfaceIndices ?? [])).toHaveLength(12);
    expect(Array.from(models[0].edgeIndices ?? [])).toEqual([
      0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3,
    ]);
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
      {
        renderedSurfacePartIds: new Set(["part:film:core"]),
      },
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
      {
        renderedSurfacePartIds: new Set(["part:film:core"]),
      },
    );

    expect(meshBacked?.style.fillVisible).toBe(true);
    expect(meshBacked?.surfaceOverlayVisible).toBe(false);
    expect(membershipFallback?.style.fillVisible).toBe(true);
    expect(membershipFallback?.surfaceOverlayVisible).toBe(true);
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
      {
        resolveSettings: () =>
          ({
            shaderVisible: true,
            visible: true,
            wireframeVisible: false,
          }) as never,
      },
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
      {
        resolveSettings: () =>
          ({
            shaderVisible: true,
            visible: true,
            wireframeVisible: false,
          }) as never,
      },
    );

    expect(surfaceOnly?.style).toMatchObject({
      fillVisible: true,
      wireframeVisible: false,
    });
  });
});
