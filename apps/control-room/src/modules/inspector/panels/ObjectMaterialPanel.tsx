"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  prepareAuthoringMutation,
  recordAuthoringMutationHistory,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import type { SceneResource } from "@/kernel/api/apiTypes";
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
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
import { ObjectAbsorbingBoundaryPanel } from "./ObjectAbsorbingBoundaryPanel";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
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

interface PanelScope {
  key: string;
  token: symbol;
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

function useObjectMaterialPanelState(selection: InspectorPanelProps["selection"]) {
  const { api, authoringHistory, resources } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const scene = useSceneResource();
  const object = resolveGeometryObjectDraft(selection, scene.data);
  const sessionIdentityKey = sessionIdentity
    ? sessionResourceIdentityKey(sessionIdentity)
    : "session:unknown";
  const scopeKey = `${sessionIdentityKey}|${object.mode}|${object.objectId}`;
  const draftFieldRevisionsRef = useRef<Map<MagneticDraftField, number>>(new Map());
  const anisotropyFieldRevisionsRef = useRef<Map<AnisotropyField, number>>(new Map());
  const scopeRef = useRef<PanelScope>({ key: scopeKey, token: Symbol(scopeKey) });
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey, token: Symbol(scopeKey) };
    draftFieldRevisionsRef.current.clear();
    anisotropyFieldRevisionsRef.current.clear();
  }
  const scope = scopeRef.current;
  const isCurrentScope = useCallback(
    () => scopeRef.current.token === scope.token && scopeRef.current.key === scope.key,
    [scope],
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
  useEffect(() => {
    const current = assignmentBaseOverrideState;
    if (!current) return;
    const decision = acknowledgedAssignmentBaseDecision({
      override: current,
      currentSceneBaseKey,
      currentResourceBaseKey: resourceDraftKey,
      currentMaterialId: materialId,
      currentObjectId: object.objectId,
      currentSceneRevision,
      currentScopeKey: scopeKey,
      currentScopeToken: scope.token,
    });
    if (decision === "use") return;
    if (decision === "rebase") {
      if (!currentSceneBaseDraft || !currentSceneBaseKey || currentSceneRevision === null) return;
      setDraftState((state) => {
        if (state.identityKey !== current.identityKey) return state;
        const revisions = new Map(draftFieldRevisionsRef.current);
        const rebasedDraft = rebaseMagneticParametersDraftAfterAssignment({
          previousBaseDraft: current.baseDraft,
          draftAtStart: state.draft,
          currentDraft: state.draft,
          committedBaseDraft: currentSceneBaseDraft,
          startingRevisions: revisions,
          currentRevisions: revisions,
        });
        return {
          baseKey: currentSceneBaseKey,
          dirty: magneticParametersDraftDirty(rebasedDraft, currentSceneBaseDraft),
          draft: rebasedDraft,
          identityKey: current.identityKey,
        };
      });
      setAssignmentBaseOverrideState((state) => {
        if (state !== current) return state;
        if (resourceDraftKey === currentSceneBaseKey) return null;
        return {
          ...current,
          baseDraft: currentSceneBaseDraft,
          baseKey: currentSceneBaseKey,
          sceneRevision: currentSceneRevision,
        };
      });
      return;
    }
    setAssignmentBaseOverrideState((state) => state === current ? null : state);
  }, [
    assignmentBaseOverrideState,
    currentSceneBaseDraft,
    currentSceneBaseKey,
    currentSceneRevision,
    materialId,
    object.objectId,
    resourceDraftKey,
    scope,
    scopeKey,
  ]);
  const [draftState, setDraftState] = useState<
    InspectorDraftState<MagneticParametersDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey: draftKey,
      identityKey: draftIdentityKey,
    }),
  );
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
    draft: CreateMaterialDraft;
    objectId: string;
    scopeKey: string;
    scopeToken: symbol;
  }>(() => ({ draft: newMaterialDraft(object.name), objectId: object.objectId, scopeKey, scopeToken: scope.token }));
  const createDraft = createDraftState.scopeKey === scopeKey &&
    createDraftState.scopeToken === scope.token &&
    createDraftState.objectId === object.objectId
    ? createDraftState.draft
    : newMaterialDraft(object.name);
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
  const draftStateForResolution = useMemo(() => {
    if (assignmentBaseDecision !== "rebase" || !assignmentBaseOverrideState ||
      draftState.identityKey !== assignmentBaseOverrideState.identityKey) {
      return draftState;
    }
    const revisions = new Map(draftFieldRevisionsRef.current);
    const rebasedDraft = rebaseMagneticParametersDraftAfterAssignment({
      previousBaseDraft: assignmentBaseOverrideState.baseDraft,
      draftAtStart: draftState.draft,
      currentDraft: draftState.draft,
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
  }, [
    assignmentBaseDecision,
    assignmentBaseOverrideState,
    draftState,
    resourceBaseDraft,
    resourceDraftKey,
  ]);

  const { draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: magneticParametersDraftDirty,
    state: draftStateForResolution,
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
      anisotropyFieldRevisionsRef.current.set(
        field,
        (anisotropyFieldRevisionsRef.current.get(field) ?? 0) + 1,
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
    }
  }

  function updateDraft(patch: Partial<MagneticParametersDraft>): void {
    const fields = Object.keys(patch) as MagneticDraftField[];
    for (const field of fields) {
      draftFieldRevisionsRef.current.set(
        field,
        (draftFieldRevisionsRef.current.get(field) ?? 0) + 1,
      );
    }
    setDraftState((current) =>
      updateInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        currentDraft:
          current.identityKey === draftIdentityKey ? draftStateForResolution.draft : baseDraft,
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
    const committedSnapshot = acknowledgedScenes
      .map((acknowledgedScene) => {
        const material = magneticParameterMaterialResourceFromSceneResource(materialId, acknowledgedScene);
        return {
          object: resolveGeometryObjectDraft(selection, acknowledgedScene),
          material,
          draft: material ? magneticParametersDraftFromResource(materialId, material) : null,
          sceneRevision: sceneResourceRevision(acknowledgedScene),
        };
      })
      .find(({ object: acknowledgedObject, draft }) =>
        draft !== null &&
        acknowledgedObject.mode === "committed" &&
        acknowledgedObject.objectId === object.objectId &&
        normalizeMaterialRef(acknowledgedObject.material) === materialId,
      );
    if (!committedSnapshot?.draft || !committedSnapshot.material) return false;
    const {
      draft: committedBaseDraft,
      object: acknowledgedObject,
      material: acknowledgedMaterial,
      sceneRevision: acknowledgedSceneRevision,
    } = committedSnapshot;
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
        currentRevisions: draftFieldRevisionsRef.current,
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
    }
  }

  async function applyParameters({
    recordHistory = true,
  }: ApplyMaterialMutationOptions = {}): Promise<boolean> {
    if (!materialId || !material.data) {
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
    }
  }

  function invalidateMagneticParameterResources(revision: number): void {
    invalidateAuthoringMutationDependents(resources, "material", revision);
  }

  function updateCreateDraft(patch: Partial<CreateMaterialDraft>): void {
    setCreateDraftState((current) => ({
      draft: {
        ...(current.scopeToken === scope.token && current.objectId === object.objectId
          ? current.draft
          : newMaterialDraft(object.name)),
        ...patch,
      },
      objectId: object.objectId,
      scopeKey,
      scopeToken: scope.token,
    }));
    setFeedback(null);
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

  async function createAndAssignMaterial(): Promise<void> {
    const operationScope = scope;
    const operationSessionScopeKey = sessionScopeKey;
    if (!object.objectId || object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object with a known revision." });
      return;
    }
    const previousBaseDraft = baseDraft;
    const draftAtStart = draft;
    const identityKeyAtStart = draftIdentityKey;
    const startingDraftRevisions = new Map(draftFieldRevisionsRef.current);
    const historyContext = {
      api,
      authoringHistory,
      sessionScopeKey: operationSessionScopeKey,
    };
    const preparation = await prepareAuthoringMutation(historyContext);
    const baseRevision = preparation.baseRevision ?? object.baseRevision;
    if (baseRevision === null) {
      setFeedback({ kind: "error", message: "No committed scene object with a known revision." });
      return;
    }
    const validation = buildCreateMaterialDraft(createDraft);
    if ("error" in validation) {
      setFeedback({ kind: "error", message: validation.error });
      return;
    }
    const transactionId = ++draftTransactionRevisionRef.current;
    startPending("create-assign", operationScope);
    setAssignmentFailureState((current) =>
      current?.scopeToken === operationScope.token ? null : current,
    );
    try {
      const result = await createMaterialThenAssign(
        api,
        object.objectId,
        createDraft,
        baseRevision,
        (created) => {
          if (!isCurrentScope()) return;
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
      await recordAuthoringMutationHistory(
        historyContext,
        "Create and assign material",
        preparation,
        result.assigned,
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
        kind: draftRebased ? "success" : "error",
        message: draftRebased
          ? result.deferredAnisotropy
            ? "Material created and assigned. Ku1 draft is ready; apply anisotropy separately."
            : "Material created and assigned."
          : "Material was created and assigned, but its committed parameter values could not be confirmed in the returned scene.",
      });
    } catch (error) {
      if (error instanceof MaterialAssignmentAfterCreateError) {
        await recordAuthoringMutationHistory(
          historyContext,
          "Create material (assignment pending)",
          preparation,
          error.created.committed_scene,
        );
      }
      if (!isCurrentScope()) return;
      if (error instanceof MaterialAssignmentAfterCreateError) {
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
          message: "Material was created and remains in the library, but assignment failed. Refresh and explicitly rebase before retrying assignment.",
        });
      } else {
        setFeedback({ kind: "error", message: errorMessage(error) });
      }
    } finally {
      finishPending("create-assign", operationScope);
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
    const startingDraftRevisions = new Map(draftFieldRevisionsRef.current);
    startPending("retry-assign", operationScope);
    try {
      const assigned = await runAuthoringMutationWithHistory(
        {
          api,
          authoringHistory,
          sessionScopeKey: operationSessionScopeKey,
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
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialId,
    object,
    parametersTargetChanged,
    pendingOperations,
    refreshFailedAssignment,
    rebaseFailedAssignment,
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
  const panel = useObjectMaterialPanelState(selection);
  const sections = materialInspectorSections(selection.kind);
  const showSection = (section: string) => sections.includes(section);
  return <ObjectMaterialPanelView panel={panel} showSection={showSection} />;
}

function ObjectMaterialPanelView({
  panel,
  showSection,
}: {
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
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialId,
    object,
    parametersTargetChanged,
    pendingOperations,
    refreshFailedAssignment,
    rebaseFailedAssignment,
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
  const applyInspectorDraft = useCallback(async () => {
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
    parametersDirty,
    parametersTargetChanged,
    setFeedback,
  ]);
  const resetInspectorDraft = useCallback(() => {
    setDraftState(
      initialInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        identityKey: draftIdentityKey,
      }),
    );
    setAnisotropyDraftState({ draft: baseAnisotropyDraft, dirtyFields: new Set(), key: "", scopeKey, scopeToken });
    setFeedback(null);
  }, [
    baseAnisotropyDraft,
    baseDraft,
    draftIdentityKey,
    draftKey,
    scopeKey,
    scopeToken,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
  ]);
  useRegisterInspectorEditSession(
    "staged",
    pendingOperations.has("assignment") ||
      pendingOperations.has("parameters") ||
      pendingOperations.has("anisotropy"),
    draftDirty || anisotropyDirty,
    !("error" in parametersValidation) && anisotropyValid,
    undefined,
    applyInspectorDraft,
    resetInspectorDraft,
  );
  return (
    <div className="fm-inspector-panel">
      <div className="grid min-w-0 gap-fm-inspector-group">
          {showSection("parameters") ? (
            <InspectorGroup title="Magnetic Parameters" collapsible defaultOpen>
              <FieldRow label="Object ID" value={object.objectId} />
              <FieldRow label="Current material" value={object.material} />
              <FieldRow
                label="Material resource"
                value={material.data?.name ?? materialId ?? "unassigned"}
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
                    pendingOperations.has("create-assign") ||
                    assignmentFailure !== null ||
                    object.mode !== "committed"
                  }
                  size="sm"
                  type="button"
                  variant="primary"
                  onClick={() => void createAndAssignMaterial()}
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
                disabled={!material.data}
                value={draft.materialName}
                onChange={(event) => updateDraft({ materialName: event.target.value })}
              />
              <FormField
                label="Ms"
                type="number"
                unit="A/m"
                disabled={!material.data}
                value={draft.ms}
                onChange={(event) => updateDraft({ ms: event.target.value })}
              />
              <FormField
                label="Aex"
                type="number"
                unit="J/m"
                disabled={!material.data}
                value={draft.aex}
                onChange={(event) => updateDraft({ aex: event.target.value })}
              />
              <FormField
                label="alpha"
                type="number"
                disabled={!material.data}
                value={draft.alpha}
                onChange={(event) => updateDraft({ alpha: event.target.value })}
              />
              <FormField
                label="Dind"
                type="number"
                unit="J/m²"
                disabled={!material.data}
                value={draft.dind}
                onChange={(event) => updateDraft({ dind: event.target.value })}
              />
              <FormField
                label="Dbulk"
                type="number"
                unit="J/m²"
                disabled={!material.data}
                value={draft.dbulk}
                onChange={(event) => updateDraft({ dbulk: event.target.value })}
              />
            </InspectorGroup>
          ) : null}

          {showSection("absorbing-boundary") && object.mode === "committed" ? (
            <ObjectAbsorbingBoundaryPanel
              objectId={object.objectId}
              baseRevision={object.baseRevision}
            />
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
                    disabled={pendingOperations.has("assignment") || object.mode !== "committed"}
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
                    disabled={pendingOperations.has("parameters") || !material.data || parametersTargetChanged}
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
                    disabled={pendingOperations.has("anisotropy") || object.mode !== "committed"}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyAnisotropy()}
                  >
                    Apply Anisotropy
                  </Button>
                ) : null}
                <Button
                  disabled={
                    pendingOperations.has("assignment") ||
                    pendingOperations.has("parameters") ||
                    pendingOperations.has("anisotropy")
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setDraftState(
                      initialInspectorDraftState({
                        baseDraft,
                        baseKey: draftKey,
                        identityKey: draftIdentityKey,
                      }),
                    );
                    setAnisotropyDraftState({ draft: baseAnisotropyDraft, dirtyFields: new Set(), key: "", scopeKey, scopeToken });
                    setFeedback(null);
                  }}
                >
                  Revert
                </Button>
              </div>
              {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
            </InspectorGroup>
          ) : null}
      </div>
    </div>
  );
}
