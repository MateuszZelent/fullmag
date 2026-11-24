import { isMoveCommitPending, tryAcquireMoveCommit, type MoveAxis, type MoveCommitHandler, type Translation3 } from "./moveCommitLock";
import type { ThreeEvent } from "@react-three/fiber";
import { Plane, Quaternion, Vector3, type Ray } from "three";

export type GizmoTransformMode = "move" | "rotate" | "scale";
export type GizmoSpace = "world" | "local";

export interface GizmoTransformPatch {
  pivot?: Translation3;
  rotation_quat?: [number, number, number, number];
  scale?: Translation3;
  translation?: Translation3;
}

export function resolveGizmoAnchorPosition(object: {
  bounds: { center: Translation3 };
  transform?: { pivot?: Translation3; translation?: Translation3 };
}): Translation3 {
  const base = object.bounds.center;
  const pivot = object.transform?.pivot;
  if (!pivot) return base;
  return [base[0] + pivot[0], base[1] + pivot[1], base[2] + pivot[2]];
}

export function resolveGizmoAxisVector(
  axis: MoveAxis,
  space: GizmoSpace,
  rotationQuat?: [number, number, number, number],
): Vector3 {
  const vec =
    axis === "x"
      ? new Vector3(1, 0, 0)
      : axis === "y"
        ? new Vector3(0, 1, 0)
        : new Vector3(0, 0, 1);
  if (space === "local" && rotationQuat) {
    vec.applyQuaternion(new Quaternion(...rotationQuat)).normalize();
  }
  return vec;
}

/**
 * Build a merge-safe Transform3D partial patch for Move / Rotate / Scale gizmo gestures
 * so untouched transform components are never overwritten or zeroed.
 */
export function buildMergeSafeGizmoTransformPatch({
  axis,
  currentTransform,
  delta,
  mode,
  space,
}: {
  axis: MoveAxis;
  currentTransform: {
    pivot?: Translation3;
    rotationQuat?: [number, number, number, number];
    scale?: Translation3;
    translation: Translation3;
  };
  delta: number;
  mode: GizmoTransformMode;
  space: GizmoSpace;
}): GizmoTransformPatch {
  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  if (mode === "rotate") {
    const axisVec = resolveGizmoAxisVector(axis, space, currentTransform.rotationQuat);
    const deltaQuat = new Quaternion().setFromAxisAngle(axisVec, delta);
    const baseQuat = currentTransform.rotationQuat
      ? new Quaternion(...currentTransform.rotationQuat)
      : new Quaternion();
    const nextQuat =
      space === "local"
        ? baseQuat.clone().multiply(deltaQuat).normalize()
        : deltaQuat.clone().multiply(baseQuat).normalize();
    return {
      rotation_quat: [nextQuat.x, nextQuat.y, nextQuat.z, nextQuat.w],
    };
  }
  if (mode === "scale") {
    const baseScale: Translation3 = currentTransform.scale
      ? [...currentTransform.scale]
      : [1, 1, 1];
    baseScale[axisIndex] = Math.max(0.05, baseScale[axisIndex] * (1 + delta));
    return { scale: baseScale };
  }
  const axisVec = resolveGizmoAxisVector(axis, space, currentTransform.rotationQuat);
  return {
    translation: [
      currentTransform.translation[0] + axisVec.x * delta,
      currentTransform.translation[1] + axisVec.y * delta,
      currentTransform.translation[2] + axisVec.z * delta,
    ],
  };
}

export function resolveGizmoShortcutUpdate(
  key: string,
  currentMode: GizmoTransformMode,
  currentSpace: GizmoSpace,
): { mode: GizmoTransformMode; space: GizmoSpace } | null {
  const lower = key.toLowerCase();
  if (lower === "g") return { mode: "move", space: currentSpace };
  if (lower === "r") return { mode: "rotate", space: currentSpace };
  if (lower === "s") return { mode: "scale", space: currentSpace };
  if (lower === "l") {
    return {
      mode: currentMode,
      space: currentSpace === "world" ? "local" : "world",
    };
  }
  return null;
}

export interface MoveDraft {
  objectId: string;
  origin: Translation3;
  translation: Translation3;
}

export interface MoveGestureControllerOptions {
  baseRevision: number;
  objectId: string;
  onAxisCommit?: (payload: {
    axis: MoveAxis;
    baseRevision: number;
    delta: number;
    objectId: string;
    translation: Translation3;
  }) => Promise<boolean | void> | boolean | void;
  onCommit: MoveCommitHandler;
  onBeginGesture?: () => boolean;
  onDraftChange: (draft: MoveDraft | null) => void;
  onGestureActiveChange?: (active: boolean) => void;
  origin: Translation3;
  rotationQuat?: [number, number, number, number];
  space?: GizmoSpace;
}

export function createMoveGestureController({
  baseRevision,
  objectId,
  onAxisCommit,
  onCommit,
  onBeginGesture,
  onDraftChange,
  onGestureActiveChange,
  origin,
  rotationQuat,
  space = "world",
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
  let draggedAxis: MoveAxis = "x";
  let draggedDelta = 0;

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
      draggedAxis = axis;
      draggedDelta = 0;
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
        draggedDelta === 0 &&
        translation.length === origin.length &&
        translation.every((coordinate, index) => coordinate === origin[index])
      ) {
        onDraftChange(null);
        return;
      }
      const releaseCommit = tryAcquireMoveCommit(onCommit);
      if (!releaseCommit) return;
      try {
        const committed = onAxisCommit
          ? await onAxisCommit({
              axis: draggedAxis,
              baseRevision,
              delta: draggedDelta,
              objectId,
              translation: [...translation],
            })
          : await onCommit(objectId, [...translation], baseRevision, {
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
      const axisVec = resolveGizmoAxisVector(active.axis, space, rotationQuat);
      const dragVec = new Vector3(
        point[0] - active.start[0],
        point[1] - active.start[1],
        point[2] - active.start[2],
      );
      draggedAxis = active.axis;
      draggedDelta = dragVec.dot(axisVec);
      translation = [
        origin[0] + axisVec.x * draggedDelta,
        origin[1] + axisVec.y * draggedDelta,
        origin[2] + axisVec.z * draggedDelta,
      ];
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
