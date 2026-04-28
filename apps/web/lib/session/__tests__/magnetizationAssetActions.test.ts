import { describe, expect, it } from "vitest";

import { assignMagneticPreset } from "../magnetizationAssetActions";
import type { SceneDocument } from "../types";

function makeSceneDocument(): SceneDocument {
  return {
    version: "scene.v1",
    revision: 1,
    scene: {
      id: "scene",
      name: "Scene",
      source_of_truth: "repo_head",
      authoring_schema: "mesh-first-fem.v1",
    },
    universe: null,
    objects: [
      {
        id: "obj1",
        name: "obj1",
        geometry: {
          geometry_kind: "Cylinder",
          geometry_params: { radius: 10, height: 4 },
          bounds_min: [40, -10, -2],
          bounds_max: [60, 10, 2],
        },
        transform: {
          translation: [50, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          pivot: [0, 0, 0],
        },
        material_ref: "mat:obj1",
        region_name: null,
        magnetization_ref: "mag:obj1",
        object_mesh: null,
        mesh_override: null,
        visible: true,
        locked: false,
        tags: [],
      },
    ],
    materials: [],
    magnetization_assets: [
      {
        id: "mag:obj1",
        name: "obj1 magnetization",
        kind: "preset_texture",
        value: null,
        seed: null,
        source_path: null,
        source_format: null,
        dataset: null,
        sample_index: null,
        mapping: {
          space: "object",
          projection: "object_local",
          clamp_mode: "none",
        },
        texture_transform: {
          translation: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          pivot: [0, 0, 0],
        },
        preset_kind: "uniform",
        preset_params: { direction: [1, 0, 0] },
        preset_version: 1,
        ui_label: "Uniform",
      },
    ],
    current_modules: { modules: [], excitation_analysis: null },
    study: null,
    outputs: { items: [] },
    editor: {
      selected_object_id: null,
      gizmo_mode: null,
      transform_space: null,
      selected_entity_id: null,
      active_transform_scope: null,
    },
  } as SceneDocument;
}

describe("assignMagneticPreset", () => {
  it("fits a metric preset into object-local texture space for translated objects", () => {
    const scene = makeSceneDocument();

    const next = assignMagneticPreset(
      scene,
      "mag:obj1",
      { kind: "vortex", label: "Vortex", description: "", defaultParams: { plane: "xy" } },
      { objectId: "obj1" },
    );

    const asset = next.magnetization_assets[0]!;
    expect(asset.mapping.space).toBe("object");
    expect(asset.texture_transform.translation[0]).toBeCloseTo(0, 12);
    expect(asset.texture_transform.translation[1]).toBeCloseTo(0, 12);
    expect(asset.texture_transform.translation[2]).toBeCloseTo(0, 12);
    expect(asset.texture_transform.scale).toEqual([1, 1, 1]);
    expect(Number(asset.preset_params?.core_radius)).toBeCloseTo(2.4, 12);
  });

  it("fits a non-metric preset into object-local texture space for translated objects", () => {
    const scene = makeSceneDocument();

    const next = assignMagneticPreset(
      scene,
      "mag:obj1",
      {
        kind: "helical",
        label: "Helical",
        description: "",
        defaultParams: { wavevector: [1, 0, 0], e1: [1, 0, 0], e2: [0, 1, 0], phase_rad: 0 },
      },
      { objectId: "obj1" },
    );

    const asset = next.magnetization_assets[0]!;
    expect(asset.mapping.space).toBe("object");
    expect(asset.texture_transform.translation).toEqual([0, 0, 0]);
    expect(asset.texture_transform.scale).toEqual([20, 20, 4]);
  });
});
