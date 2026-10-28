"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  prepareAuthoringMutation,
  recordAuthoringMutationHistory,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import type { MaterialResource, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  resolveMaterialResourceKey,
  resolveObjectInteractionResourceKey,
  useMaterialResource,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey, sessionResourceIdentityKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { applyInspectorSessionWithHistory } from "../InspectorHistoryBridge";
import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
  type InspectorEditSession,
  type InspectorEditSessionStore,
} from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
import { ObjectAbsorbingBoundaryPanel } from "./ObjectAbsorbingBoundaryPanel";
import { ObjectMaterialPanelEditSessionBridge } from "./ObjectMaterialPanelEditSessionBridge";
import {
  objectMaterialMutationScopeKey,
  objectMaterialMutationCoordinator,
  resolveObjectMaterialDraftApplyPolicy,
  type ObjectMaterialMutationCoordinator,
  type ObjectMaterialDraftScope,
} from "./ObjectMaterialPanelEditSession";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateResolvedInspectorDraftState,
  type InspectorDraftState,
} from "./inspectorDraftState";
import { resolveGeometryObjectDraft } from "./geometryObjectPanelModel";
import {
  acknowledgedAssignmentBaseDecision,
  buildCreateMaterialDraft,
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  buildUniaxialAnisotropyPatch,
  createMaterialThenAssign,
  magneticParametersDraftFromResource,
  magneticParametersDraftDirty,
  magneticParameterMaterialResourceFromSceneResource,
  materialParametersDraftKey,
  normalizeMaterialRef,
  rebaseMagneticParametersDraftAfterAssignment,
  sceneResourceRevision,
  MaterialAssignmentAfterCreateError,
  type AcknowledgedAssignmentBaseOverride,
  type CreateMaterialDraft,
  type MagneticParametersDraft,
} from "./ObjectMaterialPanelModel";

interface AnisotropyDraft {
  present: boolean;
  ku1: string;
  axisX: string;
  axisY: string;
  axisZ: string;
}

