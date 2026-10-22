import { canonicalDraftInSelectedUnits } from "@/kernel/authoring/object-edit/quantityDraftFields";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { acknowledgedAuthoringSceneRevision } from "@/kernel/authoring/authoringMutationInvalidation";
import { patchObjectGeometryTransaction } from "@/kernel/authoring/geometryLifecycleCommands";
import {
  geometryDraftGeometryEquals,
  geometryDraftTranslationEquals,
  geometryObjectEditSessionTargetKey,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import type { ObjectEditSessionIdentity } from "@/kernel/authoring/object-edit/objectEditTypes";
import { useObjectEditSelector } from "@/kernel/authoring/object-edit/useObjectEditSelector";
import {
  deleteObjectWithHistory,
  patchObjectIdentityWithHistory,
} from "@/kernel/authoring/objectGeneralMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { hasEmptyObjectMagneticModel } from "@/shared/domain/physics/objectMagneticModel";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  publishCommittedSceneResource,
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useObjectMetricsResource } from "@/kernel/resources/studyRuntimeResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  resolveTargetVisualization,
  type ObjectVisualizationSnapshot,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import {
  createPrimitiveSurfaceColorAssignments,
  isFerromagneticPrimitiveRole,
  resolvePrimitiveSurfaceColor,
  primitiveMonoColorForRole,
} from "@/kernel/visualization/primitiveSurfaceColor";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { ObjectExtensionsSection } from "../extensions/ObjectExtensionsSection";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  buildGeometryDraftPatch,
  buildTransformDraftPatch,
  mergeGeometryDescriptor,
} from "./geometryObjectPanelModel";
import {
  resolveObjectGeneralPanelModel,
  resolveObjectMetricsPanelModel,
  summarizeGeometryValidationMessages,
} from "./objectGeneralPanelModel";
import {
  objectEditMetadataEquals,
  reconcileObjectEditAck,
  reconcileObjectIdentityAck,
} from "./objectEditAckReconciliation";

type Feedback = {
  kind: "error" | "success" | "warning";
  message: string;
};

interface DraftState {
  material: string;
  name: string;
  notes: string;
  region: string;
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

type GeometryObjectVisualizationColors = Pick<
  VisualizationTargetSettings,
  "primitiveMonoColor" | "shaderMonoColor" | "surfaceColorSource" | "wireframeColor"
>;

function resolveGeometryObjectVisualizationColors(
  snapshot: ObjectVisualizationSnapshot,
  target: VisualizationTargetRef | null,
  visualizationState: Parameters<typeof resolveTargetVisualization>[0]["visualizationState"],
): GeometryObjectVisualizationColors | null {
  if (!target) return null;
  const settings = resolveTargetVisualization({
    snapshot,
    target,
    visualizationState,
  }).settings;
  return {
    primitiveMonoColor: settings.primitiveMonoColor,
    shaderMonoColor: settings.shaderMonoColor,
    surfaceColorSource: settings.surfaceColorSource,
    wireframeColor: settings.wireframeColor,
  };
}

function geometryObjectVisualizationColorsEquals(
  previous: GeometryObjectVisualizationColors | null,
  next: GeometryObjectVisualizationColors | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.primitiveMonoColor === next.primitiveMonoColor &&
    previous.shaderMonoColor === next.shaderMonoColor &&
    previous.surfaceColorSource === next.surfaceColorSource &&
    previous.wireframeColor === next.wireframeColor
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalObjectReference(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized.toLowerCase() !== "unassigned"
    ? normalized
    : null;
}

function reconcileGeneralGeometryAck(
  current: Parameters<typeof reconcileObjectEditAck>[0],
  submitted: Parameters<typeof reconcileObjectEditAck>[1],
  canonical: Parameters<typeof reconcileObjectEditAck>[2],
): ReturnType<typeof reconcileObjectEditAck> {
  // Geometry ACKs do not submit General metadata. Treat the ACK metadata as
  // the reconciliation baseline so pending values from an earlier identity
  // write remain raw in the editor until that metadata itself is acknowledged.
  return reconcileObjectEditAck(current, {
    ...submitted,
    material: canonical.material,
    name: canonical.name,
    notes: canonical.notes,
    region: canonical.region,
  }, canonical);
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
  } else {
    resources.invalidate(MODEL_SCENE_PATH, revision);
  }
  resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
  resources.invalidate(MODEL_READINESS_PATH, revision);
  resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
  resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
  resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
}

export function ObjectGeneralPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const {
    api,
    authoringHistory,
    resources,
  } = kernel;
  const scene = useSceneResource();
  const validation = useGeometryValidationResource();
  const object = resolveObjectGeneralPanelModel(selection, scene.data);
  const sceneObject = scene.data?.objects?.find((entry) => entry.id === object.objectId);
  const geometrySelectionKind = sceneObject?.role === "antenna"
    ? "object.antenna.geometry" : "object.geometry";
  const antennaWithoutMagnetization = sceneObject?.role === "antenna"
    && hasEmptyObjectMagneticModel(sceneObject);
  const visualizationState = useVisualizationStateResource({
    enabled: object.mode === "committed",
  });
  const displayVisualizationState =
    visualizationState.optimisticData ?? visualizationState.data;
  const objectMetrics = useObjectMetricsResource(
    object.mode === "committed" && !antennaWithoutMagnetization ? object.objectId : null,
  );

