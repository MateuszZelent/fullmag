import { useMemo, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import {
  createObjectTransaction,
  commitObjectTransformTransaction,
  deleteObjectTransaction,
  patchObjectGeometryTransaction,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildGeometryDraftPatch,
  buildTransformDraftPatch,
  createDraftObjectId,
  resolveGeometryObjectDraft,
  resolveGeometryObjectPanelModel,
  summarizeGeometryValidationMessages,
  type GeometryObjectDraft,
} from "./geometryObjectPanelModel";

type Feedback = {
  kind: "error" | "success";
  message: string;
};

interface DraftState {
  draft: GeometryObjectDraft;
  key: string;
}

interface FeedbackState {
  feedback: Feedback | null;
  key: string;
}

type VectorDraftField = "rotation" | "scale" | "size" | "translation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalRef(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed && trimmed !== "unassigned" ? trimmed : undefined;
}

function invalidateAuthoringResources(
  resources: ReturnType<typeof useKernel>["resources"],
  revision: number,
): void {
  resources.invalidate(MODEL_SCENE_PATH, revision);
  resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
  resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
  resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
  resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
}

export function GeometryObjectPanel({ selection }: InspectorPanelProps) {
  const { api, resources, selection: selectionController } = useKernel();
  const scene = useSceneResource();
  const validation = useGeometryValidationResource();
  const object = resolveGeometryObjectPanelModel(selection, scene.data);
  const baseDraft = useMemo(
    () => resolveGeometryObjectDraft(selection, scene.data),
    [scene.data, selection],
  );
  const draftKey = `${baseDraft.mode}:${baseDraft.objectId}:${baseDraft.baseRevision}`;
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    feedback: null,
    key: draftKey,
  });
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const feedback =
    feedbackState.key === draftKey ? feedbackState.feedback : null;
  const validationMessages = summarizeGeometryValidationMessages(
    validation.data,
    draft.objectId,
  );

  function updateDraft(updater: (current: GeometryObjectDraft) => GeometryObjectDraft): void {
    setDraftState((current) => ({
      draft: updater(current.key === draftKey ? current.draft : baseDraft),
      key: draftKey,
    }));
  }

  function setFeedback(feedbackValue: Feedback | null): void {
    setFeedbackState({
      feedback: feedbackValue,
      key: draftKey,
    });
  }

  function updateField(
    field: "height" | "material" | "name" | "radius" | "region",
    value: string,
  ): void {
    updateDraft((current) => ({ ...current, [field]: value }));
  }

  function updateVector(
    field: VectorDraftField,
    index: 0 | 1 | 2,
    value: string,
  ): void {
    updateDraft((current) => {
      const next = [...current[field]] as [string, string, string];
      next[index] = value;
      return { ...current, [field]: next };
    });
  }

  async function applyCreateDraft(): Promise<void> {
    const geometry = buildGeometryDraftPatch(draft);
    if (geometry.error || !geometry.geometry) {
      setFeedback({ kind: "error", message: geometry.error ?? "Invalid geometry draft." });
      return;
    }
    const transform = buildTransformDraftPatch(draft);
    if (transform.error || !transform.transform) {
      setFeedback({ kind: "error", message: transform.error ?? "Invalid transform draft." });
      return;
    }

    setPending(true);
    try {
      const objectId = createDraftObjectId(draft);
      const response = await createObjectTransaction(api, {
        geometry: geometry.geometry,
        material_ref: optionalRef(draft.material),
        name: draft.name.trim() || objectId,
        object_id: objectId,
        region_name: optionalRef(draft.region),
        transform: transform.transform,
      });
      invalidateAuthoringResources(resources, response.scene_revision);
      selectionController.set(
        {
          kind: "object.root",
          label: draft.name.trim() || objectId,
          nodeId: `model:object:${objectId}`,
          objectId,
          ref: {
            kind: "object.root",
            nodeId: `model:object:${objectId}`,
            objectId,
            type: "scene-object",
            visualizationTargetId: `object:${objectId}`,
          },
        },
        "geometry-authoring",
      );
      setFeedback({ kind: "success", message: "Object draft committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function applyGeometryPatch(): Promise<void> {
    const geometry = buildGeometryDraftPatch(draft);
    if (geometry.error || !geometry.geometry) {
      setFeedback({ kind: "error", message: geometry.error ?? "Invalid geometry draft." });
      return;
    }

    setPending(true);
    try {
      const response = await patchObjectGeometryTransaction(api, draft.objectId, {
        base_revision: draft.baseRevision,
        geometry: geometry.geometry,
      });
      invalidateAuthoringResources(resources, response.scene_revision);
      setFeedback({ kind: "success", message: "Geometry patch committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function applyTransformPatch(): Promise<void> {
    const transform = buildTransformDraftPatch(draft);
    if (transform.error || !transform.transform) {
      setFeedback({ kind: "error", message: transform.error ?? "Invalid transform draft." });
      return;
    }

    setPending(true);
    try {
      const response = await commitObjectTransformTransaction(api, draft.objectId, {
        base_revision: draft.baseRevision,
        transform: transform.transform,
      });
      invalidateAuthoringResources(resources, response.scene_revision);
      setFeedback({ kind: "success", message: "Transform committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function deleteObject(): Promise<void> {
    if (draft.mode !== "committed") return;
    setPending(true);
    try {
      const response = await deleteObjectTransaction(api, draft.objectId, {
        base_revision: draft.baseRevision,
      });
      invalidateAuthoringResources(resources, response.scene_revision);
      selectionController.clear("geometry-authoring");
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Geometry Object">
        <FieldRow label="Name" value={object.name} />
        <FieldRow label="Object ID" value={object.objectId} />
        <FieldRow label="Shape" value={object.shape} />
        <FieldRow label="Dimensions" value={object.dimensions} />
        <FieldRow label="Material" value={object.material} />
        <FieldRow label="Region" value={object.region} />
      </InspectorSection>
      <InspectorSection title="Resource State">
        <FieldRow label="Source" value={object.source} />
        <FieldRow label="Mode" value={object.mode} />
        <FieldRow label="Mesh" value={object.meshStatus} />
        <FieldRow
          label="Scene revision"
          value={object.revision === null ? "unknown" : String(object.revision)}
        />
        <FieldRow label="Fetch state" value={scene.status} />
      </InspectorSection>
      <InspectorSection title="Primitive Geometry">
        <FieldRow label="Kind" value={draft.geometryKind} />
        {draft.geometryKind.toLowerCase() === "cylinder" ? (
          <>
            <DraftNumberField
              label="Radius"
              unit="m"
              value={draft.radius}
              onChange={(value) => updateField("radius", value)}
            />
            <DraftNumberField
              label="Height"
              unit="m"
              value={draft.height}
              onChange={(value) => updateField("height", value)}
            />
          </>
        ) : draft.geometryKind.toLowerCase() === "sphere" ? (
          <DraftNumberField
            label="Radius"
            unit="m"
            value={draft.radius}
            onChange={(value) => updateField("radius", value)}
          />
        ) : (
          <DraftVectorField
            labels={["X", "Y", "Z"]}
            unit="m"
            values={draft.size}
            onChange={(index, value) => updateVector("size", index, value)}
          />
        )}
      </InspectorSection>
      <InspectorSection title="Transform">
        <DraftVectorField
          labels={["TX", "TY", "TZ"]}
          unit="m"
          values={draft.translation}
          onChange={(index, value) => updateVector("translation", index, value)}
        />
        <DraftVectorField
          labels={["RX", "RY", "RZ"]}
          unit="rad"
          values={draft.rotation}
          onChange={(index, value) => updateVector("rotation", index, value)}
        />
        <DraftVectorField
          labels={["SX", "SY", "SZ"]}
          unit="x"
          values={draft.scale}
          onChange={(index, value) => updateVector("scale", index, value)}
        />
      </InspectorSection>
      {draft.mode === "draft-new" ? (
        <InspectorSection title="Draft Identity">
          <DraftTextField
            label="Name"
            value={draft.name}
            onChange={(value) => updateField("name", value)}
          />
          <DraftTextField
            label="Region"
            value={draft.region}
            onChange={(value) => updateField("region", value)}
          />
          <DraftTextField
            label="Material"
            value={draft.material}
            onChange={(value) => updateField("material", value)}
          />
        </InspectorSection>
      ) : null}
      <InspectorSection title="Transactions">
        <div className="fm-inspector-actions">
          {draft.mode === "draft-new" ? (
            <Button
              disabled={pending}
              size="sm"
              type="button"
              variant="primary"
              onClick={() => void applyCreateDraft()}
            >
              Apply Draft
            </Button>
          ) : (
            <>
              <Button
                disabled={pending || draft.mode !== "committed"}
                size="sm"
                type="button"
                variant="primary"
                onClick={() => void applyGeometryPatch()}
              >
                Apply Geometry
              </Button>
              <Button
                disabled={pending || draft.mode !== "committed"}
                size="sm"
                type="button"
                onClick={() => void applyTransformPatch()}
              >
                Apply Transform
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
                Revert Draft
              </Button>
              <Button
                disabled={pending || draft.mode !== "committed"}
                size="sm"
                type="button"
                variant="danger"
                onClick={() => void deleteObject()}
              >
                Delete Object
              </Button>
            </>
          )}
        </div>
      </InspectorSection>
      <InspectorSection title="Diagnostics">
        <FieldRow label="Validation fetch" value={validation.status} />
        {feedback ? (
          <p
            className="fm-inspector-validation-message"
            data-kind={feedback.kind}
          >
            {feedback.message}
          </p>
        ) : null}
        {validationMessages.length > 0 ? (
          <ul className="fm-inspector-validation-list">
            {validationMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : (
          <FieldRow label="Backend validation" value="no object issues" />
        )}
      </InspectorSection>
    </div>
  );
}

function DraftTextField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="fm-inspector-edit-field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function DraftNumberField({
  label,
  onChange,
  unit,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  unit: string;
  value: string;
}) {
  return (
    <label className="fm-inspector-edit-field">
      <span>{label}</span>
      <span className="fm-inspector-edit-field__control">
        <input
          aria-label={label}
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <small>{unit}</small>
      </span>
    </label>
  );
}

function DraftVectorField({
  labels,
  onChange,
  unit,
  values,
}: {
  labels: readonly [string, string, string];
  onChange: (index: 0 | 1 | 2, value: string) => void;
  unit: string;
  values: readonly [string, string, string];
}) {
  return (
    <div className="fm-inspector-vector-field">
      {labels.map((label, index) => (
        <DraftNumberField
          key={label}
          label={label}
          unit={unit}
          value={values[index]}
          onChange={(value) => onChange(index as 0 | 1 | 2, value)}
        />
      ))}
    </div>
  );
}
