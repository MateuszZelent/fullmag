const CANONICAL_QUANTITY_IDS: Record<string, string> = {
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
};

export function resolveCanonicalQuantityId(quantityId: string): string {
  const trimmed = quantityId.trim();
  return CANONICAL_QUANTITY_IDS[trimmed] ?? trimmed;
}
