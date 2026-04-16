import type { MagnetizationAsset, TextureTransform3D, MagnetizationMapping } from "./types";

export type ClipboardMagneticPreset = {
  type: "fullmag.magnetic_preset";
  version: 1;
  preset_kind: string;
  preset_params: Record<string, unknown>;
  texture_transform: TextureTransform3D;
  mapping: MagnetizationMapping;
  ui_label: string | null;
};

const LOCAL_STORAGE_KEY = "fullmag:clipboard:magnetic_preset";

export function copyMagneticPreset(asset: MagnetizationAsset) {
  if (typeof window === "undefined") return;
  if (asset.kind !== "preset_texture" || !asset.preset_kind) return;

  const payload: ClipboardMagneticPreset = {
    type: "fullmag.magnetic_preset",
    version: 1,
    preset_kind: asset.preset_kind,
    preset_params: asset.preset_params ?? {},
    texture_transform: asset.texture_transform,
    mapping: asset.mapping,
    ui_label: asset.ui_label,
  };

  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("Failed to copy magnetic preset to local storage", e);
  }
}

export function readMagneticPresetClipboard(): ClipboardMagneticPreset | null {
  if (typeof window === "undefined") return null;

  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && parsed.type === "fullmag.magnetic_preset") {
      return parsed as ClipboardMagneticPreset;
    }
  } catch (e) {
    console.error("Failed to read magnetic preset from local storage", e);
  }
  return null;
}
