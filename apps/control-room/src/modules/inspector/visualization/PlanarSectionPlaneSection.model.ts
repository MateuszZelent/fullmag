import { type PlanarSectionGeometry } from "@/kernel/visualization/planarSectionModel";

/** Fraction of the requested normal position in nm, clamped to the section. */
export function sectionFractionFromNanometres(
  raw: string,
  geometry: PlanarSectionGeometry,
): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || geometry.normalExtent <= 0) return null;
  const fraction = (value * 1e-9 - geometry.normalMin) / geometry.normalExtent;
  return Math.min(1, Math.max(0, fraction));
}
