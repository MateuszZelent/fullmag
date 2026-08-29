"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";

import type {
  Viewport3DPrimitiveRenderModel,
  Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { useViewport3DColors } from "./hooks/useViewport3DColors";
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
  ) => Promise<boolean | void> | boolean | void;
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
    | {
        axis: MoveAxis;
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
    ): void {
      if (active) cancelActive(false);
      active = { axis, pointerId, releasePointerCapture, start: [...point] };
      translation = [...origin];
      setPointerCapture(pointerId);
      onGestureActiveChange?.(true);
      publish();
    },
    cancel(): boolean {
      if (!active) return false;
      cancelActive(true);
      return true;
    },
    async end(pointerId: number): Promise<void> {
      if (!active || active.pointerId !== pointerId) return;
      releaseActiveCapture();
      const committed = await onCommit(objectId, [...translation], baseRevision);
      if (committed !== false) onDraftChange(null);
    },
    move(pointerId: number, point: Translation3): void {
      if (!active || active.pointerId !== pointerId) return;
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
  onDraftChange,
  onGestureActiveChange,
}: {
  baseRevision: number;
  object: Viewport3DPrimitiveObject;
  onCommit: MoveGestureControllerOptions["onCommit"];
  onDraftChange?: (draft: MoveDraft | null) => void;
  onGestureActiveChange?: (active: boolean) => void;
}) {
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
    return installMoveGestureTerminalListeners(controller, window);
  }, [controller]);

  if (!colors) return null;

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
  target.addEventListener("keydown", onKeyDown);
  return () => {
    controller.cancel();
    target.removeEventListener("keydown", onKeyDown);
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
      void endAxisDrag(controller, event),
  };
}

export function Viewport3DMoveToolLayer({
  moveDraftResetRevision,
  moveToolObjectId,
  onCommit,
  onGestureActiveChange,
  primitiveModel,
  selectedObjectId,
}: {
  moveDraftResetRevision: number;
  moveToolObjectId: string | null;
  onCommit: MoveGestureControllerOptions["onCommit"];
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
