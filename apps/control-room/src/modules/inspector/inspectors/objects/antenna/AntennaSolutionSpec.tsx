"use client";

import {
  Cpu,
  Layers,
  Link2,
  Play,
  PlusCircle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useAntennaFieldSolutionResource,
  useAntennaStageOutputCatalogResource,
} from "@/kernel/resources/antennaResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND,
  antennaFieldSolveStudyReference,
} from "@/kernel/runtime/antennaFieldSolveStudyCommand";
import { antennaStageValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  antennaFieldSolutionIdentityStatus,
  resolveAntennaRuntimeIds,
} from "../../../panels/antenna/AntennaCompositionRuntime";
import {
  RadixAntennaProjectionDriveComposer,
  RadixAntennaSpectrumComposer,
  RadixAntennaStudyStageComposer,
  RadixRelatedResources,
} from "../../../panels/antenna/AntennaExcitationComposers";
import { AntennaExternalLeadInspectionPanel } from "../../../panels/antenna/AntennaExternalLeadInspectionPanel";
import { AntennaFieldBasisPreview } from "../../../panels/antenna/AntennaFieldBasisPreview";
import {
  antennaSamplingDomainOptions,
  antennaSolveTargetKey,
  antennaSolveTargetOptions,
  antennaVectorPotentialSelectable,
} from "../../../panels/antenna/AntennaSolveTargetsEditorModel";
import {
  asNumber,
  asRecord,
  asString,
  canonicalResourceSelection,
  executeAntennaMergePatchTransaction,
  type JsonRecord,
  resolveSelectedAntennaResourceId,
  resolveSelectedObjectId,
} from "./antennaExcitationShared";

interface AntennaSolutionDraft {
  oerstedRealization: "direct_tetra_quadrature" | "vector_potential_solver";
  samplingDomainKey: string;
  conductorMeshPolicy: string;
  solverPolicy: string;
  gaugePolicy: "zero_mean" | "terminal_reference";
  linearSolver: "cg" | "direct";
  relativeTolerance: number;
  targetKeys: readonly string[];
}

