import { MODEL_PHYSICS_GRAPH_PATH } from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionResponse,
  JsonObject,
  JsonValue,
  MaterialPropertiesResource,
  MaterialReferenceResource,
  ObjectInteractionKind,
  SceneMaterialSource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { authoringWriteOptions } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import {
  publishCommittedSceneResource,
  resolveMaterialResourceKey,
  resolveObjectInteractionResourceKey,
} from "@/kernel/resources/geometryLifecycleResources";
import type { KernelApi } from "@/kernel/types";

import { fallbackRevision, normalizeVector3 } from "../../../panels/model-roots/SpecInspectorHost";
import {
  buildMaterialAssignmentPatch,
  MaterialAssignmentAfterCreateError,
} from "../../../panels/ObjectMaterialPanelModel";
import {
  buildConstitutiveMergePatch,
  buildUniaxialInteractionPayload,
  errorMessage,
  orthogonalizeAxisGramSchmidt,
  resolveMaterialPropertiesFromDraft,
  suggestNewMaterialId,
  type UnifiedObjectMaterialDraft,
} from "./materialShared";

export interface PendingPhysicsActivation {
  readonly id:
    | "exchange"
    | "uniaxial_anisotropy"
    | "cubic_anisotropy"
    | "interfacial_dmi"
    | "bulk_dmi"
    | "study.demag_enabled"
    | "study.exchange_enabled";
  readonly label: string;
  readonly scope: "object" | "study";
}

export interface PhysicsActivationError {
  readonly module: string;
  readonly label: string;
  readonly message: string;
}

function asJsonObject(value: unknown): JsonObject | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function cloneJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function readCommittedPhysicsStackState(
  scene: SceneResource | null | undefined,
  objectId: string,
): Map<string, boolean> {
  const state = new Map<string, boolean>();
  const stack = scene?.objects?.find((o) => o.id === objectId)?.physics_stack;
  if (!Array.isArray(stack)) return state;
  for (const entry of stack) {
    if (!entry || typeof entry !== "object") continue;
    const kind = typeof entry.kind === "string" ? entry.kind.trim().toLowerCase() : "";
    if (kind) state.set(kind, entry.enabled !== false);
  }
  return state;
}

function readCommittedStudyPhysicsFlags(scene: SceneResource | null | undefined): {
  demagEnabled?: boolean;
  exchangeEnabled?: boolean;
} {
  const study = scene?.study;
  return {
    demagEnabled: typeof study?.demag_enabled === "boolean" ? study.demag_enabled : undefined,
    exchangeEnabled:
      typeof study?.exchange_enabled === "boolean" ? study.exchange_enabled : undefined,
  };
}

function upsertPhysicsStackEntry(
  stack: readonly Record<string, unknown>[],
  kind: ObjectInteractionKind,
  entry: { enabled: boolean; params: Record<string, unknown> } | null,
): Record<string, unknown>[] {
  const normalizedKind = kind.toLowerCase();
  const nextStack = stack.map((item) => ({ ...item }));
  const existingIndex = nextStack.findIndex(
    (item) => typeof item.kind === "string" && item.kind.trim().toLowerCase() === normalizedKind,
  );
  if (entry === null) {
    if (existingIndex >= 0) nextStack.splice(existingIndex, 1);
    return nextStack;
  }
  const updated: Record<string, unknown> = {
    ...(existingIndex >= 0 ? nextStack[existingIndex] : {}),
    kind,
    enabled: entry.enabled,
    params: entry.params,
  };
  if (existingIndex >= 0) {
    nextStack[existingIndex] = updated;
  } else {
    nextStack.push(updated);
  }
  return nextStack;
}

function readExistingInteractionParams(
  stack: readonly Record<string, unknown>[],
  kind: ObjectInteractionKind,
): Record<string, unknown> {
  const normalizedKind = kind.toLowerCase();
  const existing = stack.find(
    (item) => typeof item.kind === "string" && item.kind.trim().toLowerCase() === normalizedKind,
  );
  return existing?.params && typeof existing.params === "object" && !Array.isArray(existing.params)
    ? { ...(existing.params as Record<string, unknown>) }
    : {};
}

