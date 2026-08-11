import {
  beginViewport3DFieldUpdateHold,
  endViewport3DFieldUpdateHold,
} from "../viewport3dFieldUpdateHold";

export type Viewport3DCameraGestureSource =
  | "debug"
  | "fit"
  | "legacy"
  | "orbit"
  | "orientation-hud"
  | "pan"
  | "projection"
  | "reset"
  | "wheel";

interface Viewport3DCameraGestureState {
  active: boolean;
  changed: boolean;
  disposed: boolean;
  epoch: number;
  fieldHoldActive: boolean;
  source: Viewport3DCameraGestureSource | null;
}

export interface Viewport3DCameraGestureRef {
  current: Viewport3DCameraGestureState;
}

export function createViewport3DCameraGestureRef(): Viewport3DCameraGestureRef {
  return {
    current: {
      active: false,
      changed: false,
      disposed: false,
      epoch: 0,
      fieldHoldActive: false,
      source: null,
    },
  };
}

export function beginViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
  source: Viewport3DCameraGestureSource = "legacy",
): number {
  if (!ref?.current || ref.current.disposed) return -1;
  if (ref.current.active && ref.current.source === source) {
    return ref.current.epoch;
  }

  ref.current.epoch += 1;
  ref.current.active = true;
  ref.current.changed = false;
  ref.current.source = source;
  if (!ref.current.fieldHoldActive) {
    beginViewport3DFieldUpdateHold();
    ref.current.fieldHoldActive = true;
  }
  return ref.current.epoch;
}

export function markViewport3DCameraGestureChanged(
  ref: Viewport3DCameraGestureRef | null | undefined,
  epoch: number,
): boolean {
  if (!isCurrentActiveEpoch(ref, epoch)) return false;
  ref.current.changed = true;
  return true;
}

export function settleViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
  epoch: number,
): boolean {
  if (!isCurrentActiveEpoch(ref, epoch)) return false;
  finishViewport3DCameraGesture(ref.current);
  return true;
}

export function cancelViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
  epoch = ref?.current?.epoch ?? -1,
): boolean {
  if (!isCurrentActiveEpoch(ref, epoch)) return false;
  finishViewport3DCameraGesture(ref.current);
  return true;
}

export function disposeViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
): void {
  if (!ref?.current || ref.current.disposed) return;
  if (ref.current.active || ref.current.fieldHoldActive) {
    finishViewport3DCameraGesture(ref.current);
  }
  ref.current.disposed = true;
}

export function endViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef | null | undefined,
): void {
  if (!ref?.current) return;
  settleViewport3DCameraGesture(ref, ref.current.epoch);
}

export function viewport3DCameraGestureActive(
  ref: Viewport3DCameraGestureRef | null | undefined,
): boolean {
  return ref?.current?.active === true;
}

export function viewport3DCameraGestureChanged(
  ref: Viewport3DCameraGestureRef | null | undefined,
  epoch: number,
): boolean {
  return isCurrentActiveEpoch(ref, epoch) && ref.current.changed;
}

export function viewport3DCameraGestureEpoch(
  ref: Viewport3DCameraGestureRef | null | undefined,
): number {
  return ref?.current?.epoch ?? -1;
}

export function viewport3DCameraGestureSource(
  ref: Viewport3DCameraGestureRef | null | undefined,
): Viewport3DCameraGestureSource | null {
  return ref?.current?.source ?? null;
}

function finishViewport3DCameraGesture(
  state: Viewport3DCameraGestureState,
): void {
  state.active = false;
  state.changed = false;
  state.source = null;
  if (!state.fieldHoldActive) return;
  state.fieldHoldActive = false;
  endViewport3DFieldUpdateHold();
}

function isCurrentActiveEpoch(
  ref: Viewport3DCameraGestureRef | null | undefined,
  epoch: number,
): ref is Viewport3DCameraGestureRef {
  return (
    ref?.current?.disposed === false &&
    ref.current.active &&
    ref.current.epoch === epoch
  );
}
