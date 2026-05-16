/**
 * Camera controller types and sync machine for viewport-core.
 *
 * The camera state machine owns the camera position/target/up and syncs
 * it between FDM and FEM viewport contexts. fitCamera() computes a
 * bounding-sphere fit used by the auto-fit logic.
 */

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  near: number;
  far: number;
  zoom: number;
}

export type CameraSyncMode = "locked" | "free" | "fit-pending";

export interface CameraSyncState {
  mode: CameraSyncMode;
  lastFitAt: number | null;
  pending: CameraState | null;
}

export const DEFAULT_CAMERA: CameraState = {
  position: [0, 0, 5],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov: 50,
  near: 0.01,
  far: 1000,
  zoom: 1,
};

/**
 * Compute camera position to fit a bounding sphere into the viewport.
 */
export function fitCamera(
  center: [number, number, number],
  radius: number,
  fov: number,
): Pick<CameraState, "position" | "target"> {
  const distance = radius / Math.tan((fov * Math.PI) / 360);
  return {
    target: center,
    position: [center[0], center[1], center[2] + distance],
  };
}

/**
 * Compute the bounding sphere of a set of 3D points (flat array [x,y,z,...]).
 */
export function boundingSphere(
  positions: Float64Array | Float32Array | number[],
): { center: [number, number, number]; radius: number } {
  const n = positions.length / 3;
  if (n === 0) {
    return { center: [0, 0, 0], radius: 1 };
  }

  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;

  let maxR2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    maxR2 = Math.max(maxR2, dx * dx + dy * dy + dz * dz);
  }

  return { center: [cx, cy, cz], radius: Math.sqrt(maxR2) };
}
