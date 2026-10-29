import { magnetizationHslRgb } from "./orientation/magnetizationColor";
import {
  normalizeScalarColorPalette,
  scalarColorPaletteGradientCss,
  scalarColorRgb,
  type ScalarColorPalette,
} from "../../shared/visualization/scalarColorPalette";

export type Viewport3DVectorColorMode =
  | "orientation"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "monochrome";

export type Viewport3DColorPalette = ScalarColorPalette;

export interface Viewport3DScalarColorRange {
  max: number;
  min: number;
}

const VECTOR_COLOR_MODES = new Set<Viewport3DVectorColorMode>([
  "orientation",
  "x",
  "y",
  "z",
  "magnitude",
  "monochrome",
]);

export function normalizeViewport3DVectorColorMode(
  value: string | null | undefined,
  fallback: Viewport3DVectorColorMode = "orientation",
): Viewport3DVectorColorMode {
  const normalized = normalizeVectorColorToken(value);
  return VECTOR_COLOR_MODES.has(normalized as Viewport3DVectorColorMode)
    ? (normalized as Viewport3DVectorColorMode)
    : fallback;
}

export function normalizeViewport3DColorPalette(
  value: string | null | undefined,
  fallback: Viewport3DColorPalette = "viridis",
): Viewport3DColorPalette {
  return normalizeScalarColorPalette(value, fallback);
}

function normalizeVectorColorToken(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (
    normalized === "hsl" ||
    normalized === "hslsphere" ||
    normalized === "hsl_sphere"
  ) {
    return "orientation";
  }
  return normalized;
}

export function resolveViewport3DVectorColorScalar(
  mode: Viewport3DVectorColorMode,
  x: number,
  y: number,
  z: number,
): number {
  if (mode === "x") return x;
  if (mode === "y") return y;
  if (mode === "z") return z;
  return Math.hypot(x, y, z);
}

export function viewport3DColorPaletteGradientCss(
  palette: string | null | undefined = "viridis",
): string {
  return scalarColorPaletteGradientCss(palette);
}

/**
 * Maps a relative magnitude [0..1] to an RGB colour using the selected palette.
 */
export function magnitudeColorRgb(
  t: number,
  palette: string | null | undefined = "viridis",
): [number, number, number] {
  return scalarColorRgb(t, palette);
}

/**
 * @param relMag - pre-normalised relative magnitude [0..1] from the 7th segment
 *                 channel. Only used when mode is "magnitude".
 */
export function resolveViewport3DVectorColorRgb(
  mode: Viewport3DVectorColorMode,
  x: number,
  y: number,
  z: number,
  range: Viewport3DScalarColorRange,
  relMag = 1,
  palette: string | null | undefined = "viridis",
): [number, number, number] | null {
  if (mode === "monochrome") return null;
  if (mode === "orientation") {
    return magnetizationHslRgb(x, y, z);
  }
  if (mode === "magnitude") {
    return magnitudeColorRgb(relMag, palette);
  }

  return scalarValueColorRgb(
    resolveViewport3DVectorColorScalar(mode, x, y, z),
    range,
    palette,
  );
}

function scalarValueColorRgb(
  value: number,
  range: Viewport3DScalarColorRange,
  palette: string | null | undefined = "viridis",
): [number, number, number] {
  return magnitudeColorRgb(normalizeViewport3DScalarColorValue(value, range), palette);
}

/** Unit-independent normalization, including narrow SI ranges and finite extremes. */
export function normalizeViewport3DScalarColorValue(
  value: number,
  range: Viewport3DScalarColorRange,
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.min >= range.max
  ) return 0.5;
  if (value <= range.min) return 0;
  if (value >= range.max) return 1;
  const span = range.max - range.min;
  if (Number.isFinite(span)) return (value - range.min) / span;
  const scale = Math.max(Math.abs(range.min), Math.abs(range.max));
  return (value / scale - range.min / scale) / (range.max / scale - range.min / scale);
}
