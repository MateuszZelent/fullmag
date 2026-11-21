"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  Viewport3DPrimitiveRenderModel,
  Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { type MoveAxis, type MoveCommitLockToken, type Translation3 } from "./moveCommitLock";
import { type MoveGestureControllerOptions, type MoveDraft, createMoveGestureController, installMoveGestureTerminalListeners, moveAxisPointerHandlers } from "./MoveObjectGizmo.model";

export type { MoveAxis, MoveCommitLockToken, Translation3 };

function MoveObjectGizmo({
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
  const object = primitiveModel.objects.find(
    (candidate) => candidate.objectId === selectedObjectId,
  );
  if (!object) return null;
  return (
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
