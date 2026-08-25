"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  commitObjectMoveWorkflow,
  rebaseObjectMoveConflict,
  type ObjectMoveConflict,
} from "@/kernel/authoring/objectMoveConflictWorkflow";
import { useObjectMoveTool } from "@/kernel/authoring/ObjectMoveToolController";
import type { ObjectTranslation } from "@/kernel/authoring/objectTranslationMutation";
import { Button } from "@/shared/ui/Button";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";

import { Viewport3DMoveToolLayer } from "./MoveObjectGizmo";
import { buildViewport3DPrimitiveRenderModel } from "./viewport3dPrimitiveModel";

interface ActiveMoveIdentity {
  activationId: number;
  sessionId: string | null;
}

export interface Viewport3DMoveConflict extends ObjectMoveConflict {
  activationId: number;
  sessionId: string | null;
}

export function useViewport3DObjectMoveInteraction({
  moveTargetEligible,
  sceneRefetch,
  sceneRevision,
  sceneStatus,
  selectedObjectId,
  sessionId,
}: {
  moveTargetEligible: boolean;
  sceneRefetch: () => void;
  sceneRevision: number | null;
  sceneStatus: string;
  selectedObjectId: string | null;
  sessionId: string | null;
}) {
  const kernel = useKernel();
  const moveTool = useObjectMoveTool(kernel.objectMoveTool);
  const activationIdentityRef = useRef<ActiveMoveIdentity | null>(null);
  const [moveConflict, setMoveConflict] =
    useState<Viewport3DMoveConflict | null>(null);
  const [moveDraftResetRevision, setMoveDraftResetRevision] = useState(0);

  const expire = useCallback(() => {
    activationIdentityRef.current = null;
    setMoveConflict(null);
    setMoveDraftResetRevision((revision) => revision + 1);
    kernel.objectMoveTool.clear();
  }, [kernel.objectMoveTool]);
  const expireCanonicalActivation = useCallback(() => {
    activationIdentityRef.current = null;
    kernel.objectMoveTool.clear();
  }, [kernel.objectMoveTool]);

  useEffect(() => {
    if (!moveTool) {
      activationIdentityRef.current = null;
      return;
    }
    if (
      moveTool.objectId !== selectedObjectId ||
      !moveTargetEligible
    ) {
      expireCanonicalActivation();
      return;
    }
    const activeIdentity = activationIdentityRef.current;
    if (!activeIdentity || activeIdentity.activationId !== moveTool.activationId) {
      activationIdentityRef.current = {
        activationId: moveTool.activationId,
        sessionId,
      };
      return;
    }
    if (activeIdentity.sessionId === null && sessionId !== null) {
      activeIdentity.sessionId = sessionId;
      return;
    }
    if (activeIdentity.sessionId !== sessionId) expireCanonicalActivation();
  }, [
    expireCanonicalActivation,
    moveTargetEligible,
    moveTool,
    selectedObjectId,
    sessionId,
  ]);

  useEffect(
    () => () => {
      kernel.objectMoveTool.clear();
    },
    [kernel.objectMoveTool],
  );

  const targetIsCurrent = useCallback(
    (objectId: string, activationId: number) =>
      moveTool?.activationId === activationId &&
      moveTool.objectId === objectId &&
      selectedObjectId === objectId &&
      moveTargetEligible &&
      activationIdentityRef.current?.sessionId === sessionId,
    [moveTargetEligible, moveTool, selectedObjectId, sessionId],
  );
  const activeMoveConflict =
    moveConflict &&
    moveTool?.activationId === moveConflict.activationId &&
    moveTool.objectId === moveConflict.objectId &&
    selectedObjectId === moveConflict.objectId &&
    moveTargetEligible &&
    moveConflict.sessionId === sessionId
      ? moveConflict
      : null;

  const commitMove = useCallback(async (
    objectId: string,
    translation: ObjectTranslation,
    baseRevision: number,
  ) => {
    const activationId = moveTool?.activationId;
    if (activationId === undefined || !targetIsCurrent(objectId, activationId)) {
      expire();
      return false;
    }
    return commitObjectMoveWorkflow({
      api: kernel.api,
      baseRevision,
      objectId,
      onAcknowledged: () => {
        setMoveConflict(null);
        setMoveDraftResetRevision((revision) => revision + 1);
      },
      onConflict: (conflict) => {
        if (targetIsCurrent(objectId, activationId)) {
          setMoveConflict({ ...conflict, activationId, sessionId });
        }
      },
      resources: kernel.resources,
      translation,
    });
  }, [expire, kernel.api, kernel.resources, moveTool?.activationId, sessionId, targetIsCurrent]);

  const refetchMoveScene = useCallback(() => {
    if (!activeMoveConflict) {
      expire();
      return;
    }
    sceneRefetch();
  }, [activeMoveConflict, expire, sceneRefetch]);

  const rebaseMove = useCallback(() => {
    if (
      !activeMoveConflict ||
      sceneStatus !== "ready" ||
      sceneRevision === null ||
      sceneRevision === activeMoveConflict.baseRevision
    ) return;
    setMoveConflict({
      ...rebaseObjectMoveConflict(activeMoveConflict, sceneRevision),
      activationId: activeMoveConflict.activationId,
      sessionId: activeMoveConflict.sessionId,
    });
  }, [activeMoveConflict, sceneRevision, sceneStatus]);

  const retryMove = useCallback(async () => {
    if (
      !activeMoveConflict ||
      activeMoveConflict.phase !== "rebased"
    ) {
      if (moveConflict) expire();
      return;
    }
    const retry = { ...activeMoveConflict, phase: "retrying" as const };
    setMoveConflict(retry);
    await commitMove(retry.objectId, retry.translation, retry.baseRevision);
  }, [activeMoveConflict, commitMove, expire, moveConflict]);

  const canRebase = Boolean(
    activeMoveConflict?.phase === "conflict" &&
      sceneStatus === "ready" &&
      sceneRevision !== null &&
      sceneRevision !== activeMoveConflict.baseRevision,
  );

  return {
    canRebase,
    commitMove,
    moveConflict: activeMoveConflict,
    moveDraftResetRevision,
    moveToolObjectId: moveTool?.objectId ?? null,
    rebaseMove,
    refetchMoveScene,
    retryMove,
    sceneStatus,
  };
}

