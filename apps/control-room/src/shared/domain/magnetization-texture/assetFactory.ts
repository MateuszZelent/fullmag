import type { JsonObject } from "@/kernel/api/apiTypes";

import type { MagnetizationTexturePresetId } from "./texturePresets";
import type { MagnetizationTextureTarget } from "./types";

export interface PresetMagnetizationAssetInput {
  id: string;
  label?: string | null;
  mapping?: JsonObject | null;
  presetKind: MagnetizationTexturePresetId;
  presetParams: JsonObject;
  textureTransform?: JsonObject | null;
}

export function magnetizationTextureAssetId(
  target: MagnetizationTextureTarget,
  presetKind: MagnetizationTexturePresetId,
): string {
  return target.kind === "region"
    ? `mag:${target.objectId}:${target.regionId}:${presetKind}`
    : `mag:${target.objectId}:${presetKind}`;
}

export function defaultTextureMapping(): JsonObject {
  return {
    clamp_mode: "none",
    projection: "object_local",
    space: "object",
  };
}

export function defaultTextureTransform(): JsonObject {
  return {
    pivot: [0, 0, 0],
    rotation_quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
    translation: [0, 0, 0],
  };
}

export function presetMagnetizationAsset({
  id,
  label,
  mapping,
  presetKind,
  presetParams,
  textureTransform,
}: PresetMagnetizationAssetInput): JsonObject {
  const resolvedLabel =
    label?.trim() ||
    (presetKind === "uniform" ? "Uniform texture" : `${presetKind} texture`);

  return {
    id,
    kind: "preset_texture",
    mapping: mapping ?? defaultTextureMapping(),
    name: resolvedLabel,
    preset_kind: presetKind,
    preset_params: presetParams,
    preset_version: 1,
    texture_transform: textureTransform ?? defaultTextureTransform(),
    ui_label: resolvedLabel,
  };
}
