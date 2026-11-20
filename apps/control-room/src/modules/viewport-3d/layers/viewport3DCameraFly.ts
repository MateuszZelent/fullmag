/**
 * Wheel navigation that does not stall at the orbit target.
 *
 * OrbitControls dollies by scaling the camera-target distance, so every wheel
 * step shrinks as the camera approaches the target and the camera can never
 * reach or pass it. Two cases replace that behaviour:
 *
 * - free camera: the wheel flies the camera along its view direction at a
 *   constant speed proportional to the scene size, carrying the look target
 *   with it, so the camera can enter and pass through objects;
 * - object orbit: once the camera is close to the target, zooming in pushes
 *   the target ahead by the same step instead of shrinking towards zero.
 */

export type Viewport3DRotationModeForFly = "camera" | "object";

/** Fraction of the scene radius travelled per standard wheel notch (deltaY 100). */
export const VIEWPORT_3D_FLY_STEP_FRACTION = 0.12;
/** Below this camera-target distance (fraction of the scene radius), orbit zoom pushes the target. */
export const VIEWPORT_3D_PUSH_TARGET_FRACTION = 0.08;
/** Look-around pivot distance in front of a free camera (fraction of the scene radius). */
export const VIEWPORT_3D_FREE_PIVOT_FRACTION = 0.01;

export interface Viewport3DFlyStep {
  /** Signed distance to move camera and target along the view direction. */
  distance: number;
}

/**
 * Returns the step that moves camera and target together, or null when the
 * ordinary orbit dolly should handle the wheel event.
 */
export function resolveViewport3DFlyStep({
  deltaY,
  mode,
  orthographic,
  sceneRadius,
  targetDistance,
}: {
  deltaY: number;
  mode: Viewport3DRotationModeForFly;
  orthographic: boolean;
  sceneRadius: number;
  targetDistance: number;
}): Viewport3DFlyStep | null {
  if (orthographic || !Number.isFinite(deltaY) || deltaY === 0) return null;
  const radius = Number.isFinite(sceneRadius) && sceneRadius > 0 ? sceneRadius : 1;
  // Normalise trackpads and line-mode wheels to notches, capped per event.
  const notches = Math.max(-3, Math.min(3, deltaY / 100));
  const step = -notches * radius * VIEWPORT_3D_FLY_STEP_FRACTION;
  if (mode === "camera") return { distance: step };
  const zoomingIn = step > 0;
  const close = Number.isFinite(targetDistance) && targetDistance < radius * VIEWPORT_3D_PUSH_TARGET_FRACTION;
  return zoomingIn && close ? { distance: step } : null;
}
