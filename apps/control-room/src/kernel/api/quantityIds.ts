const CANONICAL_QUANTITY_IDS: Record<string, string> = {
  M: "m",
  B_drive: "B_drive",
  dm_dt: "dm_dt",
  eden_ani: "eden_ani",
  eden_demag: "eden_demag",
  eden_dmi: "eden_dmi",
  eden_ex: "eden_ex",
  eden_ext: "eden_ext",
  eden_total: "eden_total",
  e_ani: "E_ani",
  e_demag: "E_demag",
  e_dmi: "E_dmi",
  e_ex: "E_ex",
  h_ani: "H_ani",
  h_ani_cubic: "H_ani_cubic",
  h_ant: "H_ant",
  h_demag: "H_demag",
  h_dmi: "H_dmi",
  h_dmi_bulk: "H_dmi_bulk",
  h_drive: "H_drive",
  h_eff: "H_eff",
  h_ex: "H_ex",
  h_ext: "H_ext",
  h_mel: "H_mel",
  h_oe: "H_oe",
  h_therm: "H_therm",
  material_a: "mat_aex",
  material_aex: "mat_aex",
  material_alpha: "mat_alpha",
  material_dbulk: "mat_dbulk",
  material_dind: "mat_dind",
  material_ms: "mat_ms",
  mat_aex: "mat_aex",
  mat_alpha: "mat_alpha",
  mat_dbulk: "mat_dbulk",
  mat_dind: "mat_dind",
  mat_ms: "mat_ms",
  torque: "torque",
};

const MAGNETIC_ONLY_QUANTITY_IDS = new Set([
  "m",
  "H_ex",
  "torque",
  "H_ani",
  "H_dmi",
  "H_mel",
  "H_ani_cubic",
  "H_ant",
  "H_drive",
  "B_drive",
  "H_dmi_bulk",
  "H_therm",
  "E_ex",
  "E_demag",
  "E_ani",
  "E_dmi",
  "mode_amplitude",
  "mode_real",
  "mode_imag",
  "mode_phase",
  "eden_ex",
  "eden_demag",
  "eden_ext",
  "eden_ani",
  "eden_dmi",
  "eden_total",
  "mat_ms",
  "mat_aex",
  "mat_alpha",
  "mat_dind",
  "mat_dbulk",
  "dm_dt",
  "torque_stt",
  "torque_sot",
]);

const SCALAR_SPATIAL_QUANTITY_IDS = new Set([
  "eden_ani",
  "eden_demag",
  "eden_dmi",
  "eden_ex",
  "eden_ext",
  "eden_total",
  "mat_ms",
  "mat_aex",
  "mat_alpha",
  "mat_dind",
  "mat_dbulk",
]);

const QUANTITY_UNITS: Record<string, string> = {
  B_drive: "T",
  E_ani: "J",
  E_demag: "J",
  E_dmi: "J",
  E_ex: "J",
  E_ext: "J",
  E_total: "J",
  H_ani: "A/m",
  H_ani_cubic: "A/m",
  H_ant: "A/m",
  H_drive: "A/m",
  H_demag: "A/m",
  H_dmi: "A/m",
  H_dmi_bulk: "A/m",
  H_eff: "A/m",
  H_ex: "A/m",
  H_ext: "A/m",
  H_mel: "A/m",
  H_oe: "A/m",
  H_therm: "A/m",
  dm_dt: "1/s",
  eden_ani: "J/m³",
  eden_demag: "J/m³",
  eden_dmi: "J/m³",
  eden_ex: "J/m³",
  eden_ext: "J/m³",
  eden_total: "J/m³",
  m: "1",
  mat_aex: "J/m",
  mat_alpha: "1",
  mat_dbulk: "J/m³",
  mat_dind: "J/m²",
  mat_ms: "A/m",
  torque: "T",
};

export const VACUUM_PERMEABILITY_H_PER_M = 4e-7 * Math.PI;

export function storedFieldQuantityId(quantityId: string): string {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  return canonicalQuantityId === "B_drive" ? "H_drive" : canonicalQuantityId;
}

export function fieldDisplayScale(quantityId: string): number {
  return resolveCanonicalQuantityId(quantityId) === "B_drive"
    ? VACUUM_PERMEABILITY_H_PER_M
    : 1;
}

export function resolveCanonicalQuantityId(quantityId: string): string {
  const trimmed = quantityId.trim();
  return CANONICAL_QUANTITY_IDS[trimmed] ?? trimmed;
}

export function normalizeQuantityIdOrDefault(
  quantityId: string | null | undefined,
  fallback = "m",
): string {
  const trimmed = quantityId?.trim() ?? "";
  return resolveCanonicalQuantityId(trimmed || fallback);
}

export function sameQuantityId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return normalizeQuantityIdOrDefault(left) === normalizeQuantityIdOrDefault(right);
}

export function isMagneticOnlyQuantityId(quantityId: string): boolean {
  return MAGNETIC_ONLY_QUANTITY_IDS.has(resolveCanonicalQuantityId(quantityId));
}

export function isScalarSpatialQuantityId(quantityId: string): boolean {
  return SCALAR_SPATIAL_QUANTITY_IDS.has(resolveCanonicalQuantityId(quantityId));
}

export function isAnalysisFieldQuantityId(quantityId: string): boolean {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  return (
    canonicalQuantityId.startsWith("analysis:frequency-response:") ||
    canonicalQuantityId.startsWith("analysis:eigen:")
  );
}

export function quantityUnitForColorbar(quantityId: string): string {
  return QUANTITY_UNITS[resolveCanonicalQuantityId(quantityId)] ?? "";
}
