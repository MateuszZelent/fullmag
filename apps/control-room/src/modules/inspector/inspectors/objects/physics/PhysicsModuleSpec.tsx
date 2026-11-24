"use client";

import {
  Atom,
  BookOpen,
  Compass,
  GitBranch,
  HelpCircle,
  RefreshCw,
  Thermometer,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { MODEL_PHYSICS_GRAPH_PATH } from "@/kernel/api/apiPaths";
import type {
  JsonObject,
  ObjectInteractionKind,
  PhysicsGraphModuleResource,
} from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  resolveMaterialResourceKey,
  resolveSceneResourceRevision,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import {
  interactionSpecsForDiscretization,
  normalizeInteractionDiscretization,
} from "@/shared/domain/physics/interactions";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  buildObjectSelection,
  buildRootSelection,
  SpecInspectorHost,
} from "../../../panels/model-roots/SpecInspectorHost";
import { commitObjectInteractionMutation } from "../../../panels/PhysicsInteractionPanel.model";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../../template";
import {
  applyZeemanStudyPatch,
  buildAnisotropyAndZeemanRows,
  buildAnisotropyObjectParams,
  renderCubicAnisotropyFooter,
} from "./AnisotropyAndZeemanSpecs";
import {
  applyDemagStudyPatch,
  buildDemagRows,
} from "./DemagAndCouplingSpecs";
import {
  applyExchangeOrDmiStudyPatch,
  buildExchangeAndDmiRows,
  buildExchangeOrDmiObjectParams,
} from "./ExchangeAndDmiSpecs";
import { PhysicsInteractionHelpDialog } from "./PhysicsInteractionHelpDialog";
import {
  effectiveFieldMath,
  evaluatePhysicsModuleConflictOrLaneError,
  hydratePhysicsModuleBaseline,
} from "./physicsModuleHydration";
import {
  asJsonRecord,
  buildModuleHelpContent,
  commitObjectExchangeMutation,
  errorMessage,
  isRequiredModuleKind,
  isRestFetchableInteractionKind,
  isRevisionConflict,
  moduleTitleForKind,
  resolveCanonicalPhysicsModuleKind,
  type PhysicsModuleDraft,
} from "./physicsShared";
import {
  applyThermalOrPbcStudyPatch,
  buildThermalElasticAndPbcRows,
} from "./ThermalAndTransportPhysicsSpecs";

