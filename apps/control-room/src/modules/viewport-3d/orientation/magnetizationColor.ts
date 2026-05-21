import { clampNumber } from "../viewport3dMath";

export function magnetizationHslRgb(
  mx: number,
  my: number,
  mz: number,
): [number, number, number] {
  const magnitude = Math.hypot(mx, my, mz);
  if (magnitude <= 1e-30) {
    return [0.6, 0.6, 0.6];
  }

  const nx = mx / magnitude;
  const ny = my / magnitude;
  const nz = mz / magnitude;
  const hueRadians = Math.atan2(ny, nx);
  const saturation = clampNumber(Math.hypot(nx, ny), 0, 1);
  const lightness = clampNumber(nz * 0.5 + 0.5, 0, 1);
  return orientationHslToRgb(hueRadians, saturation, lightness);
}

export const HSL_REFERENCE_AXES = [
  {
    color: magnetizationHslRgb(1, 0, 0),
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
    color: magnetizationHslRgb(0, 0, 1),
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

function orientationHslToRgb(
  hueRadians: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  const h = positiveModulo((hueRadians * 180) / Math.PI / 60, 6);
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(positiveModulo(h, 2) - 1));
  const m = lightness - c / 2;

  if (h < 1) return [c + m, x + m, m];
  if (h < 2) return [x + m, c + m, m];
  if (h < 3) return [m, c + m, x + m];
  if (h < 4) return [m, x + m, c + m];
  if (h < 5) return [x + m, m, c + m];
  return [c + m, m, x + m];
}

function positiveModulo(value: number, modulus: number): number {
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
}