function syncDmiParamsOnPhysicsStack(
  stack: readonly Record<string, unknown>[],
  dind: number | null | undefined,
  dbulk: number | null | undefined,
): { stack: Record<string, unknown>[]; changed: boolean } {
  let changed = false;
  const nextStack = stack.map((item) => {
    const kind = typeof item.kind === "string" ? item.kind.trim().toLowerCase() : "";
    if (kind !== "interfacial_dmi" && kind !== "bulk_dmi") return { ...item };
    const key = kind === "interfacial_dmi" ? "dind" : "dbulk";
    const nextCoeff = (kind === "interfacial_dmi" ? dind : dbulk) ?? 0;
    const prevParams =
      item.params && typeof item.params === "object" && !Array.isArray(item.params)
        ? (item.params as Record<string, unknown>)
        : {};
    if (prevParams[key] === nextCoeff) return { ...item };
    changed = true;
    return { ...item, params: { ...prevParams, [key]: nextCoeff } };
  });
  return { stack: nextStack, changed };
}

function computeAnisotropySyncPlan(
  draft: UnifiedObjectMaterialDraft,
  prev: UnifiedObjectMaterialDraft,
  committedStackState: ReadonlyMap<string, boolean>,
) {
  const effectiveUniaxialEnabled = draft.activateRequiredPhysics
    ? draft.uniaxialEnabled || Math.abs(draft.ku1) > 0 || Math.abs(draft.ku2) > 0
    : draft.uniaxialEnabled;
  const effectiveUniaxialDraft =
    effectiveUniaxialEnabled !== draft.uniaxialEnabled
      ? { ...draft, uniaxialEnabled: effectiveUniaxialEnabled }
      : draft;
  const uniaxialChanged =
    draft.isMagneticBody &&
    (effectiveUniaxialDraft.uniaxialEnabled !== prev.uniaxialEnabled ||
      (draft.activateRequiredPhysics &&
        effectiveUniaxialEnabled &&
        committedStackState.get("uniaxial_anisotropy") !== true) ||
      draft.ku1 !== prev.ku1 ||
      draft.ku2 !== prev.ku2 ||
      JSON.stringify(draft.uniaxialAxis) !== JSON.stringify(prev.uniaxialAxis));

  const effectiveCubicEnabled = draft.activateRequiredPhysics
    ? draft.cubicEnabled ||
      Math.abs(draft.kc1) > 0 ||
      Math.abs(draft.kc2) > 0 ||
      Math.abs(draft.kc3) > 0
    : draft.cubicEnabled;
  const cubicChanged =
    draft.isMagneticBody &&
    (effectiveCubicEnabled !== prev.cubicEnabled ||
      (draft.activateRequiredPhysics &&
        effectiveCubicEnabled &&
        committedStackState.get("cubic_anisotropy") !== true) ||
      draft.kc1 !== prev.kc1 ||
      draft.kc2 !== prev.kc2 ||
      draft.kc3 !== prev.kc3 ||
      JSON.stringify(draft.cubicAxis1) !== JSON.stringify(prev.cubicAxis1) ||
      JSON.stringify(draft.cubicAxis2) !== JSON.stringify(prev.cubicAxis2));

  return {
    effectiveUniaxialDraft,
    uniaxialChanged,
    effectiveCubicEnabled,
    cubicChanged,
  };
}

function buildCubicInteractionPayload(
  draft: UnifiedObjectMaterialDraft,
  effectiveCubicEnabled: boolean,
) {
  const axis1 = normalizeVector3(draft.cubicAxis1, [1, 0, 0]);
  const axis2 = orthogonalizeAxisGramSchmidt(axis1, draft.cubicAxis2);
  const present =
    effectiveCubicEnabled ||
    Math.abs(draft.kc1) > 0 ||
    Math.abs(draft.kc2) > 0 ||
    Math.abs(draft.kc3) > 0;
  return {
    enabled: effectiveCubicEnabled,
    present,
    params: { kc1: draft.kc1, kc2: draft.kc2, kc3: draft.kc3, axis1, axis2 },
  };
}

function publishScene(
  resources: KernelApi["resources"],
  scene: SceneResource,
  rev: number | string | null | undefined,
  sessionScopeKey: string | null,
) {
  publishCommittedSceneResource(resources, scene, fallbackRevision(rev), undefined, true, sessionScopeKey);
}

function invalidateMaterialCommitResources(
  resources: KernelApi["resources"],
  objectId: string,
  rev: ReturnType<typeof fallbackRevision>,
  materialTouched: boolean,
  interactionTouched: boolean,
  invalidatedMaterialIds: ReadonlySet<string>,
  invalidatedInteractionKinds: ReadonlySet<ObjectInteractionKind>,
) {
  if (materialTouched) {
    invalidateAuthoringMutationDependents(resources, "material", rev);
    for (const matId of invalidatedMaterialIds) {
      resources.invalidate(resolveMaterialResourceKey(matId), rev);
    }
  }
  if (interactionTouched) {
    invalidateAuthoringMutationDependents(resources, "interaction", rev);
    for (const kind of invalidatedInteractionKinds) {
      resources.invalidate(resolveObjectInteractionResourceKey(objectId, kind), rev);
    }
  }
  if (materialTouched || interactionTouched) {
    resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
  }
}

