interface Viewport3DCameraGestureState {
  active: boolean;
}

export interface Viewport3DCameraGestureRef {
  current: Viewport3DCameraGestureState;
}

export function createViewport3DCameraGestureRef(): Viewport3DCameraGestureRef {
  return { current: { active: false } };
}

export function beginViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
): void {
  if (!ref?.current) return;
  ref.current.active = true;
}

export function endViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
): void {
  if (!ref?.current) return;
  ref.current.active = false;
}

export function viewport3DCameraGestureActive(
  ref: Viewport3DCameraGestureRef | null | undefined,
): boolean {
  return ref?.current?.active === true;
}
