import type { JsonObject } from "@/kernel/api/apiTypes";

import { humanPresetLabel, type MagnetizationTexturePresetId } from "./texturePresets";
import type { MagnetizationTextureTarget } from "./types";

export interface PresetMagnetizationAssetInput {
  id: string;
  label?: string | null;
  mapping?: JsonObject | null;
  presetKind: MagnetizationTexturePresetId;
  presetVersion?: number | null;
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

function defaultTextureMapping(): JsonObject {
  return {
    clamp_mode: "none",
    projection: "object_local",
    space: "object",
  };
}

function defaultTextureTransform(): JsonObject {
  return {
    pivot: [0, 0, 0],
    rotate_vectors: true,
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
  presetVersion,
  presetParams,
  textureTransform,
}: PresetMagnetizationAssetInput): JsonObject {
  const customLabel = label?.trim() || null;
  const technicalName =
    customLabel ?? humanPresetLabel(presetKind, "preset_texture");

  return {
    id,
    kind: "preset_texture",
    mapping: mapping ?? defaultTextureMapping(),
    name: technicalName,
    preset_kind: presetKind,
    preset_params: presetParams,
    preset_version: presetVersion ?? 2,
    texture_transform: textureTransform ?? defaultTextureTransform(),
    ui_label: customLabel,
  };
}
