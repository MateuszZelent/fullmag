/**
 * Canonical physical <-> scene coordinate conversion helpers.
 *
 * Fullmag geometry authoring uses physical vectors in `[x, y, z]`.
 * The current Three.js scene convention swaps Y and Z for rendering.
 *
 * NOTE:
 * Keep all swap logic in this module; do not duplicate Y<->Z conversion
 * in viewport components.
 */

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

/**
 * Physical `[x, y, z]` -> scene `[x, z, y]`.
 */
export function physicalPositionToScene(v: Vec3Tuple): Vec3Tuple {
  return [v[0], v[2], v[1]];
}

/**
 * Scene `[x, y, z]` -> physical `[x, z, y]`.
 * For the current swap matrix, inverse equals forward transform.
 */
export function scenePositionToPhysical(v: Vec3Tuple): Vec3Tuple {
  return [v[0], v[2], v[1]];
}

/**
 * Scene drag delta `[dx, dy, dz]` -> physical delta.
 */
export function sceneDeltaToPhysical(v: Vec3Tuple): Vec3Tuple {
  return scenePositionToPhysical(v);
}

/**
 * Physical non-uniform scale -> scene scale.
 */
export function physicalScaleToScene(v: Vec3Tuple): Vec3Tuple {
  return physicalPositionToScene(v);
}

/**
 * Scene non-uniform scale -> physical scale.
 */
export function sceneScaleToPhysical(v: Vec3Tuple): Vec3Tuple {
  return scenePositionToPhysical(v);
}

/**
 * Physical quaternion -> scene quaternion.
 * Current convention is axis relabeling X->X, Y->Z, Z->Y.
 */
export function physicalQuatToScene(q: QuatTuple): QuatTuple {
  return [q[0], q[2], q[1], q[3]];
}

/**
 * Scene quaternion -> physical quaternion.
 */
export function sceneQuatToPhysical(q: QuatTuple): QuatTuple {
  return [q[0], q[2], q[1], q[3]];
}