  const draftKey = `${object.mode}:${object.objectId}:${object.revision}`;
  const [draftState, setDraftState] = useState<DraftState>({
    material: object.material,
    name: object.name,
    notes: object.notes,
    region: object.region,
    key: draftKey,
  });
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    feedback: null,
    key: "",
  });
  const currentSessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
  const [pendingState, setPendingState] = useState<PendingOperationState>({
    draftKey,
    operationId: 0,
    pending: false,
    sessionScopeKey: currentSessionScopeKey,
  });
  const pendingOperationId = useRef(0);
  const editSnapshot = useObjectEditSelector(kernel.objectEditSession);
  const targetKey = geometryObjectEditSessionTargetKey(currentSessionScopeKey, {
    mode: "committed",
    objectId: object.objectId,
  });
  const sessionMatchesTarget =
    editSnapshot.identity?.targetKey === targetKey &&
    editSnapshot.identity?.objectId === object.objectId;
  const editIdentity = sessionMatchesTarget ? editSnapshot.identity : null;
  const objectEditDraft = sessionMatchesTarget ? editSnapshot.draft : null;
  const feedbackKey = JSON.stringify([
    currentSessionScopeKey, object.mode, object.objectId,
    editIdentity?.epoch, editIdentity?.draftId,
  ]);
  const sceneWritePending = kernel.objectEditSession.hasPendingWrite(currentSessionScopeKey);
  const placementGestureActive = kernel.objectEditSession.hasActiveGesture(currentSessionScopeKey);
  const ownObjectApplyPending = Boolean(
    sessionMatchesTarget && editSnapshot.applyOperationId !== null,
  );
  const ownLocalMutationPending = Boolean(
    pendingState.pending &&
      pendingState.draftKey === draftKey &&
      pendingState.sessionScopeKey === currentSessionScopeKey,
  );
  const pending = ownLocalMutationPending || ownObjectApplyPending;
  const sceneMutationLockReason = placementGestureActive
    ? "Finish or cancel the active placement gesture before applying or reverting scene changes."
    : sceneWritePending && !ownObjectApplyPending && !ownLocalMutationPending
      ? "Another scene-changing action is pending in this session."
      : undefined;
  const canonicalGeometryDraft = useMemo(
    () =>
      object.mode === "committed"
        ? resolveCommittedGeometryObjectDraft(scene.data, object.objectId)
        : null,
    [object.mode, object.objectId, scene.data],
  );
  useLayoutEffect(() => {
    if (object.mode !== "committed" || !canonicalGeometryDraft) return;
    const identity = kernel.objectEditSession.activate({
      objectId: object.objectId,
      sessionScopeKey: currentSessionScopeKey,
      targetKey,
    }, canonicalGeometryDraft);
    const currentDraft = kernel.objectEditSession.getSnapshot().draft;
    if (
      typeof currentDraft?.baseRevision === "number" &&
      Number.isFinite(currentDraft.baseRevision) &&
      typeof canonicalGeometryDraft.baseRevision === "number" &&
      Number.isFinite(canonicalGeometryDraft.baseRevision) &&
      currentDraft.baseRevision === canonicalGeometryDraft.baseRevision
    ) return;
    kernel.objectEditSession.refreshCanonical(identity, canonicalDraftInSelectedUnits(canonicalGeometryDraft, currentDraft ?? canonicalGeometryDraft));
  }, [
    canonicalGeometryDraft,
    currentSessionScopeKey,
    kernel.objectEditSession,
    object.mode,
    object.objectId,
    targetKey,
  ]);
  const geometryDraftChanged = Boolean(
    objectEditDraft &&
      canonicalGeometryDraft &&
      !geometryDraftGeometryEquals(objectEditDraft, canonicalGeometryDraft),
  );
  const transformDraftChanged = Boolean(
    objectEditDraft &&
      canonicalGeometryDraft &&
      !geometryDraftTranslationEquals(objectEditDraft, canonicalGeometryDraft),
  );
  const objectEditMetadataChanged = Boolean(
    objectEditDraft &&
      canonicalGeometryDraft &&
      !objectEditMetadataEquals(objectEditDraft, canonicalGeometryDraft),
  );
  const objectEditDraftDirty =
    geometryDraftChanged || transformDraftChanged || objectEditMetadataChanged;

  const fallbackDraft = draftState.key === draftKey ? draftState : {
    material: object.material,
    name: object.name,
    notes: object.notes,
    region: object.region,
    key: draftKey,
  };
  const draftName = objectEditDraft?.name ?? fallbackDraft.name;
  const draftNotes = objectEditDraft?.notes ?? fallbackDraft.notes;
  const draftMaterial = objectEditDraft?.material ?? fallbackDraft.material;
  const draftRegion = objectEditDraft?.region ?? fallbackDraft.region;
  const feedback = feedbackState.key === feedbackKey ? feedbackState.feedback : null;

  const validationMessages = summarizeGeometryValidationMessages(
    validation.data,
    object.objectId,
  );

  const visualizationTarget: VisualizationTargetRef | null =
    object.mode === "committed"
      ? { id: object.objectId, kind: "object", label: object.name }
      : null;

  const visualizationSettings = useObjectVisualizationSelector(
    (snapshot) =>
      resolveGeometryObjectVisualizationColors(
        snapshot,
        visualizationTarget,
        displayVisualizationState,
      ),
    { isEqual: geometryObjectVisualizationColorsEquals },
  );

  const metricsModel = resolveObjectMetricsPanelModel(objectMetrics.data);
  const primitiveColorAssignments = useMemo(
    () =>
      createPrimitiveSurfaceColorAssignments(
        scene.data?.objects
          ?.filter((entry) => isFerromagneticPrimitiveRole(entry.role))
          .map((entry) => entry.id) ?? [],
      ),
    [scene.data?.objects],
  );
  const presentationObject = scene.data?.objects?.find(
    (entry) => entry.id === object.objectId,
  );
  const primitiveColor = visualizationSettings
    ? resolvePrimitiveSurfaceColor(
        presentationObject?.role,
        visualizationSettings,
        object.objectId,
        primitiveColorAssignments,
      )
    : null;

  function createAuthoringMutationContext() {
    const commandContext = createCommandContext("inspector", kernel, {
      resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
      sourceDetail: "ObjectGeneralPanel",
    });
    const historyGeneration = authoringHistory?.getGeneration?.();
    return {
      ...commandContext,
      isCurrentSessionScope: () =>
        commandContext.isCurrentSessionScope?.() !== false &&
        (historyGeneration === undefined ||
          authoringHistory?.getGeneration?.() === historyGeneration),
    };
  }

  function currentSceneMutationLockReason(): string | null {
    const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
    if (kernel.objectEditSession.hasActiveGesture(sessionScopeKey)) {
      return "Finish or cancel the active placement gesture before applying or reverting scene changes.";
    }
    if (kernel.objectEditSession.hasPendingWrite(sessionScopeKey)) {
      return "Another scene-changing action is pending in this session.";
    }
    return null;
  }

  function currentMatchedObjectEditDraft() {
    const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
    const snapshot = kernel.objectEditSession.getSnapshot();
    const identity = snapshot.identity;
    const expectedTargetKey = geometryObjectEditSessionTargetKey(sessionScopeKey, {
      mode: "committed",
      objectId: object.objectId,
    });
    if (
      !identity ||
      identity.targetKey !== expectedTargetKey ||
      identity.objectId !== object.objectId ||
      !snapshot.draft
    ) return null;
    return { identity, draft: snapshot.draft };
  }

  function ensureObjectEditDraft(): ReturnType<typeof currentMatchedObjectEditDraft> {
    const current = currentMatchedObjectEditDraft();
    if (current) return current;
    if (object.mode !== "committed" || !canonicalGeometryDraft) return null;

    const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
    const target = {
      objectId: object.objectId,
      sessionScopeKey,
      targetKey: geometryObjectEditSessionTargetKey(sessionScopeKey, {
        mode: "committed",
        objectId: object.objectId,
      }),
    };
    const identity = kernel.objectEditSession.activate(target, {
      ...canonicalGeometryDraft,
      material: fallbackDraft.material,
      name: fallbackDraft.name,
      notes: fallbackDraft.notes,
      region: fallbackDraft.region,
    });
    const snapshot = kernel.objectEditSession.getSnapshot();
    return snapshot.identity === identity && snapshot.draft
      ? { identity, draft: snapshot.draft }
      : null;
  }

  function updateDraft(
    field: "material" | "name" | "notes" | "region",
    value: string,
  ): void {
    const editState = currentMatchedObjectEditDraft() ?? ensureObjectEditDraft();
    if (editState) {
      kernel.objectEditSession.updateDraft(editState.identity, (draft) => ({
        ...draft,
        [field]: value,
      }));
      return;
    }
    setDraftState((current) => ({
      ...current,
      [field]: value,
      key: draftKey,
    }));
  }

  function setFeedback(feedbackValue: Feedback | null): void {
    setFeedbackState({
      feedback: feedbackValue,
      key: feedbackKey,
    });
  }

  function beginPendingOperation(): () => void {
    const operationId = ++pendingOperationId.current;
    const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
    setPendingState({ draftKey, operationId, pending: true, sessionScopeKey });
    return () => {
      setPendingState((current) =>
        current.operationId === operationId
          ? { ...current, pending: false }
          : current,
      );
    };
  }

  async function applyIdentityPatch(): Promise<SceneResource | null> {
    if (object.mode !== "committed" || currentSceneMutationLockReason()) return null;
    const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
    const sceneMutationToken = kernel.objectEditSession.beginSceneMutation(
      sessionScopeKey,
      object.objectId,
    );
    if (sceneMutationToken === null) return null;
    const finishPending = beginPendingOperation();
    let isCurrentMutationContext: (() => boolean) | null = null;
    let historyDegraded = false;
    let identity: ObjectEditSessionIdentity | null = null;
    try {
      const editState = ensureObjectEditDraft();
      if (!editState || !canonicalGeometryDraft) return null;
      identity = editState.identity;
      const submittedDraft = editState.draft;
      const submittedBaseRevision = submittedDraft.baseRevision;
      if (
        typeof submittedBaseRevision !== "number" ||
        !Number.isFinite(submittedBaseRevision)
      ) {
        setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
        return null;
      }
      const mutationContext = createAuthoringMutationContext();
      isCurrentMutationContext = mutationContext.isCurrentSessionScope;
      if (
        mutationContext.sessionScopeKey !== sessionScopeKey ||
        mutationContext.isCurrentSessionScope() === false
      ) return null;
      const response = await patchObjectIdentityWithHistory(
        mutationContext,
        {
          baseRevision: submittedBaseRevision,
          ...(submittedDraft.material !== canonicalGeometryDraft.material
            ? { materialRef: optionalObjectReference(submittedDraft.material) }
            : {}),
          name: submittedDraft.name,
          notes: submittedDraft.notes,
          objectId: object.objectId,
          ...(submittedDraft.region !== canonicalGeometryDraft.region
            ? { regionName: optionalObjectReference(submittedDraft.region) }
            : {}),
        },
        {
          onHistoryDegraded: () => {
            historyDegraded = true;
          },
        },
      );
      const currentSnapshot = kernel.objectEditSession.getSnapshot();
      if (
        mutationContext.isCurrentSessionScope() === false ||
        (kernel.commands.getSessionScopeKey() ?? null) !== sessionScopeKey ||
        !identity ||
        currentSnapshot.identity !== identity ||
        !currentSnapshot.draft
      ) return null;
      const nextRevision = acknowledgedAuthoringSceneRevision(response);
      const resolvedAcknowledgedDraft = resolveCommittedGeometryObjectDraft(
        response,
        object.objectId,
      );
      if (!resolvedAcknowledgedDraft) return null;
      const acknowledgedDraft = {
        ...resolvedAcknowledgedDraft,
        baseRevision: nextRevision,
      };
      const reconciled = reconcileObjectIdentityAck(
        currentSnapshot.draft,
        submittedDraft,
        canonicalGeometryDraft,
        acknowledgedDraft,
      );
      if (
        !kernel.objectEditSession.updateDraft(identity, () => reconciled.draft) ||
        !kernel.objectEditSession.setDirty(identity, reconciled.dirty)
      ) return null;
      invalidateAuthoringResources(
        resources,
        nextRevision,
        response,
        mutationContext.sessionScopeKey,
        api.resourceCacheScope,
      );
      setFeedback({
        kind: historyDegraded ? "warning" : "success",
        message: historyDegraded
          ? "Object identity committed, but undo history was not recorded."
          : "Object identity committed.",
      });
      return response;
    } catch (error) {
      if (
        isCurrentMutationContext?.() === false ||
        (identity && kernel.objectEditSession.getSnapshot().identity !== identity) ||
        (kernel.commands.getSessionScopeKey() ?? null) !== sessionScopeKey
      ) return null;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return null;
    } finally {
      kernel.objectEditSession.endSceneMutation(sceneMutationToken);
      finishPending();
    }
  }

  async function deleteObject(): Promise<boolean> {
    if (
      object.mode !== "committed" ||
      identityDraftDirty ||
      objectEditDraftDirty ||
      currentSceneMutationLockReason()
    ) return false;
    const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
    const sceneMutationToken = kernel.objectEditSession.beginSceneMutation(
      sessionScopeKey,
      object.objectId,
    );
    if (sceneMutationToken === null) return false;
    const finishPending = beginPendingOperation();
    let isCurrentMutationContext: (() => boolean) | null = null;
    try {
      const mutationContext = createAuthoringMutationContext();
      isCurrentMutationContext = mutationContext.isCurrentSessionScope;
      if (mutationContext.sessionScopeKey !== sessionScopeKey) return false;
      const response = await deleteObjectWithHistory(mutationContext, {
        baseRevision: object.revision,
        name: object.name,
        objectId: object.objectId,
      });
      if (mutationContext.isCurrentSessionScope() === false) return false;
      invalidateAuthoringResources(
        resources,
        response.scene_revision,
        response.committed_scene,
        mutationContext.sessionScopeKey,
        api.resourceCacheScope,
      );
      return true;
    } catch (error) {
      if (isCurrentMutationContext?.() === false) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      kernel.objectEditSession.endSceneMutation(sceneMutationToken);
      finishPending();
    }
  }

  async function applyObjectEditPatch(canonicalScene?: SceneResource): Promise<boolean> {
    if (object.mode !== "committed" || currentSceneMutationLockReason()) return false;
    const editState = currentMatchedObjectEditDraft();
    const applyScene = canonicalScene ?? scene.data;
    const applyCanonicalDraft = resolveCommittedGeometryObjectDraft(
      applyScene,
      object.objectId,
    );
    if (!editState || !applyCanonicalDraft) return false;
    if (
      typeof editState.draft.baseRevision !== "number" ||
      !Number.isFinite(editState.draft.baseRevision)
    ) {
      setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      return false;
    }
    const existingObject = applyScene?.objects?.find((candidate) => candidate.id === object.objectId);
    if (!existingObject || !existingObject.geometry) {
      setFeedback({ kind: "error", message: "Canonical object geometry is unavailable." });
      return false;
    }
    const operation = kernel.objectEditSession.beginApply(editState.identity);
    if (!operation) return false;
    const submittedDraft = operation.submittedDraft;
    if (
      typeof submittedDraft.baseRevision !== "number" ||
      !Number.isFinite(submittedDraft.baseRevision)
    ) {
      const operationIsCurrent = kernel.objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: "The canonical scene revision is unavailable. Refetch the scene before applying." });
      }
      return false;
    }
    const submittedBaseRevision = submittedDraft.baseRevision;
    const submittedObject = applyScene?.objects?.find(
      (candidate) => candidate.id === operation.identity.objectId,
    );
    if (!submittedObject?.geometry) {
      const operationIsCurrent = kernel.objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: "Canonical object geometry is unavailable." });
      }
      return false;
    }
    const submittedGeometry = buildGeometryDraftPatch(submittedDraft);
    const submittedGeometryChanged = !geometryDraftGeometryEquals(
      submittedDraft,
      applyCanonicalDraft,
    );
    if (submittedGeometryChanged && (submittedGeometry.error || !submittedGeometry.geometry)) {
      const operationIsCurrent = kernel.objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: submittedGeometry.error ?? "Invalid geometry draft." });
      }
      return false;
    }
    const submittedTransform = buildTransformDraftPatch(submittedDraft, submittedObject.transform);
    if (submittedTransform.error || !submittedTransform.transform) {
      const operationIsCurrent = kernel.objectEditSession.reject(operation);
      if (operationIsCurrent) {
        setFeedback({ kind: "error", message: submittedTransform.error ?? "Invalid transform draft." });
      }
      return false;
    }
    const submittedGeometryPayload = submittedGeometryChanged
      ? mergeGeometryDescriptor(submittedObject.geometry as unknown as JsonObject, submittedGeometry.geometry as JsonObject)
      : (submittedObject.geometry as unknown as JsonObject);

    const finishPending = beginPendingOperation();
    let isCurrentMutationContext: (() => boolean) | null = null;
    let historyDegraded = false;
    try {
      const historyContext = createAuthoringMutationContext();
      isCurrentMutationContext = historyContext.isCurrentSessionScope;
      if (
        historyContext.sessionScopeKey !== operation.identity.sessionScopeKey ||
        historyContext.isCurrentSessionScope() === false
      ) {
        kernel.objectEditSession.reject(operation);
        return false;
      }
      const requestOptions = historyContext.sessionScopeKey
        ? { sessionScopeKey: historyContext.sessionScopeKey }
        : undefined;
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Edit geometry and placement ${submittedDraft.name}`,
        () => patchObjectGeometryTransaction(api, operation.identity.objectId, {
          base_revision: submittedBaseRevision,
          geometry: submittedGeometryPayload,
          transform: submittedTransform.transform as JsonObject,
        }, requestOptions),
        undefined,
        {
          onHistoryDegraded: () => {
            historyDegraded = true;
          },
        },
      );
      if (historyContext.isCurrentSessionScope() === false) {
        kernel.objectEditSession.reject(operation);
        return false;
      }
      const nextRevision = acknowledgedAuthoringSceneRevision(response);
      const resolvedAcknowledgedDraft = resolveCommittedGeometryObjectDraft(
        response.committed_scene,
        operation.identity.objectId,
      );
      if (!resolvedAcknowledgedDraft) {
        const operationIsCurrent = kernel.objectEditSession.reject(operation);
        if (operationIsCurrent && historyContext.isCurrentSessionScope()) {
          setFeedback({ kind: "error", message: "The acknowledged object is missing from the committed scene." });
        }
        return false;
      }
      const acknowledgedDraft = {
        ...resolvedAcknowledgedDraft,
        baseRevision: nextRevision,
      };
      const acknowledgedCurrentDraft = kernel.objectEditSession.acknowledge(
        operation,
        acknowledgedDraft,
        reconcileGeneralGeometryAck,
        { reconcileUnchangedDraft: true },
      );
      if (!acknowledgedCurrentDraft) return false;
      invalidateAuthoringResources(
        resources,
        nextRevision,
        response.committed_scene,
        historyContext.sessionScopeKey,
        api.resourceCacheScope,
      );
      setFeedback({
        kind: historyDegraded ? "warning" : "success",
        message: historyDegraded
          ? "Object placement committed, but undo history was not recorded."
          : "Object placement committed.",
      });
      return true;
    } catch (error) {
      const operationIsCurrent = kernel.objectEditSession.reject(operation);
      if (!operationIsCurrent || isCurrentMutationContext?.() === false) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending();
    }
  }

  function revertDraft(): void {
    setDraftState({
      material: object.material,
      name: object.name,
      notes: object.notes,
      region: object.region,
      key: draftKey,
    });
    setFeedback(null);
  }

  function revertAllDrafts(): void {
    if (pending || currentSceneMutationLockReason()) return;
    revertDraft();
    const editState = currentMatchedObjectEditDraft();
    const canonicalDraft = resolveCommittedGeometryObjectDraft(scene.data, object.objectId);
    if (editState && canonicalDraft) {
      kernel.objectEditSession.reset(editState.identity, canonicalDraftInSelectedUnits(canonicalDraft, editState.draft));
    }
  }

  const identityDraftDirty = object.mode === "committed" &&
    (objectEditDraft && canonicalGeometryDraft
      ? !objectEditMetadataEquals(objectEditDraft, canonicalGeometryDraft)
      : draftName !== object.name ||
        draftNotes !== object.notes ||
        draftMaterial !== object.material ||
        draftRegion !== object.region);
  const inspectorDirty = identityDraftDirty || objectEditDraftDirty;

  useEffect(() => {
    if (editIdentity) kernel.objectEditSession.setDirty(editIdentity, inspectorDirty);
  }, [editIdentity, inspectorDirty, kernel.objectEditSession]);

  async function applyRegisteredDrafts(): Promise<boolean> {
    if (identityDraftDirty) {
      const identityAck = await applyIdentityPatch();
      if (!identityAck) return false;
      const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
      const editState = currentMatchedObjectEditDraft();
      const acknowledgedDraft = resolveCommittedGeometryObjectDraft(
        identityAck,
        object.objectId,
      );
      if (
        sessionScopeKey !== currentSessionScopeKey ||
        !editState ||
        editState.identity.sessionScopeKey !== sessionScopeKey ||
        !acknowledgedDraft
      ) return false;
      const hasGeometryChanges =
        !geometryDraftGeometryEquals(editState.draft, acknowledgedDraft) ||
        !geometryDraftTranslationEquals(editState.draft, acknowledgedDraft);
      if (hasGeometryChanges) return applyObjectEditPatch(identityAck);
      return true;
    }

    const editState = currentMatchedObjectEditDraft();
    const currentCanonicalDraft = resolveCommittedGeometryObjectDraft(
      scene.data,
      object.objectId,
    );
    if (!editState || !currentCanonicalDraft) return !objectEditDraftDirty;
    const hasGeometryChanges =
      !geometryDraftGeometryEquals(editState.draft, currentCanonicalDraft) ||
      !geometryDraftTranslationEquals(editState.draft, currentCanonicalDraft);
    return hasGeometryChanges ? applyObjectEditPatch() : true;
  }

  useRegisterInspectorEditSession(
    object.mode === "committed" ? "staged" : null,
    pending,
    inspectorDirty,
    true,
    sceneMutationLockReason,
    applyRegisteredDrafts,
    revertAllDrafts,
    { historyMode: "mutation-owned" },
  );

  function patchObjectColor(
    field: "primitiveColor" | "frameColor",
    value: string,
  ): void {
    if (!visualizationTarget) return;
    const commandId =
      field === "primitiveColor"
        ? "visualization.target.set-primitive-mono-color"
        : "visualization.target.set-wireframe-color";
    void kernel.commands.execute(
      commandId,
      createCommandContext("inspector", kernel, {
        resourceData: displayVisualizationState
          ? { [VISUALIZATION_STATE_PATH]: displayVisualizationState }
          : undefined,
        sourceDetail: "ObjectGeneralPanel",
        visualizationTarget,
      }),
      value,
    );
  }

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Object" collapsible defaultOpen>
        {object.mode === "committed" ? (
          <>
            <FormField
              label="Name"
              mono={false}
              type="text"
              value={draftName}
              onChange={(event) => updateDraft("name", event.target.value)}
            />
            <FormField
              label="Notes"
              type="textarea"
              value={draftNotes}
              onChange={(event) => updateDraft("notes", event.target.value)}
            />
          </>
        ) : (
          <FieldRow label="Name" value={object.name} />
        )}
        <FieldRow label="Object ID" value={object.objectId} />
        <FieldRow label="Shape" value={object.shape} />
        {object.mode === "committed" ? (
          <>
            <FormField
              label="Material"
              type="text"
              value={draftMaterial}
              onChange={(event) => updateDraft("material", event.target.value)}
            />
            <FormField
              label="Region"
              type="text"
              value={draftRegion}
              onChange={(event) => updateDraft("region", event.target.value)}
            />
          </>
        ) : (
          <>
            <FieldRow label="Material" value={object.material} />
            <FieldRow label="Region" value={object.region} />
          </>
        )}
        {object.mode === "committed" && visualizationSettings ? (
          <>
            <FormField
              label="Primitive color"
              mono={false}
              type="text"
              value={primitiveMonoColorForRole(presentationObject?.role, visualizationSettings.primitiveMonoColor)}
              hint="Viewport-local primitive preference; a solid shader override takes precedence."
              onChange={(event) => patchObjectColor("primitiveColor", event.target.value)}
            />
            <FieldRow label="Preview color" value={primitiveColor?.color ?? "unavailable"} />
            <FieldRow label="Preview color source" value={primitiveColor?.source ?? "unavailable"} />
            <FormField
              label="Frame color"
              mono={false}
              type="text"
              value={visualizationSettings.wireframeColor}
              onChange={(event) => patchObjectColor("frameColor", event.target.value)}
            />
          </>
        ) : null}
      </InspectorGroup>

      {!antennaWithoutMagnetization ? <InspectorGroup title="Energies" badge={metricsModel.status} collapsible defaultOpen>
        <FieldRow label="Fetch state" value={objectMetrics.status} />
        <FieldRow label="Sample" value={metricsModel.sample} />
        <FieldRow label="Source" value={metricsModel.source} />
        <FieldRow label="Average m" value={metricsModel.magnetization} />
        <FieldRow label="Exchange" value={metricsModel.exchange} />
        <FieldRow label="Demag" value={metricsModel.demag} />
        <FieldRow label="Zeeman" value={metricsModel.zeeman} />
        <FieldRow label="Anisotropy" value={metricsModel.anisotropy} />
        <FieldRow label="DMI" value={metricsModel.dmi} />
        <FieldRow label="Total" value={metricsModel.total} />
      </InspectorGroup> : null}

      <InspectorGroup title="Resource State" collapsible defaultOpen>
        <FieldRow label="Source" value={object.source} />
        <FieldRow label="Mode" value={object.mode} />
        <FieldRow label="Mesh" value={object.meshStatus} />
        <FieldRow
          label="Scene revision"
          value={object.revision === null ? "unknown" : String(object.revision)}
        />
        <FieldRow label="Fetch state" value={scene.status} />
      </InspectorGroup>

      <InspectorGroup title="Actions">
        {objectEditDraftDirty ? (
          <div style={{ marginBottom: "0.5rem" }}>
            <FeedbackBanner
              kind="warning"
              message="Uncommitted object changes are pending. Use Apply or Revert to commit or discard them."
            />
          </div>
        ) : null}
        <div className="fm-inspector-toolbar">
          {object.mode === "committed" && (
            <>
              <Button
                disabled={pending || Boolean(sceneMutationLockReason) || !inspectorDirty}
                size="sm"
                type="button"
                title={sceneMutationLockReason}
                onClick={() => void applyRegisteredDrafts()}
              >
                {identityDraftDirty && !objectEditDraftDirty ? "Apply Identity" : "Apply"}
              </Button>
              <Button
                disabled={pending || Boolean(sceneMutationLockReason) || !inspectorDirty}
                size="sm"
                type="button"
                variant="ghost"
                title={sceneMutationLockReason}
                onClick={revertAllDrafts}
              >
                Revert
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  kernel.selection.set(
                    {
                      kind: geometrySelectionKind,
                      label: `${object.name} Geometry`,
                      nodeId: `model:object:${object.objectId}:geometry`,
                      objectId: object.objectId,
                      ref: {
                        kind: geometrySelectionKind,
                        nodeId: `model:object:${object.objectId}:geometry`,
                        objectId: object.objectId,
                        type: "scene-object",
                        visualizationTargetId: `object:${object.objectId}`,
                      },
                    },
                    "inspector",
                  );
                }}
              >
                Edit Geometry
              </Button>
              <span className="fm-inspector-toolbar__spacer" />
              <Button
                disabled={pending || inspectorDirty || Boolean(sceneMutationLockReason)}
                size="sm"
                type="button"
                variant="danger"
                title={sceneMutationLockReason ?? (inspectorDirty ? "Apply or revert changes before deleting this object." : undefined)}
                onClick={() => void deleteObject()}
              >
                Delete
              </Button>
            </>
          )}
        </div>
        {feedback ? (
          <FeedbackBanner kind={feedback.kind} message={feedback.message} />
        ) : null}
      </InspectorGroup>

      <InspectorGroup
        title="Validation"
        badge={validationMessages.length > 0 ? String(validationMessages.length) : undefined}
        collapsible
        defaultOpen={validationMessages.length > 0}
      >
        <FieldRow label="Fetch state" value={validation.status} />
        {validationMessages.length > 0 ? (
          <ul className="fm-inspector-validation-list">
            {validationMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : (
          <FieldRow label="Backend validation" value="no object issues" />
        )}
      </InspectorGroup>

      <ObjectExtensionsSection
        objectId={object.objectId}
        selection={selection}
      />
    </div>
  );
}
