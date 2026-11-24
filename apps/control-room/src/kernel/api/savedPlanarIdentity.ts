import type { SavedPlanarQuery, SavedPlanarResource } from "./apiTypes";

// Axis presets are exact canonical frames (PlanarFrameIR::axis_preset), not
// fitted directions. In particular XZ has normal -Y, since X cross Z = -Y.
export function savedPlanarFrameMatches(meta: SavedPlanarResource, query: SavedPlanarQuery): boolean {
  const frames: Record<string, number[][]> = {
    xy: [[0, 0, query.position_m], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    xz: [[0, query.position_m, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]],
    yz: [[query.position_m, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]],
  };
  const expected = frames[query.plane];
  if (!expected || !Number.isFinite(query.position_m)) return false;
  const actual = [meta.frame_origin_m, meta.frame_u_axis, meta.frame_v_axis, meta.frame_normal];
  return meta.schema_version === "fullmag.persistence.saved_planar.v1" &&
    meta.operator === "plane_sample" &&
    Array.isArray(meta.vector_components) && meta.vector_components.length === 3 &&
    meta.vector_components.every((component, index) => component === ["x", "y", "z"][index]) &&
    actual.every((axis, index) => Array.isArray(axis) && axis.length === 3 &&
      axis.every((value, coordinate) => Number.isFinite(value) && value === expected[index][coordinate]));
}
