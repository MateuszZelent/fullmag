import { describe, expect, it } from "vitest";

import { mergeProjectedSceneIntoDraft } from "../sceneDraftProjectionMerge";
import type { MagnetizationAsset, SceneDocument } from "@/lib/session/types";

function magnetizationAsset(presetKind: "uniform" | "vortex"): MagnetizationAsset {
  return {
    id: "mag:free",
    name: "free magnetization",
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
    preset_kind: presetKind,
    preset_params: presetKind === "uniform" ? { direction: [1, 0, 0] } : { plane: "xy" },
    preset_version: 1,
    ui_label: presetKind,
  };
}

function sceneWithMagnetization(asset: MagnetizationAsset): SceneDocument {
  return {
    scene: { id: "scene:1" },
    objects: [
      {
        id: "free",
        name: "free",
        magnetization_ref: asset.id,
        transform: { translation: [0, 0, 0] },
      },
    ],
    materials: [],
    magnetization_assets: [asset],
    outputs: [],
    editor: {
      selected_object_id: null,
    },
    study: {},
  } as unknown as SceneDocument;
}

describe("mergeProjectedSceneIntoDraft", () => {
  it("preserves dirty local magnetization assets over projected remote graph state", () => {
    const localVortex = sceneWithMagnetization(magnetizationAsset("vortex"));
    const remoteUniform = sceneWithMagnetization(magnetizationAsset("uniform"));

    const merged = mergeProjectedSceneIntoDraft({
      previousScene: localVortex,
      projectedScene: remoteUniform,
      remoteScene: remoteUniform,
    });

    expect(merged.magnetization_assets[0]?.preset_kind).toBe("vortex");
  });

  it("accepts projected magnetization when the local draft is not dirty", () => {
    const localUniform = sceneWithMagnetization(magnetizationAsset("uniform"));
    const projectedVortex = sceneWithMagnetization(magnetizationAsset("vortex"));

    const merged = mergeProjectedSceneIntoDraft({
      previousScene: localUniform,
      projectedScene: projectedVortex,
      remoteScene: localUniform,
    });

    expect(merged.magnetization_assets[0]?.preset_kind).toBe("vortex");
  });
});
