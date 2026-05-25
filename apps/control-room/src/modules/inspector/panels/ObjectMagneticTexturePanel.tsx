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
} from "@/shared/domain/magnetization-texture/draftModel";
import { MAGNETIZATION_TEXTURE_PRESETS } from "@/shared/domain/magnetization-texture/texturePresets";
import type { MagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/types";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildObjectMagneticTextureAssetDraft,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftKey,
  objectMagneticTexturePresetChangePatch,
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

type MagneticTexturePanelModel = ReturnType<
  typeof resolveObjectMagneticTexturePanelModel
>;

type UpdateMagneticTextureDraft = (
  patch: Partial<ObjectMagneticTextureDraft>,
) => void;

function MagneticTextureSummarySection({
  model,
  regionsStatus,
  sceneStatus,
}: {
  model: MagneticTexturePanelModel;
  regionsStatus: string;
  sceneStatus: string;
}) {
  return (
    <InspectorSection value="summary" title="Magnetic Texture" collapsible defaultCollapsed={false}>
      <FieldRow label="Object ID" value={model.objectId} />
      <FieldRow label="Target" value={model.targetKind} />
      {model.regionId && <FieldRow label="Region ID" value={model.regionId} />}
      <FieldRow label="Texture ref" value={model.assetId} />
      <FieldRow label="Asset label" value={model.assetLabel} />
      <FieldRow label="Asset kind" value={model.assetKind} />
      <FieldRow label="Preset" value={model.presetKind} />
      <FieldRow label="Assignment" value={model.assignment} />
      <FieldRow label="Scene fetch" value={sceneStatus} />
      <FieldRow label="Regions fetch" value={regionsStatus} />
    </InspectorSection>
  );
}

function MagneticTextureAssignmentSection({
  draft,
  model,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  model: MagneticTexturePanelModel;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <InspectorSection value="assignment" title="Assignment">
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
        onChange={(event) => {
          const nextPreset = event.target.value as ObjectMagneticTextureDraft["presetKind"];
          updateDraft(objectMagneticTexturePresetChangePatch(model, draft, nextPreset));
        }}
      >
        {MAGNETIZATION_TEXTURE_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </FormField>
    </InspectorSection>
  );
}

function MagneticTexturePresetParametersSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <InspectorSection value="preset" title="Preset Parameters">
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
      {(draft.presetKind === "vortex" || draft.presetKind === "antivortex") && (
        <>
          <FormField
            label="Plane"
            type="select"
            value={draft.plane}
            onChange={(event) => updateDraft({ plane: event.target.value })}
          >
            <option value="xy">XY</option>
            <option value="xz">XZ</option>
            <option value="yz">YZ</option>
          </FormField>
          <FormField
            label="Circulation"
            type="number"
            value={draft.circulation}
            onChange={(event) => updateDraft({ circulation: event.target.value })}
          />
          <FormField
            label="Core Polarity"
            type="number"
            value={draft.core_polarity}
            onChange={(event) => updateDraft({ core_polarity: event.target.value })}
          />
          <FormField
            label="Core Radius"
            type="number"
            unit="m"
            value={draft.core_radius}
            onChange={(event) => updateDraft({ core_radius: event.target.value })}
          />
        </>
      )}
      {(draft.presetKind === "bloch_skyrmion" || draft.presetKind === "neel_skyrmion") && (
        <>
          <FormField
            label="Plane"
            type="select"
            value={draft.plane}
            onChange={(event) => updateDraft({ plane: event.target.value })}
          >
            <option value="xy">XY</option>
            <option value="xz">XZ</option>
            <option value="yz">YZ</option>
          </FormField>
          <FormField
            label="Radius"
            type="number"
            unit="m"
            value={draft.radius}
            onChange={(event) => updateDraft({ radius: event.target.value })}
          />
          <FormField
            label="Wall Width"
            type="number"
            unit="m"
            value={draft.wall_width}
            onChange={(event) => updateDraft({ wall_width: event.target.value })}
          />
          <FormField
            label="Core Polarity"
            type="number"
            value={draft.core_polarity}
            onChange={(event) => updateDraft({ core_polarity: event.target.value })}
          />
          <FormField
            label="Chirality"
            type="number"
            value={draft.chirality}
            onChange={(event) => updateDraft({ chirality: event.target.value })}
          />
        </>
      )}
      {draft.presetKind === "domain_wall" && (
        <>
          <FormField
            label="Normal Axis"
            type="select"
            value={draft.normal_axis}
            onChange={(event) => updateDraft({ normal_axis: event.target.value })}
          >
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </FormField>
          <FormField
            label="Center Offset"
            type="number"
            unit="m"
            value={draft.center_offset}
            onChange={(event) => updateDraft({ center_offset: event.target.value })}
          />
          <FormField
            label="Wall Width"
            type="number"
            unit="m"
            value={draft.wall_width}
            onChange={(event) => updateDraft({ wall_width: event.target.value })}
          />
          <FormField
            label="Kind"
            type="select"
            value={draft.kind}
            onChange={(event) => updateDraft({ kind: event.target.value })}
          >
            <option value="neel">Néel</option>
            <option value="bloch">Bloch</option>
          </FormField>
          <FormField
            label="Left X"
            type="number"
            value={draft.leftX}
            onChange={(event) => updateDraft({ leftX: event.target.value })}
          />
          <FormField
            label="Left Y"
            type="number"
            value={draft.leftY}
            onChange={(event) => updateDraft({ leftY: event.target.value })}
          />
          <FormField
            label="Left Z"
            type="number"
            value={draft.leftZ}
            onChange={(event) => updateDraft({ leftZ: event.target.value })}
          />
          <FormField
            label="Right X"
            type="number"
            value={draft.rightX}
            onChange={(event) => updateDraft({ rightX: event.target.value })}
          />
          <FormField
            label="Right Y"
            type="number"
            value={draft.rightY}
            onChange={(event) => updateDraft({ rightY: event.target.value })}
          />
          <FormField
            label="Right Z"
            type="number"
            value={draft.rightZ}
            onChange={(event) => updateDraft({ rightZ: event.target.value })}
          />
        </>
      )}
      {draft.presetKind === "two_domain" && (
        <>
          <FormField
            label="Normal Axis"
            type="select"
            value={draft.normal_axis}
            onChange={(event) => updateDraft({ normal_axis: event.target.value })}
          >
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </FormField>
          <FormField
            label="Left X"
            type="number"
            value={draft.leftX}
            onChange={(event) => updateDraft({ leftX: event.target.value })}
          />
          <FormField
            label="Left Y"
            type="number"
            value={draft.leftY}
            onChange={(event) => updateDraft({ leftY: event.target.value })}
          />
          <FormField
            label="Left Z"
            type="number"
            value={draft.leftZ}
            onChange={(event) => updateDraft({ leftZ: event.target.value })}
          />
          <FormField
            label="Right X"
            type="number"
            value={draft.rightX}
            onChange={(event) => updateDraft({ rightX: event.target.value })}
          />
          <FormField
            label="Right Y"
            type="number"
            value={draft.rightY}
            onChange={(event) => updateDraft({ rightY: event.target.value })}
          />
          <FormField
            label="Right Z"
            type="number"
            value={draft.rightZ}
            onChange={(event) => updateDraft({ rightZ: event.target.value })}
          />
          <FormField
            label="Wall X"
            type="number"
            value={draft.wallX}
            onChange={(event) => updateDraft({ wallX: event.target.value })}
          />
          <FormField
            label="Wall Y"
            type="number"
            value={draft.wallY}
            onChange={(event) => updateDraft({ wallY: event.target.value })}
          />
          <FormField
            label="Wall Z"
            type="number"
            value={draft.wallZ}
            onChange={(event) => updateDraft({ wallZ: event.target.value })}
          />
        </>
      )}
      {draft.presetKind === "helical" && (
        <>
          <FormField
            label="Wavevector X"
            type="number"
            value={draft.wavevectorX}
            onChange={(event) => updateDraft({ wavevectorX: event.target.value })}
          />
          <FormField
            label="Wavevector Y"
            type="number"
            value={draft.wavevectorY}
            onChange={(event) => updateDraft({ wavevectorY: event.target.value })}
          />
          <FormField
            label="Wavevector Z"
            type="number"
            value={draft.wavevectorZ}
            onChange={(event) => updateDraft({ wavevectorZ: event.target.value })}
          />
          <FormField
            label="E1 X"
            type="number"
            value={draft.e1X}
            onChange={(event) => updateDraft({ e1X: event.target.value })}
          />
          <FormField
            label="E1 Y"
            type="number"
            value={draft.e1Y}
            onChange={(event) => updateDraft({ e1Y: event.target.value })}
          />
          <FormField
            label="E1 Z"
            type="number"
            value={draft.e1Z}
            onChange={(event) => updateDraft({ e1Z: event.target.value })}
          />
          <FormField
            label="E2 X"
            type="number"
            value={draft.e2X}
            onChange={(event) => updateDraft({ e2X: event.target.value })}
          />
          <FormField
            label="E2 Y"
            type="number"
            value={draft.e2Y}
            onChange={(event) => updateDraft({ e2Y: event.target.value })}
          />
          <FormField
            label="E2 Z"
            type="number"
            value={draft.e2Z}
            onChange={(event) => updateDraft({ e2Z: event.target.value })}
          />
          <FormField
            label="Phase"
            type="number"
            unit="rad"
            value={draft.phase_rad}
            onChange={(event) => updateDraft({ phase_rad: event.target.value })}
          />
        </>
      )}
      {draft.presetKind === "conical" && (
        <>
          <FormField
            label="Wavevector X"
            type="number"
            value={draft.wavevectorX}
            onChange={(event) => updateDraft({ wavevectorX: event.target.value })}
          />
          <FormField
            label="Wavevector Y"
            type="number"
            value={draft.wavevectorY}
            onChange={(event) => updateDraft({ wavevectorY: event.target.value })}
          />
          <FormField
            label="Wavevector Z"
            type="number"
            value={draft.wavevectorZ}
            onChange={(event) => updateDraft({ wavevectorZ: event.target.value })}
          />
          <FormField
            label="Cone Axis X"
            type="number"
            value={draft.cone_axisX}
            onChange={(event) => updateDraft({ cone_axisX: event.target.value })}
          />
          <FormField
            label="Cone Axis Y"
            type="number"
            value={draft.cone_axisY}
            onChange={(event) => updateDraft({ cone_axisY: event.target.value })}
          />
          <FormField
            label="Cone Axis Z"
            type="number"
            value={draft.cone_axisZ}
            onChange={(event) => updateDraft({ cone_axisZ: event.target.value })}
          />
          <FormField
            label="Phase"
            type="number"
            unit="rad"
            value={draft.phase_rad}
            onChange={(event) => updateDraft({ phase_rad: event.target.value })}
          />
          <FormField
            label="Cone Angle"
            type="number"
            unit="rad"
            value={draft.cone_angle_rad}
            onChange={(event) => updateDraft({ cone_angle_rad: event.target.value })}
          />
        </>
      )}
    </InspectorSection>
  );
}

