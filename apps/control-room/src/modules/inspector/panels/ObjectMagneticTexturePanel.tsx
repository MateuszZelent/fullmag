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
import { MAGNETIZATION_TEXTURE_PRESETS } from "@/shared/domain/magnetization-texture/texturePresets";
import type { MagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/types";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "./inspectorDraftState";
import {
  buildObjectMagneticTextureAssetDraft,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftDirty,
  objectMagneticTextureDraftIdentityKey,
  objectMagneticTextureDraftKey,
  objectMagneticTexturePresetChangePatch,
  resolveObjectMagneticTexturePanelModel,
  type ObjectMagneticTextureDraft,
} from "./ObjectMagneticTexturePanelModel";
import {
  magneticTextureInspectorView,
  syncAuthoringScriptBestEffort,
  type MagneticTexturePanelModel,
} from "./ObjectMagneticTexturePanelViewModel";

export type MagneticTextureFeedback =
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

export type UpdateMagneticTextureDraft = (
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
    <InspectorGroup title="Magnetic Texture" collapsible defaultOpen>
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
    </InspectorGroup>
  );
}

export function MagneticTextureAssignmentSection({
  draft,
  model,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  model: MagneticTexturePanelModel;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <InspectorGroup title="Assignment" collapsible defaultOpen>
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
    </InspectorGroup>
  );
}

type MagneticTextureDraftField = keyof ObjectMagneticTextureDraft;

interface DraftNumberFieldSpec {
  field: MagneticTextureDraftField;
  label: string;
  unit?: string;
}

const PLANE_OPTIONS = [
  ["xy", "XY"],
  ["xz", "XZ"],
  ["yz", "YZ"],
] as const;

const AXIS_OPTIONS = [
  ["x", "X"],
  ["y", "Y"],
  ["z", "Z"],
] as const;

const WALL_KIND_OPTIONS = [
  ["neel", "Néel"],
  ["bloch", "Bloch"],
] as const;

const VORTEX_FIELDS = [
  { field: "circulation", label: "Circulation" },
  { field: "core_polarity", label: "Core Polarity" },
  { field: "core_radius", label: "Core Radius", unit: "m" },
] as const satisfies readonly DraftNumberFieldSpec[];

const SKYRMION_FIELDS = [
  { field: "radius", label: "Radius", unit: "m" },
  { field: "wall_width", label: "Wall Width", unit: "m" },
  { field: "core_polarity", label: "Core Polarity" },
  { field: "chirality", label: "Chirality" },
] as const satisfies readonly DraftNumberFieldSpec[];

function patchDraftField(
  updateDraft: UpdateMagneticTextureDraft,
  field: MagneticTextureDraftField,
  value: string,
): void {
  updateDraft({ [field]: value } as Partial<ObjectMagneticTextureDraft>);
}

function DraftNumberField({
  draft,
  field,
  label,
  unit,
  updateDraft,
}: DraftNumberFieldSpec & {
  draft: ObjectMagneticTextureDraft;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <FormField
      label={label}
      inputMode="decimal"
      type="text"
      unit={unit}
      value={String(draft[field])}
      onChange={(event) => patchDraftField(updateDraft, field, event.target.value)}
    />
  );
}

function DraftNumberFields({
  draft,
  fields,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  fields: readonly DraftNumberFieldSpec[];
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <>
      {fields.map((field) => (
        <DraftNumberField
          key={field.field}
          draft={draft}
          updateDraft={updateDraft}
          {...field}
        />
      ))}
    </>
  );
}

function DraftSelectField({
  draft,
  field,
  label,
  options,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  field: MagneticTextureDraftField;
  label: string;
  options: readonly (readonly [string, string])[];
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <FormField
      label={label}
      type="select"
      value={String(draft[field])}
      onChange={(event) => patchDraftField(updateDraft, field, event.target.value)}
    >
      {options.map(([value, optionLabel]) => (
        <option key={value} value={value}>
          {optionLabel}
        </option>
      ))}
    </FormField>
  );
}

