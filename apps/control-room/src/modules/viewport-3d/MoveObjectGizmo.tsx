"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { Plane, Vector3, type Ray } from "three";

import type {
  Viewport3DPrimitiveRenderModel,
  Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { useViewport3DColors } from "./hooks/useViewport3DColors";
import {
  isMoveCommitPending,
  tryAcquireMoveCommit,
  type MoveAxis,
  type MoveCommitHandler,
  type MoveCommitLockToken,
  type Translation3,
} from "./moveCommitLock";

export type { MoveAxis, MoveCommitHandler, MoveCommitLockToken, Translation3 };

export interface MoveDraft {
  objectId: string;
  origin: Translation3;
  translation: Translation3;
}

interface MoveGestureControllerOptions {
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
      if (translation.every((coordinate, index) => coordinate === origin[index])) {
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

export function MoveObjectGizmo({
  baseRevision,
  object,
  onCommit,
  onBeginGesture,
  onDraftChange,
  onGestureActiveChange,
}: {
  baseRevision: number;
  object: Viewport3DPrimitiveObject;
  onCommit: MoveGestureControllerOptions["onCommit"];
  onBeginGesture?: () => boolean;
  onDraftChange?: (draft: MoveDraft | null) => void;
  onGestureActiveChange?: (active: boolean) => void;
}) {
  // Theme tokens only: the gizmo waits for resolved Mocha/Latte colours
  // instead of drawing a hard-coded palette in the wrong theme.
  const { colors } = useViewport3DColors();
  const origin = object.translation ?? object.bounds.center;
  const [originX, originY, originZ] = origin;
  const [draft, setDraft] = useState<MoveDraft | null>(null);
  const controller = useMemo(
    () =>
      createMoveGestureController({
        baseRevision,
        objectId: object.objectId,
        origin: [originX, originY, originZ],
        onBeginGesture,
        onCommit,
        onDraftChange: (next) => {
          setDraft(next);
          onDraftChange?.(next);
        },
        onGestureActiveChange,
      }),
    [
      baseRevision,
      object.objectId,
      onCommit,
      onBeginGesture,
      onDraftChange,
      onGestureActiveChange,
      originX,
      originY,
      originZ,
    ],
  );

  useEffect(() => {
    return installMoveGestureTerminalListeners(controller, window);
  }, [controller]);

  const offset: Translation3 = draft
    ? [
        draft.translation[0] - draft.origin[0],
        draft.translation[1] - draft.origin[1],
        draft.translation[2] - draft.origin[2],
      ]
    : [0, 0, 0];
  const length = Math.max(Math.max(...object.bounds.size) * 0.7, 1e-12);

  if (!colors) return null;
  return (
    <group
      name={`move-gizmo:${object.objectId}`}
      position={offset}
      userData={{ gizmo: "move", objectId: object.objectId }}
    >
      <mesh userData={{ draftPreview: true }}>
        <boxGeometry args={object.bounds.size} />
        <meshBasicMaterial color={colors.accent} opacity={0.22} transparent wireframe />
      </mesh>
      {(["x", "y", "z"] as const).map((axis, index) => (
        <mesh
          {...moveAxisPointerHandlers(controller, axis)}
          key={axis}
          name={`move-axis:${axis}:${object.objectId}`}
          position={axisPosition(axis, length)}
          rotation={axisRotation(axis)}
          userData={{ axis, gizmo: "move-axis", objectId: object.objectId }}
        >
          <cylinderGeometry args={[length * 0.035, length * 0.035, length, 10]} />
          <meshBasicMaterial color={[colors.danger, colors.success, colors.accent][index]} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
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

export function Viewport3DMoveToolLayer({
  moveDraftResetRevision,
  moveToolObjectId,
  onCommit,
  onBeginGesture,
  onGestureActiveChange,
  primitiveModel,
  selectedObjectId,
}: {
  moveDraftResetRevision: number;
  moveToolObjectId: string | null;
  onCommit: MoveGestureControllerOptions["onCommit"];
  onBeginGesture?: () => boolean;
  onGestureActiveChange?: (active: boolean) => void;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  selectedObjectId: string | null;
}) {
  if (
    !selectedObjectId ||
    moveToolObjectId !== selectedObjectId ||
    primitiveModel?.sceneRevision == null
  ) return null;
  return primitiveModel.objects
    .filter((object) => object.objectId === selectedObjectId)
    .map((object) => (
      <group
        key={`move:${object.objectId}:${moveDraftResetRevision}`}
        position={object.bounds.center}
      >
        <MoveObjectGizmo
          baseRevision={primitiveModel.sceneRevision as number}
          object={object}
          onCommit={onCommit}
          onBeginGesture={onBeginGesture}
          onGestureActiveChange={onGestureActiveChange}
        />
      </group>
    ));
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

function axisPosition(axis: MoveAxis, length: number): Translation3 {
  if (axis === "x") return [length / 2, 0, 0];
  if (axis === "y") return [0, length / 2, 0];
  return [0, 0, length / 2];
}

function axisRotation(axis: MoveAxis): Translation3 {
  if (axis === "x") return [0, 0, -Math.PI / 2];
  if (axis === "z") return [Math.PI / 2, 0, 0];
  return [0, 0, 0];
}
