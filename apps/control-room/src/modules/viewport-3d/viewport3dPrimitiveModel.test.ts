import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MeshSharedDomainManifestResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  buildViewport3DMagnetizationTexturePreviewMap,
  buildViewport3DPrimitiveFrameKey,
  buildViewport3DPrimitiveRenderModel,
  resolvePrimitiveSelectionBounds,
} from "./viewport3dPrimitiveModel";

const viewport3dPrimitiveModelSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/viewport3dPrimitiveModel.ts"),
  "utf8",
);

describe("viewport3dPrimitiveModel", () => {
  it("never creates a parallel primitive or pick target for synthetic __air__", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        revision: 1,
        objects: [
          {
            id: "__air__",
            name: "Synthetic air",
            geometry: { geometry_kind: "box", size: [10, 10, 10] },
          },
          {
            id: "__airbox__",
            name: "Legacy synthetic airbox",
            geometry: { geometry_kind: "box", size: [10, 10, 10] },
          },
          {
            id: "compat-air",
            name: "Legacy Airbox",
            role: "airbox",
            geometry: { geometry_kind: "box", size: [10, 10, 10] },
          },
          {
            id: "film",
            name: "Film",
            geometry: { geometry_kind: "box", size: [1, 1, 1] },
          },
        ],
      } as never,
      null,
    );

    expect(model.objects.map((object) => object.objectId)).toEqual(["film"]);
  });

  it("keeps JSON stringify out of primitive geometry key generation", () => {
    expect(viewport3dPrimitiveModelSource).not.toContain("JSON.stringify");
  });

  it("builds primitive-only entries from SceneDocument without topology", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [1, 2, 3] },
            },
            id: "box",
            name: "Box",
            transform: { translation: [4, 5, 6] },
          },
        ],
        revision: 7,
      },
      null,
    );

    expect(model.objects).toHaveLength(1);
    expect(model.objects[0]).toMatchObject({
      fallbackLabel: "primitive",
      geometryKey:
        "box:Box:{\"size\":[1,2,3]}:{\"translation\":[4,5,6]}",
      kind: "box",
      label: "Box",
      meshState: "primitive-only",
      objectId: "box",
      sceneRevision: 7,
    });
    expect(model.objects[0]?.bounds.center).toEqual([4, 5, 6]);
    expect(model.objects[0]?.bounds.size).toEqual([1, 2, 3]);
    expect(buildViewport3DPrimitiveFrameKey(model)).toBe(
      "7|box:Box:{\"size\":[1,2,3]}:{\"translation\":[4,5,6]}",
    );
  });

  it("changes primitive frame keys when primitive geometry changes", () => {
    const first = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [1, 1, 1] },
            },
            id: "box",
          },
        ],
        revision: 7,
      },
      null,
    );
    const second = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [2, 1, 1] },
            },
            id: "box",
          },
        ],
        revision: 8,
      },
      null,
    );

    expect(buildViewport3DPrimitiveFrameKey(first)).not.toBe(
      buildViewport3DPrimitiveFrameKey(second),
    );
  });

  it("preserves Box-Cylinder Difference semantics for primitive CSG preview", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              geometry_kind: "Difference",
              geometry_params: {
                base: {
                  geometry_kind: "Box",
                  geometry_params: { size: [300e-9, 1000e-9, 30e-9] },
                },
                tool: {
                  geometry_kind: "Cylinder",
                  geometry_params: {
                    height: 30e-9,
                    radius: 30e-9,
                  },
                },
              },
            },
            id: "permalloy_box",
            name: "Permalloy box",
          },
        ],
        revision: 8,
      },
      null,
    );

    expect(model.objects[0]).toMatchObject({
      bounds: {
        size: [300e-9, 1000e-9, 30e-9],
      },
      csgPreview: {
        boxSize: [300e-9, 1000e-9, 30e-9],
        cylinderAxis: [0, 0, 1],
        cylinderCenter: [0, 0, 0],
        cylinderHeight: 30e-9,
        cylinderRadius: 30e-9,
        kind: "box-cylinder-difference",
      },
      kind: "box-cylinder-difference",
    });
  });

  it("shows primitive CSG fallback when a previous mesh predates the current scene", () => {
    const manifest: MeshSharedDomainManifestResource = {
      mesh_id: "mesh-1",
      mesh_name: "Mesh",
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part-box",
          label: "Box",
          node_count: 0,
          node_start: 0,
          object_id: "permalloy_box",
          role: "magnetic",
        },
      ],
      revision: 2,
      source_scene_revision: 7,
      topology_fingerprint: "mesh-topology-hash",
    };

    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              geometry_kind: "Difference",
              geometry_params: {
                base: {
                  geometry_kind: "Box",
                  geometry_params: { size: [300e-9, 1000e-9, 30e-9] },
                },
                tool: {
                  geometry_kind: "Cylinder",
                  geometry_params: {
                    height: 30e-9,
                    radius: 30e-9,
                  },
                },
              },
            },
            id: "permalloy_box",
            name: "Permalloy box",
          },
        ],
        revision: 8,
      },
      manifest,
    );

    expect(model.objects[0]).toMatchObject({
      fallbackLabel: "stale primitive",
      kind: "box-cylinder-difference",
      meshState: "mesh-stale",
    });
  });

  it("attaches committed magnetization texture preview metadata", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        magnetization_assets: [
          {
            id: "mag-vortex",
            kind: "preset_texture",
            preset_kind: "vortex",
            ui_label: "Vortex",
          },
        ],
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [1, 1, 1] },
            },
            id: "box",
            magnetization_ref: "mag-vortex",
            name: "Box",
          },
        ],
        revision: 7,
      },
      null,
    );

    expect(model.objects[0]?.magnetizationTexturePreview).toEqual({
      assetId: "mag-vortex",
      color: "#27c4e8",
      label: "Vortex",
      presetKind: "vortex",
      source: "object",
    });
  });

  it("attaches texture pivot metadata for v2 pivot gizmo layers", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        magnetization_assets: [
          {
            id: "mag-vortex",
            kind: "preset_texture",
            preset_kind: "vortex",
            texture_transform: { pivot: [1e-9, 2e-9, 3e-9] },
          },
        ],
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [1, 1, 1] },
            },
            id: "box",
            magnetization_ref: "mag-vortex",
            name: "Box",
          },
        ],
        revision: 7,
      },
      null,
    );

    expect(model.objects[0]?.magnetizationTexturePreview).toMatchObject({
      assetId: "mag-vortex",
      pivot: [1e-9, 2e-9, 3e-9],
    });
  });

  it("colors uniform +Z magnetization preview as HSL orientation white", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        magnetization_assets: [
          {
            id: "mag-uniform-z",
            kind: "preset_texture",
            preset_kind: "uniform",
            preset_params: { direction: [0, 0, 1] },
            ui_label: "Out-of-plane",
          },
        ],
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [1, 1, 1] },
            },
            id: "arch_waveguide",
            magnetization_ref: "mag-uniform-z",
            name: "Arch waveguide",
          },
        ],
        revision: 8,
      },
      null,
    );

    expect(model.objects[0]?.magnetizationTexturePreview).toMatchObject({
      color: "#ffffff",
      presetKind: "uniform",
    });
  });

  it("colors uniform +X magnetization preview as the same full-bright HSL red", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        magnetization_assets: [
          {
            id: "mag-uniform-x",
            kind: "preset_texture",
            preset_kind: "uniform",
            preset_params: { direction: [1, 0, 0] },
            ui_label: "In-plane",
          },
        ],
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [1, 1, 1] },
            },
            id: "arch_waveguide",
            magnetization_ref: "mag-uniform-x",
            name: "Arch waveguide",
          },
        ],
        revision: 9,
      },
      null,
    );

    expect(model.objects[0]?.magnetizationTexturePreview).toMatchObject({
      color: "#ff0000",
      presetKind: "uniform",
    });
  });

  it("prefers region override magnetization texture metadata for preview", () => {
    const scene = {
      magnetization_assets: [
        {
          id: "mag-object",
          kind: "preset_texture",
          preset_kind: "uniform",
          ui_label: "Uniform object",
        },
        {
          id: "mag-region",
          kind: "preset_texture",
          preset_kind: "random_seeded",
          ui_label: "Random region",
        },
      ],
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1, 1, 1] },
          },
          id: "box",
          magnetization_ref: "mag-object",
          name: "Box",
          region_overrides: {
            "region:box": { magnetization_ref: "mag-region" },
          },
        },
      ],
      revision: 7,
    };

    const model = buildViewport3DPrimitiveRenderModel(scene, null);
    const previewMap = buildViewport3DMagnetizationTexturePreviewMap(scene);

    expect(model.objects[0]?.magnetizationTexturePreview).toMatchObject({
      assetId: "mag-region",
      color: "#43d17a",
      label: "Random region",
      presetKind: "random_seeded",
      regionId: "region:box",
      source: "region-override",
    });
    expect(previewMap.get("box")).toMatchObject({
      assetId: "mag-region",
      source: "region-override",
    });
  });

  it("marks previous object mesh as stale when the object geometry is dirty", () => {
    const manifest: MeshSharedDomainManifestResource = {
      mesh_id: "mesh-1",
      mesh_name: "Mesh",
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part-box",
          label: "Box",
          node_count: 0,
          node_start: 0,
          object_id: "box",
          role: "magnetic",
        },
      ],
      revision: 2,
      source_scene_revision: 6,
      topology_fingerprint: "mesh-topology-hash",
    };

    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              bounds_max: [1, 1, 1],
              bounds_min: [-1, -1, -1],
              geometry_kind: "Sphere",
            },
            id: "box",
            name: "Box",
            tags: ["mesh:dirty"],
          },
        ],
        revision: 7,
      },
      manifest,
    );

    expect(model.objects[0]?.meshState).toBe("mesh-stale");
    expect(model.objects[0]?.fallbackLabel).toBe("stale primitive");
  });

  it("suppresses primitive fallback when only non-mesh scene state changed", () => {
    const manifest: MeshSharedDomainManifestResource = {
      mesh_id: "mesh-1",
      mesh_name: "Mesh",
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part-box",
          label: "Box",
          node_count: 0,
          node_start: 0,
          object_id: "box",
          role: "magnetic",
        },
      ],
      revision: 2,
      source_scene_revision: 6,
      topology_fingerprint: "mesh-topology-hash",
    };

    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              bounds_max: [1, 1, 1],
              bounds_min: [-1, -1, -1],
              geometry_kind: "Sphere",
            },
            id: "box",
            magnetization_ref: "updated-texture",
            name: "Box",
          },
        ],
        revision: 7,
      },
      manifest,
    );

    expect(model.objects).toHaveLength(1);
    expect(model.objects[0]?.meshState).toBe("mesh-ready");
  });

  it("suppresses primitive fallback when mesh manifest maps the geometry id", () => {
    const manifest: MeshSharedDomainManifestResource = {
      mesh_id: "mesh-1",
      mesh_name: "Mesh",
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          geometry_id: "box_geom",
          id: "part-box",
          label: "Box",
          node_count: 0,
          node_start: 0,
          role: "magnetic",
        },
      ],
      revision: 2,
      source_scene_revision: 7,
      topology_fingerprint: "mesh-topology-hash",
    };

    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [1, 1, 1] },
            },
            id: "box",
            name: "Box",
          },
        ],
        revision: 7,
      },
      manifest,
    );

    expect(model.objects).toHaveLength(1);
    expect(model.objects[0]?.meshState).toBe("mesh-ready");
  });

  it("suppresses primitive fallback when object topology matches scene revision", () => {
    const manifest: MeshSharedDomainManifestResource = {
      mesh_id: "mesh-1",
      mesh_name: "Mesh",
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part-box",
          label: "Box",
          node_count: 0,
          node_start: 0,
          object_id: "box",
          role: "magnetic",
        },
      ],
      revision: 2,
      source_scene_revision: 7,
      topology_fingerprint: "mesh-topology-hash",
    };

    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: { geometry_kind: "Box", geometry_params: { size: [1, 1, 1] } },
            id: "box",
            name: "Box",
          },
        ],
        revision: 7,
      },
      manifest,
    );

    expect(model.objects).toHaveLength(1);
    expect(model.objects[0]?.meshState).toBe("mesh-ready");
  });

  it("suppresses primitive fallback when object has mesh:ready tag even if revision is stale", () => {
    const manifest: MeshSharedDomainManifestResource = {
      mesh_id: "mesh-1",
      mesh_name: "Mesh",
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part-box",
          label: "Box",
          node_count: 0,
          node_start: 0,
          object_id: "box",
          role: "magnetic",
        },
      ],
      revision: 2,
      source_scene_revision: 6,
      topology_fingerprint: "mesh-topology-hash",
    };

    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: { geometry_kind: "Box", geometry_params: { size: [1, 1, 1] } },
            id: "box",
            name: "Box",
            tags: ["mesh:ready"],
          },
        ],
        revision: 7,
      },
      manifest,
    );

    expect(model.objects).toHaveLength(1);
    expect(model.objects[0]?.meshState).toBe("mesh-ready");
  });

  it("keeps unchanged primitive geometry keys stable across unrelated scene revisions", () => {
    const first = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: { geometry_kind: "Box", geometry_params: { size: [1, 1, 1] } },
            id: "box-a",
            name: "Box A",
          },
          {
            geometry: { geometry_kind: "Box", geometry_params: { size: [1, 1, 1] } },
            id: "box-b",
            name: "Box B",
          },
        ],
        revision: 7,
      },
      null,
    );
    const second = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: { geometry_kind: "Box", geometry_params: { size: [1, 1, 1] } },
            id: "box-a",
            name: "Box A",
          },
          {
            geometry: { geometry_kind: "Box", geometry_params: { size: [2, 1, 1] } },
            id: "box-b",
            name: "Box B",
          },
        ],
        revision: 8,
      },
      null,
    );

    expect(second.objects.find((object) => object.objectId === "box-a")?.geometryKey)
      .toBe(first.objects.find((object) => object.objectId === "box-a")?.geometryKey);
    expect(second.objects.find((object) => object.objectId === "box-b")?.geometryKey)
      .not.toBe(first.objects.find((object) => object.objectId === "box-b")?.geometryKey);
  });

  it("resolves primitive bounds for scene-object selection", () => {
    const model = buildViewport3DPrimitiveRenderModel(
      {
        objects: [
          {
            geometry: { geometry_kind: "Box", geometry_params: { size: [2, 2, 2] } },
            id: "box",
            name: "Box",
          },
        ],
        revision: 7,
      },
      null,
    );
    const selection: Selection = {
      kind: "object.root",
      label: "Box",
      moduleSource: "test",
      nodeId: "model:object:box",
      objectId: "box",
      ref: {
        kind: "object.root",
        nodeId: "model:object:box",
        objectId: "box",
        type: "scene-object",
        visualizationTargetId: "object:box",
      },
    };

    expect(resolvePrimitiveSelectionBounds(selection, model)?.size).toEqual([
      2, 2, 2,
    ]);
  });
});
