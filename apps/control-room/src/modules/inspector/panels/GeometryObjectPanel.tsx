import { useMemo, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  createObjectTransaction,
  commitObjectTransformTransaction,
  patchObjectGeometryTransaction,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  publishCommittedSceneResource,
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
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
type DraftField =
  | "archHeight"
  | "height"
  | "length"
  | "material"
  | "name"
  | "notes"
  | "radius"
  | "region"
  | "width"
  | "z0";
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
  committedScene?: SceneResource,
): void {
  if (committedScene) {
    publishCommittedSceneResource(resources, committedScene, revision);
  } else {
    resources.invalidate(MODEL_SCENE_PATH, revision);
  }
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
      invalidateAuthoringResources(
        resources,
        response.scene_revision,
        response.committed_scene,
      );
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
      invalidateAuthoringResources(
        resources,
        response.scene_revision,
        response.committed_scene,
      );
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
      invalidateAuthoringResources(
        resources,
        response.scene_revision,
        response.committed_scene,
      );
      setFeedback({ kind: "success", message: "Transform committed." });
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
    <div className="fm-inspector-panel grid min-w-0 gap-[var(--fm-inspector-group-gap)]">
      <InspectorGroup title="Geometry Object" collapsible defaultOpen>
        {draft.mode === "committed" && (
          <FieldRow label="Object ID" value={object.objectId} />
        )}
        <FieldRow label="Shape" value={object.shape} />
        <FieldRow label="Dimensions" value={object.dimensions} />
      </InspectorGroup>

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
        onRevertDraft={revertDraft}
      />
      <ValidationSection
        messages={validationMessages}
        status={validation.status}
      />
    </div>
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
    <InspectorGroup title="Primitive Geometry" collapsible defaultOpen>
      <FieldRow label="Kind" value={draft.geometryKind} />
      <PrimitiveGeometryFields
        draft={draft}
        onFieldChange={onFieldChange}
        onVectorChange={onVectorChange}
      />
    </InspectorGroup>
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

  if (geometryKind === "archwaveguide" || geometryKind === "arch_waveguide") {
    return (
      <>
        <FormField
          label="Length"
          type="number"
          unit="m"
          value={draft.length}
          onChange={(event) => onFieldChange("length", event.target.value)}
        />
        <FormField
          label="Width"
          type="number"
          unit="m"
          value={draft.width}
          onChange={(event) => onFieldChange("width", event.target.value)}
        />
        <FormField
          label="Height"
          type="number"
          unit="m"
          value={draft.height}
          onChange={(event) => onFieldChange("height", event.target.value)}
        />
        <FormField
          label="Arch height"
          type="number"
          unit="m"
          value={draft.archHeight}
          onChange={(event) => onFieldChange("archHeight", event.target.value)}
        />
        <FormField
          label="z0"
          type="number"
          unit="m"
          value={draft.z0}
          onChange={(event) => onFieldChange("z0", event.target.value)}
        />
      </>
    );
  }

  return (
    <DraftVectorFormField
      label="Size"
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
    <InspectorGroup title="Transform" collapsible defaultOpen>
      <DraftVectorFormField
        label="Translation"
        unit="m"
        values={draft.translation}
        onChange={(index, value) => onVectorChange("translation", index, value)}
      />
      <DraftVectorFormField
        label="Rotation"
        unit="rad"
        values={draft.rotation}
        onChange={(index, value) => onVectorChange("rotation", index, value)}
      />
      <DraftVectorFormField
        label="Scale"
        unit="x"
        values={draft.scale}
        onChange={(index, value) => onVectorChange("scale", index, value)}
      />
    </InspectorGroup>
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
    <InspectorGroup title="Draft Identity" collapsible defaultOpen>
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
    </InspectorGroup>
  );
}

function ActionsSection({
  draft,
  feedback,
  onApplyCreateDraft,
  onApplyGeometryPatch,
  onApplyTransformPatch,
  onRevertDraft,
  pending,
}: {
  draft: GeometryObjectDraft;
  feedback: Feedback | null;
  onApplyCreateDraft: () => Promise<void>;
  onApplyGeometryPatch: () => Promise<void>;
  onApplyTransformPatch: () => Promise<void>;
  onRevertDraft: () => void;
  pending: boolean;
}) {
  return (
    <InspectorGroup title="Actions">
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
            onRevertDraft={onRevertDraft}
          />
        )}
      </div>
      {feedback ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
    </InspectorGroup>
  );
}

function CommittedObjectActions({
  draft,
  onApplyGeometryPatch,
  onApplyTransformPatch,
  onRevertDraft,
  pending,
}: {
  draft: GeometryObjectDraft;
  onApplyGeometryPatch: () => Promise<void>;
  onApplyTransformPatch: () => Promise<void>;
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
    <InspectorGroup
      title="Validation"
      badge={messages.length > 0 ? String(messages.length) : undefined}
      collapsible
      defaultOpen={messages.length > 0}
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
    </InspectorGroup>
  );
}

function DraftVectorFormField({
  label,
  onChange,
  unit,
  values,
}: {
  label: string;
  onChange: (index: 0 | 1 | 2, value: string) => void;
  unit: string;
  values: readonly [string, string, string];
}) {
  return (
    <Vector3Field
      label={label}
      unit={unit}
      values={values}
      onChange={onChange}
    />
  );
}
