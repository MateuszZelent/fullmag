/**
 * Camera sync machine.
 *
 * Manages transitions between camera modes (locked, free, fit-pending)
 * and produces camera state updates for the viewport store.
 */
import type { CameraState, CameraSyncMode, CameraSyncState } from "./cameraTypes";
import { DEFAULT_CAMERA, fitCamera, boundingSphere } from "./cameraTypes";

export function createCameraSyncState(): CameraSyncState {
  return { mode: "free", lastFitAt: null, pending: null };
}

export function requestFit(
  state: CameraSyncState,
  positions: Float64Array | Float32Array | number[],
  fov: number,
): CameraSyncState {
  const { center, radius } = boundingSphere(positions);
  const { position, target } = fitCamera(center, radius, fov);
  return {
    mode: "fit-pending",
    lastFitAt: Date.now(),
    pending: { ...DEFAULT_CAMERA, position, target, fov },
  };
}

export function commitFit(state: CameraSyncState): { next: CameraSyncState; camera: CameraState | null } {
  if (state.mode !== "fit-pending" || !state.pending) {
    return { next: state, camera: null };
  }
  return {
    next: { ...state, mode: "locked", pending: null },
    camera: state.pending,
  };
}

export function unlock(state: CameraSyncState): CameraSyncState {
  return { ...state, mode: "free", pending: null };
}