/**
 * Pure summary of physics modules that will be enabled on Apply when the user
 * explicitly opts in via `draft.activateRequiredPhysics` (ADR 0086).
 */
export function computePendingPhysicsActivations(
  draft: UnifiedObjectMaterialDraft,
  scene: SceneResource | null | undefined,
): readonly PendingPhysicsActivation[] {
  if (!draft.isMagneticBody) return [];
  if (!draft.materialId && !draft.pendingNewMaterial && !draft.msSet && !draft.aexSet) {
    return [];
  }
  const stackState = readCommittedPhysicsStackState(scene, draft.objectId);
  const studyFlags = readCommittedStudyPhysicsFlags(scene);
  const pending: PendingPhysicsActivation[] = [];

  if (draft.aexSet && draft.aex > 0 && stackState.get("exchange") !== true) {
    pending.push({ id: "exchange", label: "Exchange", scope: "object" });
  }
  if (
    (draft.uniaxialEnabled || Math.abs(draft.ku1) > 0 || Math.abs(draft.ku2) > 0) &&
    stackState.get("uniaxial_anisotropy") !== true
  ) {
    pending.push({ id: "uniaxial_anisotropy", label: "Uniaxial anisotropy", scope: "object" });
  }
  if (
    (draft.cubicEnabled ||
      Math.abs(draft.kc1) > 0 ||
      Math.abs(draft.kc2) > 0 ||
      Math.abs(draft.kc3) > 0) &&
    stackState.get("cubic_anisotropy") !== true
  ) {
    pending.push({ id: "cubic_anisotropy", label: "Cubic anisotropy", scope: "object" });
  }
  if (draft.dindSet && draft.dind !== 0 && stackState.get("interfacial_dmi") !== true) {
    pending.push({ id: "interfacial_dmi", label: "Interfacial DMI", scope: "object" });
  }
  if (draft.dbulkSet && draft.dbulk !== 0 && stackState.get("bulk_dmi") !== true) {
    pending.push({ id: "bulk_dmi", label: "Bulk DMI", scope: "object" });
  }
  if (draft.msSet && draft.ms > 0 && studyFlags.demagEnabled === false) {
    pending.push({ id: "study.demag_enabled", label: "Demag", scope: "study" });
  }
  if (draft.aexSet && draft.aex > 0 && studyFlags.exchangeEnabled === false) {
    pending.push({ id: "study.exchange_enabled", label: "Exchange (study)", scope: "study" });
  }
  return pending;
}

export interface MaterialPhysicsSyncParams {
  readonly objectId: string;
  readonly draft: UnifiedObjectMaterialDraft;
  readonly prev: UnifiedObjectMaterialDraft;
  readonly sceneData: SceneResource | null | undefined;
  readonly studyFlagsAlreadyCommitted?: boolean;
  readonly latestRevision: number | null;
  readonly latestCommittedScene: SceneResource | null;
  readonly sessionScopeKey: string | null;
  readonly requestScopeOptions: { sessionScopeKey: string } | undefined;
  readonly api: KernelApi["api"];
  readonly resources: KernelApi["resources"];
}

export interface MaterialPhysicsSyncResult {
  readonly latestRevision: number | null;
  readonly latestCommittedScene: SceneResource | null;
  readonly interactionTouched: boolean;
  readonly activationErrors: readonly PhysicsActivationError[];
}

/**
 * Synchronizes explicit uniaxial & cubic anisotropy edits and — ONLY when the
 * user explicitly opts in via `draft.activateRequiredPhysics` (ADR 0086) —
 * enables required canonical physics interactions. Used when only a single
 * interaction patch is needed or as fallback when `commitTransaction` is absent.
 */
