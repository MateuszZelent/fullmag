"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { useObjectMoveTool } from "@/kernel/authoring/ObjectMoveToolController";
import { useObjectEditSelector } from "@/kernel/authoring/object-edit/useObjectEditSelector";
import type { ObjectTranslation } from "@/kernel/authoring/objectTranslationMutation";
import {
  geometryDraftTranslationEquals,
  geometryObjectEditSessionTargetKey,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import { updateQuantityFieldSI } from "@/kernel/authoring/object-edit/quantityDraftFields";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { commitObjectTransformTransaction } from "@/kernel/authoring/geometryLifecycleCommands";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  sessionRequestScopeKey,
  sessionResourceIdentityKey,
  type SessionResourceIdentity,
} from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { selectionSnapshotEquals, type Selection } from "@/kernel/selection/selectionTypes";

import {
  isMoveCommitPending,
  tryAcquireMoveCommit,
  type MoveCommitLockToken,
  type MoveCommitHandler,
} from "./moveCommitLock";
import {
  Viewport3DMoveToolLayer,
  type GizmoTransformPatch,
} from "./MoveObjectGizmo";
import {
  buildViewport3DPrimitiveRenderModel,
  withObjectPlacementDraftPreview,
} from "./viewport3dPrimitiveModel";

interface ActiveMoveIdentity {
  activationId: number;
  sessionIdentityKey: string | null;
  selection: Selection;
  selectionEpoch: number;
}

interface CurrentMoveContext {
  moveTargetEligible: boolean;
  selectedObjectId: string | null;
  sessionId: string | null;
  sessionIdentity: SessionResourceIdentity | null;
  sessionIdentityKey: string | null;
  sessionScopeKey: string | null;
}

interface MoveRequestFence {
  activationId: number;
  objectId: string;
  selection: Selection;
  selectionEpoch: number;
  sessionIdentity: SessionResourceIdentity;
  sessionIdentityKey: string;
  sessionScopeKey: string;
}

const NO_MOVE_DRAFT_RESET = 0;

