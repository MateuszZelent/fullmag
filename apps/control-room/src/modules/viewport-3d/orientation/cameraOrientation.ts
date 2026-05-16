import type { Viewport3DCameraState } from "../viewport3dStore";

export type Direction3 = [number, number, number];

export const VIEWPORT_3D_SYSTEM_CENTER: Direction3 = [0, 0, 0];

export function snapCameraToDirection(
  current: Viewport3DCameraState,
  direction: Direction3,
): Viewport3DCameraState {
  const normalized = normalizeDirection(direction);
  const distance = Math.max(
    Math.hypot(
      current.position[0] - current.target[0],
      current.position[1] - current.target[1],
      current.position[2] - current.target[2],
    ),
    1e-9,
  );

  return {
    position: [
      current.target[0] + normalized[0] * distance,
      current.target[1] + normalized[1] * distance,
      current.target[2] + normalized[2] * distance,
    ],
    target: current.target,
    up: current.up,
  };
}

export function rotateCameraAroundCenter(
  current: Viewport3DCameraState,
  center: Direction3,
  radians: number,
): Viewport3DCameraState {
  const x = current.position[0] - center[0];
  const y = current.position[1] - center[1];
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    position: [
      center[0] + x * cos - y * sin,
      center[1] + x * sin + y * cos,
      current.position[2],
    ],
    target: [center[0], center[1], center[2]],
    up: current.up,
  };
}

export function orbitCameraAroundTarget(
  current: Viewport3DCameraState,
  deltaX: number,
  sensitivity: number,
): Viewport3DCameraState {
  return rotateCameraAroundCenter(
    current,
    current.target,
    -deltaX * sensitivity,
  );
}

export function normalizeDirection(direction: Direction3): Direction3 {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length === 0) {
    return [0, 0, 1];
  }

  return [
    direction[0] / length,
    direction[1] / length,
    direction[2] / length,
  ];
}
