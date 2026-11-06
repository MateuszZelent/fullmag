"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  captureAuthoringMutationFence,
} from "@/kernel/authoring/authoringHistoryMutation";
import type { MagnetizationApplyReceipt } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey, sessionResourceIdentityKey } from "@/kernel/resources/sessionResourceIdentity";
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
import { magnetizationTexturePresetOptions } from "@/shared/domain/magnetization-texture/texturePresets";
import { observationSourceWorkspaceStore } from "@/kernel/workspace/observationSourceWorkspace";
import { returnToCurrentFieldView } from "@/kernel/visualization/savedFieldPresentation";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorMetricStrip } from "../primitives/InspectorMetricStrip";
import { Vector3Field } from "../primitives/Vector3Field";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "./inspectorDraftState";
import {
  buildObjectMagneticTextureAssetDraft,
  buildMagnetizationApplyTarget,
  magneticTextureProjectionOptions,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftDirty,
  objectMagneticTextureDraftIdentityKey,
  objectMagneticTextureDraftKey,
  objectMagneticTexturePresetChangePatch,
  resolveObjectMagneticTexturePanelModel,
  type ObjectMagneticTextureDraft,
} from "./ObjectMagneticTexturePanelModel";
import {
  commitMagneticTextureApply,
  magneticTextureApplyMessage,
  magneticTextureInspectorView,
  syncAuthoringScriptBestEffort,
  type MagneticTexturePanelModel,
} from "./ObjectMagneticTexturePanelViewModel";

export type MagneticTextureFeedback =
  | {
      kind: "error";
      message: string;
    }
  | {
      kind: "success";
      message: string;
      preview?: { receipt: MagnetizationApplyReceipt; sessionScopeKey: string };
    }
  | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type UpdateMagneticTextureDraft = (
  patch: Partial<ObjectMagneticTextureDraft>,
) => void;

