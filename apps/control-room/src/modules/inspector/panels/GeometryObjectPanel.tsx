import { canonicalDraftInSelectedUnits, changeDraftQuantityUnit, updateRawQuantityField } from "@/kernel/authoring/object-edit/quantityDraftFields";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { AuthoringTransactionResponse, JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  createObjectTransaction,
  patchObjectGeometryTransaction,
  patchObjectTransaction,
  primitiveDraftOverlayStore,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import { useObjectEditSelector } from "@/kernel/authoring/object-edit/useObjectEditSelector";
import {
  geometryObjectEditSessionTargetKey,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
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
import { DraftQuantityUnitSelect, type DraftUnitUpdater } from "../primitives/DraftQuantityUnitSelect";
import type { QuantityDraftField } from "@/kernel/authoring/object-edit/objectEditTypes";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { useInspectorActiveTab } from "../InspectorTabState";
import { ObjectPlacementPanel } from "./ObjectPlacementPanel";
import { Vector3Field } from "../primitives/Vector3Field";
import {
  buildGeometryDraftPatch,
  buildTransformDraftPatch,
  geometryDraftGeometryEquals,
  geometryDraftTranslationEquals,
  createDraftObjectId,
  mergeGeometryDescriptor,
  resolveGeometryObjectDraft,
  resolveGeometryObjectPanelModel,
  resolvePrimitiveDraft,
  isPrimitiveDraftRevisionConflict,
  rebaseGeometryObjectDraft,
  summarizeGeometryValidationMessages,
  type GeometryObjectDraft,
} from "./geometryObjectPanelModel";
import { objectEditMetadataEquals, reconcileObjectEditAck, reconcileObjectIdentityAck } from "./objectEditAckReconciliation";

type Feedback = {
  kind: "error" | "success" | "warning";
  message: string;
};

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

function invalidateAuthoringResources(
  resources: ReturnType<typeof useKernel>["resources"],
  revision: number,
  committedScene?: SceneResource,
  sessionScopeKey?: string | null,
  resourceCacheScope?: string | null,
): void {
  if (committedScene) {
    publishCommittedSceneResource(
      resources,
      committedScene,
      revision,
      undefined,
      false,
      sessionScopeKey,
      resourceCacheScope,
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
    objectEditSession,
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
  const currentSessionScopeKey = commands.getSessionScopeKey() ?? null;
  const draftKey = baseDraft.mode + ":" + baseDraft.objectId;
  const targetKey = geometryObjectEditSessionTargetKey(currentSessionScopeKey, baseDraft);
  const editSnapshot = useObjectEditSelector(objectEditSession);
  const sessionMatchesTarget = editSnapshot.identity?.targetKey === targetKey;
  const editIdentity = sessionMatchesTarget ? editSnapshot.identity : null;
  const draft = sessionMatchesTarget
    ? editSnapshot.draft ?? baseDraft
    : baseDraft;
  const sourceNotice = geometrySourceNotice(draft.mode, object.mode, scene);
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    feedback: null,
    key: draftKey,
  });
  const [pendingState, setPendingState] = useState<PendingOperationState>({
    draftKey,
    operationId: 0,
    pending: false,
    sessionScopeKey: currentSessionScopeKey,
  });
  const pendingOperationId = useRef(0);
  const preConflictBaselineRef = useRef<GeometryObjectDraft | null>(null);
  const pending =
    (pendingState.pending &&
      pendingState.draftKey === draftKey &&
      pendingState.sessionScopeKey === currentSessionScopeKey) ||
    (sessionMatchesTarget && editSnapshot.applyOperationId !== null);
  const ownLocalMutationPending = Boolean(
    pendingState.pending &&
      pendingState.draftKey === draftKey &&
      pendingState.sessionScopeKey === currentSessionScopeKey,
  );
  const ownObjectApplyPending = Boolean(
    sessionMatchesTarget && editSnapshot.applyOperationId !== null,
  );
  const sceneWritePending = objectEditSession.hasPendingWrite(currentSessionScopeKey);
  const placementGestureActive = objectEditSession.hasActiveGesture(currentSessionScopeKey);
  const sceneMutationLockReason = placementGestureActive
    ? "Finish or cancel the active placement gesture before applying or reverting scene changes."
    : sceneWritePending && !ownObjectApplyPending && !ownLocalMutationPending
      ? "Another scene-changing action is pending in this session."
      : undefined;
  const [revisionConflictPhase, setRevisionConflictPhase] = useState<
    "conflict" | "refresh-error" | "refreshing" | "rebased" | "refetched" | null
  >(null);
  const [conflictBaseRevision, setConflictBaseRevision] = useState<number | null>(null);
  const [conflictOperation, setConflictOperation] = useState<
    "create" | "geometry" | "transform"
  >("create");
  const [refreshSawLoading, setRefreshSawLoading] = useState(false);
  const feedback =
    feedbackState.key === draftKey ? feedbackState.feedback : null;
  const validationMessages = summarizeGeometryValidationMessages(
    validation.data,
    draft.objectId,
  );
  const primitiveDraft = useMemo(() => resolvePrimitiveDraft(draft), [draft]);
  const activeTab = useInspectorActiveTab();

  useLayoutEffect(() => {
    const identity = objectEditSession.activate({
      objectId: baseDraft.objectId,
      sessionScopeKey: currentSessionScopeKey,
      targetKey,
    }, baseDraft);
    // ACK reconciliation may retain newer raw text that is semantically clean.
    // Publishing the same confirmed revision must not normalize that text away.
    const currentDraft = objectEditSession.getSnapshot().draft;
    if (!Number.isFinite(baseDraft.baseRevision) || currentDraft?.baseRevision !== baseDraft.baseRevision) {
      objectEditSession.refreshCanonical(identity, canonicalDraftInSelectedUnits(baseDraft, currentDraft ?? baseDraft));
    }
  }, [baseDraft, currentSessionScopeKey, objectEditSession, targetKey]);

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
    if (!editIdentity) return;
    objectEditSession.updateDraft(editIdentity, updater);
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
    updateDraft((current) => {
      if (field === "name" || field === "notes" || field === "material" || field === "region") {
        return { ...current, [field]: value };
      }
      return updateRawQuantityField(current, field, value);
    });
  }

  function updateVector(
    field: VectorDraftField,
    index: 0 | 1 | 2,
    value: string,
  ): void {
    updateDraft((current) => {
      if (field === "size" || field === "translation") {
        return updateRawQuantityField(current, `${field}.${index}`, value);
      }
      const next = [...current[field]] as [string, string, string];
      next[index] = value;
      return { ...current, [field]: next };
    });
  }

  const updateUnit: DraftUnitUpdater = (field, unit) => {
    updateDraft((current) => {
      const result = changeDraftQuantityUnit(current, field, unit);
      return result.ok ? result.draft : current;
    });
  };

  const geometryDraftChanged =
    draft.mode === "committed" && !geometryDraftGeometryEquals(draft, baseDraft);
  const transformDraftChanged =
    draft.mode === "committed" && !geometryDraftTranslationEquals(draft, baseDraft);
  const newObjectDraftChanged = draft.mode === "draft-new" && (
    !geometryDraftGeometryEquals(draft, baseDraft) ||
    !geometryDraftTranslationEquals(draft, baseDraft) ||
    !objectEditMetadataEquals(draft, baseDraft)
  );
  const metadataDraftChanged = draft.mode === "committed" && !objectEditMetadataEquals(draft, baseDraft);
  const inspectorDirty = geometryDraftChanged || transformDraftChanged || metadataDraftChanged || newObjectDraftChanged;
  const geometryPatch = buildGeometryDraftPatch(draft);
  const existingObject = scene.data?.objects?.find((candidate) => candidate.id === draft.objectId);
  const transformPatch = buildTransformDraftPatch(
    draft,
    draft.mode === "committed" ? existingObject?.transform : undefined,
  );

  useEffect(() => {
    if (editIdentity) objectEditSession.setDirty(editIdentity, inspectorDirty);
  }, [editIdentity, inspectorDirty, objectEditSession]);
  const inspectorValid = !inspectorDirty || (
    draft.baseRevision !== null &&
    Object.keys(primitiveDraft.errors).length === 0 &&
    (draft.mode !== "draft-new" || (geometryPatch.error === null && transformPatch.error === null)) &&
    (!geometryDraftChanged || geometryPatch.error === null) &&
    (!inspectorDirty || transformPatch.error === null)
  );
  const inspectorApplyBlockReason =
    revisionConflictPhase !== null && revisionConflictPhase !== "rebased"
      ? "Resolve the scene revision conflict before applying this draft."
      : undefined;

  async function applyRegisteredDraft(): Promise<boolean> {
    if (draft.mode === "draft-new") return applyCreateDraft();
    if (draft.mode === "committed") return applyObjectDraft();
    return false;
  }

  const acknowledgeCommittedDraft = useRegisterInspectorEditSession(
    draft.mode === "missing" ? null : "staged",
    pending,
    inspectorDirty,
    inspectorValid,
    sceneMutationLockReason,
    applyRegisteredDraft,
    revertDraft,
    {
      applyBlockReason: inspectorApplyBlockReason,
      historyMode: "mutation-owned",
    },
  );


  async function applyCreateDraft(): Promise<boolean> {
    if (typeof draft.baseRevision !== "number" || !Number.isFinite(draft.baseRevision)) {
      setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      return false;
    }
    if (sceneMutationLockReason) return false;
    const submittedDraft = draft;
    const submittedIdentity = editIdentity;
    const baseRevision = submittedDraft.baseRevision;
    const geometry = buildGeometryDraftPatch(submittedDraft);
    const geometryPayload = geometry.geometry;
    if (geometry.error || !geometryPayload) {
      setFeedback({ kind: "error", message: geometry.error ?? "Invalid geometry draft." });
      return false;
    }
    const transform = buildTransformDraftPatch(submittedDraft);
    const transformPayload = transform.transform;
    if (transform.error || !transformPayload) {
      setFeedback({ kind: "error", message: transform.error ?? "Invalid transform draft." });
      return false;
    }

    const objectId = createDraftObjectId(submittedDraft);
    const sceneMutationToken = objectEditSession.beginSceneMutation(
      currentSessionScopeKey,
      objectId,
    );
    if (sceneMutationToken === null) return false;
    const finishPending = beginPendingOperation();
    setRevisionConflictPhase(null);
    let isCurrentMutationContext: (() => boolean) | null = null;
    let selectedCreatedObject = false;
    try {
      const historyContext = createHistoryMutationContext();
      isCurrentMutationContext = historyContext.isCurrentSessionScope;
      if (historyContext.sessionScopeKey !== currentSessionScopeKey) return false;
      const requestOptions = historyContext.sessionScopeKey
        ? { sessionScopeKey: historyContext.sessionScopeKey }
        : undefined;
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Create ${submittedDraft.name.trim() || objectId}`,
        async () => {
          const created = await createObjectTransaction(api, {
            base_revision: baseRevision,
            geometry: geometryPayload,
            material_ref: optionalRef(submittedDraft.material),
            name: submittedDraft.name.trim() || objectId,
            object_id: objectId,
            region_name: optionalRef(submittedDraft.region),
            transform: transformPayload,
          }, requestOptions);
          const currentSnapshot = objectEditSession.getSnapshot();
          const resolvedCreatedDraft = resolveCommittedGeometryObjectDraft(
            created.committed_scene,
            objectId,
          );
          const createdDraft = resolvedCreatedDraft
            ? {
                ...resolvedCreatedDraft,
                baseRevision: acknowledgedAuthoringSceneRevision(created),
              }
            : null;
          if (
            historyContext.isCurrentSessionScope() !== false &&
            submittedIdentity !== null &&
            currentSnapshot.identity === submittedIdentity &&
            currentSnapshot.draft !== null &&
            createdDraft &&
            acknowledgeCommittedDraft()
          ) {
            preConflictBaselineRef.current = null;
            const rebased = reconcileObjectEditAck(
              currentSnapshot.draft,
              submittedDraft,
              createdDraft,
            );
            // Publish the ACK before selecting its object. A selection render
            // against the old scene would activate a missing target and reset
            // edits made while create was pending.
            publishCommittedSceneResource(resources, created.committed_scene,
              acknowledgedAuthoringSceneRevision(created), undefined, false,
              historyContext.sessionScopeKey, api.resourceCacheScope);
            const committedIdentity = objectEditSession.activate({
              objectId,
              sessionScopeKey: historyContext.sessionScopeKey,
              targetKey: geometryObjectEditSessionTargetKey(
                historyContext.sessionScopeKey,
                createdDraft,
              ),
            }, rebased.draft);
            if (rebased.dirty) {
              objectEditSession.updateDraft(committedIdentity, () => rebased.draft);
              objectEditSession.setDirty(committedIdentity, rebased.dirty);
            }
            selectionController.set(
              {
                kind: "object.root",
                label: submittedDraft.name.trim() || objectId,
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
            selectedCreatedObject = true;
          }
          return created;
        },
        undefined,
        { captureWorkspaceStateAfter: () => selectedCreatedObject },
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      if (!selectedCreatedObject) return false;
      const revision = acknowledgedAuthoringSceneRevision(response);
      invalidateAuthoringResources(
        resources,
        revision,
        undefined,
        historyContext.sessionScopeKey,
        api.resourceCacheScope,
      );
      preConflictBaselineRef.current = null;
      setFeedback({ kind: "success", message: "Object draft committed." });
      return true;
    } catch (error) {
      if (isCurrentMutationContext?.() === false) return false;
      if (isPrimitiveDraftRevisionConflict(error)) {
        preConflictBaselineRef.current = baseDraft;
        setConflictOperation("create");
        setRevisionConflictPhase("conflict");
        setConflictBaseRevision(submittedDraft.baseRevision);
        setRefreshSawLoading(false);
      }
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      objectEditSession.endSceneMutation(sceneMutationToken);
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
    const baseline = preConflictBaselineRef.current;
    updateDraft((current) =>
      rebaseGeometryObjectDraft(current, baseDraft, baseline),
    );
    setRevisionConflictPhase("rebased");
    setFeedback({ kind: "error", message: "Draft rebased to the latest scene revision. Review and retry Apply." });
  }

  async function applyObjectDraft(): Promise<boolean> {
    if (draft.mode !== "committed" || !inspectorDirty || sceneMutationLockReason) return false;
    if (typeof draft.baseRevision !== "number" || !Number.isFinite(draft.baseRevision)) {
      setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      return false;
    }
    if (!existingObject || !existingObject.geometry || !editIdentity) {
      setFeedback({ kind: "error", message: "The canonical object geometry or edit identity is unavailable. Refetch the scene before applying." });
      return false;
    }

    const operation = objectEditSession.beginApply(editIdentity);
    if (!operation) return false;
    const submittedDraft = operation.submittedDraft;
    if (typeof submittedDraft.baseRevision !== "number" || !Number.isFinite(submittedDraft.baseRevision)) {
      const operationIsCurrent = objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      }
      return false;
    }
    const submittedBaseRevision = submittedDraft.baseRevision;
    const submittedMetadataChanged = !objectEditMetadataEquals(submittedDraft, baseDraft);
    const submittedTransformChanged = !geometryDraftTranslationEquals(submittedDraft, baseDraft);
    const submittedObject = scene.data?.objects?.find(
      (candidate) => candidate.id === operation.identity.objectId,
    );
    if (!submittedObject?.geometry) {
      const operationIsCurrent = objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: "The canonical object geometry or edit identity is unavailable. Refetch the scene before applying." });
      }
      return false;
    }
    const editedGeometry = buildGeometryDraftPatch(submittedDraft);
    const submittedGeometryChanged = !geometryDraftGeometryEquals(submittedDraft, baseDraft);
    if (submittedGeometryChanged && (editedGeometry.error || !editedGeometry.geometry)) {
      const operationIsCurrent = objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: editedGeometry.error ?? "Invalid geometry draft." });
      }
      return false;
    }
    const transform = buildTransformDraftPatch(submittedDraft, submittedObject.transform);
    if (transform.error || !transform.transform) {
      const operationIsCurrent = objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: transform.error ?? "Invalid transform draft." });
      }
      return false;
    }
    const geometryPayload = submittedGeometryChanged
      ? mergeGeometryDescriptor(submittedObject.geometry as unknown as JsonObject, editedGeometry.geometry as JsonObject)
      : (submittedObject.geometry as unknown as JsonObject);
    const finishPending = beginPendingOperation();
    let isCurrentMutationContext: (() => boolean) | null = null;
    let metadataAck: SceneResource | null = null;
    try {
      const historyContext = createHistoryMutationContext();
      isCurrentMutationContext = historyContext.isCurrentSessionScope;
      if (
        historyContext.sessionScopeKey !== operation.identity.sessionScopeKey ||
        historyContext.isCurrentSessionScope() === false
      ) {
        objectEditSession.reject(operation);
        return false;
      }
      const requestOptions = historyContext.sessionScopeKey
        ? { sessionScopeKey: historyContext.sessionScopeKey }
        : undefined;
      let historyDegraded = false;
      let geometryBaseRevision = submittedBaseRevision;
      if (submittedMetadataChanged) {
        metadataAck = await runAuthoringMutationWithHistory(
          historyContext,
          "Edit metadata " + submittedDraft.name,
          // Send only edited fields: resending unchanged material/region
          // references would invalidate the realized mesh for a rename.
          () => patchObjectTransaction(api, operation.identity.objectId, {
            base_revision: submittedBaseRevision,
            ...(submittedDraft.name !== baseDraft.name ? { name: submittedDraft.name } : {}),
            ...(submittedDraft.notes !== baseDraft.notes ? { notes: submittedDraft.notes } : {}),
            ...(optionalRef(submittedDraft.material) !== optionalRef(baseDraft.material)
              ? { material_ref: optionalRef(submittedDraft.material) ?? null }
              : {}),
            ...(optionalRef(submittedDraft.region) !== optionalRef(baseDraft.region)
              ? { region_name: optionalRef(submittedDraft.region) ?? null }
              : {}),
          }, requestOptions),
          undefined,
          { onHistoryDegraded: () => { historyDegraded = true; } },
        );
        if (historyContext.isCurrentSessionScope() === false || !objectEditSession.isCurrent(operation.identity)) {
          objectEditSession.reject(operation);
          return false;
        }
        geometryBaseRevision = acknowledgedAuthoringSceneRevision(metadataAck);
      }
      const response: AuthoringTransactionResponse = submittedGeometryChanged || submittedTransformChanged
        ? await runAuthoringMutationWithHistory(
            historyContext,
            "Edit geometry and placement " + submittedDraft.name,
            () => patchObjectGeometryTransaction(api, operation.identity.objectId, {
              base_revision: geometryBaseRevision,
              geometry: geometryPayload,
              transform: transform.transform as JsonObject,
            }, requestOptions),
            undefined,
            { onHistoryDegraded: () => { historyDegraded = true; } },
          )
        : metadataAck
          ? { committed_scene: metadataAck, scene_revision: geometryBaseRevision, transaction_kind: "patch_object" }
          : (() => { throw new Error("There are no unapplied object changes."); })();
      if (historyContext.isCurrentSessionScope() === false) {
        objectEditSession.reject(operation);
        return false;
      }
      const revision = acknowledgedAuthoringSceneRevision(response);
      const resolvedCanonicalDraft = resolveCommittedGeometryObjectDraft(
        response.committed_scene,
        operation.identity.objectId,
      );
      if (!resolvedCanonicalDraft) {
        const operationIsCurrent = objectEditSession.reject(operation);
        if (operationIsCurrent && historyContext.isCurrentSessionScope()) {
          setFeedback({ kind: "error", message: "The acknowledged object is missing from the committed scene." });
        }
        return false;
      }
      const canonicalDraft = {
        ...resolvedCanonicalDraft,
        baseRevision: revision,
      };
      const acknowledgedCurrentDraft = objectEditSession.acknowledge(
        operation,
        canonicalDraft,
        reconcileObjectEditAck,
        { reconcileUnchangedDraft: true },
      );
      if (!acknowledgedCurrentDraft) return false;
      invalidateAuthoringResources(
        resources,
        revision,
        response.committed_scene,
        historyContext.sessionScopeKey,
        api.resourceCacheScope,
      );
      preConflictBaselineRef.current = null;
      setRevisionConflictPhase(null);
      setFeedback({
        kind: historyDegraded ? "warning" : "success",
        message: historyDegraded
          ? "Geometry and placement committed, but undo history was not recorded."
          : "Geometry and placement committed.",
      });
      return true;
    } catch (error) {
      const operationIsCurrent = objectEditSession.reject(operation);
      if (!operationIsCurrent || isCurrentMutationContext?.() === false) return false;
      if (metadataAck) {
        const metadataCanonical = resolveCommittedGeometryObjectDraft(metadataAck, operation.identity.objectId);
        const currentDraft = objectEditSession.getSnapshot().draft;
        if (metadataCanonical && currentDraft) {
          const metadataRevision = acknowledgedAuthoringSceneRevision(metadataAck);
          const rebased = reconcileObjectIdentityAck(currentDraft, submittedDraft, baseDraft, {
            ...metadataCanonical, baseRevision: metadataRevision,
          });
          objectEditSession.updateDraft(operation.identity, () => rebased.draft);
          objectEditSession.setDirty(operation.identity, rebased.dirty);
          invalidateAuthoringResources(resources, metadataRevision, metadataAck,
            operation.identity.sessionScopeKey, api.resourceCacheScope);
          setFeedback({ kind: "error", message: "Metadata was committed; geometry remains unapplied. " + errorMessage(error) });
          return false;
        }
      }
      if (isPrimitiveDraftRevisionConflict(error)) {
        preConflictBaselineRef.current = baseDraft;
        setConflictOperation("geometry");
        setRevisionConflictPhase("conflict");
        setConflictBaseRevision(submittedBaseRevision);
        setRefreshSawLoading(false);
      }
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending();
    }
  }

  function revertDraft(): void {
    if (
      objectEditSession.hasPendingWrite(currentSessionScopeKey) ||
      objectEditSession.hasActiveGesture(currentSessionScopeKey)
    ) return;
    if (editIdentity && !objectEditSession.reset(editIdentity, canonicalDraftInSelectedUnits(baseDraft, draft))) return;
    setRevisionConflictPhase(null);
    preConflictBaselineRef.current = null;
    setFeedback(null);
  }


  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Geometry summary" collapsible defaultOpen>
        {sourceNotice ? <FieldRow label="Source" value={sourceNotice} /> : null}
        {draft.mode === "committed" && (
          <FieldRow label="Object ID" value={object.objectId} />
        )}
        <FieldRow label="Shape" value={object.shape} />
        <FieldRow label="Dimensions" value={object.dimensions} />
      </InspectorGroup>

      {activeTab === "placement" ? (
        <ObjectPlacementPanel
          draft={draft}
          errors={primitiveDraft.errors}
          onVectorChange={updateVector}
          onUnitChange={updateUnit}
        />
      ) : activeTab === "geometry" ? (
        <PrimitiveGeometrySection
          draft={draft}
          errors={primitiveDraft.errors}
          onFieldChange={updateField}
          onVectorChange={updateVector}
          onUnitChange={updateUnit}
        />
      ) : (
        <>
          <PrimitiveGeometrySection
            draft={draft}
            errors={primitiveDraft.errors}
            onFieldChange={updateField}
            onVectorChange={updateVector}
            onUnitChange={updateUnit}
          />
          <ObjectPlacementPanel
            draft={draft}
            errors={primitiveDraft.errors}
            onVectorChange={updateVector}
            onUnitChange={updateUnit}
          />
        </>
      )}
      {Object.keys(primitiveDraft.errors).length > 0 && draft.quantityFields &&
        Object.values(draft.quantityFields).some((field) => field && field.lastValidSI !== null) ? (
        <FeedbackBanner kind="warning" message="Preview retains the last valid values. Complete or revert invalid fields before applying." />
      ) : null}
      <DraftIdentitySection draft={draft} onFieldChange={updateField} showCommitted={draft.mode === "committed"} />
      <ActionsSection
        draft={draft}
        valid={inspectorValid}
        feedback={feedback}
        sceneMutationLockReason={sceneMutationLockReason}
        pending={pending}
        onApplyCreateDraft={applyCreateDraft}
        onRebaseAfterConflict={rebaseAfterConflict}
        onRefetchAfterConflict={refetchAfterConflict}
        onRetryAfterConflict={
          conflictOperation === "create" ? applyCreateDraft : applyObjectDraft
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

function geometrySourceNotice(
  draftMode: GeometryObjectDraft["mode"],
  objectMode: ReturnType<typeof resolveGeometryObjectPanelModel>["mode"],
  scene: Pick<ReturnType<typeof useSceneResource>, "data" | "status">,
): string | null {
  if (draftMode === "draft-new") return "Unsaved draft";
  if (scene.status === "error") {
    return scene.data ? "Scene refresh failed" : "Scene unavailable";
  }
  if (scene.status === "loading") {
    return scene.data ? "Refreshing scene" : "Loading scene";
  }
  if (scene.status === "stale") return "Scene data is stale";
  if (scene.status === "ready" && objectMode === "missing") {
    return "Object not found in scene";
  }
  return null;
}

function PrimitiveGeometrySection({
  draft,
  errors,
  onFieldChange,
  onVectorChange,
  onUnitChange,
}: {
  draft: GeometryObjectDraft;
  errors: Readonly<Record<string, string>>;
  onFieldChange: DraftFieldUpdater;
  onVectorChange: VectorDraftUpdater;
  onUnitChange: DraftUnitUpdater;
}) {
  return (
    <InspectorGroup title="Primitive Geometry" collapsible defaultOpen>
      <FieldRow label="Kind" value={draft.geometryKind} />
      <PrimitiveGeometryFields
        draft={draft}
        errors={errors}
        onFieldChange={onFieldChange}
        onVectorChange={onVectorChange}
        onUnitChange={onUnitChange}
      />
    </InspectorGroup>
  );
}

function PrimitiveGeometryFields({
  draft,
  errors,
  onFieldChange,
  onVectorChange,
  onUnitChange,
}: {
  draft: GeometryObjectDraft;
  errors: Readonly<Record<string, string>>;
  onFieldChange: DraftFieldUpdater;
  onVectorChange: VectorDraftUpdater;
  onUnitChange: DraftUnitUpdater;
}) {
  const geometryKind = draft.geometryKind.toLowerCase();
  if (geometryKind === "cylinder") {
    return (
      <>
        <FormField
          error={errors.radius}
          label="Radius"
          type="number"
          unitControl={<DraftQuantityUnitSelect draft={draft} field="radius" label="Radius" onChange={onUnitChange} />}
          value={draft.radius}
          onChange={(event) => onFieldChange("radius", event.target.value)}
        />
        <FormField
          error={errors.height}
          label="Height"
          type="number"
          unitControl={<DraftQuantityUnitSelect draft={draft} field="height" label="Height" onChange={onUnitChange} />}
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
        unitControl={<DraftQuantityUnitSelect draft={draft} field="radius" label="Radius" onChange={onUnitChange} />}
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
          unitControl={<DraftQuantityUnitSelect draft={draft} field="length" label="Length" onChange={onUnitChange} />}
          value={draft.length}
          onChange={(event) => onFieldChange("length", event.target.value)}
        />
        <FormField
          label="Width"
          type="number"
          unitControl={<DraftQuantityUnitSelect draft={draft} field="width" label="Width" onChange={onUnitChange} />}
          value={draft.width}
          onChange={(event) => onFieldChange("width", event.target.value)}
        />
        <FormField
          label="Height"
          type="number"
          unitControl={<DraftQuantityUnitSelect draft={draft} field="height" label="Height" onChange={onUnitChange} />}
          value={draft.height}
          onChange={(event) => onFieldChange("height", event.target.value)}
        />
        <FormField
          label="Arch height"
          type="number"
          unitControl={<DraftQuantityUnitSelect draft={draft} field="archHeight" label="Arch height" onChange={onUnitChange} />}
          value={draft.archHeight}
          onChange={(event) => onFieldChange("archHeight", event.target.value)}
        />
        <FormField
          label="z0"
          type="number"
          unitControl={<DraftQuantityUnitSelect draft={draft} field="z0" label="z0" onChange={onUnitChange} />}
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
      draft={draft}
      field="size"
      onUnitChange={onUnitChange}
      values={draft.size}
      onChange={(index, value) => onVectorChange("size", index, value)}
    />
  );
}

function DraftIdentitySection({
  draft,
  onFieldChange,
  showCommitted = false,
}: {
  draft: GeometryObjectDraft;
  onFieldChange: DraftFieldUpdater;
  showCommitted?: boolean;
}) {
  if (draft.mode !== "draft-new" && !showCommitted) return null;

  return (
    <InspectorGroup title={draft.mode === "draft-new" ? "Draft Identity" : "Identity and references"} collapsible defaultOpen>
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
  sceneMutationLockReason,
  onApplyCreateDraft,
  onRebaseAfterConflict,
  onRefetchAfterConflict,
  onRetryAfterConflict,
  pending,
  revisionConflictPhase,
  valid,
}: {
  draft: GeometryObjectDraft;
  feedback: Feedback | null;
  valid: boolean;
  sceneMutationLockReason?: string;
  onApplyCreateDraft: () => Promise<boolean>;
  onRebaseAfterConflict: () => void;
  onRefetchAfterConflict: () => void;
  onRetryAfterConflict: () => Promise<boolean>;
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
              !valid ||
              Boolean(sceneMutationLockReason) ||
              typeof draft.baseRevision !== "number" ||
              !Number.isFinite(draft.baseRevision) ||
              revisionConflictPhase !== null
            }
            size="sm"
            type="button"
            variant="primary"
            title={sceneMutationLockReason ?? (!valid ? "Resolve validation errors before applying." : undefined)}
            onClick={() => void onApplyCreateDraft()}
          >
            Apply Draft
          </Button>
        ) : null}
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
            disabled={pending || Boolean(sceneMutationLockReason) || revisionConflictPhase !== "rebased"}
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
  draft,
  field,
  onUnitChange,
}: {
  draft?: GeometryObjectDraft;
  field?: "size" | "translation";
  onUnitChange?: DraftUnitUpdater;
  disabled?: boolean;
  errors?: readonly (string | undefined)[];
  label: string;
  onChange: (index: 0 | 1 | 2, value: string) => void;
  unit?: string;
  values: readonly [string, string, string];
}) {
  return (
    <Vector3Field
      disabled={disabled}
      errors={errors}
      label={label}
      unit={unit}
      unitControls={draft && field && onUnitChange
        ? ([0, 1, 2] as const).map((axis) => (
            <DraftQuantityUnitSelect key={axis} draft={draft} field={`${field}.${axis}` as QuantityDraftField}
              label={`${label} ${["X", "Y", "Z"][axis]}`} onChange={onUnitChange} />
          )) as [ReactNode, ReactNode, ReactNode]
        : undefined}
      values={values}
      onChange={onChange}
    />
  );
}