export function Viewport3DMoveConflictPanel({
  interaction,
}: {
  interaction: ReturnType<typeof useViewport3DObjectMoveInteraction>;
}) {
  const { moveConflict } = interaction;
  if (!moveConflict) return null;
  return (
    <aside
      className="fm-viewport-3d__move-conflict"
      data-move-conflict={moveConflict.phase}
    >
      <span>Scene changed. The move draft is preserved.</span>
      <Button
        disabled={
          moveConflict.phase !== "conflict" ||
          interaction.sceneStatus === "loading" ||
          interaction.sceneStatus === "stale"
        }
        size="sm"
        type="button"
        variant="ghost"
        onClick={interaction.refetchMoveScene}
      >
        Refetch Scene
      </Button>
      <Button
        disabled={!interaction.canRebase}
        size="sm"
        type="button"
        variant="ghost"
        onClick={interaction.rebaseMove}
      >
        Rebase Draft
      </Button>
      <Button
        disabled={moveConflict.phase !== "rebased"}
        size="sm"
        type="button"
        variant="primary"
        onClick={() => void interaction.retryMove()}
      >
        Retry Move
      </Button>
    </aside>
  );
}

/** Production integration boundary used by qualification tests without mounting WebGL. */
export function Viewport3DObjectMoveResourceSurface() {
  const scene = useSceneResource();
  const sessionIdentity = useSessionResourceIdentity();
  const selectedObjectId = useSelectionSelector((selection) =>
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId ?? selection.objectId
      : null,
  );
  const primitiveModel = useMemo(
    () => buildViewport3DPrimitiveRenderModel(scene.data, null),
    [scene.data],
  );
  const moveTargetEligible = primitiveModel.objects.some(
    (object) => object.objectId === selectedObjectId && object.role === "magnet",
  );
  const interaction = useViewport3DObjectMoveInteraction({
    moveTargetEligible,
    sceneRefetch: scene.refetch,
    sceneRevision: primitiveModel.sceneRevision,
    sceneStatus: scene.status,
    selectedObjectId,
    sessionId: sessionIdentity?.sessionId ?? null,
  });
  const [orbitBlocked, setOrbitBlocked] = useState(false);

  return (
    <div
      className="fm-viewport-3d__move-resource-surface"
      data-draft-reset-revision={interaction.moveDraftResetRevision}
      data-orbit-blocked={orbitBlocked ? "true" : "false"}
      data-scene-status={scene.status}
    >
      <Viewport3DMoveToolLayer
        moveDraftResetRevision={interaction.moveDraftResetRevision}
        moveToolObjectId={interaction.moveToolObjectId}
        onCommit={interaction.commitMove}
        onGestureActiveChange={setOrbitBlocked}
        primitiveModel={primitiveModel}
        selectedObjectId={selectedObjectId}
      />
      <Viewport3DMoveConflictPanel interaction={interaction} />
    </div>
  );
}