function MagneticTextureTransformSection({
  draft,
  model,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  model: MagneticTexturePanelModel;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  const hasBounds = Boolean(model.boundsMin && model.boundsMax);

  function handleFitToObject(): void {
    if (!model.boundsMin || !model.boundsMax) return;
    const dx = model.boundsMax[0] - model.boundsMin[0];
    const dy = model.boundsMax[1] - model.boundsMin[1];
    const dz = model.boundsMax[2] - model.boundsMin[2];
    const cx = (model.boundsMax[0] + model.boundsMin[0]) * 0.5;
    const cy = (model.boundsMax[1] + model.boundsMin[1]) * 0.5;
    const cz = (model.boundsMax[2] + model.boundsMin[2]) * 0.5;

    updateDraft({
      translationX: String(cx),
      translationY: String(cy),
      translationZ: String(cz),
      scaleX: String(dx),
      scaleY: String(dy),
      scaleZ: String(dz),
      pivotX: "0",
      pivotY: "0",
      pivotZ: "0",
      rotationXDeg: "0",
      rotationYDeg: "0",
      rotationZDeg: "0",
    });
  }

  return (
    <InspectorSection value="transform" title="Texture Transform">
      {hasBounds && (
        <div className="fm-inspector-toolbar" style={{ marginBottom: "0.75rem" }}>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={handleFitToObject}
          >
            Fit to Object
          </Button>
        </div>
      )}
      <FormField label="Translate X" type="number" unit="m" value={draft.translationX} onChange={(event) => updateDraft({ translationX: event.target.value })} />
      <FormField label="Translate Y" type="number" unit="m" value={draft.translationY} onChange={(event) => updateDraft({ translationY: event.target.value })} />
      <FormField label="Translate Z" type="number" unit="m" value={draft.translationZ} onChange={(event) => updateDraft({ translationZ: event.target.value })} />
      <FormField label="Rotate X" type="number" unit="deg" value={draft.rotationXDeg} onChange={(event) => updateDraft({ rotationXDeg: event.target.value })} />
      <FormField label="Rotate Y" type="number" unit="deg" value={draft.rotationYDeg} onChange={(event) => updateDraft({ rotationYDeg: event.target.value })} />
      <FormField label="Rotate Z" type="number" unit="deg" value={draft.rotationZDeg} onChange={(event) => updateDraft({ rotationZDeg: event.target.value })} />
      <FormField label="Scale X" type="number" value={draft.scaleX} onChange={(event) => updateDraft({ scaleX: event.target.value })} />
      <FormField label="Scale Y" type="number" value={draft.scaleY} onChange={(event) => updateDraft({ scaleY: event.target.value })} />
      <FormField label="Scale Z" type="number" value={draft.scaleZ} onChange={(event) => updateDraft({ scaleZ: event.target.value })} />
    </InspectorSection>
  );
}

function MagneticTextureMappingSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <InspectorSection value="mapping" title="Mapping" collapsible defaultCollapsed={true}>
      <FormField label="Space" type="select" value={draft.mappingSpace} onChange={(event) => updateDraft({ mappingSpace: event.target.value })}>
        <option value="object">Object</option>
        <option value="world">World</option>
      </FormField>
      <FormField label="Projection" type="select" value={draft.mappingProjection} onChange={(event) => updateDraft({ mappingProjection: event.target.value })}>
        <option value="object_local">Object local</option>
        <option value="planar_xy">Planar XY</option>
        <option value="planar_xz">Planar XZ</option>
        <option value="planar_yz">Planar YZ</option>
      </FormField>
      <FormField label="Clamp" type="select" value={draft.clampMode} onChange={(event) => updateDraft({ clampMode: event.target.value })}>
        <option value="none">None</option>
        <option value="repeat">Repeat</option>
        <option value="clamp">Clamp</option>
      </FormField>
      <FormField label="Pivot X" type="number" unit="m" value={draft.pivotX} onChange={(event) => updateDraft({ pivotX: event.target.value })} />
      <FormField label="Pivot Y" type="number" unit="m" value={draft.pivotY} onChange={(event) => updateDraft({ pivotY: event.target.value })} />
      <FormField label="Pivot Z" type="number" unit="m" value={draft.pivotZ} onChange={(event) => updateDraft({ pivotZ: event.target.value })} />
    </InspectorSection>
  );
}

