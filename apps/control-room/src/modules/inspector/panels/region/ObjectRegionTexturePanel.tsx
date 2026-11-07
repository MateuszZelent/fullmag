"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AuthoringTransactionResponse } from "@/kernel/api/apiTypes";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  publishCommittedSceneResource,
  SCENE_RESOURCE_KEY,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  resolveActiveLaneOperation,
  useActiveLaneCapabilities,
  type ActiveLaneOperationResolution,
} from "@/kernel/resources/useActiveLaneCapabilities";
import {
  ObjectRegionMetadataSection,
  type RegionAuxiliaryDraftSession,
  type RegionSubPanelProps,
} from "./shared";
import {
  buildObjectMagneticTextureAssetDraft,
  buildMagnetizationApplyTarget,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftDirty,
  objectMagneticTextureDraftIdentityKey,
  objectMagneticTextureDraftKey,
  resolveObjectMagneticTexturePanelModel,
  type ObjectMagneticTextureDraft,
} from "../ObjectMagneticTexturePanelModel";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "../inspectorDraftState";
import {
  MagneticTextureAssignmentSection,
  MagneticTexturePresetParametersSection,
  MagneticTextureRawAssetSection,
  MagneticTextureActionsSection,
  type MagneticTextureFeedback,
} from "../ObjectMagneticTexturePanel";
import {
  commitMagneticTextureApply,
  magneticTextureApplyMessage,
  syncAuthoringScriptBestEffort,
} from "../ObjectMagneticTexturePanelViewModel";
import type { Selection, RegionVisualizationTargetId } from "@/kernel/selection/selectionTypes";

