import {
  beginViewport3DCameraGesture,
  cancelViewport3DCameraGesture,
  settleViewport3DCameraGesture,
  viewport3DCameraGestureActive,
  viewport3DCameraGestureEpoch,
  viewport3DCameraGestureSource,
  type Viewport3DCameraGestureRef,
} from "../layers/viewport3DCameraGesture";

export function beginOrientationCameraGesture(ref: Viewport3DCameraGestureRef): number {
  // A second click/drag is a new transaction, even if an earlier save is pending.
  if (viewport3DCameraGestureSource(ref) === "orientation-hud") {
    cancelViewport3DCameraGesture(ref);
  }
  return beginViewport3DCameraGesture(ref, "orientation-hud");
}

export async function commitOrientationCameraGesture(
  ref: Viewport3DCameraGestureRef,
  epoch: number,
  save: () => Promise<void> | void,
  onEnd?: (epoch: number) => void,
): Promise<void> {
  if (!viewport3DCameraGestureActive(ref) || viewport3DCameraGestureEpoch(ref) !== epoch) return;
  try {
    await save();
  } finally {
    // A late completion must not end a subsequent OrbitControls or HUD gesture.
    if (settleViewport3DCameraGesture(ref, epoch)) onEnd?.(epoch);
  }
}
