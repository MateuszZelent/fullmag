"use client";

import { useMemo, useState } from "react";
import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MODEL_REGIONS_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  VISUALIZATION_STATE_RESOURCE_KEY,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  buildMagnetizationAssetPatch as buildTextureAssetPatch,
  buildRegionTextureOverridePatch,
} from "@/shared/domain/magnetization-texture/draftModel";
import {
  ObjectRegionMetadataSection,
  type RegionSubPanelProps,
} from "./shared";
import {
  buildObjectMagneticTextureAssetDraft,
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
  const { api, resources } = kernel;
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
  const [pending, setPending] = useState(false);
  const { dirty, draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: objectMagneticTextureDraftDirty,
    state: draftState,
  });

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
    resources.invalidate(SCENE_RESOURCE_KEY, revision);
    resources.invalidate(MODEL_REGIONS_RESOURCE_KEY, revision);
    resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
    resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
    resources.invalidate(VISUALIZATION_STATE_RESOURCE_KEY, revision);
  }

  async function saveTexture(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }
    const target = { kind: "region" as const, objectId: model.objectId, regionId: model.regionId! };
    setPending(true);
    try {
      const asset = buildObjectMagneticTextureAssetDraft(model, draft);
      const assetResponse = await api.model.patchMagnetizationAsset(
        asset.id,
        buildTextureAssetPatch(asset, model.baseRevision),
      );
      const response = await api.model.patchObjectRegionResource(
        target.objectId,
        target.regionId,
        buildRegionTextureOverridePatch(asset),
        { baseRevision: assetResponse.scene_revision ?? model.baseRevision ?? undefined },
      );
      const revision =
        typeof response.revision === "number"
          ? response.revision
          : assetResponse.scene_revision ?? model.baseRevision ?? 0;
      invalidateTextureResources(revision);
      const syncWarning = await syncAuthoringScriptBestEffort(api);
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
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  async function clearTexture(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }
    const target = { kind: "region" as const, objectId: model.objectId, regionId: model.regionId! };
    setPending(true);
    try {
      const response = await api.model.patchObjectRegionResource(
        target.objectId,
        target.regionId,
        buildRegionTextureOverridePatch(null),
        { baseRevision: model.baseRevision ?? undefined },
      );
      const revision =
        typeof response.revision === "number"
          ? response.revision
          : model.baseRevision ?? 0;
      invalidateTextureResources(revision);
      const syncWarning = await syncAuthoringScriptBestEffort(api);
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
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  async function activateLoadTextureNode(): Promise<void> {
    setPending(true);
    try {
      const result = await kernel.commands.execute(
        "magnetization-texture.activate-load-file",
        createCommandContext("inspector", kernel, {
          sourceDetail: "object-magnetic-texture",
        }),
      );
      if (result.status !== "completed") {
        setFeedback({
          kind: "error",
          message: result.message ?? "Could not activate texture load.",
        });
      } else {
        setFeedback(null);
      }
    } finally {
      setPending(false);
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