export function PhysicsModuleInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionDiscretization = useSessionStatusSelector((status) =>
    resolveSessionDiscretization(status.data),
  );
  const activeLane = useActiveLaneCapabilities();
  const interactionDiscretization = normalizeInteractionDiscretization(
    sessionDiscretization,
  );
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const [helpOpen, setHelpOpen] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const modRef =
    selection.ref?.type === "physics-module" ? selection.ref : null;
  const selectedGraphModule = useMemo<PhysicsGraphModuleResource | null>(() => {
    const modules = physicsGraph.data?.modules ?? [];
    if (modRef?.physicsModuleId) {
      const exact = modules.find((m) => m.id === modRef.physicsModuleId);
      if (exact) return exact;
    }
    const candidateKind =
      modRef?.physicsModuleKind ?? selection.nodeId?.split(":module:").at(-1);
    if (!candidateKind) return null;
    return (
      modules.find((m) => {
        if (m.kind !== candidateKind) return false;
        if (selection.objectId) {
          return m.applies_to.some(
            (s) => "object_id" in s && s.object_id === selection.objectId,
          );
        }
        return true;
      }) ?? null
    );
  }, [
    modRef,
    physicsGraph.data?.modules,
    selection.nodeId,
    selection.objectId,
  ]);

  const rawKind =
    selectedGraphModule?.kind ??
    modRef?.physicsModuleKind ??
    selection.nodeId?.split(":module:").at(-1) ??
    selection.nodeId?.split(":").at(-1) ??
    "exchange";
  const moduleKind = resolveCanonicalPhysicsModuleKind(rawKind);
  const objectId = selection.objectId ?? null;
  const scopeKind: "global" | "object" =
    moduleKind === "rotated_interfacial_dmi" ||
    moduleKind === "zeeman" ||
    moduleKind === "thermal_noise" ||
    moduleKind === "periodic_bc" ||
    modRef?.physicsScopeKind === "global" ||
    !objectId
      ? "global"
      : "object";

  const restInteractionKind: ObjectInteractionKind =
    isRestFetchableInteractionKind(moduleKind) ? moduleKind : "exchange";
  const objectInteraction = useObjectInteractionResource(
    objectId,
    restInteractionKind,
    {
      enabled: Boolean(
        objectId &&
          scopeKind === "object" &&
          isRestFetchableInteractionKind(moduleKind) &&
          interactionDiscretization !== "unknown",
      ),
    },
  );

  const sceneObj = useMemo(
    () =>
      objectId ? scene.data?.objects?.find((o) => o.id === objectId) : undefined,
    [objectId, scene.data?.objects],
  );
  const mat = useMemo(() => {
    const ref = sceneObj?.material_ref;
    return ref ? scene.data?.materials?.find((m) => m.id === ref) : undefined;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const demagOptions = useMemo(() => {
    const specs = interactionSpecsForDiscretization(
      interactionDiscretization === "unknown"
        ? "fem"
        : interactionDiscretization,
    );
    const demagSpec = specs.find((s) => s.id === "demag");
    const fieldOpts = demagSpec?.fields.find((f) => f.id === "method")
      ?.options ?? [{ value: "auto", label: "Auto" }];
    const studyRec = asJsonRecord(scene.data?.study);
    const currentRealization =
      typeof studyRec?.demag_realization === "string" &&
      studyRec.demag_realization.trim()
        ? studyRec.demag_realization.trim()
        : "auto";
    if (!fieldOpts.some((o) => o.value === currentRealization)) {
      return [
        ...fieldOpts,
        {
          value: currentRealization,
          label: `${currentRealization} (incompatible with current lane)`,
        },
      ];
    }
    return fieldOpts;
  }, [interactionDiscretization, scene.data?.study]);

  const baseline = useMemo<PhysicsModuleDraft>(
    () =>
      hydratePhysicsModuleBaseline({
        matId: mat?.id,
        matProperties: mat?.properties,
        moduleKind,
        objectId,
        objectInteractionData: objectInteraction.data,
        objectInteractionStatus: objectInteraction.status,
        physicsActivation: modRef?.physicsActivation,
        physicsGraphModuleCount: physicsGraph.data?.modules?.length ?? 0,
        physicsGraphStatus: physicsGraph.status,
        physicsModuleId: modRef?.physicsModuleId,
        rawKind,
        sceneObj,
        sceneStudy: scene.data?.study,
        scopeKind,
        selectedGraphModule,
      }),
    [
      mat?.id,
      mat?.properties,
      modRef?.physicsActivation,
      modRef?.physicsModuleId,
      moduleKind,
      objectId,
      objectInteraction.data,
      objectInteraction.status,
      physicsGraph.data?.modules?.length,
      physicsGraph.status,
      rawKind,
      scene.data?.study,
      sceneObj,
      scopeKind,
      selectedGraphModule,
    ],
  );

  const evaluateConflictOrLaneError = useCallback(
    (d: PhysicsModuleDraft): string | null =>
      evaluatePhysicsModuleConflictOrLaneError(
        d,
        interactionDiscretization,
        activeLane,
        scene.data?.objects,
        scene.data?.study,
        scene.data?.materials,
      ),
    [
      activeLane,
      interactionDiscretization,
      scene.data?.materials,
      scene.data?.objects,
      scene.data?.study,
    ],
  );

  const spec = useMemo<InspectorSpec<PhysicsModuleDraft>>(() => {
    const isReadOnlyModule = baseline.moduleKind === null;
    const titleLabel = moduleTitleForKind(
      baseline.moduleKind,
      baseline.rawKind,
    );

    return {
      id: `physics.module.${baseline.moduleKind ?? baseline.rawKind}`,
      header: {
        breadcrumbs:
          scopeKind === "object" && objectId
            ? [
                {
                  id: "object",
                  label: baseline.objectName,
                  selection: buildObjectSelection(
                    objectId,
                    "object.root",
                    baseline.objectName,
                  ),
                },
                {
                  id: "physics",
                  label: "Physics",
                  selection: buildObjectSelection(
                    objectId,
                    "object.physics",
                    "Physics",
                  ),
                },
                { id: "module", label: titleLabel },
              ]
            : [
                {
                  id: "global",
                  label: "Global Physics",
                  selection: buildRootSelection(
                    "physics.scope.global",
                    "model:physics:global",
                    "Global Physics",
                  ),
                },
                { id: "module", label: titleLabel },
              ],
        searchable: false,
        extraMenuActions: [
          {
            id: "module-help",
            label: "Interaction help",
            icon: HelpCircle,
            onSelect: () => setHelpOpen(true),
          },
          {
            id: "refresh-module",
            label: "Refresh physics state",
            icon: RefreshCw,
            onSelect: () => {
              scene.refetch?.();
              physicsGraph.refetch?.();
              objectInteraction.refetch?.();
              setMutationError(null);
            },
          },
        ],
      },
      identity: {
        domain: "physics",
        icon: baseline.moduleKind === "thermal_noise" ? Thermometer : Atom,
        title: () => titleLabel,
        kindLabel:
          scopeKind === "object"
            ? "Object Hamiltonian term"
            : "Global Hamiltonian term",
        entityId: baseline.moduleId,
        statePill: (d) => {
          if (!d.present) return { tone: "neutral", label: "Not in stack" };
          return d.enabled
            ? { tone: "ok", label: "Active" }
            : { tone: "degraded", label: "Disabled" };
        },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "scope",
          label: "Scope",
          value:
            d.provenance?.appliesToSummary ??
            (d.scopeKind === "object" ? d.objectName : "Global"),
        },
        {
          id: "family",
          label: "Operator",
          value: (d.moduleKind ?? d.rawKind).replace(/_/g, " "),
        },
        ...(d.provenance
          ? [
              {
                id: "activation",
                label: "Graph state",
                value: d.provenance.activation,
                tone:
                  d.provenance.activation === "active"
                    ? ("ok" as const)
                    : ("warn" as const),
              },
            ]
          : []),
      ],
      notices: (d): readonly InspectorNotice<PhysicsModuleDraft>[] => {
        const list: InspectorNotice<PhysicsModuleDraft>[] = [];
        if (d.missingFromGraph) {
          list.push({
            id: "missing-graph-module",
            tone: "warn",
            title: "Module absent from current physics graph",
            text: "The selected physics module is no longer present in the current graph revision.",
          });
        }
        const gateErr = evaluateConflictOrLaneError(d);
        if (gateErr) {
          list.push({
            id: "lane-or-conflict-error",
            tone: d.moduleKind === "magnetoelastic" ? "warn" : "err",
            text: gateErr,
          });
        }
        if (mutationError) {
          list.push({
            id: "mutation-error",
            tone: "err",
            text: mutationError,
            quickFix: {
              label: "Refresh scene",
              onApply: () => {
                scene.refetch?.();
                objectInteraction.refetch?.();
                setMutationError(null);
              },
            },
          });
        }
        return list;
      },
      sections: [
        ...(isReadOnlyModule
          ? []
          : [
              {
                id: "physics-module-params",
                title: "Interaction parameters",
                icon: Compass,
                defaultOpen: true,
                rows: [
                  {
                    key: "present" as const,
                    type: "switch" as const,
                    label: "Present in object physics stack",
                    structural: true,
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.scopeKind === "object" &&
                      !isRequiredModuleKind(d.moduleKind, d.scopeKind),
                    disabledReason: (d: PhysicsModuleDraft) =>
                      isRequiredModuleKind(d.moduleKind, d.scopeKind)
                        ? "Required interaction cannot be removed."
                        : null,
                  },
                  {
                    key: "enabled" as const,
                    type: "switch" as const,
                    label: "Enable Hamiltonian term",
                    structural: true,
                    disabledReason: (d: PhysicsModuleDraft) =>
                      !d.present
                        ? "Enable 'Present in object physics stack' first."
                        : null,
                  },
                  ...buildExchangeAndDmiRows(),
                  ...buildDemagRows(demagOptions, interactionDiscretization),
                  ...buildAnisotropyAndZeemanRows(),
                  ...buildThermalElasticAndPbcRows(scene.data?.study),
                ],
                footer: renderCubicAnisotropyFooter,
              },
            ]),
        {
          id: "physics-module-provenance",
          title: "Graph provenance & dependencies",
          icon: GitBranch,
          defaultOpen: isReadOnlyModule,
          showWhen: (d) => d.provenance !== null || isReadOnlyModule,
          rows: [
            {
              type: "readonly",
              label: "Module ID",
              mono: true,
              format: (d) => d.provenance?.id ?? d.moduleId,
            },
            {
              type: "readonly",
              label: "Source path",
              mono: true,
              showWhen: (d) => Boolean(d.provenance?.sourcePath),
              format: (d) => d.provenance?.sourcePath ?? "",
            },
            {
              type: "readonly",
              label: "Applies to",
              format: (d) =>
                d.provenance?.appliesToSummary ??
                (d.scopeKind === "object"
                  ? `Object · ${d.objectName}`
                  : "Global"),
            },
            {
              type: "readonly",
              label: "Activation",
              format: (d) =>
                d.provenance?.activation ?? (d.enabled ? "active" : "inactive"),
            },
            {
              type: "readonly",
              label: "Capability",
              showWhen: (d) => Boolean(d.provenance?.capabilitySummary),
              format: (d) => d.provenance?.capabilitySummary ?? "",
            },
            {
              type: "chips",
              label: "Depends on",
              showWhen: (d) => (d.provenance?.dependsOn.length ?? 0) > 0,
              items: (d) =>
                (d.provenance?.dependsOn ?? []).map((depId) => ({
                  id: depId,
                  label: depId,
                })),
            },
            {
              type: "readonly",
              label: "Depends on",
              showWhen: (d) => (d.provenance?.dependsOn.length ?? 0) === 0,
              format: () => "Independent (no upstream dependencies)",
            },
          ],
        },
        {
          id: "physics-module-formulation",
          title: "Variational effective-field operator",
          icon: BookOpen,
          defaultOpen: false,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="fm-math-equation rounded border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
                  {effectiveFieldMath}
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: isReadOnlyModule
        ? {
            mode: "readOnly",
            statusMessage: () => "Read-only physics graph module projection",
          }
        : {
            mode: "staged",
            cleanMessage: () => "Hamiltonian module parameters match ProblemIR",
            lockReason: (d) => evaluateConflictOrLaneError(d),
            onApply: async (draft, base) => {
              const gateError = evaluateConflictOrLaneError(draft);
              if (gateError) {
                setMutationError(gateError);
                return false;
              }
              setMutationError(null);

              const rawSceneRev = resolveSceneResourceRevision(scene.data);
              const sceneBaseRevision =
                rawSceneRev !== null && Number.isFinite(Number(rawSceneRev))
                  ? Number(rawSceneRev)
                  : null;

              try {
                if (
                  draft.scopeKind === "object" &&
                  draft.objectId &&
                  draft.moduleKind
                ) {
                  const targetObjId = draft.objectId;
                  const targetKind = draft.moduleKind as ObjectInteractionKind;

                  if (!draft.present) {
                    await runAuthoringMutationWithHistory(
                      {
                        api: kernel.api,
                        authoringHistory: kernel.authoringHistory,
                        sessionScopeKey,
                      },
                      `Remove ${titleLabel}`,
                      async ({ baseRevision }) => {
                        const rev = await commitObjectInteractionMutation({
                          interactionKind: targetKind,
                          objectId: targetObjId,
                          patch: () =>
                            kernel.api.model.patchObjectInteraction(
                              targetObjId,
                              targetKind,
                              {
                                base_revision:
                                  baseRevision ??
                                  objectInteraction.data?.scene_revision ??
                                  sceneBaseRevision,
                                present: false,
                              },
                              sessionScopeKey ? { sessionScopeKey } : undefined,
                            ),
                          resources: kernel.resources,
                        });
                        kernel.resources.invalidate(
                          MODEL_PHYSICS_GRAPH_PATH,
                          rev,
                        );
                        return rev;
                      },
                    );
                    return true;
                  }

                  if (draft.moduleKind === "exchange") {
                    await runAuthoringMutationWithHistory(
                      {
                        api: kernel.api,
                        authoringHistory: kernel.authoringHistory,
                        sessionScopeKey,
                      },
                      "Exchange interaction",
                      async ({ baseRevision }) => {
                        let currentRev =
                          baseRevision ??
                          objectInteraction.data?.scene_revision ??
                          sceneBaseRevision;
                        if (mat?.id && draft.aex !== base.aex) {
                          const matOptions = authoringWriteOptions(
                            currentRev,
                            sessionScopeKey,
                          );
                          const matResp =
                            await kernel.api.model.patchMaterialAsset(
                              mat.id,
                              {
                                properties: {
                                  ...(asJsonRecord(mat.properties) ?? {}),
                                  Aex: draft.aex,
                                },
                              },
                              matOptions,
                            );
                          currentRev =
                            acknowledgedAuthoringSceneRevision(matResp);
                          publishCommittedSceneResource(
                            kernel.resources,
                            matResp.committed_scene,
                            currentRev,
                            undefined,
                            true,
                            sessionScopeKey,
                            kernel.api.resourceCacheScope,
                          );
                          kernel.resources.invalidate(
                            resolveMaterialResourceKey(mat.id),
                            currentRev,
                          );
                          invalidateAuthoringMutationDependents(
                            kernel.resources,
                            "material",
                            currentRev,
                          );
                        }
                        return commitObjectExchangeMutation({
                          objectId: targetObjId,
                          enabled: draft.enabled,
                          baseRevision: currentRev,
                          studyRec: asJsonRecord(scene.data?.study),
                          sceneObjects: scene.data?.objects,
                          sceneMaterials: scene.data?.materials,
                          sessionScopeKey,
                          api: kernel.api,
                          resources: kernel.resources,
                        });
                      },
                    );
                    return true;
                  }

                  const params: JsonObject =
                    buildAnisotropyObjectParams(draft) ??
                    buildExchangeOrDmiObjectParams(draft) ??
                    {};

                  await runAuthoringMutationWithHistory(
                    {
                      api: kernel.api,
                      authoringHistory: kernel.authoringHistory,
                      sessionScopeKey,
                    },
                    `${titleLabel} interaction`,
                    async ({ baseRevision }) => {
                      const rev = await commitObjectInteractionMutation({
                        interactionKind: targetKind,
                        objectId: targetObjId,
                        patch: () =>
                          kernel.api.model.patchObjectInteraction(
                            targetObjId,
                            targetKind,
                            {
                              base_revision:
                                baseRevision ??
                                objectInteraction.data?.scene_revision ??
                                sceneBaseRevision,
                              enabled: draft.enabled,
                              present: true,
                              params,
                            },
                            sessionScopeKey ? { sessionScopeKey } : undefined,
                          ),
                        resources: kernel.resources,
                      });
                      kernel.resources.invalidate(
                        MODEL_PHYSICS_GRAPH_PATH,
                        rev,
                      );
                      return rev;
                    },
                  );
                  return true;
                }

                const studyRec = asJsonRecord(scene.data?.study);
                const studyPatch: JsonObject = {};
                void (
                  applyExchangeOrDmiStudyPatch(draft, studyRec, studyPatch) ||
                  applyDemagStudyPatch(draft, studyPatch) ||
                  applyZeemanStudyPatch(draft, studyPatch) ||
                  applyThermalOrPbcStudyPatch(draft, studyPatch)
                );

                await runAuthoringMutationWithHistory(
                  {
                    api: kernel.api,
                    authoringHistory: kernel.authoringHistory,
                    sessionScopeKey,
                  },
                  `${titleLabel} interaction`,
                  async ({ baseRevision }) => {
                    const tx = await kernel.api.model.commitTransaction(
                      {
                        kind: "merge_patch",
                        base_revision: baseRevision ?? sceneBaseRevision ?? 0,
                        merge_patch: { study: studyPatch },
                      },
                      sessionScopeKey ? { sessionScopeKey } : undefined,
                    );
                    const rev = acknowledgedAuthoringSceneRevision(tx);
                    publishCommittedSceneResource(
                      kernel.resources,
                      tx.committed_scene,
                      rev,
                      undefined,
                      true,
                      sessionScopeKey,
                      kernel.api.resourceCacheScope,
                    );
                    invalidateAuthoringMutationDependents(
                      kernel.resources,
                      "interaction",
                      rev,
                    );
                    kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
                    return tx;
                  },
                );
                return true;
              } catch (error) {
                if (isRevisionConflict(error)) {
                  scene.refetch?.();
                  objectInteraction.refetch?.();
                  setMutationError(
                    "Scene changed while applying this interaction. Draft preserved; scene refetched. Review and retry.",
                  );
                  return false;
                }
                setMutationError(errorMessage(error));
                return false;
              }
            },
            onRevert: () => setMutationError(null),
          },
    };
  }, [
    baseline.moduleId,
    baseline.moduleKind,
    baseline.objectName,
    baseline.rawKind,
    demagOptions,
    evaluateConflictOrLaneError,
    interactionDiscretization,
    kernel.api,
    kernel.authoringHistory,
    kernel.resources,
    mat,
    mutationError,
    objectId,
    objectInteraction,
    physicsGraph,
    scene,
    scopeKind,
    sessionScopeKey,
  ]);

  return (
    <>
      <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />
      <PhysicsInteractionHelpDialog
        content={buildModuleHelpContent(
          baseline.moduleKind ?? baseline.rawKind,
          objectId,
        )}
        open={helpOpen}
        onOpenChange={setHelpOpen}
      />
    </>
  );
}
