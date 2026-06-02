import type { Viewport3DCameraState } from "../viewport3dStore";

export type Direction3 = [number, number, number];

const VIEWPORT_3D_ORIENTATION_WORLD_UP: Direction3 = [0, 0, 1];

export function resolveViewCubeCurrentCameraState({
  cameraPosition,
  cameraState,
  cameraUp,
  controlsTarget,
}: {
  cameraPosition: Direction3;
  cameraState: Viewport3DCameraState;
  cameraUp: Direction3;
  controlsTarget?: Direction3 | null;
}): Viewport3DCameraState {
  return {
    position: [...cameraPosition],
    target: [...(controlsTarget ?? cameraState.target)],
    up: [...cameraUp],
  };
}

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
    up: resolveCameraUpForDirection(normalized),
  };
}

export function freeCameraTargetForDirection(
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
    position: current.position,
    target: [
      current.position[0] - normalized[0] * distance,
      current.position[1] - normalized[1] * distance,
      current.position[2] - normalized[2] * distance,
    ],
    up: resolveCameraUpForDirection(normalized),
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

export function rotateFreeCameraTarget(
  current: Viewport3DCameraState,
  deltaX: number,
  sensitivity: number,
): Viewport3DCameraState {
  const radians = -deltaX * sensitivity;
  const nextDirection = rotateDirectionAroundAxis(
    [
      current.target[0] - current.position[0],
      current.target[1] - current.position[1],
      current.target[2] - current.position[2],
    ],
    [0, 0, 1],
    radians,
  );

  return {
    position: current.position,
    target: [
      current.position[0] + nextDirection[0],
      current.position[1] + nextDirection[1],
      current.position[2] + nextDirection[2],
    ],
    up: current.up,
  };
}

function rotateDirectionAroundAxis(
  direction: Direction3,
  axis: Direction3,
  radians: number,
): Direction3 {
  const normalizedAxis = normalizeDirection(axis);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dot =
    direction[0] * normalizedAxis[0] +
    direction[1] * normalizedAxis[1] +
    direction[2] * normalizedAxis[2];
  const cross: Direction3 = [
    normalizedAxis[1] * direction[2] - normalizedAxis[2] * direction[1],
    normalizedAxis[2] * direction[0] - normalizedAxis[0] * direction[2],
    normalizedAxis[0] * direction[1] - normalizedAxis[1] * direction[0],
  ];

  return [
    direction[0] * cos + cross[0] * sin + normalizedAxis[0] * dot * (1 - cos),
    direction[1] * cos + cross[1] * sin + normalizedAxis[1] * dot * (1 - cos),
    direction[2] * cos + cross[2] * sin + normalizedAxis[2] * dot * (1 - cos),
  ];
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

export function resolveCameraUpForDirection(direction: Direction3): Direction3 {
  void direction;
  return [...VIEWPORT_3D_ORIENTATION_WORLD_UP];
}
