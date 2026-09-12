/**
 * Shared SI unit scaling utilities.
 *
 * Used by DimensionOverlay, SceneAxes3D, and any component that needs
 * to convert raw meters into human-readable unit prefixes.
 */

export interface UnitScale {
  scale: number;
  unit: string;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  const normalized = Number(value.toPrecision(12));
  if (Object.is(normalized, -0)) {
    return "0";
  }
  return normalized.toString();
}

/**
 * Pick the best SI prefix for a given value in meters.
 * Returns the multiplier and unit string.
 */
export function pickUnitScale(meters: number): UnitScale {
  const abs = Math.abs(meters);
  if (abs >= 1)    return { scale: 1,    unit: "m" };
  if (abs >= 1e-2) return { scale: 1e2,  unit: "cm" };
  if (abs >= 1e-3) return { scale: 1e3,  unit: "mm" };
  if (abs >= 1e-5) return { scale: 1e6,  unit: "µm" };
  if (abs >= 1e-8) return { scale: 1e9,  unit: "nm" };
  return            { scale: 1e12, unit: "pm" };
}

export function metersTextToNanometersInput(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return "";
  }
  const meters = Number(trimmed);
  if (!Number.isFinite(meters)) {
    return trimmed;
  }
  return formatCompactNumber(meters * 1e9);
}

export function nanometersInputToMetersText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const nanometers = Number(trimmed);
  if (!Number.isFinite(nanometers)) {
    return trimmed;
  }
  return formatCompactNumber(nanometers * 1e-9);
}

export function formatMetersTextAsNanometers(
  raw: string | null | undefined,
  fallback = "Auto",
): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return fallback;
  }
  const meters = Number(trimmed);
  if (!Number.isFinite(meters)) {
    return trimmed;
  }
  return `${formatCompactNumber(meters * 1e9)} nm`;
}
