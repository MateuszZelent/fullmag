import { useEffect, useMemo, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  createObjectTransaction,
  commitObjectTransformTransaction,
  patchObjectGeometryTransaction,
  primitiveDraftOverlayStore,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import {
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
  resolvePrimitiveDraft,
  isPrimitiveDraftRevisionConflict,
  rebaseGeometryObjectDraft,
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
  }
  invalidateAuthoringMutationDependents(resources, "geometry", revision);
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
  const draftKey = `${baseDraft.mode}:${baseDraft.objectId}`;
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    feedback: null,
    key: draftKey,
  });
  const [pending, setPending] = useState(false);
  const [revisionConflictPhase, setRevisionConflictPhase] = useState<
    "conflict" | "rebased" | "refetched" | null
  >(null);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const feedback =
    feedbackState.key === draftKey ? feedbackState.feedback : null;
  const validationMessages = summarizeGeometryValidationMessages(
    validation.data,
    draft.objectId,
  );
  const primitiveDraft = useMemo(() => resolvePrimitiveDraft(draft), [draft]);

  useEffect(() => {
    if (draft.mode === "draft-new") {
      primitiveDraftOverlayStore.publish(primitiveDraft);
    } else {
      primitiveDraftOverlayStore.clear();
    }
  }, [draft.mode, primitiveDraft]);
  useEffect(() => () => primitiveDraftOverlayStore.clear(), []);

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
    setRevisionConflictPhase(null);
    try {
      const objectId = createDraftObjectId(draft);
      const response = await createObjectTransaction(api, {
        base_revision: draft.baseRevision,
        geometry: geometry.geometry,
        material_ref: optionalRef(draft.material),
        name: draft.name.trim() || objectId,
        object_id: objectId,
        region_name: optionalRef(draft.region),
        transform: transform.transform,
      });
      const revision = acknowledgedAuthoringSceneRevision(response);
      invalidateAuthoringResources(
        resources,
        revision,
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
      if (isPrimitiveDraftRevisionConflict(error)) {
        setRevisionConflictPhase("conflict");
      }
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function refetchAfterConflict(): Promise<void> {
    await scene.refetch();
    setRevisionConflictPhase("refetched");
    setFeedback({ kind: "error", message: "Scene refetched. Rebase the preserved draft before retrying." });
  }

  function rebaseAfterConflict(): void {
    updateDraft((current) =>
      rebaseGeometryObjectDraft(current, baseDraft.baseRevision),
    );
    setRevisionConflictPhase("rebased");
    setFeedback({ kind: "error", message: "Draft rebased to the latest scene revision. Review and retry Apply." });
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
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Geometry Object" collapsible defaultOpen>
        {draft.mode === "committed" && (
          <FieldRow label="Object ID" value={object.objectId} />
        )}
        <FieldRow label="Shape" value={object.shape} />
        <FieldRow label="Dimensions" value={object.dimensions} />
      </InspectorGroup>

      <PrimitiveGeometrySection
        draft={draft}
        errors={primitiveDraft.errors}
        onFieldChange={updateField}
        onVectorChange={updateVector}
      />
      <TransformSection
        draft={draft}
        errors={primitiveDraft.errors}
        onVectorChange={updateVector}
      />
      <DraftIdentitySection draft={draft} onFieldChange={updateField} />
      <ActionsSection
        draft={draft}
        feedback={feedback}
        pending={pending}
        onApplyCreateDraft={applyCreateDraft}
        onApplyGeometryPatch={applyGeometryPatch}
        onApplyTransformPatch={applyTransformPatch}
        onRevertDraft={revertDraft}
        onRebaseAfterConflict={rebaseAfterConflict}
        onRefetchAfterConflict={refetchAfterConflict}
        revisionConflictPhase={revisionConflictPhase}
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
  errors,
  onFieldChange,
  onVectorChange,
}: {
  draft: GeometryObjectDraft;
  errors: Readonly<Record<string, string>>;
  onFieldChange: DraftFieldUpdater;
  onVectorChange: VectorDraftUpdater;
}) {
  return (
    <InspectorGroup title="Primitive Geometry" collapsible defaultOpen>
      <FieldRow label="Kind" value={draft.geometryKind} />
      <PrimitiveGeometryFields
        draft={draft}
        errors={errors}
        onFieldChange={onFieldChange}
        onVectorChange={onVectorChange}
      />
    </InspectorGroup>
  );
}

function PrimitiveGeometryFields({
  draft,
  errors,
  onFieldChange,
  onVectorChange,
}: {
  draft: GeometryObjectDraft;
  errors: Readonly<Record<string, string>>;
  onFieldChange: DraftFieldUpdater;
  onVectorChange: VectorDraftUpdater;
}) {
  const geometryKind = draft.geometryKind.toLowerCase();
  if (geometryKind === "cylinder") {
    return (
      <>
        <FormField
          error={errors.radius}
          label="Radius"
          type="number"
          unit="m"
          value={draft.radius}
          onChange={(event) => onFieldChange("radius", event.target.value)}
        />
        <FormField
          error={errors.height}
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
        error={errors.radius}
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
      errors={[errors["size.0"], errors["size.1"], errors["size.2"]]}
      label="Size"
      unit="m"
      values={draft.size}
      onChange={(index, value) => onVectorChange("size", index, value)}
    />
  );
}

function TransformSection({
  draft,
  errors,
  onVectorChange,
}: {
  draft: GeometryObjectDraft;
  errors: Readonly<Record<string, string>>;
  onVectorChange: VectorDraftUpdater;
}) {
  return (
    <InspectorGroup title="Transform" collapsible defaultOpen>
      <DraftVectorFormField
        errors={[
          errors["translation.0"],
          errors["translation.1"],
          errors["translation.2"],
        ]}
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
  onRebaseAfterConflict,
  onRefetchAfterConflict,
  onRevertDraft,
  pending,
  revisionConflictPhase,
}: {
  draft: GeometryObjectDraft;
  feedback: Feedback | null;
  onApplyCreateDraft: () => Promise<void>;
  onApplyGeometryPatch: () => Promise<void>;
  onApplyTransformPatch: () => Promise<void>;
  onRebaseAfterConflict: () => void;
  onRefetchAfterConflict: () => Promise<void>;
  onRevertDraft: () => void;
  pending: boolean;
  revisionConflictPhase: "conflict" | "rebased" | "refetched" | null;
}) {
  return (
    <InspectorGroup title="Actions">
      <div className="fm-inspector-toolbar">
        {draft.mode === "draft-new" ? (
          <Button
            disabled={pending || revisionConflictPhase !== null}
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
      {revisionConflictPhase ? (
        <div className="fm-inspector-toolbar" data-revision-conflict="true">
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void onRefetchAfterConflict()}
          >
            Refetch Scene
          </Button>
          <Button
            disabled={pending || revisionConflictPhase !== "refetched"}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onRebaseAfterConflict}
          >
            Rebase Draft
          </Button>
          <Button
            disabled={pending || revisionConflictPhase !== "rebased"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void onApplyCreateDraft()}
          >
            Retry Apply
          </Button>
        </div>
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
  errors,
  label,
  onChange,
  unit,
  values,
}: {
  errors?: readonly (string | undefined)[];
  label: string;
  onChange: (index: 0 | 1 | 2, value: string) => void;
  unit: string;
  values: readonly [string, string, string];
}) {
  return (
    <Vector3Field
      errors={errors}
      label={label}
      unit={unit}
      values={values}
      onChange={onChange}
    />
  );
}