export function AntennaSolutionInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const requestedStageId = resolveSelectedAntennaResourceId(
    selection,
    "stageId",
    ":solution:",
  );

  const solveStageTyped = useMemo(() => {
    const stages = scene.data?.antenna_field_solve_stages ?? [];
    if (requestedStageId) {
      return stages.find((s) => s.id === requestedStageId) ?? null;
    }
    return stages.find((s) => s.source_object_id === objectId) ?? null;
  }, [objectId, requestedStageId, scene.data]);

  const solveStageRec = asRecord(solveStageTyped);
  const stageId =
    asString(solveStageRec?.id) ?? requestedStageId ?? "solve_1";

  const runtimeIds = useMemo(
    () => resolveAntennaRuntimeIds("solution", stageId, scene.data),
    [scene.data, stageId],
  );

  const solutionOutputId = useMemo(() => {
    if (runtimeIds.solutionId) return runtimeIds.solutionId;
    const outs = Array.isArray(solveStageRec?.outputs)
      ? solveStageRec.outputs
      : [];
    const basisOut = outs
      .map(asRecord)
      .find((o) => asString(o?.quantity) === "H_ant_basis");
    return asString(basisOut?.id) ?? asString(asRecord(outs[0])?.id);
  }, [runtimeIds.solutionId, solveStageRec]);

  const fieldSolutionRes = useAntennaFieldSolutionResource(solutionOutputId, {
    enabled: Boolean(solutionOutputId),
  });
  const stageCatalogRes = useAntennaStageOutputCatalogResource(
    runtimeIds.stageId ?? stageId,
    { enabled: Boolean(stageId) },
  );

  const samplingOptions = useMemo(
    () => antennaSamplingDomainOptions(scene.data),
    [scene.data],
  );
  const allTargetOptions = useMemo(
    () => antennaSolveTargetOptions(scene.data),
    [scene.data],
  );
  const selectableDestinationOptions = useMemo(() => {
    const filtered = allTargetOptions.filter(
      (opt) =>
        opt.target.kind === "global" || opt.target.object_id !== objectId,
    );
    return filtered.length > 0 ? filtered : allTargetOptions;
  }, [allTargetOptions, objectId]);

  const vectorPotentialSelectable = useMemo(
    () =>
      antennaVectorPotentialSelectable(
        scene.data,
        solveStageTyped ?? undefined,
      ),
    [scene.data, solveStageTyped],
  );

  const matchingTransport = useMemo(() => {
    const transportId = asString(solveStageRec?.current_transport_id);
    if (!transportId) return null;
    return (
      (scene.data?.current_transports ?? [])
        .map(asRecord)
        .find((ct) => asString(ct?.name) === transportId) ?? null
    );
  }, [scene.data, solveStageRec]);

  const baseline = useMemo<AntennaSolutionDraft>(() => {
    const rawRealization = asString(solveStageRec?.oersted_realization);
    const oerstedRealization: AntennaSolutionDraft["oerstedRealization"] =
      rawRealization === "vector_potential_solver"
        ? "vector_potential_solver"
        : "direct_tetra_quadrature";

    const domainTarget = solveStageTyped?.field_sampling_domain;
    const defaultDomainKey =
      samplingOptions.find(
        (o) => o.target.kind === "object" && o.target.object_id !== objectId,
      )?.key ??
      samplingOptions[0]?.key ??
      antennaSolveTargetKey({ kind: "global" });
    const samplingDomainKey = domainTarget
      ? antennaSolveTargetKey(domainTarget)
      : defaultDomainKey;

    const rawTargetRefs = Array.isArray(solveStageTyped?.target_refs)
      ? solveStageTyped.target_refs
      : [];
    const targetKeys =
      rawTargetRefs.length > 0
        ? rawTargetRefs.map((t) => antennaSolveTargetKey(t))
        : selectableDestinationOptions[0]
          ? [selectableDestinationOptions[0].key]
          : [];

    const solverRec = asRecord(matchingTransport?.solver);
    const linearRec = asRecord(solverRec?.linear);
    const engineStr = asString(solverRec?.engine);
    const gaugeStr = asString(matchingTransport?.gauge);

    return {
      conductorMeshPolicy:
        asString(solveStageRec?.conductor_mesh_policy) ??
        "shared_domain_conforming",
      gaugePolicy:
        gaugeStr === "terminal_reference" ? "terminal_reference" : "zero_mean",
      linearSolver: engineStr === "direct" ? "direct" : "cg",
      oerstedRealization,
      relativeTolerance:
        asNumber(linearRec?.relative_tolerance) ??
        asNumber(solveStageRec?.relative_tolerance) ??
        1e-10,
      samplingDomainKey,
      solverPolicy:
        asString(solveStageRec?.solver_policy) ?? "fem_cpu_double_reference",
      targetKeys,
    };
  }, [
    matchingTransport,
    objectId,
    samplingOptions,
    selectableDestinationOptions,
    solveStageRec,
    solveStageTyped,
  ]);

  const stageDependents = useMemo(() => {
    const deps: string[] = [];
    for (const proj of scene.data?.antenna_target_projections ?? []) {
      if (proj.solution.stage_id === stageId) deps.push(`projection:${proj.id}`);
    }
    for (const specReq of scene.data?.antenna_spectrum_requests ?? []) {
      if (specReq.solution_ref.stage_id === stageId) {
        deps.push(`spectrum:${specReq.id}`);
      }
    }
    return deps;
  }, [scene.data, stageId]);

  const relatedSelection = useMemo(
    () => canonicalResourceSelection(selection, objectId, "solution", stageId),
    [objectId, selection, stageId],
  );

  const meshPolicyOptions = useMemo(() => {
    const base = [
      {
        label: "Shared-Domain Conforming (shared_domain_conforming)",
        value: "shared_domain_conforming",
      },
      {
        label: "Authored Shared-Domain (authored_shared_domain)",
        value: "authored_shared_domain",
      },
      {
        label: "Independent Conductor Object (independent_object)",
        value: "independent_object",
      },
    ];
    if (!base.some((b) => b.value === baseline.conductorMeshPolicy)) {
      base.push({
        label: baseline.conductorMeshPolicy,
        value: baseline.conductorMeshPolicy,
      });
    }
    return base;
  }, [baseline.conductorMeshPolicy]);

  const solverPolicyOptions = useMemo(() => {
    const base = [
      {
        label: "FEM CPU FP64 Reference (fem_cpu_double_reference)",
        value: "fem_cpu_double_reference",
      },
      {
        label: "Production Default (production_default)",
        value: "production_default",
      },
    ];
    if (!base.some((b) => b.value === baseline.solverPolicy)) {
      base.push({ label: baseline.solverPolicy, value: baseline.solverPolicy });
    }
    return base;
  }, [baseline.solverPolicy]);

  const runAntennaFieldSolve = useCallback(async () => {
    const portModeId = solveStageTyped?.port_mode_ids?.[0];
    const studyRef =
      scene.data && solveStageTyped
        ? antennaFieldSolveStudyReference(scene.data, {
            objectId,
            portModeId,
            stageId,
          })
        : null;
    if (studyRef?.state === "present") {
      await kernel.commands.execute(
        "study.execute-stage",
        createCommandContext("inspector", kernel, {
          input: { stageId: studyRef.queueId, stageIndex: studyRef.index },
          resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
          sessionScopeKey,
          sourceDetail: "object.antenna.solution",
        }),
      );
      return;
    }
    await kernel.commands.execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      input: {
        objectId,
        ...(portModeId ? { portModeId } : {}),
        stageId,
      },
      resources: kernel.resources,
      selection: kernel.selection,
      sessionScopeKey,
      source: "inspector",
    });
  }, [kernel, objectId, scene.data, sessionScopeKey, solveStageTyped, stageId]);

  const spec = useMemo<InspectorSpec<AntennaSolutionDraft>>(
    () => ({
      id: "object.antenna.solution",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "solution", label: `Field Solve (${stageId})` },
        ],
        deleteAction: solveStageTyped
          ? {
              confirmDescription:
                stageDependents.length > 0
                  ? `Cannot remove while referenced by: ${stageDependents.join(", ")}.`
                  : "Removes this antenna field-solve stage definition without cascading deletion.",
              confirmTitle: () => `Remove solve stage ${stageId}?`,
              label: "Remove solve stage (no cascade)",
              onDelete: async () => {
                if (stageDependents.length > 0) {
                  throw new Error(
                    `Removal refused until dependents are rebound or removed: ${stageDependents.join(", ")}.`,
                  );
                }
                const baseRev =
                  asNumber(sceneRec?.revision) ??
                  asNumber(sceneRec?.scene_revision) ??
                  0;
                const remaining = (
                  scene.data?.antenna_field_solve_stages ?? []
                ).filter((s) => s.id !== stageId);
                await executeAntennaMergePatchTransaction({
                  baseRevision: baseRev,
                  kernel,
                  label: `Remove antenna solve stage ${stageId}`,
                  mergePatch: {
                    antenna_field_solve_stages:
                      remaining as unknown as JsonObject[],
                  },
                  scene: scene.data ?? null,
                  sessionScopeKey,
                });
              },
            }
          : undefined,
        primaryHeaderAction: {
          icon: Play,
          label: "Solve antenna visualization",
          onRun: runAntennaFieldSolve,
        },
      },
      identity: {
        domain: "physics",
        entityId: `sol:${stageId}`,
        icon: Cpu,
        kindLabel: "Quasi-static J & Oersted field basis",
        statePill: () =>
          fieldSolutionRes.data
            ? { label: "Qualified", tone: "ok" }
            : { label: "Solve required", tone: "warn" },
        title: () => `Antenna Field Solver (${stageId})`,
      },
      facts: (d) => [
        {
          id: "model",
          label: "Oersted model",
          value:
            d.oerstedRealization === "direct_tetra_quadrature"
              ? "Biot-Savart 3D"
              : "FEM A-V",
        },
        {
          id: "targets",
          label: "Targets",
          value: `${d.targetKeys.length} assigned`,
        },
        {
          id: "tol",
          label: "CG tolerance",
          value: d.relativeTolerance.toExponential(0),
        },
        {
          id: "status",
          label: "div J = 0",
          tone: fieldSolutionRes.data ? "ok" : undefined,
          value: fieldSolutionRes.data ? "Verified" : null,
        },
      ],
      notices: (): readonly InspectorNotice<AntennaSolutionDraft>[] => {
        if (!solveStageTyped || !scene.data) return [];
        const messages = antennaStageValidationMessages(
          solveStageTyped,
          scene.data,
        );
        return messages.map((msg, idx) => ({
          id: `stage-val-${idx}`,
          text: msg,
          title: "Stage validation requirement",
          tone: "warn" as const,
        }));
      },
      modeTabs: [
        { commitModeOverride: "staged", id: "setup", label: "Solver & Composers" },
        {
          commitModeOverride: "readOnly",
          id: "diagnostics",
          label: "Inspection & Basis",
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Cpu,
          id: "solver-config",
          modeTabId: "setup",
          rows: [
            {
              key: "oerstedRealization",
              label: "Oersted realization",
              options: [
                {
                  label: "Direct Tetrahedral Biot-Savart Quadrature (3D)",
                  value: "direct_tetra_quadrature",
                },
                {
                  disabledReason: vectorPotentialSelectable
                    ? undefined
                    : "Vector potential is not supported for current-driven or closed-loop sources; use direct tetrahedral quadrature.",
                  label: "Coupled FEM Vector Potential ∇×(μ₀⁻¹∇×A) = J",
                  value: "vector_potential_solver",
                },
              ],
              structural: true,
              type: "select",
            },
            {
              key: "samplingDomainKey",
              label: "Field sampling domain",
              options:
                samplingOptions.length > 0
                  ? samplingOptions.map((o) => ({
                      label: o.label,
                      value: o.key,
                    }))
                  : [
                      {
                        label: "Global",
                        value: antennaSolveTargetKey({ kind: "global" }),
                      },
                    ],
              type: "select",
            },
            {
              key: "conductorMeshPolicy",
              label: "Mesh target policy",
              options: meshPolicyOptions,
              type: "select",
            },
            {
              key: "solverPolicy",
              label: "Solver policy",
              options: solverPolicyOptions,
              type: "select",
            },
            {
              key: "gaugePolicy",
              label: "Electric potential gauge",
              options: [
                { label: "Zero-mean potential (∫V dΩ = 0)", value: "zero_mean" },
                {
                  label: "Terminal reference (V_ref = 0)",
                  value: "terminal_reference",
                },
              ],
              type: "segmented",
            },
            {
              key: "linearSolver",
              label: "Linear charge solver (∇·σ∇V = 0)",
              options: [
                { label: "Conjugate Gradient + AMG (cg)", value: "cg" },
                { label: "Sparse Direct LU / Cholesky (direct)", value: "direct" },
              ],
              type: "select",
            },
            {
              key: "relativeTolerance",
              label: "Relative tolerance",
              max: 1e-5,
              min: 1e-14,
              scrub: "log",
              symbol: (
                <>
                  &epsilon;<sub>CG</sub>
                </>
              ),
              type: "number",
            },
          ],
          title: "Charge & Oersted field solver",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "destination-targets",
          modeTabId: "setup",
          rows: [
            {
              key: "targetKeys",
              label: "Field destination targets",
              options:
                selectableDestinationOptions.length > 0
                  ? selectableDestinationOptions.map((o) => ({
                      label: o.label,
                      value: o.key,
                    }))
                  : [
                      {
                        label: "Global",
                        value: antennaSolveTargetKey({ kind: "global" }),
                      },
                    ],
              type: "toggles",
              validate: (val) =>
                val.length === 0
                  ? "Select at least one field destination target."
                  : null,
            },
          ],
          title: "Field destination targets",
        },
        {
          defaultOpen: true,
          icon: Play,
          id: "study-stage-composer",
          live: true,
          modeTabId: "setup",
          rows: [
            {
              render: () => (
                <RadixAntennaStudyStageComposer
                  objectId={objectId}
                  scene={scene.data ?? null}
                  sceneScopeKey={scene.sessionScopeKey ?? scope}
                  stageId={stageId}
                  status={scene.status}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Add field solve to Study",
        },
        {
          defaultOpen: false,
          icon: PlusCircle,
          id: "projection-drive-composer",
          live: true,
          modeTabId: "setup",
          rows: [
            {
              render: () => (
                <RadixAntennaProjectionDriveComposer
                  refetch={scene.refetch}
                  scene={scene.data ?? null}
                  sceneScopeKey={scene.sessionScopeKey ?? scope}
                  stageId={stageId}
                  status={scene.status}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Create antenna projection & drive",
        },
        {
          defaultOpen: false,
          icon: Sparkles,
          id: "spectrum-composer",
          live: true,
          modeTabId: "setup",
          rows: [
            {
              render: () => (
                <RadixAntennaSpectrumComposer
                  refetch={scene.refetch}
                  scene={scene.data ?? null}
                  sceneScopeKey={scene.sessionScopeKey ?? scope}
                  stageId={stageId}
                  status={scene.status}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Author structured spatial FFT",
        },
        {
          defaultOpen: false,
          icon: Link2,
          id: "related-resources",
          live: true,
          rows: [
            {
              render: () => (
                <RadixRelatedResources
                  available={scene.status === "ready"}
                  scene={scene.data ?? null}
                  scope={scene.sessionScopeKey ?? scope}
                  selection={relatedSelection}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Related antenna resources",
        },
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "convergence-diagnostics",
          modeTabId: "diagnostics",
          rows: [
            {
              format: () =>
                antennaFieldSolutionIdentityStatus(
                  runtimeIds,
                  fieldSolutionRes,
                  stageCatalogRes,
                ),
              label: "Runtime basis identity",
              type: "readonly",
            },
            {
              format: () =>
                stageCatalogRes.data
                  ? `${stageCatalogRes.data.status} (rev ${stageCatalogRes.data.stage_revision})`
                  : "Not published yet",
              label: "Stage output catalog",
              type: "readonly",
            },
            {
              format: () => String(fieldSolutionRes.data?.bases.length ?? 0),
              label: "Published port-mode bases",
              type: "readonly",
            },
            {
              render: () => (
                <div className="fm-inspector-stack">
                  <AntennaExternalLeadInspectionPanel authoredStageId={stageId} />
                  {fieldSolutionRes.data?.sample_positions ? (
                    <AntennaFieldBasisPreview
                      key={fieldSolutionRes.data.asset_id}
                      solution={fieldSolutionRes.data}
                    />
                  ) : null}
                </div>
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Quasi-static inspection & published basis",
        },
      ],
      details: () => [
        { label: "Stage ID", mono: true, value: stageId },
        {
          label: "Current transport",
          mono: true,
          value: asString(solveStageRec?.current_transport_id) ?? null,
        },
        {
          label: "Physical model",
          mono: true,
          value: asString(solveStageRec?.model) ?? null,
        },
        {
          label: "Solution ID",
          mono: true,
          value: fieldSolutionRes.data?.solution_id ?? null,
        },
        {
          label: "Asset ID",
          mono: true,
          value: fieldSolutionRes.data?.asset_id ?? null,
        },
        {
          label: "Content digest",
          mono: true,
          value: fieldSolutionRes.data?.content_digest ?? null,
        },
      ],
      commitBar: {
        cleanMessage: () => "Solver setup & target destinations are synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;
          const resolvedSampling =
            samplingOptions.find((o) => o.key === draft.samplingDomainKey)
              ?.target ?? ({ kind: "global" } as const);
          const resolvedTargets = draft.targetKeys
            .map(
              (k) =>
                allTargetOptions.find((o) => o.key === k)?.target ?? null,
            )
            .filter(
              (
                t,
              ): t is NonNullable<
                SceneResource["antenna_field_solve_stages"]
              >[number]["target_refs"][number] => t !== null,
            );
          const existingStages = Array.isArray(
            sceneRec?.antenna_field_solve_stages,
          )
            ? sceneRec.antenna_field_solve_stages
            : [];
          const baseStage: JsonRecord = solveStageRec
            ? { ...solveStageRec }
            : {
                current_transport_id: `${objectId}:current`,
                model: "quasistatic_conduction_biot_savart3d",
                outputs: [
                  { id: `${objectId}:field-solution`, quantity: "H_ant_basis" },
                ],
                port_mode_ids: [],
              };
          delete baseStage.linear_solver;
          delete baseStage.quadrature_order;
          delete baseStage.relative_tolerance;
          delete baseStage.sampling_domain;

          const nextStage: JsonObject = {
            ...baseStage,
            conductor_mesh_policy: draft.conductorMeshPolicy,
            field_sampling_domain: resolvedSampling,
            id: stageId,
            oersted_realization: draft.oerstedRealization,
            solver_policy: draft.solverPolicy,
            source_object_id: objectId,
            target_refs:
              resolvedTargets.length > 0
                ? resolvedTargets
                : [{ kind: "global" }],
          } as JsonObject;

          const patchedStages = solveStageRec
            ? existingStages.map((s) =>
                asString(asRecord(s)?.id) === stageId ? nextStage : s,
              )
            : [...existingStages, nextStage];

          const mergePatch: JsonObject = {
            antenna_field_solve_stages: patchedStages as JsonObject[],
          };

          if (matchingTransport && Array.isArray(sceneRec?.current_transports)) {
            const transportName = asString(matchingTransport.name);
            mergePatch.current_transports = sceneRec.current_transports.map(
              (ct) => {
                const ctRec = asRecord(ct);
                if (!ctRec || asString(ctRec.name) !== transportName) {
                  return ct as JsonObject;
                }
                const prevSolver = asRecord(ctRec.solver) ?? {};
                const prevLinear = asRecord(prevSolver.linear) ?? {};
                return {
                  ...ctRec,
                  gauge: draft.gaugePolicy,
                  solver: {
                    ...prevSolver,
                    engine: draft.linearSolver,
                    linear: {
                      ...prevLinear,
                      relative_tolerance: draft.relativeTolerance,
                    },
                  },
                } as JsonObject;
              },
            );
          }

          await executeAntennaMergePatchTransaction({
            baseRevision: baseRev,
            kernel,
            label: `Edit antenna field-solve stage ${stageId}`,
            mergePatch,
            scene: scene.data ?? null,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      allTargetOptions,
      fieldSolutionRes,
      kernel,
      matchingTransport,
      meshPolicyOptions,
      objectId,
      relatedSelection,
      runAntennaFieldSolve,
      runtimeIds,
      samplingOptions,
      scene.data,
      scene.refetch,
      scene.sessionScopeKey,
      scene.status,
      sceneRec,
      scope,
      selectableDestinationOptions,
      sessionScopeKey,
      solveStageRec,
      solveStageTyped,
      solverPolicyOptions,
      stageCatalogRes,
      stageDependents,
      stageId,
      vectorPotentialSelectable,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
