import { hasUnsyncedSceneMagnetization } from "@/components/panels/settings/materialPanelMagnetization";
import type { SceneDocument } from "@/lib/session/types";

export function mergeProjectedSceneIntoDraft(args: {
  previousScene: SceneDocument | null;
  projectedScene: SceneDocument;
  remoteScene: SceneDocument | null;
}): SceneDocument {
  const { previousScene, projectedScene, remoteScene } = args;
  if (!previousScene) {
    return projectedScene;
  }

  const magnetizationDirty = hasUnsyncedSceneMagnetization({
    localScene: previousScene,
    remoteScene,
  });

  return {
    ...projectedScene,
    scene: previousScene.scene,
    outputs: previousScene.outputs,
    editor: previousScene.editor,
    objects: projectedScene.objects.map((object) => {
      const existing = previousScene.objects.find(
        (candidate) => candidate.id === object.id || candidate.name === object.name,
      );
      if (!existing) {
        return object;
      }
      return {
        ...existing,
        id: object.id,
        name: object.name,
        geometry: object.geometry,
        transform: {
          ...existing.transform,
          translation: object.transform.translation,
        },
        material_ref: object.material_ref,
        region_name: object.region_name,
        magnetization_ref: object.magnetization_ref,
        physics_stack: object.physics_stack,
        mesh_override: object.mesh_override,
      };
    }),
    materials: projectedScene.materials.map((material) => {
      const existing = previousScene.materials.find(
        (candidate) => candidate.id === material.id,
      );
      return existing
        ? {
            ...existing,
            id: material.id,
            properties: material.properties,
          }
        : material;
    }),
    magnetization_assets: magnetizationDirty
      ? previousScene.magnetization_assets
      : projectedScene.magnetization_assets.map((asset) => {
          const existing = previousScene.magnetization_assets.find(
            (candidate) => candidate.id === asset.id,
          );
          if (!existing) {
            return asset;
          }
          const samePreset =
            existing.kind === asset.kind &&
            existing.preset_kind === asset.preset_kind;
          return {
            ...asset,
            id: asset.id,
            mapping: samePreset ? existing.mapping : asset.mapping,
            texture_transform: samePreset
              ? existing.texture_transform
              : asset.texture_transform,
          };
        }),
  };
}
