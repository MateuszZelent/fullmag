"use client";

import { useMemo, useState } from "react";
import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import type { RegionPatchRequest } from "@/kernel/api/apiTypes";
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
  buildMagnetizationAssignmentPatch as buildTextureAssignmentPatch,
} from "@/shared/domain/magnetization-texture/draftModel";
import { Accordion } from "@/shared/ui/Accordion";
import {
  ObjectRegionMetadataSection,
  type RegionSubPanelProps,
} from "./shared";
import {
  buildObjectMagneticTextureAssetDraft,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftKey,
  resolveObjectMagneticTexturePanelModel,
  type ObjectMagneticTextureDraft,
} from "../ObjectMagneticTexturePanelModel";
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
  const [draftState, setDraftState] = useState({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<MagneticTextureFeedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseDraft);

  function updateDraft(patch: Partial<ObjectMagneticTextureDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
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
      const patch = buildTextureAssignmentPatch(
        target,
        asset.id,
        assetResponse.scene_revision ?? model.baseRevision,
      );
      const response = await api.model.patchRegion(
        target.regionId,
        patch.payload as RegionPatchRequest,
      );
      const revision =
        typeof response.revision === "number"
          ? response.revision
          : assetResponse.scene_revision ?? model.baseRevision ?? 0;
      invalidateTextureResources(revision);
      const syncWarning = await syncAuthoringScriptBestEffort(api);
      setDraftState({
        draft: { ...draft, magnetizationRef: asset.id },
        key: draftKey,
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
      const patch = buildTextureAssignmentPatch(target, null, model.baseRevision);
      const response = await api.model.patchRegion(
        target.regionId,
        patch.payload as RegionPatchRequest,
      );
      const revision =
        typeof response.revision === "number"
          ? response.revision
          : model.baseRevision ?? 0;
      invalidateTextureResources(revision);
      const syncWarning = await syncAuthoringScriptBestEffort(api);
      setDraftState({
        draft: { ...baseDraft, magnetizationRef: "" },
        key: draftKey,
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

  const sections = ["regions", "assignment", "preset", "actions"];

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      <ObjectRegionMetadataSection model={regionModel} />

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
          setDraftState({ draft: baseDraft, key: draftKey });
          setFeedback(null);
        }}
        onSave={() => void saveTexture()}
        pending={pending}
      />
    </Accordion>
  );
}