export async function syncMaterialPhysicsAutoActivation(
  params: MaterialPhysicsSyncParams,
): Promise<MaterialPhysicsSyncResult> {
  const {
    objectId,
    draft,
    prev,
    sceneData,
    studyFlagsAlreadyCommitted = false,
    sessionScopeKey,
    requestScopeOptions,
    api,
    resources,
  } = params;
  let { latestRevision, latestCommittedScene } = params;
  let interactionTouched = false;
  const activationErrors: PhysicsActivationError[] = [];

  const committedStackState = readCommittedPhysicsStackState(
    latestCommittedScene ?? sceneData,
    objectId,
  );
  const { effectiveUniaxialDraft, uniaxialChanged, effectiveCubicEnabled, cubicChanged } =
    computeAnisotropySyncPlan(draft, prev, committedStackState);

  if (uniaxialChanged) {
    const payload = buildUniaxialInteractionPayload(effectiveUniaxialDraft);
    const ack = await api.model.patchObjectInteraction(
      objectId,
      "uniaxial_anisotropy",
      { base_revision: latestRevision, ...payload },
      requestScopeOptions,
    );
    latestRevision = ack.scene_revision;
    interactionTouched = true;
    resources.invalidate(
      resolveObjectInteractionResourceKey(objectId, "uniaxial_anisotropy"),
      fallbackRevision(latestRevision),
    );
  }

  if (cubicChanged) {
    const payload = buildCubicInteractionPayload(draft, effectiveCubicEnabled);
    const ack = await api.model.patchObjectInteraction(
      objectId,
      "cubic_anisotropy",
      { base_revision: latestRevision, ...payload },
      requestScopeOptions,
    );
    latestRevision = ack.scene_revision;
    interactionTouched = true;
    resources.invalidate(
      resolveObjectInteractionResourceKey(objectId, "cubic_anisotropy"),
      fallbackRevision(latestRevision),
    );
  }

  if (
    draft.activateRequiredPhysics &&
    draft.isMagneticBody &&
    typeof api.model.patchObjectInteraction === "function"
  ) {
    const optInKinds: ReadonlyArray<{
      kind: ObjectInteractionKind;
      label: string;
      condition: boolean;
    }> = [
      { kind: "exchange", label: "Exchange", condition: draft.aexSet && draft.aex > 0 },
      { kind: "interfacial_dmi", label: "Interfacial DMI", condition: draft.dindSet && draft.dind !== 0 },
      { kind: "bulk_dmi", label: "Bulk DMI", condition: draft.dbulkSet && draft.dbulk !== 0 },
    ];
    for (const { kind, label, condition } of optInKinds) {
      if (!condition || committedStackState.get(kind) === true) continue;
      try {
        const ack = await api.model.patchObjectInteraction(
          objectId,
          kind,
          { base_revision: latestRevision, enabled: true, present: true, params: {} },
          requestScopeOptions,
        );
        latestRevision = ack.scene_revision;
        interactionTouched = true;
        resources.invalidate(
          resolveObjectInteractionResourceKey(objectId, kind),
          fallbackRevision(latestRevision),
        );
      } catch (error) {
        activationErrors.push({ module: kind, label, message: errorMessage(error) });
      }
    }

    if (!studyFlagsAlreadyCommitted) {
      const studyFlags = readCommittedStudyPhysicsFlags(latestCommittedScene ?? sceneData);
      const enableDemag = draft.msSet && draft.ms > 0 && studyFlags.demagEnabled === false;
      const enableExchange = draft.aexSet && draft.aex > 0 && studyFlags.exchangeEnabled === false;
      if ((enableDemag || enableExchange) && typeof api.model.commitTransaction === "function") {
        try {
          const studyTx = await api.model.commitTransaction(
            {
              ...(latestRevision !== null ? { base_revision: latestRevision } : {}),
              kind: "merge_patch",
              merge_patch: {
                study: {
                  ...(enableDemag ? { demag_enabled: true } : {}),
                  ...(enableExchange ? { exchange_enabled: true } : {}),
                },
              },
            },
            requestScopeOptions,
          );
          latestRevision = studyTx.scene_revision;
          latestCommittedScene = studyTx.committed_scene;
          interactionTouched = true;
          publishScene(resources, studyTx.committed_scene, studyTx.scene_revision, sessionScopeKey);
        } catch (error) {
          const labels = [
            ...(enableDemag ? ["Demag"] : []),
            ...(enableExchange ? ["Exchange (study)"] : []),
          ];
          activationErrors.push({
            module: "study.physics_flags",
            label: labels.join(" & "),
            message: errorMessage(error),
          });
        }
      }
    }
  }

  return { latestRevision, latestCommittedScene, interactionTouched, activationErrors };
}

/**
 * Builds a single atomic `merge_patch` consolidating Duplicate & Unlink
 * (cloned material creation with source/references provenance + object assignment
 * + constitutive study metadata) into one scene revision.
 */
