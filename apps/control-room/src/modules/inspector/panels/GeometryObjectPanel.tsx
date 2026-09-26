import { useEffect, useMemo, useRef, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  createObjectTransaction,
  patchObjectGeometryTransaction,
  primitiveDraftOverlayStore,
} from "@/kernel/authoring/geometryLifecycleCommands";
import {
  commitObjectTranslation,
  PROBLEM_IR_03_RIGID_TRANSFORM_REASON,
} from "@/kernel/authoring/objectTranslationMutation";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
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

interface PendingOperationState {
  draftKey: string;
  operationId: number;
  pending: boolean;
  sessionScopeKey: string | null;
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

function sameDraftFields(
  left: GeometryObjectDraft,
  right: GeometryObjectDraft,
  fields: readonly (keyof GeometryObjectDraft)[],
): boolean {
  return fields.every((field) => JSON.stringify(left[field]) === JSON.stringify(right[field]));
}

function sameDraftValues(left: GeometryObjectDraft, right: GeometryObjectDraft): boolean {
  return sameDraftFields(left, right, [
    "archHeight",
    "geometryKind",
    "height",
    "length",
    "material",
    "name",
    "radius",
    "region",
    "size",
    "translation",
    "width",
    "z0",
  ]);
}

function invalidateAuthoringResources(
  resources: ReturnType<typeof useKernel>["resources"],
  revision: number,
  committedScene?: SceneResource,
  sessionScopeKey?: string | null,
): void {
  if (committedScene) {
    publishCommittedSceneResource(
      resources,
      committedScene,
      revision,
      undefined,
      false,
      sessionScopeKey,
    );
  }
  invalidateAuthoringMutationDependents(resources, "geometry", revision);
}

export function GeometryObjectPanel({ selection }: InspectorPanelProps) {
  const {
    api,
    authoringHistory,
    commands,
    layout,
    resources,
    selection: selectionController,
  } = useKernel();
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
  const [pendingState, setPendingState] = useState<PendingOperationState>({
    draftKey,
    operationId: 0,
    pending: false,
    sessionScopeKey: commands.getSessionScopeKey() ?? null,
  });
  const pendingOperationId = useRef(0);
  const currentSessionScopeKey = commands.getSessionScopeKey() ?? null;
  const pending = pendingState.pending &&
    pendingState.draftKey === draftKey &&
    pendingState.sessionScopeKey === currentSessionScopeKey;
  const [revisionConflictPhase, setRevisionConflictPhase] = useState<
    "conflict" | "refresh-error" | "refreshing" | "rebased" | "refetched" | null
  >(null);
  const [conflictBaseRevision, setConflictBaseRevision] = useState<number | null>(null);
  const [conflictOperation, setConflictOperation] = useState<
    "create" | "geometry" | "transform"
  >("create");
  const [refreshSawLoading, setRefreshSawLoading] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const feedback =
    feedbackState.key === draftKey ? feedbackState.feedback : null;
  const validationMessages = summarizeGeometryValidationMessages(
    validation.data,
    draft.objectId,
  );
  const primitiveDraft = useMemo(() => resolvePrimitiveDraft(draft), [draft]);

  function createHistoryMutationContext() {
    const sessionScopeKey = commands.getSessionScopeKey();
    const historyGeneration = authoringHistory?.getGeneration?.();
    return {
      api,
      authoringHistory,
      layout,
      resourceData: { [MODEL_SCENE_PATH]: scene.data },
      selection: selectionController,
      sessionScopeKey: sessionScopeKey ?? null,
      isCurrentSessionScope: () =>
        commands.getSessionScopeKey() === sessionScopeKey &&
        (historyGeneration === undefined ||
          authoringHistory?.getGeneration?.() === historyGeneration),
    };
  }

  useEffect(() => {
    if (draft.mode === "draft-new") {
      primitiveDraftOverlayStore.publish(primitiveDraft);
    } else {
      primitiveDraftOverlayStore.clear();
    }
  }, [draft.mode, primitiveDraft]);
  useEffect(() => () => primitiveDraftOverlayStore.clear(), []);
  useEffect(() => {
    if (revisionConflictPhase !== "refreshing") return;
    let cancelled = false;
    const updateAfterResourceTransition = (update: () => void) => {
      queueMicrotask(() => {
        if (!cancelled) update();
      });
    };
    if (scene.status === "loading") {
      updateAfterResourceTransition(() => setRefreshSawLoading(true));
    } else if (scene.status === "error") {
      updateAfterResourceTransition(() => {
        setRevisionConflictPhase("refresh-error");
        setFeedbackState({
          feedback: {
            kind: "error",
            message:
              scene.error?.message ??
              "Scene refetch failed. Retry refetch before rebasing.",
          },
          key: draftKey,
        });
      });
    } else if (
      refreshSawLoading &&
      scene.status === "ready" &&
      baseDraft.baseRevision !== null &&
      baseDraft.baseRevision !== conflictBaseRevision
    ) {
      updateAfterResourceTransition(() => {
        setRevisionConflictPhase("refetched");
        setFeedbackState({
          feedback: {
            kind: "error",
            message: "Scene refetched. Rebase the preserved draft before retrying.",
          },
          key: draftKey,
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [
    baseDraft.baseRevision,
    conflictBaseRevision,
    draftKey,
    refreshSawLoading,
    revisionConflictPhase,
    scene.error,
    scene.status,
  ]);

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

  function beginPendingOperation(): () => void {
    const operationId = ++pendingOperationId.current;
    const sessionScopeKey = commands.getSessionScopeKey() ?? null;
    setPendingState({ draftKey, operationId, pending: true, sessionScopeKey });
    return () => {
      setPendingState((current) =>
        current.operationId === operationId
          ? { ...current, pending: false }
          : current,
      );
    };
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

  async function applyCreateDraft(): Promise<boolean> {
    if (draft.baseRevision === null) {
      setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      return false;
    }
    const baseRevision = draft.baseRevision;
    const geometry = buildGeometryDraftPatch(draft);
    const geometryPayload = geometry.geometry;
    if (geometry.error || !geometryPayload) {
      setFeedback({ kind: "error", message: geometry.error ?? "Invalid geometry draft." });
      return false;
    }
    const transform = buildTransformDraftPatch(draft);
    const transformPayload = transform.transform;
    if (transform.error || !transformPayload) {
      setFeedback({ kind: "error", message: transform.error ?? "Invalid transform draft." });
      return false;
    }

    const finishPending = beginPendingOperation();
    setRevisionConflictPhase(null);
    let isCurrentMutationContext: (() => boolean) | null = null;
    try {
      const objectId = createDraftObjectId(draft);
      const historyContext = createHistoryMutationContext();
      isCurrentMutationContext = historyContext.isCurrentSessionScope;
      const requestOptions = historyContext.sessionScopeKey
        ? { sessionScopeKey: historyContext.sessionScopeKey }
        : undefined;
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Create ${draft.name.trim() || objectId}`,
        async () => {
          const created = await createObjectTransaction(api, {
            base_revision: baseRevision,
            geometry: geometryPayload,
            material_ref: optionalRef(draft.material),
            name: draft.name.trim() || objectId,
            object_id: objectId,
            region_name: optionalRef(draft.region),
            transform: transformPayload,
          }, requestOptions);
          if (historyContext.isCurrentSessionScope() !== false) {
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
          }
          return created;
        },
        undefined,
        { captureWorkspaceStateAfter: true },
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      const revision = acknowledgedAuthoringSceneRevision(response);
      invalidateAuthoringResources(
        resources,
        revision,
        response.committed_scene,
        historyContext.sessionScopeKey,
      );
      setFeedback({ kind: "success", message: "Object draft committed." });
      return true;
    } catch (error) {
      if (isCurrentMutationContext?.() === false) return false;
      if (isPrimitiveDraftRevisionConflict(error)) {
        setConflictOperation("create");
        setRevisionConflictPhase("conflict");
        setConflictBaseRevision(draft.baseRevision);
        setRefreshSawLoading(false);
      }
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending();
    }
  }

  function refetchAfterConflict(): void {
    setRefreshSawLoading(false);
    setRevisionConflictPhase("refreshing");
    setFeedback({ kind: "error", message: "Refetching the canonical scene…" });
    scene.refetch();
  }

  function rebaseAfterConflict(): void {
    updateDraft((current) =>
      rebaseGeometryObjectDraft(current, baseDraft.baseRevision),
    );
    setRevisionConflictPhase("rebased");
    setFeedback({ kind: "error", message: "Draft rebased to the latest scene revision. Review and retry Apply." });
  }

  async function applyGeometryPatch(): Promise<boolean> {
    if (draft.baseRevision === null) {
      setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      return false;
    }
    const baseRevision = draft.baseRevision;
    const geometry = buildGeometryDraftPatch(draft);
    const geometryPayload = geometry.geometry;
    if (geometry.error || !geometryPayload) {
      setFeedback({ kind: "error", message: geometry.error ?? "Invalid geometry draft." });
      return false;
    }

    const finishPending = beginPendingOperation();
    let isCurrentMutationContext: (() => boolean) | null = null;
    try {
      const historyContext = createHistoryMutationContext();
      isCurrentMutationContext = historyContext.isCurrentSessionScope;
      const requestOptions = historyContext.sessionScopeKey
        ? { sessionScopeKey: historyContext.sessionScopeKey }
        : undefined;
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Edit geometry ${draft.name}`,
        () => patchObjectGeometryTransaction(api, draft.objectId, {
          base_revision: baseRevision,
          geometry: geometryPayload,
        }, requestOptions),
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      invalidateAuthoringResources(
        resources,
        response.scene_revision,
        response.committed_scene,
        historyContext.sessionScopeKey,
      );
      setFeedback({ kind: "success", message: "Geometry patch committed." });
      return true;
    } catch (error) {
      if (isCurrentMutationContext?.() === false) return false;
      if (isPrimitiveDraftRevisionConflict(error)) {
        setConflictOperation("geometry");
        setRevisionConflictPhase("conflict");
        setConflictBaseRevision(draft.baseRevision);
        setRefreshSawLoading(false);
      }
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending();
    }
  }

  async function applyTransformPatch(): Promise<boolean> {
    if (draft.baseRevision === null) {
      setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      return false;
    }
    const baseRevision = draft.baseRevision;
    const transform = buildTransformDraftPatch(draft);
    const transformPayload = transform.transform;
    if (transform.error || !transformPayload) {
      setFeedback({ kind: "error", message: transform.error ?? "Invalid transform draft." });
      return false;
    }

    const finishPending = beginPendingOperation();
    let isCurrentMutationContext: (() => boolean) | null = null;
    try {
      const translation = transformPayload.translation as [number, number, number];
      const historyContext = createHistoryMutationContext();
      isCurrentMutationContext = historyContext.isCurrentSessionScope;
      await runAuthoringMutationWithHistory(
        historyContext,
        `Edit transform ${draft.name}`,
        () => commitObjectTranslation({
          api,
          baseRevision,
          objectId: draft.objectId,
          resources,
          sessionScopeKey: historyContext.sessionScopeKey ?? undefined,
          isCurrentSessionScope: historyContext.isCurrentSessionScope,
          translation,
        }),
        (mutationResult) => mutationResult.committedScene ?? null,
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      setFeedback({ kind: "success", message: "Transform committed." });
      return true;
    } catch (error) {
      if (isCurrentMutationContext?.() === false) return false;
      if (isPrimitiveDraftRevisionConflict(error)) {
        setConflictOperation("transform");
        setRevisionConflictPhase("conflict");
        setConflictBaseRevision(draft.baseRevision);
        setRefreshSawLoading(false);
      }
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending();
    }
  }

  function revertDraft(): void {
    setDraftState({ draft: baseDraft, key: draftKey });
    setFeedback(null);
  }

  const geometryDraftChanged = draft.mode === "committed" && !sameDraftFields(
    draft,
    baseDraft,
    ["archHeight", "geometryKind", "height", "length", "radius", "size", "width", "z0"],
  );
  const transformDraftChanged = draft.mode === "committed" && !sameDraftFields(
    draft,
    baseDraft,
    ["translation"],
  );
  const newObjectDraftChanged = draft.mode === "draft-new" && !sameDraftValues(draft, baseDraft);
  const inspectorDirty = geometryDraftChanged || transformDraftChanged || newObjectDraftChanged;
  const geometryPatch = buildGeometryDraftPatch(draft);
  const transformPatch = buildTransformDraftPatch(draft);
  const inspectorValid = !inspectorDirty || (
    draft.baseRevision !== null &&
    Object.keys(primitiveDraft.errors).length === 0 &&
    (draft.mode !== "draft-new" || (geometryPatch.error === null && transformPatch.error === null)) &&
    (!geometryDraftChanged || geometryPatch.error === null) &&
    (!transformDraftChanged || transformPatch.error === null)
  );
  const inspectorApplyBlockReason = revisionConflictPhase !== null
    ? "Resolve the scene revision conflict before applying this draft."
    : geometryDraftChanged && transformDraftChanged
      ? "Apply geometry and transform separately so each change has its own history entry."
      : undefined;

  async function applyRegisteredDraft(): Promise<boolean> {
    if (draft.mode === "draft-new") return applyCreateDraft();
    if (draft.mode !== "committed") return false;
    if (geometryDraftChanged && !transformDraftChanged) return applyGeometryPatch();
    if (transformDraftChanged && !geometryDraftChanged) return applyTransformPatch();
    return false;
  }

  useRegisterInspectorEditSession(
    draft.mode === "missing" ? null : "staged",
    pending,
    inspectorDirty,
    inspectorValid,
    undefined,
    applyRegisteredDraft,
    revertDraft,
    {
      applyBlockReason: inspectorApplyBlockReason,
      historyMode: "mutation-owned",
    },
  );

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
        onRetryAfterConflict={
          conflictOperation === "transform"
            ? applyTransformPatch
            : conflictOperation === "geometry"
              ? applyGeometryPatch
              : applyCreateDraft
        }
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
        disabled
        label="Rotation"
        unit="rad"
        values={draft.rotation}
        onChange={(index, value) => onVectorChange("rotation", index, value)}
      />
      <DraftVectorFormField
        disabled
        label="Scale"
        unit="x"
        values={draft.scale}
        onChange={(index, value) => onVectorChange("scale", index, value)}
      />
      <FieldRow label="Rotate / Scale" value={PROBLEM_IR_03_RIGID_TRANSFORM_REASON} />
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
  onRetryAfterConflict,
  onRevertDraft,
  pending,
  revisionConflictPhase,
}: {
  draft: GeometryObjectDraft;
  feedback: Feedback | null;
  onApplyCreateDraft: () => Promise<boolean>;
  onApplyGeometryPatch: () => Promise<boolean>;
  onApplyTransformPatch: () => Promise<boolean>;
  onRebaseAfterConflict: () => void;
  onRefetchAfterConflict: () => void;
  onRetryAfterConflict: () => Promise<boolean>;
  onRevertDraft: () => void;
  pending: boolean;
  revisionConflictPhase: "conflict" | "refresh-error" | "refreshing" | "rebased" | "refetched" | null;
}) {
  return (
    <InspectorGroup title="Actions">
      <div className="fm-inspector-toolbar">
        {draft.mode === "draft-new" ? (
          <Button
            disabled={
              pending ||
              draft.baseRevision === null ||
              revisionConflictPhase !== null
            }
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
            disabled={pending || revisionConflictPhase === "refreshing"}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onRefetchAfterConflict}
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
            onClick={() => void onRetryAfterConflict()}
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
  onApplyGeometryPatch: () => Promise<boolean>;
  onApplyTransformPatch: () => Promise<boolean>;
  onRevertDraft: () => void;
  pending: boolean;
}) {
  return (
    <>
      <Button
        disabled={pending || draft.mode !== "committed" || draft.baseRevision === null}
        size="sm"
        type="button"
        variant="primary"
        onClick={() => void onApplyGeometryPatch()}
      >
        Apply Geometry
      </Button>
      <Button
        disabled={pending || draft.mode !== "committed" || draft.baseRevision === null}
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
  disabled,
  errors,
  label,
  onChange,
  unit,
  values,
}: {
  disabled?: boolean;
  errors?: readonly (string | undefined)[];
  label: string;
  onChange: (index: 0 | 1 | 2, value: string) => void;
  unit: string;
  values: readonly [string, string, string];
}) {
  return (
    <Vector3Field
      disabled={disabled}
      errors={errors}
      label={label}
      unit={unit}
      values={values}
      onChange={onChange}
    />
  );
}
