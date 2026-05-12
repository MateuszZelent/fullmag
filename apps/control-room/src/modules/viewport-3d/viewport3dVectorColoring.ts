import { magnetizationHslRgb } from "./orientation/magnetizationColor";

export type Viewport3DVectorColorMode =
  | "orientation"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "monochrome";

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

export function resolveViewport3DVectorColorRgb(
  mode: Viewport3DVectorColorMode,
  x: number,
  y: number,
  z: number,
  range: Viewport3DScalarColorRange,
): [number, number, number] | null {
  if (mode === "monochrome") return null;
  if (mode === "orientation") {
    return magnetizationHslRgb(x, y, z);
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