export function buildAtomicDuplicateAndUnlinkMergePatch(
  sceneData: SceneResource,
  objectId: string,
  clonedAsset: {
    readonly materialId: string;
    readonly name: string;
    readonly properties: MaterialPropertiesResource;
    readonly references: readonly MaterialReferenceResource[];
    readonly source: SceneMaterialSource | null;
  },
  draft: UnifiedObjectMaterialDraft,
): JsonObject {
  const nextMaterials = [
    ...(sceneData.materials ?? []),
    {
      id: clonedAsset.materialId,
      name: clonedAsset.name,
      properties: clonedAsset.properties,
      references: clonedAsset.references,
      ...(clonedAsset.source ? { source: clonedAsset.source } : {}),
    },
  ];
  const nextObjects = (sceneData.objects ?? []).map((obj) =>
    obj.id === objectId ? { ...obj, material_ref: clonedAsset.materialId } : obj,
  );
  return {
    ...buildConstitutiveMergePatch(clonedAsset.materialId, draft),
    materials: cloneJsonValue(nextMaterials),
    objects: cloneJsonValue(nextObjects),
  };
}

export interface CommitObjectMaterialDraftParams {
  readonly objectId: string;
  readonly draft: UnifiedObjectMaterialDraft;
  readonly prev: UnifiedObjectMaterialDraft;
  readonly baseRevision: number | null;
  readonly sceneData: SceneResource | null | undefined;
  readonly existingMaterialIds: ReadonlySet<string>;
  readonly sessionScopeKey: string | null;
  readonly requestScopeOptions: { sessionScopeKey: string } | undefined;
  readonly api: KernelApi["api"];
  readonly resources: KernelApi["resources"];
}

/**
 * Commits all material, assignment, constitutive, anisotropy, and explicit
 * opt-in physics activation changes (ADR 0086).
 *
 * Consolidates compound or study-level material edits (`materials`, `objects`,
 * `physics_stack`, `study`, `current_transports`) into a **single atomic
 * `commitTransaction` (`merge_patch`)** so the scene advances by one revision
 * with all-or-nothing failure safety (M8).
 */
