import type { SceneDocument, MagnetizationAsset } from "./types";
import { MAGNETIC_PRESET_CATALOG, METRIC_ANALYTIC_PRESETS, type MagneticPresetDescriptor } from "../magnetizationPresetCatalog";
import { fitPresetParamsToBounds } from "../textureTransform";

function cloneSceneDocument(scene: SceneDocument): SceneDocument {
  // structuredClone is safe here as SceneDocument is pure JSON-serializable data
  return structuredClone(scene);
}

export function patchMagnetizationAsset(
  scene: SceneDocument,
  assetId: string,
  patch: Partial<MagnetizationAsset>
): SceneDocument {
  const nextScene = cloneSceneDocument(scene);
  const index = nextScene.magnetization_assets.findIndex((a) => a.id === assetId);
  if (index !== -1) {
    nextScene.magnetization_assets[index] = {
      ...nextScene.magnetization_assets[index],
      ...patch,
    };
  }
  return nextScene;
}

export function assignMagneticPreset(
  scene: SceneDocument,
  assetId: string,
  descriptor: MagneticPresetDescriptor,
  options?: {
    objectId?: string;
    fitToObjectOnFirstAssign?: boolean;
  },
): SceneDocument {
  const existing = scene.magnetization_assets.find((asset) => asset.id === assetId);
  let next = patchMagnetizationAsset(scene, assetId, {
    kind: "preset_texture",
    value: null,
    seed: null,
    source_path: null,
    source_format: null,
    dataset: null,
    sample_index: null,
    preset_kind: descriptor.kind,
    preset_params: descriptor.defaultParams ? structuredClone(descriptor.defaultParams) : {},
    preset_version: 1,
    mapping: existing?.mapping ?? {
      space: "object",
      projection: "object_local",
      clamp_mode: "none",
    },
    texture_transform: existing?.texture_transform ?? {
      translation: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
    },
    ui_label: descriptor.label,
  });

  const shouldFit =
    options?.fitToObjectOnFirstAssign !== false &&
    Boolean(options?.objectId) &&
    descriptor.kind !== "uniform" &&
    (!existing ||
      existing.kind !== "preset_texture" ||
      existing.preset_kind !== descriptor.kind);
  if (shouldFit) {
    next = fitTextureToObject(next, options!.objectId!, assetId);
  }
  return next;
}

export function resetMagneticPresetParams(
  scene: SceneDocument,
  assetId: string
): SceneDocument {
  const asset = scene.magnetization_assets.find((a) => a.id === assetId);
  if (!asset || !asset.preset_kind) return scene;

  const descriptor = MAGNETIC_PRESET_CATALOG.find((d) => d.kind === asset.preset_kind);
  if (!descriptor) return scene;

  return patchMagnetizationAsset(scene, assetId, {
    preset_params: descriptor.defaultParams ? structuredClone(descriptor.defaultParams) : {},
  });
}

export function resetTextureTransform(
  scene: SceneDocument,
  assetId: string
): SceneDocument {
  return patchMagnetizationAsset(scene, assetId, {
    texture_transform: {
      translation: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
    },
  });
}

export function fitTextureToObject(
  scene: SceneDocument,
  objectId: string,
  assetId: string
): SceneDocument {
  const object = scene.objects.find((o) => o.id === objectId);
  if (!object) return scene;

  const boundsMin = object.geometry.bounds_min;
  const boundsMax = object.geometry.bounds_max;

  if (!boundsMin || !boundsMax) {
    return scene; // No bounds available to fit to
  }

  const asset = scene.magnetization_assets.find((a) => a.id === assetId);
  const presetKind = asset?.preset_kind ?? "";

  // For metric analytic presets, fit *preset parameters* to geometry instead
  // of scaling the coordinate system (which breaks physical dimensions).
  if (presetKind && METRIC_ANALYTIC_PRESETS.has(presetKind)) {
    const currentParams = asset?.preset_params ?? {};
    const { params: fittedParams, transform } = fitPresetParamsToBounds(
      presetKind,
      currentParams,
      boundsMin as [number, number, number],
      boundsMax as [number, number, number],
    );
    return patchMagnetizationAsset(scene, assetId, {
      preset_params: fittedParams,
      texture_transform: transform,
    });
  }

  // For non-metric presets, use the classic bounds-extent fit.
  const cx = (boundsMin[0] + boundsMax[0]) / 2;
  const cy = (boundsMin[1] + boundsMax[1]) / 2;
  const cz = (boundsMin[2] + boundsMax[2]) / 2;

  const ex = Math.abs(boundsMax[0] - boundsMin[0]);
  const ey = Math.abs(boundsMax[1] - boundsMin[1]);
  const ez = Math.abs(boundsMax[2] - boundsMin[2]);

  return patchMagnetizationAsset(scene, assetId, {
    texture_transform: {
      translation: [cx, cy, cz],
      rotation_quat: [0, 0, 0, 1],
      scale: [ex, ey, ez],
      pivot: [0, 0, 0],
    },
  });
}