function MagneticTextureRawAssetSection({
  model,
}: {
  model: MagneticTexturePanelModel;
}) {
  return (
    <InspectorSection value="raw" title="Raw Asset" collapsible defaultCollapsed={true}>
      <FormField label="Mapping" type="textarea" readOnly rows={5} value={model.mapping} />
      <FormField label="Texture transform" type="textarea" readOnly rows={5} value={model.textureTransform} />
    </InspectorSection>
  );
}

function MagneticTextureActionsSection({
  dirty,
  feedback,
  model,
  onClear,
  onRevert,
  onSave,
  pending,
}: {
  dirty: boolean;
  feedback: Feedback;
  model: MagneticTexturePanelModel;
  onClear: () => void;
  onRevert: () => void;
  onSave: () => void;
  pending: boolean;
}) {
  return (
    <InspectorSection value="actions" title="Actions">
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending || model.mode !== "committed"}
          size="sm"
          type="button"
          variant="primary"
          onClick={onSave}
        >
          Save Texture
        </Button>
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={onRevert}
        >
          Revert
        </Button>
        <Button
          disabled={pending || model.mode !== "committed"}
          size="sm"
          type="button"
          variant="ghost"
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
      <FieldRow label="Draft" value={dirty ? "modified" : "clean"} />
      {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
    </InspectorSection>
  );
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
          : assetResponse.scene_revision ?? model.baseRevision ?? 0;
      invalidateTextureResources(revision);
      await api.model.syncAuthoringScript({});
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
        typeof response.revision === "number"
          ? response.revision
          : model.baseRevision ?? 0;
      invalidateTextureResources(revision);
      await api.model.syncAuthoringScript({});
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
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={["summary", "assignment", "preset", "transform", "mapping", "actions"]}
    >
      <MagneticTextureSummarySection
        model={model}
        regionsStatus={regions.status}
        sceneStatus={scene.status}
      />
      <MagneticTextureAssignmentSection
        draft={draft}
        model={model}
        updateDraft={updateDraft}
      />
      <MagneticTexturePresetParametersSection draft={draft} updateDraft={updateDraft} />
      <MagneticTextureTransformSection draft={draft} model={model} updateDraft={updateDraft} />
      <MagneticTextureMappingSection draft={draft} updateDraft={updateDraft} />
      <MagneticTextureRawAssetSection model={model} />
      <MagneticTextureActionsSection
        dirty={dirty}
        feedback={feedback}
        model={model}
        onClear={() => void clearTexture()}
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
