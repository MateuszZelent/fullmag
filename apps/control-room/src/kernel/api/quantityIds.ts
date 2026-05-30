const CANONICAL_QUANTITY_IDS: Record<string, string> = {
  M: "m",
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
  h_eff: "H_eff",
  h_ex: "H_ex",
  h_ext: "H_ext",
  h_mel: "H_mel",
  h_oe: "H_oe",
  h_therm: "H_therm",
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
  "dm_dt",
  "torque_stt",
  "torque_sot",
]);

export function resolveCanonicalQuantityId(quantityId: string): string {
  const trimmed = quantityId.trim();
  return CANONICAL_QUANTITY_IDS[trimmed] ?? trimmed;
}

export function isMagneticOnlyQuantityId(quantityId: string): boolean {
  return MAGNETIC_ONLY_QUANTITY_IDS.has(resolveCanonicalQuantityId(quantityId));
}
