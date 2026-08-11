export type Viewport3DCameraProjection = "orthographic" | "perspective";

export type Viewport3DCameraTuple3 = readonly [number, number, number];

export interface Viewport3DLiveCameraSnapshot {
  orthographicScale: number | null;
  position: Viewport3DCameraTuple3;
  projection: Viewport3DCameraProjection;
  target: Viewport3DCameraTuple3;
  up: Viewport3DCameraTuple3;
}

const VIEWPORT_3D_CAMERA_RELATIVE_EPSILON = 1e-8;
const VIEWPORT_3D_CAMERA_MIN_LINEAR_EPSILON = 1e-15;
const VIEWPORT_3D_CAMERA_UP_ANGULAR_EPSILON = 1e-8;

export function resolveViewport3DCameraSnapshotScale(
  snapshot: Viewport3DLiveCameraSnapshot,
): number {
  return Math.max(
    vectorLength(vectorDifference(snapshot.position, snapshot.target)),
    Math.abs(snapshot.orthographicScale ?? 0),
    VIEWPORT_3D_CAMERA_MIN_LINEAR_EPSILON,
  );
}

export function resolveViewport3DCameraLinearTolerance(
  sceneScale: number,
): number {
  return Math.max(
    Math.abs(sceneScale) * VIEWPORT_3D_CAMERA_RELATIVE_EPSILON,
    VIEWPORT_3D_CAMERA_MIN_LINEAR_EPSILON,
  );
}

export function viewport3DCameraSnapshotsEqual(
  left: Viewport3DLiveCameraSnapshot,
  right: Viewport3DLiveCameraSnapshot,
  sceneScale = Math.max(
    resolveViewport3DCameraSnapshotScale(left),
    resolveViewport3DCameraSnapshotScale(right),
  ),
): boolean {
  if (left.projection !== right.projection) return false;

  const linearTolerance = resolveViewport3DCameraLinearTolerance(sceneScale);
  if (!vectorsNear(left.position, right.position, linearTolerance)) return false;
  if (!vectorsNear(left.target, right.target, linearTolerance)) return false;
  if (!directionsNear(left.up, right.up)) return false;

  if (left.orthographicScale === null || right.orthographicScale === null) {
    return left.orthographicScale === right.orthographicScale;
  }
  return (
    Math.abs(left.orthographicScale - right.orthographicScale) <=
    resolveViewport3DCameraLinearTolerance(
      Math.max(
        Math.abs(left.orthographicScale),
        Math.abs(right.orthographicScale),
      ),
    )
  );
}

function directionsNear(
  left: Viewport3DCameraTuple3,
  right: Viewport3DCameraTuple3,
): boolean {
  const leftLength = vectorLength(left);
  const rightLength = vectorLength(right);
  if (leftLength <= 0 || rightLength <= 0) return leftLength === rightLength;
  const cosine = Math.min(
    1,
    Math.max(
      -1,
      vectorDot(left, right) / (leftLength * rightLength),
    ),
  );
  return 1 - cosine <= VIEWPORT_3D_CAMERA_UP_ANGULAR_EPSILON;
}

function vectorDifference(
  left: Viewport3DCameraTuple3,
  right: Viewport3DCameraTuple3,
): Viewport3DCameraTuple3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function vectorDot(
  left: Viewport3DCameraTuple3,
  right: Viewport3DCameraTuple3,
): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function vectorLength(value: Viewport3DCameraTuple3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function vectorsNear(
  left: Viewport3DCameraTuple3,
  right: Viewport3DCameraTuple3,
  tolerance: number,
): boolean {
  return vectorLength(vectorDifference(left, right)) <= tolerance;
}
