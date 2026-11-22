"use client";

import {
  Activity,
  Cpu,
  Eye,
  Gauge,
  Layers,
  Link2,
  Play,
  PlusCircle,
  Radio,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Video,
  Waves,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  BinaryResourceResult,
  FieldDriveCreateRequest,
  FieldDriveReplaceRequest,
  JsonObject,
  MaskFieldDriveCreateRequest,
  MaskFieldDriveReplaceRequest,
  MaskFieldDriveResource,
  MaskTermResource,
  ReadyAntennaTermsRequest,
  RegionalFieldDriveResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { antennaSpectrumPayloadByteLengths } from "@/kernel/api/codecs/antennaSpectrumManifestCodec";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { closedLoopManifest } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import {
  antennaInspectionDisplayMatchesOwner,
  antennaSpectrumPayloadEtag,
  useAntennaExternalLeadInspectionResource,
  useAntennaFieldSolutionResource,
  useAntennaInspectionDisplayResource,
  useAntennaSourceSpectrumPayloadResource,
  useAntennaSourceSpectrumResource,
  useAntennaStageOutputCatalogResource,
} from "@/kernel/resources/antennaResources";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND,
  antennaFieldSolveStudyReference,
} from "@/kernel/runtime/antennaFieldSolveStudyCommand";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type {
  AntennaFieldIntent,
  AntennaFieldQuantity,
} from "@/kernel/visualization/antennaFieldIntent";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { antennaRegionalSources } from "@/shared/domain/physics/antennaRegionalSource";
import {
  antennaResourceOwner,
  type AntennaOwnedResourceKind,
} from "@/shared/domain/physics/antennaResourceOwner";
import { antennaStageValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorPropertyRow } from "../../primitives/InspectorPropertyRow";
import type { InspectorNotice, InspectorSpec, UnitOption } from "../../template";
import {
  VisualizationDisplayPassesControl,
  VisualizationRenderModeControl,
  type VisualizationRenderModeValue,
} from "../../visualization/VisualizationInspectorControls";
import {
  antennaWaveformDefaults,
  buildAntennaLegacyMigrationPatch,
  resolveAntennaObjectDraft,
} from "../AntennaObjectPanelModel";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";
import { AntennaArtifactVisualization } from "./AntennaArtifactVisualization";
import { AntennaCameraControls } from "./AntennaCameraControls";
import { AntennaClippingControls } from "./AntennaClippingControls";
import {
  antennaFieldSolutionIdentityStatus,
  resolveAntennaRuntimeIds,
} from "./AntennaCompositionRuntime";
import {
  antennaDriveBindingKey,
  antennaDriveBindingOptions,
  validateAntennaDriveBinding,
} from "./AntennaDriveBindingsModel";
import {
  defaultDrivePreviewRange,
  MAX_DRIVE_PREVIEW_POINTS,
  sampleAntennaDrive,
} from "./AntennaDrivePreviewModel";
import {
  RadixAntennaColorRangeControl,
  RadixAntennaProjectionDriveComposer,
  RadixAntennaSpectrumComposer,
  RadixAntennaStudyStageComposer,
  RadixRelatedResources,
  RadixSamplingPlaneFields,
  RadixSamplingResolution,
} from "./AntennaExcitationComposers";
import {
  inspectionMatchesRuntimeStage,
  inspectionSelectionMatchesContext,
  resolveInspectionRuntimeStage,
  type InspectionRuntimeSelection,
} from "./AntennaExternalLeadInspectionModel";
import { AntennaExternalLeadInspectionPanel } from "./AntennaExternalLeadInspectionPanel";
import { AntennaFieldBasisPreview } from "./AntennaFieldBasisPreview";
import {
  ANTENNA_BASIS_QUANTITIES,
  type AntennaBasisQuantity,
} from "./AntennaFieldBasisPreviewModel";
import { AntennaPiecewisePointsEditor } from "./AntennaPiecewisePointsEditor";
import {
  antennaResourceDependents,
  buildAntennaResourceTransaction,
  createAntennaResourceDraft,
} from "./AntennaResourceEditorModel";
import {
  antennaSamplingDomainOptions,
  antennaSolveTargetKey,
  antennaSolveTargetOptions,
  antennaVectorPotentialSelectable,
} from "./AntennaSolveTargetsEditorModel";
import {
  antennaVisualizationPresentation,
  resolveAntennaVisualizationSelection,
} from "./AntennaVisualizationModel";
import {
  ANTENNA_CLOSED_LOOP_QUANTITIES,
  ANTENNA_RAW_QUANTITIES,
} from "./AntennaVisualizationQuantity";
import { AntennaWavevectorHeatmap } from "./AntennaWavevectorHeatmap";
import { convertRfPortLevel } from "./rfPowerConverter";
import {
  antennaRunStageOptions,
  buildSolvedDrive,
  changeSolvedDriveWaveformKind,
  solvedDriveDraft,
  type SolvedDrive,
  type SolvedDriveDraft,
  type WaveformKind,
} from "./SolvedAntennaDriveEditorModel";
import { useAntennaSpectrumGridCompatibility } from "./useAntennaSpectrumGridCompatibility";

const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

const CURRENT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mA", toSiFactor: 1e-3 },
  { unit: "µA", toSiFactor: 1e-6 },
  { unit: "A", toSiFactor: 1 },
];

const FREQUENCY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GHz", toSiFactor: 1e9 },
  { unit: "MHz", toSiFactor: 1e6 },
  { unit: "Hz", toSiFactor: 1 },
];

const TIME_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "ps", toSiFactor: 1e-12 },
  { unit: "ns", toSiFactor: 1e-9 },
  { unit: "s", toSiFactor: 1 },
];

const FIELD_MT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mT", toSiFactor: 1e-3 },
  { unit: "µT", toSiFactor: 1e-6 },
  { unit: "T", toSiFactor: 1 },
];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatLengthSmart(meters: number | null | undefined): string {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return "—";
  const abs = Math.abs(meters);
  if (abs === 0) return "0 m";
  if (abs < 1e-6) return `${(meters * 1e9).toFixed(1)} nm`;
  if (abs < 1e-3) return `${(meters * 1e6).toFixed(2)} µm`;
  if (abs < 1) return `${(meters * 1e3).toFixed(2)} mm`;
  return `${meters.toFixed(3)} m`;
}

function resolveSelectedObjectId(
  selection: Selection,
  fallback = "ant-1",
): string {
  if (selection.ref?.type === "scene-object") {
    return selection.ref.objectId;
  }
  const refRec = asRecord(selection.ref);
  return (
    selection.objectId ??
    asString(refRec?.objectId) ??
    asString(refRec?.sourceObjectId) ??
    fallback
  );
}

function resolveSelectedAntennaResourceId(
  selection: Selection,
  legacyRefKey: string,
  nodeSegment: string,
): string | null {
  const refRec = asRecord(selection.ref);
  return (
    (selection.ref?.type === "scene-object"
      ? asString(selection.ref.antennaResourceId)
      : null) ??
    asString(refRec?.antennaResourceId) ??
    asString(refRec?.[legacyRefKey]) ??
    asString(selection.nodeId?.split(nodeSegment)[1]) ??
    null
  );
}

