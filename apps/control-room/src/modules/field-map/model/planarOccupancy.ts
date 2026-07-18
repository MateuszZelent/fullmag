export const PLANAR_OCCUPANCY = {
  occupied: 0,
  empty: 1,
  partial: 2,
  undefinedOrientation: 3,
  overlapAmbiguous: 4,
} as const;

export function isRenderablePlanarOccupancy(code: number | undefined): boolean {
  return (
    code === undefined ||
    code === PLANAR_OCCUPANCY.occupied ||
    code === PLANAR_OCCUPANCY.partial ||
    code === PLANAR_OCCUPANCY.overlapAmbiguous
  );
}

export function planarOccupancyLabel(
  code: number | undefined,
): "empty" | "occupied" | "overlap_ambiguous" | "partial" | "undefined_orientation" {
  switch (code) {
    case PLANAR_OCCUPANCY.empty:
      return "empty";
    case PLANAR_OCCUPANCY.partial:
      return "partial";
    case PLANAR_OCCUPANCY.undefinedOrientation:
      return "undefined_orientation";
    case PLANAR_OCCUPANCY.overlapAmbiguous:
      return "overlap_ambiguous";
    default:
      return "occupied";
  }
}
