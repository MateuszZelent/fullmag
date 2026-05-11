import type { Viewport3DCameraState } from "../viewport3dStore";

export type Direction3 = [number, number, number];

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
  };
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
