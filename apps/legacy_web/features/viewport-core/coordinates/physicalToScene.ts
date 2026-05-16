/**
 * Canonical physical <-> scene coordinate conversion helpers.
 *
 * Fullmag geometry authoring uses physical vectors in `[x, y, z]`.
 * The Three.js scene uses the same axis order; only SI metres are scaled
 * to nanometres for rendering.
 */

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

/**
 * Three.js scene units for authoring/world-space viewports.
 *
 * Runtime geometry is stored in SI metres. Rendering it directly makes typical
 * micromagnetic objects smaller than the camera near plane, so the viewport
 * uses nanometres as scene units.
 */
export const PHYSICAL_TO_SCENE_SCALE = 1e9;
export const SCENE_TO_PHYSICAL_SCALE = 1 / PHYSICAL_TO_SCENE_SCALE;

export function physicalLengthToScene(value: number): number {
  return value * PHYSICAL_TO_SCENE_SCALE;
}

export function sceneLengthToPhysical(value: number): number {
  return value * SCENE_TO_PHYSICAL_SCALE;
}

/**
 * Physical position `[x, y, z]` in metres -> scene `[x, y, z]` in nanometres.
 */
export function physicalPositionToScene(v: Vec3Tuple): Vec3Tuple {
  return [
    physicalLengthToScene(v[0]),
    physicalLengthToScene(v[1]),
    physicalLengthToScene(v[2]),
  ];
}

/**
 * Scene position `[x, y, z]` in nanometres -> physical `[x, y, z]` in metres.
 */
export function scenePositionToPhysical(v: Vec3Tuple): Vec3Tuple {
  return [
    sceneLengthToPhysical(v[0]),
    sceneLengthToPhysical(v[1]),
    sceneLengthToPhysical(v[2]),
  ];
}

/**
 * Scene drag delta `[dx, dy, dz]` -> physical delta.
 */
export function sceneDeltaToPhysical(v: Vec3Tuple): Vec3Tuple {
  return scenePositionToPhysical(v);
}

/**
 * Physical non-uniform size/scale in metres -> scene size in nanometres.
 */
export function physicalScaleToScene(v: Vec3Tuple): Vec3Tuple {
  return physicalPositionToScene(v);
}

/**
 * Scene non-uniform size in nanometres -> physical size in metres.
 */
export function sceneScaleToPhysical(v: Vec3Tuple): Vec3Tuple {
  return scenePositionToPhysical(v);
}

/**
 * Dimensionless transform scale in physical axis order -> scene axis order.
 *
 * Do not use `physicalScaleToScene` for primitive transform scale factors:
 * those are unitless multipliers, not SI lengths.
 */
export function dimensionlessScaleToScene(v: Vec3Tuple): Vec3Tuple {
  return [v[0], v[1], v[2]];
}

export function sceneScaleToDimensionless(v: Vec3Tuple): Vec3Tuple {
  return [v[0], v[1], v[2]];
}

/**
 * Physical quaternion -> scene quaternion.
 */
export function physicalQuatToScene(q: QuatTuple): QuatTuple {
  return [q[0], q[1], q[2], q[3]];
}

/**
 * Scene quaternion -> physical quaternion.
 */
export function sceneQuatToPhysical(q: QuatTuple): QuatTuple {
  return [q[0], q[1], q[2], q[3]];
}
