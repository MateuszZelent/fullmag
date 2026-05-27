import { magnetizationHslRgb } from "./orientation/magnetizationColor";

export type Viewport3DVectorColorMode =
  | "orientation"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "monochrome";

export type Viewport3DColorPalette =
  | "coolwarm"
  | "inferno"
  | "jet"
  | "magma"
  | "viridis";

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
const COLOR_PALETTES = new Set<Viewport3DColorPalette>([
  "coolwarm",
  "inferno",
  "jet",
  "magma",
  "viridis",
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
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return COLOR_PALETTES.has(normalized as Viewport3DColorPalette)
    ? (normalized as Viewport3DColorPalette)
    : fallback;
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

/**
 * Viridis-inspired gradient stops matching V1 legacy magnitudeColor:
 * dark-purple → blue → green → yellow.
 */
const MAGNITUDE_STOPS: [number, number, number][] = [
  [0x44 / 255, 0x01 / 255, 0x54 / 255],
  [0x31 / 255, 0x68 / 255, 0x8e / 255],
  [0x35 / 255, 0xb7 / 255, 0x79 / 255],
  [0xfd / 255, 0xe7 / 255, 0x25 / 255],
];
const PALETTE_STOPS: Record<
  Viewport3DColorPalette,
  [number, number, number][]
> = {
  coolwarm: [
    [0x3b / 255, 0x4c / 255, 0xc0 / 255],
    [0xdd / 255, 0xdd / 255, 0xdd / 255],
    [0xb4 / 255, 0x04 / 255, 0x26 / 255],
  ],
  inferno: [
    [0x00 / 255, 0x00 / 255, 0x04 / 255],
    [0x42 / 255, 0x0a / 255, 0x68 / 255],
    [0x93 / 255, 0x2b / 255, 0x5d / 255],
    [0xdd / 255, 0x51 / 255, 0x3a / 255],
    [0xfc / 255, 0xff / 255, 0xa4 / 255],
  ],
  jet: [
    [0x00 / 255, 0x00 / 255, 0x7f / 255],
    [0x00 / 255, 0x7f / 255, 0xff / 255],
    [0x7f / 255, 0xff / 255, 0x7f / 255],
    [0xff / 255, 0x7f / 255, 0x00 / 255],
    [0x7f / 255, 0x00 / 255, 0x00 / 255],
  ],
  magma: [
    [0x00 / 255, 0x00 / 255, 0x04 / 255],
    [0x3b / 255, 0x0f / 255, 0x70 / 255],
    [0x8c / 255, 0x29 / 255, 0x80 / 255],
    [0xde / 255, 0x49 / 255, 0x68 / 255],
    [0xfc / 255, 0xfd / 255, 0xbf / 255],
  ],
  viridis: MAGNITUDE_STOPS,
};

/**
 * Maps a relative magnitude [0..1] to an RGB colour using the selected palette.
 */
export function magnitudeColorRgb(
  t: number,
  palette: string | null | undefined = "viridis",
): [number, number, number] {
  const clamped = Math.min(Math.max(t, 0), 1);
  const stops = PALETTE_STOPS[normalizeViewport3DColorPalette(palette)];
  const scaled = clamped * (stops.length - 1);
  const idx = Math.min(Math.floor(scaled), stops.length - 2);
  const frac = scaled - idx;
  const a = stops[idx]!;
  const b = stops[idx + 1]!;
  return [
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
  ];
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

  return scalarColorRgb(
    resolveViewport3DVectorColorScalar(mode, x, y, z),
    range,
  );
}

function scalarColorRgb(
  value: number,
  range: Viewport3DScalarColorRange,
): [number, number, number] {
  const span = Math.max(range.max - range.min, 1e-12);
  const normalized = Math.min(Math.max((value - range.min) / span, 0), 1);
  return [
    normalized,
    0.38 + 0.42 * (1 - Math.abs(normalized - 0.5) * 2),
    1 - normalized,
  ];
}
