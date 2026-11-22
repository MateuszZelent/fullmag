import { MODEL_PHYSICS_GRAPH_PATH } from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionResponse,
  ObjectInteractionKind,
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

import {
  fallbackRevision,
  normalizeVector3,
} from "../../../panels/model-roots/SpecInspectorHost";
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

function readCommittedPhysicsStackState(
  scene: SceneResource | null | undefined,
  objectId: string,
): Map<string, boolean> {
  const state = new Map<string, boolean>();
  const committedObj = scene?.objects?.find((o) => o.id === objectId);
  const stack = (
    committedObj as unknown as { physics_stack?: unknown[] } | undefined
  )?.physics_stack;
  if (!Array.isArray(stack)) return state;
  for (const entry of stack) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const kind =
      typeof rec.kind === "string" ? rec.kind.trim().toLowerCase() : "";
    if (!kind) continue;
    state.set(kind, rec.enabled !== false);
  }
  return state;
}

function readCommittedStudyPhysicsFlags(
  scene: SceneResource | null | undefined,
): { demagEnabled?: boolean; exchangeEnabled?: boolean } {
  const study = (
    scene as unknown as {
      study?: { demag_enabled?: boolean; exchange_enabled?: boolean };
    } | null | undefined
  )?.study;
  return {
    demagEnabled: study?.demag_enabled,
    exchangeEnabled: study?.exchange_enabled,
  };
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
    (draft.uniaxialEnabled ||
      Math.abs(draft.ku1) > 0 ||
      Math.abs(draft.ku2) > 0) &&
    stackState.get("uniaxial_anisotropy") !== true
  ) {
    pending.push({
      id: "uniaxial_anisotropy",
      label: "Uniaxial anisotropy",
      scope: "object",
    });
  }
  if (
    (draft.cubicEnabled ||
      Math.abs(draft.kc1) > 0 ||
      Math.abs(draft.kc2) > 0 ||
      Math.abs(draft.kc3) > 0) &&
    stackState.get("cubic_anisotropy") !== true
  ) {
    pending.push({
      id: "cubic_anisotropy",
      label: "Cubic anisotropy",
      scope: "object",
    });
  }
  if (
    draft.dindSet &&
    draft.dind !== 0 &&
    stackState.get("interfacial_dmi") !== true
  ) {
    pending.push({
      id: "interfacial_dmi",
      label: "Interfacial DMI",
      scope: "object",
    });
  }
  if (
    draft.dbulkSet &&
    draft.dbulk !== 0 &&
    stackState.get("bulk_dmi") !== true
  ) {
    pending.push({ id: "bulk_dmi", label: "Bulk DMI", scope: "object" });
  }
  if (
    draft.msSet &&
    draft.ms > 0 &&
    studyFlags.demagEnabled === false
  ) {
    pending.push({
      id: "study.demag_enabled",
      label: "Demag",
      scope: "study",
    });
  }
  if (
    draft.aexSet &&
    draft.aex > 0 &&
    studyFlags.exchangeEnabled === false
  ) {
    pending.push({
      id: "study.exchange_enabled",
      label: "Exchange (study)",
      scope: "study",
    });
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
 * enables required canonical physics interactions (`exchange`, `interfacial_dmi`,
 * `bulk_dmi`, plus study `demag_enabled` / `exchange_enabled` flags).
 * Never swallows errors silently; returns structured `activationErrors`.
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

  const effectiveScene = latestCommittedScene ?? sceneData;
  const committedStackState = readCommittedPhysicsStackState(
    effectiveScene,
    objectId,
  );

  // Only enable anisotropy beyond the user's explicit toggle when opted in.
  const effectiveUniaxialEnabled = draft.activateRequiredPhysics
    ? draft.uniaxialEnabled ||
      Math.abs(draft.ku1) > 0 ||
      Math.abs(draft.ku2) > 0
    : draft.uniaxialEnabled;
  const effectiveUniaxialDraft =
    effectiveUniaxialEnabled !== draft.uniaxialEnabled
      ? { ...draft, uniaxialEnabled: effectiveUniaxialEnabled }
      : draft;

  const uniaxialChanged =
    effectiveUniaxialDraft.uniaxialEnabled !== prev.uniaxialEnabled ||
    (draft.activateRequiredPhysics &&
      effectiveUniaxialEnabled &&
      committedStackState.get("uniaxial_anisotropy") !== true) ||
    draft.ku1 !== prev.ku1 ||
    draft.ku2 !== prev.ku2 ||
    JSON.stringify(draft.uniaxialAxis) !== JSON.stringify(prev.uniaxialAxis);

  if (uniaxialChanged && draft.isMagneticBody) {
    const payload = buildUniaxialInteractionPayload(effectiveUniaxialDraft);
    const ack = await api.model.patchObjectInteraction(
      objectId,
      "uniaxial_anisotropy",
      {
        base_revision: latestRevision,
        enabled: payload.enabled,
        present: payload.present,
        params: payload.params,
      },
      requestScopeOptions,
    );
    latestRevision = ack.scene_revision;
    interactionTouched = true;
    resources.invalidate(
      resolveObjectInteractionResourceKey(objectId, "uniaxial_anisotropy"),
      fallbackRevision(latestRevision),
    );
  }

  const effectiveCubicEnabled = draft.activateRequiredPhysics
    ? draft.cubicEnabled ||
      Math.abs(draft.kc1) > 0 ||
      Math.abs(draft.kc2) > 0 ||
      Math.abs(draft.kc3) > 0
    : draft.cubicEnabled;
  const cubicChanged =
    effectiveCubicEnabled !== prev.cubicEnabled ||
    (draft.activateRequiredPhysics &&
      effectiveCubicEnabled &&
      committedStackState.get("cubic_anisotropy") !== true) ||
    draft.kc1 !== prev.kc1 ||
    draft.kc2 !== prev.kc2 ||
    draft.kc3 !== prev.kc3 ||
    JSON.stringify(draft.cubicAxis1) !== JSON.stringify(prev.cubicAxis1) ||
    JSON.stringify(draft.cubicAxis2) !== JSON.stringify(prev.cubicAxis2);

  if (cubicChanged && draft.isMagneticBody) {
    const axis1 = normalizeVector3(draft.cubicAxis1, [1, 0, 0]);
    const axis2 = orthogonalizeAxisGramSchmidt(axis1, draft.cubicAxis2);
    const cubicKind = "cubic_anisotropy" as unknown as ObjectInteractionKind;
    const ack = await api.model.patchObjectInteraction(
      objectId,
      cubicKind,
      {
        base_revision: latestRevision,
        enabled: effectiveCubicEnabled,
        present:
          effectiveCubicEnabled ||
          Math.abs(draft.kc1) > 0 ||
          Math.abs(draft.kc2) > 0 ||
          Math.abs(draft.kc3) > 0,
        params: {
          kc1: draft.kc1,
          kc2: draft.kc2,
          kc3: draft.kc3,
          axis1,
          axis2,
        },
      },
      requestScopeOptions,
    );
    latestRevision = ack.scene_revision;
    interactionTouched = true;
    const cubicResourceKey = resolveObjectInteractionResourceKey(
      objectId,
      "uniaxial_anisotropy",
    ).replace("uniaxial_anisotropy", "cubic_anisotropy");
    resources.invalidate(
      cubicResourceKey,
      fallbackRevision(latestRevision),
    );
  }

  // Explicit opt-in physics activation ONLY (ADR 0086). Never activates silently.
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
      {
        kind: "exchange",
        label: "Exchange",
        condition: draft.aexSet && draft.aex > 0,
      },
      {
        kind: "interfacial_dmi",
        label: "Interfacial DMI",
        condition: draft.dindSet && draft.dind !== 0,
      },
      {
        kind: "bulk_dmi" as unknown as ObjectInteractionKind,
        label: "Bulk DMI",
        condition: draft.dbulkSet && draft.dbulk !== 0,
      },
    ];
    for (const { kind, label, condition } of optInKinds) {
      if (!condition || committedStackState.get(kind) === true) continue;
      try {
        const ack = await api.model.patchObjectInteraction(
          objectId,
          kind,
          {
            base_revision: latestRevision,
            enabled: true,
            present: true,
            params: {},
          },
          requestScopeOptions,
        );
        latestRevision = ack.scene_revision;
        interactionTouched = true;
        resources.invalidate(
          resolveObjectInteractionResourceKey(objectId, kind),
          fallbackRevision(latestRevision),
        );
      } catch (error) {
        activationErrors.push({
          module: kind,
          label,
          message: errorMessage(error),
        });
      }
    }

    if (!studyFlagsAlreadyCommitted) {
      const studyFlags = readCommittedStudyPhysicsFlags(
        latestCommittedScene ?? sceneData,
      );
      const enableDemag =
        draft.msSet && draft.ms > 0 && studyFlags.demagEnabled === false;
      const enableExchange =
        draft.aexSet && draft.aex > 0 && studyFlags.exchangeEnabled === false;
      if (
        (enableDemag || enableExchange) &&
        typeof api.model.commitTransaction === "function"
      ) {
        try {
          const studyTx = await api.model.commitTransaction(
            {
              ...(latestRevision !== null
                ? { base_revision: latestRevision }
                : {}),
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
          publishCommittedSceneResource(
            resources,
            studyTx.committed_scene,
            studyTx.scene_revision,
            undefined,
            true,
            sessionScopeKey,
          );
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

  return {
    latestRevision,
    latestCommittedScene,
    interactionTouched,
    activationErrors,
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
  let materialTouched = false;
  let studyFlagsAlreadyCommitted = false;
  const invalidatedMaterialIds = new Set<string>();
  if (prev.materialId) {
    invalidatedMaterialIds.add(prev.materialId);
  }

  const isExplicitUnassign =
    !draft.materialId && !draft.pendingNewMaterial && Boolean(prev.materialId);

  let resolvedMatId: string | null = draft.materialId;

  if (isExplicitUnassign) {
    const patchedScene = await api.model.patchObject(
      objectId,
      buildMaterialAssignmentPatch({ materialRef: "" }, latestRevision),
      requestScopeOptions,
    );
    latestRevision = patchedScene.revision ?? latestRevision;
    latestCommittedScene = patchedScene;
    materialTouched = true;
    publishCommittedSceneResource(
      resources,
      patchedScene,
      fallbackRevision(patchedScene.revision),
      undefined,
      true,
      sessionScopeKey,
    );
  } else {
    const propertiesPayload = resolveMaterialPropertiesFromDraft(draft, prev);
    const shouldCreateNewMaterial =
      !resolvedMatId ||
      draft.pendingNewMaterial ||
      !existingMaterialIds.has(resolvedMatId);

    if (shouldCreateNewMaterial) {
      const customId =
        draft.newMaterialId.trim() ||
        resolvedMatId?.trim() ||
        suggestNewMaterialId(`mat-${objectId}`, existingMaterialIds);
      resolvedMatId = customId;
      invalidatedMaterialIds.add(resolvedMatId);
      const createdName =
        draft.materialName.trim() || `Material (${draft.objectName})`;

      if (draft.isMagneticBody) {
        const tx: AuthoringTransactionResponse =
          await api.model.createMaterial(
            resolvedMatId,
            createdName,
            propertiesPayload,
            [],
            authoringWriteOptions(latestRevision, sessionScopeKey),
            { assignToObjectId: objectId },
          );
        latestRevision = tx.scene_revision;
        latestCommittedScene = tx.committed_scene;
      } else {
        const tx: AuthoringTransactionResponse =
          await api.model.createMaterial(
            resolvedMatId,
            createdName,
            propertiesPayload,
            [],
            authoringWriteOptions(latestRevision, sessionScopeKey),
          );
        publishCommittedSceneResource(
          resources,
          tx.committed_scene,
          fallbackRevision(tx.scene_revision),
          undefined,
          true,
          sessionScopeKey,
        );
        try {
          const patchedScene = await api.model.patchObject(
            objectId,
            buildMaterialAssignmentPatch(
              { materialRef: resolvedMatId },
              tx.scene_revision,
            ),
            requestScopeOptions,
          );
          latestRevision = patchedScene.revision ?? tx.scene_revision;
          latestCommittedScene = patchedScene;
        } catch (patchErr) {
          throw new MaterialAssignmentAfterCreateError(
            objectId,
            resolvedMatId,
            tx,
            null,
            patchErr,
            sessionScopeKey,
          );
        }
      }
      materialTouched = true;
      publishCommittedSceneResource(
        resources,
        latestCommittedScene,
        fallbackRevision(latestRevision),
        undefined,
        true,
        sessionScopeKey,
      );
    } else if (resolvedMatId) {
      invalidatedMaterialIds.add(resolvedMatId);
      if (resolvedMatId !== prev.materialId) {
        const patchedScene = await api.model.patchObject(
          objectId,
          buildMaterialAssignmentPatch(
            { materialRef: resolvedMatId },
            latestRevision,
          ),
          requestScopeOptions,
        );
        latestRevision = patchedScene.revision ?? latestRevision;
        latestCommittedScene = patchedScene;
        materialTouched = true;
        publishCommittedSceneResource(
          resources,
          patchedScene,
          fallbackRevision(patchedScene.revision),
          undefined,
          true,
          sessionScopeKey,
        );
      }

      const prevProperties = resolveMaterialPropertiesFromDraft(prev, prev);
      const constantsChanged =
        draft.materialName !== prev.materialName ||
        propertiesPayload.Ms !== prevProperties.Ms ||
        propertiesPayload.Aex !== prevProperties.Aex ||
        propertiesPayload.alpha !== prevProperties.alpha ||
        propertiesPayload.Dind !== prevProperties.Dind ||
        propertiesPayload.Dbulk !== prevProperties.Dbulk;

      if (constantsChanged) {
        const tx = await api.model.patchMaterialAsset(
          resolvedMatId,
          {
            name: draft.materialName.trim(),
            properties: propertiesPayload,
          },
          authoringWriteOptions(latestRevision, sessionScopeKey),
        );
        latestRevision = tx.scene_revision;
        latestCommittedScene = tx.committed_scene;
        materialTouched = true;
        publishCommittedSceneResource(
          resources,
          tx.committed_scene,
          tx.scene_revision,
          undefined,
          true,
          sessionScopeKey,
        );
      }
    }

    const constitutiveChanged =
      draft.gamma !== prev.gamma ||
      draft.landeG !== prev.landeG ||
      draft.sigma !== prev.sigma ||
      draft.density !== prev.density ||
      draft.magnetoelasticEnabled !== prev.magnetoelasticEnabled ||
      draft.b1 !== prev.b1 ||
      draft.b2 !== prev.b2 ||
      draft.c11 !== prev.c11 ||
      draft.c12 !== prev.c12 ||
      draft.c44 !== prev.c44;

    if (
      (constitutiveChanged ||
        (shouldCreateNewMaterial && draft.magnetoelasticEnabled)) &&
      typeof api.model.commitTransaction === "function"
    ) {
      const constitutiveKey = resolvedMatId ?? objectId;
      const mergePatch = buildConstitutiveMergePatch(
        constitutiveKey,
        draft,
        sceneData?.current_transports,
        draft.sigma !== prev.sigma,
      );
      // Bundle opt-in study physics flags into the same merge_patch transaction
      // to avoid a redundant commitTransaction round-trip.
      if (draft.activateRequiredPhysics && draft.isMagneticBody) {
        const studyFlags = readCommittedStudyPhysicsFlags(
          latestCommittedScene ?? sceneData,
        );
        const enableDemag =
          draft.msSet && draft.ms > 0 && studyFlags.demagEnabled === false;
        const enableExchange =
          draft.aexSet && draft.aex > 0 && studyFlags.exchangeEnabled === false;
        if (enableDemag || enableExchange) {
          const studyPatch = (mergePatch.study ?? {}) as Record<string, unknown>;
          mergePatch.study = {
            ...studyPatch,
            ...(enableDemag ? { demag_enabled: true } : {}),
            ...(enableExchange ? { exchange_enabled: true } : {}),
          } as unknown as typeof mergePatch.study;
          studyFlagsAlreadyCommitted = true;
        }
      }
      const mergeTx = await api.model.commitTransaction(
        {
          ...(latestRevision !== null ? { base_revision: latestRevision } : {}),
          kind: "merge_patch",
          merge_patch: mergePatch,
        },
        requestScopeOptions,
      );
      latestRevision = mergeTx.scene_revision;
      latestCommittedScene = mergeTx.committed_scene;
      materialTouched = true;
      publishCommittedSceneResource(
        resources,
        mergeTx.committed_scene,
        mergeTx.scene_revision,
        undefined,
        true,
        sessionScopeKey,
      );
    }
  }

  const physicsSync = await syncMaterialPhysicsAutoActivation({
    objectId,
    draft,
    prev,
    sceneData,
    studyFlagsAlreadyCommitted,
    latestRevision,
    latestCommittedScene,
    sessionScopeKey,
    requestScopeOptions,
    api,
    resources,
  });
  latestRevision = physicsSync.latestRevision;
  latestCommittedScene = physicsSync.latestCommittedScene;
  const { interactionTouched, activationErrors } = physicsSync;

  const rev = fallbackRevision(latestRevision);
  if (materialTouched) {
    invalidateAuthoringMutationDependents(resources, "material", rev);
    for (const matId of invalidatedMaterialIds) {
      resources.invalidate(resolveMaterialResourceKey(matId), rev);
    }
  }
  if (interactionTouched || studyFlagsAlreadyCommitted) {
    invalidateAuthoringMutationDependents(resources, "interaction", rev);
  }
  if (materialTouched || interactionTouched || studyFlagsAlreadyCommitted) {
    resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
  }

  return {
    committed_scene: latestCommittedScene,
    scene_revision: latestRevision,
    activationErrors,
  };
}