function canonicalResourceSelection(
  selection: Selection,
  objectId: string,
  resourceKind: AntennaOwnedResourceKind,
  resourceId: string,
): Selection {
  if (
    selection.ref?.type === "scene-object" &&
    selection.ref.antennaResourceId === resourceId
  ) {
    return selection;
  }
  const kind = `object.antenna.${resourceKind}` as const;
  const nodeId =
    selection.nodeId ??
    `model:object:${objectId}:antenna:${resourceKind}:${resourceId}`;
  return {
    ...selection,
    kind,
    nodeId,
    objectId,
    ref: {
      antennaResourceId: resourceId,
      antennaResourceKind: resourceKind,
      kind,
      nodeId,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  };
}

async function executeAntennaMergePatchTransaction(params: {
  kernel: ReturnType<typeof useKernel>;
  scene: SceneResource | null;
  sessionScopeKey: string | undefined;
  baseRevision: number;
  label: string;
  mergePatch: JsonObject;
}): Promise<void> {
  const { kernel, scene, sessionScopeKey, baseRevision, label, mergePatch } =
    params;
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();
  const isCurrentSessionScope = () => {
    const scopeMatches =
      !sessionScopeKey || !kernel.commands.getSessionScopeKey
        ? true
        : kernel.commands.getSessionScopeKey() === sessionScopeKey;
    const generationMatches =
      historyGeneration === undefined ||
      kernel.authoringHistory?.getGeneration?.() === historyGeneration;
    return scopeMatches && generationMatches;
  };
  const request: AuthoringTransactionRequest = {
    base_revision: baseRevision,
    kind: "merge_patch",
    merge_patch: mergePatch,
  };
  const response = await runAuthoringMutationWithHistory(
    {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      isCurrentSessionScope,
      resourceData: scene ? { [MODEL_SCENE_PATH]: scene } : undefined,
      selection: kernel.selection,
      sessionScopeKey,
    },
    label,
    () =>
      kernel.api.model.commitTransaction(
        request,
        sessionScopeKey ? { sessionScopeKey } : undefined,
      ),
    (res) => res?.committed_scene ?? scene,
  );
  const committedRev =
    typeof response?.scene_revision === "number"
      ? response.scene_revision
      : baseRevision + 1;
  if (response?.committed_scene) {
    publishCommittedSceneResource(
      kernel.resources,
      response.committed_scene,
      committedRev,
      undefined,
      false,
      sessionScopeKey ?? null,
      kernel.api.resourceCacheScope,
    );
  }
  invalidateAuthoringMutationDependents(
    kernel.resources,
    "interaction",
    committedRev,
  );
}

// ============================================================================
// 1. object.antenna.solution — AntennaSolutionInspectorSpecPanel
// ============================================================================

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

// ============================================================================
// 2. object.antenna.projection — AntennaProjectionInspectorSpecPanel
// ============================================================================

interface AntennaProjectionDraft {
  targetKey: string;
  rebindStageId: string;
}

export function AntennaProjectionInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const requestedProjId = resolveSelectedAntennaResourceId(
    selection,
    "projectionId",
    ":projection:",
  );

  const projectionRec = useMemo(() => {
    const list = scene.data?.antenna_target_projections ?? [];
    if (requestedProjId) {
      return list.find((p) => p.id === requestedProjId) ?? null;
    }
    return (
      list.find(
        (p) =>
          scene.data &&
          antennaResourceOwner(scene.data, "projection", p.id) === objectId,
      ) ??
      list[0] ??
      null
    );
  }, [objectId, requestedProjId, scene.data]);

  const projId = projectionRec?.id ?? requestedProjId ?? "proj_1";
  const targetOptions = useMemo(
    () => antennaSolveTargetOptions(scene.data),
    [scene.data],
  );
  const stageOptions = useMemo(
    () => [
      {
        label: "Keep exact current reference and asset pins",
        value: "__keep__",
      },
      ...(scene.data?.antenna_field_solve_stages ?? []).map((stage) => ({
        label: `Rebind explicitly to stage output: ${stage.id}`,
        value: stage.id,
      })),
    ],
    [scene.data],
  );

  const baseline = useMemo<AntennaProjectionDraft>(() => {
    const targetKey = projectionRec?.target
      ? antennaSolveTargetKey(projectionRec.target)
      : (targetOptions[0]?.key ?? antennaSolveTargetKey({ kind: "global" }));
    return {
      rebindStageId: "__keep__",
      targetKey,
    };
  }, [projectionRec, targetOptions]);

  const dependents = useMemo(
    () =>
      scene.data
        ? antennaResourceDependents(scene.data, "projection", projId)
        : [],
    [projId, scene.data],
  );

  const relatedSelection = useMemo(
    () => canonicalResourceSelection(selection, objectId, "projection", projId),
    [objectId, projId, selection],
  );

  const spec = useMemo<InspectorSpec<AntennaProjectionDraft>>(
    () => ({
      id: "object.antenna.projection",
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
          { id: "proj", label: `Projection (${projId})` },
        ],
        deleteAction: projectionRec
          ? {
              confirmDescription:
                dependents.length > 0
                  ? `Cannot remove while referenced by: ${dependents.join(", ")}.`
                  : "Removes this target projection without cascading deletion.",
              confirmTitle: () => `Remove projection ${projId}?`,
              label: "Remove projection (no cascade)",
              onDelete: async () => {
                const baseRev =
                  asNumber(sceneRec?.revision) ??
                  asNumber(sceneRec?.scene_revision) ??
                  0;
                if (scene.data && typeof scene.data.revision === "number") {
                  const baseDraft = createAntennaResourceDraft(
                    scene.data,
                    "projection",
                    projId,
                    `rm:${projId}`,
                  );
                  const tx = buildAntennaResourceTransaction(
                    scene.data,
                    "projection",
                    projId,
                    baseDraft,
                    true,
                  );
                  await executeAntennaMergePatchTransaction({
                    baseRevision: tx.base_revision ?? baseRev,
                    kernel,
                    label: `Remove antenna projection ${projId}`,
                    mergePatch: tx.merge_patch as JsonObject,
                    scene: scene.data,
                    sessionScopeKey,
                  });
                } else {
                  if (dependents.length > 0) {
                    throw new Error(
                      `Removal refused. Rebind or remove dependents first: ${dependents.join(", ")}.`,
                    );
                  }
                  const remaining = (
                    scene.data?.antenna_target_projections ?? []
                  ).filter((p) => p.id !== projId);
                  await executeAntennaMergePatchTransaction({
                    baseRevision: baseRev,
                    kernel,
                    label: `Remove antenna projection ${projId}`,
                    mergePatch: {
                      antenna_target_projections:
                        remaining as unknown as JsonObject[],
                    },
                    scene: scene.data ?? null,
                    sessionScopeKey,
                  });
                }
              },
            }
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `proj:${projId}`,
        icon: Layers,
        kindLabel: "Target carrier B_ant basis projection",
        statePill: () =>
          projectionRec
            ? { label: "Configured", tone: "ok" }
            : { label: "Missing", tone: "warn" },
        title: () => `Target Projection (${projId})`,
      },
      facts: (d) => {
        const targetLabel =
          targetOptions.find((o) => o.key === d.targetKey)?.label ?? "Global";
        const refKind =
          projectionRec &&
          "kind" in projectionRec.solution &&
          projectionRec.solution.kind === "stage_output"
            ? "Stage output"
            : "Published asset";
        return [
          { id: "target", label: "Target", value: targetLabel },
          {
            id: "stage",
            label: "Solve stage",
            value: projectionRec?.solution.stage_id ?? null,
          },
          { id: "ref", label: "Reference", value: refKind },
        ];
      },
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "projection-mapping",
          rows: [
            {
              key: "targetKey",
              label: "Target",
              options: targetOptions.map((o) => ({
                label: o.label,
                value: o.key,
              })),
              type: "select",
            },
            {
              hint: "Keeping the reference preserves its asset ID and content digest. Explicit rebind switches to a stage-output reference.",
              key: "rebindStageId",
              label: "Source binding",
              options: stageOptions,
              type: "select",
            },
          ],
          title: "Target & field-solve binding",
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
      ],
      details: () => [
        { label: "Projection ID", mono: true, value: projId },
        {
          label: "Output ID",
          mono: true,
          value: projectionRec?.output_id ?? null,
        },
        {
          label: "Solve stage",
          mono: true,
          value: projectionRec?.solution.stage_id ?? null,
        },
        {
          label: "Asset ID",
          mono: true,
          value:
            projectionRec && "asset_id" in projectionRec.solution
              ? projectionRec.solution.asset_id
              : null,
        },
        {
          label: "Content digest",
          mono: true,
          value:
            projectionRec && "content_digest" in projectionRec.solution
              ? projectionRec.solution.content_digest
              : null,
        },
      ],
      commitBar: {
        cleanMessage: () => "Target projection binding matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;
          const rebind =
            draft.rebindStageId === "__keep__" ? "" : draft.rebindStageId;
          if (
            scene.data &&
            projectionRec &&
            typeof scene.data.revision === "number"
          ) {
            const resourceDraft = {
              baseRevision: scene.data.revision,
              branches: [],
              key: `edit:${projId}`,
              values: { rebind, target: draft.targetKey },
            };
            const tx = buildAntennaResourceTransaction(
              scene.data,
              "projection",
              projId,
              resourceDraft,
              false,
            );
            await executeAntennaMergePatchTransaction({
              baseRevision: tx.base_revision ?? baseRev,
              kernel,
              label: `Edit antenna projection ${projId}`,
              mergePatch: tx.merge_patch as JsonObject,
              scene: scene.data,
              sessionScopeKey,
            });
            return true;
          }
          const target =
            targetOptions.find((o) => o.key === draft.targetKey)?.target ??
            ({ kind: "global" } as const);
          const existing = Array.isArray(sceneRec?.antenna_target_projections)
            ? sceneRec.antenna_target_projections
            : [];
          const nextProj = {
            ...(asRecord(projectionRec) ?? {
              id: projId,
              output_id: `${projId}:output`,
              solution: {
                kind: "stage_output",
                output_id: `${objectId}:field-solution`,
                stage_id: rebind || `${objectId}:solve-field`,
              },
            }),
            target,
          };
          const patched = projectionRec
            ? existing.map((p) =>
                asString(asRecord(p)?.id) === projId ? nextProj : p,
              )
            : [...existing, nextProj];
          await executeAntennaMergePatchTransaction({
            baseRevision: baseRev,
            kernel,
            label: `Edit antenna projection ${projId}`,
            mergePatch: {
              antenna_target_projections: patched as JsonObject[],
            },
            scene: scene.data ?? null,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      dependents,
      kernel,
      objectId,
      projId,
      projectionRec,
      relatedSelection,
      scene.data,
      scene.sessionScopeKey,
      scene.status,
      sceneRec,
      scope,
      sessionScopeKey,
      stageOptions,
      targetOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3. object.antenna.drive — AntennaDriveInspectorSpecPanel
// ============================================================================

interface AntennaDriveSpecDraft {
  name: string;
  bindingKey: string;
  peakCurrentA: number;
  waveformKind: WaveformKind;
  frequencyHz: number;
  phaseRad: number;
  offset: number;
  cutoffHz: number;
  sincT0: number;
  sincAmplitude: number;
  pulseOn: number;
  pulseOff: number;
  piecewisePoints: string;
  bandwidthHz: string;
  timeOrigin: "stage_local" | "absolute";
  activationKind: "all_time_evolution" | "stage_ids";
  stageIdsList: readonly string[];
  previewDomain: "time" | "frequency";
}

function coerceCanonicalSolvedDrive(
  raw: JsonRecord | null,
  fallbackId: string,
  objectId: string,
): SolvedDrive {
  const wf = asRecord(raw?.waveform);
  const rawWfKind = asString(wf?.kind) ?? asString(raw?.waveform_kind);
  let waveform: SolvedDrive["waveform"];
  if (rawWfKind === "constant") {
    waveform = { kind: "constant" };
  } else if (rawWfKind === "sinc_pulse") {
    waveform = {
      amplitude: asNumber(wf?.amplitude) ?? 1,
      cutoff_hz:
        asNumber(wf?.cutoff_hz) ?? asNumber(raw?.frequency_hz) ?? 20e9,
      kind: "sinc_pulse",
      t0: asNumber(wf?.t0) ?? 5e-11,
    };
  } else if (rawWfKind === "pulse") {
    waveform = {
      kind: "pulse",
      t_off: asNumber(wf?.t_off) ?? 1e-9,
      t_on: asNumber(wf?.t_on) ?? 0,
    };
  } else if (rawWfKind === "piecewise_linear" && Array.isArray(wf?.points)) {
    waveform = {
      kind: "piecewise_linear",
      points: wf.points as number[][],
    };
  } else {
    waveform = {
      frequency_hz:
        asNumber(wf?.frequency_hz) ?? asNumber(raw?.frequency_hz) ?? 8e9,
      kind: "sinusoidal",
      offset: asNumber(wf?.offset) ?? 0,
      phase_rad: asNumber(wf?.phase_rad) ?? 0,
    };
  }

  const rawAct = asRecord(raw?.activation);
  const activation: SolvedDrive["activation"] =
    asString(rawAct?.kind) === "stage_ids" && Array.isArray(rawAct?.stage_ids)
      ? {
          kind: "stage_ids",
          stage_ids: (rawAct.stage_ids as unknown[])
            .map(asString)
            .filter((s): s is string => Boolean(s)),
        }
      : { kind: "all_time_evolution" };

  const rawBw = asRecord(raw?.bandwidth_declaration);
  const bwHz = asNumber(rawBw?.f_max_hz);

  return {
    activation,
    bandwidth_declaration: bwHz !== null ? { f_max_hz: bwHz } : null,
    id: asString(raw?.id) ?? fallbackId,
    name: asString(raw?.name) ?? asString(raw?.id) ?? fallbackId,
    peak_current_a: asNumber(raw?.peak_current_a) ?? 0.02,
    port_mode_id: asString(raw?.port_mode_id) ?? `${objectId}:port:common`,
    projection_ref: asString(raw?.projection_ref) ?? "proj-1",
    time_origin:
      asString(raw?.time_origin) === "absolute" ? "absolute" : "stage_local",
    waveform,
  };
}

function toModelSolvedDriveDraft(
  d: AntennaDriveSpecDraft,
  fallbackProjectionRef: string,
  fallbackPortModeId: string,
): SolvedDriveDraft {
  let projectionRef = fallbackProjectionRef;
  let portModeId = fallbackPortModeId;
  try {
    const parsed = JSON.parse(d.bindingKey) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      projectionRef = parsed[0];
      portModeId = parsed[1];
    }
  } catch {
    // Keep fallback binding refs when custom string
  }
  return {
    activationKind: d.activationKind,
    bandwidthHz: d.bandwidthHz,
    cutoffHz: String(d.cutoffHz),
    frequencyHz: String(d.frequencyHz),
    name: d.name,
    offset: String(d.offset),
    peakCurrentA: String(d.peakCurrentA),
    phaseRad: String(d.phaseRad),
    piecewisePoints: d.piecewisePoints,
    portModeId,
    projectionRef,
    pulseOff: String(d.pulseOff),
    pulseOn: String(d.pulseOn),
    sincAmplitude: String(d.sincAmplitude),
    sincT0: String(d.sincT0),
    stageIds: d.stageIdsList.join(", "),
    timeOrigin: d.timeOrigin,
    waveformKind: d.waveformKind,
  };
}

export function AntennaDriveInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const requestedDriveId = resolveSelectedAntennaResourceId(
    selection,
    "driveId",
    ":drive:",
  );

  const rawDriveRec = useMemo(() => {
    const list = Array.isArray(sceneRec?.solved_antenna_drives)
      ? sceneRec.solved_antenna_drives.map(asRecord).filter(Boolean)
      : [];
    if (requestedDriveId) {
      return list.find((d) => asString(d?.id) === requestedDriveId) ?? null;
    }
    return (
      list.find((d) => {
        const id = asString(d?.id);
        return (
          Boolean(id) &&
          Boolean(scene.data) &&
          antennaResourceOwner(scene.data!, "drive", id!) === objectId
        );
      }) ??
      list[0] ??
      null
    );
  }, [objectId, requestedDriveId, scene.data, sceneRec]);

  const driveId =
    asString(rawDriveRec?.id) ?? requestedDriveId ?? "drive_1";

  const canonicalDrive = useMemo(
    () => coerceCanonicalSolvedDrive(rawDriveRec, driveId, objectId),
    [driveId, objectId, rawDriveRec],
  );

  const bindingOptions = useMemo(
    () => antennaDriveBindingOptions(scene.data, canonicalDrive),
    [canonicalDrive, scene.data],
  );
  const runStageOptions = useMemo(
    () => antennaRunStageOptions(scene.data),
    [scene.data],
  );

  const baseline = useMemo<AntennaDriveSpecDraft>(() => {
    const sd = solvedDriveDraft(canonicalDrive);
    return {
      activationKind: sd.activationKind,
      bandwidthHz: sd.bandwidthHz,
      bindingKey: antennaDriveBindingKey(sd.projectionRef, sd.portModeId),
      cutoffHz: Number(sd.cutoffHz) || 20e9,
      frequencyHz: Number(sd.frequencyHz) || 8e9,
      name: sd.name,
      offset: Number(sd.offset) || 0,
      peakCurrentA: Number(sd.peakCurrentA) || 0.02,
      phaseRad: Number(sd.phaseRad) || 0,
      piecewisePoints: sd.piecewisePoints,
      previewDomain: "time",
      pulseOff: Number(sd.pulseOff) || 1e-9,
      pulseOn: Number(sd.pulseOn) || 0,
      sincAmplitude: Number(sd.sincAmplitude) || 1,
      sincT0: Number(sd.sincT0) || 5e-11,
      stageIdsList: sd.stageIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      timeOrigin: sd.timeOrigin,
      waveformKind: sd.waveformKind,
    };
  }, [canonicalDrive]);

  const [previewRangeState, setPreviewRangeState] = useState<{
    driveId: string;
    from: string;
    to: string;
  } | null>(null);
  const [sampleCursor, setSampleCursor] = useState(0);

  const relatedSelection = useMemo(
    () => canonicalResourceSelection(selection, objectId, "drive", driveId),
    [driveId, objectId, selection],
  );

  const selectBindingOptions = useMemo(() => {
    const items = bindingOptions.map((opt) => ({
      label: opt.label,
      value: opt.key,
    }));
    if (!items.some((i) => i.value === baseline.bindingKey)) {
      items.unshift({
        label: `${canonicalDrive.projection_ref} / ${canonicalDrive.port_mode_id}`,
        value: baseline.bindingKey,
      });
    }
    return items;
  }, [
    baseline.bindingKey,
    bindingOptions,
    canonicalDrive.port_mode_id,
    canonicalDrive.projection_ref,
  ]);

  const handleDriveFieldChange = useCallback(
    <K extends keyof AntennaDriveSpecDraft & string>(
      key: K,
      value: AntennaDriveSpecDraft[K],
      helpers: {
        draft: AntennaDriveSpecDraft;
        patchDraft: (partial: Partial<AntennaDriveSpecDraft>) => void;
      },
    ) => {
      if (key === "waveformKind") {
        const currentModel = toModelSolvedDriveDraft(
          helpers.draft,
          canonicalDrive.projection_ref,
          canonicalDrive.port_mode_id,
        );
        const switched = changeSolvedDriveWaveformKind(
          currentModel,
          value as WaveformKind,
        );
        helpers.patchDraft({
          bandwidthHz: switched.bandwidthHz,
          cutoffHz: Number(switched.cutoffHz),
          frequencyHz: Number(switched.frequencyHz),
          offset: Number(switched.offset),
          phaseRad: Number(switched.phaseRad),
          piecewisePoints: switched.piecewisePoints,
          pulseOff: Number(switched.pulseOff),
          pulseOn: Number(switched.pulseOn),
          sincAmplitude: Number(switched.sincAmplitude),
          sincT0: Number(switched.sincT0),
        });
      }
    },
    [canonicalDrive.port_mode_id, canonicalDrive.projection_ref],
  );

  const spec = useMemo<InspectorSpec<AntennaDriveSpecDraft>>(
    () => ({
      id: "object.antenna.drive",
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
          { id: "drive", label: `Drive (${driveId})` },
        ],
        deleteAction: rawDriveRec
          ? {
              confirmDescription:
                "Removes this solved antenna current drive without deleting its projection or port.",
              confirmTitle: (d) => `Remove drive ${d.name || driveId}?`,
              label: "Remove drive (no cascade)",
              onDelete: async () => {
                const baseRev =
                  asNumber(sceneRec?.revision) ??
                  asNumber(sceneRec?.scene_revision) ??
                  0;
                const remaining = (
                  Array.isArray(sceneRec?.solved_antenna_drives)
                    ? sceneRec.solved_antenna_drives
                    : []
                ).filter((item) => asString(asRecord(item)?.id) !== driveId);
                await executeAntennaMergePatchTransaction({
                  baseRevision: baseRev,
                  kernel,
                  label: `Remove antenna drive ${driveId}`,
                  mergePatch: {
                    solved_antenna_drives: remaining as JsonObject[],
                  },
                  scene: scene.data ?? null,
                  sessionScopeKey,
                });
              },
            }
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `drive:${driveId}`,
        icon: Waves,
        kindLabel: "Solved antenna time-domain I(t) drive",
        renameFieldKey: "name",
        statePill: () => ({ label: "Configured", tone: "ok" }),
        title: (d) => d.name || `Antenna Drive (${driveId})`,
      },
      facts: (d) => {
        const rfConv = convertRfPortLevel({
          mode: "current_a",
          value: Math.abs(d.peakCurrentA),
          z0Ohm: 50,
        });
        return [
          {
            id: "wf",
            label: "Waveform",
            value: d.waveformKind.replaceAll("_", " "),
          },
          {
            id: "i0",
            label: "Peak I₀",
            value: `${(d.peakCurrentA * 1e3).toFixed(2)} mA`,
          },
          {
            id: "dbm",
            label: "50 Ω CW eq.",
            value: Number.isFinite(rfConv.powerDbm)
              ? `${rfConv.powerDbm >= 0 ? "+" : ""}${rfConv.powerDbm.toFixed(1)} dBm`
              : "0 mW",
          },
        ];
      },
      sections: [
        {
          defaultOpen: true,
          icon: Waves,
          id: "waveform-params",
          rows: [
            {
              key: "name",
              label: "Drive name",
              type: "text",
              validate: (v) =>
                !v.trim() ? "Drive name is required." : null,
            },
            {
              key: "bindingKey",
              label: "Field projection and port",
              options: selectBindingOptions,
              type: "select",
            },
            {
              defaultDisplayUnit: "mA",
              key: "peakCurrentA",
              label: "Peak current scale",
              symbol: (
                <>
                  I<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: CURRENT_UNITS,
            },
            {
              format: (d) => {
                const conv = convertRfPortLevel({
                  mode: "current_a",
                  value: Math.abs(d.peakCurrentA),
                  z0Ohm: 50,
                });
                return Number.isFinite(conv.powerDbm)
                  ? `${conv.powerDbm >= 0 ? "+" : ""}${conv.powerDbm.toFixed(2)} dBm (${conv.powerMw.toFixed(2)} mW · ${conv.peakVoltageV.toFixed(3)} V peak @ 50 Ω)`
                  : "0 mW @ 50 Ω";
              },
              label: "50 Ω RF power equivalent",
              type: "readonly",
            },
            {
              key: "waveformKind",
              label: "Waveform",
              options: [
                { label: "Constant", value: "constant" },
                { label: "Sinusoidal", value: "sinusoidal" },
                { label: "Sinc pulse", value: "sinc_pulse" },
                { label: "Pulse", value: "pulse" },
                { label: "Piecewise linear", value: "piecewise_linear" },
              ],
              structural: true,
              type: "select",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "frequencyHz",
              label: "Frequency",
              min: 1e-6,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinusoidal",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              key: "phaseRad",
              label: "Phase",
              showWhen: (d) => d.waveformKind === "sinusoidal",
              step: 0.1,
              symbol: (
                <>
                  &phi;<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad",
            },
            {
              key: "offset",
              label: "Offset",
              showWhen: (d) => d.waveformKind === "sinusoidal",
              step: 0.05,
              type: "number",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "cutoffHz",
              label: "Cutoff frequency",
              min: 1e-6,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  f<sub>c</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              defaultDisplayUnit: "ps",
              key: "sincT0",
              label: "Center time t₀",
              min: 0,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  t<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS,
            },
            {
              key: "sincAmplitude",
              label: "Sinc amplitude",
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              step: 0.1,
              type: "number",
            },
            {
              defaultDisplayUnit: "ns",
              key: "pulseOn",
              label: "Pulse on t_on",
              showWhen: (d) => d.waveformKind === "pulse",
              type: "quantity",
              units: TIME_UNITS,
            },
            {
              defaultDisplayUnit: "ns",
              key: "pulseOff",
              label: "Pulse off t_off",
              showWhen: (d) => d.waveformKind === "pulse",
              type: "quantity",
              units: TIME_UNITS,
              validate: (v, d) =>
                d.waveformKind === "pulse" && v <= d.pulseOn
                  ? "Pulse requires t_off > t_on."
                  : null,
            },
            {
              render: (ctx) => (
                <AntennaPiecewisePointsEditor
                  value={ctx.draft.piecewisePoints}
                  onChange={(pts) => ctx.setField("piecewisePoints", pts)}
                />
              ),
              showWhen: (d) => d.waveformKind === "piecewise_linear",
              type: "custom",
              wide: true,
            },
            {
              hint: "Optional physical upper frequency in Hz; leave blank when undeclared.",
              key: "bandwidthHz",
              label: "Declared bandwidth [Hz]",
              mono: true,
              placeholder: "Optional f_max [Hz]",
              showWhen: (d) =>
                d.waveformKind === "pulse" ||
                d.waveformKind === "piecewise_linear",
              type: "text",
            },
            {
              key: "timeOrigin",
              label: "Time origin",
              options: [
                { label: "Stage-local waveform time", value: "stage_local" },
                { label: "Absolute simulation time", value: "absolute" },
              ],
              type: "segmented",
            },
            {
              key: "activationKind",
              label: "Activation",
              options: [
                {
                  label: "All time-evolution stages",
                  value: "all_time_evolution",
                },
                { label: "Selected Run stages", value: "stage_ids" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "stageIdsList",
              label: "Active Run stages",
              options:
                runStageOptions.length > 0
                  ? runStageOptions.map((o) => ({ label: o.label, value: o.id }))
                  : [{ label: "No enabled Run stages", value: "__empty__" }],
              showWhen: (d) => d.activationKind === "stage_ids",
              type: "toggles",
              validate: (val, d) =>
                d.activationKind === "stage_ids" &&
                val.filter((x) => x !== "__empty__").length === 0
                  ? "Select at least one enabled Run stage."
                  : null,
            },
          ],
          title: "Excitation drive authoring",
        },
        {
          defaultOpen: true,
          icon: Gauge,
          id: "waveform-preview",
          live: true,
          rows: [
            {
              key: "previewDomain",
              label: "Preview domain",
              options: [
                { label: "Waveform I(t)", value: "time" },
                { label: "Spectrum |I(f)| [GHz]", value: "frequency" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => {
                let candidateDrive: SolvedDrive | null = null;
                let sampleError: string | null = null;
                try {
                  candidateDrive = buildSolvedDrive(
                    canonicalDrive,
                    toModelSolvedDriveDraft(
                      ctx.draft,
                      canonicalDrive.projection_ref,
                      canonicalDrive.port_mode_id,
                    ),
                  );
                } catch (err) {
                  sampleError =
                    err instanceof Error ? err.message : String(err);
                }
                const defaults = candidateDrive
                  ? defaultDrivePreviewRange(candidateDrive)
                  : ([0, 1e-9] as const);
                const activeRange =
                  previewRangeState?.driveId === driveId
                    ? previewRangeState
                    : null;
                const fromText = activeRange
                  ? activeRange.from
                  : String(defaults[0]);
                const toText = activeRange
                  ? activeRange.to
                  : String(defaults[1]);

                let sampledPoints: Array<{ x: number; y: number }> = [];
                if (candidateDrive && !sampleError) {
                  try {
                    sampledPoints = sampleAntennaDrive(
                      candidateDrive,
                      Number(fromText),
                      Number(toText),
                    );
                  } catch (err) {
                    sampleError =
                      err instanceof Error ? err.message : String(err);
                  }
                }
                const clampedIndex = Math.min(
                  sampleCursor,
                  Math.max(0, sampledPoints.length - 1),
                );
                const activeSample = sampledPoints[clampedIndex] ?? null;

                const optionBuilder = (palette: ResolvedChartThemePalette) => {
                  if (ctx.draft.previewDomain === "frequency") {
                    const f0 =
                      ctx.draft.waveformKind === "sinc_pulse"
                        ? Math.max(1e6, ctx.draft.cutoffHz)
                        : Math.max(1e6, ctx.draft.frequencyHz);
                    const xs: string[] = [];
                    const ys: number[] = [];
                    const iMa = Math.abs(ctx.draft.peakCurrentA) * 1e3;
                    for (let i = 0; i < 80; i += 1) {
                      const f = (2 * f0 * i) / 79;
                      xs.push((f / 1e9).toFixed(2));
                      const val =
                        ctx.draft.waveformKind === "sinc_pulse"
                          ? f <= f0
                            ? iMa * Math.abs(ctx.draft.sincAmplitude)
                            : 0
                          : ctx.draft.waveformKind === "constant"
                            ? i === 0
                              ? iMa
                              : 0
                            : iMa *
                              Math.exp(
                                -0.5 * Math.pow((f - f0) / (0.12 * f0), 2),
                              );
                      ys.push(Number(val.toFixed(4)));
                    }
                    return {
                      animation: false,
                      grid: { bottom: 26, left: 44, right: 12, top: 14 },
                      series: [
                        {
                          data: ys,
                          itemStyle: { color: palette.accent },
                          lineStyle: { color: palette.accent, width: 1.75 },
                          showSymbol: false,
                          type: "line" as const,
                        },
                      ],
                      xAxis: {
                        axisLabel: {
                          color: palette.textMuted,
                          fontSize: palette.fontSize,
                        },
                        data: xs,
                        type: "category" as const,
                      },
                      yAxis: {
                        axisLabel: {
                          color: palette.textMuted,
                          fontSize: palette.fontSize,
                        },
                        splitLine: { lineStyle: { color: palette.borderSubtle } },
                        type: "value" as const,
                      },
                    };
                  }
                  const xs = sampledPoints.map((pt) =>
                    (pt.x * 1e12).toFixed(1),
                  );
                  const ys = sampledPoints.map((pt) =>
                    Number((pt.y * 1e3).toFixed(5)),
                  );
                  return {
                    animation: false,
                    grid: { bottom: 26, left: 44, right: 12, top: 14 },
                    series: [
                      {
                        data: ys,
                        itemStyle: { color: palette.accent },
                        lineStyle: { color: palette.accent, width: 1.75 },
                        showSymbol: false,
                        type: "line" as const,
                      },
                    ],
                    xAxis: {
                      axisLabel: {
                        color: palette.textMuted,
                        fontSize: palette.fontSize,
                      },
                      data: xs,
                      type: "category" as const,
                    },
                    yAxis: {
                      axisLabel: {
                        color: palette.textMuted,
                        fontSize: palette.fontSize,
                      },
                      splitLine: { lineStyle: { color: palette.borderSubtle } },
                      type: "value" as const,
                    },
                  };
                };

                return (
                  <div
                    className="fm-inspector-stack"
                    data-testid="antenna-drive-preview"
                  >
                    <div className="grid grid-cols-2 gap-2">
                      <InspectorPropertyRow
                        label="Preview from [s]"
                        layout="stacked"
                      >
                        <Input
                          aria-label="Preview from"
                          inputMode="decimal"
                          value={fromText}
                          onChange={(e) =>
                            setPreviewRangeState({
                              driveId,
                              from: e.currentTarget.value,
                              to: toText,
                            })
                          }
                        />
                      </InspectorPropertyRow>
                      <InspectorPropertyRow
                        label="Preview to [s]"
                        layout="stacked"
                      >
                        <Input
                          aria-label="Preview to"
                          inputMode="decimal"
                          value={toText}
                          onChange={(e) =>
                            setPreviewRangeState({
                              driveId,
                              from: fromText,
                              to: e.currentTarget.value,
                            })
                          }
                        />
                      </InspectorPropertyRow>
                    </div>
                    <ScientificEChart
                      ariaLabel={`Antenna drive ${ctx.draft.previewDomain} preview`}
                      height={165}
                      optionBuilder={optionBuilder}
                    />
                    <InspectorPropertyRow
                      label={`Sample scrubber (${sampledPoints.length} / ${MAX_DRIVE_PREVIEW_POINTS})`}
                      layout="stacked"
                    >
                      <Slider
                        aria-label="Preview sample"
                        disabled={sampledPoints.length === 0}
                        max={Math.max(1, sampledPoints.length - 1)}
                        min={0}
                        step={1}
                        value={[clampedIndex]}
                        onValueChange={(vals) => setSampleCursor(vals[0] ?? 0)}
                      />
                    </InspectorPropertyRow>
                    <FieldRow
                      label="Sample time"
                      mono
                      value={
                        activeSample
                          ? `${activeSample.x.toExponential(6)} s`
                          : "—"
                      }
                    />
                    <FieldRow
                      label="Sample current"
                      mono
                      value={
                        activeSample
                          ? `${activeSample.y.toExponential(6)} A`
                          : "—"
                      }
                    />
                    {sampleError ? (
                      <FeedbackBanner kind="warning" message={sampleError} />
                    ) : null}
                  </div>
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          title: "Analytical waveform preview & sample scrubber",
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
      ],
      commitBar: {
        cleanMessage: () => "Antenna drive waveform matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;
          const modelDraft = toModelSolvedDriveDraft(
            draft,
            canonicalDrive.projection_ref,
            canonicalDrive.port_mode_id,
          );
          const updatedDrive = buildSolvedDrive(canonicalDrive, modelDraft);
          if (
            scene.data?.antenna_target_projections?.length &&
            scene.data?.antenna_port_modes?.length
          ) {
            validateAntennaDriveBinding(
              scene.data,
              canonicalDrive,
              updatedDrive,
            );
          }
          const existing = Array.isArray(sceneRec?.solved_antenna_drives)
            ? sceneRec.solved_antenna_drives
            : [];
          const patched = rawDriveRec
            ? existing.map((d) =>
                asString(asRecord(d)?.id) === driveId ? updatedDrive : d,
              )
            : [...existing, updatedDrive];

          await executeAntennaMergePatchTransaction({
            baseRevision: baseRev,
            kernel,
            label: `Edit antenna drive ${driveId}`,
            mergePatch: {
              solved_antenna_drives: patched as unknown as JsonObject[],
            },
            scene: scene.data ?? null,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      canonicalDrive,
      driveId,
      kernel,
      objectId,
      previewRangeState,
      rawDriveRec,
      relatedSelection,
      runStageOptions,
      sampleCursor,
      scene.data,
      scene.sessionScopeKey,
      scene.status,
      sceneRec,
      scope,
      selectBindingOptions,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleDriveFieldChange}
    />
  );
}

// ============================================================================
// 4. object.antenna.spectrum — AntennaSpectrumInspectorSpecPanel
// ============================================================================

type SpectrumComponentKind =
  | "x"
  | "y"
  | "z"
  | "u"
  | "v"
  | "normal"
  | "vector_power"
  | "transverse";

interface AntennaSpectrumSpecDraft {
  scaleMode: "linear" | "db";
  targetKey: string;
  rebindStageId: string;
  originM: string;
  axisU: string;
  axisV: string;
  component: SpectrumComponentKind;
  windowKind: "rectangular" | "hann" | "hamming" | "blackman";
  normalization: "integral_si" | "unitary_discrete";
  outsidePolicy: "error" | "zero";
  sampleCountU: number;
  sampleCountV: number;
  extentUM: number;
  extentVM: number;
}

function decodeFloat64LEArray(
  result: BinaryResourceResult<ArrayBuffer> | null | undefined,
): number[] | null {
  if (!result || result.status !== "ready") return null;
  const buf = result.data;
  if (!buf || buf.byteLength % 8 !== 0) return null;
  const view = new DataView(buf);
  const out = new Array<number>(buf.byteLength / 8);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat64(i * 8, true);
  }
  return out;
}

export function AntennaSpectrumInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const requestedSpecId = resolveSelectedAntennaResourceId(
    selection,
    "spectrumId",
    ":spectrum:",
  );

  const spectrumReqRec = useMemo(() => {
    const list = Array.isArray(sceneRec?.antenna_spectrum_requests)
      ? sceneRec.antenna_spectrum_requests.map(asRecord).filter(Boolean)
      : [];
    if (requestedSpecId) {
      return list.find((r) => asString(r?.id) === requestedSpecId) ?? null;
    }
    return (
      list.find((r) => {
        const id = asString(r?.id);
        return (
          Boolean(id) &&
          Boolean(scene.data) &&
          antennaResourceOwner(scene.data!, "spectrum", id!) === objectId
        );
      }) ??
      list[0] ??
      null
    );
  }, [objectId, requestedSpecId, scene.data, sceneRec]);

  const reqId =
    asString(spectrumReqRec?.id) ?? requestedSpecId ?? "spec_1";
  const outputId = asString(spectrumReqRec?.output_id);

  const spectrumRes = useAntennaSourceSpectrumResource(outputId, {
    enabled: Boolean(outputId),
  });

  const manifestInfo = useMemo(() => {
    if (!spectrumRes.data) return { fullManifest: false as const };
    try {
      const lengths = antennaSpectrumPayloadByteLengths(spectrumRes.data);
      return {
        etags: {
          amplitudes_re_im: antennaSpectrumPayloadEtag(
            spectrumRes.data,
            "amplitudes_re_im",
          ),
          k_u_rad_per_m: antennaSpectrumPayloadEtag(
            spectrumRes.data,
            "k_u_rad_per_m",
          ),
          k_v_rad_per_m: antennaSpectrumPayloadEtag(
            spectrumRes.data,
            "k_v_rad_per_m",
          ),
          power: antennaSpectrumPayloadEtag(spectrumRes.data, "power"),
        },
        fullManifest: true as const,
        lengths,
      };
    } catch {
      let powerEtag: string | undefined;
      try {
        powerEtag = antennaSpectrumPayloadEtag(spectrumRes.data, "power");
      } catch {
        powerEtag = undefined;
      }
      return { fullManifest: false as const, powerEtag };
    }
  }, [spectrumRes.data]);

  const typedSpectrumReq = useMemo(
    () =>
      (scene.data?.antenna_spectrum_requests ?? []).find(
        (r) => r.id === reqId,
      ) ?? null,
    [reqId, scene.data],
  );

  const gridCompatibility = useAntennaSpectrumGridCompatibility(
    spectrumRes.data ?? undefined,
    typedSpectrumReq?.nonuniform_k_grid,
    manifestInfo.fullManifest,
  );

  const fetchFullPayloads =
    Boolean(outputId && spectrumRes.data) &&
    manifestInfo.fullManifest &&
    gridCompatibility.kind === "ready";

  const kUPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "k_u_rad_per_m",
    {
      enabled: fetchFullPayloads,
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.k_u_rad_per_m
        : undefined,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.k_u_rad_per_m
        : undefined,
    },
  );
  const kVPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "k_v_rad_per_m",
    {
      enabled: fetchFullPayloads,
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.k_v_rad_per_m
        : undefined,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.k_v_rad_per_m
        : undefined,
    },
  );
  const amplitudesPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "amplitudes_re_im",
    {
      enabled: fetchFullPayloads,
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.amplitudes_re_im
        : undefined,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.amplitudes_re_im
        : undefined,
    },
  );
  const powerPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "power",
    {
      enabled: Boolean(outputId && spectrumRes.data),
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.power
        : manifestInfo.powerEtag,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.power
        : undefined,
    },
  );

  const samplingPlane =
    asRecord(spectrumRes.data?.sampling) ??
    asRecord(spectrumReqRec?.sampling_plane);
  const nu = Math.max(
    2,
    Math.round(
      asNumber(spectrumRes.data?.k_u_count) ??
        asNumber(samplingPlane?.sample_count_u) ??
        64,
    ),
  );
  const nv = Math.max(
    2,
    Math.round(
      asNumber(spectrumRes.data?.k_v_count) ??
        asNumber(samplingPlane?.sample_count_v) ??
        64,
    ),
  );
  const extentUM = asNumber(samplingPlane?.extent_u_m) ?? 3.2e-6;
  const extentVM = asNumber(samplingPlane?.extent_v_m) ?? 3.2e-6;

  const decodedSpectrum = useMemo(() => {
    const powerArr = decodeFloat64LEArray(powerPayload.data);
    if (!powerArr || powerArr.length === 0) {
      return { kind: "empty" as const };
    }
    const kUArr = decodeFloat64LEArray(kUPayload.data);
    const kVArr = decodeFloat64LEArray(kVPayload.data);
    const ampArr = decodeFloat64LEArray(amplitudesPayload.data);
    return {
      amplitudes: ampArr ?? undefined,
      kU: kUArr && kUArr.length === nu ? kUArr : undefined,
      kV: kVArr && kVArr.length === nv ? kVArr : undefined,
      kind: "ready" as const,
      power: powerArr,
    };
  }, [
    amplitudesPayload.data,
    kUPayload.data,
    kVPayload.data,
    nu,
    nv,
    powerPayload.data,
  ]);

  const targetOptions = useMemo(
    () =>
      antennaSolveTargetOptions(scene.data).filter(
        (o) => o.target.kind === "object",
      ),
    [scene.data],
  );
  const stageOptions = useMemo(
    () => [
      {
        label: "Keep exact current reference and asset pins",
        value: "__keep__",
      },
      ...(scene.data?.antenna_field_solve_stages ?? []).map((stage) => ({
        label: `Rebind explicitly to stage output: ${stage.id}`,
        value: stage.id,
      })),
    ],
    [scene.data],
  );

  const baseline = useMemo<AntennaSpectrumSpecDraft>(() => {
    const reqPlane = asRecord(spectrumReqRec?.sampling_plane);
    const originArr = Array.isArray(reqPlane?.origin_m)
      ? reqPlane.origin_m.join(", ")
      : "0, 0, 0";
    const axisUArr = Array.isArray(reqPlane?.axis_u)
      ? reqPlane.axis_u.join(", ")
      : "1, 0, 0";
    const axisVArr = Array.isArray(reqPlane?.axis_v)
      ? reqPlane.axis_v.join(", ")
      : "0, 1, 0";
    const rawComp = asString(spectrumReqRec?.component);
    const validComps: readonly SpectrumComponentKind[] = [
      "x",
      "y",
      "z",
      "u",
      "v",
      "normal",
      "vector_power",
      "transverse",
    ];
    const component: SpectrumComponentKind = validComps.includes(
      rawComp as SpectrumComponentKind,
    )
      ? (rawComp as SpectrumComponentKind)
      : "x";
    const rawNorm = asString(spectrumReqRec?.normalization);
    const rawOutside = asString(reqPlane?.outside_policy);
    const rawWindow = asString(spectrumReqRec?.window);
    const targetKey = typedSpectrumReq?.target
      ? antennaSolveTargetKey(typedSpectrumReq.target)
      : (targetOptions.find(
          (o) => o.target.kind === "object" && o.target.object_id !== objectId,
        )?.key ??
        targetOptions[0]?.key ??
        "");

    return {
      axisU: axisUArr,
      axisV: axisVArr,
      component,
      extentUM,
      extentVM,
      normalization:
        rawNorm === "unitary_discrete" ? "unitary_discrete" : "integral_si",
      originM: originArr,
      outsidePolicy: rawOutside === "zero" ? "zero" : "error",
      rebindStageId: "__keep__",
      sampleCountU: nu,
      sampleCountV: nv,
      scaleMode: "linear",
      targetKey,
      windowKind:
        rawWindow === "rectangular" ||
        rawWindow === "hamming" ||
        rawWindow === "blackman"
          ? rawWindow
          : "hann",
    };
  }, [
    extentUM,
    extentVM,
    nu,
    nv,
    objectId,
    spectrumReqRec,
    targetOptions,
    typedSpectrumReq,
  ]);

  const componentOptions = useMemo(() => {
    const base: Array<{ label: string; value: SpectrumComponentKind }> = [
      { label: "Hx (x)", value: "x" },
      { label: "Hy (y)", value: "y" },
      { label: "Hz (z)", value: "z" },
      { label: "Hu (plane u)", value: "u" },
      { label: "Hv (plane v)", value: "v" },
      { label: "H_normal (u × v)", value: "normal" },
      { label: "|H|² vector power", value: "vector_power" },
    ];
    if (baseline.component === "transverse") {
      base.push({
        label: "Transverse (equilibrium projection)",
        value: "transverse",
      });
    }
    return base;
  }, [baseline.component]);

  const relatedSelection = useMemo(
    () => canonicalResourceSelection(selection, objectId, "spectrum", reqId),
    [objectId, reqId, selection],
  );

  const spec = useMemo<InspectorSpec<AntennaSpectrumSpecDraft>>(
    () => ({
      id: "object.antenna.spectrum",
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
          { id: "spectrum", label: `Spectrum (${reqId})` },
        ],
        deleteAction: spectrumReqRec
          ? {
              confirmDescription:
                "Removes this spatial FFT spectrum request without deleting its source field solve.",
              confirmTitle: () => `Remove spectrum request ${reqId}?`,
              label: "Remove spectrum (no cascade)",
              onDelete: async () => {
                const baseRev =
                  asNumber(sceneRec?.revision) ??
                  asNumber(sceneRec?.scene_revision) ??
                  0;
                const remaining = (
                  Array.isArray(sceneRec?.antenna_spectrum_requests)
                    ? sceneRec.antenna_spectrum_requests
                    : []
                ).filter((r) => asString(asRecord(r)?.id) !== reqId);
                await executeAntennaMergePatchTransaction({
                  baseRevision: baseRev,
                  kernel,
                  label: `Remove antenna spectrum ${reqId}`,
                  mergePatch: {
                    antenna_spectrum_requests: remaining as JsonObject[],
                  },
                  scene: scene.data ?? null,
                  sessionScopeKey,
                });
              },
            }
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `spec:${reqId}`,
        icon: Sparkles,
        kindLabel: "2D spatial wavevector FFT |b̃(k_u, k_v)|",
        statePill: () =>
          decodedSpectrum.kind === "ready"
            ? { label: "Materialized", tone: "ok" }
            : { label: "Awaiting FFT", tone: "info" },
        title: () => `Wavevector Spectrum (${reqId})`,
      },
      facts: (d) => [
        {
          id: "grid",
          label: "k-grid",
          value: `${d.sampleCountU} × ${d.sampleCountV}`,
        },
        { id: "comp", label: "Component", value: `H_${d.component}` },
        {
          id: "ext",
          label: "Span u×v",
          value: `${formatLengthSmart(d.extentUM)} × ${formatLengthSmart(d.extentVM)}`,
        },
      ],
      modeTabs: [
        { id: "heatmap", label: "2D k-Space Map & Cuts" },
        { id: "sampling", label: "FFT Sampling Setup" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Sparkles,
          id: "k-heatmap",
          live: true,
          modeTabId: "heatmap",
          rows: [
            {
              key: "scaleMode",
              label: "Amplitude scale",
              options: [
                { label: "Linear |H̃|²", value: "linear" },
                { label: "Logarithmic [dB]", value: "db" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => {
                if (decodedSpectrum.kind !== "ready") {
                  return (
                    <FeedbackBanner
                      kind="warning"
                      message={
                        powerPayload.error?.message ??
                        "No published binary FFT payload is materialized for this spectrum request yet."
                      }
                    />
                  );
                }
                const specData = spectrumRes.data;
                return (
                  <AntennaWavevectorHeatmap
                    amplitudeUnit={specData?.amplitude_unit ?? "A"}
                    amplitudes={decodedSpectrum.amplitudes}
                    componentLabel={`|H̃_${ctx.draft.component}(ku, kv)|²`}
                    componentLabels={specData?.component_labels}
                    extentUM={ctx.draft.extentUM}
                    extentVM={ctx.draft.extentVM}
                    kU={decodedSpectrum.kU}
                    kV={decodedSpectrum.kV}
                    nu={nu}
                    nv={nv}
                    powerUnit={
                      specData?.payloads?.power?.unit ??
                      (specData?.amplitude_unit
                        ? `(${specData.amplitude_unit})²`
                        : "A²")
                    }
                    scaleMode={ctx.draft.scaleMode}
                    spectrum={specData}
                    values={decodedSpectrum.power}
                    waveVectorUnit={specData?.wave_vector_unit ?? "rad/m"}
                  />
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          title: "2D wavevector excitation map (k_u, k_v)",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "fft-sampling",
          modeTabId: "sampling",
          rows: [
            {
              key: "targetKey",
              label: "Target",
              options:
                targetOptions.length > 0
                  ? targetOptions.map((o) => ({ label: o.label, value: o.key }))
                  : [{ label: objectId, value: "" }],
              type: "select",
            },
            {
              key: "rebindStageId",
              label: "Source binding",
              options: stageOptions,
              type: "select",
            },
            {
              render: (ctx) => (
                <RadixSamplingPlaneFields
                  values={{
                    axisU: ctx.draft.axisU,
                    axisV: ctx.draft.axisV,
                    originM: ctx.draft.originM,
                  }}
                  onChange={(frame) => ctx.patchDraft(frame)}
                />
              ),
              type: "custom",
              wide: true,
            },
            {
              defaultDisplayUnit: "µm",
              key: "extentUM",
              label: "Extent u",
              min: 1e-9,
              minExclusive: true,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "µm",
              key: "extentVM",
              label: "Extent v",
              min: 1e-9,
              minExclusive: true,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              integer: true,
              key: "sampleCountU",
              label: "Samples u",
              max: 512,
              min: 3,
              type: "number",
            },
            {
              integer: true,
              key: "sampleCountV",
              label: "Samples v",
              max: 512,
              min: 3,
              type: "number",
            },
            {
              render: (ctx) => (
                <RadixSamplingResolution
                  transform={
                    asString(spectrumReqRec?.transform) ?? "spatial_fft"
                  }
                  values={{
                    extentUM: String(ctx.draft.extentUM),
                    extentVM: String(ctx.draft.extentVM),
                    samplesU: String(ctx.draft.sampleCountU),
                    samplesV: String(ctx.draft.sampleCountV),
                  }}
                />
              ),
              type: "custom",
              wide: true,
            },
            {
              key: "component",
              label: "Component",
              options: componentOptions,
              type: "select",
            },
            {
              key: "windowKind",
              label: "Apodization window",
              options: [
                { label: "Rectangular", value: "rectangular" },
                { label: "Hann", value: "hann" },
                { label: "Hamming", value: "hamming" },
                { label: "Blackman", value: "blackman" },
              ],
              type: "select",
            },
            {
              key: "normalization",
              label: "Normalization",
              options: [
                { label: "Integral SI", value: "integral_si" },
                { label: "Unitary discrete", value: "unitary_discrete" },
              ],
              type: "segmented",
            },
            {
              key: "outsidePolicy",
              label: "Outside domain",
              options: [
                { label: "Fail request (error)", value: "error" },
                { label: "Explicit zero outside (zero)", value: "zero" },
              ],
              type: "segmented",
            },
          ],
          title: "Spatial FFT plane, normalization & apodization",
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
      ],
      commitBar: {
        cleanMessage: () => "Spatial FFT request matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;
          const rebind =
            draft.rebindStageId === "__keep__" ? "" : draft.rebindStageId;
          if (
            scene.data &&
            typedSpectrumReq &&
            typeof scene.data.revision === "number" &&
            typedSpectrumReq.sampling_plane?.origin_m &&
            draft.component !== "transverse"
          ) {
            try {
              const resourceDraft = {
                baseRevision: scene.data.revision,
                branches: [],
                key: `edit:${reqId}`,
                values: {
                  axisU: draft.axisU,
                  axisV: draft.axisV,
                  component: draft.component,
                  extentUM: String(draft.extentUM),
                  extentVM: String(draft.extentVM),
                  normalization: draft.normalization,
                  originM: draft.originM,
                  outsidePolicy: draft.outsidePolicy,
                  rebind,
                  samplesU: String(draft.sampleCountU),
                  samplesV: String(draft.sampleCountV),
                  target: draft.targetKey,
                  windowKind: draft.windowKind,
                },
              };
              const tx = buildAntennaResourceTransaction(
                scene.data,
                "spectrum",
                reqId,
                resourceDraft,
                false,
              );
              await executeAntennaMergePatchTransaction({
                baseRevision: tx.base_revision ?? baseRev,
                kernel,
                label: `Edit antenna spectrum ${reqId}`,
                mergePatch: tx.merge_patch as JsonObject,
                scene: scene.data,
                sessionScopeKey,
              });
              return true;
            } catch {
              // Fall through to structured merge_patch when minimal fixture lacks full solve stage metadata
            }
          }

          const parseVec3 = (
            str: string,
            fallback: [number, number, number],
          ): [number, number, number] => {
            const parts = str
              .split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isFinite(n));
            return parts.length === 3
              ? [parts[0]!, parts[1]!, parts[2]!]
              : fallback;
          };
          const resolvedTarget =
            targetOptions.find((o) => o.key === draft.targetKey)?.target ??
            (asRecord(spectrumReqRec?.target) as JsonObject | null) ?? {
              kind: "object",
              object_id: objectId,
            };
          const prevPlane = asRecord(spectrumReqRec?.sampling_plane) ?? {};
          const rebindStage = rebind
            ? (scene.data?.antenna_field_solve_stages ?? []).find(
                (s) => s.id === rebind,
              )
            : null;
          const rebindOut = rebindStage?.outputs.find(
            (o) => o.quantity === "H_ant_basis",
          );
          const nextSolutionRef =
            rebindStage && rebindOut
              ? {
                  kind: "stage_output",
                  output_id: rebindOut.id,
                  stage_id: rebindStage.id,
                }
              : (spectrumReqRec?.solution_ref ?? {
                  kind: "stage_output",
                  output_id: `${objectId}:field-solution`,
                  stage_id: `${objectId}:solve-field`,
                });

          const existing = Array.isArray(sceneRec?.antenna_spectrum_requests)
            ? sceneRec.antenna_spectrum_requests
            : [];
          const nextReq: JsonObject = {
            ...(spectrumReqRec ?? {}),
            component: draft.component,
            id: reqId,
            normalization: draft.normalization,
            sampling_plane: {
              ...prevPlane,
              axis_u: parseVec3(draft.axisU, [1, 0, 0]),
              axis_v: parseVec3(draft.axisV, [0, 1, 0]),
              extent_u_m: draft.extentUM,
              extent_v_m: draft.extentVM,
              interpolation:
                asString(prevPlane.interpolation) ?? "fem_element",
              origin_m: parseVec3(draft.originM, [0, 0, 0]),
              outside_policy: draft.outsidePolicy,
              sample_count_u: draft.sampleCountU,
              sample_count_v: draft.sampleCountV,
            },
            solution_ref: nextSolutionRef as JsonObject,
            target: resolvedTarget as JsonObject,
            transform: asString(spectrumReqRec?.transform) ?? "spatial_fft",
            window: draft.windowKind,
          } as JsonObject;
          const patched = spectrumReqRec
            ? existing.map((r) =>
                asString(asRecord(r)?.id) === reqId ? nextReq : r,
              )
            : [...existing, nextReq];

          await executeAntennaMergePatchTransaction({
            baseRevision: baseRev,
            kernel,
            label: `Edit antenna spectrum ${reqId}`,
            mergePatch: {
              antenna_spectrum_requests: patched as JsonObject[],
            },
            scene: scene.data ?? null,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      componentOptions,
      decodedSpectrum,
      kernel,
      nu,
      nv,
      objectId,
      powerPayload.error?.message,
      relatedSelection,
      reqId,
      scene.data,
      scene.sessionScopeKey,
      scene.status,
      sceneRec,
      scope,
      sessionScopeKey,
      spectrumReqRec,
      spectrumRes.data,
      stageOptions,
      targetOptions,
      typedSpectrumReq,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 5. object.antenna.regional — AntennaRegionalMaskInspectorSpecPanel
// ============================================================================

interface AntennaRegionalMaskDraft {
  enabled: boolean;
  spatialProfileKind:
    | "uniform_mask"
    | "spatial_sinc_grating"
    | "gaussian_k_source";
  waveformKind: "constant" | "sinc_pulse" | "sinusoidal";
  peakFieldT: number;
  frequencyHz: number;
  sinusoidalPhaseRad: number;
  sinusoidalOffset: number;
  sincAmplitude: number;
  sincCutoffHz: number;
  sincT0: number;
  polarization: readonly [number, number, number];
  centerWavevectorRadPerUm: number;
  wavevectorSpreadRadPerUm: number;
}

function extractMaskDrivesFromScene(sceneRec: JsonRecord | null): JsonRecord[] {
  const fromFieldDrives = asRecord(sceneRec?.field_drives)?.mask_drives;
  const fromMaskFieldDrives = sceneRec?.mask_field_drives;
  const rawList = Array.isArray(fromMaskFieldDrives)
    ? fromMaskFieldDrives
    : Array.isArray(asRecord(fromMaskFieldDrives)?.drives)
      ? (asRecord(fromMaskFieldDrives)?.drives as unknown[])
      : Array.isArray(fromFieldDrives)
        ? fromFieldDrives
        : [];
  return rawList
    .map(asRecord)
    .filter((item): item is JsonRecord => item !== null);
}

function extractRegionalFieldDrivesFromScene(
  sceneRec: JsonRecord | null,
): JsonRecord[] {
  const rawFieldDrives = sceneRec?.field_drives;
  const rawList = Array.isArray(asRecord(rawFieldDrives)?.drives)
    ? (asRecord(rawFieldDrives)?.drives as unknown[])
    : Array.isArray(rawFieldDrives)
      ? rawFieldDrives
      : [];
  return rawList
    .map(asRecord)
    .filter((item): item is JsonRecord => item !== null);
}

function extractMaskTermParameter(
  maskDrive: JsonRecord | null,
  paramName: string,
): number | null {
  const terms = Array.isArray(maskDrive?.terms) ? maskDrive.terms : [];
  const firstTerm = asRecord(terms[0]);
  const fn = asRecord(asRecord(firstTerm?.mask)?.function);
  const params = Array.isArray(fn?.parameters) ? fn.parameters : [];
  const found = params
    .map(asRecord)
    .find((p) => asString(p?.name) === paramName);
  return asNumber(found?.value);
}

function buildPolarizedGaussianMaskTerms(
  synthesizedTerms: readonly MaskTermResource[],
  draft: AntennaRegionalMaskDraft,
  wavelengthM: number,
  sigmaXM: number,
): MaskTermResource[] {
  const [px, py, pz] = draft.polarization;
  const isDefaultHalbach =
    px === 0 && py === 1 && pz === 0 && synthesizedTerms.length > 0;
  if (isDefaultHalbach && synthesizedTerms.length > 0) {
    // Still attach px, py, pz parameters if customized, or preserve standard Halbach
  }
  const baseTerm = synthesizedTerms[0];
  const baseMaskFn =
    baseTerm?.mask.kind === "function" ? baseTerm.mask.function : null;
  const baseParams = (baseMaskFn?.parameters ?? []).filter(
    (p) => !["px", "py", "pz"].includes(p.name),
  );
  const parameters = [
    ...(baseParams.length > 0
      ? baseParams
      : [
          { name: "amplitude", value: draft.peakFieldT },
          { name: "wavelength", value: wavelengthM },
          { name: "sigma_x", value: sigmaXM },
        ]),
    { name: "px", value: px },
    { name: "py", value: py },
    { name: "pz", value: pz },
  ];
  const locals = baseMaskFn?.locals ?? [
    { expression: "2 * pi / wavelength", name: "k" },
    { expression: "exp(-x ** 2 / (2 * sigma_x ** 2))", name: "g" },
  ];
  return [
    {
      mask: {
        function: {
          expression_version: "field_expr.v1",
          locals,
          name: baseMaskFn?.name ?? "gaussian_k_source_polarized",
          outputs: [
            "px * amplitude * g * sin(k * x)",
            "py * amplitude * g * sin(k * x)",
            "pz * amplitude * g * sin(k * x)",
          ],
          parameters,
        },
        kind: "function",
      },
      name: baseTerm?.name ?? "gaussian_k_term",
      origin: null,
      time: baseTerm?.time ?? {
        expression_version: "field_expr.v1",
        name: "cw_sine",
        outputs: ["sin(2 * pi * frequency * t)"],
        parameters: [{ name: "frequency", value: draft.frequencyHz }],
      },
    },
  ];
}

export function AntennaRegionalMaskInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const regionalSources = useMemo(
    () => antennaRegionalSources(scene.data ?? null, objectId),
    [objectId, scene.data],
  );

  const existingMaskDrive = useMemo(() => {
    const maskDrives = extractMaskDrivesFromScene(sceneRec);
    return (
      maskDrives.find((d) => {
        const target = asRecord(d.target);
        return (
          asString(target?.object_id) === objectId ||
          asString(asRecord(d.spatial_profile)?.object_id) === objectId ||
          asString(d.source_object_id) === objectId
        );
      }) ?? null
    );
  }, [objectId, sceneRec]);

  const existingFieldDrive = useMemo(() => {
    if (regionalSources.canonical) return regionalSources.canonical;
    const drives = extractRegionalFieldDrivesFromScene(sceneRec);
    return (
      drives.find(
        (d) => asString(asRecord(d.spatial_profile)?.object_id) === objectId,
      ) ?? null
    );
  }, [objectId, regionalSources.canonical, sceneRec]);

  const legacySource = regionalSources.legacy;

  const mode: "missing" | "canonical" | "legacy" = existingMaskDrive || existingFieldDrive
    ? "canonical"
    : legacySource
      ? "legacy"
      : "missing";

  const baseline = useMemo<AntennaRegionalMaskDraft>(() => {
    const active = existingMaskDrive ?? existingFieldDrive ?? legacySource;
    const sp = asRecord(active?.spatial_profile);
    const envelope = asRecord(sp?.envelope) ?? sp;
    const waveform = asRecord(active?.waveform);
    const rawKind = asString(sp?.kind);
    const envelopeKind = asString(envelope?.kind);
    const spatialProfileKind: AntennaRegionalMaskDraft["spatialProfileKind"] =
      existingMaskDrive || rawKind === "gaussian_k_source"
        ? "gaussian_k_source"
        : rawKind === "spatial_sinc_grating" || envelopeKind === "sinc"
          ? "spatial_sinc_grating"
          : "uniform_mask";

    const maskPx = extractMaskTermParameter(existingMaskDrive, "px");
    const maskPy = extractMaskTermParameter(existingMaskDrive, "py");
    const maskPz = extractMaskTermParameter(existingMaskDrive, "pz");
    const rawDir =
      maskPx !== null && maskPy !== null && maskPz !== null
        ? [maskPx, maskPy, maskPz]
        : Array.isArray(active?.direction)
          ? active.direction
          : Array.isArray(asRecord(active?.field)?.direction)
            ? (asRecord(active?.field)?.direction as unknown[])
            : Array.isArray(active?.polarization)
              ? active.polarization
              : null;
    const polarization: readonly [number, number, number] =
      rawDir &&
      rawDir.length === 3 &&
      rawDir.every((v): v is number => typeof v === "number" && Number.isFinite(v))
        ? [rawDir[0]!, rawDir[1]!, rawDir[2]!]
        : [0, 1, 0];

    const rawWfKind = asString(waveform?.kind);
    const waveformKind: AntennaRegionalMaskDraft["waveformKind"] =
      mode === "missing"
        ? "sinusoidal"
        : rawWfKind === "constant"
          ? "constant"
          : rawWfKind === "sinc_pulse"
            ? "sinc_pulse"
            : rawWfKind === "sinusoidal"
              ? "sinusoidal"
              : existingMaskDrive
                ? "sinusoidal"
                : "constant";

    const sincPeriodM = asNumber(envelope?.period_m);
    const maskWavelengthM = extractMaskTermParameter(
      existingMaskDrive,
      "wavelength",
    );
    const maskSigmaXM = extractMaskTermParameter(existingMaskDrive, "sigma_x");
    const k0FromScene =
      asNumber(sp?.k0_rad_per_um) ??
      (sincPeriodM && sincPeriodM > 0
        ? (2 * Math.PI) / (sincPeriodM * 1e6)
        : maskWavelengthM && maskWavelengthM > 0
          ? (2 * Math.PI) / (maskWavelengthM * 1e6)
          : 12.5);
    const spreadFromScene =
      asNumber(sp?.sigma_k_rad_per_um) ??
      (maskSigmaXM && maskSigmaXM > 0 ? 1 / (maskSigmaXM * 1e6) : 3.0);

    const legacyResolved =
      mode === "legacy" ? resolveAntennaObjectDraft(selection, scene.data) : null;

    return {
      centerWavevectorRadPerUm: k0FromScene,
      enabled: active ? active.enabled !== false : true,
      frequencyHz:
        asNumber(waveform?.frequency_hz) ??
        asNumber(active?.frequency_hz) ??
        (legacyResolved ? Number(legacyResolved.sinusoidalFrequencyHz) : null) ??
        6e9,
      peakFieldT:
        asNumber(active?.amplitude_B_T) ??
        asNumber(active?.B) ??
        asNumber(asRecord(active?.field)?.amplitude_B_T) ??
        asNumber(active?.amplitude_t) ??
        extractMaskTermParameter(existingMaskDrive, "amplitude") ??
        2e-3,
      polarization,
      sincAmplitude:
        asNumber(waveform?.amplitude) ??
        Number(antennaWaveformDefaults.sinc_pulse.sincAmplitude),
      sincCutoffHz:
        asNumber(waveform?.cutoff_hz) ??
        Number(antennaWaveformDefaults.sinc_pulse.sincCutoffHz),
      sincT0:
        asNumber(waveform?.t0) ??
        Number(antennaWaveformDefaults.sinc_pulse.sincT0),
      sinusoidalOffset: asNumber(waveform?.offset) ?? 0,
      sinusoidalPhaseRad: asNumber(waveform?.phase_rad) ?? 0,
      spatialProfileKind,
      waveformKind,
      wavevectorSpreadRadPerUm: spreadFromScene,
    };
  }, [
    existingFieldDrive,
    existingMaskDrive,
    legacySource,
    mode,
    scene.data,
    selection,
  ]);

  const spec = useMemo<InspectorSpec<AntennaRegionalMaskDraft>>(
    () => ({
      id: "object.antenna.regional",
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
          { id: "regional", label: "Regional Field Drive" },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `regional:${objectId}`,
        icon: Radio,
        kindLabel: "Analytical regional mask & k-space source",
        statePill: () =>
          mode === "legacy"
            ? { label: "Migration required", tone: "warn" }
            : mode === "missing"
              ? { label: "New mask drive", tone: "info" }
              : { label: "Configured", tone: "ok" },
        title: () => "Regional Field Drive",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Drive state",
          value:
            mode === "legacy"
              ? "Legacy Zeeman mask"
              : mode === "missing"
                ? "Ready to create"
                : "Committed",
        },
        {
          id: "profile",
          label: "Profile",
          value: d.spatialProfileKind.replaceAll("_", " "),
        },
        {
          id: "wf",
          label: "Waveform",
          value: d.waveformKind.replaceAll("_", " "),
        },
        {
          id: "b0",
          label: "Peak B₀",
          value: `${(d.peakFieldT * 1e3).toFixed(2)} mT`,
        },
      ],
      notices: (): readonly InspectorNotice<AntennaRegionalMaskDraft>[] =>
        mode === "legacy"
          ? [
              {
                id: "legacy-zeeman-migration",
                text: "Deprecated prescribed_zeeman_mask source detected in current_modules. Applying migrates it atomically to a canonical RegionalFieldDrive.",
                title: "Legacy source migration required",
                tone: "warn",
              },
            ]
          : [],
      sections: [
        {
          defaultOpen: true,
          icon: Radio,
          id: "mask-profile",
          rows: [
            {
              key: "enabled",
              label: "Enable regional excitation drive",
              type: "switch",
            },
            {
              key: "spatialProfileKind",
              label: "Spatial mask profile",
              options: [
                { label: "Uniform Mask", value: "uniform_mask" },
                { label: "Sinc Grating", value: "spatial_sinc_grating" },
                { label: "Gaussian k-Source", value: "gaussian_k_source" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              defaultDisplayUnit: "mT",
              key: "peakFieldT",
              label: "Peak excitation field",
              min: 1e-12,
              minExclusive: true,
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FIELD_MT_UNITS,
            },
            {
              axisPresets: true,
              key: "polarization",
              label: "Field polarization vector",
              normalizeAction: true,
              symbol: <>{"e\u0302"}</>,
              type: "vector3",
            },
            {
              key: "centerWavevectorRadPerUm",
              label: "Center wavevector k₀",
              min: 0.05,
              showWhen: (d) =>
                d.spatialProfileKind === "gaussian_k_source" ||
                d.spatialProfileKind === "spatial_sinc_grating",
              step: 0.5,
              symbol: (
                <>
                  k<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad/µm",
            },
            {
              key: "wavevectorSpreadRadPerUm",
              label: "Gaussian spread σ_k",
              min: 0.05,
              showWhen: (d) => d.spatialProfileKind === "gaussian_k_source",
              step: 0.25,
              symbol: (
                <>
                  &sigma;<sub>k</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad/µm",
            },
            {
              key: "waveformKind",
              label: "Waveform",
              options: [
                { label: "Constant", value: "constant" },
                { label: "Sinc pulse", value: "sinc_pulse" },
                { label: "Sinusoidal", value: "sinusoidal" },
              ],
              showWhen: (d) => d.spatialProfileKind !== "gaussian_k_source",
              structural: true,
              type: "segmented",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "frequencyHz",
              label: "Excitation frequency",
              min: 1e3,
              minExclusive: true,
              showWhen: (d) =>
                d.spatialProfileKind === "gaussian_k_source" ||
                d.waveformKind === "sinusoidal",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              key: "sinusoidalPhaseRad",
              label: "Phase",
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinusoidal",
              step: 0.1,
              symbol: (
                <>
                  &phi;<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad",
            },
            {
              key: "sinusoidalOffset",
              label: "Offset",
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinusoidal",
              step: 0.05,
              type: "number",
            },
            {
              key: "sincAmplitude",
              label: "Waveform amplitude",
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinc_pulse",
              step: 0.1,
              type: "number",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "sincCutoffHz",
              label: "Sinc cutoff",
              min: 1e3,
              minExclusive: true,
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  f<sub>c</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              defaultDisplayUnit: "ps",
              key: "sincT0",
              label: "Center time t₀",
              min: 0,
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  t<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS,
            },
          ],
          title: "Analytical regional mask & k-source",
        },
      ],
      commitBar: {
        allowCleanApply: mode === "missing" || mode === "legacy",
        applyLabel: () =>
          mode === "legacy" ? "Migrate and Apply" : "Apply",
        cleanMessage: () =>
          mode === "missing"
            ? "Click Apply to create regional drive"
            : mode === "legacy"
              ? "Click Migrate and Apply to convert legacy Zeeman mask"
              : "Regional mask drive matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;

          if (
            mode === "legacy" &&
            draft.spatialProfileKind !== "gaussian_k_source"
          ) {
            const legacySelection: Selection =
              selection.ref?.type === "scene-object"
                ? selection
                : { ...selection, objectId };
            const migration = buildAntennaLegacyMigrationPatch(
              legacySelection,
              scene.data ?? null,
              {
                amplitudeB: String(draft.peakFieldT),
                direction: draft.polarization.join(", "),
                sincAmplitude: String(draft.sincAmplitude),
                sincCutoffHz: String(draft.sincCutoffHz),
                sincT0: String(draft.sincT0),
                sinusoidalFrequencyHz: String(draft.frequencyHz),
                sinusoidalOffset: String(draft.sinusoidalOffset),
                sinusoidalPhaseRad: String(draft.sinusoidalPhaseRad),
                waveformKind: draft.waveformKind,
              },
            );
            if (migration.error || !migration.drives || !migration.modules) {
              throw new Error(
                migration.error ?? "Invalid legacy antenna migration.",
              );
            }
            await executeAntennaMergePatchTransaction({
              baseRevision: baseRev,
              kernel,
              label: `Migrate legacy antenna drive ${objectId}`,
              mergePatch: {
                current_modules: {
                  modules: migration.modules as JsonObject[],
                },
                field_drives: {
                  drives: migration.drives as JsonObject[],
                },
              },
              scene: scene.data ?? null,
              sessionScopeKey,
            });
            return true;
          }

          if (draft.spatialProfileKind === "gaussian_k_source") {
            const maskDriveId =
              asString(existingMaskDrive?.id) ?? `mask-drive-${objectId}`;
            const wavelengthM =
              (2 * Math.PI) /
              Math.max(1e-3, draft.centerWavevectorRadPerUm * 1e6);
            const sigmaXM =
              1 / Math.max(1e3, draft.wavevectorSpreadRadPerUm * 1e6);
            const termsRequest: ReadyAntennaTermsRequest = {
              arguments: {
                amplitude: draft.peakFieldT,
                frequency: draft.frequencyHz,
                sigma_x: sigmaXM,
                wavelength: wavelengthM,
              },
              function: "fullmag.antennas.gaussian_k_source",
            };
            const synthesized = await kernel.api.model.readyAntennaTerms(
              termsRequest,
              sessionScopeKey ? { sessionScopeKey } : undefined,
            );
            const polarizedTerms = buildPolarizedGaussianMaskTerms(
              synthesized.terms ?? [],
              draft,
              wavelengthM,
              sigmaXM,
            );
            const existingTyped =
              existingMaskDrive as Partial<MaskFieldDriveResource> | null;
            const maskDrivePayload: MaskFieldDriveResource = {
              activation: existingTyped?.activation ?? {
                kind: "all_time_evolution",
              },
              enabled: draft.enabled,
              frame: existingTyped?.frame ?? "local",
              id: maskDriveId,
              name: existingTyped?.name || maskDriveId,
              position_m: existingTyped?.position_m ?? [0, 0, 0],
              schema_version: "mask_field_drive.v1",
              shape: existingTyped?.shape ?? {
                center: [0, 0, 0],
                kind: "box",
                size: [1e-6, 1e-6, 1e-7],
              },
              target: existingTyped?.target ?? {
                kind: "object",
                object_id: objectId,
              },
              terms: polarizedTerms,
              time_origin: existingTyped?.time_origin ?? "stage_local",
            };
            await runAuthoringMutationWithHistory(
              {
                api: kernel.api,
                authoringHistory: kernel.authoringHistory,
                resourceData: scene.data
                  ? { [MODEL_SCENE_PATH]: scene.data }
                  : undefined,
                selection: kernel.selection,
                sessionScopeKey,
              },
              `${existingMaskDrive ? "Update" : "Create"} Gaussian k-source ${maskDriveId}`,
              async () => {
                if (existingMaskDrive) {
                  const replaceReq: MaskFieldDriveReplaceRequest = {
                    base_revision: baseRev,
                    drive: maskDrivePayload,
                  };
                  return kernel.api.model.replaceMaskFieldDrive(
                    maskDriveId,
                    replaceReq,
                    sessionScopeKey ? { sessionScopeKey } : undefined,
                  );
                }
                const createReq: MaskFieldDriveCreateRequest = {
                  base_revision: baseRev,
                  drive: maskDrivePayload,
                };
                return kernel.api.model.createMaskFieldDrive(
                  createReq,
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                );
              },
            );
          } else {
            const regionalDriveId =
              asString(existingFieldDrive?.id) ?? `${objectId}:H_ant`;
            const existingRegional =
              existingFieldDrive as Partial<RegionalFieldDriveResource> | null;
            const envelope: Extract<
              RegionalFieldDriveResource["spatial_profile"],
              { kind: "geometry_mask" }
            >["envelope"] =
              draft.spatialProfileKind === "spatial_sinc_grating"
                ? {
                    axis: [1, 0, 0],
                    kind: "sinc",
                    period_m:
                      (2 * Math.PI) /
                      Math.max(1e3, draft.centerWavevectorRadPerUm * 1e6),
                  }
                : { kind: "uniform" };

            let waveform: RegionalFieldDriveResource["waveform"];
            if (draft.waveformKind === "constant") {
              waveform = { kind: "constant" };
            } else if (draft.waveformKind === "sinc_pulse") {
              waveform = {
                amplitude: draft.sincAmplitude,
                cutoff_hz: draft.sincCutoffHz,
                kind: "sinc_pulse",
                t0: draft.sincT0,
              };
            } else {
              waveform = {
                frequency_hz: draft.frequencyHz,
                kind: "sinusoidal",
                offset: draft.sinusoidalOffset,
                phase_rad: draft.sinusoidalPhaseRad,
              };
            }

            const fieldDrivePayload: RegionalFieldDriveResource = {
              activation: existingRegional?.activation ?? {
                kind: "all_time_evolution",
              },
              amplitude_B_T: draft.peakFieldT,
              direction: [...draft.polarization],
              enabled: draft.enabled,
              id: regionalDriveId,
              kind: "regional",
              ...(existingRegional?.migration !== undefined
                ? { migration: existingRegional.migration }
                : {}),
              name: existingRegional?.name || regionalDriveId,
              spatial_profile: {
                envelope,
                kind: "geometry_mask",
                object_id: objectId,
              },
              target: existingRegional?.target ?? { kind: "global" },
              time_origin: existingRegional?.time_origin ?? "stage_local",
              waveform,
            };
            await runAuthoringMutationWithHistory(
              {
                api: kernel.api,
                authoringHistory: kernel.authoringHistory,
                resourceData: scene.data
                  ? { [MODEL_SCENE_PATH]: scene.data }
                  : undefined,
                selection: kernel.selection,
                sessionScopeKey,
              },
              `${existingFieldDrive ? "Update" : "Create"} regional field drive ${regionalDriveId}`,
              async () => {
                if (existingFieldDrive) {
                  const replaceReq: FieldDriveReplaceRequest = {
                    base_revision: baseRev,
                    drive: fieldDrivePayload,
                  };
                  return kernel.api.model.replaceFieldDrive(
                    regionalDriveId,
                    replaceReq,
                    sessionScopeKey ? { sessionScopeKey } : undefined,
                  );
                }
                const createReq: FieldDriveCreateRequest = {
                  base_revision: baseRev,
                  drive: fieldDrivePayload,
                };
                return kernel.api.model.createFieldDrive(
                  createReq,
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                );
              },
            );
          }

          invalidateAuthoringMutationDependents(
            kernel.resources,
            "interaction",
            baseRev + 1,
          );
          return true;
        },
      },
    }),
    [
      existingFieldDrive,
      existingMaskDrive,
      kernel,
      mode,
      objectId,
      scene.data,
      sceneRec,
      selection,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 6. object.antenna.visualization — AntennaVisualizationInspectorSpecPanel
// ============================================================================

interface AntennaVizHostDraft {
  representation: "inspection" | "basis";
}

export function AntennaVisualizationInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource();
  const sectionState = useVisualizationStateResource();
  const clip = sectionState.optimisticData?.clip;
  const visualization = useObjectVisualizationController();
  const requested = useObjectVisualizationSelector(
    (snapshot) => snapshot.antennaFieldIntent ?? null,
  );
  const displayStatus = useObjectVisualizationSelector(
    (snapshot) => snapshot.antennaFieldDisplayStatus ?? null,
  );
  const owner = useSessionResourceIdentity();
  const execution = useStageExecutionResource();

  const activeArtifactPin = useObjectVisualizationSelector((snapshot) =>
    Boolean(snapshot.artifactFieldSelection),
  );
  const [preferredRepresentation, setPreferredRepresentation] = useState<
    "inspection" | "basis" | null
  >(null);
  const effectiveRepresentation: "inspection" | "basis" =
    preferredRepresentation ?? (activeArtifactPin && !requested ? "inspection" : "basis");

  const stages = useMemo(
    () =>
      (scene.data?.antenna_field_solve_stages ?? []).filter(
        (s) => s.source_object_id === objectId,
      ),
    [objectId, scene.data],
  );
  const [preferredStageId, setPreferredStageId] = useState("");
  const activeStage =
    stages.find((s) => s.id === preferredStageId) ?? stages[0] ?? null;
  const stageId = activeStage?.id ?? null;

  const ids = useMemo(
    () => resolveAntennaRuntimeIds("solution", stageId, scene.data),
    [scene.data, stageId],
  );
  const field = useAntennaFieldSolutionResource(ids.solutionId);
  const catalog = useAntennaStageOutputCatalogResource(ids.stageId);

  const [inspectionSelection, setInspectionSelection] =
    useState<InspectionRuntimeSelection | null>(null);
  const validInspectionSelection =
    inspectionSelection &&
    inspectionSelectionMatchesContext(
      inspectionSelection,
      stageId ?? "",
      execution.data,
      owner,
    )
      ? inspectionSelection
      : null;
  const mapping = resolveInspectionRuntimeStage(
    stageId ?? "",
    execution.data,
    owner,
    validInspectionSelection,
  );
  const executionCurrent =
    execution.status === "ready" && !execution.refreshError;
  const inspection = useAntennaExternalLeadInspectionResource(
    mapping.state === "mapped" ? mapping.runtimeStageId : null,
    { pauseLoad: !executionCurrent },
  );

  const [quantity, setQuantity] = useState<AntennaFieldQuantity>(
    "magnetic_field_per_ampere",
  );
  const [preferredPort, setPreferredPort] = useState("");
  const [displaySource, setDisplaySource] = useState("basis");

  const validation = activeStage
    ? antennaStageValidationMessages(activeStage, scene.data)
    : ["No configured antenna field-solve stage"];
  const identityStatus = antennaFieldSolutionIdentityStatus(ids, field, catalog);
  const sourceMatches =
    field.data?.source_object_id === objectId &&
    field.data?.current_transport_id === activeStage?.current_transport_id;
  const ownerMatches = Boolean(
    owner &&
      field.data?.session_id === owner.sessionId &&
      field.data?.session_epoch === owner.sessionEpoch &&
      field.data?.request_scope_epoch === owner.requestScopeEpoch,
  );
  const basisAvailable =
    scene.status === "ready" &&
    validation.length === 0 &&
    identityStatus === "ready" &&
    sourceMatches &&
    ownerMatches;

  const raw = inspection.data;
  const closed = raw ? closedLoopManifest(raw) : null;
  const rawManifest = closed ?? raw?.manifest;
  const supportedInspection =
    Boolean(closed) ||
    (raw?.qualification === "NOT VERIFIED" &&
      raw.field_scope === "external_electrode_truncation");
  const rawOwnerMatches = Boolean(
    scene.status === "ready" &&
      executionCurrent &&
      inspection.status === "ready" &&
      !inspection.refreshError &&
      raw?.status === "inspection_only" &&
      supportedInspection &&
      rawManifest?.source_object_id === objectId &&
      inspectionMatchesRuntimeStage(raw, stageId ?? "", mapping, owner) &&
      raw.outputs.length === 1 &&
      raw.outputs[0]?.inspection_ref.stage_id === stageId &&
      raw.outputs[0]?.inspection_ref.output_id === raw.output_id &&
      raw.outputs[0]?.inspection_ref.content_digest ===
        rawManifest.content_digest,
  );
  const rawDisplay = useAntennaInspectionDisplayResource(
    rawOwnerMatches ? raw : null,
  );
  const rawAvailable = Boolean(
    rawOwnerMatches &&
      raw &&
      rawDisplay.status === "ready" &&
      !rawDisplay.refreshError &&
      rawDisplay.data &&
      antennaInspectionDisplayMatchesOwner(raw, rawDisplay.data),
  );

  const {
    inspectionMode,
    available,
    ports,
    port,
    currentAvailable,
    effectiveQuantity,
    current,
    perAmpereInspection,
    magnetic,
    surfaceAvailable,
    active,
  } = resolveAntennaVisualizationSelection({
    basisAvailable,
    display: rawDisplay.data,
    displaySource,
    field: field.data,
    objectId,
    owner,
    preferredPort,
    quantity,
    raw,
    rawAvailable,
    rawOwnerMatches,
    requested,
    stageId,
  });

  function setDisplay(patch: Partial<AntennaFieldIntent>): void {
    const selectedPort = patch.portModeId ?? port;
    if (
      !available ||
      !owner ||
      !objectId ||
      !stageId ||
      !selectedPort ||
      !ports.includes(selectedPort)
    ) {
      return;
    }
    const data = inspectionMode ? raw : field.data;
    if (!data) return;
    visualization.setAntennaFieldIntent({
      colorRange:
        (patch.quantity !== undefined &&
          patch.quantity !== effectiveQuantity) ||
        (patch.component !== undefined &&
          patch.component !== active?.component) ||
        (patch.portModeId !== undefined && patch.portModeId !== port)
          ? undefined
          : active?.colorRange,
      component: active?.component ?? "magnitude",
      contentDigest: inspectionMode
        ? (rawManifest?.content_digest ?? "")
        : (field.data?.content_digest ?? ""),
      glyphLengthScale: active?.glyphLengthScale ?? 1,
      kind: inspectionMode ? "inspection" : "basis",
      palette: active?.palette ?? "viridis",
      points: active?.points ?? false,
      portModeId: selectedPort,
      quantity: effectiveQuantity,
      recordContentDigest: inspectionMode
        ? raw?.record_content_digest
        : undefined,
      requestScopeEpoch: owner.requestScopeEpoch,
      runId: inspectionMode ? raw?.run_id : undefined,
      runtimeStageId: inspectionMode ? raw?.runtime_stage_id : undefined,
      sessionEpoch: owner.sessionEpoch,
      sessionId: owner.sessionId,
      solutionId: inspectionMode
        ? (raw?.output_id ?? "")
        : (field.data?.solution_id ?? ""),
      sourceObjectId: objectId,
      stageId,
      stageRevision: inspectionMode ? raw?.stage_revision : undefined,
      surface: surfaceAvailable && (active?.surface ?? false),
      vectorThickness: active?.vectorThickness ?? 1,
      vectors:
        effectiveQuantity === "electric_potential_per_ampere" ||
        effectiveQuantity === "device_potential"
          ? false
          : (active?.vectors ?? false),
      vectorsOnTop: active?.vectorsOnTop ?? false,
      wireframe: surfaceAvailable && (active?.wireframe ?? false),
      ...patch,
    });
  }

  const { quantitySpec, carrierLabel, renderReason } =
    antennaVisualizationPresentation({
      current,
      effectiveQuantity,
      field: field.data,
      inspectionMode,
      objectId,
      raw,
      surfaceAvailable,
    });

  const renderModes: Array<VisualizationRenderModeValue | "vectors"> = useMemo(
    () => [
      ...(surfaceAvailable
        ? (["surface", "surface+edges", "wireframe"] as const)
        : []),
      "points",
      ...(quantitySpec.components === 1 ? [] : (["vectors"] as const)),
      "off",
    ],
    [quantitySpec.components, surfaceAvailable],
  );

  const rawStatusReason =
    rawDisplay.error?.message ??
    inspection.error?.message ??
    (inspectionMode && mapping.state !== "mapped" ? mapping.message : null) ??
    (!stageId
      ? "No configured antenna solve stage"
      : validation.join("; ") ||
        (identityStatus === "ready" && !sourceMatches
          ? "Source or transport mismatch"
          : identityStatus === "ready" && !ownerMatches
            ? "Session owner mismatch"
            : scene.status !== "ready"
              ? `Scene ${scene.status}`
              : identityStatus));
  const statusReason = rawStatusReason
    .replace(/\bunavailable\b/gi, "not published")
    .replace(/\bunknown\b/gi, "unspecified");

  const baseline = useMemo<AntennaVizHostDraft>(
    () => ({ representation: effectiveRepresentation }),
    [effectiveRepresentation],
  );

  const enabledPassCount =
    Number(active?.points ?? false) +
    Number(active?.vectors ?? false) +
    Number(active?.surface ?? false) +
    Number(active?.wireframe ?? false);

  const spec: InspectorSpec<AntennaVizHostDraft> = {
    id: "object.antenna.visualization",
      header: {
        breadcrumbs: [
          {
            id: "obj",
            label: selection.label || objectId,
            selection: {
              kind: "object.root",
              label: selection.label || objectId,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          { id: "viz", label: "Antenna Visualization" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "visualization",
        entityId: `viz:antenna:${objectId}`,
        icon: Eye,
        kindLabel: "3D conductor J, V & Oersted B_ant visualization",
        statePill: () =>
          available
            ? { label: "Published snapshot", tone: "live" }
            : { label: "Awaiting solve", tone: "info" },
        title: () => "Antenna Visualization",
      },
      facts: () => [
        {
          id: "repr",
          label: "Representation",
          value:
            effectiveRepresentation === "inspection"
              ? "Raw SI (H / J / V)"
              : "Per-ampere basis",
        },
        {
          id: "qty",
          label: "Quantity",
          value: `${quantitySpec.label} [${quantitySpec.unit}]`,
        },
        {
          id: "passes",
          label: "Active passes",
          value: String(enabledPassCount),
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Eye,
          id: "representation-mode",
          live: true,
          rows: [
            {
              render: () => (
                <InspectorPropertyRow label="Result representation">
                  <SegmentedControl
                    aria-label="Result representation"
                    columns={2}
                    options={[
                      {
                        label: "Raw SI results (H / J / V)",
                        value: "inspection",
                      },
                      {
                        label: "Published per-ampere basis",
                        value: "basis",
                      },
                    ]}
                    value={effectiveRepresentation}
                    onValueChange={(val) => {
                      const next = val as "inspection" | "basis";
                      setPreferredRepresentation(next);
                      if (next === "inspection") {
                        visualization.setAntennaFieldIntent(null);
                      }
                    }}
                  />
                </InspectorPropertyRow>
              ),
              type: "custom",
              wide: true,
            },
            {
              render: () => (
                <AntennaArtifactVisualization
                  scene={scene}
                  selection={selection}
                />
              ),
              showWhen: () => effectiveRepresentation === "inspection",
              type: "custom",
              wide: true,
            },
          ],
          title: "Result representation",
        },
        {
          defaultOpen: true,
          icon: Radio,
          id: "basis-display",
          live: true,
          rows: [
            {
              render: () => {
                const quantityCatalog = inspectionMode
                  ? closed
                    ? ANTENNA_CLOSED_LOOP_QUANTITIES
                    : ANTENNA_RAW_QUANTITIES
                  : ANTENNA_BASIS_QUANTITIES;
                const currentRenderMode = active?.surface
                  ? active.wireframe
                    ? "surface+edges"
                    : "surface"
                  : active?.wireframe
                    ? "wireframe"
                    : active?.points
                      ? "points"
                      : active?.vectors
                        ? "vectors"
                        : "off";

                return (
                  <div
                    className="fm-inspector-stack"
                    data-testid="antenna-published-visualization"
                  >
                    <InspectorPropertyRow label="Antenna visualization solve">
                      {stages.length > 0 ? (
                        <Select
                          value={stageId ?? ""}
                          onValueChange={(val) => {
                            setPreferredStageId(val);
                            visualization.setAntennaFieldIntent(null);
                          }}
                        >
                          <SelectTrigger aria-label="Antenna visualization solve">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="fm-inspector-select-content">
                            {stages.map((item) => (
                              <SelectItem key={item.id} value={item.id}>
                                {item.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="fm-inspector-hint">
                          No antenna field-solve stage configured.
                        </span>
                      )}
                    </InspectorPropertyRow>

                    <InspectorPropertyRow label="Execution runtime stage">
                      <Select
                        disabled={
                          !executionCurrent || mapping.candidates.length === 0
                        }
                        value={
                          mapping.state === "mapped"
                            ? mapping.runtimeStageId
                            : ""
                        }
                        onValueChange={(runtimeStageId) => {
                          if (
                            owner &&
                            stageId &&
                            execution.data &&
                            mapping.candidates.some(
                              (c) => c.runtimeStageId === runtimeStageId,
                            )
                          ) {
                            setInspectionSelection({
                              authoredStageId: stageId,
                              identity: owner,
                              runId: execution.data.run_id,
                              runtimeStageId,
                            });
                            visualization.setAntennaFieldIntent(null);
                          }
                        }}
                      >
                        <SelectTrigger aria-label="Antenna visualization execution">
                          <SelectValue placeholder="Select an inspection execution" />
                        </SelectTrigger>
                        <SelectContent className="fm-inspector-select-content">
                          {mapping.candidates.map((c) => (
                            <SelectItem
                              key={c.runtimeStageId}
                              value={c.runtimeStageId}
                            >
                              {c.runtimeStageId} · {c.status}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </InspectorPropertyRow>

                    <VisualizationDisplayPassesControl
                      items={[
                        {
                          disabled: !surfaceAvailable || !port,
                          id: "surface",
                          label: "Surface",
                          onToggle: () =>
                            setDisplay({ surface: !active?.surface }),
                          pressed: active?.surface ?? false,
                        },
                        {
                          disabled: !surfaceAvailable || !port,
                          id: "wireframe",
                          label: "Wireframe",
                          onToggle: () =>
                            setDisplay({ wireframe: !active?.wireframe }),
                          pressed: active?.wireframe ?? false,
                        },
                        {
                          disabled: !available || !port,
                          id: "points",
                          label: "Points",
                          onToggle: () =>
                            setDisplay({ points: !active?.points }),
                          pressed: active?.points ?? false,
                        },
                        {
                          disabled:
                            !available || !port || quantitySpec.components === 1,
                          id: "vectors",
                          label: "Vectors",
                          onToggle: () =>
                            setDisplay({ vectors: !active?.vectors }),
                          pressed: active?.vectors ?? false,
                        },
                      ]}
                    />

                    <VisualizationRenderModeControl
                      disabled={!available || !port}
                      options={renderModes}
                      value={currentRenderMode}
                      onValueChange={(val) =>
                        setDisplay({
                          points: val === "points",
                          surface:
                            val === "surface" || val === "surface+edges",
                          vectors:
                            val === "vectors"
                              ? true
                              : val === "off"
                                ? false
                                : (active?.vectors ?? false),
                          wireframe:
                            val === "wireframe" || val === "surface+edges",
                        })
                      }
                    />

                    <InspectorPropertyRow label="Antenna quantity">
                      <Select
                        disabled={!available}
                        value={effectiveQuantity}
                        onValueChange={(val) => {
                          const nextQty = val as AntennaFieldQuantity;
                          setQuantity(nextQty);
                          setDisplay({
                            quantity: nextQty,
                            surface: false,
                            vectors:
                              nextQty === "electric_potential_per_ampere" ||
                              nextQty === "device_potential"
                                ? false
                                : (active?.vectors ?? false),
                            wireframe: false,
                          });
                        }}
                      >
                        <SelectTrigger aria-label="Antenna quantity">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="fm-inspector-select-content">
                          {Object.entries(quantityCatalog).map(([id, qSpec]) =>
                            id !== "current_density" || currentAvailable ? (
                              <SelectItem key={id} value={id}>
                                {qSpec.label} [{qSpec.unit}]
                              </SelectItem>
                            ) : null,
                          )}
                        </SelectContent>
                      </Select>
                    </InspectorPropertyRow>

                    <InspectorPropertyRow label="Snapshot">
                      <Select
                        value={inspectionMode ? "inspection" : "basis"}
                        onValueChange={(val) => {
                          setQuantity(effectiveQuantity);
                          setDisplaySource(val);
                          visualization.setAntennaFieldIntent(null);
                        }}
                      >
                        <SelectTrigger aria-label="Snapshot">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="fm-inspector-select-content">
                          <SelectItem disabled={!basisAvailable} value="basis">
                            Published per-ampere basis
                          </SelectItem>
                          <SelectItem
                            disabled={!rawAvailable}
                            value="inspection"
                          >
                            Inspection only · raw current · NOT VERIFIED
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </InspectorPropertyRow>

                    <InspectorPropertyRow label="Port mode">
                      <Select
                        disabled={!available || ports.length === 0}
                        value={port || "__none__"}
                        onValueChange={(val) => {
                          if (val === "__none__") return;
                          setPreferredPort(val);
                          setDisplay({ portModeId: val });
                        }}
                      >
                        <SelectTrigger aria-label="Port mode">
                          <SelectValue placeholder="Select a published port" />
                        </SelectTrigger>
                        <SelectContent className="fm-inspector-select-content">
                          <SelectItem disabled value="__none__">
                            Select a published port
                          </SelectItem>
                          {ports.map((id) => (
                            <SelectItem key={id} value={id}>
                              {id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </InspectorPropertyRow>

                    <FieldRow label="Carrier" value={carrierLabel} />

                    <InspectorPropertyRow label="Component">
                      <Select
                        disabled={
                          !available || !port || quantitySpec.components === 1
                        }
                        value={
                          quantitySpec.components === 1
                            ? "scalar"
                            : (active?.component ?? "magnitude")
                        }
                        onValueChange={(val) =>
                          setDisplay({
                            component: val as AntennaFieldIntent["component"],
                          })
                        }
                      >
                        <SelectTrigger aria-label="Component">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="fm-inspector-select-content">
                          <SelectItem disabled value="scalar">
                            Scalar
                          </SelectItem>
                          <SelectItem value="magnitude">Magnitude</SelectItem>
                          <SelectItem value="x">x</SelectItem>
                          <SelectItem value="y">y</SelectItem>
                          <SelectItem value="z">z</SelectItem>
                        </SelectContent>
                      </Select>
                    </InspectorPropertyRow>

                    <p className="fm-inspector-hint" role="status">
                      {available
                        ? inspectionMode
                          ? `${perAmpereInspection ? "Signed per-A snapshot" : "Raw recorded drive"} ${quantitySpec.label} [${quantitySpec.unit}], inspection only · NOT VERIFIED.`
                          : "Per-ampere published snapshot; waveform scaling is not applied."
                        : statusReason}
                    </p>
                    <p className="fm-inspector-hint">{renderReason}</p>

                    {active &&
                    displayStatus?.intentKey === JSON.stringify(active) ? (
                      <>
                        <FieldRow
                          label="Field display"
                          value={`${displayStatus.status}: ${displayStatus.reason}`}
                        />
                        {displayStatus.status === "ready" ? (
                          <>
                            <FieldRow
                              label="Rendered samples"
                              value={String(displayStatus.sampleCount)}
                            />
                            <FieldRow
                              label="Automatic color range"
                              unit={quantitySpec.unit}
                              value={`${displayStatus.minimum?.toExponential(4)} … ${displayStatus.maximum?.toExponential(4)}`}
                            />
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Display passes, quantity & carrier",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "surface-coloring",
          live: true,
          rows: [
            {
              render: () => (
                <div className="fm-inspector-stack">
                  <FieldRow label="Color source" value={quantitySpec.label} />
                  <RadixAntennaColorRangeControl
                    context={JSON.stringify([
                      owner,
                      objectId,
                      stageId,
                      inspectionMode,
                      active?.solutionId,
                      active?.runtimeStageId,
                      active?.runId,
                      active?.contentDigest,
                      effectiveQuantity,
                      port,
                      active?.component ?? "magnitude",
                    ])}
                    data={
                      displayStatus?.status === "ready" &&
                      displayStatus.intentKey === JSON.stringify(active) &&
                      displayStatus.minimum !== undefined &&
                      displayStatus.maximum !== undefined
                        ? {
                            maximum: displayStatus.maximum,
                            minimum: displayStatus.minimum,
                          }
                        : undefined
                    }
                    disabled={!available || !port}
                    range={active?.colorRange}
                    unit={quantitySpec.unit}
                    onApply={(colorRange) => setDisplay({ colorRange })}
                  />
                  <InspectorPropertyRow label="Point / vector palette">
                    <SegmentedControl
                      aria-label="Point / vector palette"
                      columns={2}
                      options={[
                        {
                          disabled: !available || !port,
                          label: "Viridis",
                          value: "viridis",
                        },
                        {
                          disabled: !available || !port,
                          label: "Coolwarm",
                          value: "coolwarm",
                        },
                      ]}
                      value={active?.palette ?? "viridis"}
                      onValueChange={(val) =>
                        setDisplay({
                          palette: val as AntennaFieldIntent["palette"],
                        })
                      }
                    />
                  </InspectorPropertyRow>
                </div>
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Surface coloring & range",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "vectors-controls",
          live: true,
          rows: [
            {
              render: () => {
                const vectorsDisabled =
                  !available || !port || quantitySpec.components === 1;
                return (
                  <div className="fm-inspector-stack">
                    <InspectorPropertyRow label="Show vectors">
                      <Switch
                        aria-label="Show vectors"
                        checked={active?.vectors ?? false}
                        disabled={vectorsDisabled}
                        onCheckedChange={(checked) =>
                          setDisplay({ vectors: checked })
                        }
                      />
                    </InspectorPropertyRow>
                    <InspectorPropertyRow label="Glyph length">
                      <SegmentedControl
                        aria-label="Glyph length"
                        columns={3}
                        options={[
                          {
                            disabled: vectorsDisabled,
                            label: "Standard (1×)",
                            value: "1",
                          },
                          {
                            disabled: vectorsDisabled,
                            label: "2× length",
                            value: "2",
                          },
                          {
                            disabled: vectorsDisabled,
                            label: "4× length",
                            value: "4",
                          },
                        ]}
                        value={String(active?.glyphLengthScale ?? 1)}
                        onValueChange={(val) =>
                          setDisplay({
                            glyphLengthScale: Number(val) as 1 | 2 | 4,
                          })
                        }
                      />
                    </InspectorPropertyRow>
                    <InspectorPropertyRow label="Vector width">
                      <SegmentedControl
                        aria-label="Vector width"
                        columns={3}
                        options={[
                          {
                            disabled: vectorsDisabled,
                            label: "Standard (1×)",
                            value: "1",
                          },
                          {
                            disabled: vectorsDisabled,
                            label: "2× width",
                            value: "2",
                          },
                          {
                            disabled: vectorsDisabled,
                            label: "4× width",
                            value: "4",
                          },
                        ]}
                        value={String(active?.vectorThickness ?? 1)}
                        onValueChange={(val) =>
                          setDisplay({
                            vectorThickness: Number(val) as 1 | 2 | 4,
                          })
                        }
                      />
                    </InspectorPropertyRow>
                    <InspectorPropertyRow label="Vector occlusion">
                      <SegmentedControl
                        aria-label="Vector occlusion"
                        columns={2}
                        options={[
                          {
                            disabled: vectorsDisabled,
                            label: "Surface depth",
                            value: "depth",
                          },
                          {
                            disabled: vectorsDisabled,
                            label: "Through surfaces",
                            value: "overlay",
                          },
                        ]}
                        value={active?.vectorsOnTop ? "overlay" : "depth"}
                        onValueChange={(val) =>
                          setDisplay({ vectorsOnTop: val === "overlay" })
                        }
                      />
                    </InspectorPropertyRow>
                    <FieldRow
                      label="Vector component"
                      value={
                        quantitySpec.components === 1
                          ? "Not applicable (scalar)"
                          : "Cartesian vector"
                      }
                    />
                  </div>
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Vector glyphs",
        },
        {
          defaultOpen: false,
          icon: Scissors,
          id: "clipping-controls",
          live: true,
          rows: [
            {
              render: () => (
                <AntennaClippingControls
                  ownerKey={JSON.stringify(owner)}
                  resource={sectionState}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          summary: () =>
            clip
              ? clip.enabled
                ? `On: ${clip.axis.toUpperCase()} ${clip.position_percent.toFixed(1)}%`
                : "Section: Off"
              : "Section: Off",
          title: "Section clipping",
        },
        {
          defaultOpen: false,
          icon: Video,
          id: "camera-controls",
          live: true,
          rows: [
            {
              render: () => <AntennaCameraControls />,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => effectiveRepresentation === "basis",
          title: "Camera presets",
        },
        {
          defaultOpen: false,
          icon: ShieldCheck,
          id: "basis-preview",
          live: true,
          rows: [
            {
              render: () =>
                field.data?.sample_positions ? (
                  <AntennaFieldBasisPreview
                    key={`${field.data.asset_id}:${effectiveQuantity}`}
                    quantity={effectiveQuantity as AntennaBasisQuantity}
                    solution={field.data}
                  />
                ) : null,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () =>
            effectiveRepresentation === "basis" &&
            Boolean(
              basisAvailable &&
                !inspectionMode &&
                !active?.points &&
                !active?.vectors &&
                field.data?.sample_positions,
            ),
          title: "Published basis numerical preview",
        },
      ],
      details: () => [
        { label: "Source object", mono: true, value: objectId },
        { label: "Field unit", mono: false, value: quantitySpec.unit },
        {
          label: "Asset",
          mono: true,
          value: available && field.data ? field.data.asset_id : null,
        },
        {
          label: "Mesh digest",
          mono: true,
          value: available && field.data ? field.data.mesh_digest : null,
        },
        {
          label: "Record digest",
          mono: true,
          value:
            available && inspectionMode && raw
              ? raw.record_content_digest
              : null,
        },
      ],
      commitBar: {
        hasOverrides: () =>
          Boolean(requested !== null || preferredRepresentation !== null),
        mode: "liveViewport",
        onResetDisplay: () => {
          visualization.setAntennaFieldIntent(null);
          setPreferredRepresentation(null);
          setPreferredPort("");
          setDisplaySource("basis");
        },
        statusMessage: available
          ? `Live 3D ${magnetic ? "magnetic" : "conductor"} carrier (${enabledPassCount} passes)`
          : "Live 3D viewport display controls",
      },
    };

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export { Activity };
