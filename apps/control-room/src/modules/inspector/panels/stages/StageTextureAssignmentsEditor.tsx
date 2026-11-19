"use client";

import { useState } from "react";

import type { JsonObject, JsonValue, SceneResource } from "@/kernel/api/apiTypes";
import type { RegionVisualizationTargetId, Selection } from "@/kernel/selection/selectionTypes";
import { buildRegionTextureOverridePatch } from "@/shared/domain/magnetization-texture/draftModel";
import {
  magnetizationTexturePresetOptions,
  type MagnetizationTexturePresetId,
} from "@/shared/domain/magnetization-texture/texturePresets";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  MagneticTextureMappingSection,
  MagneticTexturePresetParametersSection,
  MagneticTextureTransformSection,
} from "../ObjectMagneticTexturePanel";
import {
  buildObjectMagneticTextureAssetDraft,
  objectMagneticTextureDraftFromModel,
  objectMagneticTexturePresetChangePatch,
  resolveObjectMagneticTexturePanelModel,
  type ObjectMagneticTexturePanelModel,
} from "../ObjectMagneticTexturePanelModel";
import {
  readStageTextureAssignments,
  stageTextureAssignmentsValue,
  type StageTextureAssignment,
} from "../StudyStageAuthoringModel";

const MAX_ASSIGNMENTS = 4096;

