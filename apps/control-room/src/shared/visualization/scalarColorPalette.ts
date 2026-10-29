const SCALAR_COLOR_PALETTE_CATALOG = [
  { value: "viridis", label: "Viridis" },
  { value: "inferno", label: "Inferno" },
  { value: "magma", label: "Magma" },
  { value: "coolwarm", label: "Coolwarm" },
  { value: "jet", label: "Jet" },
  { value: "plasma", label: "Plasma" },
  { value: "cividis", label: "Cividis" },
  { value: "turbo", label: "Turbo" },
  { value: "grayscale", label: "Grayscale" },
  { value: "rdbu", label: "RdBu" },
] as const;

export type ScalarColorPalette =
  (typeof SCALAR_COLOR_PALETTE_CATALOG)[number]["value"];

export const SCALAR_COLOR_PALETTE_ITEMS: Array<{
  label: string;
  value: ScalarColorPalette;
}> = SCALAR_COLOR_PALETTE_CATALOG.map(({ label, value }) => ({
  label,
  value,
}));

export type ScalarColorPaletteStop = readonly [number, number, number];
export type ScalarColorPaletteStops = readonly ScalarColorPaletteStop[];

type Rgb = [number, number, number];
type ScalarColorPaletteId = ScalarColorPalette | "twilight";

const COLOR_PALETTES = new Set<ScalarColorPalette>(
  SCALAR_COLOR_PALETTE_ITEMS.map(({ value }) => value),
);

const DIVERGING_SCALAR_PALETTES = new Set<ScalarColorPalette>([
  "coolwarm",
  "rdbu",
]);

export function isDivergingScalarPalette(palette: string): boolean {
  return DIVERGING_SCALAR_PALETTES.has(normalizeScalarColorPalette(palette));
}

const PALETTE_STOPS: Readonly<
  Record<ScalarColorPaletteId, ScalarColorPaletteStops>
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
  viridis: [
    [0x44 / 255, 0x01 / 255, 0x54 / 255],
    [0x31 / 255, 0x68 / 255, 0x8e / 255],
    [0x35 / 255, 0xb7 / 255, 0x79 / 255],
    [0xfd / 255, 0xe7 / 255, 0x25 / 255],
  ],
  plasma: [
    [0x0d / 255, 0x08 / 255, 0x87 / 255],
    [0x7e / 255, 0x03 / 255, 0xa8 / 255],
    [0xcc / 255, 0x47 / 255, 0x78 / 255],
    [0xf8 / 255, 0x95 / 255, 0x40 / 255],
    [0xf0 / 255, 0xf9 / 255, 0x21 / 255],
  ],
  cividis: [
    [0x00 / 255, 0x20 / 255, 0x4c / 255],
    [0x42 / 255, 0x4d / 255, 0x6b / 255],
    [0x7d / 255, 0x7c / 255, 0x78 / 255],
    [0xbc / 255, 0xae / 255, 0x6c / 255],
    [0xfe / 255, 0xe8 / 255, 0x38 / 255],
  ],
  turbo: [
    [0x30 / 255, 0x12 / 255, 0x3b / 255],
    [0x46 / 255, 0x6b / 255, 0xe3 / 255],
    [0x28 / 255, 0xbb / 255, 0xec / 255],
    [0x32 / 255, 0xf2 / 255, 0x98 / 255],
    [0xa4 / 255, 0xfc / 255, 0x3c / 255],
    [0xfa / 255, 0xba / 255, 0x39 / 255],
    [0xe6 / 255, 0x5f / 255, 0x0d / 255],
    [0x7a / 255, 0x04 / 255, 0x03 / 255],
  ],
  grayscale: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  rdbu: [
    [0x67 / 255, 0x00 / 255, 0x1f / 255],
    [0xb2 / 255, 0x18 / 255, 0x2b / 255],
    [0xd6 / 255, 0x60 / 255, 0x4d / 255],
    [0xf4 / 255, 0xa5 / 255, 0x82 / 255],
    [0xfd / 255, 0xdb / 255, 0xc7 / 255],
    [0xf7 / 255, 0xf7 / 255, 0xf7 / 255],
    [0xd1 / 255, 0xe5 / 255, 0xf0 / 255],
    [0x92 / 255, 0xc5 / 255, 0xde / 255],
    [0x43 / 255, 0x93 / 255, 0xc3 / 255],
    [0x21 / 255, 0x66 / 255, 0xac / 255],
    [0x05 / 255, 0x30 / 255, 0x61 / 255],
  ],
  // Twilight is retained for the frequency-domain phase shader but is not a
  // selectable scalar palette because it is cyclic.
  twilight: [
    [0.184, 0.079, 0.213],
    [0.384, 0.461, 0.731],
    [0.886, 0.85, 0.886],
    [0.698, 0.338, 0.322],
    [0.184, 0.079, 0.213],
  ],
};

/** Immutable sRGB stop values shared by CPU sampling, colorbars, and shaders. */
export function getScalarColorPaletteStops(
  palette: ScalarColorPalette | "twilight",
): ScalarColorPaletteStops {
  return PALETTE_STOPS[palette];
}

export function normalizeScalarColorPalette(
  value: string | null | undefined,
  fallback: ScalarColorPalette = "viridis",
): ScalarColorPalette {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return COLOR_PALETTES.has(normalized as ScalarColorPalette)
    ? (normalized as ScalarColorPalette)
    : fallback;
}

/**
 * Converts a single sRGB channel value [0..1] to linear-sRGB, using the
 * standard sRGB EOTF (same piecewise formula as three.js's internal
 * `sRGBTransferEOTF` GLSL chunk).
 */
function srgbChannelToLinear(component: number): number {
  return component <= 0.04045
    ? component / 12.92
    : Math.pow((component + 0.055) / 1.055, 2.4);
}

/** Palette samples in display sRGB for Canvas ImageData and CSS consumers. */
export function scalarColorSrgb(
  t: number,
  palette: string | null | undefined = "viridis",
): Rgb {
  const clamped = Math.min(Math.max(t, 0), 1);
  const stops = PALETTE_STOPS[normalizeScalarColorPalette(palette)];
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const fraction = scaled - index;
  const start = stops[index]!;
  const end = stops[index + 1]!;
  return [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
    start[2] + (end[2] - start[2]) * fraction,
  ];
}

/** Palette samples in linear-sRGB for the Three.js working color space. */
export function scalarColorRgb(
  t: number,
  palette: string | null | undefined = "viridis",
): Rgb {
  const srgb = scalarColorSrgb(t, palette);
  return [
    srgbChannelToLinear(srgb[0]),
    srgbChannelToLinear(srgb[1]),
    srgbChannelToLinear(srgb[2]),
  ];
}

export function scalarColorPaletteGradientCss(
  palette: string | null | undefined = "viridis",
  direction = "90deg",
): string {
  const stops = PALETTE_STOPS[normalizeScalarColorPalette(palette)];
  return `linear-gradient(${direction} in srgb, ${stops
    .map(
      ([red, green, blue]) =>
        `rgb(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)})`,
    )
    .join(", ")})`;
}
