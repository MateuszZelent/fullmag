import type { MagnetizationAsset, TextureTransform3D } from "./session/types";
import { MAGNETIC_PRESET_CATALOG } from "./magnetizationPresetCatalog";

const IDENTITY_ROTATION: [number, number, number, number] = [0, 0, 0, 1];
const ZERO_VECTOR: [number, number, number] = [0, 0, 0];
const ONE_VECTOR: [number, number, number] = [1, 1, 1];

function arraysEqual(a: number[], b: number[], epsilon = 1e-6): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, i) => Math.abs(val - b[i]!) < epsilon);
}

export function isTextureTransformIdentity(transform: TextureTransform3D): boolean {
  return (
    arraysEqual(transform.translation, ZERO_VECTOR) &&
    arraysEqual(transform.rotation_quat, IDENTITY_ROTATION) &&
    arraysEqual(transform.scale, ONE_VECTOR)
  );
}

export function isPresetParamAtDefault(
  presetKind: string,
  key: string,
  currentValue: unknown
): boolean {
  const descriptor = MAGNETIC_PRESET_CATALOG.find((d) => d.kind === presetKind);
  if (!descriptor || !descriptor.defaultParams) return true;

  const defaultValue = descriptor.defaultParams[key];

  if (Array.isArray(currentValue) && Array.isArray(defaultValue)) {
    return arraysEqual(currentValue as number[], defaultValue as number[]);
  }

  return currentValue === defaultValue;
}

export function isPresetModified(asset: MagnetizationAsset): {
  paramsModified: boolean;
  transformModified: boolean;
  totalModified: boolean;
} {
  const transformModified = !isTextureTransformIdentity(asset.texture_transform);
  let paramsModified = false;

  if (asset.preset_kind && asset.preset_params) {
    const keys = Object.keys(asset.preset_params);
    for (const key of keys) {
      if (!isPresetParamAtDefault(asset.preset_kind, key, asset.preset_params[key])) {
        paramsModified = true;
        break;
      }
    }
  }

  return {
    paramsModified,
    transformModified,
    totalModified: paramsModified || transformModified,
  };
}
