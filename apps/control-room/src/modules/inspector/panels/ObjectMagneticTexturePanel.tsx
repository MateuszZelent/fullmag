"use client";

import { useMemo, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
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
} from "@/modules/magnetization-texture/draftModel";
import { MAGNETIZATION_TEXTURE_PRESETS } from "@/modules/magnetization-texture/texturePresets";
import type { MagnetizationTextureTarget } from "@/modules/magnetization-texture/types";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftKey,
  buildObjectMagneticTextureAssetDraft,
  resolveObjectMagneticTexturePanelModel,
  type ObjectMagneticTextureDraft,
  } from "./ObjectMagneticTexturePanelModel";

interface DraftState {
  draft: ObjectMagneticTextureDraft;
  key: string;
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetFromModel(
  model: ReturnType<typeof resolveObjectMagneticTexturePanelModel>,
): MagnetizationTextureTarget | null {
  if (model.targetKind === "region") {
    return model.regionId
      ? { kind: "region", objectId: model.objectId, regionId: model.regionId }
      : null;
  }
  return { kind: "object", objectId: model.objectId };
}

export function ObjectMagneticTexturePanel({
  selection,
}: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();
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
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
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
    const target = targetFromModel(model);
    if (!target) {
      setFeedback({ kind: "error", message: "No selected texture target." });
      return;
    }

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
      const response =
        target.kind === "region"
          ? await api.model.patchRegion(target.regionId, patch.payload)
          : await api.model.patchObject(model.objectId, patch.payload);
      const revision =
        typeof response.revision === "number"
          ? response.revision
          : assetResponse.scene_revision;
      invalidateTextureResources(revision);
      setDraftState({
        draft: { ...draft, magnetizationRef: asset.id },
        key: draftKey,
      });
      setFeedback({
        kind: "success",
        message: "Magnetic texture saved.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function clearTexture(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }
    const target = targetFromModel(model);
    if (!target) {
      setFeedback({ kind: "error", message: "No selected texture target." });
      return;
    }

    setPending(true);
    try {
      const patch = buildTextureAssignmentPatch(target, null, model.baseRevision);
      const response =
        target.kind === "region"
          ? await api.model.patchRegion(target.regionId, patch.payload)
          : await api.model.patchObject(model.objectId, patch.payload);
      const revision =
        typeof response.revision === "number" ? response.revision : Date.now();
      invalidateTextureResources(revision);
      setDraftState({
        draft: { ...baseDraft, magnetizationRef: "" },
        key: draftKey,
      });
      setFeedback({ kind: "success", message: "Magnetic texture cleared." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Magnetic Texture" collapsible defaultCollapsed={false}>
        <FieldRow label="Object ID" value={model.objectId} />
        <FieldRow label="Target" value={model.targetKind} />
        {model.regionId && <FieldRow label="Region ID" value={model.regionId} />}
        <FieldRow label="Texture ref" value={model.assetId} />
        <FieldRow label="Asset label" value={model.assetLabel} />
        <FieldRow label="Asset kind" value={model.assetKind} />
        <FieldRow label="Preset" value={model.presetKind} />
        <FieldRow label="Assignment" value={model.assignment} />
        <FieldRow label="Scene fetch" value={scene.status} />
        <FieldRow label="Regions fetch" value={regions.status} />
      </InspectorSection>

      <InspectorSection title="Assignment">
        <FormField
          label="Magnetization ref"
          mono={false}
          type="text"
          value={draft.magnetizationRef}
          onChange={(event) =>
            updateDraft({ magnetizationRef: event.target.value })
          }
        />
        <FormField
          label="Asset label"
          mono={false}
          type="text"
          value={draft.assetLabel}
          onChange={(event) => updateDraft({ assetLabel: event.target.value })}
        />
        <FormField
          label="Preset"
          type="select"
          value={draft.presetKind}
          onChange={(event) =>
            updateDraft({
              presetKind: event.target.value as ObjectMagneticTextureDraft["presetKind"],
            })
          }
        >
          {MAGNETIZATION_TEXTURE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </FormField>
      </InspectorSection>

      <InspectorSection title="Preset Parameters">
        {draft.presetKind === "uniform" && (
          <>
            <FormField
              label="Direction X"
              type="number"
              value={draft.directionX}
              onChange={(event) => updateDraft({ directionX: event.target.value })}
            />
            <FormField
              label="Direction Y"
              type="number"
              value={draft.directionY}
              onChange={(event) => updateDraft({ directionY: event.target.value })}
            />
            <FormField
              label="Direction Z"
              type="number"
              value={draft.directionZ}
              onChange={(event) => updateDraft({ directionZ: event.target.value })}
            />
          </>
        )}
        {draft.presetKind === "random_seeded" && (
          <FormField
            label="Seed"
            type="number"
            value={draft.seed}
            onChange={(event) => updateDraft({ seed: event.target.value })}
          />
        )}
        {draft.presetKind === "vortex" && (
          <>
            <FormField
              label="Chirality"
              type="number"
              value={draft.chirality}
              onChange={(event) => updateDraft({ chirality: event.target.value })}
            />
            <FormField
              label="Polarity"
              type="number"
              value={draft.polarity}
              onChange={(event) => updateDraft({ polarity: event.target.value })}
            />
          </>
        )}
      </InspectorSection>

      <InspectorSection title="Texture Transform">
        <FormField
          label="Translate X"
          type="number"
          unit="m"
          value={draft.translationX}
          onChange={(event) => updateDraft({ translationX: event.target.value })}
        />
        <FormField
          label="Translate Y"
          type="number"
          unit="m"
          value={draft.translationY}
          onChange={(event) => updateDraft({ translationY: event.target.value })}
        />
        <FormField
          label="Translate Z"
          type="number"
          unit="m"
          value={draft.translationZ}
          onChange={(event) => updateDraft({ translationZ: event.target.value })}
        />
        <FormField
          label="Rotate X"
          type="number"
          unit="deg"
          value={draft.rotationXDeg}
          onChange={(event) => updateDraft({ rotationXDeg: event.target.value })}
        />
        <FormField
          label="Rotate Y"
          type="number"
          unit="deg"
          value={draft.rotationYDeg}
          onChange={(event) => updateDraft({ rotationYDeg: event.target.value })}
        />
        <FormField
          label="Rotate Z"
          type="number"
          unit="deg"
          value={draft.rotationZDeg}
          onChange={(event) => updateDraft({ rotationZDeg: event.target.value })}
        />
        <FormField
          label="Scale X"
          type="number"
          value={draft.scaleX}
          onChange={(event) => updateDraft({ scaleX: event.target.value })}
        />
        <FormField
          label="Scale Y"
          type="number"
          value={draft.scaleY}
          onChange={(event) => updateDraft({ scaleY: event.target.value })}
        />
        <FormField
          label="Scale Z"
          type="number"
          value={draft.scaleZ}
          onChange={(event) => updateDraft({ scaleZ: event.target.value })}
        />
      </InspectorSection>

      <InspectorSection title="Mapping" collapsible defaultCollapsed={true}>
        <FormField
          label="Space"
          type="select"
          value={draft.mappingSpace}
          onChange={(event) => updateDraft({ mappingSpace: event.target.value })}
        >
          <option value="object">Object</option>
          <option value="world">World</option>
        </FormField>
        <FormField
          label="Projection"
          type="select"
          value={draft.mappingProjection}
          onChange={(event) =>
            updateDraft({ mappingProjection: event.target.value })
          }
        >
          <option value="object_local">Object local</option>
          <option value="world_xyz">World XYZ</option>
        </FormField>
        <FormField
          label="Clamp"
          type="select"
          value={draft.clampMode}
          onChange={(event) => updateDraft({ clampMode: event.target.value })}
        >
          <option value="none">None</option>
          <option value="repeat">Repeat</option>
          <option value="clamp">Clamp</option>
        </FormField>
        <FormField
          label="Pivot X"
          type="number"
          unit="m"
          value={draft.pivotX}
          onChange={(event) => updateDraft({ pivotX: event.target.value })}
        />
        <FormField
          label="Pivot Y"
          type="number"
          unit="m"
          value={draft.pivotY}
          onChange={(event) => updateDraft({ pivotY: event.target.value })}
        />
        <FormField
          label="Pivot Z"
          type="number"
          unit="m"
          value={draft.pivotZ}
          onChange={(event) => updateDraft({ pivotZ: event.target.value })}
        />
      </InspectorSection>

      <InspectorSection title="Raw Asset" collapsible defaultCollapsed={true}>
        <FormField
          label="Mapping"
          type="textarea"
          readOnly
          rows={5}
          value={model.mapping}
        />
        <FormField
          label="Texture transform"
          type="textarea"
          readOnly
          rows={5}
          value={model.textureTransform}
        />
      </InspectorSection>

      <InspectorSection title="Actions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || model.mode !== "committed"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void saveTexture()}
          >
            Save Texture
          </Button>
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setDraftState({ draft: baseDraft, key: draftKey });
              setFeedback(null);
            }}
          >
            Revert
          </Button>
          <Button
            disabled={pending || model.mode !== "committed"}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void clearTexture()}
          >
            Clear
          </Button>
        </div>
        <FieldRow label="Draft" value={dirty ? "modified" : "clean"} />
        {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
      </InspectorSection>
    </div>
  );
}
