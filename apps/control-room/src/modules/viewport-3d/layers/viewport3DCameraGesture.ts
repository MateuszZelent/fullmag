import {
  beginViewport3DFieldUpdateHold,
  endViewport3DFieldUpdateHold,
} from "../viewport3dFieldUpdateHold";

interface Viewport3DCameraGestureState {
  active: boolean;
  fieldHoldActive: boolean;
  releaseTimeout: ReturnType<typeof setTimeout> | null;
}

export interface Viewport3DCameraGestureRef {
  current: Viewport3DCameraGestureState;
}

export const VIEWPORT_3D_CAMERA_FIELD_UPDATE_RELEASE_DELAY_MS = 150;

export function createViewport3DCameraGestureRef(): Viewport3DCameraGestureRef {
  return { current: { active: false, fieldHoldActive: false, releaseTimeout: null } };
}

export function beginViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
): void {
  if (!ref?.current) return;
  if (ref.current.releaseTimeout) {
    clearTimeout(ref.current.releaseTimeout);
    ref.current.releaseTimeout = null;
  }
  if (!ref.current.fieldHoldActive) {
    beginViewport3DFieldUpdateHold();
    ref.current.fieldHoldActive = true;
  }
  ref.current.active = true;
}

export function endViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
): void {
  if (!ref?.current) return;
  ref.current.active = false;
  if (!ref.current.fieldHoldActive) return;
  if (ref.current.releaseTimeout) {
    clearTimeout(ref.current.releaseTimeout);
  }
  ref.current.releaseTimeout = setTimeout(() => {
    ref.current.releaseTimeout = null;
    if (!ref.current.fieldHoldActive) return;
    ref.current.fieldHoldActive = false;
    endViewport3DFieldUpdateHold();
  }, VIEWPORT_3D_CAMERA_FIELD_UPDATE_RELEASE_DELAY_MS);
}

export function viewport3DCameraGestureActive(
  ref: Viewport3DCameraGestureRef | null | undefined,
): boolean {
  return ref?.current?.active === true;
}