function PlaneSelect({
  draft,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <DraftSelectField
      draft={draft}
      field="plane"
      label="Plane"
      options={PLANE_OPTIONS}
      updateDraft={updateDraft}
    />
  );
}

function NormalAxisSelect({
  draft,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <DraftSelectField
      draft={draft}
      field="normal_axis"
      label="Normal Axis"
      options={AXIS_OPTIONS}
      updateDraft={updateDraft}
    />
  );
}

export function MagneticTexturePresetParametersSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <InspectorGroup title="Preset Parameters" collapsible defaultOpen>
      {draft.presetKind === "uniform" ? (
        <Vector3Field
          label="Direction"
          values={[draft.directionX, draft.directionY, draft.directionZ]}
          onChange={(index, value) => {
            const fields = ["directionX", "directionY", "directionZ"] as const;
            updateDraft({ [fields[index]]: value });
          }}
        />
      ) : null}
      {draft.presetKind === "random_seeded" ? (
        <DraftNumberField draft={draft} field="seed" label="Seed" updateDraft={updateDraft} />
      ) : null}
      {draft.presetKind === "vortex" || draft.presetKind === "antivortex" ? (
        <>
          <PlaneSelect draft={draft} updateDraft={updateDraft} />
          <DraftNumberFields draft={draft} fields={VORTEX_FIELDS} updateDraft={updateDraft} />
        </>
      ) : null}
      {draft.presetKind === "bloch_skyrmion" ||
      draft.presetKind === "neel_skyrmion" ? (
        <>
          <PlaneSelect draft={draft} updateDraft={updateDraft} />
          <DraftNumberFields draft={draft} fields={SKYRMION_FIELDS} updateDraft={updateDraft} />
        </>
      ) : null}
      {draft.presetKind === "domain_wall" ? (
        <>
          <NormalAxisSelect draft={draft} updateDraft={updateDraft} />
          <DraftSelectField
            draft={draft}
            field="kind"
            label="Kind"
            options={WALL_KIND_OPTIONS}
            updateDraft={updateDraft}
          />
          <DraftNumberField draft={draft} field="center_offset" label="Center Offset" unit="m" updateDraft={updateDraft} />
          <DraftNumberField draft={draft} field="wall_width" label="Wall Width" unit="m" updateDraft={updateDraft} />
          <Vector3Field
            label="Left"
            values={[draft.leftX, draft.leftY, draft.leftZ]}
            onChange={(index, value) => {
              const fields = ["leftX", "leftY", "leftZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <Vector3Field
            label="Right"
            values={[draft.rightX, draft.rightY, draft.rightZ]}
            onChange={(index, value) => {
              const fields = ["rightX", "rightY", "rightZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
        </>
      ) : null}
      {draft.presetKind === "two_domain" ? (
        <>
          <NormalAxisSelect draft={draft} updateDraft={updateDraft} />
          <Vector3Field
            label="Left"
            values={[draft.leftX, draft.leftY, draft.leftZ]}
            onChange={(index, value) => {
              const fields = ["leftX", "leftY", "leftZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <Vector3Field
            label="Right"
            values={[draft.rightX, draft.rightY, draft.rightZ]}
            onChange={(index, value) => {
              const fields = ["rightX", "rightY", "rightZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <Vector3Field
            label="Wall"
            values={[draft.wallX, draft.wallY, draft.wallZ]}
            onChange={(index, value) => {
              const fields = ["wallX", "wallY", "wallZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
        </>
      ) : null}
      {draft.presetKind === "helical" ? (
        <>
          <Vector3Field
            label="Wavevector"
            values={[draft.wavevectorX, draft.wavevectorY, draft.wavevectorZ]}
            onChange={(index, value) => {
              const fields = ["wavevectorX", "wavevectorY", "wavevectorZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <Vector3Field
            label="E1"
            values={[draft.e1X, draft.e1Y, draft.e1Z]}
            onChange={(index, value) => {
              const fields = ["e1X", "e1Y", "e1Z"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <Vector3Field
            label="E2"
            values={[draft.e2X, draft.e2Y, draft.e2Z]}
            onChange={(index, value) => {
              const fields = ["e2X", "e2Y", "e2Z"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <DraftNumberField draft={draft} field="phase_rad" label="Phase" unit="rad" updateDraft={updateDraft} />
        </>
      ) : null}
      {draft.presetKind === "conical" ? (
        <>
          <Vector3Field
            label="Wavevector"
            values={[draft.wavevectorX, draft.wavevectorY, draft.wavevectorZ]}
            onChange={(index, value) => {
              const fields = ["wavevectorX", "wavevectorY", "wavevectorZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <Vector3Field
            label="Cone Axis"
            values={[draft.cone_axisX, draft.cone_axisY, draft.cone_axisZ]}
            onChange={(index, value) => {
              const fields = ["cone_axisX", "cone_axisY", "cone_axisZ"] as const;
              updateDraft({ [fields[index]]: value });
            }}
          />
          <DraftNumberField draft={draft} field="phase_rad" label="Phase" unit="rad" updateDraft={updateDraft} />
          <DraftNumberField draft={draft} field="cone_angle_rad" label="Cone Angle" unit="rad" updateDraft={updateDraft} />
        </>
      ) : null}
    </InspectorGroup>
  );
}

export function MagneticTextureTransformSection({
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
    <InspectorGroup title="Texture Transform" collapsible defaultOpen>
      {hasBounds && (
        <div className="fm-inspector-toolbar fm-mb-3">
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
      <Vector3Field
        label="Translation"
        unit="m"
        values={[draft.translationX, draft.translationY, draft.translationZ]}
        onChange={(index, value) => {
          const fields = ["translationX", "translationY", "translationZ"] as const;
          updateDraft({ [fields[index]]: value });
        }}
      />
      <Vector3Field
        label="Rotation"
        unit="deg"
        values={[draft.rotationXDeg, draft.rotationYDeg, draft.rotationZDeg]}
        onChange={(index, value) => {
          const fields = ["rotationXDeg", "rotationYDeg", "rotationZDeg"] as const;
          updateDraft({ [fields[index]]: value });
        }}
      />
      <Vector3Field
        label="Scale"
        values={[draft.scaleX, draft.scaleY, draft.scaleZ]}
        onChange={(index, value) => {
          const fields = ["scaleX", "scaleY", "scaleZ"] as const;
          updateDraft({ [fields[index]]: value });
        }}
      />
    </InspectorGroup>
  );
}

export function MagneticTextureMappingSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMagneticTextureDraft;
  updateDraft: UpdateMagneticTextureDraft;
}) {
  return (
    <InspectorGroup title="Mapping" collapsible defaultOpen={false}>
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
      <Vector3Field
        label="Pivot"
        unit="m"
        values={[draft.pivotX, draft.pivotY, draft.pivotZ]}
        onChange={(index, value) => {
          const fields = ["pivotX", "pivotY", "pivotZ"] as const;
          updateDraft({ [fields[index]]: value });
        }}
      />
    </InspectorGroup>
  );
}

export function MagneticTextureRawAssetSection({
  model,
}: {
  model: MagneticTexturePanelModel;
}) {
  return (
    <InspectorGroup title="Raw Asset" collapsible defaultOpen={false}>
      <FormField label="Mapping" type="textarea" readOnly rows={5} value={model.mapping} />
      <FormField label="Texture transform" type="textarea" readOnly rows={5} value={model.textureTransform} />
    </InspectorGroup>
  );
}

export function MagneticTextureLoadFileSection({
  feedback,
  model,
  onLoad,
  pending,
}: {
  feedback: MagneticTextureFeedback;
  model: MagneticTexturePanelModel;
  onLoad: () => void;
  pending: boolean;
}) {
  return (
    <InspectorGroup title="Load Texture" collapsible defaultOpen>
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending || model.mode !== "committed"}
          size="sm"
          type="button"
          variant="primary"
          onClick={onLoad}
        >
          Load File
        </Button>
      </div>
      <FieldRow label="Target" value={model.objectId} />
      <FieldRow label="Quantity" value="m" />
      <FieldRow label="Formats" value="H5, Zarr ZIP" />
      <FieldRow label="Mode" value="ready to load" />
      {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
    </InspectorGroup>
  );
}

export function MagneticTextureActionsSection({
  dirty,
  feedback,
  model,
  onClear,
  onActivateLoad,
  onRevert,
  onSave,
  pending,
}: {
  dirty: boolean;
  feedback: MagneticTextureFeedback;
  model: MagneticTexturePanelModel;
  onClear: () => void;
  onActivateLoad: () => void;
  onRevert: () => void;
  onSave: () => void;
  pending: boolean;
}) {
  return (
    <InspectorGroup title="Actions">
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
          disabled={pending || model.mode !== "committed" || model.targetKind !== "object"}
          size="sm"
          type="button"
          variant="ghost"
          onClick={onActivateLoad}
        >
          Load Texture
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
    </InspectorGroup>
  );
}

export function ObjectMagneticTexturePanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const { api, resources } = kernel;
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
  const inspectorView = magneticTextureInspectorView(selection.kind);

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
          ? await api.model.patchRegion(
              target.regionId,
              patch.payload as RegionPatchRequest,
            )
          : await api.model.patchObject(model.objectId, patch.payload);
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
          ? `Magnetic texture saved. Authoring script sync skipped: ${syncWarning}`
          : "Magnetic texture saved.",
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
          ? await api.model.patchRegion(
              target.regionId,
              patch.payload as RegionPatchRequest,
            )
          : await api.model.patchObject(model.objectId, patch.payload);
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
          ? `Magnetic texture cleared. Authoring script sync skipped: ${syncWarning}`
          : "Magnetic texture cleared.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
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

  async function loadTextureFile(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }

    setPending(true);
    try {
      const result = await kernel.commands.execute(
        "study.load-field-state",
        createCommandContext("inspector", kernel, {
          sourceDetail: "object-magnetic-texture-load",
        }),
      );
      setFeedback({
        kind: result.status === "completed" ? "success" : "error",
        message: result.message ?? "Magnetic texture load finished.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-[var(--fm-inspector-group-gap)]">
      <MagneticTextureSummarySection
        model={model}
        regionsStatus={regions.status}
        sceneStatus={scene.status}
      />
      {inspectorView === "asset" || inspectorView === "region" ? (
        <>
          <MagneticTextureAssignmentSection
            draft={draft}
            model={model}
            updateDraft={updateDraft}
          />
          <MagneticTexturePresetParametersSection draft={draft} updateDraft={updateDraft} />
          <MagneticTextureRawAssetSection model={model} />
        </>
      ) : null}
      {inspectorView === "transform" ? (
        <>
          <MagneticTextureTransformSection draft={draft} model={model} updateDraft={updateDraft} />
          <MagneticTextureMappingSection draft={draft} updateDraft={updateDraft} />
          <MagneticTextureRawAssetSection model={model} />
        </>
      ) : null}
      {inspectorView === "overview" ? (
        <MagneticTextureRawAssetSection model={model} />
      ) : null}
      {inspectorView === "load" ? (
        <MagneticTextureLoadFileSection
          feedback={feedback}
          model={model}
          onLoad={() => void loadTextureFile()}
          pending={pending}
        />
      ) : null}
      {inspectorView !== "load" ? (
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
      ) : null}
    </div>
  );
}
