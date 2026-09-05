export type DefaultPlanarPlane = "xy" | "xz" | "yz";

export interface DefaultPlanarBounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

export function normalAxisForPlane(plane: DefaultPlanarPlane): "x" | "y" | "z" {
  switch (plane) {
    case "xy":
      return "z";
    case "xz":
      return "y";
    case "yz":
      return "x";
  }
}

export function resolvedAxisCoordinate(
  bounds: DefaultPlanarBounds,
  plane: DefaultPlanarPlane,
  positionFraction: number,
): number {
  const axis = AXIS_INDEX[normalAxisForPlane(plane)];
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  const fraction = Number.isFinite(positionFraction)
    ? Math.min(1, Math.max(0, positionFraction))
    : 0.5;
  return min + fraction * (max - min);
}

export function positionFractionFromCoordinate(
  bounds: DefaultPlanarBounds,
  plane: DefaultPlanarPlane,
  coordinate: number,
): number {
  const axis = AXIS_INDEX[normalAxisForPlane(plane)];
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  if (!Number.isFinite(coordinate) || max <= min) return 0.5;
  return Math.min(1, Math.max(0, (coordinate - min) / (max - min)));
}

export function defaultPlaneLabel(plane: DefaultPlanarPlane): string {
  return plane.toUpperCase();
}

export type PlanarSourceLengthUnit = "m" | "mm" | "um" | "nm";

export function recommendedLengthUnit(bounds: DefaultPlanarBounds | null | undefined): PlanarSourceLengthUnit {
  if (!bounds) return "m";
  const span = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  if (!Number.isFinite(span) || span <= 0) return "m";
  if (span <= 1e-6) return "nm";
  if (span <= 1e-3) return "um";
  if (span <= 1) return "mm";
  return "m";
}

export function lengthScaleForUnit(unit: PlanarSourceLengthUnit): number {
  switch (unit) {
    case "nm":
      return 1e-9;
    case "um":
      return 1e-6;
    case "mm":
      return 1e-3;
    case "m":
      return 1;
  }
}
