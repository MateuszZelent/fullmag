export function magnetizationHslRgb(
  mx: number,
  my: number,
  mz: number,
): [number, number, number] {
  const length = Math.hypot(mx, my, mz);
  if (length === 0) {
    return [0.5, 0.5, 0.5];
  }

  const hue = normalizedHue(Math.atan2(my, mx) / (Math.PI * 2));
  const saturation = Math.min(1, Math.hypot(mx / length, my / length));
  const lightness = (clamp(mz / length, -1, 1) + 1) / 2;
  return hslToRgb(hue, saturation, lightness);
}

export const HSL_REFERENCE_AXES = [
  {
    color: [1, 0, 0],
    direction: [1, 0, 0],
    id: "x",
    label: "+X",
  },
  {
    color: magnetizationHslRgb(0, 1, 0),
    direction: [0, 1, 0],
    id: "y",
    label: "+Y",
  },
  {
    color: [1, 1, 1],
    direction: [0, 0, 1],
    id: "z",
    label: "+Z",
  },
] satisfies Array<{
  color: [number, number, number];
  direction: [number, number, number];
  id: string;
  label: string;
}>;

function normalizedHue(hue: number): number {
  return hue < 0 ? hue + 1 : hue;
}

function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  if (saturation === 0) {
    return [lightness, lightness, lightness];
  }

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return [
    hueChannel(p, q, hue + 1 / 3),
    hueChannel(p, q, hue),
    hueChannel(p, q, hue - 1 / 3),
  ];
}

function hueChannel(p: number, q: number, hue: number): number {
  let t = hue;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
