"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";

import type { Viewport3DPrimitiveObject } from "./viewport3dPrimitiveModel";
export { PROBLEM_IR_03_RIGID_TRANSFORM_REASON } from "@/kernel/authoring/objectTranslationMutation";

export type MoveAxis = "x" | "y" | "z";
export type Translation3 = [number, number, number];

export interface MoveDraft {
  objectId: string;
  origin: Translation3;
  translation: Translation3;
}

interface MoveGestureControllerOptions {
  baseRevision: number;
  objectId: string;
  onCommit: (
    objectId: string,
    translation: Translation3,
    baseRevision: number,
  ) => Promise<void> | void;
  onDraftChange: (draft: MoveDraft | null) => void;
  onGestureActiveChange?: (active: boolean) => void;
  origin: Translation3;
}

export function createMoveGestureController({
  baseRevision,
  objectId,
  onCommit,
  onDraftChange,
  onGestureActiveChange,
  origin,
}: MoveGestureControllerOptions) {
  let active:
    | { axis: MoveAxis; pointerId: number; start: Translation3 }
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
    ): void {
      active = { axis, pointerId, start: [...point] };
      translation = [...origin];
      setPointerCapture(pointerId);
      onGestureActiveChange?.(true);
      publish();
    },
    cancel(): boolean {
      if (!active) return false;
      active = null;
      translation = [...origin];
      publish();
      onGestureActiveChange?.(false);
      return true;
    },
    async end(
      pointerId: number,
      releasePointerCapture: (pointerId: number) => void,
    ): Promise<void> {
      if (!active || active.pointerId !== pointerId) return;
      active = null;
      releasePointerCapture(pointerId);
      onGestureActiveChange?.(false);
      await onCommit(objectId, [...translation], baseRevision);
    },
    move(pointerId: number, point: Translation3): void {
      if (!active || active.pointerId !== pointerId) return;
      const axisIndex = active.axis === "x" ? 0 : active.axis === "y" ? 1 : 2;
      translation = [...origin];
      translation[axisIndex] += point[axisIndex] - active.start[axisIndex];
      publish();
    },
  };
}

export function MoveObjectGizmo({
  baseRevision,
  object,
  onCommit,
  onDraftChange,
  onGestureActiveChange,
}: {
  baseRevision: number;
  object: Viewport3DPrimitiveObject;
  onCommit: MoveGestureControllerOptions["onCommit"];
  onDraftChange?: (draft: MoveDraft | null) => void;
  onGestureActiveChange?: (active: boolean) => void;
}) {
  const origin = object.translation ?? object.bounds.center;
  const [originX, originY, originZ] = origin;
  const [draft, setDraft] = useState<MoveDraft | null>(null);
  const controller = useMemo(
    () =>
      createMoveGestureController({
        baseRevision,
        objectId: object.objectId,
        origin: [originX, originY, originZ],
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
      onDraftChange,
      onGestureActiveChange,
      originX,
      originY,
      originZ,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && controller.cancel()) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      controller.cancel();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [controller]);

  const offset: Translation3 = draft
    ? [
        draft.translation[0] - draft.origin[0],
        draft.translation[1] - draft.origin[1],
        draft.translation[2] - draft.origin[2],
      ]
    : [0, 0, 0];
  const length = Math.max(Math.max(...object.bounds.size) * 0.7, 1e-12);

  return (
    <group
      position={offset}
      userData={{ gizmo: "move", objectId: object.objectId }}
    >
      <mesh userData={{ draftPreview: true }}>
        <boxGeometry args={object.bounds.size} />
        <meshBasicMaterial color="#89b4fa" opacity={0.22} transparent wireframe />
      </mesh>
      {(["x", "y", "z"] as const).map((axis, index) => (
        <mesh
          key={axis}
          position={axisPosition(axis, length)}
          rotation={axisRotation(axis)}
          userData={{ axis, gizmo: "move-axis", objectId: object.objectId }}
          onPointerDown={(event) => beginAxisDrag(controller, axis, event)}
          onPointerMove={(event) => moveAxisDrag(controller, event)}
          onPointerUp={(event) => void endAxisDrag(controller, event)}
        >
          <cylinderGeometry args={[length * 0.035, length * 0.035, length, 10]} />
          <meshBasicMaterial color={["#f38ba8", "#a6e3a1", "#89b4fa"][index]} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

function eventPoint(event: ThreeEvent<PointerEvent>): Translation3 {
  return [event.point.x, event.point.y, event.point.z];
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
  );
}

function moveAxisDrag(
  controller: ReturnType<typeof createMoveGestureController>,
  event: ThreeEvent<PointerEvent>,
): void {
  event.stopPropagation();
  controller.move(event.pointerId, eventPoint(event));
}

async function endAxisDrag(
  controller: ReturnType<typeof createMoveGestureController>,
  event: ThreeEvent<PointerEvent>,
): Promise<void> {
  event.stopPropagation();
  const target = pointerTarget(event);
  await controller.end(event.pointerId, (pointerId) =>
    target.releasePointerCapture(pointerId),
  );
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