export function StageTextureAssignmentsEditor({
  disabledReason,
  onChange,
  onOpenChange,
  open,
  scene,
  value,
}: {
  disabledReason: string | null;
  onChange: (value: JsonValue | undefined) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  scene: SceneResource;
  value: JsonValue | undefined;
}) {
  const assignments = readStageTextureAssignments(value);
  const magnets = (scene.objects ?? []).filter((object) => object.role === "magnet");
  const [objectId, setObjectId] = useState("");
  const [regionId, setRegionId] = useState("");
  const object = objectId ? magnets.find((candidate) => candidate.id === objectId) : magnets[0];
  const region = object?.regions?.find((candidate) => candidate.region_id === regionId && candidate.enabled !== false);
  const disabled = disabledReason !== null;
  const addBlockedReason = disabledReason ?? (!magnets.length ? "Add a magnetic object first."
    : assignments?.length === MAX_ASSIGNMENTS ? "The stage assignment limit has been reached." : null);
  const model = object && (!regionId || region) ? resolveObjectMagneticTexturePanelModel(
    textureSelection(object.id, region?.region_id), scene,
  ) : null;

  return (
    <InspectorGroup title="Texture changes before this stage">
      <p>The configured Study flow applies these changes only at this stage.</p>
      {assignments === null ? (
        <>
          <FeedbackBanner kind="error" message="This stage has an unreadable texture assignment list." />
          <Button disabled={disabled} onClick={() => onChange(undefined)} size="sm" type="button">
            Remove invalid texture list
          </Button>
        </>
      ) : assignments.length > 0 ? (
        <ol>
          {assignments.map((assignment, index) => {
            const target = magnets.find((item) => item.id === assignment.object_id);
            const targetRegion = target?.regions?.find((item) => item.region_id === assignment.region_id);
            const scope = [target?.name || assignment.object_id, targetRegion?.name || assignment.region_id]
              .filter(Boolean).join(" / ");
            const texture = assignment.initializer
              ? String(assignment.initializer.preset_kind ?? assignment.initializer.kind)
              : assignment.region_id ? "Use object texture" : "Uniform +X";
            return (
              <li key={index} className="fm-inspector-toolbar">
                <span>{scope} · {texture}</span>
                <Button
                  aria-label={`Remove texture change ${index + 1} for ${scope}`}
                  disabled={disabled || open}
                  onClick={() => onChange(stageTextureAssignmentsValue(assignments.filter((_, i) => i !== index)))}
                  size="sm"
                  type="button"
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {!open && assignments !== null ? (
        <Button disabled={addBlockedReason !== null} title={addBlockedReason ?? undefined} size="sm"
          type="button" onClick={() => onOpenChange(true)}>
          Add texture change
        </Button>
      ) : null}
      {open && assignments !== null ? (
        <>
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={disabled}>
            <FormField label="Magnetic object" type="select" value={object?.id ?? ""} onChange={(event) => {
              setObjectId(event.target.value);
              setRegionId("");
            }}>
              {!object ? <option value="">Choose a magnetic object</option> : null}
              {magnets.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
            </FormField>
            <FormField label="Apply to" type="select" value={regionId}
              onChange={(event) => setRegionId(event.target.value)}>
              <option value="">Object (region overrides apply)</option>
              {regionId && !region ? <option value={regionId} disabled>Region is unavailable</option> : null}
              {object?.regions?.filter((item) => item.enabled !== false && item.region_id)
                .map((item) => <option key={item.region_id} value={item.region_id}>{item.name}</option>)}
            </FormField>
            {model ? <StageTexturePresetForm
              key={JSON.stringify([model.objectId, model.regionId])}
              model={model}
              onAdd={(assignment) => {
                if (addBlockedReason !== null) return;
                onChange(stageTextureAssignmentsValue([...assignments, assignment]));
                onOpenChange(false);
              }}
            /> : null}
          </fieldset>
          <Button onClick={() => onOpenChange(false)} size="sm" type="button">Cancel texture change</Button>
        </>
      ) : null}
      {addBlockedReason ? <p role="status">{addBlockedReason}</p> : null}
    </InspectorGroup>
  );
}

function StageTexturePresetForm({ model, onAdd }: {
  model: ObjectMagneticTexturePanelModel;
  onAdd: (assignment: StageTextureAssignment) => void;
}) {
  const [draft, setDraft] = useState(() => objectMagneticTextureDraftFromModel(model));
  const [reset, setReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateDraft = (patch: Partial<typeof draft>) => {
    setError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  return (
    <>
      <FormField label="Texture" type="select" value={reset ? "reset" : draft.presetKind} onChange={(event) => {
        const value = event.target.value;
        setReset(value === "reset");
        if (value !== "reset") updateDraft(objectMagneticTexturePresetChangePatch(
          model, draft, value as MagnetizationTexturePresetId,
        ));
      }}>
        {magnetizationTexturePresetOptions(draft.presetKind)
          .map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        <option value="reset">{model.regionId ? "Use object texture" : "Reset to uniform +X"}</option>
      </FormField>
      {!reset ? <>
        <MagneticTexturePresetParametersSection draft={draft} updateDraft={updateDraft} />
        <MagneticTextureTransformSection draft={draft} model={model} updateDraft={updateDraft} />
        <MagneticTextureMappingSection draft={draft} updateDraft={updateDraft} />
      </> : null}
      {error ? <FeedbackBanner kind="error" message={error} /> : null}
      <Button size="sm" type="button" onClick={() => {
        try {
          const initializer = reset ? null : buildRegionTextureOverridePatch(
            buildObjectMagneticTextureAssetDraft(model, draft),
          ).texture_override?.initial_magnetization as JsonObject | undefined;
          if (initializer === undefined) throw new Error("No texture could be prepared for this stage.");
          onAdd({ object_id: model.objectId, region_id: model.regionId, initializer });
        } catch (error) {
          setError(error instanceof Error ? error.message : "Could not add the texture change.");
        }
      }}>Add to stage</Button>
    </>
  );
}

function textureSelection(objectId: string, regionId: string | undefined): Selection {
  const kind = regionId ? "object.region.texture" : "object.magnetic-texture";
  return {
    kind, label: "Texture", moduleSource: "inspector", nodeId: null, objectId,
    ref: {
      kind, nodeId: "", objectId, regionId, type: "scene-object",
      visualizationTargetId: regionId
        ? `region:${objectId}:${encodeURIComponent(regionId)}` as RegionVisualizationTargetId
        : `object:${objectId}`,
    },
  };
}
