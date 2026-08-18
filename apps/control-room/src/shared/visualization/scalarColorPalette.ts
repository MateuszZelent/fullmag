export type ScalarColorPalette =
  | "coolwarm"
  | "inferno"
  | "jet"
  | "magma"
  | "viridis";

type Rgb = [number, number, number];

const COLOR_PALETTES = new Set<ScalarColorPalette>([
  "coolwarm",
  "inferno",
  "jet",
  "magma",
  "viridis",
]);

const PALETTE_STOPS: Record<ScalarColorPalette, Rgb[]> = {
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
};

export function normalizeScalarColorPalette(
  value: string | null | undefined,
  fallback: ScalarColorPalette = "viridis",
): ScalarColorPalette {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return COLOR_PALETTES.has(normalized as ScalarColorPalette)
    ? (normalized as ScalarColorPalette)
    : fallback;
}

export function scalarColorRgb(
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

export function scalarColorPaletteGradientCss(
  palette: string | null | undefined = "viridis",
  direction = "90deg",
): string {
  const stops = PALETTE_STOPS[normalizeScalarColorPalette(palette)];
  return `linear-gradient(${direction}, ${stops
    .map(
      ([red, green, blue]) =>
        `rgb(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)})`,
    )
    .join(", ")})`;
}
