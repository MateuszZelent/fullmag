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
  const saturation = clamp(Math.hypot(nx, ny), 0, 1);
  const value = clamp(nz * 0.5 + 0.5, 0, 1);
  return orientationHsvToRgb(hueRadians, saturation, value);
}

export function magnetizationHslRgbForSceneVector(
  sceneX: number,
  sceneY: number,
  sceneZ: number,
): [number, number, number] {
  return magnetizationHslRgb(sceneX, sceneZ, sceneY);
}

const AXIS_RGB = {
  x: [1, 0, 0],
  y: [0x50 / 255, 0xc8 / 255, 0x50 / 255],
  z: [0x50 / 255, 0x90 / 255, 0xe6 / 255],
} satisfies Record<"x" | "y" | "z", [number, number, number]>;

export const HSL_REFERENCE_AXES = [
  {
    color: AXIS_RGB.x,
    direction: [1, 0, 0],
    id: "x",
    label: "+X",
  },
  {
    color: AXIS_RGB.z,
    direction: [0, 1, 0],
    id: "y",
    label: "+Z",
  },
  {
    color: AXIS_RGB.y,
    direction: [0, 0, 1],
    id: "z",
    label: "+Y",
  },
] satisfies Array<{
  color: [number, number, number];
  direction: [number, number, number];
  id: string;
  label: string;
}>;

function orientationHsvToRgb(
  hueRadians: number,
  saturation: number,
  value: number,
): [number, number, number] {
  const h = positiveModulo((hueRadians * 180) / Math.PI / 60, 6);
  const c = value * saturation;
  const x = c * (1 - Math.abs(positiveModulo(h, 2) - 1));
  const m = value - c;

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
