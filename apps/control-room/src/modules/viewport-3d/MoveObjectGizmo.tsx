"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  Viewport3DPrimitiveRenderModel,
  Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { type MoveAxis, type MoveCommitLockToken, type Translation3 } from "./moveCommitLock";
import {
  type GizmoSpace,
  type GizmoTransformMode,
  type GizmoTransformPatch,
  type MoveGestureControllerOptions,
  type MoveDraft,
  buildMergeSafeGizmoTransformPatch,
  createMoveGestureController,
  installMoveGestureTerminalListeners,
  moveAxisPointerHandlers,
  resolveGizmoAnchorPosition,
  resolveGizmoShortcutUpdate,
} from "./MoveObjectGizmo.model";

export type {
  GizmoSpace,
  GizmoTransformMode,
  GizmoTransformPatch,
  MoveAxis,
  MoveCommitLockToken,
  Translation3,
};

function MoveObjectGizmo({
  baseRevision,
  initialMode = "move",
  initialSpace = "world",
  object,
  onCommit,
  onTransformPatchCommit,
  onBeginGesture,
  onDraftChange,
  onGestureActiveChange,
}: {
  baseRevision: number;
  initialMode?: GizmoTransformMode;
  initialSpace?: GizmoSpace;
  object: Viewport3DPrimitiveObject;
  onCommit: MoveGestureControllerOptions["onCommit"];
  onTransformPatchCommit?: (
    objectId: string,
    patch: GizmoTransformPatch,
    baseRevision: number,
  ) => Promise<boolean | void> | boolean | void;
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
  const [mode, setMode] = useState<GizmoTransformMode>(initialMode);
  const [space, setSpace] = useState<GizmoSpace>(initialSpace);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const next = resolveGizmoShortcutUpdate(event.key, mode, space);
      if (!next) return;
      setMode(next.mode);
      setSpace(next.space);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, space]);

  const controller = useMemo(
    () =>
      createMoveGestureController({
        baseRevision,
        objectId: object.objectId,
        origin: [originX, originY, originZ],
        rotationQuat: object.transform?.rotationQuat,
        space,
        onBeginGesture,
        onCommit,
        ...(mode !== "move" && onTransformPatchCommit
          ? {
              onAxisCommit: async ({ axis, baseRevision: rev, delta, objectId: id }) => {
                const scaleRef = Math.max(Math.max(...object.bounds.size), 1e-12);
                const normalizedDelta = delta / scaleRef;
                const patch = buildMergeSafeGizmoTransformPatch({
                  axis,
                  currentTransform: {
                    pivot: object.transform?.pivot,
                    rotationQuat: object.transform?.rotationQuat,
                    scale: object.transform?.scale,
                    translation: [originX, originY, originZ],
                  },
                  delta: mode === "rotate" ? normalizedDelta * Math.PI : normalizedDelta,
                  mode,
                  space,
                });
                return onTransformPatchCommit(id, patch, rev);
              },
            }
          : {}),
        onDraftChange: (next) => {
          setDraft(next);
          onDraftChange?.(next);
        },
        onGestureActiveChange,
      }),
    [
      baseRevision,
      mode,
      object.bounds.size,
      object.objectId,
      object.transform?.pivot,
      object.transform?.rotationQuat,
      object.transform?.scale,
      onCommit,
      onTransformPatchCommit,
      onBeginGesture,
      onDraftChange,
      onGestureActiveChange,
      originX,
      originY,
      originZ,
      space,
    ],
  );

  useEffect(() => {
    return installMoveGestureTerminalListeners(controller, window);
  }, [controller]);

  const offset: Translation3 =
    mode === "move" && draft
      ? [
          draft.translation[0] - draft.origin[0],
          draft.translation[1] - draft.origin[1],
          draft.translation[2] - draft.origin[2],
        ]
      : [0, 0, 0];
  const length = Math.max(Math.max(...object.bounds.size) * 0.7, 1e-12);
  const localQuat =
    space === "local" && object.transform?.rotationQuat
      ? object.transform.rotationQuat
      : undefined;

  if (!colors) return null;
  return (
    <group
      name={`move-gizmo:${object.objectId}`}
      position={offset}
      quaternion={localQuat}
      userData={{ gizmo: mode, objectId: object.objectId, space }}
    >
      <mesh userData={{ draftPreview: true }}>
        <boxGeometry args={object.bounds.size} />
        <meshBasicMaterial color={colors.accent} opacity={0.22} transparent wireframe />
      </mesh>
      {(["x", "y", "z"] as const).map((axis, index) => {
        const axisColor = [colors.danger, colors.success, colors.accent][index];
        if (mode === "rotate") {
          return (
            <mesh
              key={axis}
              {...moveAxisPointerHandlers(controller, axis)}
              name={`rotate-axis:${axis}:${object.objectId}`}
              rotation={axisRotation(axis)}
              userData={{ axis, gizmo: "rotate-axis", objectId: object.objectId }}
            >
              <torusGeometry args={[length * 0.85, length * 0.03, 10, 32]} />
              <meshBasicMaterial color={axisColor} depthTest={false} />
            </mesh>
          );
        }
        return (
          <group key={axis}>
            <mesh
              {...moveAxisPointerHandlers(controller, axis)}
              name={`${mode}-axis:${axis}:${object.objectId}`}
              position={axisPosition(axis, length)}
              rotation={axisRotation(axis)}
              userData={{ axis, gizmo: `${mode}-axis`, objectId: object.objectId }}
            >
              <cylinderGeometry args={[length * 0.035, length * 0.035, length, 10]} />
              <meshBasicMaterial color={axisColor} depthTest={false} />
            </mesh>
            {mode === "scale" ? (
              <mesh
                {...moveAxisPointerHandlers(controller, axis)}
                name={`scale-tip:${axis}:${object.objectId}`}
                position={axisTipPosition(axis, length)}
                userData={{ axis, gizmo: "scale-tip", objectId: object.objectId }}
              >
                <boxGeometry args={[length * 0.14, length * 0.14, length * 0.14]} />
                <meshBasicMaterial color={axisColor} depthTest={false} />
              </mesh>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

export function Viewport3DMoveToolLayer({
  moveDraftResetRevision,
  moveToolObjectId,
  onCommit,
  onTransformPatchCommit,
  onBeginGesture,
  onGestureActiveChange,
  primitiveModel,
  selectedObjectId,
}: {
  moveDraftResetRevision: number;
  moveToolObjectId: string | null;
  onCommit: MoveGestureControllerOptions["onCommit"];
  onTransformPatchCommit?: (
    objectId: string,
    patch: GizmoTransformPatch,
    baseRevision: number,
  ) => Promise<boolean | void> | boolean | void;
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
  const anchorPosition = resolveGizmoAnchorPosition(object);
  return (
      <group
        key={`move:${object.objectId}:${moveDraftResetRevision}`}
        position={anchorPosition}
      >
        <MoveObjectGizmo
          baseRevision={primitiveModel.sceneRevision as number}
          object={object}
          onCommit={onCommit}
          onTransformPatchCommit={onTransformPatchCommit}
          onBeginGesture={onBeginGesture}
          onGestureActiveChange={onGestureActiveChange}
        />
      </group>
  );
}

function axisTipPosition(axis: MoveAxis, length: number): Translation3 {
  if (axis === "x") return [length, 0, 0];
  if (axis === "y") return [0, length, 0];
  return [0, 0, length];
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
