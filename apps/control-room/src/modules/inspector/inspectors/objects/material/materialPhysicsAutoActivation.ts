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
  orthogonalizeAxisGramSchmidt,
  resolveMaterialPropertiesFromDraft,
  suggestNewMaterialId,
  type UnifiedObjectMaterialDraft,
} from "./materialShared";

export interface MaterialPhysicsSyncParams {
  readonly objectId: string;
  readonly draft: UnifiedObjectMaterialDraft;
  readonly prev: UnifiedObjectMaterialDraft;
  readonly materialTouched: boolean;
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
}

/**
 * Synchronizes uniaxial & cubic anisotropy interactions (auto-enabling on non-zero
 * Ku1/Ku2/Kc1/Kc2/Kc3) and auto-activates canonical physics interactions
 * (`exchange`, `interfacial_dmi`, `bulk_dmi`, plus study `demag_enabled` /
 * `exchange_enabled` flags) when a material is newly assigned or a parameter
 * transitions to non-zero, while respecting existing manual disables.
 */
export async function syncMaterialPhysicsAutoActivation(
  params: MaterialPhysicsSyncParams,
): Promise<MaterialPhysicsSyncResult> {
  const {
    objectId,
    draft,
    prev,
    materialTouched,
    sessionScopeKey,
    requestScopeOptions,
    api,
    resources,
  } = params;
  let { latestRevision, latestCommittedScene } = params;
  let interactionTouched = false;

  // Auto-enable uniaxial/cubic anisotropy when non-zero Ku/Kc is entered
  const autoUniaxialEnabled =
    draft.uniaxialEnabled ||
    ((draft.ku1 !== prev.ku1 || draft.ku2 !== prev.ku2) &&
      (Math.abs(draft.ku1) > 0 || Math.abs(draft.ku2) > 0));
  const effectiveUniaxialDraft =
    autoUniaxialEnabled !== draft.uniaxialEnabled
      ? { ...draft, uniaxialEnabled: autoUniaxialEnabled }
      : draft;

  // Atomically persist uniaxial anisotropy WITH lossless Ku2!
  const uniaxialChanged =
    effectiveUniaxialDraft.uniaxialEnabled !== prev.uniaxialEnabled ||
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

  const autoCubicEnabled =
    draft.cubicEnabled ||
    ((draft.kc1 !== prev.kc1 ||
      draft.kc2 !== prev.kc2 ||
      draft.kc3 !== prev.kc3) &&
      (Math.abs(draft.kc1) > 0 ||
        Math.abs(draft.kc2) > 0 ||
        Math.abs(draft.kc3) > 0));
  const cubicChanged =
    autoCubicEnabled !== prev.cubicEnabled ||
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
        enabled: autoCubicEnabled,
        present:
          autoCubicEnabled ||
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

  // Auto-activate canonical physics interactions from material parameters
  // when a material is newly assigned OR a parameter transitions to non-zero
  // (only for interactions not yet present on the object so manual disables are respected).
  const newlyAssignedMaterial =
    draft.pendingNewMaterial ||
    (Boolean(draft.materialId) && draft.materialId !== prev.materialId);
  if (
    draft.isMagneticBody &&
    materialTouched &&
    typeof api.model.patchObjectInteraction === "function"
  ) {
    const committedObj = latestCommittedScene?.objects?.find(
      (o) => o.id === objectId,
    );
    const existingStack = Array.isArray(
      (committedObj as unknown as { physics_stack?: unknown[] } | undefined)
        ?.physics_stack,
    )
      ? (committedObj as unknown as { physics_stack: unknown[] }).physics_stack
      : [];
    const stackKinds = new Set(
      existingStack
        .map((entry) =>
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>).kind
            : null,
        )
        .filter((k): k is string => typeof k === "string"),
    );
    const aexActivated =
      draft.aexSet &&
      draft.aex > 0 &&
      (newlyAssignedMaterial || !prev.aexSet || prev.aex <= 0);
    const dindActivated =
      draft.dindSet &&
      draft.dind !== 0 &&
      (newlyAssignedMaterial || !prev.dindSet || prev.dind === 0);
    const dbulkActivated =
      draft.dbulkSet &&
      draft.dbulk !== 0 &&
      (newlyAssignedMaterial || !prev.dbulkSet || prev.dbulk === 0);
    const autoKinds: Array<{ kind: ObjectInteractionKind; condition: boolean }> = [
      { kind: "exchange", condition: aexActivated },
      { kind: "interfacial_dmi", condition: dindActivated },
      {
        kind: "bulk_dmi" as unknown as ObjectInteractionKind,
        condition: dbulkActivated,
      },
    ];
    for (const { kind, condition } of autoKinds) {
      if (!condition || stackKinds.has(kind)) continue;
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
      } catch {
        // Best-effort auto-activation: never fail material save if lane/endpoint rejects.
      }
    }
    const studyObj = (
      latestCommittedScene as unknown as {
        study?: { demag_enabled?: boolean; exchange_enabled?: boolean };
      } | null
    )?.study;
    const enableDemag =
      draft.msSet &&
      draft.ms > 0 &&
      (newlyAssignedMaterial || !prev.msSet || prev.ms <= 0) &&
      studyObj?.demag_enabled === false;
    const enableExchange =
      aexActivated && studyObj?.exchange_enabled === false;
    if (
      (enableDemag || enableExchange) &&
      typeof api.model.commitTransaction === "function"
    ) {
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
        publishCommittedSceneResource(
          resources,
          studyTx.committed_scene,
          studyTx.scene_revision,
          undefined,
          true,
          sessionScopeKey,
        );
      } catch {
        // Best-effort study flag activation.
      }
    }
  }

  return {
    latestRevision,
    latestCommittedScene,
    interactionTouched,
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
}> {
  let latestRevision = baseRevision ?? sceneData?.revision ?? null;
  let latestCommittedScene: SceneResource | null = null;
  let materialTouched = false;
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
    materialTouched,
    latestRevision,
    latestCommittedScene,
    sessionScopeKey,
    requestScopeOptions,
    api,
    resources,
  });
  latestRevision = physicsSync.latestRevision;
  latestCommittedScene = physicsSync.latestCommittedScene;
  const { interactionTouched } = physicsSync;

  const rev = fallbackRevision(latestRevision);
  if (materialTouched) {
    invalidateAuthoringMutationDependents(resources, "material", rev);
    for (const matId of invalidatedMaterialIds) {
      resources.invalidate(resolveMaterialResourceKey(matId), rev);
    }
  }
  if (interactionTouched) {
    invalidateAuthoringMutationDependents(resources, "interaction", rev);
  }
  if (materialTouched || interactionTouched) {
    resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
  }

  return {
    committed_scene: latestCommittedScene,
    scene_revision: latestRevision,
  };
}