function anisotropyDraftFromParams(
  present: boolean,
  params: unknown,
): AnisotropyDraft {
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const axis = Array.isArray(p["axis"]) ? (p["axis"] as unknown[]) : [0, 0, 1];
  return {
    present,
    ku1: typeof p["ku1"] === "number" ? String(p["ku1"]) : "",
    axisX: typeof axis[0] === "number" ? String(axis[0]) : "0",
    axisY: typeof axis[1] === "number" ? String(axis[1]) : "0",
    axisZ: typeof axis[2] === "number" ? String(axis[2]) : "1",
  };
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

type PendingOperation = "anisotropy" | "assignment" | "create-assign" | "parameters" | "retry-assign";
const EMPTY_PENDING_OPERATIONS: ReadonlySet<PendingOperation> = new Set();
type AnisotropyField = keyof AnisotropyDraft;
type MagneticDraftField = keyof MagneticParametersDraft;
type CreateMaterialDraftField = keyof CreateMaterialDraft;

const CREATE_MATERIAL_DRAFT_FIELDS: readonly CreateMaterialDraftField[] = [
  "aex",
  "alpha",
  "anisotropyAxis",
  "ku1",
  "materialId",
  "ms",
  "name",
];

interface PanelScope {
  readonly key: string;
  readonly token: symbol;
  readonly draftFieldRevisions: Map<MagneticDraftField, number>;
  readonly createDraftFieldRevisions: Map<CreateMaterialDraftField, number>;
  readonly anisotropyFieldRevisions: Map<AnisotropyField, number>;
}

interface PendingOperationsState {
  operations: ReadonlySet<PendingOperation>;
  scopeKey: string;
  scopeToken: symbol;
}

interface AssignmentFailureState {
  error: MaterialAssignmentAfterCreateError;
  rebasedRevision: number | null;
  refreshError: string | null;
  refreshPhase: "idle" | "requested" | "loading" | "ready" | "error";
  scopeKey: string;
  scopeToken: symbol;
  transactionId: number;
}

interface ApplyMaterialMutationOptions {
  recordHistory?: boolean;
}

function effectiveAssignmentRefreshPhase(
  failure: AssignmentFailureState,
  scene: ReturnType<typeof useSceneResource>,
): AssignmentFailureState["refreshPhase"] {
  if (failure.refreshPhase === "requested") {
    if (scene.status === "loading" || scene.status === "stale") return "loading";
    if (
      scene.status === "ready" &&
      typeof scene.data?.revision === "number" &&
      scene.data.revision > failure.error.assignmentBaseRevision
    ) {
      return "ready";
    }
    return "requested";
  }
  if (failure.refreshPhase !== "loading") return failure.refreshPhase;
  if (scene.status === "error") return "error";
  if (
    scene.status === "ready" &&
    typeof scene.data?.revision === "number" &&
    scene.data.revision > failure.error.assignmentBaseRevision
  ) {
    return "ready";
  }
  return "loading";
}

function newMaterialDraft(objectName: string): CreateMaterialDraft {
  const slug = objectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    aex: "1.3e-11",
    alpha: "0.01",
    anisotropyAxis: ["0", "0", "1"],
    ku1: "",
    materialId: `mat:${slug || "new-material"}`,
    ms: "8e5",
    name: `${objectName || "New object"} material`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useObjectMaterialPanelState(
  selection: InspectorPanelProps["selection"],
  mutationCoordinator: ObjectMaterialMutationCoordinator,
) {
  const { api, authoringHistory, commands, resources } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const scene = useSceneResource();
  const object = resolveGeometryObjectDraft(selection, scene.data);
  useSyncExternalStore(
    mutationCoordinator.subscribe,
    mutationCoordinator.getVersion,
    mutationCoordinator.getVersion,
  );
  const mutationScopeKey = objectMaterialMutationScopeKey(
    sessionScopeKey,
    object.objectId,
  );
  const mutationBusy = mutationCoordinator.getActive(mutationScopeKey) !== null;
  const sessionIdentityKey = sessionIdentity
    ? sessionResourceIdentityKey(sessionIdentity)
    : "session:unknown";
  const scopeKey = `${sessionIdentityKey}|${object.mode}|${object.objectId}`;
  const [scopeState, setScopeState] = useState<PanelScope>(() => ({
    key: scopeKey, token: Symbol(scopeKey),
    draftFieldRevisions: new Map(),
    createDraftFieldRevisions: new Map(),
    anisotropyFieldRevisions: new Map(),
  }));
  const scope = useMemo(() => scopeState.key === scopeKey ? scopeState : {
    key: scopeKey, token: Symbol(scopeKey),
    draftFieldRevisions: new Map<MagneticDraftField, number>(),
    createDraftFieldRevisions: new Map<CreateMaterialDraftField, number>(),
    anisotropyFieldRevisions: new Map<AnisotropyField, number>(),
  }, [scopeState, scopeKey]);
  if (scopeState !== scope) setScopeState(scope);
  const scopeRef = useRef<PanelScope | null>(null);
  useLayoutEffect(() => {
    scopeRef.current = scope;
    return () => { if (scopeRef.current === scope) scopeRef.current = null; };
  }, [scope]);
  const historyGeneration = authoringHistory?.getGeneration?.();
  const isCurrentScope = useCallback(
    () => Boolean(sessionScopeKey) && scopeRef.current === scope && commands.getSessionScopeKey() === sessionScopeKey &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration),
    [authoringHistory, commands, historyGeneration, scope, sessionScopeKey],
  );
  const [assignmentBaseOverrideState, setAssignmentBaseOverrideState] =
    useState<AcknowledgedAssignmentBaseOverride | null>(null);
  const materialId = normalizeMaterialRef(object.material);
  const material = useMaterialResource(materialId);
  const anisotropyInteraction = useObjectInteractionResource(
    object.objectId || null,
    "uniaxial_anisotropy",
  );
  const baseAnisotropyDraft = useMemo(
    () =>
      anisotropyDraftFromParams(
        anisotropyInteraction.data?.present ?? false,
        anisotropyInteraction.data?.params ?? {},
      ),
    [anisotropyInteraction.data],
  );
  const [anisotropyDraftState, setAnisotropyDraftState] = useState<{
    draft: AnisotropyDraft;
    dirtyFields: ReadonlySet<AnisotropyField>;
    key: string;
    scopeKey: string;
    scopeToken: symbol;
  }>({ draft: baseAnisotropyDraft, dirtyFields: new Set(), key: "", scopeKey, scopeToken: scope.token });
  const anisotropyDraftKey = [
    object.objectId,
    String(anisotropyInteraction.data?.present ?? false),
    String(anisotropyInteraction.data?.params ? JSON.stringify(anisotropyInteraction.data.params) : ""),
  ].join(":");
  const anisotropyDraft =
    anisotropyDraftState.scopeKey === scopeKey &&
    anisotropyDraftState.scopeToken === scope.token &&
    (anisotropyDraftState.key === anisotropyDraftKey || anisotropyDraftState.dirtyFields.size > 0)
      ? anisotropyDraftState.draft
      : baseAnisotropyDraft;
  const resourceBaseDraft = useMemo(
    () =>
      magneticParametersDraftFromResource(
        object.material,
        material.data ?? null,
      ),
    [material.data, object.material],
  );
  const assignmentKey = [
    object.mode,
    object.objectId,
    object.baseRevision ?? "unknown",
    object.material,
  ].join(":");
  const resourceDraftKey = `${assignmentKey}:${materialParametersDraftKey(
    object.material,
    material.data ?? null,
  )}`;
  const currentSceneRevision = sceneResourceRevision(scene.data);
  const currentSceneMaterial = materialId && scene.data
    ? magneticParameterMaterialResourceFromSceneResource(materialId, scene.data)
    : null;
  const currentSceneBaseDraft = currentSceneMaterial
    ? magneticParametersDraftFromResource(materialId, currentSceneMaterial)
    : null;
  const currentSceneBaseKey = currentSceneMaterial && object.mode === "committed"
    ? `${assignmentKey}:${materialParametersDraftKey(materialId, currentSceneMaterial)}`
    : null;
  const draftIdentityKey = [scopeKey, object.mode, object.objectId].join(":");
  const assignmentBaseDecision = assignmentBaseOverrideState
    ? acknowledgedAssignmentBaseDecision({
        override: assignmentBaseOverrideState,
        currentSceneBaseKey,
        currentResourceBaseKey: resourceDraftKey,
        currentMaterialId: materialId,
        currentObjectId: object.objectId,
        currentSceneRevision,
        currentScopeKey: scopeKey,
        currentScopeToken: scope.token,
      })
    : "discard";
  // Keep confirmed assignment fields available while the new material GET loads.
  const materialData = material.data ?? (
    assignmentBaseDecision !== "discard" && assignmentBaseOverrideState?.materialId === materialId
      ? currentSceneMaterial
      : null
  );
  const assignmentBaseOverride = assignmentBaseDecision === "use"
    ? assignmentBaseOverrideState
    : null;
  const baseDraft = assignmentBaseDecision === "use" && assignmentBaseOverride
    ? assignmentBaseOverride.baseDraft
    : assignmentBaseDecision === "rebase" && currentSceneBaseDraft
      ? currentSceneBaseDraft
      : resourceBaseDraft;
  const draftKey = assignmentBaseDecision === "use" && assignmentBaseOverride
    ? assignmentBaseOverride.baseKey
    : assignmentBaseDecision === "rebase" && currentSceneBaseKey
      ? currentSceneBaseKey
      : resourceDraftKey;
  const [draftState, setDraftState] = useState<
    InspectorDraftState<MagneticParametersDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey: draftKey,
      identityKey: draftIdentityKey,
    }),
  );
  // Adjust this component's state before commit when the acknowledged base changes.
  if (assignmentBaseOverrideState && assignmentBaseDecision !== "use") {
    const current = assignmentBaseOverrideState;
    if (assignmentBaseDecision === "rebase") {
      if (currentSceneBaseDraft && currentSceneBaseKey && currentSceneRevision !== null) {
        if (draftState.identityKey === current.identityKey) {
          const revisions = new Map(scope.draftFieldRevisions);
          const rebasedDraft = rebaseMagneticParametersDraftAfterAssignment({
            previousBaseDraft: current.baseDraft,
            draftAtStart: draftState.draft,
            currentDraft: draftState.draft,
            committedBaseDraft: currentSceneBaseDraft,
            startingRevisions: revisions,
            currentRevisions: revisions,
          });
          setDraftState({
            baseKey: currentSceneBaseKey,
            dirty: magneticParametersDraftDirty(rebasedDraft, currentSceneBaseDraft),
            draft: rebasedDraft,
            identityKey: current.identityKey,
          });
        }
        setAssignmentBaseOverrideState(resourceDraftKey === currentSceneBaseKey ? null : {
          ...current,
          baseDraft: currentSceneBaseDraft,
          baseKey: currentSceneBaseKey,
          sceneRevision: currentSceneRevision,
        });
      }
    } else {
      setAssignmentBaseOverrideState(null);
    }
  }
  const [feedbackState, setFeedbackState] = useState<{
    value: Feedback;
    scopeToken: symbol;
  }>(() => ({ value: null, scopeToken: scope.token }));
  const feedback = feedbackState.scopeToken === scope.token ? feedbackState.value : null;
  const setFeedback = useCallback(
    (value: Feedback) => setFeedbackState({ value, scopeToken: scope.token }),
    [scope],
  );
  const [pendingOperationsState, setPendingOperationsState] = useState<PendingOperationsState>(
    () => ({ operations: new Set(), scopeKey, scopeToken: scope.token }),
  );
  const [createDraftState, setCreateDraftState] = useState<{
    baseline: CreateMaterialDraft;
    draft: CreateMaterialDraft;
    objectId: string;
    scopeKey: string;
    scopeToken: symbol;
  }>(() => {
    const baseline = newMaterialDraft(object.name);
    return { baseline, draft: baseline, objectId: object.objectId, scopeKey, scopeToken: scope.token };
  });
  const createDraftStateMatchesScope = createDraftState.scopeKey === scopeKey &&
    createDraftState.scopeToken === scope.token &&
    createDraftState.objectId === object.objectId;
  const createDraftBaseline = createDraftStateMatchesScope
    ? createDraftState.baseline
    : newMaterialDraft(object.name);
  const createDraft = createDraftStateMatchesScope
    ? createDraftState.draft
    : createDraftBaseline;
  const createDraftRef = useRef(createDraft);
  const createDraftRefScope = useRef({
    objectId: object.objectId,
    scopeKey,
    scopeToken: scope.token,
  });
  useLayoutEffect(() => {
    createDraftRef.current = createDraft;
    createDraftRefScope.current = {
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    };
  }, [createDraft, object.objectId, scopeKey, scope.token]);
  const createDraftDirty = JSON.stringify(createDraft) !== JSON.stringify(createDraftBaseline);
  const [assignmentFailureState, setAssignmentFailureState] = useState<AssignmentFailureState | null>(null);
  const pendingOperations = pendingOperationsState.scopeKey === scopeKey && pendingOperationsState.scopeToken === scope.token
    ? pendingOperationsState.operations
    : EMPTY_PENDING_OPERATIONS;
  const assignmentFailure = assignmentFailureState?.scopeKey === scopeKey && assignmentFailureState.scopeToken === scope.token
    ? {
        ...assignmentFailureState,
        refreshPhase: effectiveAssignmentRefreshPhase(assignmentFailureState, scene),
        refreshError:
          assignmentFailureState.refreshError ??
          (assignmentFailureState.refreshPhase === "loading" && scene.status === "error"
            ? errorMessage(scene.error)
            : null),
      }
    : null;
  const draftTransactionRevisionRef = useRef(0);
  function acquireObjectMutation(operation: string) {
    const lease = mutationCoordinator.acquire(mutationScopeKey, operation);
    if (!lease) {
      const active = mutationCoordinator.getActive(mutationScopeKey);
      setFeedback({
        kind: "error",
        message: active
          ? `${active.operation} is still saving. Wait for its acknowledgement before starting another update.`
          : "Another update is still saving. Wait for its acknowledgement before trying again.",
      });
    }
    return lease;
  }

  function draftStateForResolution(
    state: InspectorDraftState<MagneticParametersDraft>,
  ): InspectorDraftState<MagneticParametersDraft> {
    if (assignmentBaseDecision !== "rebase" || !assignmentBaseOverrideState ||
      state.identityKey !== assignmentBaseOverrideState.identityKey) {
      return state;
    }
    const revisions = new Map(scope.draftFieldRevisions);
    const rebasedDraft = rebaseMagneticParametersDraftAfterAssignment({
      previousBaseDraft: assignmentBaseOverrideState.baseDraft,
      draftAtStart: state.draft,
      currentDraft: state.draft,
      committedBaseDraft: resourceBaseDraft,
      startingRevisions: revisions,
      currentRevisions: revisions,
    });
    return {
      baseKey: resourceDraftKey,
      dirty: magneticParametersDraftDirty(rebasedDraft, resourceBaseDraft),
      draft: rebasedDraft,
      identityKey: assignmentBaseOverrideState.identityKey,
    };
  }
  const resolvedDraftState = draftStateForResolution(draftState);

  const { draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: magneticParametersDraftDirty,
    state: resolvedDraftState,
  });
  const draftMaterialId = normalizeMaterialRef(draft.materialRef);
  const parametersTargetChanged = draftMaterialId !== materialId;

  function startPending(operation: PendingOperation, pendingScope = scope): void {
    setPendingOperationsState((current) => {
      if (current.scopeToken !== pendingScope.token) {
        return {
          operations: new Set([operation]),
          scopeKey: pendingScope.key,
          scopeToken: pendingScope.token,
        };
      }
      return {
        operations: new Set(current.operations).add(operation),
        scopeKey: pendingScope.key,
        scopeToken: pendingScope.token,
      };
    });
  }

  function finishPending(operation: PendingOperation, pendingScope = scope): void {
    setPendingOperationsState((current) => {
      if (current.scopeToken !== pendingScope.token) return current;
      const next = new Set(current.operations);
      next.delete(operation);
      return { operations: next, scopeKey: pendingScope.key, scopeToken: pendingScope.token };
    });
  }

  function updateAnisotropyDraft(patch: Partial<AnisotropyDraft>): void {
    const fields = Object.keys(patch) as AnisotropyField[];
    for (const field of fields) {
      scope.anisotropyFieldRevisions.set(
        field,
        (scope.anisotropyFieldRevisions.get(field) ?? 0) + 1,
      );
    }
    setAnisotropyDraftState((current) => {
      const sameKey = current.scopeToken === scope.token && current.key === anisotropyDraftKey;
      const dirtyFields = sameKey
        ? new Set(current.dirtyFields)
        : new Set<AnisotropyField>();
      for (const field of fields) dirtyFields.add(field);
      return {
        draft: {
          ...(sameKey ? current.draft : baseAnisotropyDraft),
          ...patch,
        },
        dirtyFields,
        key: anisotropyDraftKey,
        scopeKey,
        scopeToken: scope.token,
      };
    });
  }

  async function applyAnisotropy({
    recordHistory = true,
  }: ApplyMaterialMutationOptions = {}): Promise<boolean> {
    if (!object.objectId || object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return false;
    }
    const anisotropy = buildUniaxialAnisotropyPatch(
      anisotropyDraft.ku1,
      [anisotropyDraft.axisX, anisotropyDraft.axisY, anisotropyDraft.axisZ],
    );
    if ("error" in anisotropy) {
      setFeedback({ kind: "error", message: anisotropy.error });
      return false;
    }
    const value = anisotropy.value ?? { axis: [0, 0, 1] as [number, number, number], ku1: 0 };
    const operationScope = scope;
    const operationSessionScopeKey = sessionScopeKey;
    const mutationLease = acquireObjectMutation("Anisotropy");
    if (!mutationLease) return false;
    startPending("anisotropy", operationScope);
    try {
      const mutation = ({ baseRevision }: { baseRevision: number | null }) =>
        api.model.patchObjectInteraction(
          object.objectId,
          "uniaxial_anisotropy",
          {
            base_revision: baseRevision ?? anisotropyInteraction.data?.scene_revision ?? null,
            present: anisotropyDraft.present,
            params: { ku1: value.ku1, axis: value.axis },
          },
          operationSessionScopeKey
            ? { sessionScopeKey: operationSessionScopeKey }
            : undefined,
        );
      const response = recordHistory
        ? await runAuthoringMutationWithHistory(
            {
              api,
              authoringHistory,
              sessionScopeKey: operationSessionScopeKey,
              isCurrentSessionScope: isCurrentScope,
            },
            "Update uniaxial anisotropy",
            mutation,
          )
        : await mutation({ baseRevision: null });
      const revision = acknowledgedAuthoringSceneRevision(response);
      if (!isCurrentScope()) return false;
      resources.invalidate(
        resolveObjectInteractionResourceKey(object.objectId, "uniaxial_anisotropy"),
        revision,
      );
      invalidateMagneticParameterResources(revision);
      setFeedback({ kind: "success", message: "Uniaxial anisotropy updated." });
      return true;
    } catch (error) {
      if (!isCurrentScope()) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending("anisotropy", operationScope);
      mutationCoordinator.finish(mutationLease);
    }
  }

  function updateDraft(patch: Partial<MagneticParametersDraft>): void {
    const fields = Object.keys(patch) as MagneticDraftField[];
    for (const field of fields) {
      scope.draftFieldRevisions.set(
        field,
        (scope.draftFieldRevisions.get(field) ?? 0) + 1,
      );
    }
    setDraftState((current) =>
      updateResolvedInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        currentState: draftStateForResolution(current),
        identityKey: draftIdentityKey,
        isDirty: magneticParametersDraftDirty,
        patch,
      }),
    );
  }

  function rebaseAssignedMaterialDraft(
    materialId: string,
    acknowledgedScenes: readonly SceneResource[],
    previousBaseDraft: MagneticParametersDraft,
    draftAtStart: MagneticParametersDraft,
    identityKeyAtStart: string,
    startingRevisions: ReadonlyMap<MagneticDraftField, number>,
    pendingScope: PanelScope,
  ): boolean {
    if (!isCurrentScope() || pendingScope.token !== scope.token) return false;
    let acknowledgedMaterial: MaterialResource | null = null;
    for (const acknowledgedScene of acknowledgedScenes) {
      const candidate = magneticParameterMaterialResourceFromSceneResource(materialId, acknowledgedScene);
      if (candidate) {
        acknowledgedMaterial = candidate;
        break;
      }
    }
    if (!acknowledgedMaterial) return false;

    const assignedObjectSnapshot = acknowledgedScenes
      .map((acknowledgedScene) => ({
        object: resolveGeometryObjectDraft(selection, acknowledgedScene),
        sceneRevision: sceneResourceRevision(acknowledgedScene),
      }))
      .find(({ object: acknowledgedObject }) =>
        acknowledgedObject.mode === "committed" &&
        acknowledgedObject.objectId === object.objectId &&
        normalizeMaterialRef(acknowledgedObject.material) === materialId,
      );
    if (!assignedObjectSnapshot) return false;

    const committedBaseDraft = magneticParametersDraftFromResource(materialId, acknowledgedMaterial);
    const { object: acknowledgedObject, sceneRevision: acknowledgedSceneRevision } = assignedObjectSnapshot;
    const committedBaseKey = `${[
      acknowledgedObject.mode,
      acknowledgedObject.objectId,
      acknowledgedObject.baseRevision ?? "unknown",
      acknowledgedObject.material,
    ].join(":")}:${materialParametersDraftKey(materialId, acknowledgedMaterial)}`;
    setAssignmentBaseOverrideState({
      baseDraft: committedBaseDraft,
      baseKey: committedBaseKey,
      identityKey: identityKeyAtStart,
      materialId,
      objectId: acknowledgedObject.objectId,
      sceneRevision: acknowledgedSceneRevision,
      scopeKey: pendingScope.key,
      scopeToken: pendingScope.token,
    });
    setDraftState((current) => {
      if (current.identityKey !== identityKeyAtStart) return current;
      const rebasedDraft = rebaseMagneticParametersDraftAfterAssignment({
        previousBaseDraft,
        draftAtStart,
        currentDraft: current.draft,
        committedBaseDraft,
        startingRevisions,
        currentRevisions: scope.draftFieldRevisions,
      });
      return {
        baseKey: committedBaseKey,
        dirty: magneticParametersDraftDirty(rebasedDraft, committedBaseDraft),
        draft: rebasedDraft,
        identityKey: identityKeyAtStart,
      };
    });
    return true;
  }

  async function applyMaterial({
    recordHistory = true,
  }: ApplyMaterialMutationOptions = {}): Promise<boolean> {
    if (object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return false;
    }

    const operationScope = scope;
    const operationSessionScopeKey = sessionScopeKey;
    const mutationLease = acquireObjectMutation("Material assignment");
    if (!mutationLease) return false;
    startPending("assignment", operationScope);
    try {
      const mutation = ({ baseRevision }: { baseRevision: number | null }) =>
        api.model.patchObject(
          object.objectId,
          buildMaterialAssignmentPatch(draft, baseRevision ?? object.baseRevision),
          operationSessionScopeKey
            ? { sessionScopeKey: operationSessionScopeKey }
            : undefined,
        );
      const sceneResponse = recordHistory
        ? await runAuthoringMutationWithHistory(
            {
              api,
              authoringHistory,
              sessionScopeKey: operationSessionScopeKey,
              isCurrentSessionScope: isCurrentScope,
            },
            "Update object material assignment",
            mutation,
          )
        : await mutation({ baseRevision: null });
      const revision = acknowledgedAuthoringSceneRevision(sceneResponse);
      if (!isCurrentScope()) return false;
      invalidateMagneticParameterResources(revision);
      setFeedback({
        kind: "success",
        message: "Object material assignment updated.",
      });
      return true;
    } catch (error) {
      if (!isCurrentScope()) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending("assignment", operationScope);
      mutationCoordinator.finish(mutationLease);
    }
  }

  async function applyParameters({
    recordHistory = true,
  }: ApplyMaterialMutationOptions = {}): Promise<boolean> {
    if (!materialId || !materialData) {
      setFeedback({
        kind: "error",
        message: "No committed material asset is assigned to this object.",
      });
      return false;
    }
    if (parametersTargetChanged) {
      setFeedback({
        kind: "error",
        message: "Apply the material assignment before editing its parameters.",
      });
      return false;
    }

    const result = buildMaterialParametersPatch(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return false;
    }

    const operationScope = scope;
    const operationSessionScopeKey = sessionScopeKey;
    const mutationLease = acquireObjectMutation("Material parameters");
    if (!mutationLease) return false;
    startPending("parameters", operationScope);
    try {
      const mutation = ({ baseRevision }: { baseRevision: number | null }) =>
        api.model.patchMaterialAsset(
          materialId,
          result.patch,
          (() => {
            const options =
              baseRevision === null
                ? object.baseRevision === null
                  ? undefined
                  : { baseRevision: object.baseRevision }
                : { baseRevision };
            return operationSessionScopeKey
              ? { ...options, sessionScopeKey: operationSessionScopeKey }
              : options;
          })(),
        );
      const response = recordHistory
        ? await runAuthoringMutationWithHistory(
            {
              api,
              authoringHistory,
              sessionScopeKey: operationSessionScopeKey,
              isCurrentSessionScope: isCurrentScope,
            },
            "Update material parameters",
            mutation,
          )
        : await mutation({ baseRevision: null });
      const revision = acknowledgedAuthoringSceneRevision(response);
      if (!isCurrentScope()) return false;
      resources.invalidate(resolveMaterialResourceKey(materialId), revision);
      invalidateMagneticParameterResources(revision);
      setFeedback({
        kind: "success",
        message: "Magnetic parameters updated.",
      });
      return true;
    } catch (error) {
      if (!isCurrentScope()) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending("parameters", operationScope);
      mutationCoordinator.finish(mutationLease);
    }
  }

  function invalidateMagneticParameterResources(revision: number): void {
    invalidateAuthoringMutationDependents(resources, "material", revision);
  }

  function updateCreateDraft(patch: Partial<CreateMaterialDraft>): void {
    const matchesScope = createDraftStateMatchesScope;
    const refMatchesScope = createDraftRefScope.current.objectId === object.objectId &&
      createDraftRefScope.current.scopeKey === scopeKey &&
      createDraftRefScope.current.scopeToken === scope.token;
    const baseline = matchesScope ? createDraftState.baseline : newMaterialDraft(object.name);
    // Event handlers may update several fields before React commits the next
    // render. Compose from the ref so each synchronous edit builds on the
    // previous one instead of restoring stale fields from this render.
    const currentDraft = matchesScope || refMatchesScope ? createDraftRef.current : baseline;
    const nextDraft = { ...currentDraft, ...patch };
    for (const field of Object.keys(patch) as CreateMaterialDraftField[]) {
      scope.createDraftFieldRevisions.set(
        field,
        (scope.createDraftFieldRevisions.get(field) ?? 0) + 1,
      );
    }
    createDraftRef.current = nextDraft;
    createDraftRefScope.current = {
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    };
    setCreateDraftState({
      baseline,
      draft: nextDraft,
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    });
    setFeedback(null);
  }

  function rebaseCreateDraftAfterAcknowledgement(
    startingRevisions: ReadonlyMap<CreateMaterialDraftField, number>,
  ): void {
    const baseline = newMaterialDraft(object.name);
    const latestDraft = createDraftRef.current;
    const rebasedDraft = { ...baseline };
    for (const field of CREATE_MATERIAL_DRAFT_FIELDS) {
      const changedDuringRequest =
        (scope.createDraftFieldRevisions.get(field) ?? 0) !==
        (startingRevisions.get(field) ?? 0);
      if (changedDuringRequest) {
        Object.assign(rebasedDraft, { [field]: latestDraft[field] });
      }
    }
    createDraftRef.current = rebasedDraft;
    createDraftRefScope.current = {
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    };
    setCreateDraftState({
      baseline,
      draft: rebasedDraft,
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    });
  }

  function resetCreateDraft(): void {
    const baseline = newMaterialDraft(object.name);
    createDraftRef.current = baseline;
    createDraftRefScope.current = {
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    };
    setCreateDraftState({
      baseline,
      draft: baseline,
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    });
    scope.createDraftFieldRevisions.clear();
    setAssignmentFailureState((current) =>
      current?.scopeToken === scope.token ? null : current,
    );
  }

  function stageDeferredAnisotropy(
    anisotropy: { axis: [number, number, number]; ku1: number } | null,
    pendingScope = scope,
  ): void {
    if (!anisotropy || !isCurrentScope() || pendingScope.token !== scope.token) return;
    const staged: Partial<AnisotropyDraft> = {
      axisX: String(anisotropy.axis[0]),
      axisY: String(anisotropy.axis[1]),
      axisZ: String(anisotropy.axis[2]),
      ku1: String(anisotropy.ku1),
      present: true,
    };
    setAnisotropyDraftState((current) => {
      const sameKey = current.scopeToken === scope.token && current.key === anisotropyDraftKey;
      const merged: AnisotropyDraft = {
        ...(sameKey ? current.draft : baseAnisotropyDraft),
      };
      const dirtyFields = sameKey ? new Set(current.dirtyFields) : new Set<AnisotropyField>();
      for (const [field, value] of Object.entries(staged) as [AnisotropyField, AnisotropyDraft[AnisotropyField]][]) {
        if (!dirtyFields.has(field)) {
          Object.assign(merged, { [field]: value });
          dirtyFields.add(field);
        }
      }
      return { draft: merged, dirtyFields, key: anisotropyDraftKey, scopeKey, scopeToken: scope.token };
    });
  }

  async function createAndAssignMaterial(hasBoundaryDraft = false): Promise<void> {
    const operationScope = scope;
    const operationSessionScopeKey = sessionScopeKey;
    if (!object.objectId || object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object with a known revision." });
      return;
    }
    if (
      magneticParametersDraftDirty(draft, baseDraft) ||
      JSON.stringify(anisotropyDraft) !== JSON.stringify(baseAnisotropyDraft) ||
      hasBoundaryDraft
    ) {
      setFeedback({
        kind: "error",
        message: "Apply or revert the other object drafts first. Then use Create and assign, or Revert all drafts.",
      });
      return;
    }
    if (assignmentFailure) {
      setFeedback({
        kind: "error",
        message: "This material already exists after a failed assignment. Use Refresh scene, Rebase assignment, then Retry assignment, or Revert.",
      });
      return;
    }
    const submittedCreateDraft = createDraftRef.current;
    const validation = buildCreateMaterialDraft(submittedCreateDraft);
    if ("error" in validation) {
      setFeedback({ kind: "error", message: validation.error });
      return;
    }
    const mutationLease = acquireObjectMutation("Create and assign material");
    if (!mutationLease) return;
    const previousBaseDraft = baseDraft;
    const draftAtStart = draft;
    const identityKeyAtStart = draftIdentityKey;
    const startingDraftRevisions = new Map(scope.draftFieldRevisions);
    const startingCreateDraftRevisions = new Map(scope.createDraftFieldRevisions);
    const historyContext = {
      api,
      authoringHistory,
      sessionScopeKey: operationSessionScopeKey,
      isCurrentSessionScope: isCurrentScope,
    };
    const transactionId = ++draftTransactionRevisionRef.current;
    startPending("create-assign", operationScope);
    let preparation: Awaited<ReturnType<typeof prepareAuthoringMutation>> | null = null;
    try {
      preparation = await prepareAuthoringMutation(historyContext);
      if (!isCurrentScope()) return;
      const baseRevision = preparation.baseRevision ?? object.baseRevision;
      if (baseRevision === null) {
        setFeedback({ kind: "error", message: "No committed scene object with a known revision." });
        return;
      }
      const result = await createMaterialThenAssign(
        api,
        object.objectId,
        submittedCreateDraft,
        baseRevision,
        (created) => {
          if (!isCurrentScope()) return;
          rebaseCreateDraftAfterAcknowledgement(startingCreateDraftRevisions);
          publishCommittedSceneResource(
            resources,
            created.committed_scene,
            created.scene_revision,
            undefined,
            false,
            operationSessionScopeKey,
            api.resourceCacheScope,
          );
          resources.invalidate(
            resolveMaterialResourceKey(validation.value.materialId),
            created.scene_revision,
          );
          invalidateMagneticParameterResources(created.scene_revision);
        },
        isCurrentScope,
        operationSessionScopeKey,
      );
      if (!isCurrentScope()) return;
      const assignmentRevision = acknowledgedAuthoringSceneRevision(result.assigned);
      publishCommittedSceneResource(
        resources,
        result.assigned,
        assignmentRevision,
        undefined,
        false,
        operationSessionScopeKey,
        api.resourceCacheScope,
      );
      invalidateMagneticParameterResources(assignmentRevision);
      let historyError: string | null = null;
      try {
        await recordAuthoringMutationHistory(
          historyContext,
          "Create and assign material",
          preparation,
          result.assigned,
        );
      } catch (error) {
        historyError = errorMessage(error);
      }
      if (!isCurrentScope()) return;
      const draftRebased = rebaseAssignedMaterialDraft(
        result.materialId,
        [result.assigned, result.created.committed_scene],
        previousBaseDraft,
        draftAtStart,
        identityKeyAtStart,
        startingDraftRevisions,
        operationScope,
      );
      stageDeferredAnisotropy(result.deferredAnisotropy, operationScope);
      setFeedback({
        kind: draftRebased && !historyError ? "success" : "error",
        message: historyError
          ? `Material was created and assigned, but its history record failed: ${historyError}`
          : draftRebased
          ? result.deferredAnisotropy
            ? "Material created and assigned. Ku1 draft is ready; apply anisotropy separately."
            : "Material created and assigned."
          : "Material was created and assigned, but its committed parameter values could not be confirmed in the returned scene.",
      });
    } catch (error) {
      if (!isCurrentScope()) return;
      if (error instanceof MaterialAssignmentAfterCreateError) {
        let historyError: string | null = null;
        if (preparation) {
          try {
            await recordAuthoringMutationHistory(
              historyContext,
              "Create material (assignment pending)",
              preparation,
              error.created.committed_scene,
            );
          } catch (recordError) {
            historyError = errorMessage(recordError);
          }
        }
        if (!isCurrentScope()) return;
        stageDeferredAnisotropy(error.deferredAnisotropy, operationScope);
        setAssignmentFailureState({
          error,
          rebasedRevision: null,
          refreshError: null,
          refreshPhase: "idle",
          scopeKey: operationScope.key,
          scopeToken: operationScope.token,
          transactionId,
        });
        setFeedback({
          kind: "error",
          message: historyError
            ? `Material was created, assignment failed, and history could not be recorded: ${historyError}. Use Refresh scene, Rebase assignment, then Retry assignment, or Revert.`
            : "Material was created and remains in the library, but assignment failed. Use Refresh scene, Rebase assignment, then Retry assignment, or Revert.",
        });
      } else {
        setFeedback({ kind: "error", message: errorMessage(error) });
      }
    } finally {
      finishPending("create-assign", operationScope);
      mutationCoordinator.finish(mutationLease);
    }
  }

  function rebaseFailedAssignment(): void {
    if (
      !assignmentFailure ||
      assignmentFailure.refreshPhase !== "ready" ||
      scene.status !== "ready" ||
      typeof scene.data?.revision !== "number" ||
      scene.data.revision <= assignmentFailure.error.assignmentBaseRevision
    ) return;
    const rebasedRevision = scene.data.revision;
    setAssignmentFailureState((current) => {
      if (!current || current.scopeToken !== scope.token || current.transactionId !== assignmentFailure.transactionId) {
        return current;
      }
      return { ...current, rebasedRevision };
    });
    setFeedback({ kind: "success", message: `Assignment rebased to scene revision ${rebasedRevision}.` });
  }

  function refreshFailedAssignment(): void {
    if (!assignmentFailure || !isCurrentScope()) return;
    const failure = assignmentFailure;
    setAssignmentFailureState((current) =>
      current?.scopeToken === scope.token && current.transactionId === failure.transactionId
      ? {
            ...current,
            rebasedRevision: null,
            refreshError: null,
            refreshPhase: "loading",
          }
        : current,
    );
    scene.refetch();
  }

  async function retryFailedAssignment(): Promise<void> {
    if (!assignmentFailure || assignmentFailure.rebasedRevision === null || !isCurrentScope()) return;
    const operationScope = scope;
    const operationSessionScopeKey = sessionScopeKey;
    const failure = assignmentFailure;
    const rebasedRevision = failure.rebasedRevision;
    if (rebasedRevision === null) return;
    const previousBaseDraft = baseDraft;
    const draftAtStart = draft;
    const identityKeyAtStart = draftIdentityKey;
    const startingDraftRevisions = new Map(scope.draftFieldRevisions);
    const mutationLease = acquireObjectMutation("Retry material assignment");
    if (!mutationLease) return;
    startPending("retry-assign", operationScope);
    try {
      const assigned = await runAuthoringMutationWithHistory(
        {
          api,
          authoringHistory,
          sessionScopeKey: operationSessionScopeKey,
          isCurrentSessionScope: isCurrentScope,
        },
        "Retry material assignment",
        async ({ baseRevision }) =>
          failure.error.retry(api, baseRevision ?? rebasedRevision),
      );
      if (!isCurrentScope()) return;
      const assignmentRevision = acknowledgedAuthoringSceneRevision(assigned);
      publishCommittedSceneResource(
        resources,
        assigned,
        assignmentRevision,
        undefined,
        false,
        operationSessionScopeKey,
        api.resourceCacheScope,
      );
      invalidateMagneticParameterResources(assignmentRevision);
      const draftRebased = rebaseAssignedMaterialDraft(
        failure.error.materialId,
        [assigned, failure.error.created.committed_scene],
        previousBaseDraft,
        draftAtStart,
        identityKeyAtStart,
        startingDraftRevisions,
        operationScope,
      );
      setAssignmentFailureState((current) =>
        current?.scopeToken === operationScope.token && current.transactionId === failure.transactionId
          ? null
          : current,
      );
      setFeedback({
        kind: draftRebased ? "success" : "error",
        message: draftRebased
          ? "Material assignment retry succeeded."
          : "Material assignment retry succeeded, but its committed parameter values could not be confirmed in the returned scene.",
      });
    } catch (error) {
      if (!isCurrentScope()) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      finishPending("retry-assign", operationScope);
      mutationCoordinator.finish(mutationLease);
    }
  }

  return {
    anisotropyDraft,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    assignmentFailure,
    baseAnisotropyDraft,
    baseDraft,
    createAndAssignMaterial,
    createDraft,
    createDraftDirty,
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialData,
    materialId,
    mutationBusy,
    mutationCoordinator,
    mutationScopeKey,
    object,
    parametersTargetChanged,
    pendingOperations,
    refreshFailedAssignment,
    rebaseFailedAssignment,
    resetCreateDraft,
    retryFailedAssignment,
    scene,
    scopeKey,
    scopeToken: scope.token,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
    updateAnisotropyDraft,
    updateCreateDraft,
    updateDraft,
  } as const;
}

