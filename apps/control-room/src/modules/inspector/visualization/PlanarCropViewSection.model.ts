import type { PlanarCropState } from "@/kernel/api/apiTypes";

export type CropField = keyof PlanarCropState;

/** Validates one edited crop limit against the other three; errors name the edited field. */
export function planarCropFromEdit(
  base: PlanarCropState,
  field: CropField,
  raw: string,
): { crop: PlanarCropState } | { error: string } {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) return { error: "Enter a finite value in nm." };
  const crop = { ...base, [field]: value * 1e-9 };
  if (crop.u_min_m >= crop.u_max_m) {
    return { error: field.endsWith("min_m") ? "Minimum must be below the maximum." : "Maximum must be above the minimum." };
  }
  if (crop.v_min_m >= crop.v_max_m) {
    return { error: field.endsWith("min_m") ? "Minimum must be below the maximum." : "Maximum must be above the minimum." };
  }
  return { crop };
}
