import { isMoveCommitPending, tryAcquireMoveCommit, type MoveAxis, type MoveCommitHandler, type Translation3 } from "./moveCommitLock";
import type { ThreeEvent } from "@react-three/fiber";
import { Plane, Vector3, type Ray } from "three";

export interface MoveDraft {
  objectId: string;
  origin: Translation3;
  translation: Translation3;
}

export interface MoveGestureControllerOptions {
  baseRevision: number;
  objectId: string;
  onCommit: MoveCommitHandler;
  onBeginGesture?: () => boolean;
  onDraftChange: (draft: MoveDraft | null) => void;
  onGestureActiveChange?: (active: boolean) => void;
  origin: Translation3;
}

export function createMoveGestureController({
  baseRevision,
  objectId,
  onCommit,
  onBeginGesture,
  onDraftChange,
  onGestureActiveChange,
  origin,
}: MoveGestureControllerOptions) {
  let active:
    | {
        axis: MoveAxis;
        dragPlane: Plane | null;
        pointerId: number;
        releasePointerCapture: (pointerId: number) => void;
        start: Translation3;
      }
    | null = null;
  let translation: Translation3 = [...origin];

  const publish = () =>
    onDraftChange({ objectId, origin: [...origin], translation: [...translation] });

  return {
    begin(
      axis: MoveAxis,
      pointerId: number,
      point: Translation3,
      setPointerCapture: (pointerId: number) => void,
      releasePointerCapture: (pointerId: number) => void,
      ray?: Ray,
    ): void {
      if (active || isMoveCommitPending(onCommit)) return;
      if (onBeginGesture && !onBeginGesture()) return;
      try {
        setPointerCapture(pointerId);
      } catch {
        try {
          releasePointerCapture(pointerId);
        } catch {
          // R3F may have registered capture before native capture failed.
        }
        if (onBeginGesture) onGestureActiveChange?.(false);
        return;
      }
      active = {
        axis, pointerId, releasePointerCapture, start: [...point],
        dragPlane: ray
          ? new Plane().setFromNormalAndCoplanarPoint(ray.direction, new Vector3(...point))
          : null,
      };
      translation = [...origin];
      onGestureActiveChange?.(true);
      publish();
    },
    cancelPointer(pointerId: number): boolean {
      if (!active || active.pointerId !== pointerId) return false;
      cancelActive(true);
      return true;
    },
    cancel(): boolean {
      if (!active) return false;
      cancelActive(true);
      return true;
    },
    async end(pointerId: number): Promise<void> {
      if (!active || active.pointerId !== pointerId) return;
      releaseActiveCapture();
      if (
        translation.length === origin.length &&
        translation.every((coordinate, index) => coordinate === origin[index])
      ) {
        onDraftChange(null);
        return;
      }
      const releaseCommit = tryAcquireMoveCommit(onCommit);
      if (!releaseCommit) return;
      try {
        const committed = await onCommit(objectId, [...translation], baseRevision, {
          lockHeldByGesture: true,
        });
        if (committed !== false) onDraftChange(null);
      } finally {
        releaseCommit();
      }
    },
    move(pointerId: number, point: Translation3, ray?: Ray): void {
      if (!active || active.pointerId !== pointerId) return;
      if (ray && active.dragPlane) {
        const intersection = ray.intersectPlane(active.dragPlane, new Vector3());
        if (!intersection) return;
        point = [intersection.x, intersection.y, intersection.z];
      }
      const axisIndex = active.axis === "x" ? 0 : active.axis === "y" ? 1 : 2;
      translation = [...origin];
      translation[axisIndex] += point[axisIndex] - active.start[axisIndex];
      publish();
    },
  };

  function releaseActiveCapture(): void {
    const terminal = active;
    if (!terminal) return;
    active = null;
    try {
      terminal.releasePointerCapture(terminal.pointerId);
    } catch {
      // Capture may already have been released by the browser before lostpointercapture.
    }
    onGestureActiveChange?.(false);
  }

  function cancelActive(clearDraft: boolean): void {
    releaseActiveCapture();
    translation = [...origin];
    if (clearDraft) onDraftChange(null);
  }
}

export function installMoveGestureTerminalListeners(
  controller: ReturnType<typeof createMoveGestureController>,
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  const onKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Escape" && controller.cancel()) {
      keyboardEvent.preventDefault();
    }
  };
  const onPointerTerminated = (event: Event) => {
    controller.cancelPointer((event as PointerEvent).pointerId);
  };
  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("pointercancel", onPointerTerminated, true);
  target.addEventListener("lostpointercapture", onPointerTerminated, true);
  return () => {
    controller.cancel();
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("pointercancel", onPointerTerminated, true);
    target.removeEventListener("lostpointercapture", onPointerTerminated, true);
  };
}

export function moveAxisPointerHandlers(
  controller: ReturnType<typeof createMoveGestureController>,
  axis: MoveAxis,
) {
  return {
    onLostPointerCapture: (event: ThreeEvent<PointerEvent>) =>
      cancelAxisDrag(controller, event),
    onPointerCancel: (event: ThreeEvent<PointerEvent>) =>
      cancelAxisDrag(controller, event),
    onPointerDown: (event: ThreeEvent<PointerEvent>) =>
      beginAxisDrag(controller, axis, event),
    onPointerMove: (event: ThreeEvent<PointerEvent>) =>
      moveAxisDrag(controller, event),
    onPointerUp: (event: ThreeEvent<PointerEvent>) =>
      void endAxisDrag(controller, event).catch(() => undefined),
  };
}

function eventPoint(event: ThreeEvent<PointerEvent>): Translation3 {
  const point = event.point ??
    (event.nativeEvent as PointerEvent & {
      point?: { x: number; y: number; z: number };
    }).point;
  if (!point) return [0, 0, 0];
  return [point.x, point.y, point.z];
}

function pointerTarget(event: ThreeEvent<PointerEvent>): Element & {
  releasePointerCapture(pointerId: number): void;
  setPointerCapture(pointerId: number): void;
} {
  return event.target as Element & {
    releasePointerCapture(pointerId: number): void;
    setPointerCapture(pointerId: number): void;
  };
}

function beginAxisDrag(
  controller: ReturnType<typeof createMoveGestureController>,
  axis: MoveAxis,
  event: ThreeEvent<PointerEvent>,
): void {
  event.stopPropagation();
  const target = pointerTarget(event);
  controller.begin(axis, event.pointerId, eventPoint(event), (pointerId) =>
    target.setPointerCapture(pointerId),
    (pointerId) => target.releasePointerCapture(pointerId),
    event.ray,
  );
}

function moveAxisDrag(
  controller: ReturnType<typeof createMoveGestureController>,
  event: ThreeEvent<PointerEvent>,
): void {
  event.stopPropagation();
  controller.move(event.pointerId, eventPoint(event), event.ray);
}

async function endAxisDrag(
  controller: ReturnType<typeof createMoveGestureController>,
  event: ThreeEvent<PointerEvent>,
): Promise<void> {
  event.stopPropagation();
  await controller.end(event.pointerId);
}

function cancelAxisDrag(
  controller: ReturnType<typeof createMoveGestureController>,
  event: ThreeEvent<PointerEvent>,
): void {
  event.stopPropagation();
  controller.cancel();
}
