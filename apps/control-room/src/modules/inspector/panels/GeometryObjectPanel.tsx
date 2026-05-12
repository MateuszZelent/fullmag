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
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
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
type DraftField = "height" | "material" | "name" | "radius" | "region";
type DraftFieldUpdater = (field: DraftField, value: string) => void;
type VectorDraftUpdater = (
  field: VectorDraftField,
  index: 0 | 1 | 2,
  value: string,
) => void;

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

  function updateField(field: DraftField, value: string): void {
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

  function revertDraft(): void {
    setDraftState({ draft: baseDraft, key: draftKey });
    setFeedback(null);
  }

  return (
    <div className="fm-inspector-panel">
      <GeometryObjectSummarySection object={object} />
      <GeometryResourceStateSection object={object} sceneStatus={scene.status} />
      <PrimitiveGeometrySection
        draft={draft}
        onFieldChange={updateField}
        onVectorChange={updateVector}
      />
      <TransformSection draft={draft} onVectorChange={updateVector} />
      <DraftIdentitySection draft={draft} onFieldChange={updateField} />
      <ActionsSection
        draft={draft}
        feedback={feedback}
        pending={pending}
        onApplyCreateDraft={applyCreateDraft}
        onApplyGeometryPatch={applyGeometryPatch}
        onApplyTransformPatch={applyTransformPatch}
        onDeleteObject={deleteObject}
        onRevertDraft={revertDraft}
      />
      <ValidationSection
        messages={validationMessages}
        status={validation.status}
      />
    </div>
  );
}

function GeometryObjectSummarySection({
  object,
}: {
  object: ReturnType<typeof resolveGeometryObjectPanelModel>;
}) {
  return (
    <InspectorSection title="Geometry Object" collapsible defaultCollapsed={false}>
      <FieldRow label="Name" value={object.name} />
      <FieldRow label="Object ID" value={object.objectId} />
      <FieldRow label="Shape" value={object.shape} />
      <FieldRow label="Dimensions" value={object.dimensions} />
      <FieldRow label="Material" value={object.material} />
      <FieldRow label="Region" value={object.region} />
    </InspectorSection>
  );
}

function GeometryResourceStateSection({
  object,
  sceneStatus,
}: {
  object: ReturnType<typeof resolveGeometryObjectPanelModel>;
  sceneStatus: string;
}) {
  return (
    <InspectorSection title="Resource State" collapsible defaultCollapsed={true}>
      <FieldRow label="Source" value={object.source} />
      <FieldRow label="Mode" value={object.mode} />
      <FieldRow label="Mesh" value={object.meshStatus} />
      <FieldRow
        label="Scene revision"
        value={object.revision === null ? "unknown" : String(object.revision)}
      />
      <FieldRow label="Fetch state" value={sceneStatus} />
    </InspectorSection>
  );
}

function PrimitiveGeometrySection({
  draft,
  onFieldChange,
  onVectorChange,
}: {
  draft: GeometryObjectDraft;
  onFieldChange: DraftFieldUpdater;
  onVectorChange: VectorDraftUpdater;
}) {
  return (
    <InspectorSection title="Primitive Geometry">
      <FieldRow label="Kind" value={draft.geometryKind} />
      <PrimitiveGeometryFields
        draft={draft}
        onFieldChange={onFieldChange}
        onVectorChange={onVectorChange}
      />
    </InspectorSection>
  );
}

function PrimitiveGeometryFields({
  draft,
  onFieldChange,
  onVectorChange,
}: {
  draft: GeometryObjectDraft;
  onFieldChange: DraftFieldUpdater;
  onVectorChange: VectorDraftUpdater;
}) {
  const geometryKind = draft.geometryKind.toLowerCase();
  if (geometryKind === "cylinder") {
    return (
      <>
        <FormField
          label="Radius"
          type="number"
          unit="m"
          value={draft.radius}
          onChange={(event) => onFieldChange("radius", event.target.value)}
        />
        <FormField
          label="Height"
          type="number"
          unit="m"
          value={draft.height}
          onChange={(event) => onFieldChange("height", event.target.value)}
        />
      </>
    );
  }

  if (geometryKind === "sphere") {
    return (
      <FormField
        label="Radius"
        type="number"
        unit="m"
        value={draft.radius}
        onChange={(event) => onFieldChange("radius", event.target.value)}
      />
    );
  }

  return (
    <DraftVectorFormField
      labels={["X", "Y", "Z"]}
      unit="m"
      values={draft.size}
      onChange={(index, value) => onVectorChange("size", index, value)}
    />
  );
}