function MagneticTextureSummarySection({
  defaultOpen = true,
  model,
  regionsStatus,
  sceneStatus,
}: {
  defaultOpen?: boolean;
  model: MagneticTexturePanelModel;
  regionsStatus: string;
  sceneStatus: string;
}) {
  return (
    <InspectorGroup title="Magnetic Texture" collapsible defaultOpen={defaultOpen}>
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
        {magnetizationTexturePresetOptions(draft.presetKind).map((preset) => (
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

const BIMERON_FIELDS = [
  { field: "radius", label: "Radius", unit: "m" },
  { field: "wall_width", label: "Wall Width", unit: "m" },
  { field: "vorticity", label: "Vorticity" },
  { field: "helicity_rad", label: "Helicity", unit: "rad" },
  { field: "background_sign", label: "Background Sign" },
] as const satisfies readonly DraftNumberFieldSpec[];


const SKYRMIONIUM_FIELDS = [
  { field: "inner_radius", label: "Inner Radius", unit: "m" },
  { field: "outer_radius", label: "Outer Radius", unit: "m" },
  { field: "wall_width", label: "Wall Width", unit: "m" },
  { field: "chirality", label: "Chirality" },
  { field: "background_sign", label: "Background Sign" },
] as const satisfies readonly DraftNumberFieldSpec[];

const HOPFION_FIELDS = [
  { field: "radius", label: "Radius", unit: "m" },
  { field: "hopf_charge", label: "Hopf Charge" },
  { field: "background_sign", label: "Background Sign" },
  { field: "axial_scale", label: "Axial Scale" },
  { field: "phase_rad", label: "Phase", unit: "rad" },
] as const satisfies readonly DraftNumberFieldSpec[];

const COMPACT_HOPFION_FIELDS = [
  { field: "major_radius", label: "Major Radius", unit: "m" },
  { field: "minor_radius", label: "Minor Radius", unit: "m" },
] as const satisfies readonly DraftNumberFieldSpec[];

const VORTEX_WALL_FIELDS = [
  { field: "wall_half_width", label: "Wall Half-Width", unit: "m" },
  { field: "left_mx", label: "Left mx" },
  { field: "right_mx", label: "Right mx" },
  { field: "circulation", label: "Circulation" },
  { field: "core_polarity", label: "Core Polarity" },
  { field: "core_radius", label: "Core Radius", unit: "m" },
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
      {draft.presetKind === "random" || draft.presetKind === "random_seeded" ? (
        <DraftNumberField draft={draft} field="seed" label="Seed" updateDraft={updateDraft} />
      ) : null}
      {draft.presetKind === "vortex" || draft.presetKind === "antivortex" ? (
        <>
          <PlaneSelect draft={draft} updateDraft={updateDraft} />
          <DraftNumberFields draft={draft} fields={VORTEX_FIELDS} updateDraft={updateDraft} />
        </>
      ) : null}
      {draft.presetKind === "bloch_skyrmion" ||
      draft.presetKind === "neel_skyrmion" ||
      draft.presetKind === "antiskyrmion" ? (
        <>
          <PlaneSelect draft={draft} updateDraft={updateDraft} />
          <DraftNumberFields draft={draft} fields={SKYRMION_FIELDS} updateDraft={updateDraft} />
        </>
      ) : null}

      {draft.presetKind === "skyrmionium" ? (
        <>
          <PlaneSelect draft={draft} updateDraft={updateDraft} />
          <DraftSelectField
            draft={draft}
            field="kind"
            label="Kind"
            options={WALL_KIND_OPTIONS}
            updateDraft={updateDraft}
          />
          <DraftNumberFields
            draft={draft}
            fields={SKYRMIONIUM_FIELDS}
            updateDraft={updateDraft}
          />
        </>
      ) : null}
      {draft.presetKind === "hopfion" ? (
        <DraftNumberFields
          draft={draft}
          fields={HOPFION_FIELDS}
          updateDraft={updateDraft}
        />
      ) : null}
      {draft.presetKind === "hopfion_compact_support" ? (
        <DraftNumberFields
          draft={draft}
          fields={COMPACT_HOPFION_FIELDS}
          updateDraft={updateDraft}
        />
      ) : null}
      {draft.presetKind === "vortex_wall" ? (
        <>
          <PlaneSelect draft={draft} updateDraft={updateDraft} />
          <DraftNumberFields
            draft={draft}
            fields={VORTEX_WALL_FIELDS}
            updateDraft={updateDraft}
          />
        </>
      ) : null}
      {draft.presetKind === "bimeron" ? (
        <>
          <PlaneSelect draft={draft} updateDraft={updateDraft} />
          <DraftNumberFields draft={draft} fields={BIMERON_FIELDS} updateDraft={updateDraft} />
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
  const projectionOptions = magneticTextureProjectionOptions(draft.presetKind);
  return (
    <InspectorGroup title="Mapping" collapsible defaultOpen={false}>
      <FormField label="Space" type="select" value={draft.mappingSpace} onChange={(event) => updateDraft({ mappingSpace: event.target.value })}>
        <option value="object">Object</option>
        <option value="world">World</option>
      </FormField>
      <FormField label="Projection" type="select" value={draft.mappingProjection} onChange={(event) => updateDraft({ mappingProjection: event.target.value })}>
        {projectionOptions.includes("object_local") && <option value="object_local">Object local</option>}
        {projectionOptions.includes("planar_xy") && <option value="planar_xy">Planar XY</option>}
        {projectionOptions.includes("planar_xz") && <option value="planar_xz">Planar XZ</option>}
        {projectionOptions.includes("planar_yz") && <option value="planar_yz">Planar YZ</option>}
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

function MagneticTexturePreviewAction({
  receipt,
  sessionScopeKey,
}: { receipt: MagnetizationApplyReceipt; sessionScopeKey: string }) {
  const kernel = useKernel();
  const identity = useSessionResourceIdentity();
  const operation = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => operation.current?.abort(), []);
  const source = receipt.prepared_initial_state;
  if (!identity || sessionRequestScopeKey(identity) !== sessionScopeKey || !source ||
      source.scene_revision !== receipt.scene_revision || receipt.status !== "initial_state_ready") return null;
  const scope = receipt.scopes[0];
  const sessionIdentityKey = sessionResourceIdentityKey(identity);

  async function show() {
    if (operation.current || !source || !scope) return;
    const abort = new AbortController();
    const displayedObservation = observationSourceWorkspaceStore.getSnapshot();
    const displayedResult = kernel.savedResultsPlayback?.getSnapshot();
    const selectedTarget = kernel.selection.get();
    operation.current = abort;
    setLoading(true);
    setError(null);
    try {
      await kernel.api.data.fields.preparedMagnetization(
        source, { max_samples: 1 }, { sessionScopeKey, signal: abort.signal },
      );
      if (abort.signal.aborted || kernel.commands.getSessionScopeKey() !== sessionScopeKey ||
          observationSourceWorkspaceStore.getSnapshot() !== displayedObservation ||
          kernel.savedResultsPlayback?.getSnapshot() !== displayedResult ||
          kernel.selection.get() !== selectedTarget) return;
      if (!returnToCurrentFieldView(kernel.visualization, kernel.selection, "inspector")) {
        throw new Error("Apply or discard the current Inspector draft before opening the preview.");
      }
      kernel.analysisFieldOverlay.clear();
      kernel.visualization.setArtifactFieldSelection(null);
      observationSourceWorkspaceStore.showPrepared({
        source,
        sessionIdentityKey,
        objectId: scope.object_id,
        regionId: scope.region_id ?? null,
      });
      kernel.savedResultsPlayback?.close();
      kernel.layout.setActiveViewportMainModule("viewport-3d");
    } catch (failure) {
      if (!abort.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (operation.current === abort) operation.current = null;
      if (!abort.signal.aborted) setLoading(false);
    }
  }

  return <>
    <Button size="sm" type="button" variant="secondary" disabled={loading} onClick={() => void show()}>
      {loading ? "Checking initial magnetization…" : "Show initial magnetization"}
    </Button>
    {error && <FeedbackBanner kind="error" message={error} />}
  </>;
}

export function MagneticTextureActionsSection({
  capability = null,
  dirty,
  feedback,
  model,
  onClear,
  onActivateLoad,
  onRevert,
  onSave,
  pending,
  stagedDraft = false,
}: {
  capability?: ActiveLaneOperationResolution | null;
  dirty: boolean;
  feedback: MagneticTextureFeedback;
  model: MagneticTexturePanelModel;
  onClear: () => void;
  onActivateLoad: () => void;
  onRevert: () => void;
  onSave: () => void;
  pending: boolean;
  stagedDraft?: boolean;
}) {
  const preview = feedback?.kind === "success" ? feedback.preview : undefined;
  const previewScope = preview?.receipt.scopes[0];
  const showPreview = !pending && preview && previewScope?.object_id === model.objectId &&
    (previewScope.region_id ?? null) === (model.regionId ?? null);
  return (
    <InspectorGroup title="Actions">
      <div className="fm-inspector-toolbar">
        {!stagedDraft || !dirty ? (
          <Button
            disabled={
              pending ||
              model.mode !== "committed" ||
              (model.targetKind === "region" && !model.authoredRegion) ||
              (capability !== null && !capability.enabled)
            }
            size="sm"
            type="button"
            variant="primary"
            onClick={onSave}
          >
            {stagedDraft ? "Reapply Texture" : "Apply Texture"}
          </Button>
        ) : null}
        <Button
          disabled={pending || model.mode !== "committed" || model.targetKind !== "object"}
          size="sm"
          type="button"
          variant="ghost"
          onClick={onActivateLoad}
        >
          Load Texture
        </Button>
        {!stagedDraft ? (
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onRevert}
          >
            Revert
          </Button>
        ) : null}
        <Button
          disabled={pending || model.mode !== "committed" ||
            (model.targetKind === "region" && !model.authoredRegion)}
          size="sm"
          type="button"
          variant="ghost"
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
      <FieldRow label="Draft" value={dirty ? "modified" : "clean"} />
      {capability ? (
        <FieldRow
          label="Capability"
          value={`${capability.state}: ${capability.reason}`}
        />
      ) : null}
      {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
      {showPreview && (
        <MagneticTexturePreviewAction
          key={preview.receipt.operation_id}
          receipt={preview.receipt}
          sessionScopeKey={preview.sessionScopeKey}
        />
      )}
    </InspectorGroup>
  );
}

export interface ObjectMagneticTexturePanelProps extends InspectorPanelProps {
  sectionScope?: "overview" | "asset" | "load" | "region" | "transform";
}

export function ObjectMagneticTexturePanel({
  selection,
  sectionScope,
}: ObjectMagneticTexturePanelProps) {
  const kernel = useKernel();
  const { api, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const activeLane = useActiveLaneCapabilities();
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
  const resourceRevision = model.baseRevision ?? scene.data?.revision ?? -1;
  const [baselineState, setBaselineState] = useState<{
    draft: ObjectMagneticTextureDraft;
    identityKey: string;
    revision: number;
  }>({ draft: baseDraft, identityKey: draftIdentityKey, revision: resourceRevision });
  const baselineDraft = baselineState.identityKey === draftIdentityKey &&
    resourceRevision < baselineState.revision
    ? baselineState.draft
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
  const [pending, setPending] = useState(false);
  const { draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: objectMagneticTextureDraftDirty,
    state: draftState,
  });
  const dirty = objectMagneticTextureDraftDirty(draft, baselineDraft);
  const mutationInFlight = useRef(false);
  const acknowledgeTextureDraftRef = useRef<(() => boolean) | null>(null);
  const textureCapabilityOperation =
    draft.presetKind === "uniform"
      ? "initial_magnetization.uniform"
      : draft.presetKind === "vortex"
        ? "initial_magnetization.vortex"
        : null;
  const textureCapability = textureCapabilityOperation
    ? resolveActiveLaneOperation(activeLane, textureCapabilityOperation)
    : null;
  const inspectorView = sectionScope ?? magneticTextureInspectorView(selection.kind);

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

  function invalidateTextureResources(revision: number): void {
    invalidateAuthoringMutationDependents(resources, "magnetization", revision);
  }

  async function saveTexture(draftToApply: ObjectMagneticTextureDraft | null = draft): Promise<boolean> {
    const acknowledgeDraft = acknowledgeTextureDraftRef.current;
    if (mutationInFlight.current) return false;
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return false;
    }
    if (draftToApply && textureCapability && !textureCapability.enabled) {
      setFeedback({ kind: "error", message: textureCapability.reason });
      return false;
    }
    if (model.targetKind === "region" && !model.authoredRegion) {
      setFeedback({ kind: "error", message: "Select an authored magnetic region to apply its texture." });
      return false;
    }
    if (!sessionScopeKey) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return false;
    }

    const submittedDraft = draft;
    const mutationContext = captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, {
        resourceData: { [SCENE_RESOURCE_KEY]: scene.data },
        sessionScopeKey,
      }),
    );
    const isCurrentSession = () => mutationContext.isCurrentSessionScope?.() === true;
    mutationInFlight.current = true;
    setPending(true);
    try {
      const target = buildMagnetizationApplyTarget(model, draftToApply);
      const response = await commitMagneticTextureApply(api, mutationContext, target, model.baseRevision);
      if (!isCurrentSession()) return false;
      const revision = acknowledgedAuthoringSceneRevision(response);
      publishCommittedSceneResource(resources, response.committed_scene, revision,
        undefined, false, sessionScopeKey, api.resourceCacheScope);
      invalidateTextureResources(revision);
      const syncWarning = await syncAuthoringScriptBestEffort(api, sessionScopeKey);
      if (!isCurrentSession()) return false;
      const acknowledgedDraft = objectMagneticTextureDraftFromModel(
        resolveObjectMagneticTexturePanelModel(selection, response.committed_scene, regions.data),
      );
      setBaselineState({
        draft: acknowledgedDraft,
        identityKey: draftIdentityKey,
        revision,
      });
      if (
        draftStateRef.current.identityKey === draftIdentityKey &&
        draftStateRef.current.draft === submittedDraft &&
        acknowledgeDraft?.()
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
        preview: { receipt: response.magnetization_apply, sessionScopeKey },
      });
      return true;
    } catch (error) {
      if (!isCurrentSession()) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      mutationInFlight.current = false;
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
    if (mutationInFlight.current) return;
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

  function resetDraft(): void {
    if (mutationInFlight.current) return;
    replaceDraftState({
      baseKey: draftKey,
      dirty: false,
      draft: baselineDraft,
      identityKey: draftIdentityKey,
    });
    setFeedback(null);
  }

  let validationError: string | null = null;
  if (
    inspectorView === "overview" ||
    inspectorView === "asset" ||
    inspectorView === "region" ||
    inspectorView === "transform"
  ) {
    try {
      buildObjectMagneticTextureAssetDraft(model, draft);
    } catch (error) {
      validationError = errorMessage(error);
    }
  }
  const editableTextureView =
    inspectorView === "overview" ||
    inspectorView === "asset" ||
    inspectorView === "region" ||
    inspectorView === "transform";
  const valid = model.mode === "committed" &&
    validationError === null &&
    (!textureCapability || textureCapability.enabled) &&
    !(model.targetKind === "region" && !model.authoredRegion);
  const applyBlockReason = !sessionScopeKey
    ? "Session identity is not ready."
    : textureCapability && !textureCapability.enabled
      ? textureCapability.reason
      : validationError ?? undefined;
  const acknowledgeTextureDraft = useRegisterInspectorEditSession(
    editableTextureView ? "staged" : "immediate",
    pending,
    editableTextureView && dirty,
    editableTextureView ? valid : true,
    undefined,
    saveTexture,
    resetDraft,
    {
      applyBlockReason: editableTextureView ? applyBlockReason : undefined,
      historyMode: "mutation-owned",
    },
  );
  useLayoutEffect(() => {
    acknowledgeTextureDraftRef.current = acknowledgeTextureDraft;
  }, [acknowledgeTextureDraft]);

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorMetricStrip
        metrics={[
          { label: "Target", value: model.regionId ?? model.objectId },
          { label: "Preset", value: draft.presetKind },
          { label: "Asset", value: model.assetId },
          {
            label: "State",
            tone: dirty ? "warning" : "neutral",
            value: dirty ? "modified" : model.assignment,
          },
        ]}
      />
      {inspectorView === "overview" ? (
        <>
          <MagneticTextureAssignmentSection
            draft={draft}
            model={model}
            updateDraft={updateDraft}
          />
          <MagneticTexturePresetParametersSection draft={draft} updateDraft={updateDraft} />
          <MagneticTextureSummarySection
            defaultOpen={false}
            model={model}
            regionsStatus={regions.status}
            sceneStatus={scene.status}
          />
          <MagneticTextureRawAssetSection model={model} />
        </>
      ) : null}
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
        </>
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
          capability={textureCapability}
          dirty={dirty}
          feedback={feedback}
          model={model}
          onClear={() => void saveTexture(null)}
          onActivateLoad={() => void activateLoadTextureNode()}
          onRevert={resetDraft}
          onSave={() => void saveTexture()}
          pending={pending}
          stagedDraft={editableTextureView}
        />
      ) : null}
    </div>
  );
}