export function ObjectRegionTexturePanel({
  model: regionModel,
  meshLane = "unknown",
  auxiliaryDraftOwnerKey,
  reportAuxiliaryDraftSession,
}: RegionSubPanelProps) {
  const kernel = useKernel();
  const { api, authoringHistory, commands, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const activeLane = useActiveLaneCapabilities();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();
  
  const selection = useMemo<Selection>(() => ({
    kind: "object.region.texture",
    label: "Texture",
    moduleSource: "inspector",
    nodeId: null,
    objectId: regionModel.objectId,
    ref: {
      kind: "object.region.texture",
      nodeId: "",
      objectId: regionModel.objectId,
      regionId: regionModel.regionId ?? "",
      type: "scene-object",
      visualizationTargetId: `region:${regionModel.objectId}:${encodeURIComponent(regionModel.regionId ?? "")}` as RegionVisualizationTargetId,
    },
  }), [regionModel.objectId, regionModel.regionId]);

  const model = useMemo(
    () =>
      resolveObjectMagneticTexturePanelModel(
        selection,
        scene.data,
        regions.data,
      ),
    [regions.data, scene.data, selection],
  );

  const baseDraft = useMemo(
    () => objectMagneticTextureDraftFromModel(model),
    [model],
  );
  const draftKey = objectMagneticTextureDraftKey(model);
  const draftIdentityKey = objectMagneticTextureDraftIdentityKey(model);
  const resourceRevision = model.baseRevision ?? -1;
  const [acknowledgedBaseline, setAcknowledgedBaseline] = useState<{
    draft: ObjectMagneticTextureDraft;
    identityKey: string;
    revision: number;
  }>({ draft: baseDraft, identityKey: draftIdentityKey, revision: resourceRevision });
  const baselineDraft = acknowledgedBaseline.identityKey === draftIdentityKey &&
    resourceRevision < acknowledgedBaseline.revision
    ? acknowledgedBaseline.draft
    : baseDraft;
  const [draftState, setDraftState] = useState<
    InspectorDraftState<ObjectMagneticTextureDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey: draftKey,
      identityKey: draftIdentityKey,
    }),
  );
  const draftStateRef = useRef(draftState);
  useLayoutEffect(() => {
    draftStateRef.current = draftState;
  }, [draftState]);
  const [feedback, setFeedback] = useState<MagneticTextureFeedback>(null);
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    sessionScopeKey: string | null;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey;
  const resolvedDraftState = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: objectMagneticTextureDraftDirty,
    state: draftState,
  });
  const draft = resolvedDraftState.draft;
  const dirty = objectMagneticTextureDraftDirty(draft, baselineDraft);
  const mutationInFlight = useRef(false);
  const textureCapabilityOperation =
    draft.presetKind === "uniform"
      ? "initial_magnetization.uniform"
      : draft.presetKind === "vortex"
        ? "initial_magnetization.vortex"
        : null;
  const textureCapability: ActiveLaneOperationResolution | null =
    textureCapabilityOperation
      ? resolveActiveLaneOperation(activeLane, textureCapabilityOperation)
      : null;

  function replaceDraftState(next: InspectorDraftState<ObjectMagneticTextureDraft>): void {
    draftStateRef.current = next;
    setDraftState(next);
  }

  function updateDraft(patch: Partial<ObjectMagneticTextureDraft>): void {
    replaceDraftState(
      updateInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        currentDraft: draft,
        identityKey: draftIdentityKey,
        isDirty: objectMagneticTextureDraftDirty,
        patch,
      }),
    );
  }

  function publishTextureCommit(response: AuthoringTransactionResponse, scopeKey: string): number {
    const revision = acknowledgedAuthoringSceneRevision(response);
    publishCommittedSceneResource(resources, response.committed_scene, revision,
      undefined, false, scopeKey, api.resourceCacheScope);
    invalidateAuthoringMutationDependents(resources, "magnetization", revision);
    return revision;
  }

  function createHistoryMutationContext() {
    const operationSessionScopeKey = sessionScopeKey;
    const historyGeneration = authoringHistory?.getGeneration?.();
    return {
      api,
      authoringHistory,
      resourceData: { [SCENE_RESOURCE_KEY]: scene.data },
      sessionScopeKey: operationSessionScopeKey,
      isCurrentSessionScope: () =>
        commands.getSessionScopeKey() === operationSessionScopeKey &&
        (historyGeneration === undefined ||
          authoringHistory?.getGeneration?.() === historyGeneration),
    };
  }

  function beginPendingOperation(): number {
    const operationId = ++nextPendingOperationId.current;
    setPendingOperation({ id: operationId, sessionScopeKey });
    return operationId;
  }

  function finishPendingOperation(operationId: number): void {
    setPendingOperation((current) =>
      current?.id === operationId ? null : current,
    );
  }

  async function saveTexture(
    draftToApply: ObjectMagneticTextureDraft | null = draft,
  ): Promise<boolean> {
    const submittedDraft = draftToApply ?? draft;
    if (mutationInFlight.current) return false;
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return false;
    }
    if (draftToApply && textureCapability && !textureCapability.enabled) {
      setFeedback({ kind: "error", message: textureCapability.reason });
      return false;
    }
    if (!model.regionId || !model.authoredRegion) {
      setFeedback({ kind: "error", message: "Select an authored magnetic region to apply its texture." });
      return false;
    }
    const historyContext = createHistoryMutationContext();
    if (!historyContext.sessionScopeKey) {
      setFeedback({
        kind: "error",
        message: "Session identity is not ready. Try again after it loads.",
      });
      return false;
    }
    mutationInFlight.current = true;
    const operationId = beginPendingOperation();
    try {
      const target = buildMagnetizationApplyTarget(model, draftToApply);
      const response = await commitMagneticTextureApply(api, historyContext, target, model.baseRevision);
      if (historyContext.isCurrentSessionScope() === false) return false;
      const revision = publishTextureCommit(response, historyContext.sessionScopeKey);
      const syncWarning = await syncAuthoringScriptBestEffort(
        api,
        historyContext.sessionScopeKey,
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      const acknowledgedDraft = objectMagneticTextureDraftFromModel(
        resolveObjectMagneticTexturePanelModel(selection, response.committed_scene, regions.data),
      );
      setAcknowledgedBaseline({
        draft: acknowledgedDraft,
        identityKey: draftIdentityKey,
        revision,
      });
      if (
        draftStateRef.current.identityKey === draftIdentityKey &&
        draftStateRef.current.draft === submittedDraft
      ) {
        replaceDraftState({
          baseKey: draftKey,
          dirty: false,
          draft: acknowledgedDraft,
          identityKey: draftIdentityKey,
        });
      }
      setFeedback({
        kind: "success",
        message: magneticTextureApplyMessage(response.magnetization_apply, syncWarning),
        preview: { receipt: response.magnetization_apply, sessionScopeKey: historyContext.sessionScopeKey },
      });
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return false;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      mutationInFlight.current = false;
      finishPendingOperation(operationId);
    }
  }

  async function activateLoadTextureNode(): Promise<void> {
    if (mutationInFlight.current) return;
    const operationId = beginPendingOperation();
    const commandContext = createCommandContext("inspector", kernel, {
      sourceDetail: "object-magnetic-texture",
    });
    try {
      const result = await kernel.commands.execute(
        "magnetization-texture.activate-load-file",
        commandContext,
      );
      if (commandContext.isCurrentSessionScope?.() === false) return;
      if (result.status !== "completed") {
        setFeedback({
          kind: "error",
          message: result.message ?? "Could not activate texture load.",
        });
      } else {
        setFeedback(null);
      }
    } finally {
      finishPendingOperation(operationId);
    }
  }

  function resetDraft(): void {
    if (mutationInFlight.current) return;
    replaceDraftState(
      initialInspectorDraftState({
        baseDraft: baselineDraft,
        baseKey: draftKey,
        identityKey: draftIdentityKey,
      }),
    );
    setFeedback(null);
  }

  let valid = model.mode === "committed" && Boolean(model.regionId && model.authoredRegion) &&
    (!textureCapability || textureCapability.enabled);
  if (valid) {
    try {
      buildObjectMagneticTextureAssetDraft(model, draft);
    } catch {
      valid = false;
    }
  }
  const saveTextureRef = useRef(saveTexture);
  const auxiliaryResetRef = useRef(resetDraft);
  // Publish the latest handler closures after every committed render.
  useLayoutEffect(() => {
    saveTextureRef.current = saveTexture;
    auxiliaryResetRef.current = resetDraft;
  });
  const applyAuxiliaryDraft = useCallback(
    () => saveTextureRef.current(draft),
    [draft],
  );
  const resetAuxiliaryDraft = useCallback(
    () => auxiliaryResetRef.current(),
    [],
  );
  useEffect(() => {
    if (!auxiliaryDraftOwnerKey || !reportAuxiliaryDraftSession) return;
    const session: RegionAuxiliaryDraftSession = {
      applying: pending && mutationInFlight.current,
      apply: applyAuxiliaryDraft,
      dirty,
      reset: resetAuxiliaryDraft,
      valid,
    };
    reportAuxiliaryDraftSession(auxiliaryDraftOwnerKey, session);
    return () => reportAuxiliaryDraftSession(auxiliaryDraftOwnerKey, null);
  }, [
    applyAuxiliaryDraft,
    auxiliaryDraftOwnerKey,
    dirty,
    pending,
    reportAuxiliaryDraftSession,
    resetAuxiliaryDraft,
    valid,
  ]);

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={regionModel} meshLane={meshLane} />

      <MagneticTextureAssignmentSection
        draft={draft}
        model={model}
        updateDraft={updateDraft}
      />
      <MagneticTexturePresetParametersSection draft={draft} updateDraft={updateDraft} />
      <MagneticTextureRawAssetSection model={model} />

      <MagneticTextureActionsSection
        capability={textureCapability}
        dirty={dirty}
        feedback={feedback}
        model={model}
        onClear={() => void saveTexture(null)}
        onActivateLoad={() => void activateLoadTextureNode()}
        onRevert={resetDraft}
        onSave={() => void saveTexture()}
        pending={pending}
      />
    </div>
  );
}
