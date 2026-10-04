"use client";

import { useMemo, useRef, useState } from "react";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
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
  type RegionSubPanelProps,
} from "./shared";
import {
  buildObjectMagneticTextureAssetDraft,
  buildMagnetizationTransactionRequest,
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
import { syncAuthoringScriptBestEffort } from "../ObjectMagneticTexturePanelViewModel";
import type { Selection, RegionVisualizationTargetId } from "@/kernel/selection/selectionTypes";

export function ObjectRegionTexturePanel({
  model: regionModel,
  meshLane = "unknown",
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
  const [draftState, setDraftState] = useState<
    InspectorDraftState<ObjectMagneticTextureDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey: draftKey,
      identityKey: draftIdentityKey,
    }),
  );
  const [feedback, setFeedback] = useState<MagneticTextureFeedback>(null);
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    sessionScopeKey: string | null;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey;
  const { dirty, draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: objectMagneticTextureDraftDirty,
    state: draftState,
  });
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

  function updateDraft(patch: Partial<ObjectMagneticTextureDraft>): void {
    setDraftState(
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

  function invalidateTextureResources(revision: number): void {
    invalidateAuthoringMutationDependents(resources, "magnetization", revision);
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

  async function saveTexture(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }
    if (textureCapability && !textureCapability.enabled) {
      setFeedback({ kind: "error", message: textureCapability.reason });
      return;
    }
    if (!model.regionId) {
      setFeedback({ kind: "error", message: "No selected texture target." });
      return;
    }
    const historyContext = createHistoryMutationContext();
    if (!historyContext.sessionScopeKey) {
      setFeedback({
        kind: "error",
        message: "Session identity is not ready. Try again after it loads.",
      });
      return;
    }
    const operationId = beginPendingOperation();
    try {
      const asset = buildObjectMagneticTextureAssetDraft(model, draft);
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Save region magnetic texture ${model.regionId}`,
        async ({ baseRevision }) => {
          const request = buildMagnetizationTransactionRequest(
            model,
            asset,
            asset.id,
          );
          const commitRevision = baseRevision ?? request.base_revision;
          if (typeof commitRevision !== "number" || !Number.isFinite(commitRevision)) {
            throw new Error(
              "The canonical scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          const options = authoringWriteOptions(
            commitRevision,
            historyContext.sessionScopeKey,
          );
          if (!options?.sessionScopeKey || options.baseRevision === undefined) {
            throw new Error(
              "The session-scoped scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          return api.model.commitTransaction(
            {
              ...request,
              base_revision: commitRevision,
            },
            options,
          );
        },
      );
      if (historyContext.isCurrentSessionScope() === false) return;
      const revision = acknowledgedAuthoringSceneRevision(response);
      invalidateTextureResources(revision);
      const syncWarning = await syncAuthoringScriptBestEffort(
        api,
        historyContext.sessionScopeKey,
      );
      if (historyContext.isCurrentSessionScope() === false) return;
      setDraftState({
        baseKey: draftKey,
        dirty: false,
        draft: { ...draft, magnetizationRef: asset.id },
        identityKey: draftIdentityKey,
      });
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Magnetic texture saved. Sync skipped: ${syncWarning}`
          : "Magnetic texture saved.",
      });
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      finishPendingOperation(operationId);
    }
  }

  async function clearTexture(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }
    if (!model.regionId) {
      setFeedback({ kind: "error", message: "No selected texture target." });
      return;
    }
    const historyContext = createHistoryMutationContext();
    if (!historyContext.sessionScopeKey) {
      setFeedback({
        kind: "error",
        message: "Session identity is not ready. Try again after it loads.",
      });
      return;
    }
    const operationId = beginPendingOperation();
    try {
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Clear region magnetic texture ${model.regionId}`,
        async ({ baseRevision }) => {
          const request = buildMagnetizationTransactionRequest(
            model,
            null,
            null,
          );
          const commitRevision = baseRevision ?? request.base_revision;
          if (typeof commitRevision !== "number" || !Number.isFinite(commitRevision)) {
            throw new Error(
              "The canonical scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          const options = authoringWriteOptions(
            commitRevision,
            historyContext.sessionScopeKey,
          );
          if (!options?.sessionScopeKey || options.baseRevision === undefined) {
            throw new Error(
              "The session-scoped scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          return api.model.commitTransaction(
            {
              ...request,
              base_revision: commitRevision,
            },
            options,
          );
        },
      );
      if (historyContext.isCurrentSessionScope() === false) return;
      const revision = acknowledgedAuthoringSceneRevision(response);
      invalidateTextureResources(revision);
      const syncWarning = await syncAuthoringScriptBestEffort(
        api,
        historyContext.sessionScopeKey,
      );
      if (historyContext.isCurrentSessionScope() === false) return;
      setDraftState({
        baseKey: draftKey,
        dirty: false,
        draft: { ...baseDraft, magnetizationRef: "" },
        identityKey: draftIdentityKey,
      });
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Magnetic texture cleared. Sync skipped: ${syncWarning}`
          : "Magnetic texture cleared.",
      });
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      finishPendingOperation(operationId);
    }
  }

  async function activateLoadTextureNode(): Promise<void> {
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
        onClear={() => void clearTexture()}
        onActivateLoad={() => void activateLoadTextureNode()}
        onRevert={() => {
          setDraftState(
            initialInspectorDraftState({
              baseDraft,
              baseKey: draftKey,
              identityKey: draftIdentityKey,
            }),
          );
          setFeedback(null);
        }}
        onSave={() => void saveTexture()}
        pending={pending}
      />
    </div>
  );
}