function TransformSection({
  draft,
  onVectorChange,
}: {
  draft: GeometryObjectDraft;
  onVectorChange: VectorDraftUpdater;
}) {
  return (
    <InspectorSection title="Transform">
      <DraftVectorFormField
        labels={["TX", "TY", "TZ"]}
        unit="m"
        values={draft.translation}
        onChange={(index, value) => onVectorChange("translation", index, value)}
      />
      <DraftVectorFormField
        labels={["RX", "RY", "RZ"]}
        unit="rad"
        values={draft.rotation}
        onChange={(index, value) => onVectorChange("rotation", index, value)}
      />
      <DraftVectorFormField
        labels={["SX", "SY", "SZ"]}
        unit="x"
        values={draft.scale}
        onChange={(index, value) => onVectorChange("scale", index, value)}
      />
    </InspectorSection>
  );
}

function DraftIdentitySection({
  draft,
  onFieldChange,
}: {
  draft: GeometryObjectDraft;
  onFieldChange: DraftFieldUpdater;
}) {
  if (draft.mode !== "draft-new") return null;

  return (
    <InspectorSection title="Draft Identity">
      <FormField
        label="Name"
        mono={false}
        type="text"
        value={draft.name}
        onChange={(event) => onFieldChange("name", event.target.value)}
      />
      <FormField
        label="Region"
        mono={false}
        type="text"
        value={draft.region}
        onChange={(event) => onFieldChange("region", event.target.value)}
      />
      <FormField
        label="Material"
        mono={false}
        type="text"
        value={draft.material}
        onChange={(event) => onFieldChange("material", event.target.value)}
      />
    </InspectorSection>
  );
}

function ActionsSection({
  draft,
  feedback,
  onApplyCreateDraft,
  onApplyGeometryPatch,
  onApplyTransformPatch,
  onDeleteObject,
  onRevertDraft,
  pending,
}: {
  draft: GeometryObjectDraft;
  feedback: Feedback | null;
  onApplyCreateDraft: () => Promise<void>;
  onApplyGeometryPatch: () => Promise<void>;
  onApplyTransformPatch: () => Promise<void>;
  onDeleteObject: () => Promise<void>;
  onRevertDraft: () => void;
  pending: boolean;
}) {
  return (
    <InspectorSection title="Actions">
      <div className="fm-inspector-toolbar">
        {draft.mode === "draft-new" ? (
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void onApplyCreateDraft()}
          >
            Apply Draft
          </Button>
        ) : (
          <CommittedObjectActions
            draft={draft}
            pending={pending}
            onApplyGeometryPatch={onApplyGeometryPatch}
            onApplyTransformPatch={onApplyTransformPatch}
            onDeleteObject={onDeleteObject}
            onRevertDraft={onRevertDraft}
          />
        )}
      </div>
      {feedback ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
    </InspectorSection>
  );
}

function CommittedObjectActions({
  draft,
  onApplyGeometryPatch,
  onApplyTransformPatch,
  onDeleteObject,
  onRevertDraft,
  pending,
}: {
  draft: GeometryObjectDraft;
  onApplyGeometryPatch: () => Promise<void>;
  onApplyTransformPatch: () => Promise<void>;
  onDeleteObject: () => Promise<void>;
  onRevertDraft: () => void;
  pending: boolean;
}) {
  return (
    <>
      <Button
        disabled={pending || draft.mode !== "committed"}
        size="sm"
        type="button"
        variant="primary"
        onClick={() => void onApplyGeometryPatch()}
      >
        Apply Geometry
      </Button>
      <Button
        disabled={pending || draft.mode !== "committed"}
        size="sm"
        type="button"
        onClick={() => void onApplyTransformPatch()}
      >
        Apply Transform
      </Button>
      <Button
        disabled={pending}
        size="sm"
        type="button"
        variant="ghost"
        onClick={onRevertDraft}
      >
        Revert
      </Button>
      <span className="fm-inspector-toolbar__spacer" />
      <Button
        disabled={pending || draft.mode !== "committed"}
        size="sm"
        type="button"
        variant="danger"
        onClick={() => void onDeleteObject()}
      >
        Delete
      </Button>
    </>
  );
}

function ValidationSection({
  messages,
  status,
}: {
  messages: string[];
  status: string;
}) {
  return (
    <InspectorSection
      title="Validation"
      badge={messages.length > 0 ? String(messages.length) : undefined}
      collapsible
      defaultCollapsed={messages.length === 0}
    >
      <FieldRow label="Fetch state" value={status} />
      {messages.length > 0 ? (
        <ul className="fm-inspector-validation-list">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : (
        <FieldRow label="Backend validation" value="no object issues" />
      )}
    </InspectorSection>
  );
}

function DraftVectorFormField({
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
    <>
      {labels.map((label, index) => (
        <FormField
          key={label}
          label={label}
          type="number"
          unit={unit}
          value={values[index]}
          onChange={(event) => onChange(index as 0 | 1 | 2, event.target.value)}
        />
      ))}
    </>
  );
}