export function useViewport3DObjectMoveInteraction({
  moveTargetEligible,
  selectedObjectId,
  sessionId,
}: {
  moveTargetEligible: boolean;
  selectedObjectId: string | null;
  sessionId: string | null;
}) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const sceneSnapshotRef = useRef({ data: scene.data, status: scene.status });
  const moveTool = useObjectMoveTool(kernel.objectMoveTool);
  const sessionIdentity = useSessionResourceIdentity();
  const currentContextRef = useRef<CurrentMoveContext | null>(null);
  const sessionIdentityKey = sessionIdentity
    ? sessionResourceIdentityKey(sessionIdentity)
    : null;
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const activationIdentityRef = useRef<ActiveMoveIdentity | null>(null);
  const selectionEpochRef = useRef(0);
  const gestureTokenRef = useRef<number | null>(null);
  const selectionSnapshotRef = useRef<ReturnType<typeof kernel.selection.get> | null>(null);
  const [, forceSelectionRender] = useState(0);
  const [moveStatus, setMoveStatus] = useState<{
    error: string | null;
    objectId: string | null;
    sessionIdentityKey: string | null;
  }>({ error: null, objectId: null, sessionIdentityKey: null });
  const moveError =
    moveStatus.sessionIdentityKey === sessionIdentityKey &&
    moveStatus.objectId === selectedObjectId
      ? moveStatus.error
      : null;

  useEffect(() => {
    sceneSnapshotRef.current = { data: scene.data, status: scene.status };
    currentContextRef.current = {
      moveTargetEligible,
      selectedObjectId,
      sessionId,
      sessionIdentity,
      sessionIdentityKey,
      sessionScopeKey,
    };
  });

  const expireCanonicalActivation = useCallback(() => {
    activationIdentityRef.current = null;
    kernel.objectMoveTool.clear();
  }, [kernel.objectMoveTool]);

  useEffect(() => {
    if (selectionSnapshotRef.current === null) {
      selectionSnapshotRef.current = kernel.selection.get();
    }
    return kernel.selection.subscribe((selection) => {
      if (selectionSnapshotRef.current && selectionSnapshotEquals(selectionSnapshotRef.current, selection)) return;
      selectionSnapshotRef.current = selection;
      selectionEpochRef.current += 1;
      forceSelectionRender((revision) => revision + 1);
    });
  }, [kernel.selection]);

  useEffect(() => {
    if (!moveTool) {
      activationIdentityRef.current = null;
      return;
    }
    if (
      moveTool.objectId !== selectedObjectId ||
      !moveTargetEligible ||
      (sessionIdentity !== null && sessionId !== sessionIdentity.sessionId)
    ) {
      expireCanonicalActivation();
      return;
    }
    const activeIdentity = activationIdentityRef.current;
    if (!activeIdentity || activeIdentity.activationId !== moveTool.activationId) {
      activationIdentityRef.current = {
        activationId: moveTool.activationId,
        sessionIdentityKey,
        selection: kernel.selection.get(),
        selectionEpoch: selectionEpochRef.current,
      };
      return;
    }
    const selection = kernel.selection.get();
    if (
      activeIdentity.sessionIdentityKey === null &&
      sessionIdentityKey !== null &&
      activeIdentity.selectionEpoch === selectionEpochRef.current &&
      selectionSnapshotEquals(activeIdentity.selection, selection)
    ) {
      activeIdentity.sessionIdentityKey = sessionIdentityKey;
      return;
    }
    if (
      activeIdentity.sessionIdentityKey !== sessionIdentityKey ||
      activeIdentity.selectionEpoch !== selectionEpochRef.current ||
      !selectionSnapshotEquals(activeIdentity.selection, selection)
    ) expireCanonicalActivation();
  }, [
    expireCanonicalActivation,
    kernel.selection,
    moveTargetEligible,
    moveTool,
    selectedObjectId,
    sessionId,
    sessionIdentityKey,
    sessionIdentity,
  ]);

  useEffect(
    () => () => {
      kernel.objectMoveTool.clear();
    },
    [kernel.objectMoveTool],
  );

  const onBeginGesture = useCallback(() => {
    const current = currentContextRef.current;
    const currentScene = sceneSnapshotRef.current;
    const activeIdentity = activationIdentityRef.current;
    const activeTool = kernel.objectMoveTool.getSnapshot();
    const selection = kernel.selection.get();
    if (
      gestureTokenRef.current !== null ||
      !current?.sessionIdentity ||
      !current.sessionIdentityKey ||
      !current.sessionScopeKey ||
      !current.selectedObjectId ||
      current.sessionId !== current.sessionIdentity.sessionId ||
      !current.moveTargetEligible ||
      currentScene.status !== "ready" ||
      !activeTool ||
      activeTool.objectId !== current.selectedObjectId ||
      !activeIdentity ||
      activeIdentity.activationId !== activeTool.activationId ||
      activeIdentity.sessionIdentityKey !== current.sessionIdentityKey ||
      activeIdentity.selectionEpoch !== selectionEpochRef.current ||
      !selectionSnapshotEquals(activeIdentity.selection, selection) ||
      selection.objectId !== current.selectedObjectId
    ) return false;

    const canonicalDraft = resolveCommittedGeometryObjectDraft(
      currentScene.data,
      current.selectedObjectId,
    );
    if (!canonicalDraft || canonicalDraft.baseRevision === null) return false;

    const token = kernel.objectEditSession.beginGesture(
      current.sessionScopeKey,
      current.selectedObjectId,
    );
    if (token === null) return false;
    gestureTokenRef.current = token;
    return true;
  }, [kernel.objectEditSession, kernel.objectMoveTool, kernel.selection]);

  const onGestureActiveChange = useCallback((active: boolean) => {
    if (active) return;
    const token = gestureTokenRef.current;
    if (token === null) return;
    gestureTokenRef.current = null;
    kernel.objectEditSession.endGesture(token);
  }, [kernel.objectEditSession]);

  const isCurrentSessionScope = useCallback((fence: MoveRequestFence) => {
    const current = currentContextRef.current;
    if (
      !current ||
      current.sessionScopeKey !== fence.sessionScopeKey ||
      current.sessionIdentityKey !== fence.sessionIdentityKey
    ) return false;
    const registryScope = kernel.commands?.getSessionScopeKey?.();
    return registryScope === undefined || registryScope === fence.sessionScopeKey;
  }, [kernel.commands]);

  const isMoveRequestCurrent = useCallback((fence: MoveRequestFence) => {
    const current = currentContextRef.current;
    const active = activationIdentityRef.current;
    const selected = kernel.selection.get();
    const activeTool = kernel.objectMoveTool.getSnapshot();
    return Boolean(
      current &&
      current.moveTargetEligible &&
      current.selectedObjectId === fence.objectId &&
      current.sessionId === fence.sessionIdentity.sessionId &&
      current.sessionIdentityKey === fence.sessionIdentityKey &&
      current.sessionScopeKey === fence.sessionScopeKey &&
      isCurrentSessionScope(fence) &&
      activeTool?.activationId === fence.activationId &&
      activeTool.objectId === fence.objectId &&
      active?.activationId === fence.activationId &&
      active.sessionIdentityKey === fence.sessionIdentityKey &&
      active.selectionEpoch === fence.selectionEpoch &&
      selectionEpochRef.current === fence.selectionEpoch &&
      selectionSnapshotEquals(active.selection, selected) &&
      selectionSnapshotEquals(fence.selection, selected) &&
      selected.objectId === fence.objectId
    );
  }, [isCurrentSessionScope, kernel.objectMoveTool, kernel.selection]);

  const commitMoveRef = useRef<MoveCommitHandler | null>(null);
  const commitMove = useCallback((
    objectId: string,
    translation: ObjectTranslation,
    baseRevision: number,
    lock?: MoveCommitLockToken,
  ): boolean => {
    const activeTool = kernel.objectMoveTool.getSnapshot();
    const current = currentContextRef.current;
    const activeIdentity = activationIdentityRef.current;
    const selection = kernel.selection.get();
    const activationId = activeTool?.activationId;
    if (
      activationId === undefined ||
      !current?.sessionIdentity ||
      !current.sessionIdentityKey ||
      !current.sessionScopeKey ||
      current.sessionId !== current.sessionIdentity.sessionId ||
      current.selectedObjectId !== objectId ||
      !current.moveTargetEligible ||
      !activeTool ||
      activeTool.objectId !== objectId ||
      !activeIdentity ||
      activeIdentity.activationId !== activationId ||
      activeIdentity.sessionIdentityKey !== current.sessionIdentityKey ||
      activeIdentity.selectionEpoch !== selectionEpochRef.current ||
      !selectionSnapshotEquals(activeIdentity.selection, selection) ||
      selection.objectId !== objectId
    ) return true;

    if (kernel.objectEditSession.hasPendingWrite(current.sessionScopeKey)) return true;

    const fence: MoveRequestFence = {
      activationId,
      objectId,
      selection,
      selectionEpoch: selectionEpochRef.current,
      sessionIdentity: current.sessionIdentity,
      sessionIdentityKey: current.sessionIdentityKey,
      sessionScopeKey: current.sessionScopeKey,
    };
    const handler = commitMoveRef.current;
    const releaseCommit = lock?.lockHeldByGesture
      ? null
      : handler
        ? tryAcquireMoveCommit(handler)
        : null;
    if (!lock?.lockHeldByGesture && !releaseCommit) return false;
    if (lock?.lockHeldByGesture && (!handler || !isMoveCommitPending(handler))) {
      return false;
    }

    const reportError = (message: string) => {
      if (isMoveRequestCurrent(fence)) {
        setMoveStatus({
          error: message,
          objectId: fence.objectId,
          sessionIdentityKey: fence.sessionIdentityKey,
        });
      }
    };

    try {
      if (!isMoveRequestCurrent(fence)) return true;
      if (kernel.objectEditSession.hasPendingWrite(fence.sessionScopeKey)) return true;
      const currentScene = sceneSnapshotRef.current;
      if (currentScene.status !== "ready") {
        reportError("The scene is not ready. Refresh it, then move the object again.");
        return true;
      }

      const canonicalDraft = resolveCommittedGeometryObjectDraft(currentScene.data, objectId);
      if (
        !canonicalDraft ||
        canonicalDraft.baseRevision === null ||
        canonicalDraft.baseRevision !== baseRevision
      ) {
        reportError("The scene changed during the drag. Refresh it, then move the object again.");
        return true;
      }

      const targetKey = geometryObjectEditSessionTargetKey(
        fence.sessionScopeKey,
        canonicalDraft,
      );
      const identity = kernel.objectEditSession.activate({
        objectId,
        sessionScopeKey: fence.sessionScopeKey,
        targetKey,
      }, canonicalDraft);
      const snapshot = kernel.objectEditSession.getSnapshot();
      const currentDraft = snapshot.identity?.draftId === identity.draftId
        ? snapshot.draft
        : null;
      if (
        !currentDraft ||
        currentDraft.mode !== "committed" ||
        currentDraft.objectId !== objectId ||
        currentDraft.baseRevision !== baseRevision
      ) {
        reportError("The active object draft is stale. Revert or refresh it before moving the object.");
        return true;
      }

      const withMoveTranslation = (draft: GeometryObjectDraft) =>
        ([0, 1, 2] as const).reduce((next, axis) =>
          updateQuantityFieldSI(next, `translation.${axis}`, translation[axis]), draft);
      const nextDraft = withMoveTranslation(currentDraft);
      if (geometryDraftTranslationEquals(currentDraft, nextDraft)) {
        setMoveStatus({
          error: null,
          objectId: fence.objectId,
          sessionIdentityKey: fence.sessionIdentityKey,
        });
        return true;
      }
      if (
        !isMoveRequestCurrent(fence) ||
        kernel.objectEditSession.hasPendingWrite(fence.sessionScopeKey)
      ) return true;

      const updated = kernel.objectEditSession.updateDraft(identity, withMoveTranslation);
      if (!updated) {
        reportError("The object draft changed before the move could be staged. Try the move again.");
        return true;
      }
      setMoveStatus({
        error: null,
        objectId: fence.objectId,
        sessionIdentityKey: fence.sessionIdentityKey,
      });
      return true;
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
      return true;
    } finally {
      releaseCommit?.();
    }
  }, [
    isMoveRequestCurrent,
    kernel,
  ]);
  useEffect(() => {
    commitMoveRef.current = commitMove;
  }, [commitMove]);

  const commitTransformPatch = useCallback(
    async (
      objectId: string,
      patch: GizmoTransformPatch,
      baseRevision: number,
    ): Promise<boolean> => {
      const current = currentContextRef.current;
      if (!current?.sessionScopeKey || current.selectedObjectId !== objectId) {
        return false;
      }
      const response = await commitObjectTransformTransaction(
        kernel.api,
        objectId,
        {
          base_revision: baseRevision,
          transform: patch as unknown as Record<string, unknown>,
        } as unknown as Parameters<typeof commitObjectTransformTransaction>[2],
        { sessionScopeKey: current.sessionScopeKey },
      );
      const rev = acknowledgedAuthoringSceneRevision(response);
      publishCommittedSceneResource(
        kernel.resources,
        response.committed_scene,
        rev,
        undefined,
        false,
        current.sessionScopeKey,
        kernel.api.resourceCacheScope,
      );
      invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);
      return true;
    },
    [kernel.api, kernel.resources],
  );

  return {
    commitMove,
    commitTransformPatch,
    onBeginGesture,
    onGestureActiveChange,
    moveDraftResetRevision: NO_MOVE_DRAFT_RESET,
    moveError,
    moveToolObjectId: moveTool?.objectId ?? null,
  };
}

