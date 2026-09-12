import type { SceneCameraHandle } from "./cameraOrientation";
import type { ViewportCameraState } from "@/features/workspace-graph";

export function captureViewportCameraState(
  bridge: SceneCameraHandle | null | undefined,
  metadata?: {
    projection?: "perspective" | "orthographic" | null;
    navigation?: "trackball" | "cad" | null;
    lastFocusedObjectId?: string | null;
  },
): ViewportCameraState | null {
  const camera = bridge?.camera ?? null;
  const controls = bridge?.controls ?? null;
  if (!camera || !controls) {
    return null;
  }
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    up: [camera.up.x, camera.up.y, camera.up.z],
    target: [controls.target.x, controls.target.y, controls.target.z],
    projection: metadata?.projection ?? null,
    navigation: metadata?.navigation ?? null,
    lastFocusedObjectId: metadata?.lastFocusedObjectId ?? null,
  };
}

export function restoreViewportCameraState(
  bridge: SceneCameraHandle | null | undefined,
  state: ViewportCameraState | null | undefined,
): boolean {
  const camera = bridge?.camera ?? null;
  const controls = bridge?.controls ?? null;
  if (!camera || !controls || !state) {
    return false;
  }
  camera.position.set(...state.position);
  camera.up.set(...state.up);
  controls.target.set(...state.target);
  camera.lookAt(...state.target);
  controls.update();
  return true;
}