type ObjectMaterialPanelState = ReturnType<typeof useObjectMaterialPanelState>;

function materialInspectorSections(selectionKind: string | null): string[] {
  switch (selectionKind) {
    case "object.material":
      return ["parameters", "material-parameters", "absorbing-boundary", "actions"];
    case "object.magnetic-parameters":
      return ["parameters", "assignment", "uniaxial-anisotropy", "absorbing-boundary", "actions"];
    default:
      return ["parameters", "assignment", "uniaxial-anisotropy", "material-parameters", "absorbing-boundary", "actions"];
  }
}

export function ObjectMaterialPanel({ selection }: InspectorPanelProps) {
  const panel = useObjectMaterialPanelState(selection, objectMaterialMutationCoordinator);
  const [absorbingBoundaryEditSessionStore] = useState(createInspectorEditSessionStore);
  const sections = materialInspectorSections(selection.kind);
  const showSection = (section: string) => sections.includes(section);
  return (
    <ObjectMaterialPanelView
      absorbingBoundaryEditSessionStore={absorbingBoundaryEditSessionStore}
      panel={panel}
      showSection={showSection}
    />
  );
}

function ObjectMaterialPanelView({
  absorbingBoundaryEditSessionStore,
  panel,
  showSection,
}: {
  absorbingBoundaryEditSessionStore: InspectorEditSessionStore;
  panel: ObjectMaterialPanelState;
  showSection: (section: string) => boolean;
}) {
  const {
    anisotropyDraft,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    assignmentFailure,
    baseAnisotropyDraft,
    baseDraft,
    createAndAssignMaterial,
    createDraft,
    createDraftDirty,
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialData,
    materialId,
    mutationBusy,
    mutationCoordinator,
    mutationScopeKey,
    object,
    parametersTargetChanged,
    pendingOperations,
    refreshFailedAssignment,
    rebaseFailedAssignment,
    resetCreateDraft,
    retryFailedAssignment,
    scene,
    scopeKey,
    scopeToken,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
    updateAnisotropyDraft,
    updateCreateDraft,
    updateDraft,
  } = panel;
  useSyncExternalStore(
    absorbingBoundaryEditSessionStore.subscribe,
    absorbingBoundaryEditSessionStore.getVersion,
    () => 0,
  );
  const absorbingBoundarySession = absorbingBoundaryEditSessionStore.getCurrentSession();
  const absorbingBoundaryDraftDirty = absorbingBoundarySession?.dirty ?? false;
  const draftDirty = magneticParametersDraftDirty(draft, baseDraft);
  const parametersDirty = magneticParametersDraftDirty(
    { ...draft, materialRef: baseDraft.materialRef },
    baseDraft,
  );
  const anisotropyDirty = JSON.stringify(anisotropyDraft) !== JSON.stringify(baseAnisotropyDraft);
  const parametersValidation = buildMaterialParametersPatch(draft);
  const anisotropyValid = [
    anisotropyDraft.ku1,
    anisotropyDraft.axisX,
    anisotropyDraft.axisY,
    anisotropyDraft.axisZ,
  ].every((value) => Number.isFinite(Number(value)));
  const dirtyMaterialScopes: ObjectMaterialDraftScope[] = [
    ...(parametersTargetChanged ? ["assignment" as const] : []),
    ...(parametersDirty ? ["parameters" as const] : []),
    ...(anisotropyDirty ? ["anisotropy" as const] : []),
  ];
  const assignmentApplyAvailable =
    showSection("assignment") && object.mode === "committed";
  const availableMaterialApplyScopes = new Set<ObjectMaterialDraftScope>([
    ...(assignmentApplyAvailable ? ["assignment" as const] : []),
    ...(showSection("material-parameters") &&
    (materialData || (parametersTargetChanged && assignmentApplyAvailable))
      ? ["parameters" as const]
      : []),
    ...(showSection("uniaxial-anisotropy") && object.mode === "committed"
      ? ["anisotropy" as const]
      : []),
  ]);
  const materialApplyPolicy = resolveObjectMaterialDraftApplyPolicy(
    dirtyMaterialScopes,
    availableMaterialApplyScopes,
  );
  const createDraftApplyBlockReason = createDraftDirty
    ? !showSection("assignment")
      ? "This view hides Create and assign while its form has unsaved values. Use Revert here, or return to an assignment view and resolve other drafts before creating."
      : dirtyMaterialScopes.length > 0 || absorbingBoundaryDraftDirty
        ? `The new-material form and another object draft are both dirty. Resolve the other draft with its local Apply action, then use Create and assign; Revert is also available.${
            materialApplyPolicy.applyBlockReason
              ? ` ${materialApplyPolicy.applyBlockReason}`
              : ""
          }`
        : "The new-material form has unsaved values. Use Create and assign to save it, or Revert; global Apply does not create materials."
    : undefined;
  const assignmentFailureApplyBlockReason = assignmentFailure
    ? "A material was created but assignment is pending. Use Refresh scene, Rebase assignment, then Retry assignment, or Revert. Global Apply will not retry it."
    : undefined;
  const materialApplyBlockReason =
    createDraftApplyBlockReason ??
    assignmentFailureApplyBlockReason ??
    materialApplyPolicy.applyBlockReason;
  const applyInspectorDraft = useCallback(async () => {
    const activeMutation = mutationCoordinator.getActive(mutationScopeKey);
    if (activeMutation) {
      setFeedback({
        kind: "error",
        message: `${activeMutation.operation} is still saving. Wait for its acknowledgement before applying again.`,
      });
      return false;
    }
    if (createDraftDirty) {
      setFeedback({
        kind: "error",
        message: createDraftApplyBlockReason ?? "Use Create and assign to save the new material, or Revert.",
      });
      return false;
    }
    if (assignmentFailure) {
      setFeedback({
        kind: "error",
        message: assignmentFailureApplyBlockReason ?? "Refresh, rebase, and retry assignment, or Revert.",
      });
      return false;
    }
    if (materialApplyPolicy.directApplyFailureReason) {
      setFeedback({
        kind: "error",
        message: materialApplyPolicy.directApplyFailureReason,
      });
      return false;
    }
    if (parametersTargetChanged) {
      if (!(await applyMaterial({ recordHistory: false }))) return false;
      if (parametersDirty) {
        setFeedback({
          kind: "success",
          message: "Material assignment saved. Apply again after the assigned material loads to save its parameters.",
        });
        return false;
      }
    } else if (parametersDirty && !(await applyParameters({ recordHistory: false }))) {
      return false;
    }
    if (anisotropyDirty && !(await applyAnisotropy({ recordHistory: false }))) return false;
    return true;
  }, [
    anisotropyDirty,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    assignmentFailure,
    assignmentFailureApplyBlockReason,
    createDraftApplyBlockReason,
    createDraftDirty,
    materialApplyPolicy.directApplyFailureReason,
    mutationCoordinator,
    mutationScopeKey,
    parametersDirty,
    parametersTargetChanged,
    setFeedback,
  ]);
  const resetInspectorDraft = useCallback(() => {
    const activeMutation = mutationCoordinator.getActive(mutationScopeKey);
    if (activeMutation) {
      setFeedback({
        kind: "error",
        message: `${activeMutation.operation} is still saving. Wait for its acknowledgement before reverting.`,
      });
      return;
    }
    setDraftState(
      initialInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        identityKey: draftIdentityKey,
      }),
    );
    setAnisotropyDraftState({ draft: baseAnisotropyDraft, dirtyFields: new Set(), key: "", scopeKey, scopeToken });
    resetCreateDraft();
    setFeedback(null);
  }, [
    baseAnisotropyDraft,
    baseDraft,
    draftIdentityKey,
    draftKey,
    scopeKey,
    scopeToken,
    setAnisotropyDraftState,
    resetCreateDraft,
    mutationCoordinator,
    mutationScopeKey,
    setDraftState,
    setFeedback,
  ]);
  const { api, authoringHistory, commands } = useKernel();
  const materialEditSession: InspectorEditSession = {
    applyBlockReason: materialApplyBlockReason,
    apply: applyInspectorDraft,
    applying:
      mutationBusy ||
      pendingOperations.has("assignment") ||
      pendingOperations.has("parameters") ||
      pendingOperations.has("anisotropy"),
    dirty:
      draftDirty ||
      anisotropyDirty ||
      createDraftDirty ||
      assignmentFailure !== null ||
      mutationBusy,
    mode: "staged",
    reset: resetInspectorDraft,
    valid: !("error" in parametersValidation) && anisotropyValid,
  };
  const applyMaterialDraftWithHistory = async (): Promise<boolean> => {
    const sessionScopeKey = commands.getSessionScopeKey();
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrentSessionScope = () =>
      commands.getSessionScopeKey() === sessionScopeKey;
    const isCurrentHistoryGeneration = () =>
      historyGeneration === undefined ||
      authoringHistory?.getGeneration?.() === historyGeneration;
    return applyInspectorSessionWithHistory(
      materialEditSession,
      { model: { scene: (options) => api.model.scene(options) } },
      authoringHistory ?? null,
      "Inspector changes",
      {
        isCurrent: isCurrentSessionScope,
        isHistoryGenerationCurrent: isCurrentHistoryGeneration,
        requestOptions: sessionScopeKey ? { sessionScopeKey } : undefined,
      },
    );
  };
  const materialSessionWithHistory: InspectorEditSession = {
    ...materialEditSession,
    apply: applyMaterialDraftWithHistory,
  };
  return (
    <div className="fm-inspector-panel">
      <ObjectMaterialPanelEditSessionBridge
        absorbingBoundaryEditSessionStore={absorbingBoundaryEditSessionStore}
        materialSession={materialSessionWithHistory}
        mutationCoordinator={mutationCoordinator}
        mutationScopeKey={mutationScopeKey}
      />
      <div className="grid min-w-0 gap-fm-inspector-group">
          {showSection("parameters") ? (
            <InspectorGroup title="Magnetic Parameters" collapsible defaultOpen>
              <FieldRow label="Object ID" value={object.objectId} />
              <FieldRow label="Current material" value={object.material} />
              <FieldRow
                label="Material resource"
                value={materialData?.name ?? materialId ?? "unassigned"}
              />
              <FieldRow label="Mode" value={object.mode} />
              <FieldRow
                label="Scene revision"
                value={object.baseRevision === null ? "unknown" : String(object.baseRevision)}
              />
              <FieldRow label="Scene fetch" value={scene.status} />
              <FieldRow label="Material fetch" value={material.status} />
            </InspectorGroup>
          ) : null}

          {showSection("assignment") ? (
            <InspectorGroup title="Assignment">
              <FormField
                label="Material"
                type="select"
                value={draft.materialRef}
                onChange={(event) => updateDraft({ materialRef: event.target.value })}
              >
                <option value="">Unassigned</option>
                {scene.data?.materials?.map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.name} ({material.id})
                  </option>
                ))}
              </FormField>
              <FieldRow
                label="Selected"
                value={
                  scene.data?.materials?.find((material) => material.id === draft.materialRef)
                    ?.name ?? draft.materialRef ?? "unassigned"
                }
              />
            </InspectorGroup>
          ) : null}
          {showSection("assignment") ? (
            <InspectorGroup title="Create and Assign Material">
              <FormField
                label="New material name"
                mono={false}
                type="text"
                value={createDraft.name}
                onChange={(event) => updateCreateDraft({ name: event.target.value })}
              />
              <FormField
                label="New material ID"
                type="text"
                value={createDraft.materialId}
                onChange={(event) => updateCreateDraft({ materialId: event.target.value })}
              />
              <FormField
                label="New Ms"
                type="number"
                unit="A/m"
                value={createDraft.ms}
                onChange={(event) => updateCreateDraft({ ms: event.target.value })}
              />
              <FormField
                label="New A"
                type="number"
                unit="J/m"
                value={createDraft.aex}
                onChange={(event) => updateCreateDraft({ aex: event.target.value })}
              />
              <FormField
                label="New alpha"
                type="number"
                value={createDraft.alpha}
                onChange={(event) => updateCreateDraft({ alpha: event.target.value })}
              />
              <FormField
                label="New Ku1"
                hint="Optional interaction draft. It is not part of the material ACK and must be applied separately below."
                type="number"
                unit="J/m³"
                value={createDraft.ku1}
                onChange={(event) => updateCreateDraft({ ku1: event.target.value })}
              />
              <Vector3Field
                label="New anisotropy axis"
                disabled={!createDraft.ku1.trim()}
                values={[...createDraft.anisotropyAxis]}
                onChange={(index, value) => {
                  const axis = [...createDraft.anisotropyAxis] as [string, string, string];
                  axis[index] = value;
                  updateCreateDraft({ anisotropyAxis: axis });
                }}
              />
              <div className="fm-inspector-toolbar">
                <Button
                  disabled={
                    mutationBusy ||
                    pendingOperations.has("create-assign") ||
                    assignmentFailure !== null ||
                    object.mode !== "committed" ||
                    draftDirty ||
                    anisotropyDirty ||
                    absorbingBoundaryDraftDirty
                  }
                  size="sm"
                  type="button"
                  variant="primary"
                  onClick={() => void createAndAssignMaterial(absorbingBoundaryDraftDirty)}
                >
                  Create and assign
                </Button>
              </div>
              {assignmentFailure ? (
                <div className="fm-inspector-toolbar" data-material-assignment-conflict="true">
                  <Button
                    disabled={pendingOperations.has("retry-assign")}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => void refreshFailedAssignment()}
                  >
                    Refresh scene
                  </Button>
                  <Button
                    disabled={
                      pendingOperations.has("retry-assign") ||
                      scene.status !== "ready" ||
                      assignmentFailure.refreshPhase !== "ready" ||
                      (scene.data?.revision ?? 0) <= assignmentFailure.error.assignmentBaseRevision
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={rebaseFailedAssignment}
                  >
                    Rebase assignment
                  </Button>
                  <Button
                    disabled={pendingOperations.has("retry-assign") || assignmentFailure.rebasedRevision === null}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void retryFailedAssignment()}
                  >
                    Retry assignment
                  </Button>
                  {assignmentFailure.refreshError ? (
                    <FieldRow label="Refresh error" value={assignmentFailure.refreshError} />
                  ) : null}
                </div>
              ) : null}
            </InspectorGroup>
          ) : null}
      </div>

      <div className="grid min-w-0 gap-fm-inspector-group">
          {showSection("material-parameters") ? (
            <InspectorGroup title="Material Parameters">
              <FormField
                label="Name"
                mono={false}
                type="text"
                disabled={!materialData}
                value={draft.materialName}
                onChange={(event) => updateDraft({ materialName: event.target.value })}
              />
              <FormField
                label="Ms"
                type="number"
                unit="A/m"
                disabled={!materialData}
                value={draft.ms}
                onChange={(event) => updateDraft({ ms: event.target.value })}
              />
              <FormField
                label="Aex"
                type="number"
                unit="J/m"
                disabled={!materialData}
                value={draft.aex}
                onChange={(event) => updateDraft({ aex: event.target.value })}
              />
              <FormField
                label="alpha"
                type="number"
                disabled={!materialData}
                value={draft.alpha}
                onChange={(event) => updateDraft({ alpha: event.target.value })}
              />
              <FormField
                label="Dind"
                type="number"
                unit="J/m²"
                disabled={!materialData}
                value={draft.dind}
                onChange={(event) => updateDraft({ dind: event.target.value })}
              />
              <FormField
                label="Dbulk"
                type="number"
                unit="J/m²"
                disabled={!materialData}
                value={draft.dbulk}
                onChange={(event) => updateDraft({ dbulk: event.target.value })}
              />
            </InspectorGroup>
          ) : null}

          {showSection("absorbing-boundary") && object.mode === "committed" ? (
            <InspectorEditSessionProvider store={absorbingBoundaryEditSessionStore}>
              <ObjectAbsorbingBoundaryPanel
                objectId={object.objectId}
                baseRevision={object.baseRevision}
                mutationCoordinator={mutationCoordinator}
                mutationScopeKey={mutationScopeKey}
              />
            </InspectorEditSessionProvider>
          ) : null}

          {showSection("uniaxial-anisotropy") ? (
            <InspectorGroup title="Uniaxial Anisotropy">
              <FormField
                label="Present"
                type="checkbox"
                checked={anisotropyDraft.present}
                onChange={(event) =>
                  updateAnisotropyDraft({ present: (event.target as HTMLInputElement).checked })
                }
              />
              <FormField
                label="Ku1"
                type="number"
                unit="J/m³"
                disabled={!anisotropyDraft.present}
                value={anisotropyDraft.ku1}
                onChange={(event) => updateAnisotropyDraft({ ku1: event.target.value })}
              />
              <Vector3Field
                label="Axis"
                disabled={!anisotropyDraft.present}
                values={[anisotropyDraft.axisX, anisotropyDraft.axisY, anisotropyDraft.axisZ]}
                onChange={(index, value) => {
                  const fields = ["axisX", "axisY", "axisZ"] as const;
                  updateAnisotropyDraft({ [fields[index]]: value });
                }}
              />
            </InspectorGroup>
          ) : null}
      </div>

      <div className="grid min-w-0 gap-fm-inspector-group">
          {showSection("actions") ? (
            <InspectorGroup title="Actions">
              <div className="fm-inspector-toolbar">
                {showSection("assignment") ? (
                  <Button
                    disabled={mutationBusy || pendingOperations.has("assignment") || object.mode !== "committed"}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyMaterial()}
                  >
                    Apply Assignment
                  </Button>
                ) : null}
                {showSection("material-parameters") ? (
                  <Button
                    disabled={mutationBusy || pendingOperations.has("parameters") || !materialData || parametersTargetChanged}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyParameters()}
                  >
                    Apply Parameters
                  </Button>
                ) : null}
                {showSection("uniaxial-anisotropy") ? (
                  <Button
                    disabled={mutationBusy || pendingOperations.has("anisotropy") || object.mode !== "committed"}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyAnisotropy()}
                  >
                    Apply Anisotropy
                  </Button>
                ) : null}
              </div>
              {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
            </InspectorGroup>
          ) : null}
      </div>
    </div>
  );
}