export async function commitObjectMaterialDraft({
  objectId,
  draft,
  prev,
  baseRevision,
  sceneData,
  existingMaterialIds,
  sessionScopeKey,
  requestScopeOptions,
  api,
  resources,
}: CommitObjectMaterialDraftParams): Promise<{
  committed_scene: SceneResource | null;
  scene_revision: number | null;
  activationErrors: readonly PhysicsActivationError[];
}> {
  let latestRevision = baseRevision ?? sceneData?.revision ?? null;
  let latestCommittedScene: SceneResource | null = null;
  const invalidatedMaterialIds = new Set<string>();
  const invalidatedInteractionKinds = new Set<ObjectInteractionKind>();
  if (prev.materialId) invalidatedMaterialIds.add(prev.materialId);

  const isExplicitUnassign =
    !draft.materialId && !draft.pendingNewMaterial && Boolean(prev.materialId);
  const propertiesPayload = resolveMaterialPropertiesFromDraft(draft, prev);
  const prevProperties = resolveMaterialPropertiesFromDraft(prev, prev);
  const shouldCreateNewMaterial =
    !isExplicitUnassign &&
    (!draft.materialId || draft.pendingNewMaterial || !existingMaterialIds.has(draft.materialId));

  let resolvedMatId: string | null = isExplicitUnassign ? null : draft.materialId;
  if (shouldCreateNewMaterial) {
    resolvedMatId =
      draft.newMaterialId.trim() ||
      resolvedMatId?.trim() ||
      suggestNewMaterialId(`mat-${objectId}`, existingMaterialIds);
  }
  if (resolvedMatId) invalidatedMaterialIds.add(resolvedMatId);

  const materialReassigned =
    !isExplicitUnassign &&
    !shouldCreateNewMaterial &&
    Boolean(resolvedMatId) &&
    resolvedMatId !== prev.materialId;

  const constantsChanged =
    !isExplicitUnassign &&
    !shouldCreateNewMaterial &&
    Boolean(resolvedMatId) &&
    (draft.materialName !== prev.materialName ||
      propertiesPayload.Ms !== prevProperties.Ms ||
      propertiesPayload.Aex !== prevProperties.Aex ||
      propertiesPayload.alpha !== prevProperties.alpha ||
      propertiesPayload.Dind !== prevProperties.Dind ||
      propertiesPayload.Dbulk !== prevProperties.Dbulk);

  const constitutiveChanged =
    !isExplicitUnassign &&
    (draft.gamma !== prev.gamma ||
      draft.landeG !== prev.landeG ||
      draft.sigma !== prev.sigma ||
      draft.density !== prev.density ||
      draft.magnetoelasticEnabled !== prev.magnetoelasticEnabled ||
      draft.b1 !== prev.b1 ||
      draft.b2 !== prev.b2 ||
      draft.c11 !== prev.c11 ||
      draft.c12 !== prev.c12 ||
      draft.c44 !== prev.c44);
  const needsConstitutivePatch =
    !isExplicitUnassign &&
    (constitutiveChanged || (shouldCreateNewMaterial && draft.magnetoelasticEnabled));

  const committedStackState = readCommittedPhysicsStackState(sceneData, objectId);
  const { effectiveUniaxialDraft, uniaxialChanged, effectiveCubicEnabled, cubicChanged } =
    computeAnisotropySyncPlan(draft, prev, committedStackState);

  const optInObjectInteractions: ObjectInteractionKind[] = [];
  let enableDemag = false;
  let enableExchange = false;
  if (draft.activateRequiredPhysics && draft.isMagneticBody) {
    if (draft.aexSet && draft.aex > 0 && committedStackState.get("exchange") !== true) {
      optInObjectInteractions.push("exchange");
    }
    if (draft.dindSet && draft.dind !== 0 && committedStackState.get("interfacial_dmi") !== true) {
      optInObjectInteractions.push("interfacial_dmi");
    }
    if (draft.dbulkSet && draft.dbulk !== 0 && committedStackState.get("bulk_dmi") !== true) {
      optInObjectInteractions.push("bulk_dmi");
    }
    const studyFlags = readCommittedStudyPhysicsFlags(sceneData);
    enableDemag = draft.msSet && draft.ms > 0 && studyFlags.demagEnabled === false;
    enableExchange = draft.aexSet && draft.aex > 0 && studyFlags.exchangeEnabled === false;
  }

  const hasStudyStep = needsConstitutivePatch || enableDemag || enableExchange;
  const totalMutationSteps =
    (isExplicitUnassign ? 1 : 0) +
    (shouldCreateNewMaterial ? (draft.isMagneticBody ? 1 : 2) : 0) +
    (materialReassigned ? 1 : 0) +
    (constantsChanged ? 1 : 0) +
    (hasStudyStep ? 1 : 0) +
    (uniaxialChanged ? 1 : 0) +
    (cubicChanged ? 1 : 0) +
    optInObjectInteractions.length;

  const canCommitAtomically =
    typeof api.model.commitTransaction === "function" &&
    Boolean(sceneData?.objects?.some((o) => o.id === objectId));

  // M8: Single atomic commitTransaction(merge_patch) for compound or study-level applies.
  if (canCommitAtomically && (totalMutationSteps > 1 || hasStudyStep) && sceneData) {
    const mergePatch: JsonObject = {};
    let materialTouched = false;
    let interactionTouched = false;

    if (shouldCreateNewMaterial && resolvedMatId) {
      const createdName = draft.materialName.trim() || `Material (${draft.objectName})`;
      mergePatch.materials = cloneJsonValue([
        ...(sceneData.materials ?? []),
        { id: resolvedMatId, name: createdName, properties: propertiesPayload, references: [] },
      ]);
      materialTouched = true;
    } else if (constantsChanged && resolvedMatId) {
      mergePatch.materials = cloneJsonValue(
        (sceneData.materials ?? []).map((mat) =>
          mat.id === resolvedMatId
            ? { ...mat, name: draft.materialName.trim(), properties: { ...mat.properties, ...propertiesPayload } }
            : mat,
        ),
      );
      materialTouched = true;
    }

    const dmiParamsChanged =
      constantsChanged &&
      (propertiesPayload.Dind !== prevProperties.Dind ||
        propertiesPayload.Dbulk !== prevProperties.Dbulk);
    const needsObjectsPatch =
      isExplicitUnassign ||
      shouldCreateNewMaterial ||
      materialReassigned ||
      uniaxialChanged ||
      cubicChanged ||
      optInObjectInteractions.length > 0 ||
      dmiParamsChanged;

    if (needsObjectsPatch) {
      let objectsMutated = false;
      const nextObjects = (sceneData.objects ?? []).map((obj) => {
        const isTarget = obj.id === objectId;
        const usesUpdatedMaterial =
          Boolean(resolvedMatId) &&
          (isTarget ? !isExplicitUnassign : obj.material_ref === resolvedMatId);
        if (!isTarget && !(dmiParamsChanged && usesUpdatedMaterial)) return obj;

        let nextMaterialRef = obj.material_ref ?? "";
        if (isTarget) {
          if (isExplicitUnassign) {
            nextMaterialRef = "";
            materialTouched = true;
            objectsMutated = true;
          } else if ((shouldCreateNewMaterial || materialReassigned) && resolvedMatId) {
            nextMaterialRef = resolvedMatId;
            materialTouched = true;
            objectsMutated = true;
          }
        }

        let nextStack: Record<string, unknown>[] = Array.isArray(obj.physics_stack)
          ? obj.physics_stack.map((entry) => ({ ...entry }))
          : [];
        let stackChanged = false;

        if (isTarget && uniaxialChanged) {
          const payload = buildUniaxialInteractionPayload(effectiveUniaxialDraft);
          nextStack = upsertPhysicsStackEntry(
            nextStack,
            "uniaxial_anisotropy",
            payload.present ? { enabled: payload.enabled, params: payload.params } : null,
          );
          stackChanged = true;
          interactionTouched = true;
          invalidatedInteractionKinds.add("uniaxial_anisotropy");
        }

        if (isTarget && cubicChanged) {
          const payload = buildCubicInteractionPayload(draft, effectiveCubicEnabled);
          nextStack = upsertPhysicsStackEntry(
            nextStack,
            "cubic_anisotropy",
            payload.present ? { enabled: payload.enabled, params: payload.params } : null,
          );
          stackChanged = true;
          interactionTouched = true;
          invalidatedInteractionKinds.add("cubic_anisotropy");
        }

        if (isTarget && optInObjectInteractions.length > 0) {
          for (const kind of optInObjectInteractions) {
            const existingParams = readExistingInteractionParams(nextStack, kind);
            const params =
              kind === "interfacial_dmi"
                ? { interface_normal: [0, 0, 1], ...existingParams, dind: draft.dind }
                : kind === "bulk_dmi"
                  ? { ...existingParams, dbulk: draft.dbulk }
                  : existingParams;
            nextStack = upsertPhysicsStackEntry(nextStack, kind, { enabled: true, params });
            stackChanged = true;
            interactionTouched = true;
            invalidatedInteractionKinds.add(kind);
          }
        }

        if (dmiParamsChanged && usesUpdatedMaterial) {
          const synced = syncDmiParamsOnPhysicsStack(
            nextStack,
            propertiesPayload.Dind,
            propertiesPayload.Dbulk,
          );
          if (synced.changed) {
            nextStack = synced.stack;
            stackChanged = true;
            interactionTouched = true;
          }
        }

        if (stackChanged) {
          objectsMutated = true;
          return { ...obj, material_ref: nextMaterialRef, physics_stack: nextStack };
        }
        return isTarget ? { ...obj, material_ref: nextMaterialRef } : obj;
      });
      if (objectsMutated) mergePatch.objects = cloneJsonValue(nextObjects);
    }

    if (needsConstitutivePatch) {
      Object.assign(
        mergePatch,
        buildConstitutiveMergePatch(
          resolvedMatId ?? objectId,
          draft,
          sceneData.current_transports,
          draft.sigma !== prev.sigma,
        ),
      );
      materialTouched = true;
    }

    if (enableDemag || enableExchange) {
      mergePatch.study = {
        ...(asJsonObject(mergePatch.study) ?? {}),
        ...(enableDemag ? { demag_enabled: true } : {}),
        ...(enableExchange ? { exchange_enabled: true } : {}),
      };
      interactionTouched = true;
    }

    const tx = await api.model.commitTransaction(
      {
        ...(latestRevision !== null ? { base_revision: latestRevision } : {}),
        kind: "merge_patch",
        merge_patch: mergePatch,
      },
      requestScopeOptions,
    );
    latestRevision = tx.scene_revision;
    latestCommittedScene = tx.committed_scene;
    const rev = fallbackRevision(latestRevision);
    publishScene(resources, tx.committed_scene, rev, sessionScopeKey);
    invalidateMaterialCommitResources(
      resources, objectId, rev, materialTouched, interactionTouched, invalidatedMaterialIds, invalidatedInteractionKinds,
    );
    return { committed_scene: latestCommittedScene, scene_revision: latestRevision, activationErrors: [] };
  }

  // Single-operation atomic endpoints & sequential fallback (when commitTransaction is unavailable).
  let materialTouched = false;
  let studyFlagsAlreadyCommitted = false;

  if (isExplicitUnassign) {
    const patchedScene = await api.model.patchObject(
      objectId, buildMaterialAssignmentPatch({ materialRef: "" }, latestRevision), requestScopeOptions,
    );
    latestRevision = patchedScene.revision ?? latestRevision;
    latestCommittedScene = patchedScene;
    materialTouched = true;
    publishScene(resources, patchedScene, patchedScene.revision, sessionScopeKey);
  } else {
    if (shouldCreateNewMaterial && resolvedMatId) {
      const createdName = draft.materialName.trim() || `Material (${draft.objectName})`;
      if (draft.isMagneticBody) {
        const tx: AuthoringTransactionResponse = await api.model.createMaterial(
          resolvedMatId, createdName, propertiesPayload, [], authoringWriteOptions(latestRevision, sessionScopeKey),
          { assignToObjectId: objectId },
        );
        latestRevision = tx.scene_revision;
        latestCommittedScene = tx.committed_scene;
      } else {
        const tx: AuthoringTransactionResponse = await api.model.createMaterial(
          resolvedMatId, createdName, propertiesPayload, [], authoringWriteOptions(latestRevision, sessionScopeKey),
        );
        publishScene(resources, tx.committed_scene, tx.scene_revision, sessionScopeKey);
        try {
          const patchedScene = await api.model.patchObject(
            objectId, buildMaterialAssignmentPatch({ materialRef: resolvedMatId }, tx.scene_revision), requestScopeOptions,
          );
          latestRevision = patchedScene.revision ?? tx.scene_revision;
          latestCommittedScene = patchedScene;
        } catch (patchErr) {
          throw new MaterialAssignmentAfterCreateError(objectId, resolvedMatId, tx, null, patchErr, sessionScopeKey);
        }
      }
      materialTouched = true;
      publishScene(resources, latestCommittedScene, latestRevision, sessionScopeKey);
    } else if (resolvedMatId) {
      if (materialReassigned) {
        const patchedScene = await api.model.patchObject(
          objectId, buildMaterialAssignmentPatch({ materialRef: resolvedMatId }, latestRevision), requestScopeOptions,
        );
        latestRevision = patchedScene.revision ?? latestRevision;
        latestCommittedScene = patchedScene;
        materialTouched = true;
        publishScene(resources, patchedScene, patchedScene.revision, sessionScopeKey);
      }
      if (constantsChanged) {
        const tx = await api.model.patchMaterialAsset(
          resolvedMatId, { name: draft.materialName.trim(), properties: propertiesPayload },
          authoringWriteOptions(latestRevision, sessionScopeKey),
        );
        latestRevision = tx.scene_revision;
        latestCommittedScene = tx.committed_scene;
        materialTouched = true;
        publishScene(resources, tx.committed_scene, tx.scene_revision, sessionScopeKey);
      }
    }

    if (needsConstitutivePatch && typeof api.model.commitTransaction === "function") {
      const mergePatch = buildConstitutiveMergePatch(
        resolvedMatId ?? objectId, draft, sceneData?.current_transports, draft.sigma !== prev.sigma,
      );
      if (enableDemag || enableExchange) {
        mergePatch.study = {
          ...(asJsonObject(mergePatch.study) ?? {}),
          ...(enableDemag ? { demag_enabled: true } : {}),
          ...(enableExchange ? { exchange_enabled: true } : {}),
        };
        studyFlagsAlreadyCommitted = true;
      }
      const mergeTx = await api.model.commitTransaction(
        { ...(latestRevision !== null ? { base_revision: latestRevision } : {}), kind: "merge_patch", merge_patch: mergePatch },
        requestScopeOptions,
      );
      latestRevision = mergeTx.scene_revision;
      latestCommittedScene = mergeTx.committed_scene;
      materialTouched = true;
      publishScene(resources, mergeTx.committed_scene, mergeTx.scene_revision, sessionScopeKey);
    }
  }

  const physicsSync = await syncMaterialPhysicsAutoActivation({
    objectId, draft, prev, sceneData, studyFlagsAlreadyCommitted, latestRevision,
    latestCommittedScene, sessionScopeKey, requestScopeOptions, api, resources,
  });
  latestRevision = physicsSync.latestRevision;
  latestCommittedScene = physicsSync.latestCommittedScene;

  invalidateMaterialCommitResources(
    resources, objectId, fallbackRevision(latestRevision), materialTouched,
    physicsSync.interactionTouched || studyFlagsAlreadyCommitted, invalidatedMaterialIds, invalidatedInteractionKinds,
  );

  return {
    committed_scene: latestCommittedScene,
    scene_revision: latestRevision,
    activationErrors: physicsSync.activationErrors,
  };
}