export function Viewport3DMoveStatus({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <aside className="fm-viewport-3d__move-conflict" aria-live="polite">
      <span role="alert">Move draft was not staged: {error}</span>
    </aside>
  );
}

/** Production integration boundary used by qualification tests without mounting WebGL. */
export function Viewport3DObjectMoveResourceSurface() {
  const kernel = useKernel();
  const scene = useSceneResource();
  const sessionIdentity = useSessionResourceIdentity();
  const editSnapshot = useObjectEditSelector(kernel.objectEditSession);
  const selectedObjectId = useSelectionSelector((selection) =>
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId ?? selection.objectId
      : null,
  );
  const primitiveModel = useMemo(
    () => buildViewport3DPrimitiveRenderModel(scene.data, null),
    [scene.data],
  );
  const primitiveModelWithPlacementDraft = useMemo(
    () => withObjectPlacementDraftPreview(
      primitiveModel,
      editSnapshot.draft,
      selectedObjectId,
    ),
    [editSnapshot.draft, primitiveModel, selectedObjectId],
  );
  const moveTargetEligible = primitiveModelWithPlacementDraft?.objects.some(
    (object) => object.objectId === selectedObjectId && object.role === "magnet",
  ) ?? false;
  const interaction = useViewport3DObjectMoveInteraction({
    moveTargetEligible,
    selectedObjectId,
    sessionId: sessionIdentity?.sessionId ?? null,
  });
  const onInteractionGestureActiveChange = interaction.onGestureActiveChange;
  const [orbitBlocked, setOrbitBlocked] = useState(false);
  const handleGestureActiveChange = useCallback((active: boolean) => {
    onInteractionGestureActiveChange(active);
    setOrbitBlocked(active);
  }, [onInteractionGestureActiveChange]);

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
        onBeginGesture={interaction.onBeginGesture}
        onGestureActiveChange={handleGestureActiveChange}
        primitiveModel={primitiveModelWithPlacementDraft ?? null}
        selectedObjectId={selectedObjectId}
      />
      <Viewport3DMoveStatus error={interaction.moveError} />
    </div>
  );
}
