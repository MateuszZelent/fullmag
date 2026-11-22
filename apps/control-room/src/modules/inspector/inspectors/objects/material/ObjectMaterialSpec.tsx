"use client";

import { BookOpen, Magnet } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type {
  MaterialReferenceResource,
  MaterialResource,
  SceneMaterialResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { MaterialLibraryDialog } from "@/kernel/layout/MaterialLibraryDialog";
import {
  publishCommittedSceneResource,
  resolveMaterialResourceKey,
  useMaterialResource,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { KernelApi } from "@/kernel/types";
import type { MaterialCatalogSelection } from "@/shared/domain/material/materialLibrary";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  MU0_SI,
  SpecInspectorHost,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  buildMaterialAssignmentPatch,
  createMaterialAssetThenAssign,
  independentMaterialAsset,
  magneticParameterMaterialResourceFromSceneResource,
  materialAssetFromLibraryEntry,
  MaterialAssignmentAfterCreateError,
  normalizeMaterialRef,
} from "../../../panels/ObjectMaterialPanelModel";
import type {
  InspectorActionContext,
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../../template";
import { commitObjectMaterialDraft } from "./materialPhysicsAutoActivation";
import { buildMaterialSpecSections } from "./materialSections";
import {
  buildBaselineMaterialDraft,
  buildConstitutiveMergePatch,
  classifyUniaxialAnisotropyRegime,
  computeExchangeLengthMeters,
  errorMessage,
  isRevisionConflictError,
  resolveMaterialPropertiesFromDraft,
  type RevisionConflictState,
  suggestNewMaterialId,
  type UnifiedObjectMaterialDraft,
} from "./materialShared";

/* ── Session-scoped History Context Hook ── */

function useMaterialHistoryContext(
  kernel: KernelApi,
  sceneData: SceneResource | null | undefined,
  sessionScopeKey: string | null,
) {
  const sessionScopeKeyRef = useRef(sessionScopeKey);
  const mountedRef = useRef(true);
  useEffect(() => {
    sessionScopeKeyRef.current = sessionScopeKey;
  }, [sessionScopeKey]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return useCallback(() => {
    const capturedScopeKey = sessionScopeKey;
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    return {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      resourceData: sceneData ? { [MODEL_SCENE_PATH]: sceneData } : undefined,
      selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
      sessionScopeKey: capturedScopeKey,
      isCurrentSessionScope: () =>
        mountedRef.current &&
        sessionScopeKeyRef.current === capturedScopeKey &&
        (historyGeneration === undefined ||
          kernel.authoringHistory?.getGeneration?.() === historyGeneration),
    };
  }, [
    kernel.api,
    kernel.authoringHistory,
    kernel.selection,
    sceneData,
    sessionScopeKey,
  ]);
}

/* ── Unified ObjectMaterialInspectorPanel (`object.material`) ── */

export function ObjectMaterialInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const { sessionIdentity } = useSessionScopedResourceKey(MODEL_SCENE_PATH);
  const sessionScopeKey =
    sessionRequestScopeKey(sessionIdentity) ??
    kernel.commands?.getSessionScopeKey?.() ??
    null;
  const makeHistoryContext = useMaterialHistoryContext(
    kernel,
    scene.data,
    sessionScopeKey,
  );

  const [catalogOpen, setCatalogOpen] = useState(false);
  const [conflictState, setConflictState] = useState<RevisionConflictState | null>(null);

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const activeSceneMatId = normalizeMaterialRef(sceneObj?.material_ref ?? "");
  const role = sceneObj?.role?.trim().toLowerCase() ?? "magnet";
  const isMagneticBody =
    role !== "conductor" &&
    role !== "auxiliary" &&
    role !== "spacer_dielectric" &&
    role !== "antenna";

  const materialResource = useMaterialResource(activeSceneMatId);
  const uniaxialResource = useObjectInteractionResource(
    objectId || null,
    "uniaxial_anisotropy",
    { enabled: Boolean(objectId) && isMagneticBody },
  );

  const resolvedMaterialResource = useMemo<MaterialResource | null>(() => {
    if (!activeSceneMatId) return null;
    const fromScene = scene.data
      ? magneticParameterMaterialResourceFromSceneResource(activeSceneMatId, scene.data)
      : null;
    if (
      materialResource.data &&
      materialResource.data.id === activeSceneMatId &&
      (materialResource.data.scene_revision >= (scene.data?.revision ?? 0) || !fromScene)
    ) {
      return materialResource.data;
    }
    return fromScene ?? materialResource.data ?? null;
  }, [activeSceneMatId, materialResource.data, scene.data]);

  const dialogModelMaterial = useMemo<SceneMaterialResource | undefined>(() => {
    if (!activeSceneMatId) return undefined;
    const rawFromScene = scene.data?.materials?.find((m) => m.id === activeSceneMatId);
    if (resolvedMaterialResource) {
      return {
        id: resolvedMaterialResource.id,
        name: resolvedMaterialResource.name,
        properties: {
          ...(rawFromScene?.properties ?? {}),
          ...resolvedMaterialResource.properties,
        },
        references: resolvedMaterialResource.references ?? rawFromScene?.references,
        source: resolvedMaterialResource.source ?? rawFromScene?.source ?? null,
      };
    }
    return rawFromScene;
  }, [activeSceneMatId, resolvedMaterialResource, scene.data?.materials]);

  const baseline = useMemo(
    () =>
      buildBaselineMaterialDraft(
        objectId,
        selection.label ?? "Object",
        scene.data,
        resolvedMaterialResource,
        uniaxialResource.data
          ? {
              present: uniaxialResource.data.present,
              enabled: uniaxialResource.data.enabled,
              params: (uniaxialResource.data.params ?? {}) as Record<string, unknown>,
              scene_revision: uniaxialResource.data.scene_revision,
            }
          : null,
      ),
    [
      objectId,
      resolvedMaterialResource,
      scene.data,
      selection.label,
      uniaxialResource.data,
    ],
  );

  const existingMaterialIds = useMemo(
    () => new Set((scene.data?.materials ?? []).map((m) => m.id)),
    [scene.data?.materials],
  );

  const sessionMaterials = useMemo(
    () =>
      (scene.data?.materials ?? []).map((mat) => ({
        id: mat.id,
        label: mat.name || mat.id,
        subtitle:
          typeof mat.properties?.Ms === "number"
            ? `Ms = ${(mat.properties.Ms / 1e3).toFixed(0)} kA/m \u00b7 \u03b1 = ${mat.properties.alpha}`
            : `\u03b1 = ${mat.properties?.alpha ?? 0}`,
      })),
    [scene.data?.materials],
  );

  const handleRefreshAndRebase = useCallback(() => {
    setConflictState(null);
    void scene.refetch?.();
    void materialResource.refetch?.();
    void uniaxialResource.refetch?.();
  }, [materialResource, scene, uniaxialResource]);

  const handleRetryFailedAssignment = useCallback(
    async (ctx: InspectorActionContext<UnifiedObjectMaterialDraft>) => {
      const pending = conflictState?.pendingAssignmentError;
      if (!pending || !objectId) return;
      const createdMaterialId = pending.materialId.trim();
      if (!createdMaterialId) return;
      const createdMaterialName =
        pending.created.committed_scene?.materials
          ?.find((m) => m.id === createdMaterialId)
          ?.name?.trim() || createdMaterialId;
      const historyContext = makeHistoryContext();
      try {
        const patchedScene = await runAuthoringMutationWithHistory(
          historyContext,
          `Assign material ${createdMaterialName}`,
          ({ baseRevision }) =>
            kernel.api.model.patchObject(
              objectId,
              buildMaterialAssignmentPatch(
                { materialRef: createdMaterialId },
                baseRevision ?? scene.data?.revision ?? pending.assignmentBaseRevision,
              ),
              sessionScopeKey ? { sessionScopeKey } : undefined,
            ),
        );
        const rev = fallbackRevision(patchedScene.revision);
        publishCommittedSceneResource(
          kernel.resources,
          patchedScene,
          rev,
          undefined,
          true,
          sessionScopeKey,
        );
        invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
        kernel.resources.invalidate(
          resolveMaterialResourceKey(createdMaterialId),
          rev,
        );
        setConflictState(null);
        ctx.patchDraft({
          materialId: createdMaterialId,
          newMaterialId: createdMaterialId,
          materialName: createdMaterialName,
          pendingNewMaterial: false,
        });
        ctx.notify("Material assignment completed", createdMaterialName);
      } catch (error) {
        if (isRevisionConflictError(error)) {
          setConflictState({
            message: errorMessage(error),
            conflictedRevision: scene.data?.revision ?? null,
            pendingAssignmentError: pending,
          });
          void scene.refetch?.();
        }
      }
    },
    [
      conflictState?.pendingAssignmentError,
      kernel.api.model,
      kernel.resources,
      makeHistoryContext,
      objectId,
      scene,
      sessionScopeKey,
    ],
  );

  const handleDuplicateAndUnlink = useCallback(
    async (ctx: InspectorActionContext<UnifiedObjectMaterialDraft>) => {
      if (!objectId) return;
      const draftProperties = resolveMaterialPropertiesFromDraft(ctx.draft, baseline);
      const baseAsset = resolvedMaterialResource
        ? independentMaterialAsset(resolvedMaterialResource)
        : {
            materialId: suggestNewMaterialId(
              `mat-${objectId}`,
              existingMaterialIds,
            ),
            name: `${ctx.draft.materialName} (${ctx.draft.objectName})`,
            properties: draftProperties,
            references: [] as MaterialReferenceResource[],
            source: null,
          };
      const clonedAsset = {
        ...baseAsset,
        properties: draftProperties,
      };
      const historyContext = makeHistoryContext();
      try {
        const result = await runAuthoringMutationWithHistory(
          historyContext,
          `Duplicate & Unlink ${clonedAsset.name}`,
          async ({ baseRevision }) => {
            const initialRevision = baseRevision ?? scene.data?.revision ?? null;
            let latestScene: SceneResource;
            let latestRevision: number;
            if (ctx.draft.isMagneticBody && initialRevision !== null) {
              const assigned = await createMaterialAssetThenAssign(
                kernel.api,
                objectId,
                clonedAsset,
                initialRevision,
                historyContext.isCurrentSessionScope,
                sessionScopeKey,
              );
              latestScene = assigned.assigned;
              latestRevision = assigned.created.scene_revision;
            } else if (ctx.draft.isMagneticBody) {
              const created = await kernel.api.model.createMaterial(
                clonedAsset.materialId,
                clonedAsset.name,
                clonedAsset.properties,
                clonedAsset.references,
                authoringWriteOptions(initialRevision, sessionScopeKey),
                {
                  ...(clonedAsset.source ? { source: clonedAsset.source } : {}),
                  assignToObjectId: objectId,
                },
              );
              latestScene = created.committed_scene;
              latestRevision = created.scene_revision;
            } else {
              const created = await kernel.api.model.createMaterial(
                clonedAsset.materialId,
                clonedAsset.name,
                clonedAsset.properties,
                clonedAsset.references,
                authoringWriteOptions(initialRevision, sessionScopeKey),
                clonedAsset.source ? { source: clonedAsset.source } : undefined,
              );
              publishCommittedSceneResource(
                kernel.resources,
                created.committed_scene,
                fallbackRevision(created.scene_revision),
                undefined,
                true,
                sessionScopeKey,
              );
              try {
                const patched = await kernel.api.model.patchObject(
                  objectId,
                  buildMaterialAssignmentPatch(
                    { materialRef: clonedAsset.materialId },
                    created.scene_revision,
                  ),
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                );
                latestScene = patched;
                latestRevision = patched.revision ?? created.scene_revision;
              } catch (patchErr) {
                throw new MaterialAssignmentAfterCreateError(
                  objectId,
                  clonedAsset.materialId,
                  created,
                  null,
                  patchErr,
                  sessionScopeKey,
                );
              }
            }

            if (typeof kernel.api.model.commitTransaction === "function") {
              const mergeTx = await kernel.api.model.commitTransaction(
                {
                  base_revision: latestRevision,
                  kind: "merge_patch",
                  merge_patch: buildConstitutiveMergePatch(
                    clonedAsset.materialId,
                    ctx.draft,
                  ),
                },
                sessionScopeKey ? { sessionScopeKey } : undefined,
              );
              latestScene = mergeTx.committed_scene;
              latestRevision = mergeTx.scene_revision;
            }

            return {
              committed_scene: latestScene,
              scene_revision: latestRevision,
            };
          },
        );
        const rev = result.scene_revision;
        publishCommittedSceneResource(
          kernel.resources,
          result.committed_scene,
          rev,
          undefined,
          true,
          sessionScopeKey,
        );
        invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
        kernel.resources.invalidate(
          resolveMaterialResourceKey(clonedAsset.materialId),
          rev,
        );
        if (ctx.draft.materialId) {
          kernel.resources.invalidate(
            resolveMaterialResourceKey(ctx.draft.materialId),
            rev,
          );
        }
        setConflictState(null);
        ctx.patchDraft({
          materialId: clonedAsset.materialId,
          newMaterialId: clonedAsset.materialId,
          materialName: clonedAsset.name,
          pendingNewMaterial: false,
        });
        ctx.notify("Material duplicated & unlinked", clonedAsset.name);
      } catch (error) {
        if (
          isRevisionConflictError(error) ||
          error instanceof MaterialAssignmentAfterCreateError
        ) {
          setConflictState({
            message: errorMessage(error),
            conflictedRevision: scene.data?.revision ?? null,
            pendingAssignmentError:
              error instanceof MaterialAssignmentAfterCreateError ? error : null,
          });
          void scene.refetch?.();
        }
        throw error;
      }
    },
    [
      baseline,
      existingMaterialIds,
      kernel.api,
      kernel.resources,
      makeHistoryContext,
      objectId,
      resolvedMaterialResource,
      scene,
      sessionScopeKey,
    ],
  );

  const handleUseCatalogMaterial = useCallback(
    async (catalogSelection: MaterialCatalogSelection) => {
      if (!objectId) return;
      const asset = materialAssetFromLibraryEntry(catalogSelection);
      const historyContext = makeHistoryContext();
      try {
        const result = await runAuthoringMutationWithHistory(
          historyContext,
          `Use material ${asset.name}`,
          async ({ baseRevision }) => {
            const initialRevision = baseRevision ?? scene.data?.revision ?? null;
            if (isMagneticBody && initialRevision !== null) {
              const assigned = await createMaterialAssetThenAssign(
                kernel.api,
                objectId,
                asset,
                initialRevision,
                historyContext.isCurrentSessionScope,
                sessionScopeKey,
              );
              return {
                committed_scene: assigned.assigned,
                scene_revision: assigned.created.scene_revision,
              };
            }
            if (isMagneticBody) {
              const created = await kernel.api.model.createMaterial(
                asset.materialId,
                asset.name,
                asset.properties,
                asset.references,
                authoringWriteOptions(initialRevision, sessionScopeKey),
                {
                  ...(asset.source ? { source: asset.source } : {}),
                  assignToObjectId: objectId,
                },
              );
              return {
                committed_scene: created.committed_scene,
                scene_revision: created.scene_revision,
              };
            }
            const created = await kernel.api.model.createMaterial(
              asset.materialId,
              asset.name,
              asset.properties,
              asset.references,
              authoringWriteOptions(initialRevision, sessionScopeKey),
              asset.source ? { source: asset.source } : undefined,
            );
            publishCommittedSceneResource(
              kernel.resources,
              created.committed_scene,
              fallbackRevision(created.scene_revision),
              undefined,
              true,
              sessionScopeKey,
            );
            let patched: SceneResource;
            try {
              patched = await kernel.api.model.patchObject(
                objectId,
                buildMaterialAssignmentPatch(
                  { materialRef: asset.materialId },
                  created.scene_revision,
                ),
                sessionScopeKey ? { sessionScopeKey } : undefined,
              );
            } catch (patchErr) {
              throw new MaterialAssignmentAfterCreateError(
                objectId,
                asset.materialId,
                created,
                null,
                patchErr,
                sessionScopeKey,
              );
            }
            return {
              committed_scene: patched,
              scene_revision: patched.revision ?? created.scene_revision,
            };
          },
        );
        const rev = result.scene_revision;
        publishCommittedSceneResource(
          kernel.resources,
          result.committed_scene,
          rev,
          undefined,
          true,
          sessionScopeKey,
        );
        invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
        kernel.resources.invalidate(resolveMaterialResourceKey(asset.materialId), rev);
        if (activeSceneMatId) {
          kernel.resources.invalidate(
            resolveMaterialResourceKey(activeSceneMatId),
            rev,
          );
        }
        setConflictState(null);
      } catch (error) {
        if (
          isRevisionConflictError(error) ||
          error instanceof MaterialAssignmentAfterCreateError
        ) {
          setConflictState({
            message: errorMessage(error),
            conflictedRevision: scene.data?.revision ?? null,
            pendingAssignmentError:
              error instanceof MaterialAssignmentAfterCreateError ? error : null,
          });
          void scene.refetch?.();
        }
        throw error;
      }
    },
    [
      activeSceneMatId,
      isMagneticBody,
      kernel.api,
      kernel.resources,
      makeHistoryContext,
      objectId,
      scene,
      sessionScopeKey,
    ],
  );

  const activeSourceSnapshot = resolvedMaterialResource?.source ?? null;
  const activeReferences = useMemo(
    () => resolvedMaterialResource?.references ?? [],
    [resolvedMaterialResource?.references],
  );

  const spec = useMemo<InspectorSpec<UnifiedObjectMaterialDraft>>(
    () => ({
      id: "object.material",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection("objects.root", "model:objects", "Objects"),
          },
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          { id: "material", label: "Material" },
        ],
        canFitView: baseline.exists,
        searchable: true,
        primaryHeaderAction: {
          label: "Full Catalog",
          icon: BookOpen,
          onRun: () => setCatalogOpen(true),
        },
      },
      identity: {
        domain: "material",
        icon: Magnet,
        title: (draft) => (draft.materialId ? draft.materialName : "Unassigned Material"),
        renameFieldKey: "materialName",
        kindLabel: "Unified constitutive material",
        entityId: baseline.materialId ?? (objectId || undefined),
        statePill: (draft) =>
          !draft.materialId && !draft.pendingNewMaterial
            ? { tone: "warn", label: "Unassigned" }
            : draft.pendingNewMaterial
              ? { tone: "info", label: "Staged New" }
              : draft.sharedWithObjects.length > 1
                ? { tone: "info", label: `Shared (${draft.sharedWithObjects.length})` }
                : { tone: "ok", label: "Assigned" },
      },
      facts: (draft): readonly InspectorFact[] => {
        const lex =
          draft.msSet && draft.aexSet
            ? computeExchangeLengthMeters(draft.ms, draft.aex)
            : null;
        return [
          {
            id: "bsat",
            label: "\u03bc\u2080Ms",
            value:
              draft.msSet && draft.ms > 0
                ? `${((MU0_SI * draft.ms) * 1e3).toFixed(0)} mT`
                : null,
          },
          {
            id: "lex",
            label: "Exchange l_ex",
            value: lex !== null ? `${(lex * 1e9).toFixed(2)} nm` : null,
            tone: "info",
          },
          {
            id: "alpha",
            label: "Damping \u03b1",
            value: draft.isMagneticBody ? String(Number(draft.alpha.toPrecision(4))) : null,
          },
          {
            id: "ku",
            label: "Anisotropy",
            value: draft.uniaxialEnabled
              ? classifyUniaxialAnisotropyRegime(draft.ku1, draft.ku2).label
              : null,
          },
        ];
      },
      notices: (draft): readonly InspectorNotice<UnifiedObjectMaterialDraft>[] => {
        const list: InspectorNotice<UnifiedObjectMaterialDraft>[] = [];
        if (conflictState) {
          list.push({
            id: "material-revision-conflict",
            tone: "err",
            title: "Scene revision conflict (HTTP 409)",
            text: `${conflictState.message} Refresh and rebase onto the latest scene revision (${scene.data?.revision ?? "current"}) to apply your staged edits safely.`,
            quickFix: conflictState.pendingAssignmentError
              ? {
                  label: "Retry Assignment",
                  onApply: (ctx) => handleRetryFailedAssignment(ctx),
                }
              : {
                  label: "Refresh & Rebase",
                  onApply: () => handleRefreshAndRebase(),
                },
          });
        }
        if (draft.sharedWithObjects.length > 1 && !draft.pendingNewMaterial && draft.materialId) {
          list.push({
            id: "shared-material-guard",
            tone: "warn",
            title: `Shared across ${draft.sharedWithObjects.length} objects`,
            text: `Editing "${draft.materialName}" updates constants on: ${draft.sharedWithObjects.join(", ")}. Duplicate and unlink to isolate this object.`,
            quickFix: {
              label: "Duplicate & Unlink",
              onApply: (ctx) => handleDuplicateAndUnlink(ctx),
            },
          });
        }
        if (!draft.materialId && !draft.pendingNewMaterial) {
          list.push({
            id: "material-unassigned",
            tone: "info",
            title: baseline.materialId ? "Material will be unassigned on Apply" : "No material bound yet",
            text: baseline.materialId
              ? "Click Apply to clear material_ref on this object, or click Create Custom / Assign from Library to create a new material."
              : "Pick a reference material from the library or click Apply to create and bind a dedicated material.",
          });
        }
        return list;
      },
      sections: buildMaterialSpecSections({
        baseline,
        sessionMaterials,
        existingMaterialIds,
        dialogModelMaterial,
        activeSourceSnapshot,
        activeReferences,
        conflictState,
        onOpenCatalog: () => setCatalogOpen(true),
        onRefreshAndRebase: () => handleRefreshAndRebase(),
        onRetryFailedAssignment: (ctx) => handleRetryFailedAssignment(ctx),
        onDuplicateAndUnlink: (ctx) => handleDuplicateAndUnlink(ctx),
      }),
      commitBar: {
        mode: "staged",
        allowCleanApply: (d, base) =>
          (!base.materialId && !d.materialId) || d.pendingNewMaterial,
        cleanMessage: () => "Material constants & anisotropy match committed SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing scene object." : null),
        onApply: async (draft, prev) => {
          if (!objectId) return false;
          const historyContext = makeHistoryContext();
          const requestScopeOptions = sessionScopeKey ? { sessionScopeKey } : undefined;

          try {
            await runAuthoringMutationWithHistory(
              historyContext,
              !draft.materialId && !draft.pendingNewMaterial && prev.materialId
                ? `Unassign material from ${draft.objectName}`
                : `Apply material ${draft.materialName.trim() || draft.objectName}`,
              ({ baseRevision }) =>
                commitObjectMaterialDraft({
                  objectId,
                  draft,
                  prev,
                  baseRevision: baseRevision ?? null,
                  sceneData: scene.data,
                  existingMaterialIds,
                  sessionScopeKey,
                  requestScopeOptions,
                  api: kernel.api,
                  resources: kernel.resources,
                }),
            );
            setConflictState(null);
            return true;
          } catch (error) {
            if (
              isRevisionConflictError(error) ||
              error instanceof MaterialAssignmentAfterCreateError
            ) {
              setConflictState({
                message: errorMessage(error),
                conflictedRevision: scene.data?.revision ?? null,
                pendingAssignmentError:
                  error instanceof MaterialAssignmentAfterCreateError ? error : null,
              });
              void scene.refetch?.();
            }
            throw error;
          }
        },
      },
    }),
    [
      activeReferences,
      activeSourceSnapshot,
      baseline,
      conflictState,
      dialogModelMaterial,
      existingMaterialIds,
      handleDuplicateAndUnlink,
      handleRefreshAndRebase,
      handleRetryFailedAssignment,
      kernel.api,
      kernel.resources,
      makeHistoryContext,
      objectId,
      scene,
      sessionMaterials,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <MaterialLibraryDialog
        modelMaterial={dialogModelMaterial}
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        onUseMaterial={
          objectId && baseline.exists ? handleUseCatalogMaterial : undefined
        }
      />
    </SpecInspectorHost>
  );
}
